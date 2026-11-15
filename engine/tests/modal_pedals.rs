use rusty_piano_engine::{
    config::SoundProfile,
    midi::{MidiEvent, Pedal},
    playback::parse_smf,
    record::encode_smf,
    render::{render_sound_profile, StereoBuf, SAMPLE_RATE},
    sound::modal_piano::{profile::ModalNoises, ModalProfile},
};

type Events = Vec<(u64, MidiEvent)>;

fn via_smf(events: &[(u64, MidiEvent)]) -> Events {
    parse_smf(&encode_smf(events)).unwrap()
}

fn render(events: &[(u64, MidiEvent)]) -> StereoBuf {
    render_sound_profile(&SoundProfile::Modal(ModalProfile::default()), events)
}

fn mono(buf: &StereoBuf) -> Vec<f32> {
    buf.left
        .iter()
        .zip(buf.right.iter())
        .map(|(l, r)| 0.5 * (l + r))
        .collect()
}

fn level_db(x: &[f32]) -> f64 {
    let ms = x.iter().map(|&v| (v as f64) * (v as f64)).sum::<f64>() / x.len().max(1) as f64;
    10.0 * (ms + 1e-30).log10()
}

fn window(m: &[f32], from_s: f64, to_s: f64) -> &[f32] {
    let a = (from_s * SAMPLE_RATE as f64) as usize;
    let b = ((to_s * SAMPLE_RATE as f64) as usize).min(m.len());
    &m[a..b]
}

fn pedal(pedal: Pedal, value: u8) -> MidiEvent {
    MidiEvent::Pedal { pedal, value }
}

#[test]
fn recorded_pedals_reach_the_modal_engine() {
    let a: Events = vec![
        (0, MidiEvent::NoteOn { note: 60, velocity: 100 }),
        (100_000, MidiEvent::Sustain { on: true }),
        (200_000, MidiEvent::NoteOff { note: 60 }),
        (1_200_000, MidiEvent::Sustain { on: false }),
    ];
    let b = via_smf(&a);
    assert_eq!(b[1].1, pedal(Pedal::Sustain, 127));
    assert_eq!(b[3].1, pedal(Pedal::Sustain, 0));
    let ra = render(&a);
    let rb = render(&b);
    assert_eq!(ra.left, rb.left);
    assert_eq!(ra.right, rb.right);
}

#[test]
fn half_pedal_sits_between_up_and_down() {
    let drop = |v: u8| {
        let e: Events = vec![
            (0, pedal(Pedal::Sustain, v)),
            (0, MidiEvent::NoteOn { note: 60, velocity: 100 }),
            (500_000, MidiEvent::NoteOff { note: 60 }),
        ];
        let m = mono(&render(&via_smf(&e)));
        level_db(window(&m, 0.45, 0.50)) - level_db(window(&m, 0.75, 0.80))
    };
    let (d0, d64, d127) = (drop(0), drop(64), drop(127));
    println!("drop pedal 0: {d0:.2} dB, 64: {d64:.2} dB, 127: {d127:.2} dB");
    assert!(d0 > d64 + 6.0, "{d0} vs {d64}");
    assert!(d64 > d127 + 2.0, "{d64} vs {d127}");
}

#[test]
fn sostenuto_and_soft_survive_smf_and_render() {
    let e: Events = vec![
        (0, MidiEvent::NoteOn { note: 48, velocity: 100 }),
        (100_000, pedal(Pedal::Sostenuto, 127)),
        (150_000, pedal(Pedal::Soft, 127)),
        (200_000, MidiEvent::NoteOn { note: 64, velocity: 90 }),
        (400_000, MidiEvent::NoteOff { note: 48 }),
        (400_000, MidiEvent::NoteOff { note: 64 }),
        (1_400_000, pedal(Pedal::Sostenuto, 0)),
        (1_500_000, pedal(Pedal::Soft, 0)),
    ];
    assert_eq!(via_smf(&e), e);
    let buf = render(&e);
    for &x in buf.left.iter().chain(buf.right.iter()) {
        assert!(x.is_finite());
        assert!(x.abs() <= 0.98 + 1e-6, "sample {x}");
    }
    let without: Events = e
        .iter()
        .copied()
        .filter(|(_, ev)| !matches!(ev, MidiEvent::Pedal { pedal: Pedal::Sostenuto, .. }))
        .collect();
    let with_db = level_db(window(&mono(&buf), 0.9, 1.3));
    let without_db = level_db(window(&mono(&render(&without)), 0.9, 1.3));
    println!("0.9-1.3 s level with sostenuto {with_db:.2} dB, without {without_db:.2} dB");
    assert!(with_db >= without_db + 10.0, "{with_db} vs {without_db}");
}

