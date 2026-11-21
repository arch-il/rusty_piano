//! Per-note direct level from the centroid error: the shared soundboard leaves the treble dark, so each note gets the direct_db that best matches the reference spectral centroid.

use super::analysis::analyze_note;
use super::evaluate::render_note;
use super::reference::{parallel_map, RefSet, VELOCITIES};
use crate::sound::modal_piano::tables::{NoteAnchor, NoteTable};
use crate::sound::modal_piano::ModalProfile;

pub const DIRECT_DB_GRID: [f32; 10] = [-12.0, -6.0, -3.0, 0.0, 3.0, 6.0, 9.0, 12.0, 15.0, 18.0];
pub const MIN_GAIN_ST: f64 = 1.0;

pub const TREBLE_FROM_NOTE: u8 = 86;

fn eligible(note: u8) -> bool {
    note >= TREBLE_FROM_NOTE
}

fn with_direct(p: &ModalProfile, note: u8, direct_db: f32) -> ModalProfile {
    let mut q = *p;
    q.notes = NoteTable::from_anchors(&[NoteAnchor { direct_db, ..p.notes.at(note) }]).expect("single anchor table");
    q
}

fn velocity_error(q: &ModalProfile, refs: &RefSet, note: u8, v: u8) -> Option<f64> {
    let (_, rf) = refs.get(note, v)?;
    let rc = rf.centroid_hz.filter(|&c| c > 0.0)?;
    let x = render_note(q, note, v, 0.5, 0.0);
    let oc = analyze_note(&x, 48000, note, 0.5).centroid_hz.filter(|&c| c > 0.0)?;
    Some(12.0 * (oc / rc).log2())
}

fn mean(v: &[Option<f64>]) -> Option<f64> {
    let a: Vec<f64> = v.iter().flatten().copied().collect();
    if a.is_empty() {
        None
    } else {
        Some(a.iter().sum::<f64>() / a.len() as f64)
    }
}

pub fn centroid_error(p: &ModalProfile, refs: &RefSet, note: u8, direct_db: f32) -> Option<f64> {
    let q = with_direct(p, note, direct_db);
    let e: Vec<Option<f64>> = VELOCITIES.iter().map(|&v| velocity_error(&q, refs, note, v)).collect();
    mean(&e)
}

fn pick(errors: &[(f32, Option<f64>)]) -> Option<(f32, f64)> {
    let mut best: Option<(f32, f64)> = None;
    for &(d, e) in errors {
        if let Some(e) = e {
            if best.is_none_or(|(_, b)| e.abs() < b.abs()) {
                best = Some((d, e));
            }
        }
    }
    best
}

pub fn best_direct_db(p: &ModalProfile, refs: &RefSet, note: u8, threads: usize) -> Option<(f32, f64)> {
    let errors = parallel_map(DIRECT_DB_GRID.len(), threads, |i| (DIRECT_DB_GRID[i], centroid_error(p, refs, note, DIRECT_DB_GRID[i])));
    pick(&errors)
}

fn median_abs(v: &[f64]) -> f64 {
    if v.is_empty() {
        return 0.0;
    }
    let mut a: Vec<f64> = v.iter().map(|x| x.abs()).collect();
    a.sort_by(|x, y| x.partial_cmp(y).unwrap());
    let n = a.len();
    if n % 2 == 1 {
        a[n / 2]
    } else {
        0.5 * (a[n / 2 - 1] + a[n / 2])
    }
}

