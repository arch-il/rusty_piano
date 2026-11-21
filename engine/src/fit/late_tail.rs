//! Per-note damper_tail multiplier: picks the one that best matches the reference late release level.

use super::analysis::analyze_note;
use super::evaluate::render_note;
use super::reference::{parallel_map, RefSet, AFTER_KEY_UP_S};
use crate::sound::modal_piano::tables::{NoteAnchor, NoteTable};
use crate::sound::modal_piano::ModalProfile;

pub const TAIL_GRID: [f32; 7] = [0.25, 0.5, 0.71, 1.0, 1.41, 2.0, 4.0];
pub const MIN_GAIN_DB: f64 = 1.0;
pub const RELEASE_SLACK: f64 = 0.05;

pub fn late_errors(p: &ModalProfile, refs: &RefSet, note: u8, mult: f32) -> Option<(f64, Option<f64>)> {
    let mut q = *p;
    let mut anchors: Vec<NoteAnchor> = p.notes.anchors().to_vec();
    if let Some(a) = anchors.iter_mut().find(|a| a.note == note) {
        a.damper_tail = mult;
    } else {
        anchors = vec![NoteAnchor { damper_tail: mult, ..p.notes.at(note) }];
    }
    q.notes = NoteTable::from_anchors(&anchors).expect("anchor table");
    let (rn, r) = refs.get(note, 64)?;
    let hold = rn.hold_s();
    let x = render_note(&q, note, 64, hold, AFTER_KEY_UP_S);
    let o = analyze_note(&x, 48000, note, hold);
    let late = o.late_release_db.unwrap_or(-100.0) - r.late_release_db?;
    let release = match (o.release_ms, r.release_ms) {
        (Some(a), Some(b)) if a > 0.0 && b > 0.0 => Some((a / b).log2().abs()),
        _ => None,
    };
    Some((late, release))
}

pub fn best_tail(p: &ModalProfile, refs: &RefSet, note: u8, threads: usize) -> Option<(f32, f64)> {
    let cur = p.notes.at(note).damper_tail;
    let res = parallel_map(TAIL_GRID.len() + 1, threads, |i| {
        let m = if i < TAIL_GRID.len() { TAIL_GRID[i] } else { cur };
        late_errors(p, refs, note, m)
    });
    let base = res[TAIL_GRID.len()]?;
    let mut best: Option<(f32, f64)> = None;
    for (&m, r) in TAIL_GRID.iter().zip(&res) {
        let Some((e, rel)) = *r else { continue };
        let valid = match (rel, base.1) {
            (Some(a), Some(b)) => a <= b + RELEASE_SLACK,
            _ => true,
        };
        if valid && best.is_none_or(|(_, b)| e.abs() < b) {
            best = Some((m, e.abs()));
        }
    }
    best
}

pub fn late_tail_pass(p: &mut ModalProfile, refs: &RefSet, notes: &[u8], threads: usize) -> String {
    if p.decay.damper_tail_db == 0.0 {
        return "late tail: skipped (damper tail off)".to_string();
    }
    let mut anchors: Vec<NoteAnchor> = p.notes.anchors().to_vec();
    let mut damped = 0;
    let mut changed: Vec<(u8, f32)> = Vec::new();
    let (mut before, mut after) = (0.0, 0.0);
    for anchor in &mut anchors {
        let a = *anchor;
        if a.note >= p.decay.undamped_from_note || !notes.contains(&a.note) {
            continue;
        }
        if refs.get(a.note, 64).is_none_or(|(_, f)| f.late_release_db.is_none()) {
            continue;
        }
        let Some((cur, _)) = late_errors(p, refs, a.note, a.damper_tail) else { continue };
        let Some((m, e)) = best_tail(p, refs, a.note, threads) else { continue };
        damped += 1;
        before += cur.abs();
        if e <= cur.abs() - MIN_GAIN_DB {
            anchor.damper_tail = m;
            changed.push((a.note, m));
            after += e;
        } else {
            after += cur.abs();
        }
    }
    p.notes = NoteTable::from_anchors(&anchors).expect("at most 88 fitted notes");
    let n = damped.max(1) as f64;
    let list: Vec<String> = changed.iter().map(|(n, m)| format!("({n}, {m})")).collect();
    format!(
        "late tail: {damped} damped notes, {} changed, mean |late| before {:.2} dB after {:.2} dB; changed [{}]",
        changed.len(),
        before / n,
        after / n,
        list.join(", ")
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fit::reference::RefNote;
    use crate::sound::modal_piano::parse_modal_profile;

    #[test]
    #[cfg_attr(debug_assertions, ignore = "needs release")]
    fn best_tail_recovers_a_synthetic_target() {
        let base = parse_modal_profile(include_str!("../../profiles/physical.ron")).unwrap();
        let mut anchors: Vec<NoteAnchor> = base.notes.anchors().to_vec();
        assert_eq!(anchors[27].note, 48);
        anchors[27].damper_tail = 2.0;
        let mut target = base;
        target.notes = NoteTable::from_anchors(&anchors).unwrap();
        let f = analyze_note(&render_note(&target, 48, 64, 1.0, AFTER_KEY_UP_S), 48000, 48, 1.0);
        assert!(f.late_release_db.is_some());
        let refs = RefSet { items: vec![(RefNote { note: 48, velocity: 64, on_s: 0.0, off_s: 1.0 }, f)] };
        let (m, e) = best_tail(&base, &refs, 48, 4).unwrap();
        assert_eq!(m, 2.0);
        assert!(e < 1e-9, "error {e}");
    }

    #[test]
    #[cfg_attr(debug_assertions, ignore = "needs release")]
    fn late_tail_pass_skips_when_tail_off() {
        let mut base = parse_modal_profile(include_str!("../../profiles/physical.ron")).unwrap();
        base.decay.damper_tail_db = 0.0;
        let mut q = base;
        let line = late_tail_pass(&mut q, &RefSet { items: vec![] }, &[48], 4);
        assert_eq!(line, "late tail: skipped (damper tail off)");
        assert!(q == base);
    }
}