#[test]
fn sostenuto_keeps_only_keys_held_at_press() {
    let a: Events = vec![
        (0, MidiEvent::NoteOn { note: 48, velocity: 100 }),
        (100_000, pedal(Pedal::Sostenuto, 127)),
        (200_000, MidiEvent::NoteOn { note: 64, velocity: 90 }),
        (400_000, MidiEvent::NoteOff { note: 48 }),
        (400_000, MidiEvent::NoteOff { note: 64 }),
        (1_400_000, pedal(Pedal::Sostenuto, 0)),
    ];
    let b: Events = a
        .iter()
        .copied()
        .filter(|(_, ev)| !matches!(ev, MidiEvent::NoteOn { note: 64, .. } | MidiEvent::NoteOff { note: 64 }))
        .collect();
    let n: Events = a
        .iter()
        .copied()
        .filter(|(_, ev)| !matches!(ev, MidiEvent::Pedal { pedal: Pedal::Sostenuto, .. }))
        .collect();
    let lvl = |e: &Events| level_db(window(&mono(&render(e)), 0.9, 1.3));
    let (la, lb, ln) = (lvl(&a), lvl(&b), lvl(&n));
    println!("0.9-1.3 s level A {la:.2} dB, B (no note 64) {lb:.2} dB, N (no sostenuto) {ln:.2} dB");
    assert!((la - lb).abs() <= 1.0, "{la} vs {lb}");
    assert!(la >= ln + 10.0, "{la} vs {ln}");
}

#[test]
fn pedal_resonance_survives_smf_and_render() {
    let e: Events = vec![
        (0, pedal(Pedal::Sustain, 127)),
        (200_000, MidiEvent::NoteOn { note: 48, velocity: 100 }),
        (500_000, MidiEvent::NoteOff { note: 48 }),
        (3_000_000, pedal(Pedal::Sustain, 0)),
    ];
    assert_eq!(via_smf(&e), e);
    let a = render(&e);
    let mut p = ModalProfile::default();
    p.resonance.strength = 0.0;
    p.noises = ModalNoises::off();
    let b = render_sound_profile(&SoundProfile::Modal(p), &e);
    for buf in [&a, &b] {
        for &x in buf.left.iter().chain(buf.right.iter()) {
            assert!(x.is_finite());
            assert!(x.abs() <= 0.98 + 1e-6, "sample {x}");
        }
    }
    let (ma, mb) = (mono(&a), mono(&b));
    let (wa, wb) = (window(&ma, 1.0, 2.5), window(&mb, 1.0, 2.5));
    let max_diff = wa.iter().zip(wb).map(|(x, y)| (x - y).abs()).fold(0.0f32, f32::max);
    println!("levels 1.0-2.5 s: default {:.2} dB, resonance off {:.2} dB, max diff {max_diff}", level_db(wa), level_db(wb));
    assert!(max_diff > 1e-5, "max diff {max_diff}");
}

#[test]
fn noises_reach_render_through_smf() {
    let e: Events = vec![
        (0, MidiEvent::NoteOn { note: 60, velocity: 100 }),
        (500_000, MidiEvent::NoteOff { note: 60 }),
    ];
    let e = via_smf(&e);
    let a = mono(&render(&e));
    let p = ModalProfile {
        noises: ModalNoises::off(),
        ..Default::default()
    };
    let b = mono(&render_sound_profile(&SoundProfile::Modal(p), &e));
    for (from, to) in [(0.0, 0.03), (0.5, 0.53)] {
        let (wa, wb) = (window(&a, from, to), window(&b, from, to));
        let rms = (wa.iter().zip(wb).map(|(x, y)| ((x - y) as f64).powi(2)).sum::<f64>() / wa.len() as f64).sqrt();
        println!("noise difference rms {from}-{to} s: {rms}");
        assert!(rms > 0.0, "no noise in {from}-{to} s");
    }
}
