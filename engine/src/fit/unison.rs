//! Per-note detune and decay_spread for notes outside the drop bounds: picks the pair that best matches the reference d1/d2.

use super::analysis::analyze_note;
use super::evaluate::render_note;
use super::reference::{parallel_map, RefSet};
use crate::sound::modal_piano::tables::{NoteAnchor, NoteTable};
use crate::sound::modal_piano::ModalProfile;

pub const DETUNE_GRID: [f32; 6] = [0.0, 0.25, 0.5, 1.0, 2.0, 4.0];
pub const SPREAD_GRID: [f32; 4] = [0.0, 0.4, 1.0, 2.0];
pub const UNISON_HOLD_S: f64 = 2.5;
pub const MIN_GAIN: f64 = 1.0;
pub const UNISON_MAX_NOTE: u8 = 79;

pub fn drop_errors(p: &ModalProfile, refs: &RefSet, note: u8, detune: f32, spread: f32) -> Option<(f64, f64, f64)> {
    let mut q = *p;
    let mut anchors: Vec<NoteAnchor> = p.notes.anchors().to_vec();
    if let Some(a) = anchors.iter_mut().find(|a| a.note == note) {
        a.detune = detune;
        a.decay_spread = spread;
    } else {
        anchors = vec![NoteAnchor { detune, decay_spread: spread, ..p.notes.at(note) }];
    }
    q.notes = NoteTable::from_anchors(&anchors).expect("anchor table");
    let x = render_note(&q, note, 64, UNISON_HOLD_S, 0.0);
    let o = analyze_note(&x, 48000, note, UNISON_HOLD_S);
    let (_, r) = refs.get(note, 64)?;
    let d1e = o.d1_db? - r.d1_db?;
    let d2e = o.d2_db? - r.d2_db?;
    Some((d1e, d2e, (d1e / 2.0).powi(2) + (d2e / 3.0).powi(2)))
}

pub fn best_unison(p: &ModalProfile, refs: &RefSet, note: u8, threads: usize) -> Option<(f32, f32, f64)> {
    let pairs: Vec<(f32, f32)> = DETUNE_GRID.iter().flat_map(|&d| SPREAD_GRID.iter().map(move |&s| (d, s))).collect();
    let costs = parallel_map(pairs.len(), threads, |i| drop_errors(p, refs, note, pairs[i].0, pairs[i].1).map(|e| e.2));
    let mut best: Option<(f32, f32, f64)> = None;
    for (&(d, s), c) in pairs.iter().zip(&costs) {
        if let Some(c) = *c {
            if best.is_none_or(|(_, _, b)| c < b) {
                best = Some((d, s, c));
            }
        }
    }
    best
}

pub fn unison_pass(p: &mut ModalProfile, refs: &RefSet, notes: &[u8], threads: usize) -> String {
    let mut anchors: Vec<NoteAnchor> = p.notes.anchors().to_vec();
    let mut outside = 0;
    let mut changed: Vec<(u8, f32, f32, f64, f64)> = Vec::new();
    for anchor in &mut anchors {
        let a = *anchor;
        if a.note > UNISON_MAX_NOTE || !notes.contains(&a.note) {
            continue;
        }
        let Some((d1e, d2e, cur)) = drop_errors(p, refs, a.note, a.detune, a.decay_spread) else {
            continue;
        };
        if d1e.abs() <= 2.0 && d2e.abs() <= 4.0 {
            continue;
        }
        outside += 1;
        if let Some((d, s, c)) = best_unison(p, refs, a.note, threads) {
            if c <= cur - MIN_GAIN {
                anchor.detune = d;
                anchor.decay_spread = s;
                changed.push((a.note, d, s, cur, c));
            }
        }
    }
    p.notes = NoteTable::from_anchors(&anchors).expect("at most 88 fitted notes");
    let list: Vec<String> = changed.iter().map(|(n, d, s, b, a)| format!("({n}, {d}, {s}, {b:.2} -> {a:.2})")).collect();
    format!("unison pass: {outside} notes outside the drop bounds (notes up to {UNISON_MAX_NOTE}), {} changed: [{}]", changed.len(), list.join(", "))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fit::reference::RefNote;

    fn refs_for(target: &ModalProfile) -> RefSet {
        refs_for_note(target, 64)
    }

    fn refs_for_note(target: &ModalProfile, note: u8) -> RefSet {
        let f = analyze_note(&render_note(target, note, 64, UNISON_HOLD_S, 0.0), 48000, note, UNISON_HOLD_S);
        RefSet { items: vec![(RefNote { note, velocity: 64, on_s: 0.0, off_s: UNISON_HOLD_S }, f)] }
    }

    #[test]
    #[cfg_attr(debug_assertions, ignore = "needs release")]
    fn unison_pass_skips_treble_notes() {
        let base = ModalProfile { notes: NoteTable::from_anchors(&[NoteAnchor::neutral(96)]).unwrap(), ..Default::default() };
        let mut target = base;
        target.notes = NoteTable::from_anchors(&[NoteAnchor { detune: 0.0, decay_spread: 0.0, ..NoteAnchor::neutral(96) }]).unwrap();
        let refs = refs_for_note(&target, 96);
        let mut q = base;
        unison_pass(&mut q, &refs, &[96], 4);
        assert!(q == base);
    }

    #[test]
    #[cfg_attr(debug_assertions, ignore = "needs release")]
    fn best_unison_recovers_a_synthetic_target() {
        let base = ModalProfile { notes: NoteTable::from_anchors(&[NoteAnchor::neutral(64)]).unwrap(), ..Default::default() };
        let mut target = base;
        target.notes = NoteTable::from_anchors(&[NoteAnchor { detune: 0.0, decay_spread: 0.0, ..NoteAnchor::neutral(64) }]).unwrap();
        let refs = refs_for(&target);
        let (d, s, c) = best_unison(&base, &refs, 64, 4).unwrap();
        assert_eq!((d, s), (0.0, 0.0));
        assert!(c < 1e-9, "cost {c}");
    }

    #[test]
    #[cfg_attr(debug_assertions, ignore = "needs release")]
    fn unison_pass_leaves_matched_notes_alone() {
        let base = ModalProfile { notes: NoteTable::from_anchors(&[NoteAnchor::neutral(64)]).unwrap(), ..Default::default() };
        let refs = refs_for(&base);
        let mut q = base;
        let line = unison_pass(&mut q, &refs, &[64], 4);
        assert!(q == base);
        assert!(line.starts_with("unison pass:"));
    }
}
