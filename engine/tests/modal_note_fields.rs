use rusty_piano_engine::{
    fit::evaluate::render_note,
    midi::MidiEvent,
    render::render_events_stereo,
    sound::modal_piano::{
        parse_modal_profile,
        profile::ModalNoises,
        tables::{NoteAnchor, NoteTable},
        ModalPiano, ModalProfile,
    },
};

const SR: u32 = 48000;

// recorded on 2026-11-19 before the direct_db, decay_spread and damper_tail fields existed; an intended sound change must update it
const HASH_BEFORE: u64 = 11693217865367104116;

fn hash_profile() -> ModalProfile {
    let mut p = ModalProfile::default();
    p.decay.damper_tail_db = 30.0;
    p.notes = NoteTable::from_anchors(&[
        NoteAnchor { t60: 1.3, damper: 0.8, aftersound: 0.6, ..NoteAnchor::neutral(36) },
        NoteAnchor { level_db: 2.0, hardness: 1.5, detune: 1.5, ..NoteAnchor::neutral(60) },
        NoteAnchor { t60: 0.5, prompt_db_per_s: 35.0, after_level_db: -4.0, ..NoteAnchor::neutral(96) },
    ])
    .unwrap();
    p
}

fn render_hash(p: &ModalProfile) -> u64 {
    let events = vec![
        (0u64, MidiEvent::NoteOn { note: 36, velocity: 90 }),
        (0, MidiEvent::NoteOn { note: 60, velocity: 70 }),
        (100_000, MidiEvent::NoteOn { note: 96, velocity: 100 }),
        (400_000, MidiEvent::NoteOff { note: 36 }),
        (500_000, MidiEvent::Sustain { on: true }),
        (600_000, MidiEvent::NoteOff { note: 60 }),
        (700_000, MidiEvent::NoteOn { note: 72, velocity: 60 }),
        (900_000, MidiEvent::Sustain { on: false }),
        (1_000_000, MidiEvent::NoteOff { note: 96 }),
        (1_100_000, MidiEvent::NoteOff { note: 72 }),
    ];
    let buf = render_events_stereo(&mut ModalPiano::with_profile(SR, p), &events, SR, 1.0);
    let mut h: u64 = 0xcbf29ce484222325;
    for v in buf.left.iter().chain(buf.right.iter()) {
        for b in v.to_bits().to_le_bytes() {
            h ^= b as u64;
            h = h.wrapping_mul(0x100000001b3);
        }
    }
    h
}

fn physical() -> ModalProfile {
    parse_modal_profile(include_str!("../profiles/physical.ron")).unwrap()
}

fn rms(x: &[f32]) -> f64 {
    (x.iter().map(|&v| (v as f64) * (v as f64)).sum::<f64>() / x.len() as f64).sqrt()
}

fn with_notes(p: &ModalProfile, a: &[NoteAnchor]) -> ModalProfile {
    let mut q = *p;
    q.notes = NoteTable::from_anchors(a).unwrap();
    q
}

fn render_mono(p: &ModalProfile, note: u8, hold_s: f64, tail_s: f64) -> Vec<f32> {
    let mut q = *p;
    q.noises = ModalNoises::off();
    q.resonance.strength = 0.0;
    let events = vec![
        (0u64, MidiEvent::NoteOn { note, velocity: 80 }),
        ((hold_s * 1e6).round() as u64, MidiEvent::NoteOff { note }),
    ];
    let buf = render_events_stereo(&mut ModalPiano::with_profile(SR, &q), &events, SR, tail_s);
    let mut v = buf.left;
    v.extend(buf.right);
    v
}

#[test]
#[cfg_attr(debug_assertions, ignore = "hash recorded in a release build")]
fn neutral_fields_are_bit_exact() {
    assert_eq!(render_hash(&hash_profile()), HASH_BEFORE);
}

#[test]
fn old_ron_parses_with_neutral_new_fields() {
    let src = include_str!("../profiles/physical.ron");
    let start = src.find("    notes: [").unwrap();
    let end = start + src[start..].find("    ],").unwrap() + "    ],".len();
    let old = format!(
        "{}    notes: [\n        (note: 48, cents: 0.00, level_db: 0.00, t60: 1.000, damping: 1.000, inharmonicity: 1.000, hardness: 1.000, strike: 1.000, damper: 1.000, aftersound: 1.000, prompt_db_per_s: 0.00, after_level_db: 0.00),\n        (note: 72, cents: 0.00, level_db: 0.00, t60: 1.000, damping: 1.000, inharmonicity: 1.000, hardness: 1.000, strike: 1.000, damper: 1.000, aftersound: 1.000, prompt_db_per_s: 0.00, after_level_db: 0.00),\n    ],{}",
        &src[..start],
        &src[end..]
    );
    let p = parse_modal_profile(&old).unwrap();
    assert_eq!(p.notes.anchors().len(), 2);
    for a in p.notes.anchors() {
        assert_eq!(a.detune, 1.0);
        assert_eq!(a.decay_spread, 1.0);
        assert_eq!(a.damper_tail, 1.0);
        assert_eq!(a.direct_db, 0.0);
    }
    let shipped = physical();
    assert!(shipped.notes.anchors().iter().any(|a| a.direct_db != 0.0));
}

