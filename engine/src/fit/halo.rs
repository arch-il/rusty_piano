//! Fitting the sympathetic resonance (strength, partials, max_hz) to the numbers measured from the private Pianoteq 9 NY Steinway D Player render `pedal-pairs`. Numbers only; no audio is read here.

use crate::fit::reference::parallel_map;
use crate::midi::MidiEvent;
use crate::sound::modal_piano::profile::{ModalResonance, MAX_RESONANCE_PARTIALS};
use crate::sound::modal_piano::{ModalPiano, ModalProfile};
use crate::sound::SoundEngine;

/// (note, on0, off0, on1, off1, pedal_up) in seconds from the WAV start, 48 kHz.
/// Every strike is velocity 80. The first strike of a pair has no pedal. For
/// the second, the sustain pedal goes down 0.2 s before the strike (CC64 127
/// at on1 - 0.2) and comes up at pedal_up.
pub const PAIRS: [(u8, f64, f64, f64, f64, f64); 7] = [
    (28, 0.5, 0.8, 11.0, 11.3, 19.0),
    (36, 21.5, 21.8, 32.0, 32.3, 40.0),
    (48, 42.5, 42.8, 53.0, 53.3, 61.0),
    (60, 63.5, 63.8, 74.0, 74.3, 82.0),
    (72, 84.5, 84.8, 95.0, 95.3, 103.0),
    (84, 105.5, 105.8, 116.0, 116.3, 124.0),
    (96, 126.5, 126.8, 137.0, 137.3, 145.0),
];

#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PairRef {
    /// MIDI note of the pair.
    pub note: u8,
    /// Loudest 50 ms frame of the strike without pedal, in the 0.5 s after on0.
    pub peak_db: f64,
    /// Level 1.0..1.5 s after key-up, no pedal.
    pub np1_db: f64,
    /// Level 1.0..1.5 s after key-up, with pedal.
    pub p1_db: f64,
    /// Level 2.5..3.0 s after key-up, no pedal.
    pub np2_db: f64,
    /// Level 2.5..3.0 s after key-up, with pedal.
    pub p2_db: f64,
    /// Background level 0.7..0.25 s before the second strike (before pedal down).
    pub floor_db: f64,
    /// Loudest 50 ms frame in the 0.2 s between pedal-down and the strike.
    pub down_db: f64,
    /// Level 0.25..0.05 s before the pedal release.
    pub up_before_db: f64,
    /// Loudest 50 ms frame in the 0.3 s after the pedal release.
    pub up_db: f64,
}

pub fn level_db(x: &[f32]) -> f64 {
    let s: f64 = x.iter().map(|&v| (v as f64) * (v as f64)).sum();
    10.0 * (s / x.len() as f64 + 1e-30).log10()
}

pub fn idx(s: f64) -> usize {
    (s * 48000.0).round() as usize
}

pub fn win(m: &[f32], a: f64, b: f64) -> f64 {
    level_db(&m[idx(a)..idx(b)])
}

pub fn fmax(m: &[f32], start: f64, n: usize) -> f64 {
    (0..n)
        .map(|i| win(m, start + 0.05 * i as f64, start + 0.05 * (i + 1) as f64))
        .fold(f64::NEG_INFINITY, f64::max)
}

pub fn measure_pair(m: &[f32], p: &(u8, f64, f64, f64, f64, f64)) -> PairRef {
    let (note, on0, off0, on1, off1, pedal_up) = *p;
    PairRef {
        note,
        peak_db: fmax(m, on0, 10),
        np1_db: win(m, off0 + 1.0, off0 + 1.5),
        p1_db: win(m, off1 + 1.0, off1 + 1.5),
        np2_db: win(m, off0 + 2.5, off0 + 3.0),
        p2_db: win(m, off1 + 2.5, off1 + 3.0),
        floor_db: win(m, on1 - 0.7, on1 - 0.25),
        down_db: fmax(m, on1 - 0.2, 4),
        up_before_db: win(m, pedal_up - 0.25, pedal_up - 0.05),
        up_db: fmax(m, pedal_up, 6),
    }
}

