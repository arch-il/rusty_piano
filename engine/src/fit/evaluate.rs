//! Renders notes with a modal profile and measures how far they are from the references (per-note errors, score, summary).

use super::analysis::{analyze_note, NoteFeatures};
use super::reference::{parallel_map, RefSet, AFTER_KEY_UP_S, VELOCITIES};
use crate::midi::MidiEvent;
use crate::render::render_events_stereo;
use crate::sound::modal_piano::profile::ModalNoises;
use crate::sound::modal_piano::{ModalPiano, ModalProfile};

const RATE: u32 = 48000;

/// Renders one note alone. The master volume is set to 0.05 and the result scaled by 20, so the soft limiter never touches a single note; the shipped master volume is unchanged.
/// Mechanical noises are switched off: the fit and its checks measure the string/body model; key-up noise otherwise sets the level l0 of the release measurement.
/// The sympathetic resonance bank is off too, so each single-note measurement depends only on that note's own anchor; the shipped profile keeps both.
/// The reverb is off too: the fit measures the dry instrument.
pub fn render_note(p: &ModalProfile, note: u8, velocity: u8, hold_s: f64, tail_s: f64) -> Vec<f32> {
    let mut q = *p;
    q.output.master_volume = 0.05;
    q.noises = ModalNoises::off();
    q.resonance.strength = 0.0;
    q.reverb.mix = 0.0;
    let mut e = ModalPiano::with_profile(RATE, &q);
    let events = vec![
        (0u64, MidiEvent::NoteOn { note, velocity }),
        ((hold_s * 1e6).round() as u64, MidiEvent::NoteOff { note }),
    ];
    let buf = render_events_stereo(&mut e, &events, RATE, tail_s);
    buf.left
        .iter()
        .zip(buf.right.iter())
        .map(|(l, r)| 0.5 * (l + r) * 20.0)
        .collect()
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Job {
    pub note: u8,
    pub velocity: u8,
    pub hold_s: f64,
    pub full: bool,
}

pub fn our_features(p: &ModalProfile, jobs: &[Job], threads: usize) -> Vec<NoteFeatures> {
    parallel_map(jobs.len(), threads, |i| {
        let j = jobs[i];
        let (hold, tail) = if j.full { (j.hold_s, AFTER_KEY_UP_S) } else { (0.5, 0.0) };
        let x = render_note(p, j.note, j.velocity, hold, tail);
        analyze_note(&x, RATE, j.note, hold)
    })
}

pub fn eval_jobs(refs: &RefSet, notes: &[u8]) -> Vec<Job> {
    let mut jobs = Vec::new();
    for &n in notes {
        let hold = refs.get(n, 64).map_or(3.0, |(r, _)| r.hold_s());
        jobs.push(Job { note: n, velocity: 64, hold_s: hold, full: true });
        for v in [16u8, 40, 96, 127] {
            jobs.push(Job { note: n, velocity: v, hold_s: 0.5, full: false });
        }
    }
    jobs
}

#[derive(Debug, Clone, PartialEq)]
pub struct NoteError {
    pub note: u8,
    pub level_by_velocity: [Option<f64>; 5],
    pub level_db: Option<f64>,
    pub level_shape_db: Option<f64>,
    pub centroid_by_velocity: [Option<f64>; 5],
    pub centroid_st: Option<f64>,
    pub centroid_shape_st: Option<f64>,
    pub d1_db: Option<f64>,
    pub d2_db: Option<f64>,
    pub tail_log2: Option<f64>,
    pub cdrop_log2: Option<f64>,
    pub cents: Option<f64>,
    pub b_log2: Option<f64>,
    pub release_log2: Option<f64>,
    /// ours - reference late_release_db, damped notes only; not part of note_score (own fit phase).
    pub late_release_db: Option<f64>,
    pub ours: NoteFeatures,
    pub reference: NoteFeatures,
}

fn mean_shape(v: &[Option<f64>; 5]) -> (Option<f64>, Option<f64>) {
    let vals: Vec<f64> = v.iter().flatten().copied().collect();
    if vals.len() < 3 {
        return (None, None);
    }
    let mean = vals.iter().sum::<f64>() / vals.len() as f64;
    let shape = (vals.iter().map(|x| (x - mean) * (x - mean)).sum::<f64>() / vals.len() as f64).sqrt();
    (Some(mean), Some(shape))
}

fn diff(a: Option<f64>, b: Option<f64>) -> Option<f64> {
    Some(a? - b?)
}

fn log2_ratio(a: Option<f64>, b: Option<f64>) -> Option<f64> {
    let (a, b) = (a?, b?);
    if a > 0.0 && b > 0.0 {
        Some((a / b).log2())
    } else {
        None
    }
}

pub fn build_errors(refs: &RefSet, jobs: &[Job], feats: &[NoteFeatures], notes: &[u8], p: &ModalProfile) -> Vec<NoteError> {
    let find = |note: u8, v: u8| -> Option<NoteFeatures> {
        jobs.iter().position(|j| j.note == note && j.velocity == v).and_then(|i| feats.get(i).copied())
    };
    notes
        .iter()
        .map(|&n| {
            let mut level = [None; 5];
            let mut cent = [None; 5];
            for (k, &v) in VELOCITIES.iter().enumerate() {
                if let (Some(o), Some((_, r))) = (find(n, v), refs.get(n, v)) {
                    level[k] = Some(o.peak_db - r.peak_db);
                    cent[k] = log2_ratio(o.centroid_hz, r.centroid_hz).map(|x| 12.0 * x);
                }
            }
            let (level_db, level_shape_db) = mean_shape(&level);
            let (centroid_st, centroid_shape_st) = mean_shape(&cent);
            let ours = find(n, 64).unwrap_or_default();
            let r = refs.get(n, 64).map(|(_, f)| *f).unwrap_or_default();
            let tail = |f: &NoteFeatures| f.tail_db_per_s.map(|t| t.max(0.3));
            let cdrop = |f: &NoteFeatures| -> Option<f64> {
                let (c, l) = (f.centroid_hz?, f.late_centroid_hz?);
                if c > 0.0 && l > 0.0 { Some(c / l) } else { None }
            };
            NoteError {
                note: n,
                level_by_velocity: level,
                level_db,
                level_shape_db,
                centroid_by_velocity: cent,
                centroid_st,
                centroid_shape_st,
                d1_db: diff(ours.d1_db, r.d1_db),
                d2_db: diff(ours.d2_db, r.d2_db),
                tail_log2: log2_ratio(tail(&ours), tail(&r)),
                cdrop_log2: log2_ratio(cdrop(&ours), cdrop(&r)),
                cents: diff(ours.cents, r.cents),
                b_log2: log2_ratio(ours.inharmonicity, r.inharmonicity),
                release_log2: if n >= p.decay.undamped_from_note {
                    None
                } else {
                    log2_ratio(ours.release_ms, r.release_ms)
                },
                late_release_db: if n >= p.decay.undamped_from_note {
                    None
                } else {
                    diff(ours.late_release_db, r.late_release_db)
                },
                ours,
                reference: r,
            }
        })
        .collect()
}

/// Sum of the available squared terms, each capped at 25.
pub fn note_score(e: &NoteError, offset_db: f64) -> f64 {
    let t = |x: Option<f64>, scale: f64| x.map_or(0.0, |v| ((v / scale) * (v / scale)).min(25.0));
    t(e.level_db.map(|l| l - offset_db), 1.0)
        + t(e.level_shape_db, 1.0)
        + t(e.d1_db, 2.0)
        + t(e.d2_db, 3.0)
        + t(e.tail_log2, 0.25)
        + t(e.centroid_st, 1.0)
        + t(e.centroid_shape_st, 1.0)
        + t(e.cdrop_log2, 0.25)
        + t(e.cents, 2.0)
        + t(e.b_log2, 0.25)
        + t(e.release_log2, 0.25)
}

#[derive(Debug, Clone, PartialEq)]
pub struct Summary {
    pub level: Option<f64>,
    pub level_shape: Option<f64>,
    pub d1: Option<f64>,
    pub d2: Option<f64>,
    pub tail: Option<f64>,
    pub centroid: Option<f64>,
    pub centroid_shape: Option<f64>,
    pub cdrop: Option<f64>,
    pub cents: Option<f64>,
    pub b: Option<f64>,
    pub release: Option<f64>,
    pub late: Option<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Evaluation {
    pub notes: Vec<NoteError>,
    pub level_offset_db: f64,
    pub summary: Summary,
    pub score: f64,
}

fn median(mut v: Vec<f64>) -> Option<f64> {
    if v.is_empty() {
        return None;
    }
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let n = v.len();
    Some(if n % 2 == 1 { v[n / 2] } else { 0.5 * (v[n / 2 - 1] + v[n / 2]) })
}

fn median_abs(errors: &[NoteError], f: impl Fn(&NoteError) -> Option<f64>) -> Option<f64> {
    median(errors.iter().filter_map(f).filter(|x| x.is_finite()).map(f64::abs).collect())
}

pub fn finish(errors: Vec<NoteError>) -> Evaluation {
    let offset = median(errors.iter().filter_map(|e| e.level_db).filter(|x| x.is_finite()).collect()).unwrap_or(0.0);
    let summary = Summary {
        level: median_abs(&errors, |e| e.level_db.map(|l| l - offset)),
        level_shape: median_abs(&errors, |e| e.level_shape_db),
        d1: median_abs(&errors, |e| e.d1_db),
        d2: median_abs(&errors, |e| e.d2_db),
        tail: median_abs(&errors, |e| e.tail_log2),
        centroid: median_abs(&errors, |e| e.centroid_st),
        centroid_shape: median_abs(&errors, |e| e.centroid_shape_st),
        cdrop: median_abs(&errors, |e| e.cdrop_log2),
        cents: median_abs(&errors, |e| e.cents),
        b: median_abs(&errors, |e| e.b_log2),
        release: median_abs(&errors, |e| e.release_log2),
        late: median_abs(&errors, |e| e.late_release_db),
    };
    let score = if errors.is_empty() {
        0.0
    } else {
        errors.iter().map(|e| note_score(e, offset)).sum::<f64>() / errors.len() as f64
    };
    Evaluation { notes: errors, level_offset_db: offset, summary, score }
}

pub fn evaluate(p: &ModalProfile, refs: &RefSet, notes: &[u8], threads: usize) -> Evaluation {
    let jobs = eval_jobs(refs, notes);
    let feats = our_features(p, &jobs, threads);
    finish(build_errors(refs, &jobs, &feats, notes, p))
}

fn f2(x: Option<f64>) -> String {
    x.map_or("-".to_string(), |v| format!("{v:.2}"))
}

pub fn summary_line(s: &Summary) -> String {
    format!(
        "median abs error: level {} dB, shape {} dB, d1 {} dB, d2 {} dB, tail {}, centroid {} st, centroid shape {} st, cdrop {}, cents {}, B {}, release {}, late {} dB",
        f2(s.level),
        f2(s.level_shape),
        f2(s.d1),
        f2(s.d2),
        f2(s.tail),
        f2(s.centroid),
        f2(s.centroid_shape),
        f2(s.cdrop),
        f2(s.cents),
        f2(s.b),
        f2(s.release),
        f2(s.late)
    )
}

pub fn report_table(before: &Evaluation, after: Option<&Evaluation>) -> String {
    let mut out = String::new();
    out.push_str("note |  level dB | shape dB | d1 dB | d2 dB | tail log2 | centroid st | cshape st | cdrop log2 | cents | B log2 | release log2 | late dB\n");
    let cell = |b: Option<f64>, a: Option<f64>| match after {
        Some(_) => format!("{}>{}", f2(b), f2(a)),
        None => f2(b),
    };
    for (i, b) in before.notes.iter().enumerate() {
        let a = after.and_then(|e| e.notes.get(i));
        let g = |f: &dyn Fn(&NoteError) -> Option<f64>| cell(f(b), a.and_then(f));
        let off_b = before.level_offset_db;
        let off_a = after.map_or(0.0, |e| e.level_offset_db);
        let level_b = b.level_db.map(|l| l - off_b);
        let level_a = a.and_then(|x| x.level_db).map(|l| l - off_a);
        out.push_str(&format!(
            "{:>4} | {} | {} | {} | {} | {} | {} | {} | {} | {} | {} | {} | {}\n",
            b.note,
            cell(level_b, level_a),
            g(&|e| e.level_shape_db),
            g(&|e| e.d1_db),
            g(&|e| e.d2_db),
            g(&|e| e.tail_log2),
            g(&|e| e.centroid_st),
            g(&|e| e.centroid_shape_st),
            g(&|e| e.cdrop_log2),
            g(&|e| e.cents),
            g(&|e| e.b_log2),
            g(&|e| e.release_log2),
            g(&|e| e.late_release_db),
        ));
    }
    match after {
        Some(a) => {
            out.push_str(&format!("level offset before: {:.2} dB\n", before.level_offset_db));
            out.push_str(&format!("level offset after: {:.2} dB\n", a.level_offset_db));
            out.push_str(&format!("before: {}\n", summary_line(&before.summary)));
            out.push_str(&format!("after: {}\n", summary_line(&a.summary)));
            out.push_str(&format!("score before: {:.3}, after: {:.3}\n", before.score, a.score));
        }
        None => {
            out.push_str(&format!("level offset: {:.2} dB\n", before.level_offset_db));
            out.push_str(&format!("{}\n", summary_line(&before.summary)));
            out.push_str(&format!("score: {:.3}\n", before.score));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sound::modal_piano::tables::{NoteAnchor, NoteTable};

    #[test]
    fn render_note_is_noise_free() {
        let p = ModalProfile::default();
        let mut q = p;
        q.noises = ModalNoises::off();
        assert_eq!(render_note(&p, 84, 64, 0.5, 0.5), render_note(&q, 84, 64, 0.5, 0.5));
    }

    #[test]
    fn render_note_ignores_reverb() {
        let mut p = ModalProfile::default();
        p.reverb.mix = 0.5;
        let mut q = p;
        q.reverb.mix = 0.0;
        assert_eq!(render_note(&p, 60, 64, 0.5, 0.5), render_note(&q, 60, 64, 0.5, 0.5));
    }

    #[test]
    fn release_follows_damper_without_noises() {
        let release = |m: f32| {
            let p = ModalProfile {
                notes: NoteTable::from_anchors(&[NoteAnchor { damper: m, ..NoteAnchor::neutral(84) }]).unwrap(),
                ..Default::default()
            };
            let x = render_note(&p, 84, 64, 4.0, 2.0);
            analyze_note(&x, RATE, 84, 4.0).release_ms
        };
        let (r1, r4) = (release(1.0), release(4.0));
        println!("release_ms damper 1: {r1:?}, damper 4: {r4:?}");
        let (Some(r1), Some(r4)) = (r1, r4) else { panic!("release None: {r1:?} {r4:?}") };
        assert!(r4 >= 2.0 * r1, "release {r1} -> {r4}");
    }

    #[test]
    fn single_note_render_ignores_other_anchors() {
        let base: Vec<NoteAnchor> = [36, 60, 72, 84, 96].iter().map(|&n| NoteAnchor::neutral(n)).collect();
        let mut changed = base.clone();
        for a in changed.iter_mut().filter(|a| a.note == 84 || a.note == 96) {
            a.t60 = 0.3;
            a.aftersound = 4.0;
            a.damper = 8.0;
        }
        let p = ModalProfile {
            notes: NoteTable::from_anchors(&base).unwrap(),
            ..Default::default()
        };
        let mut q = p;
        q.notes = NoteTable::from_anchors(&changed).unwrap();
        assert_eq!(render_note(&p, 72, 64, 1.0, 1.0), render_note(&q, 72, 64, 1.0, 1.0));
    }

    #[test]
    #[cfg_attr(debug_assertions, ignore = "needs release")]
    fn treble_damper_above_88_when_enabled() {
        let mut p = ModalProfile {
            notes: NoteTable::from_anchors(&[NoteAnchor { damper: 5.0, ..NoteAnchor::neutral(96) }]).unwrap(),
            ..Default::default()
        };
        p.decay.undamped_from_note = 97;
        let x = render_note(&p, 96, 64, 3.0, 2.0);
        let r = analyze_note(&x, RATE, 96, 3.0).release_ms;
        p.decay.undamped_from_note = 89;
        let x = render_note(&p, 96, 64, 3.0, 2.0);
        let u = analyze_note(&x, RATE, 96, 3.0).release_ms;
        println!("release_ms note 96 damped: {r:?}, undamped: {u:?}");
        let Some(r) = r else { panic!("damped release None") };
        assert!(r < 1500.0, "release {r}");
        assert!(u.is_none_or(|u| u >= 2.0 * r), "undamped release {u:?} vs {r}");
    }
}