#[test]
#[cfg_attr(debug_assertions, ignore)]
fn direct_db_scales_only_the_direct_path() {
    let mut base = ModalProfile { noises: ModalNoises::off(), ..Default::default() };
    base.resonance.strength = 0.0;
    let loud = with_notes(&base, &[NoteAnchor { direct_db: 6.0206, ..NoteAnchor::neutral(72) }]);
    let flat = with_notes(&base, &[NoteAnchor::neutral(72)]);

    let (mut a, mut b) = (loud, flat);
    for q in [&mut a, &mut b] {
        q.mics.board_mix = 0.0;
        q.mics.body_mix = 0.0;
    }
    let ra = render_note(&a, 72, 80, 0.5, 0.5);
    let rb = render_note(&b, 72, 80, 0.5, 0.5);
    let ratio = rms(&ra) / rms(&rb);
    assert!((ratio - 2.0).abs() < 1e-3, "ratio {ratio}");

    let (mut a, mut b) = (loud, flat);
    for q in [&mut a, &mut b] {
        q.mics.direct_mix = 0.0;
    }
    let (ra, rb) = (render_note(&a, 72, 80, 0.5, 0.5), render_note(&b, 72, 80, 0.5, 0.5));
    // the voice cull (quiet peak measured after the direct gain) may end a boosted voice at a different moment in the last 0.1 s
    let n = ra.len() * 9 / 10;
    let first = ra[..n].iter().zip(rb[..n].iter()).position(|(x, y)| x != y);
    assert_eq!(first, None, "first differing sample of {}", ra.len());
}

#[test]
#[cfg_attr(debug_assertions, ignore)]
fn decay_spread_zero_matches_no_spread() {
    let mut p = ModalProfile::default();
    p.strings.unison_decay_spread = 0.25;
    let a = with_notes(&p, &[NoteAnchor { decay_spread: 0.0, ..NoteAnchor::neutral(60) }]);
    let mut b = ModalProfile::default();
    b.strings.unison_decay_spread = 0.0;
    assert_eq!(render_mono(&a, 60, 1.0, 0.5), render_mono(&b, 60, 1.0, 0.5));
}

#[test]
#[cfg_attr(debug_assertions, ignore)]
fn damper_tail_multiplier_lengthens_the_tail() {
    let p = physical();
    assert!(p.decay.damper_tail_db > 0.0);
    let tail_level = |q: &ModalProfile| {
        let r = render_mono(q, 48, 0.3, 2.0);
        let n = r.len() / 2;
        let left = &r[..n];
        let from = ((0.3 + 1.0) * SR as f64) as usize;
        let to = ((0.3 + 1.5) * SR as f64) as usize;
        20.0 * rms(&left[from..to]).max(1e-12).log10()
    };
    let one = with_notes(&p, &[NoteAnchor::neutral(48)]);
    let two = with_notes(&p, &[NoteAnchor { damper_tail: 2.0, ..NoteAnchor::neutral(48) }]);
    let (l1, l2) = (tail_level(&one), tail_level(&two));
    assert!(l2 >= l1 + 3.0, "{l1} dB vs {l2} dB");

    let mut off = p;
    off.decay.damper_tail_db = 0.0;
    let one = with_notes(&off, &[NoteAnchor::neutral(48)]);
    let two = with_notes(&off, &[NoteAnchor { damper_tail: 2.0, ..NoteAnchor::neutral(48) }]);
    assert_eq!(render_mono(&one, 48, 0.3, 2.0), render_mono(&two, 48, 0.3, 2.0));
}

#[test]
fn new_fields_are_validated() {
    let src = include_str!("../profiles/physical.ron");
    let start = src.find("    notes: [").unwrap();
    let end_rel = src[start..].find("    ],").unwrap();
    let end = start + end_rel + "    ],".len();
    let with = |anchor: &str| format!("{}    notes: [\n        ({anchor}),\n    ],{}", &src[..start], &src[end..]);

    for (anchor, field) in [
        ("note: 60, direct_db: 40.0", "notes[0].direct_db"),
        ("note: 60, decay_spread: 5.0", "notes[0].decay_spread"),
        ("note: 60, damper_tail: 0.05", "notes[0].damper_tail"),
    ] {
        let e = parse_modal_profile(&with(anchor)).unwrap_err().to_string();
        assert!(e.contains(field), "{e}");
    }
    parse_modal_profile(&with("note: 60, direct_db: -3.0, decay_spread: 0.5, damper_tail: 2.0")).unwrap();
}