pub fn brightness_pass(p: &ModalProfile, refs: &RefSet, notes: &[u8], threads: usize) -> (Vec<(u8, f32)>, String) {
    let mut jobs: Vec<(usize, f32, u8)> = Vec::new();
    for (ni, &n) in notes.iter().enumerate() {
        if !eligible(n) {
            continue;
        }
        for d in DIRECT_DB_GRID {
            for &v in &VELOCITIES {
                jobs.push((ni, d, v));
            }
        }
    }
    let res = parallel_map(jobs.len(), threads, |i| {
        let (ni, d, v) = jobs[i];
        let n = notes[ni];
        velocity_error(&with_direct(p, n, d), refs, n, v)
    });
    let mut chosen: Vec<(u8, f32)> = Vec::new();
    let mut before: Vec<f64> = Vec::new();
    let mut after: Vec<f64> = Vec::new();
    for (ni, &n) in notes.iter().enumerate() {
        if !eligible(n) {
            chosen.push((n, 0.0));
            continue;
        }
        let mut errors: Vec<(f32, Option<f64>)> = Vec::new();
        for d in DIRECT_DB_GRID {
            let e: Vec<Option<f64>> = jobs.iter().zip(&res).filter(|((j, jd, _), _)| *j == ni && *jd == d).map(|(_, r)| *r).collect();
            errors.push((d, mean(&e)));
        }
        let e0 = errors.iter().find(|(d, _)| *d == 0.0).and_then(|(_, e)| *e);
        let best = pick(&errors);
        let mut d = 0.0f32;
        let mut e_after = e0;
        if let (Some(e0), Some((bd, be))) = (e0, best) {
            if be.abs() <= e0.abs() - MIN_GAIN_ST {
                d = bd;
                e_after = Some(be);
            }
        }
        if let Some(e) = e0 {
            before.push(e);
        }
        if let Some(e) = e_after {
            after.push(e);
        }
        chosen.push((n, d));
    }
    let changed: Vec<(u8, f32)> = chosen.iter().copied().filter(|&(_, d)| d != 0.0).collect();
    let edge = changed.iter().filter(|&&(_, d)| d == DIRECT_DB_GRID[DIRECT_DB_GRID.len() - 1]).count();
    let line = format!(
        "brightness pass: {} notes (only notes from 86), {} changed, median |centroid| before {:.2} st after {:.2} st; changed {:?}, {} at the grid edge (+18 dB)",
        notes.len(),
        changed.len(),
        median_abs(&before),
        median_abs(&after),
        changed,
        edge
    );
    (chosen, line)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fit::reference::RefNote;

    fn table(note: u8, direct_db: f32) -> NoteTable {
        NoteTable::from_anchors(&[NoteAnchor { direct_db, ..NoteAnchor::neutral(note) }]).unwrap()
    }

    fn refs_from(p: &ModalProfile, note: u8) -> RefSet {
        let items = VELOCITIES
            .iter()
            .map(|&v| {
                (
                    RefNote { note, velocity: v, on_s: 0.0, off_s: 0.5 },
                    analyze_note(&render_note(p, note, v, 0.5, 0.0), 48000, note, 0.5),
                )
            })
            .collect();
        RefSet { items }
    }

    fn base_target(note: u8, db: f32) -> (ModalProfile, ModalProfile) {
        let base = ModalProfile { notes: table(note, 0.0), ..Default::default() };
        let mut target = base;
        target.notes = table(note, db);
        (base, target)
    }

    #[test]
    #[cfg_attr(debug_assertions, ignore = "needs release")]
    fn best_direct_db_recovers_a_synthetic_target() {
        let (base, target) = base_target(96, 12.0);
        let refs = refs_from(&target, 96);
        let (d, e) = best_direct_db(&base, &refs, 96, 4).unwrap();
        assert_eq!(d, 12.0);
        assert!(e.abs() < 1e-9, "{e}");
    }

    #[test]
    #[cfg_attr(debug_assertions, ignore = "needs release")]
    fn brightness_pass_keeps_zero_when_already_matched() {
        let (base, _) = base_target(96, 0.0);
        let refs = refs_from(&base, 96);
        let (chosen, line) = brightness_pass(&base, &refs, &[96], 4);
        assert_eq!(chosen, vec![(96, 0.0)]);
        assert!(line.starts_with("brightness pass:"), "{line}");
    }

    #[test]
    #[cfg_attr(debug_assertions, ignore = "needs release")]
    fn brightness_pass_leaves_mid_notes_alone() {
        let (base, target) = base_target(60, 12.0);
        let refs = refs_from(&target, 60);
        let (chosen, _) = brightness_pass(&base, &refs, &[60], 4);
        assert_eq!(chosen, vec![(60, 0.0)]);
    }

    #[test]
    #[cfg_attr(debug_assertions, ignore = "needs release")]
    fn brightness_pass_leaves_bass_notes_alone() {
        let (base, target) = base_target(21, 12.0);
        let refs = refs_from(&target, 21);
        let (chosen, _) = brightness_pass(&base, &refs, &[21], 4);
        assert_eq!(chosen, vec![(21, 0.0)]);
    }
}
