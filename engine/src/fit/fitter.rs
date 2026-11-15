//! The fitter: velocity response, per-note passes, aftersound fold, gain with a headroom cap, and the fitted RON texts.

use super::analysis::{analyze_note, NoteFeatures};
use super::eq_fit::{band_error_db, solve_gains, BAND_WEIGHTS};
use super::evaluate::{build_errors, eval_jobs, evaluate, finish, our_features, render_note, report_table, Evaluation, Job, NoteError};
use crate::metrics::analyze;
use crate::render::{read_wav_mono, render_events_stereo, test_piece};
use super::reference::{measured_undamped_from, parallel_map, RefSet, AFTER_KEY_UP_S, VELOCITIES};
use super::ron_edit::{field_value, fmt_dec, fmt_sig, set_value, unfitted, write_fitted, FITTED_FIELDS};
use crate::midi::MidiEvent;
use crate::sound::modal_piano::tables::{NoteAnchor, NoteTable, MAX_NOTE_ANCHORS};
use crate::sound::modal_piano::{parse_modal_profile, ModalPiano, ModalProfile};
use std::path::{Path, PathBuf};
use std::time::Instant;

const RATE: u32 = 48000;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LogParam {
    pub x: f64,
    pub lo: f64,
    pub hi: f64,
    pub s0: f64,
    pub max_step: f64,
    pub prev: Option<(f64, f64)>,
    pub frozen: bool,
}

impl LogParam {
    pub fn new(lo: f64, hi: f64, s0: f64) -> Self {
        Self { x: 1.0, lo, hi, s0, max_step: 1.0, prev: None, frozen: false }
    }

    /// One log-secant step toward e = 0; e is the error of the current x.
    pub fn update(&mut self, e: Option<f64>) {
        let Some(e) = e else { return };
        if self.frozen || !e.is_finite() {
            return;
        }
        let lx = self.x.log2();
        let mut slope = self.s0;
        if let Some((lp, ep)) = self.prev {
            if (lx - lp).abs() > 1e-6 {
                let s = (e - ep) / (lx - lp);
                let a = self.s0.abs();
                if s.signum() == self.s0.signum() && (0.2 * a..=5.0 * a).contains(&s.abs()) {
                    slope = s;
                } else if (e - ep).abs() < 0.05 * a * (lx - lp).abs() {
                    self.frozen = true;
                    if ep.abs() < e.abs() {
                        self.x = lp.exp2();
                    }
                    return;
                }
            }
        }
        self.prev = Some((lx, e));
        let step = (-e / slope).clamp(-self.max_step, self.max_step);
        self.x = (lx + step).exp2().clamp(self.lo, self.hi);
    }
}

