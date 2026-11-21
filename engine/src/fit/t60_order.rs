//! Keeps the test-piece t60 order 36 > 60 > 96 by shortening an offending note anchor.

use crate::config::SoundProfile;
use crate::metrics::{analyze, segments_from_events};
use crate::render::{render_sound_profile, test_piece, SAMPLE_RATE};
use crate::sound::modal_piano::tables::{NoteAnchor, NoteTable};
use crate::sound::modal_piano::ModalProfile;

pub const ORDER_NOTES: [u8; 3] = [36, 60, 96];
pub const ORDER_MARGIN: f64 = 1.05;
pub const T60_STEP: f32 = 0.7;
pub const MAX_STEPS: usize = 10;

pub fn test_piece_t60s(p: &ModalProfile) -> Option<[f64; 3]> {
    let piece = test_piece();
    let stereo = render_sound_profile(&SoundProfile::Modal(*p), &piece.events);
    let audio_s = stereo.len() as f64 / SAMPLE_RATE as f64;
    let segments = segments_from_events(&piece.events, &piece.sections, audio_s);
    let a = analyze(&stereo.mono(), SAMPLE_RATE, &segments, 0.0);
    let mut out = [0.0; 3];
    for (i, note) in ORDER_NOTES.iter().enumerate() {
        out[i] = a.segments.iter().find(|s| s.section == "keys" && s.notes == vec![*note]).and_then(|s| s.t60_s)?;
    }
    Some(out)
}

pub fn order_ok(t: [f64; 3]) -> bool {
    t[0] > ORDER_MARGIN * t[1] && t[1] > ORDER_MARGIN * t[2]
}

fn measure(p: &ModalProfile, template: &ModalProfile) -> Option<[f64; 3]> {
    let mut q = *p;
    q.resonance = template.resonance;
    test_piece_t60s(&q)
}

fn set_anchor(p: &mut ModalProfile, a: NoteAnchor) {
    let mut anchors: Vec<NoteAnchor> = p.notes.anchors().to_vec();
    if let Some(x) = anchors.iter_mut().find(|x| x.note == a.note) {
        *x = a;
    } else {
        anchors.push(a);
    }
    p.notes = NoteTable::from_anchors(&anchors).expect("anchor table");
}

pub fn t60_order_pass(p: &mut ModalProfile, template: &ModalProfile, notes: &[u8]) -> String {
    let Some(first) = measure(p, template) else {
        return "t60 order: not measurable, no action".to_string();
    };
    if order_ok(first) {
        return format!("t60 order: 36 {:.2} s > 60 {:.2} s > 96 {:.2} s, holds", first[0], first[1], first[2]);
    }
    let mut t = first;
    let mut actions: Vec<String> = Vec::new();
    let mut stuck = false;
    let mut steps = 0usize;
    let mut last: Option<u8> = None;
    let mut run = 0usize;
    while steps < MAX_STEPS && !order_ok(t) {
        let offender: u8 = if t[1].partial_cmp(&(ORDER_MARGIN * t[2])) != Some(std::cmp::Ordering::Greater) { 96 } else { 60 };
        let anchor = p.notes.anchors().iter().find(|a| a.note == offender).copied();
        let Some(anchor) = anchor.filter(|_| notes.contains(&offender)) else {
            actions.push(format!("no action (note {offender} not fitted)"));
            stuck = true;
            break;
        };
        if last != Some(offender) {
            if let Some(l) = last {
                actions.push(format!("note {l} t60 x{T60_STEP} ({run} steps)"));
            }
            last = Some(offender);
            run = 0;
        }
        run += 1;
        steps += 1;
        set_anchor(p, NoteAnchor { t60: (anchor.t60 * T60_STEP).max(0.1), ..anchor });
        match measure(p, template) {
            Some(n) => t = n,
            None => break,
        }
    }
    if let Some(l) = last {
        actions.push(format!("note {l} t60 x{T60_STEP} ({run} steps)"));
    }
    if !stuck && !order_ok(t) {
        let offender: u8 = if t[1].partial_cmp(&(ORDER_MARGIN * t[2])) != Some(std::cmp::Ordering::Greater) { 96 } else { 60 };
        set_anchor(p, NoteAnchor { note: offender, ..template.notes.at(offender) });
        actions.push(format!("note {offender} reverted to the template anchor"));
        if let Some(n) = measure(p, template) {
            t = n;
        }
    }
    format!(
        "t60 order: before 36 {:.2} / 60 {:.2} / 96 {:.2} s, after 36 {:.2} / 60 {:.2} / 96 {:.2} s, {}, actions: [{}]",
        first[0],
        first[1],
        first[2],
        t[0],
        t[1],
        t[2],
        if order_ok(t) { "holds" } else { "broken" },
        actions.join(", ")
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sound::modal_piano::parse_modal_profile;

    #[test]
    #[cfg_attr(debug_assertions, ignore = "needs release")]
    fn order_pass_repairs_a_long_note_96() {
        let base = parse_modal_profile(include_str!("../../profiles/physical.ron")).unwrap();
        let anchor_t60 = |p: &ModalProfile, note: u8| p.notes.anchors().iter().find(|a| a.note == note).unwrap().t60;
        let with96 = |t60: f32| {
            let mut p = base;
            let a = *p.notes.anchors().iter().find(|a| a.note == 96).unwrap();
            set_anchor(&mut p, NoteAnchor { t60, ..a });
            p
        };
        let t60_60 = anchor_t60(&base, 60);
        let mut tried: Vec<String> = Vec::new();
        let mut found: Option<ModalProfile> = None;
        for m in [1.5f32, 2.0, 3.0, 4.0, 6.0] {
            let p = with96(m * t60_60);
            let measured = measure(&p, &base);
            tried.push(format!("x{m} -> {measured:?}"));
            if measured.is_some_and(|t| !order_ok(t)) {
                found = Some(p);
                break;
            }
        }
        let mut p = found.unwrap_or_else(|| panic!("no measurable broken order found, tried {tried:?}"));
        let line = t60_order_pass(&mut p, &base, &(21..=108).collect::<Vec<u8>>());
        assert!(line.starts_with("t60 order:"), "{line}");
        assert!(line.contains(", holds,"), "{line}");
        assert!(order_ok(measure(&p, &base).unwrap()), "{line}");
        println!("{line}");
    }
}