// Pianoteq 9 NY Steinway D Player, pedal-pairs.wav (velocity 80), measured 2026-11-05 by measure_pedal_pairs_reference; numbers only, no audio from the private reference folder is read at normal test time or committed.
pub const PEDAL_PAIRS_REF: [PairRef; 7] = [
    PairRef { note: 28, peak_db: -26.61, np1_db: -83.12, p1_db: -30.55, np2_db: -119.24, p2_db: -33.41, floor_db: -142.49, down_db: -68.60, up_before_db: -40.69, up_db: -41.81 },
    PairRef { note: 36, peak_db: -24.57, np1_db: -85.02, p1_db: -34.39, np2_db: -115.08, p2_db: -40.50, floor_db: -142.43, down_db: -68.60, up_before_db: -47.45, up_db: -48.92 },
    PairRef { note: 48, peak_db: -24.65, np1_db: -84.81, p1_db: -35.97, np2_db: -117.18, p2_db: -44.09, floor_db: -142.36, down_db: -68.60, up_before_db: -52.09, up_db: -54.42 },
    PairRef { note: 60, peak_db: -24.01, np1_db: -87.39, p1_db: -37.24, np2_db: -122.74, p2_db: -47.57, floor_db: -142.44, down_db: -68.60, up_before_db: -56.79, up_db: -58.00 },
    PairRef { note: 72, peak_db: -26.86, np1_db: -88.64, p1_db: -46.22, np2_db: -126.05, p2_db: -57.24, floor_db: -142.47, down_db: -68.60, up_before_db: -64.61, up_db: -62.06 },
    PairRef { note: 84, peak_db: -23.23, np1_db: -93.82, p1_db: -61.89, np2_db: -125.97, p2_db: -71.14, floor_db: -142.47, down_db: -68.60, up_before_db: -87.90, up_db: -68.77 },
    PairRef { note: 96, peak_db: -25.13, np1_db: -70.96, p1_db: -63.15, np2_db: -106.08, p2_db: -75.62, floor_db: -142.41, down_db: -68.60, up_before_db: -91.13, up_db: -68.84 },
];

pub fn render_into(e: &mut ModalPiano, out: &mut Vec<f32>, secs: f64) {
    let mut l = [0.0f32; 64];
    let mut r = [0.0f32; 64];
    let mut left = idx(secs);
    while left > 0 {
        let k = left.min(64);
        e.render_stereo(&mut l[..k], &mut r[..k]);
        out.extend(l[..k].iter().zip(r[..k].iter()).map(|(a, b)| 0.5 * (a + b)));
        left -= k;
    }
}

pub fn floored(level: f64, peak: f64) -> f64 {
    level.max(peak - 80.0)
}

/// Excess power of the pedalled window over the unpedalled one, relative to the strike peak, floored at -80 dB.
pub fn halo_db(peak: f64, pedal: f64, nopedal: f64) -> f64 {
    let p = 10f64.powf(floored(pedal, peak) / 10.0);
    let np = 10f64.powf(floored(nopedal, peak) / 10.0);
    let ex = p - np;
    if ex <= 0.0 {
        -80.0
    } else {
        (10.0 * ex.log10() - peak).max(-80.0)
    }
}

pub fn ours_pair(p: &ModalProfile, note: u8, pedal: bool) -> (f64, f64, f64) {
    let mut e = ModalPiano::with_profile(48000, p);
    let mut m = Vec::new();
    if pedal {
        e.handle(&MidiEvent::Sustain { on: true });
    }
    render_into(&mut e, &mut m, 0.2);
    e.handle(&MidiEvent::NoteOn { note, velocity: 80 });
    render_into(&mut e, &mut m, 0.3);
    e.handle(&MidiEvent::NoteOff { note });
    render_into(&mut e, &mut m, 3.1);
    (fmax(&m, 0.2, 10), win(&m, 1.5, 2.0), win(&m, 3.0, 3.5))
}

