//! Reference loader: note times from the reference MIDI files, audio segments read through read_wav_mono_range, features per note and velocity.

use super::analysis::{analyze_note, NoteFeatures};
use crate::midi::MidiEvent;
use crate::playback::parse_smf;
use crate::render::read_wav_mono_range;
use std::path::{Path, PathBuf};

pub const VELOCITIES: [u8; 5] = [16, 40, 64, 96, 127];
pub const AFTER_KEY_UP_S: f64 = 2.0;
pub const REF_RATE: u32 = 48000;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RefNote {
    pub note: u8,
    pub velocity: u8,
    pub on_s: f64,
    pub off_s: f64,
}

impl RefNote {
    pub fn hold_s(&self) -> f64 {
        self.off_s - self.on_s
    }
}

pub fn single_notes(folder: &Path, velocity: u8) -> Result<Vec<RefNote>, String> {
    let path = folder.join("midi").join(format!("single-notes-v{velocity:03}.mid"));
    let bytes = std::fs::read(&path).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    let events = parse_smf(&bytes).map_err(|e| format!("{}: {e}", path.display()))?;
    let mut open: Vec<(u8, f64)> = Vec::new();
    let mut out: Vec<RefNote> = Vec::new();
    for (us, ev) in events {
        let t = us as f64 / 1e6;
        match ev {
            MidiEvent::NoteOn { note, velocity: v } if v > 0 => open.push((note, t)),
            MidiEvent::NoteOn { note, .. } | MidiEvent::NoteOff { note } => {
                if let Some(i) = open.iter().position(|(n, _)| *n == note) {
                    let (_, on_s) = open.remove(i);
                    out.push(RefNote { note, velocity, on_s, off_s: t });
                }
            }
            _ => {}
        }
    }
    out.sort_by(|a, b| a.on_s.partial_cmp(&b.on_s).unwrap());
    Ok(out)
}

pub fn wav_path(folder: &Path, velocity: u8) -> PathBuf {
    folder.join("wav").join(format!("single-notes-v{velocity:03}.wav"))
}

pub fn read_segment(folder: &Path, r: &RefNote) -> Result<Vec<f32>, String> {
    let path = wav_path(folder, r.velocity);
    let (x, rate) = read_wav_mono_range(&path, r.on_s, r.hold_s() + AFTER_KEY_UP_S)?;
    if rate != REF_RATE {
        return Err(format!("{}: sample rate {rate} Hz, expected {REF_RATE} Hz", path.display()));
    }
    Ok(x)
}

#[derive(Debug, Clone, Default)]
pub struct RefSet {
    pub items: Vec<(RefNote, NoteFeatures)>,
}

impl RefSet {
    pub fn get(&self, note: u8, velocity: u8) -> Option<&(RefNote, NoteFeatures)> {
        self.items.iter().find(|(r, _)| r.note == note && r.velocity == velocity)
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DamperRow {
    pub note: u8,
    pub release_ms: Option<f64>,
    pub held30_ms: Option<f64>,
    pub damped: bool,
}

pub fn measured_undamped_from(refs: &RefSet, notes: &[u8], floor: u8) -> (u8, Vec<DamperRow>) {
    let mut rows = Vec::new();
    let mut highest: Option<u8> = None;
    for &n in notes {
        let Some((_, f)) = refs.get(n, 64) else { continue };
        let release_ms = f.release_ms;
        let held30_ms = f.tail_db_per_s.map(|t| 30_000.0 / t.max(0.3));
        let damped = match (release_ms, held30_ms) {
            (Some(r), Some(h)) => r < 0.6 * h,
            (Some(r), None) => r < 1000.0,
            (None, _) => false,
        };
        if damped {
            highest = Some(highest.map_or(n, |h| h.max(n)));
        }
        rows.push(DamperRow { note: n, release_ms, held30_ms, damped });
    }
    let u = highest.map_or(floor, |h| floor.max(h.saturating_add(1))).clamp(21, 109);
    (u, rows)
}

/// Runs f(0..n) on scoped workers (job i on worker i % threads) and returns the results in job order.
pub fn parallel_map<T: Send, F: Fn(usize) -> T + Sync>(n: usize, threads: usize, f: F) -> Vec<T> {
    let workers = threads.clamp(1, n.max(1));
    let mut slots: Vec<Option<T>> = (0..n).map(|_| None).collect();
    std::thread::scope(|s| {
        let f = &f;
        let handles: Vec<_> = (0..workers)
            .map(|w| {
                s.spawn(move || {
                    (w..n).step_by(workers).map(|i| (i, f(i))).collect::<Vec<(usize, T)>>()
                })
            })
            .collect();
        for h in handles {
            for (i, v) in h.join().expect("fit worker panicked") {
                slots[i] = Some(v);
            }
        }
    });
    slots.into_iter().map(|v| v.expect("job result")).collect()
}

pub fn load_ref_set(folder: &Path, notes: &[u8], threads: usize) -> Result<RefSet, String> {
    let mut by_velocity: Vec<Vec<RefNote>> = Vec::new();
    for &v in &VELOCITIES {
        by_velocity.push(single_notes(folder, v)?);
    }
    let mut jobs: Vec<RefNote> = Vec::new();
    for &n in notes {
        for (vi, list) in by_velocity.iter().enumerate() {
            let r = list
                .iter()
                .find(|r| r.note == n)
                .ok_or_else(|| format!("note {n} is missing from single-notes-v{:03}.mid", VELOCITIES[vi]))?;
            jobs.push(*r);
        }
    }
    let results = parallel_map(jobs.len(), threads, |i| {
        let r = jobs[i];
        let x = read_segment(folder, &r)?;
        Ok::<_, String>((r, analyze_note(&x, REF_RATE, r.note, r.hold_s())))
    });
    let mut items = Vec::new();
    for res in results {
        items.push(res?);
    }
    Ok(RefSet { items })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(note: u8, tail: f64, release: f64) -> (RefNote, NoteFeatures) {
        (
            RefNote { note, velocity: 64, on_s: 0.0, off_s: 4.0 },
            NoteFeatures { tail_db_per_s: Some(tail), release_ms: Some(release), ..Default::default() },
        )
    }

    #[test]
    fn measured_undamped_from_follows_highest_damped_note() {
        let refs = RefSet { items: vec![item(80, 10.0, 300.0), item(90, 20.0, 200.0), item(100, 30.0, 900.0)] };
        let notes = [80, 90, 100];
        let (u, rows) = measured_undamped_from(&refs, &notes, 89);
        assert_eq!(u, 91);
        assert_eq!(rows.iter().map(|r| r.damped).collect::<Vec<_>>(), vec![true, true, false]);
        assert_eq!(measured_undamped_from(&refs, &notes, 95).0, 95);
    }
}