/// Fills the None entries by log2-linear interpolation by index between the nearest Some values; the ends copy the nearest; all None gives 1.0.
pub fn fill_gaps(v: &[Option<f64>]) -> Vec<f64> {
    let known: Vec<(usize, f64)> = v.iter().enumerate().filter_map(|(i, x)| x.map(|x| (i, x.log2()))).collect();
    (0..v.len())
        .map(|i| {
            if let Some(x) = v[i] {
                return x;
            }
            let before = known.iter().rev().find(|k| k.0 < i);
            let after = known.iter().find(|k| k.0 > i);
            match (before, after) {
                (Some(&(i0, l0)), Some(&(i1, l1))) => {
                    let t = (i - i0) as f64 / (i1 - i0) as f64;
                    (l0 + (l1 - l0) * t).exp2()
                }
                (Some(&(_, l)), None) | (None, Some(&(_, l))) => l.exp2(),
                (None, None) => 1.0,
            }
        })
        .collect()
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct NoteState {
    pub anchor: NoteAnchor,
    pub params: [LogParam; 6],
    pub best: Option<(NoteAnchor, [f64; 6], f64)>,
    pub restored: bool,
    pub measured: [bool; 6],
}

impl NoteState {
    pub fn new(note: u8) -> Self {
        Self {
            anchor: NoteAnchor::neutral(note),
            params: [
                LogParam::new(0.1, 10.0, 1.0),
                LogParam::new(0.2, 5.0, -1.0),
                LogParam::new(0.2, 5.0, 1.0),
                LogParam::new(0.1, 10.0, 0.5),
                LogParam::new(0.25, 4.0, 0.4),
                LogParam::new(0.2, 30.0, 1.0),
            ],
            best: None,
            restored: false,
            measured: [false; 6],
        }
    }

    fn xs(&self) -> [f64; 6] {
        self.params.map(|p| p.x)
    }

    /// Copies the parameter values into the anchor.
    pub fn sync(&mut self) {
        let [b, t, a, d, h, p] = self.xs().map(|x| x as f32);
        self.anchor.inharmonicity = b;
        self.anchor.t60 = t;
        self.anchor.aftersound = a;
        self.anchor.damping = d;
        self.anchor.hardness = h;
        self.anchor.damper = p;
    }

    /// Records the cost of the current anchor. A level shape above the bound (when a best exists) restores the best, freezes
    /// hardness and returns false. Otherwise a better cost (or the first measurement after a restore) becomes the best and
    /// returns true; a worse one restores the best, halves the steps and returns false (no update this pass).
    pub fn observe(&mut self, score: f64, shape: Option<f64>, bound: Option<f64>) -> bool {
        if self.best.is_some() && !self.restored {
            if let (Some(s), Some(b)) = (shape, bound) {
                if s > b + 1e-9 {
                    self.restore_best();
                    self.params[4].frozen = true;
                    self.restored = true;
                    return false;
                }
            }
        }
        let better = self.best.is_none_or(|b| score < b.2);
        if better || self.restored {
            self.best = Some((self.anchor, self.xs(), score));
            self.restored = false;
            return true;
        }
        self.restore_best();
        for p in &mut self.params {
            p.max_step *= 0.5;
        }
        self.restored = true;
        false
    }

    pub fn restore_best(&mut self) {
        if let Some((a, xs, _)) = self.best {
            self.anchor = a;
            for (p, x) in self.params.iter_mut().zip(xs) {
                p.x = x;
            }
        }
    }

    /// One update from the errors: cents (capped at +-50 per pass), level relative to the offset, and the six multipliers
    /// (inharmonicity, t60, aftersound, damping, hardness, damper).
    pub fn apply(&mut self, cents: Option<f64>, level_db: Option<f64>, e: [Option<f64>; 6]) {
        if let Some(c) = cents.filter(|c| c.is_finite()) {
            self.anchor.cents = (self.anchor.cents as f64 - c.clamp(-50.0, 50.0)).clamp(-100.0, 100.0) as f32;
        }
        if let Some(l) = level_db.filter(|l| l.is_finite()) {
            self.anchor.level_db = (self.anchor.level_db as f64 - l).clamp(-24.0, 24.0) as f32;
        }
        for (p, e) in self.params.iter_mut().zip(e) {
            p.update(e);
        }
        self.sync();
    }
}

fn note_inputs(err: &NoteError, offset: f64) -> (Option<f64>, Option<f64>, [Option<f64>; 6]) {
    let t60 = match (err.ours.d1_db, err.reference.d1_db) {
        (Some(o), Some(r)) => Some((o.max(1.0) / r.max(1.0)).log2()),
        _ => None,
    };
    let e = [
        err.b_log2,
        t60,
        err.tail_log2,
        err.cdrop_log2,
        err.centroid_st.map(|c| c / 12.0),
        err.release_log2,
    ];
    (err.cents, err.level_db.map(|l| l - offset), e.map(|x| x.filter(|v| v.is_finite())))
}

/// Keep-best cost of one note: the note_score terms and scales, with caps of 25 (level shape, centroid, centroid shape,
/// cdrop), 100 (tail, cents, B) and 400 (level, d1, d2, release).
fn fit_cost(e: &NoteError, offset: f64) -> f64 {
    let t = |x: Option<f64>, scale: f64, cap: f64| x.map_or(0.0, |v| ((v / scale) * (v / scale)).min(cap));
    t(e.level_db.map(|l| l - offset), 1.0, 400.0)
        + t(e.level_shape_db, 1.0, 25.0)
        + t(e.d1_db, 2.0, 400.0)
        + t(e.d2_db, 3.0, 400.0)
        + t(e.tail_log2, 0.25, 100.0)
        + t(e.centroid_st, 1.0, 25.0)
        + t(e.centroid_shape_st, 1.0, 25.0)
        + t(e.cdrop_log2, 0.25, 25.0)
        + t(e.cents, 2.0, 100.0)
        + t(e.b_log2, 0.25, 100.0)
        + t(e.release_log2, 0.25, 400.0)
}

/// Mean fit_cost over the notes at the evaluation's level offset.
fn table_cost(e: &Evaluation) -> f64 {
    if e.notes.is_empty() {
        0.0
    } else {
        e.notes.iter().map(|n| fit_cost(n, e.level_offset_db)).sum::<f64>() / e.notes.len() as f64
    }
}

/// Step kinds of drop_step.
pub const STEP_T60_L: u8 = 0;
pub const STEP_AFT_LONGER: u8 = 1;
pub const STEP_AFT_SHORTER: u8 = 2;
const A_MIN: f64 = 0.2;

/// One decoupled drop step; the kind is decided first and only that kind is applied: longer aftersound (multiplier down, less early drop, L at 0), shorter aftersound (multiplier up to 1, more early drop), else t60 by the slope error plus the two-sided early excess by after_level_db. The damper is not touched.
pub fn drop_step(a: &NoteAnchor, d1e: Option<f64>, slope_err: Option<f64>, our_slope_db: Option<f64>, gamma: f64, allow_aft: bool) -> (NoteAnchor, u8) {
    let f = |x: f64| x.clamp(-gamma, gamma).exp2();
    let mut b = *a;
    if allow_aft {
        if let Some(d) = d1e {
            if d > 2.0 && a.after_level_db >= -0.05 && (a.aftersound as f64) > A_MIN + 1e-6 {
                b.aftersound = (a.aftersound as f64 * (-0.5 * gamma.min(1.0)).exp2()).max(A_MIN) as f32;
                return (b, STEP_AFT_LONGER);
            }
            if d < -2.0 && a.after_level_db >= -0.05 && (a.aftersound as f64) < 1.0 - 1e-6 {
                b.aftersound = (a.aftersound as f64 * (0.5 * gamma.min(1.0)).exp2()).min(1.0) as f32;
                return (b, STEP_AFT_SHORTER);
            }
        }
    }
    let mut factor = 1.0;
    if let Some(es) = slope_err {
        b.t60 = (a.t60 as f64 * f(es)).clamp(0.1, 10.0) as f32;
        factor = b.t60 as f64 / a.t60 as f64;
    }
    if let Some(d) = d1e {
        let pred = d + our_slope_db.map_or(0.0, |s| s * (1.0 / factor - 1.0));
        if pred < 0.0 || a.after_level_db < -0.05 {
            let l = (a.after_level_db as f64 + pred.clamp(-12.0 * gamma, 12.0 * gamma)).clamp(-40.0, 0.0);
            b.after_level_db = l as f32;
            b.prompt_db_per_s = if l < 0.0 { (30.0 - l) as f32 } else { 0.0 };
        }
    }
    (b, STEP_T60_L)
}

/// One damper step by the release error: the damper moves by 2^-rel.
pub fn damper_step(a: &NoteAnchor, rel: f64, gamma: f64) -> NoteAnchor {
    let mut b = *a;
    b.damper = (a.damper as f64 * (-rel).clamp(-gamma, gamma).exp2()).clamp(0.2, 30.0) as f32;
    b
}

#[derive(Debug, Clone, PartialEq)]
pub struct FitOptions {
    pub folder: PathBuf,
    pub notes: Vec<u8>,
    pub passes: usize,
    pub threads: usize,
}

#[derive(Debug, Clone)]
pub struct FitOutcome {
    pub profile: ModalProfile,
    pub physical_ron: String,
    pub sl990_ron: String,
    pub before: Evaluation,
    pub after: Evaluation,
    pub report: String,
}

/// Renders the jobs for every profile; a profile whose renders are not all finite gets None.
fn features_checked(profiles: &[ModalProfile], jobs: &[Job], threads: usize) -> Vec<Option<Vec<NoteFeatures>>> {
    let n = jobs.len();
    let all = parallel_map(profiles.len() * n, threads, |i| {
        let (p, j) = (&profiles[i / n], jobs[i % n]);
        let (hold, tail) = if j.full { (j.hold_s, AFTER_KEY_UP_S) } else { (0.5, 0.0) };
        let x = render_note(p, j.note, j.velocity, hold, tail);
        x.iter().all(|v| v.is_finite()).then(|| analyze_note(&x, RATE, j.note, hold))
    });
    all.chunks(n.max(1)).take(profiles.len()).map(|c| c.iter().copied().collect()).collect()
}

/// Velocity-response objective: mean over notes of the variance of the level and centroid errors across velocities,
/// and each note's level variance alone (NaN where a note has fewer than 3 velocities).
fn velocity_objective(refs: &RefSet, jobs: &[Job], feats: Option<&Vec<NoteFeatures>>, notes: &[u8]) -> (f64, Vec<f64>) {
    let Some(feats) = feats else { return (f64::INFINITY, vec![f64::INFINITY; notes.len()]) };
    let var = |v: &[f64]| {
        let m = v.iter().sum::<f64>() / v.len() as f64;
        v.iter().map(|x| (x - m) * (x - m)).sum::<f64>() / v.len() as f64
    };
    let mut terms = Vec::new();
    let mut level_terms = Vec::new();
    for &n in notes {
        let (mut l, mut c) = (Vec::new(), Vec::new());
        for (j, f) in jobs.iter().zip(feats) {
            if j.note != n {
                continue;
            }
            let Some((_, r)) = refs.get(n, j.velocity) else { continue };
            if let (Some(oc), Some(rc)) = (f.centroid_hz, r.centroid_hz) {
                if oc > 0.0 && rc > 0.0 {
                    l.push(f.peak_db - r.peak_db);
                    c.push(12.0 * (oc / rc).log2());
                }
            }
        }
        if l.len() >= 3 {
            terms.push(var(&l) + var(&c));
            level_terms.push(var(&l));
        } else {
            level_terms.push(f64::NAN);
        }
    }
    if terms.is_empty() {
        return (f64::NAN, level_terms);
    }
    let j = terms.iter().sum::<f64>() / terms.len() as f64;
    if j.is_finite() {
        (j, level_terms)
    } else {
        (f64::INFINITY, vec![f64::INFINITY; notes.len()])
    }
}

fn mean_finite(v: &[f64]) -> f64 {
    let f: Vec<f64> = v.iter().copied().filter(|x| x.is_finite()).collect();
    f.iter().sum::<f64>() / f.len().max(1) as f64
}

const CHORD: [u8; 10] = [36, 43, 48, 52, 55, 60, 64, 67, 72, 76];

fn chord_events() -> Vec<(u64, MidiEvent)> {
    let mut v = vec![(0u64, MidiEvent::Sustain { on: true })];
    for note in CHORD {
        v.push((0, MidiEvent::NoteOn { note, velocity: 127 }));
    }
    v
}

/// Pre-limiter peak (linear x20) at the real master volume: rendered at 0.05 so the limiter never acts.
fn pre_limiter_peak(p: &ModalProfile, events: &[(u64, MidiEvent)], tail_s: f64) -> f64 {
    let mut q = *p;
    q.output.master_volume *= 0.05;
    let mut e = ModalPiano::with_profile(RATE, &q);
    let buf = render_events_stereo(&mut e, events, RATE, tail_s);
    20.0 * buf.left.iter().chain(buf.right.iter()).fold(0.0f32, |m, x| m.max(x.abs())) as f64
}

fn median(mut v: Vec<f64>) -> f64 {
    v.sort_by(|a, b| a.total_cmp(b));
    let n = v.len();
    if n == 0 {
        1.0
    } else if n % 2 == 1 {
        v[n / 2]
    } else {
        0.5 * (v[n / 2 - 1] + v[n / 2])
    }
}

fn table_of(states: &[NoteState]) -> NoteTable {
    let anchors: Vec<NoteAnchor> = states.iter().map(|s| s.anchor).collect();
    NoteTable::from_anchors(&anchors).expect("at most 88 fitted notes")
}

fn evaluate_table(p: &ModalProfile, refs: &RefSet, notes: &[u8], jobs: &[Job], threads: usize) -> Evaluation {
    let feats = our_features(p, jobs, threads);
    finish(build_errors(refs, jobs, &feats, notes, p))
}

fn gap_fill(states: &mut [NoteState]) {
    for k in 0..6 {
        let v: Vec<Option<f64>> = states.iter().map(|s| s.measured[k].then_some(s.params[k].x)).collect();
        let filled = fill_gaps(&v);
        for (s, x) in states.iter_mut().zip(filled) {
            if !s.measured[k] {
                s.params[k].x = x;
            }
        }
    }
    for s in states.iter_mut() {
        s.sync();
    }
}

/// Per-note passes with keep-best (passes + 1 evaluations), then the better of the per-note best mix and the best whole table goes into p.notes.
/// Each note's level shape is bounded by max(its pass-0 shape, shape_ref + SHAPE_TOLERANCE_DB) (shape_ref empty = the pass-0 shapes);
/// returns the report note and the pass-0 shapes.
#[allow(clippy::too_many_arguments)] // the pass needs the profile, states, refs, notes, jobs, threads, pass count and shape bounds; a struct would only wrap them
fn note_passes(
    p: &mut ModalProfile,
    states: &mut [NoteState],
    refs: &RefSet,
    notes: &[u8],
    jobs: &[Job],
    threads: usize,
    passes: usize,
    shape_ref: &[Option<f64>],
) -> (String, Vec<Option<f64>>) {
    let mut table_best: Option<(NoteTable, f64)> = None;
    let mut entry: Vec<Option<f64>> = Vec::new();
    let mut bounds: Vec<Option<f64>> = Vec::new();
    for pass in 0..=passes {
        let table = table_of(states);
        p.notes = table;
        let eval = evaluate_table(p, refs, notes, jobs, threads);
        if pass == 0 {
            entry = eval.notes.iter().map(|e| e.level_shape_db).collect();
            bounds = entry
                .iter()
                .enumerate()
                .map(|(i, &s)| {
                    let s = s?;
                    let r = if shape_ref.is_empty() { Some(s) } else { shape_ref.get(i).copied().flatten() };
                    Some(r.map_or(s, |r| s.max(r + SHAPE_TOLERANCE_DB)))
                })
                .collect();
        }
        let eligible = pass == 0
            || eval.notes.iter().zip(&bounds).all(|(e, b)| match (e.level_shape_db, b) {
                (Some(s), Some(b)) => s <= b + 1e-9,
                _ => true,
            });
        let cost = table_cost(&eval);
        if eligible && table_best.as_ref().is_none_or(|b| cost < b.1) {
            table_best = Some((table, cost));
        }
        let offset = eval.level_offset_db;
        for ((s, err), b) in states.iter_mut().zip(&eval.notes).zip(&bounds) {
            let (cents, level, e) = note_inputs(err, offset);
            for (m, ek) in s.measured.iter_mut().zip(&e) {
                *m |= ek.is_some();
            }
            if s.observe(fit_cost(err, offset), err.level_shape_db, *b) && pass < passes {
                s.apply(cents, level, e);
            }
        }
        if pass < passes {
            gap_fill(states);
        }
    }
    for s in states.iter_mut() {
        s.restore_best();
    }
    gap_fill(states);
    let mix = table_of(states);
    p.notes = mix;
    let mix_cost = table_cost(&evaluate_table(p, refs, notes, jobs, threads));
    let mut table_note = format!("per-note best mix cost {mix_cost:.3}");
    if let Some((t, s)) = table_best {
        table_note += &format!(", best whole table cost {s:.3}");
        if s < mix_cost {
            p.notes = t;
            table_note += " (whole table kept)";
        } else {
            table_note += " (per-note mix kept)";
        }
    }
    (table_note, entry)
}

/// Level-shape worsening (dB) allowed over the reference shape of the first per-note passes.
const SHAPE_TOLERANCE_DB: f64 = 0.1;

/// Level and cents only, from short renders at all five velocities; returns the level offset.
fn level_pass(p: &mut ModalProfile, refs: &RefSet, notes: &[u8], threads: usize) -> f64 {
    let sl_jobs: Vec<Job> = notes
        .iter()
        .flat_map(|&note| VELOCITIES.iter().map(move |&velocity| Job { note, velocity, hold_s: 0.5, full: false }))
        .collect();
    let sl_feats = our_features(p, &sl_jobs, threads);
    let sl_eval = finish(build_errors(refs, &sl_jobs, &sl_feats, notes, p));
    let sl_offset = sl_eval.level_offset_db;
    let mut anchors: Vec<NoteAnchor> = p.notes.anchors().to_vec();
    for x in anchors.iter_mut() {
        if let Some(err) = sl_eval.notes.iter().find(|e| e.note == x.note) {
            if let Some(l) = err.level_db.filter(|l| l.is_finite()) {
                x.level_db = (x.level_db as f64 - (l - sl_offset)).clamp(-24.0, 24.0) as f32;
            }
            if let Some(c) = err.cents.filter(|c| c.is_finite()) {
                x.cents = (x.cents as f64 - c).clamp(-100.0, 100.0) as f32;
            }
        }
    }
    p.notes = NoteTable::from_anchors(&anchors).expect("at most 88 fitted notes");
    sl_offset
}

type DropErrs = [Option<f64>; 4];

/// Drop and release polish. Phase A moves t60, the early excess (after_level_db) and the aftersound multiplier on d1/d2; phase B moves only the damper on the release.
fn drop_polish(p: &mut ModalProfile, refs: &RefSet, notes: &[u8], threads: usize) -> (Vec<String>, usize) {
    let start: Vec<NoteAnchor> = p.notes.anchors().to_vec();
    let k = start.len();
    let mut cur = start.clone();
    let mut best: Vec<Option<(NoteAnchor, DropErrs, f64)>> = vec![None; k];
    let mut last_kind = vec![STEP_T60_L; k];
    let mut aft_dead = vec![false; k];
    let trace = std::env::var("RP_FIT_TRACE").is_ok();
    let mut gamma = vec![1.0f64; k];
    let mut done = vec![false; k];
    let inside_a = |e: &DropErrs| e[0].is_none_or(|x| x.abs() <= 2.0) && e[1].is_none_or(|x| x.abs() <= 4.0);
    let sub = |a: Option<f64>, b: Option<f64>| Some(a? - b?);
    let mut ra = 0;
    for round in 0..=13 {
        let todo: Vec<usize> = (0..k).filter(|&i| !done[i] && notes.contains(&cur[i].note)).collect();
        if todo.is_empty() {
            break;
        }
        ra = round + 1;
        p.notes = NoteTable::from_anchors(&cur).expect("at most 88 fitted notes");
        let jobs: Vec<Job> = todo
            .iter()
            .map(|&i| {
                let note = cur[i].note;
                let hold_s = refs.get(note, 64).map_or(3.0, |(r, _)| r.hold_s());
                Job { note, velocity: 64, hold_s, full: true }
            })
            .collect();
        let feats = our_features(p, &jobs, threads);
        for (&i, ours) in todo.iter().zip(&feats) {
            let n = cur[i].note;
            let r = refs.get(n, 64).map(|(_, f)| *f).unwrap_or_default();
            let d1e = sub(ours.d1_db, r.d1_db);
            let d2e = sub(ours.d2_db, r.d2_db);
            let our_slope = match (ours.d1_db, ours.d2_db) {
                (Some(o1), Some(o2)) => Some(o2 - o1),
                _ => None,
            };
            let slope_err = match (our_slope, r.d1_db, r.d2_db) {
                (Some(s), Some(r1), Some(r2)) => Some((s.max(1.0) / (r2 - r1).max(1.0)).log2()),
                _ => None,
            };
            let errs = [d1e, d2e, slope_err, our_slope].map(|x| x.filter(|v| v.is_finite()));
            let t = |x: Option<f64>, scale: f64| x.map_or(0.0, |v| ((v / scale) * (v / scale)).min(400.0));
            let cost = t(errs[0], 2.0) + t(errs[1], 3.0);
            let accepted = round == 0 || best[i].is_none_or(|b| cost < b.2 - 1e-9);
            let evaluated = cur[i];
            if accepted {
                best[i] = Some((cur[i], errs, cost));
            } else if let Some(b) = best[i] {
                cur[i] = b.0;
                gamma[i] *= 0.5;
            }
            if trace {
                let c = evaluated;
                eprintln!(
                    "trace A r{round} n{n} t60 {:.3} aft {:.3} L {:.2} | d1e {:?} d2e {:?} cost {cost:.3} {}",
                    c.t60, c.aftersound, c.after_level_db, d1e, d2e, if accepted { "accepted" } else { "reverted" }
                );
            }
            if gamma[i] < 0.1 && last_kind[i] != STEP_T60_L && !aft_dead[i] {
                aft_dead[i] = true;
                gamma[i] = 1.0;
            }
            let Some((ba, be, _)) = best[i] else { continue };
            let none = be[0].is_none() && be[1].is_none();
            if inside_a(&be) || none || gamma[i] < 0.1 || round == 13 {
                done[i] = true;
            } else {
                let (mut nb, mut kind) = drop_step(&ba, be[0], be[2], be[3], gamma[i], !aft_dead[i]);
                if kind != last_kind[i] && gamma[i] != 1.0 {
                    gamma[i] = 1.0;
                    (nb, kind) = drop_step(&ba, be[0], be[2], be[3], 1.0, !aft_dead[i]);
                }
                cur[i] = nb;
                last_kind[i] = kind;
            }
        }
    }
    let mut fin: Vec<NoteAnchor> = (0..k).map(|i| best[i].map_or(start[i], |b| b.0)).collect();

    let undamped = p.decay.undamped_from_note;
    let ref_rel = |n: u8| refs.get(n, 64).and_then(|(_, f)| f.release_ms).filter(|x| *x > 0.0);
    let mut curb = fin.clone();
    let mut bestb: Vec<Option<(NoteAnchor, f64, bool, f64)>> = vec![None; k];
    let mut gamma_b = vec![2.0f64; k];
    let mut done_b = vec![false; k];
    let mut rb = 0;
    for round in 0..=7 {
        let todo: Vec<usize> = (0..k)
            .filter(|&i| !done_b[i] && notes.contains(&curb[i].note) && curb[i].note < undamped && ref_rel(curb[i].note).is_some())
            .collect();
        if todo.is_empty() {
            break;
        }
        rb = round + 1;
        p.notes = NoteTable::from_anchors(&curb).expect("at most 88 fitted notes");
        let jobs: Vec<Job> = todo
            .iter()
            .map(|&i| {
                let note = curb[i].note;
                let hold_s = refs.get(note, 64).map_or(3.0, |(r, _)| r.hold_s());
                Job { note, velocity: 64, hold_s, full: true }
            })
            .collect();
        let feats = our_features(p, &jobs, threads);
        for (&i, ours) in todo.iter().zip(&feats) {
            let rf = ref_rel(curb[i].note).unwrap_or(1.0);
            let o = ours.release_ms.filter(|v| v.is_finite() && *v > 0.0);
            let pseudo = o.is_none();
            let rel = o.map_or(3.0, |o| (o / rf).log2());
            let cost = ((rel / 0.25) * (rel / 0.25)).min(400.0);
            let accept = round == 0 || bestb[i].is_none_or(|b| cost < b.3 - 1e-9 || (pseudo && b.2));
            if accept {
                bestb[i] = Some((curb[i], rel, pseudo, cost));
            } else if let Some(b) = bestb[i] {
                curb[i] = b.0;
                gamma_b[i] *= 0.5;
            }
            let Some((ba, brel, bpseudo, _)) = bestb[i] else { continue };
            if (brel.abs() <= 0.3 && !bpseudo) || gamma_b[i] < 0.1 || round == 7 {
                done_b[i] = true;
            } else {
                curb[i] = damper_step(&ba, brel, gamma_b[i]);
            }
        }
    }
    for i in 0..k {
        if let Some(b) = bestb[i] {
            fin[i] = b.0;
        }
    }
    p.notes = NoteTable::from_anchors(&fin).expect("at most 88 fitted notes");
    let adjusted = fin.iter().zip(&start).filter(|(a, b)| a != b).count();
    let outside: Vec<u8> = (0..k)
        .filter(|&i| best[i].is_some_and(|b| !inside_a(&b.1)) || bestb[i].is_some_and(|b| b.2 || b.1.abs() > 0.35))
        .map(|i| fin[i].note)
        .collect();
    let mut lines = vec![format!(
        "drop polish: {ra}+{rb} rounds, {adjusted} notes adjusted, still outside (|d1|<=2,|d2|<=4,|rel|<=0.35): {outside:?}"
    )];
    for i in 0..k {
        let Some(b) = best[i] else { continue };
        let a = fin[i];
        let x = |v: Option<f64>| v.map_or("-".to_string(), |v| format!("{v:.1}"));
        let rel = bestb[i].filter(|b| !b.2).map_or("-".to_string(), |b| format!("{:.2}", b.1));
        lines.push(format!(
            "drop note {}: t60 {:.2} aftersound {:.2} after_level_db {:.1} damper {:.2} | d1e {} d2e {} rel {rel}",
            a.note, a.t60, a.aftersound, a.after_level_db, a.damper, x(b.1[0]), x(b.1[1])
        ));
    }
    (lines, adjusted)
}

const TAIL_DB: [f64; 8] = [0.0, 20.0, 25.0, 30.0, 35.0, 40.0, 45.0, 50.0];
const TAIL_BASS_S: [f64; 5] = [1.0, 2.0, 3.0, 5.0, 8.0];
const TAIL_TREBLE_S: [f64; 4] = [0.3, 0.6, 1.0, 2.0];

/// Damper tail fit: damper_tail_db, damper_tail_t60_bass_s and damper_tail_t60_treble_s against late_release_db
/// (the level 1.0 to 1.5 s after key-up). It uses a coordinate-wise search instead of the full 8 x 5 x 4 grid:
/// two sweeps over db, bass T60, treble T60 (one parameter at a time, the others held), starting from 30 dB / 3 s / 0.6 s.
/// The search runs on every 3rd damped note, scored by the mean absolute late_release_db error; the winner and "off" are then
/// compared on all damped fitted notes. The tail stays off (0.0) unless it beats off by at least 1 dB of mean error, and a
/// candidate is rejected when the median |release_log2| of the same notes grows by more than 0.05.
/// Returns the report line.
type TailCache = Vec<((u64, u64, u64), (f64, f64))>;

fn damper_tail_pass(p: &mut ModalProfile, refs: &RefSet, notes: &[u8], threads: usize) -> String {
    let undamped = p.decay.undamped_from_note;
    let damped: Vec<u8> = notes
        .iter()
        .copied()
        .filter(|&n| n < undamped && refs.get(n, 64).is_some_and(|(_, f)| f.late_release_db.is_some()))
        .collect();
    if damped.is_empty() {
        p.decay.damper_tail_db = 0.0;
        return "damper tail: off (no damped notes with a late-release reference)".to_string();
    }
    let sub: Vec<u8> = damped.iter().copied().step_by(3).collect();
    let base = *p;
    let measure = |set: &[u8], t: (f64, f64, f64)| -> (f64, f64) {
        let mut q = base;
        q.decay.damper_tail_db = t.0 as f32;
        q.decay.damper_tail_t60_bass_s = t.1 as f32;
        q.decay.damper_tail_t60_treble_s = t.2 as f32;
        let jobs: Vec<Job> = set
            .iter()
            .map(|&note| Job { note, velocity: 64, hold_s: refs.get(note, 64).map_or(3.0, |(r, _)| r.hold_s()), full: true })
            .collect();
        let feats = our_features(&q, &jobs, threads);
        let mut late = Vec::new();
        let mut rel = Vec::new();
        for (&n, o) in set.iter().zip(&feats) {
            let r = refs.get(n, 64).map(|(_, f)| *f).unwrap_or_default();
            if let Some(b) = r.late_release_db {
                late.push((o.late_release_db.unwrap_or(-100.0) - b).abs());
            }
            if let (Some(a), Some(b)) = (o.release_ms, r.release_ms) {
                if a > 0.0 && b > 0.0 {
                    rel.push((a / b).log2().abs());
                }
            }
        }
        (if late.is_empty() { f64::INFINITY } else { late.iter().sum::<f64>() / late.len() as f64 }, median(rel))
    };
    let off_t = (0.0, base.decay.damper_tail_t60_bass_s as f64, base.decay.damper_tail_t60_treble_s as f64);
    let off = measure(&sub, off_t);
    let mut cache: TailCache = Vec::new();
    let mut eval = |t: (f64, f64, f64)| -> (f64, f64) {
        if t.0 == 0.0 {
            return off;
        }
        let key = (t.0.to_bits(), t.1.to_bits(), t.2.to_bits());
        if let Some(c) = cache.iter().find(|c| c.0 == key) {
            return c.1;
        }
        let r = measure(&sub, t);
        cache.push((key, r));
        r
    };
    let valid = |r: (f64, f64)| r.0.is_finite() && r.1 <= off.1 + 0.05;
    let mut cur = (30.0, 3.0, 0.6);
    for _ in 0..2 {
        for which in 0..3 {
            let grid: &[f64] = [&TAIL_DB[..], &TAIL_BASS_S[..], &TAIL_TREBLE_S[..]][which];
            let mut best: Option<(f64, f64)> = None;
            for &v in grid {
                let mut t = cur;
                match which {
                    0 => t.0 = v,
                    1 => t.1 = v,
                    _ => t.2 = v,
                }
                if which > 0 && t.0 == 0.0 {
                    continue;
                }
                let r = eval(t);
                if valid(r) && best.is_none_or(|b| r.0 < b.1) {
                    best = Some((v, r.0));
                }
            }
            if let Some((v, _)) = best {
                match which {
                    0 => cur.0 = v,
                    1 => cur.1 = v,
                    _ => cur.2 = v,
                }
            }
        }
    }
    let before = measure(&damped, off_t);
    let after = if cur.0 > 0.0 { measure(&damped, cur) } else { before };
    let on = cur.0 > 0.0 && valid(eval(cur)) && eval(cur).0 <= off.0 - 1.0 && after.0.is_finite() && after.0 <= before.0 - 1.0 && after.1 <= before.1 + 0.05;
    if on {
        p.decay.damper_tail_db = cur.0 as f32;
        p.decay.damper_tail_t60_bass_s = cur.1 as f32;
        p.decay.damper_tail_t60_treble_s = cur.2 as f32;
        format!(
            "damper tail: db {}, t60 bass {} s, treble {} s, late mean error before {:.2} after {:.2} dB, median release before {:.2} after {:.2}",
            fmt_dec(cur.0, 1),
            fmt_dec(cur.1, 1),
            fmt_dec(cur.2, 1),
            before.0,
            after.0,
            before.1,
            after.1
        )
    } else {
        p.decay.damper_tail_db = 0.0;
        format!(
            "damper tail: db 0.0 (off; best candidate db {}, t60 bass {} s, treble {} s did not beat off by 1 dB), late mean error before {:.2} after {:.2} dB, median release before {:.2} after {:.2}",
            fmt_dec(cur.0, 1),
            fmt_dec(cur.1, 1),
            fmt_dec(cur.2, 1),
            before.0,
            before.0,
            before.1,
            before.1
        )
    }
}

/// Takes each note's anchor from the table, sets the parameter values from it and clears the keep-best.
fn reset_states(states: &mut [NoteState], table: &NoteTable) {
    for s in states.iter_mut() {
        if let Some(a) = table.anchors().iter().find(|a| a.note == s.anchor.note) {
            s.anchor = *a;
        }
        let a = s.anchor;
        for (p, x) in s.params.iter_mut().zip([a.inharmonicity, a.t60, a.aftersound, a.damping, a.hardness, a.damper]) {
            p.x = x as f64;
        }
        s.best = None;
        s.restored = false;
    }
}

/// Octave bands of the built-in test piece rendered with the profile (master volume 0.05, x20, mono, 2 s tail).
fn test_piece_bands(p: &ModalProfile) -> [Option<f64>; 10] {
    let mut q = *p;
    q.output.master_volume = 0.05;
    let mut e = ModalPiano::with_profile(RATE, &q);
    let buf = render_events_stereo(&mut e, &test_piece().events, RATE, 2.0);
    let mono: Vec<f32> = buf.mono().iter().map(|x| x * 20.0).collect();
    analyze(&mono, RATE, &[], 0.0).whole.octave_bands_db
}

pub fn fit(opts: &FitOptions, refs: &RefSet, physical_template: &str, sl990_template: &str) -> Result<FitOutcome, String> {
    let start = Instant::now();
    let prior = ModalProfile::default();
    let t = parse_modal_profile(physical_template).map_err(|e| format!("physical template: {e}"))?;
    if unfitted(&t) != prior {
        return Err("template differs from the prior outside the fitted fields".to_string());
    }
    let mut notes = opts.notes.clone();
    notes.sort_unstable();
    notes.dedup();
    if notes.is_empty() || notes.len() > MAX_NOTE_ANCHORS {
        return Err(format!("fit needs 1 to {MAX_NOTE_ANCHORS} notes, got {}", notes.len()));
    }
    let threads = opts.threads.max(1);

    // S0: prior and level match.
    let before = evaluate(&prior, refs, &notes, threads);
    let mut p = prior;
    let (uf, damper_rows) = measured_undamped_from(refs, &notes, prior.decay.undamped_from_note);
    p.decay.undamped_from_note = uf;
    p.output.output_gain = (prior.output.output_gain as f64 * 10f64.powf(-before.level_offset_db / 20.0)) as f32;

    // SV: velocity response.
    let n = notes.len();
    let sv_notes: Vec<u8> = if n <= 15 {
        notes.clone()
    } else {
        (0..15).map(|i| notes[((i * (n - 1)) as f64 / 14.0).round() as usize]).collect()
    };
    let sv_jobs: Vec<Job> = sv_notes
        .iter()
        .flat_map(|&note| VELOCITIES.iter().map(move |&velocity| Job { note, velocity, hold_s: 0.5, full: false }))
        .collect();
    let first = features_checked(&[p], &sv_jobs, threads);
    let (mut j_cur, lv_start) = velocity_objective(refs, &sv_jobs, first[0].as_ref(), &sv_notes);
    let j_before = j_cur;
    let mut lv_cur = lv_start.clone();
    let mut sv_log: Vec<String> = Vec::new();
    type Cands = (&'static str, &'static str, [f64; 4], bool, f64, f64);
    let params: [Cands; 5] = [
        ("velocity", "speed_curve", [0.7, 0.85, 1.15, 1.3], true, 0.3, 4.0),
        ("velocity", "hammer_speed_min_mps", [0.6, 0.8, 1.25, 1.6], true, 0.05, 1.5),
        ("velocity", "hammer_speed_max_mps", [0.8, 0.9, 1.1, 1.25], true, 1.0, 9.0),
        ("hammer", "exponent_bass", [-0.3, -0.15, 0.15, 0.3], false, 1.6, 3.8),
        ("hammer", "exponent_treble", [-0.3, -0.15, 0.15, 0.3], false, 1.6, 3.8),
    ];
    for round in 1..=2 {
        for &(s, f, steps, mul, lo, hi) in &params {
            let cur = field_value(&p, s, f).unwrap_or(0.0);
            let mut cands: Vec<(f64, ModalProfile)> = Vec::new();
            for d in steps {
                let v = if mul { cur * d } else { cur + d }.clamp(lo, hi);
                let mut q = p;
                set_value(&mut q, s, f, v);
                if q == p || q.velocity.hammer_speed_min_mps >= 0.5 * q.velocity.hammer_speed_max_mps {
                    continue;
                }
                cands.push((v, q));
            }
            let profiles: Vec<ModalProfile> = cands.iter().map(|c| c.1).collect();
            let feats = features_checked(&profiles, &sv_jobs, threads);
            let mut best: Option<(usize, f64, Vec<f64>)> = None;
            let mut rejected: Option<(f64, f64, String)> = None;
            for (i, fe) in feats.iter().enumerate() {
                let (j, lv) = velocity_objective(refs, &sv_jobs, fe.as_ref(), &sv_notes);
                if j.is_finite() && shape_ok(&lv_start, &lv) && best.as_ref().is_none_or(|b| j < b.1) {
                    best = Some((i, j, lv.clone()));
                }
                if j.is_finite() && rejected.as_ref().is_none_or(|r| j < r.1) {
                    let reason = match lv_start.iter().zip(&lv).position(|(s, x)| s.is_finite() && !(x.is_finite() && *x <= s + (0.1f64).max(0.1 * s))) {
                        Some(k) => format!("level variance of note {} rose {:.3} -> {:.3}", sv_notes[k], lv_start[k], lv[k]),
                        None => "J not 0.01 below".to_string(),
                    };
                    rejected = Some((cands[i].0, j, reason));
                }
            }
            match best {
                Some((i, j, lv)) if !j_cur.is_finite() || j < j_cur - 0.01 => {
                    sv_log.push(format!(
                        "round {round}: {s}.{f} {} -> {} (J {j_cur:.4} -> {j:.4}, mean level variance {:.4} -> {:.4})",
                        fmt_dec(cur, 3),
                        fmt_dec(cands[i].0, 3),
                        mean_finite(&lv_cur),
                        mean_finite(&lv)
                    ));
                    p = cands[i].1;
                    j_cur = j;
                    lv_cur = lv;
                }
                _ => {
                    let why = rejected.map_or(String::new(), |(v, j, reason)| format!("; best candidate {} J {j:.4} rejected: {reason}", fmt_dec(v, 3)));
                    sv_log.push(format!("round {round}: {s}.{f} kept {} (J {j_cur:.4}){why}", fmt_dec(cur, 3)));
                }
            }
        }
    }
    let j_after = j_cur;

    // SN: per-note passes, N + 1 evaluations.
    let jobs = eval_jobs(refs, &notes);
    let mut states: Vec<NoteState> = notes.iter().map(|&n| NoteState::new(n)).collect();
    let (table_note, shape_ref) = note_passes(&mut p, &mut states, refs, &notes, &jobs, threads, opts.passes, &[]);

    // SA: aftersound fold.
    let mut anchors: Vec<NoteAnchor> = p.notes.anchors().to_vec();
    let a = p.soundboard.coupling_loss_fraction as f64;
    let g = median(anchors.iter().map(|x| x.aftersound as f64).collect());
    let a_new = (1.0 - (1.0 - a) * g).clamp(0.0, 0.95);
    for x in anchors.iter_mut() {
        let a_eff = (1.0 - (1.0 - a) * x.aftersound as f64).clamp(0.0, 0.95);
        x.aftersound = ((1.0 - a_eff) / (1.0 - a_new)).clamp(0.2, 5.0) as f32;
    }
    p.soundboard.coupling_loss_fraction = a_new as f32;
    p.notes = NoteTable::from_anchors(&anchors)?;

    // SE: output EQ against the test-piece spectrum, guarded by the pre-SE snapshot.
    let snapshot = p;
    let snap_score = evaluate(&p, refs, &notes, threads).score;
    let ref_path = opts.folder.join("wav").join("test-piece.wav");
    let mut eq_lines: Vec<String> = Vec::new();
    let ref_read = if ref_path.exists() { Some(reference_test_piece_bands(&ref_path)?) } else { None };
    if let Some((None, rate)) = ref_read {
        eq_lines.push(format!("eq: skipped (test-piece.wav is {rate} Hz, the fit renders at 48000 Hz)"));
    } else if let Some((Some(reference), _)) = ref_read {
        let ours = test_piece_bands(&p);
        let e0 = band_error_db(&ours, &reference);
        let residual: [Option<f64>; 10] = std::array::from_fn(|b| match (ours[b], reference[b]) {
            (Some(o), Some(r)) if r >= -60.0 => Some(r - o),
            _ => None,
        });
        let mut q = p;
        q.eq = solve_gains(&residual, &BAND_WEIGHTS, &p.eq, RATE as f64);
        let e1 = band_error_db(&test_piece_bands(&q), &reference);
        let kept = matches!((e0, e1), (Some(a), Some(b)) if b <= a - 0.5);
        if kept {
            p = q;
        }
        let f = |x: Option<f64>| x.map_or("-".to_string(), |v| format!("{v:.2}"));
        eq_lines.push(format!(
            "eq: band error {} dB -> {} dB, {}, gains low {}, p1 {}, p2 {}, p3 {}, high {}",
            f(e0),
            f(e1),
            if kept { "kept" } else { "dropped" },
            fmt_dec(q.eq.low_shelf_db as f64, 1),
            fmt_dec(q.eq.peak1_db as f64, 1),
            fmt_dec(q.eq.peak2_db as f64, 1),
            fmt_dec(q.eq.peak3_db as f64, 1),
            fmt_dec(q.eq.high_shelf_db as f64, 1)
        ));
        if kept {
            reset_states(&mut states, &p.notes);
            let (more, _) = note_passes(&mut p, &mut states, refs, &notes, &jobs, threads, 2, &shape_ref);
            eq_lines.push(format!("eq: 2 more per-note passes, {more}"));
        }
    } else {
        eq_lines.push("eq: skipped (no test-piece.wav)".to_string());
    }

    // SL: level and cents only, from short renders at all five velocities.
    let sl_offset = level_pass(&mut p, refs, &notes, threads);
    eq_lines.push(format!("level pass: offset {sl_offset:.2} dB"));
    let final_score = evaluate(&p, refs, &notes, threads).score;
    if final_score > 1.05 * snap_score {
        p = snapshot;
    }
    eq_lines.push(format!(
        "eq: {} (score {snap_score:.3} -> {final_score:.3})",
        if p.eq.is_flat() { "dropped" } else { "kept" }
    ));

    // SD: drop and release polish, then the level pass again.
    let (drop_lines, _) = drop_polish(&mut p, refs, &notes, threads);
    eq_lines.extend(drop_lines);
    eq_lines.push(damper_tail_pass(&mut p, refs, &notes, threads));
    let stepped: Vec<u8> = p.notes.anchors().iter().filter(|a| a.after_level_db < 0.0).map(|a| a.note).collect();
    eq_lines.push(format!("two-stage: notes with an aftersound step (after_level_db < 0): {stepped:?}"));
    let sl_offset2 = level_pass(&mut p, refs, &notes, threads);
    eq_lines.push(format!("level pass: offset {sl_offset2:.2} dB"));
    let eval_g = evaluate(&p, refs, &notes, threads);
    // SG: gain and headroom.
    let gain = p.output.output_gain as f64;
    let g_match = gain * 10f64.powf(-eval_g.level_offset_db / 20.0);
    let mut q = p;
    q.output.output_gain = g_match as f32;
    let sl_q = parse_modal_profile(&write_fitted(sl990_template, &q)?).map_err(|e| format!("fitted physical_sl990.ron: {e}"))?;
    let piece = test_piece();
    let peaks = parallel_map(2, threads, |i| pre_limiter_peak(if i == 0 { &q } else { &sl_q }, &piece.events, 2.0));
    let cap_phys = g_match * q.output.limiter_ceiling as f64 * 0.99 / peaks[0];
    let cap_sl = g_match * sl_q.output.limiter_ceiling as f64 * 0.99 / peaks[1];
    let gain_phys = g_match.min(cap_phys);
    let template_sl_gain = parse_modal_profile(sl990_template).map_err(|e| format!("physical_sl990.ron template: {e}"))?.output.output_gain as f64;
    let gain_sl = g_match.min(cap_sl).max(template_sl_gain);
    let floor_used = gain_sl > g_match.min(cap_sl);
    p.output.output_gain = gain_phys as f32;
    let mut p_sl = p;
    p_sl.output.output_gain = gain_sl as f32;
    let mut sl_chord = sl_q;
    sl_chord.output.output_gain = gain_sl as f32;
    let chord = chord_events();
    let chord_peaks = parallel_map(2, threads, |i| pre_limiter_peak(if i == 0 { &p } else { &sl_chord }, &chord, 1.0));

    // SW: write and parse.
    let physical_ron = write_fitted(physical_template, &p)?;
    let sl990_ron = write_fitted(sl990_template, &p_sl)?;
    let profile = parse_modal_profile(&physical_ron).map_err(|e| format!("fitted physical.ron: {e}"))?;
    parse_modal_profile(&sl990_ron).map_err(|e| format!("fitted physical_sl990.ron: {e}"))?;
    let after = evaluate(&profile, refs, &notes, threads);

    let mut report = String::new();
    report.push_str(&format!("Folder: {}\n", opts.folder.display()));
    report.push_str(&format!("Notes ({}): {:?}\n", notes.len(), notes));
    report.push_str(&format!("Passes: {}, threads: {threads}\n", opts.passes));
    report.push_str(&format!("Elapsed: {:.1} s\n", start.elapsed().as_secs_f64()));
    for &(s, f) in FITTED_FIELDS {
        let b = field_value(&prior, s, f).unwrap_or(0.0);
        let a = field_value(&profile, s, f).unwrap_or(0.0);
        report.push_str(&format!("{s}.{f}: {} -> {}\n", fmt_sig(b, 4), fmt_sig(a, 4)));
    }
    report.push_str(&format!(
        "output_gain: level match {}, test-piece cap physical {} (peak {:.3} at the match), sl990 {} (peak {:.3}), chosen physical {}, sl990 {} (sl990 floor {}, floor {}); level offset vs reference physical {:.2} dB, sl990 gain {:.2} dB vs match; loud chord pre-limiter peak physical {:.3}, sl990 {:.3} (limiter ceiling {}, the limiter catches it)\n",
        fmt_sig(g_match, 4),
        fmt_sig(cap_phys, 4),
        peaks[0],
        fmt_sig(cap_sl, 4),
        peaks[1],
        fmt_sig(gain_phys, 4),
        fmt_sig(gain_sl, 4),
        fmt_sig(template_sl_gain, 4),
        if floor_used { "used" } else { "not used" },
        20.0 * (gain_phys / g_match).log10(),
        20.0 * (gain_sl / g_match).log10(),
        chord_peaks[0],
        chord_peaks[1],
        p.output.limiter_ceiling
    ));
    report.push_str(&format!(
        "Stage V: J before {j_before:.4}, after {j_after:.4}, mean level variance {:.4} -> {:.4} on notes {sv_notes:?}\n",
        mean_finite(&lv_start),
        mean_finite(&lv_cur)
    ));
    for l in &sv_log {
        report.push_str(&format!("  {l}\n"));
    }
    let damped_list: Vec<u8> = damper_rows.iter().filter(|r| r.damped).map(|r| r.note).collect();
    let undamped_list: Vec<u8> = damper_rows.iter().filter(|r| !r.damped).map(|r| r.note).collect();
    report.push_str(&format!(
        "dampers: undamped_from_note {} -> {uf}; damped {damped_list:?}; undamped {undamped_list:?}\n",
        prior.decay.undamped_from_note
    ));
    report.push_str(&format!("Per-note passes: {table_note}\n"));
    report.push_str(&format!("Aftersound fold: median multiplier {g:.3}, coupling_loss_fraction {a:.3} -> {a_new:.3}\n"));
    for l in &eq_lines {
        report.push_str(&format!("{l}\n"));
    }
    let out_drop: Vec<u8> = after
        .notes
        .iter()
        .filter(|e| e.d1_db.is_some_and(|x| x.abs() > 3.0) || e.d2_db.is_some_and(|x| x.abs() > 5.0))
        .map(|e| e.note)
        .collect();
    let out_rel: Vec<u8> = after.notes.iter().filter(|e| e.release_log2.is_some_and(|r| r.abs() > 0.68)).map(|e| e.note).collect();
    report.push_str(&format!("bounds: outside |d1|<=3 or |d2|<=5: {out_drop:?}; release outside factor 1.6: {out_rel:?}\n"));
    report.push_str(&report_table(&before, Some(&after)));
    Ok(FitOutcome { profile, physical_ron, sl990_ron, before, after, report })
}

type Bands = [Option<f64>; 10];

/// Octave bands of the reference test piece, or None (with the file's rate) when it is not at the fit's render rate.
fn reference_test_piece_bands(path: &Path) -> Result<(Option<Bands>, u32), String> {
    let (x, rate) = read_wav_mono(path)?;
    if rate != RATE {
        return Ok((None, rate));
    }
    Ok((Some(analyze(&x, RATE, &[], 0.0).whole.octave_bands_db), rate))
}

/// A candidate keeps the level shape when no note's value rises above its start value by more than max(0.1, 10 %).
fn shape_ok(start: &[f64], cand: &[f64]) -> bool {
    start.iter().zip(cand).all(|(s, x)| !s.is_finite() || (!x.is_nan() && *x <= s + (0.1f64).max(0.1 * s)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shape_ok_cases() {
        assert!(shape_ok(&[0.5], &[0.5]));
        assert!(shape_ok(&[0.2], &[0.25]));
        assert!(!shape_ok(&[1.0], &[1.5]));
        assert!(!shape_ok(&[0.5], &[f64::NAN]));
        assert!(shape_ok(&[f64::NAN, 0.5], &[9.0, 0.5]));
    }

    #[test]
    fn wrong_rate_reference_is_skipped() {
        let path = std::env::temp_dir().join("rusty_piano_fit_rate_test.wav");
        let spec = hound::WavSpec { channels: 1, sample_rate: 44100, bits_per_sample: 16, sample_format: hound::SampleFormat::Int };
        let mut w = hound::WavWriter::create(&path, spec).unwrap();
        for i in 0..22050 {
            w.write_sample((8000.0 * (i as f32 * 0.05).sin()) as i16).unwrap();
        }
        w.finalize().unwrap();
        let r = reference_test_piece_bands(&path).unwrap();
        std::fs::remove_file(&path).unwrap();
        assert_eq!(r, (None, 44100));
    }

    #[test]
    #[cfg_attr(debug_assertions, ignore = "needs release")]
    fn pre_limiter_peak_scales_with_gain() {
        let p = ModalProfile::default();
        let mut p2 = p;
        p2.output.output_gain *= 2.0;
        let ev = chord_events();
        let ratio = pre_limiter_peak(&p2, &ev, 0.3) / pre_limiter_peak(&p, &ev, 0.3);
        assert!((ratio - 2.0).abs() < 1e-3, "{ratio}");
    }

    #[test]
    fn log_secant_step_converges() {
        let mut p = LogParam::new(0.1, 10.0, 1.0);
        for _ in 0..3 {
            let e = (p.x / 3.0).log2();
            p.update(Some(e));
        }
        assert!((p.x / 3.0 - 1.0).abs() <= 0.01, "{p:?}");
        let mut p = LogParam::new(0.1, 10.0, 1.0);
        for _ in 0..5 {
            let e = 2.0 * (p.x / 3.0).log2();
            p.update(Some(e));
        }
        assert!((p.x / 3.0 - 1.0).abs() <= 0.01, "{p:?}");
    }

    #[test]
    fn log_secant_freezes_flat_parameter() {
        let mut p = LogParam::new(0.2, 5.0, 1.0);
        for _ in 0..3 {
            p.update(Some(0.7));
        }
        assert!(p.frozen, "{p:?}");
        assert!((p.lo..=p.hi).contains(&p.x), "{p:?}");
        let x = p.x;
        p.update(Some(3.0));
        assert_eq!(p.x, x);
        let mut q = LogParam::new(0.2, 5.0, 1.0);
        q.update(None);
        assert_eq!(q.x, 1.0);
    }

    #[test]
    fn fill_gaps_interpolates_in_log() {
        let v = fill_gaps(&[None, Some(1.0), None, Some(4.0), None]);
        let want = [1.0, 1.0, 2.0, 4.0, 4.0];
        for (a, b) in v.iter().zip(want) {
            assert!((a - b).abs() < 1e-12, "{v:?}");
        }
        assert_eq!(v.len(), 5);
        assert_eq!(fill_gaps(&[None, None, None]), vec![1.0, 1.0, 1.0]);
    }

    #[test]
    fn keep_best_restores_worse_note() {
        let mut s = NoteState::new(60);
        assert!(s.observe(1.0, None, None));
        let first = s.anchor;
        s.apply(Some(10.0), Some(2.0), [Some(1.0), Some(-1.0), Some(0.5), Some(0.5), Some(0.5), Some(0.5)]);
        assert_ne!(s.anchor, first);
        assert!(!s.observe(5.0, None, None));
        assert_eq!(s.anchor, first);
        for p in &s.params {
            assert_eq!(p.x, 1.0);
            assert_eq!(p.max_step, 0.5);
        }
        assert!(s.observe(5.0, None, None));
        assert_eq!(s.best.map(|b| b.2), Some(5.0));
    }

    #[test]
    fn keep_best_rejects_shape_regression() {
        let mut s = NoteState::new(60);
        assert!(s.observe(5.0, Some(1.0), Some(1.1)));
        let first = s.anchor;
        s.apply(Some(10.0), Some(2.0), [Some(1.0), Some(-1.0), Some(0.5), Some(0.5), Some(0.5), Some(0.5)]);
        assert_ne!(s.anchor, first);
        assert!(!s.observe(1.0, Some(2.0), Some(1.1)));
        assert_eq!(s.anchor, first);
        assert!(s.params[4].frozen);
        for p in &s.params {
            assert_eq!(p.max_step, 1.0);
        }
    }

    #[test]
    fn drop_step_signs_and_clamps() {
        let close = |a: f32, b: f64| (a as f64 - b).abs() < 1e-5;
        let a = NoteAnchor::neutral(60);
        let (b, k) = drop_step(&a, Some(-6.0), Some(0.5), Some(10.0), 1.0, true);
        let after = -6.0 + 10.0 * ((-0.5f64).exp2() - 1.0);
        assert!(close(b.t60, 0.5f64.exp2()), "{b:?}");
        assert!((b.after_level_db as f64 - after).abs() < 0.01 && (after + 8.929).abs() < 0.01, "{b:?}");
        assert!((b.prompt_db_per_s as f64 - (30.0 - after)).abs() < 0.01, "{b:?}");
        assert!(b.aftersound == 1.0 && b.damper == a.damper && k == STEP_T60_L, "{b:?}");
        let (g, _) = drop_step(&a, Some(-6.0), Some(0.5), Some(10.0), 0.25, true);
        let f = 0.25f64.exp2();
        assert!(close(g.t60, f) && close(g.after_level_db, -3.0) && close(g.prompt_db_per_s, 33.0), "{g:?}");
        let l3 = NoteAnchor { after_level_db: -3.0, prompt_db_per_s: 33.0, ..a };
        let (u, k) = drop_step(&l3, Some(5.0), None, None, 1.0, true);
        assert!(u.after_level_db == 0.0 && u.prompt_db_per_s == 0.0 && u.aftersound == a.aftersound && k == STEP_T60_L, "{u:?}");
        let (u, k) = drop_step(&a, Some(5.0), Some(1.0), None, 1.0, true);
        assert!(close(u.aftersound, (-0.5f64).exp2()) && u.t60 == a.t60 && u.after_level_db == 0.0 && k == STEP_AFT_LONGER, "{u:?}");
        let (u, k) = drop_step(&a, Some(5.0), None, None, 0.5, true);
        assert!(close(u.aftersound, (-0.25f64).exp2()) && k == STEP_AFT_LONGER, "{u:?}");
        let (u, k) = drop_step(&a, Some(5.0), None, None, 1.0, false);
        assert!(u == a && k == STEP_T60_L);
        let lo = NoteAnchor { aftersound: 0.25, ..a };
        assert!(close(drop_step(&lo, Some(5.0), None, None, 1.0, true).0.aftersound, 0.2));
        let (u, k) = drop_step(&a, Some(1.5), None, None, 1.0, true);
        assert!(u == a && k == STEP_T60_L);
        let am = NoteAnchor { aftersound: 0.2, ..a };
        let (u, _) = drop_step(&am, Some(5.0), None, None, 1.0, true);
        assert!(u == am);
        let a2 = NoteAnchor { aftersound: 0.5, ..a };
        let (u, k) = drop_step(&a2, Some(-5.0), None, None, 1.0, true);
        assert!(close(u.aftersound, 0.5 * 0.5f64.exp2()) && u.after_level_db == 0.0 && k == STEP_AFT_SHORTER, "{u:?}");
        let (u, _) = drop_step(&NoteAnchor { aftersound: 0.8, ..a }, Some(-5.0), None, None, 1.0, true);
        assert!(close(u.aftersound, 1.0), "{u:?}");
        let (u, k) = drop_step(&a, Some(-5.0), None, None, 1.0, true);
        assert!(u.aftersound == 1.0 && u.after_level_db < 0.0 && k == STEP_T60_L, "{u:?}");
        let hi = NoteAnchor { t60: 9.0, ..a };
        assert!(close(drop_step(&hi, None, Some(1.0), None, 1.0, true).0.t60, 10.0));
        let deep = NoteAnchor { after_level_db: -38.0, ..a };
        assert!(close(drop_step(&deep, Some(-10.0), None, None, 1.0, true).0.after_level_db, -40.0));
        assert_eq!(drop_step(&a, None, None, None, 1.0, true), (a, STEP_T60_L));
    }

    #[test]
    fn damper_step_signs_and_clamps() {
        let close = |a: f32, b: f64| (a as f64 - b).abs() < 1e-5;
        let a = NoteAnchor::neutral(60);
        assert!(close(damper_step(&NoteAnchor { damper: 29.0, ..a }, -1.0, 1.0).damper, 30.0));
        assert!(close(damper_step(&NoteAnchor { damper: 1.0, ..a }, 1.0, 2.0).damper, 0.5));
        assert!(close(damper_step(&NoteAnchor { damper: 1.0, ..a }, 3.0, 2.0).damper, 0.25));
    }
}
