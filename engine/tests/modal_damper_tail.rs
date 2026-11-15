use rusty_piano_engine::{
    midi::MidiEvent,
    sound::{
        modal_piano::{parse_modal_profile, ModalPiano, ModalProfile},
        SoundEngine,
    },
};

const SR: u32 = 48000;

fn physical(tail_db: f32, tail_bass: f32) -> ModalProfile {
    let mut p = parse_modal_profile(include_str!("../profiles/physical.ron")).unwrap();
    p.decay.damper_tail_db = tail_db;
    p.decay.damper_tail_t60_bass_s = tail_bass;
    p
}

fn render(e: &mut ModalPiano, frames: usize) -> Vec<f32> {
    let mut out = Vec::with_capacity(frames);
    let mut done = 0;
    while done < frames {
        let n = (frames - done).min(64);
        let mut l = [0.0f32; 64];
        let mut r = [0.0f32; 64];
        e.render_stereo(&mut l[..n], &mut r[..n]);
        for i in 0..n {
            out.push(0.5 * (l[i] + r[i]));
        }
        done += n;
    }
    out
}

fn secs(s: f64) -> usize {
    (s * SR as f64) as usize
}

fn level(x: &[f32]) -> f64 {
    let ms = x.iter().map(|&v| (v as f64) * (v as f64)).sum::<f64>() / x.len() as f64;
    10.0 * (ms + 1e-30).log10()
}

fn win(x: &[f32], from: f64, to: f64) -> f64 {
    level(&x[secs(from)..secs(to)])
}

/// Key held 0.3 s at velocity 80, then released; returns `after` seconds of audio from the release on (and the hold part is dropped).
fn note_tail(p: &ModalProfile, note: u8, after: f64) -> Vec<f32> {
    let mut e = ModalPiano::with_profile(SR, p);
    e.handle(&MidiEvent::NoteOn { note, velocity: 80 });
    render(&mut e, secs(0.3));
    e.handle(&MidiEvent::NoteOff { note });
    render(&mut e, secs(after))
}

#[test]
fn tail_survives_the_voice_cull() {
    let mut p = physical(35.0, 2.0);
    p.decay.damper_tail_t60_bass_s = 2.0;
    for note in [21u8, 72] {
        let mut e = ModalPiano::with_profile(SR, &p);
        e.handle(&MidiEvent::NoteOn { note, velocity: 64 });
        let held = render(&mut e, secs(3.0));
        e.handle(&MidiEvent::NoteOff { note });
        let after = render(&mut e, secs(2.0));
        let peak = (0..20)
            .map(|i| win(&held, i as f64 * 0.05, (i + 1) as f64 * 0.05))
            .fold(f64::MIN, f64::max);
        let mut lv: Vec<f64> = (0..10)
            .map(|i| win(&after, 1.0 + i as f64 * 0.05, 1.05 + i as f64 * 0.05))
            .collect();
        lv.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let med = lv[lv.len() / 2];
        let rms = after[secs(1.0)..secs(1.5)].iter().any(|&v| v != 0.0);
        assert!(rms, "note {note}: digital silence 1.0-1.5 s after key-up");
        assert!(med > peak - 110.0, "note {note}: median {med} dB vs peak {peak} dB");
    }
}

#[test]
fn tail_off_never_changes_the_signal() {
    let a = note_tail(&physical(0.0, 2.0), 36, 1.5);
    let b = note_tail(&physical(0.0, 7.0), 36, 1.5);
    let c = note_tail(&physical(0.0, 0.05), 36, 1.5);
    assert_eq!(a, b);
    assert_eq!(a, c);
    let mut p = physical(0.0, 2.0);
    p.decay.damper_tail_t60_treble_s = 9.0;
    assert_eq!(a, note_tail(&p, 36, 1.5));
}

#[test]
fn tail_raises_the_residual_but_not_the_fast_stage() {
    let off = note_tail(&physical(0.0, 3.0), 36, 1.6);
    let mut p = physical(40.0, 3.0);
    p.decay.damper_tail_t60_bass_s = 3.0;
    let on = note_tail(&p, 36, 1.6);
    let late_off = win(&off, 1.0, 1.5);
    let late_on = win(&on, 1.0, 1.5);
    assert!(late_on >= late_off + 15.0, "off {late_off} on {late_on}");
    let drop = |x: &[f32]| win(x, 0.0, 0.01) - win(x, 0.1, 0.11);
    let (d_off, d_on) = (drop(&off), drop(&on));
    assert!((d_off - d_on).abs() <= 1.0, "drop off {d_off} on {d_on}");
}

#[test]
fn repress_resets_the_stage() {
    let mut p = physical(40.0, 3.0);
    p.decay.damper_tail_t60_bass_s = 3.0;
    let mut e = ModalPiano::with_profile(SR, &p);
    e.handle(&MidiEvent::NoteOn { note: 36, velocity: 80 });
    render(&mut e, secs(0.3));
    e.handle(&MidiEvent::NoteOff { note: 36 });
    let first = render(&mut e, secs(1.2));
    e.handle(&MidiEvent::NoteOn { note: 36, velocity: 80 });
    render(&mut e, secs(0.3));
    e.handle(&MidiEvent::NoteOff { note: 36 });
    let second = render(&mut e, secs(0.3));
    let drop = |x: &[f32]| win(x, 0.0, 0.01) - win(x, 0.1, 0.11);
    let (d1, d2) = (drop(&first), drop(&second));
    assert!((d1 - d2).abs() <= 1.0, "first {d1} second {d2}");
}

#[test]
fn resonance_keys_never_enter_the_tail() {
    use rusty_piano_engine::midi::Pedal;
    let run = |tail_db: f32| {
        let mut p = physical(tail_db, 3.0);
        p.decay.damper_tail_t60_treble_s = 1.0;
        let mut e = ModalPiano::with_profile(SR, &p);
        e.handle(&MidiEvent::Pedal { pedal: Pedal::Sustain, value: 64 });
        e.handle(&MidiEvent::NoteOn { note: 48, velocity: 110 });
        render(&mut e, secs(3.0))
    };
    let on = run(40.0);
    let off = run(0.0);
    assert!(on.iter().any(|&v| v != 0.0));
    assert_eq!(on, off);
}