/// (ring1 - peak, ring2 - peak) of the pedal-pairs reference row of `note`, floored at peak - 80 dB.
pub fn ref_rings(note: u8) -> (f64, f64) {
    let r = PEDAL_PAIRS_REF.iter().find(|r| r.note == note).unwrap();
    (floored(r.p1_db, r.peak_db) - r.peak_db, floored(r.p2_db, r.peak_db) - r.peak_db)
}

/// The same two numbers for our engine with the pedal down. The pedalled render's own peak is used as the reference level.
pub fn our_rings(p: &ModalProfile, note: u8) -> (f64, f64) {
    let (peak, p1, p2) = ours_pair(p, note, true);
    (floored(p1, peak) - peak, floored(p2, peak) - peak)
}

/// Dry (unpedalled) ring error of one note against the reference: (note, window 1 error, window 2 error) in dB. A window floored on both sides carries no information and counts as 0.
pub fn dry_errors(p: &ModalProfile, threads: usize) -> Vec<(u8, f64, f64)> {
    parallel_map(PAIRS.len(), threads, |i| {
        let note = PAIRS[i].0;
        let r = PEDAL_PAIRS_REF.iter().find(|r| r.note == note).unwrap();
        let (peak, w1, w2) = ours_pair(p, note, false);
        let one = |ours: f64, refv: f64| {
            let fo = floored(ours, peak) - peak;
            let fr = floored(refv, r.peak_db) - r.peak_db;
            if fo <= -80.0 && fr <= -80.0 {
                0.0
            } else {
                fo - fr
            }
        };
        (note, one(w1, r.np1_db), one(w2, r.np2_db))
    })
}

pub const DRY_TOL_DB: f64 = 3.0;

/// Notes whose dry rings are within DRY_TOL_DB of the reference in both windows, and the others.
pub fn split_notes(dry: &[(u8, f64, f64)]) -> (Vec<u8>, Vec<u8>) {
    let used = dry.iter().filter(|d| d.1.abs() <= DRY_TOL_DB && d.2.abs() <= DRY_TOL_DB).map(|d| d.0).collect();
    let excluded = dry.iter().filter(|d| d.1.abs() > DRY_TOL_DB || d.2.abs() > DRY_TOL_DB).map(|d| d.0).collect();
    (used, excluded)
}

pub type HaloRow = (u8, f64, f64, f64, f64);

/// Rows (note, ours1, ref1, ours2, ref2) for the 7 pedal-pairs notes and the sum of squared differences.
pub fn halo_error(p: &ModalProfile, threads: usize) -> (f64, Vec<HaloRow>) {
    let all: Vec<u8> = PAIRS.iter().map(|x| x.0).collect();
    halo_error_on(p, threads, &all)
}

/// The same for the listed notes only.
pub fn halo_error_on(p: &ModalProfile, threads: usize, notes: &[u8]) -> (f64, Vec<HaloRow>) {
    let rows = parallel_map(notes.len(), threads, |i| {
        let note = notes[i];
        let (o1, o2) = our_rings(p, note);
        let (r1, r2) = ref_rings(note);
        (note, o1, r1, o2, r2)
    });
    let err = rows.iter().map(|r| (r.1 - r.2).powi(2) + (r.3 - r.4).powi(2)).sum();
    (err, rows)
}

#[derive(Debug, Clone, PartialEq)]
pub struct HaloSearch {
    pub strength: Vec<f32>,
    pub partials: Vec<usize>,
    pub max_hz: Vec<f32>,
}

impl HaloSearch {
    pub fn full() -> Self {
        Self {
            strength: vec![0.0, 0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0],
            partials: [2usize, 4, 6, 8, 10, 12].into_iter().filter(|&n| n <= MAX_RESONANCE_PARTIALS).collect(),
            // Never below 2200 Hz: the undamped top treble (C7 = 2093 Hz and up) must be able to ring along (profile rule).
            max_hz: vec![2200.0, 3000.0, 4000.0, 5000.0],
        }
    }
}

/// A halo fit on fewer usable notes is not trusted enough to replace the shipped resonance.
pub const MIN_HALO_NOTES: usize = 3;

#[derive(Debug, Clone)]
pub struct HaloFit {
    pub resonance: ModalResonance,
    pub error_before: f64,
    pub error_after: f64,
    pub report: String,
    pub used: Vec<u8>,
}

fn rows_text(rows: &[HaloRow]) -> String {
    let mut s = String::new();
    for r in rows {
        s.push_str(&format!(
            "  note {:>3}: ring1 ours {:7.2} ref {:7.2} | ring2 ours {:7.2} ref {:7.2}\n",
            r.0, r.1, r.2, r.3, r.4
        ));
    }
    s
}

fn start_error(used: &[u8], err_on: impl Fn(&[u8]) -> f64) -> f64 {
    err_on(used)
}

pub fn fit_halo(base: &ModalProfile, search: &HaloSearch, threads: usize) -> HaloFit {
    let dry = dry_errors(base, threads);
    let (used, excluded) = split_notes(&dry);
    let off: Vec<String> = dry
        .iter()
        .filter(|d| excluded.contains(&d.0))
        .map(|d| format!("{} ({:+.1}/{:+.1} dB)", d.0, d.1, d.2))
        .collect();
    let mut report = format!("halo: used notes {used:?}, excluded {excluded:?} (dry ring off by {})
", off.join(", "));
    if used.len() < 2 {
        report.push_str("halo: fewer than 2 usable notes, resonance left unchanged
");
        let (e, _) = halo_error_on(base, threads, &used);
        return HaloFit { resonance: base.resonance, error_before: e, error_after: e, report, used };
    }
    let (error_before, rows_before) = halo_error_on(base, threads, &used);
    let mut cur = ModalResonance::default();
    let mut p = *base;
    p.resonance = cur;
    let mut cur_err = start_error(&used, |n| halo_error_on(&p, threads, n).0);
    report.push_str(&format!("start (default resonance) error {cur_err:.2}
"));
    for (round, which) in ["strength", "partials", "max_hz", "strength"].iter().enumerate() {
        let cands: Vec<ModalResonance> = match *which {
            "strength" => search.strength.iter().map(|&v| ModalResonance { strength: v, ..cur }).collect(),
            "partials" => search.partials.iter().map(|&v| ModalResonance { partials: v, ..cur }).collect(),
            _ => search.max_hz.iter().map(|&v| ModalResonance { max_hz: v, ..cur }).collect(),
        };
        let errs = parallel_map(cands.len(), threads, |i| {
            let mut q = *base;
            q.resonance = cands[i];
            halo_error_on(&q, 1, &used).0
        });
        report.push_str(&format!("round {} ({which}):\n", round + 1));
        let mut best: Option<usize> = None;
        for (i, (c, e)) in cands.iter().zip(errs.iter()).enumerate() {
            let v = match *which {
                "strength" => format!("{}", c.strength),
                "partials" => format!("{}", c.partials),
                _ => format!("{}", c.max_hz),
            };
            report.push_str(&format!("  {v:>8}  error {e:.2}\n"));
            if best.is_none_or(|b| *e < errs[b]) {
                best = Some(i);
            }
        }
        if let Some(b) = best {
            if errs[b] < cur_err - 0.05 {
                cur = cands[b];
                cur_err = errs[b];
            }
        }
        report.push_str(&format!(
            "  -> strength {} partials {} max_hz {} error {cur_err:.2}\n",
            cur.strength, cur.partials, cur.max_hz
        ));
    }
    let mut fitted = *base;
    fitted.resonance = cur;
    let (error_after, rows_after) = halo_error_on(&fitted, threads, &used);
    report.push_str(&format!("before: error {error_before:.2}\n{}", rows_text(&rows_before)));
    report.push_str(&format!("after: error {error_after:.2}\n{}", rows_text(&rows_after)));
    HaloFit { resonance: cur, error_before, error_after, report, used }
}

#[cfg(test)]
mod tests {
    use super::start_error;

    #[test]
    fn baseline_uses_the_same_notes_as_the_candidates() {
        let used = [10u8, 20];
        let e = start_error(&used, |n| n.iter().map(|&x| x as f64).sum());
        assert_eq!(e, 30.0);
    }
}
