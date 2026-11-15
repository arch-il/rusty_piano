//! Rule (kept by decision 2026-11-06): live profile edits that change a sounding note's split (coupled_partials, coupled_max_hz, string count, partials_per_string, max_hz, coupling going to or from zero) apply to new notes only; other note-table, decay and tuning edits reach sounding notes.

use rusty_piano_engine::{
    midi::MidiEvent,
    render::SAMPLE_RATE,
    sound::{
        modal_piano::{ModalPiano, ModalProfile},
        SoundEngine,
    },
};

fn render(e: &mut ModalPiano, frames: usize) -> Vec<f32> {
    let mut out = Vec::with_capacity(frames);
    let mut done = 0;
    while done < frames {
        let n = 64.min(frames - done);
        let mut l = vec![0.0f32; n];
        let mut r = vec![0.0f32; n];
        e.render_stereo(&mut l, &mut r);
        out.extend(l.iter().zip(r.iter()).map(|(a, b)| 0.5 * (a + b)));
        done += n;
    }
    out
}

fn secs(s: f64) -> usize {
    (s * SAMPLE_RATE as f64) as usize
}

fn note_on(e: &mut ModalPiano, note: u8, velocity: u8) {
    e.handle(&MidiEvent::NoteOn { note, velocity });
}

fn level_db(x: &[f32]) -> f64 {
    let ms = x.iter().map(|&v| (v as f64) * (v as f64)).sum::<f64>() / x.len().max(1) as f64;
    10.0 * (ms + 1e-30).log10()
}

#[test]
fn split_edit_applies_to_new_notes_only() {
    let mut base = ModalProfile::default();
    base.resonance.strength = 0.0;
    let mut edited = base;
    edited.soundboard.coupled_partials = 6;

    let mut a = ModalPiano::with_profile(SAMPLE_RATE, &base);
    note_on(&mut a, 48, 100);
    render(&mut a, secs(0.3));
    let m0 = a.active_modes();
    a.set_profile(&edited);
    render(&mut a, secs(0.2));
    assert_eq!(a.active_modes(), m0, "held note must keep its split");
    let before = a.active_modes();
    note_on(&mut a, 60, 100);
    render(&mut a, 64);
    let grown = a.active_modes() - before;

    let mut fresh = ModalPiano::with_profile(SAMPLE_RATE, &edited);
    note_on(&mut fresh, 60, 100);
    render(&mut fresh, 64);
    let fresh_modes = fresh.active_modes();
    println!("m0 {m0}, new-note growth {grown}, fresh edited engine {fresh_modes}");
    assert_eq!(grown, fresh_modes);

    let tail = |edit: bool| {
        let mut e = ModalPiano::with_profile(SAMPLE_RATE, &base);
        note_on(&mut e, 48, 100);
        render(&mut e, secs(0.3));
        if edit {
            e.set_profile(&edited);
        }
        let x = render(&mut e, secs(0.2));
        level_db(&x[x.len() - secs(0.05)..])
    };
    let (lb, lc) = (tail(false), tail(true));
    println!("last 50 ms level: never edited {lb:.3} dB, edited {lc:.3} dB");
    assert!((lb - lc).abs() <= 0.5, "{lb} vs {lc}");
}

#[test]
fn stolen_voice_fades_with_board_on() {
    let mut p = ModalProfile::default();
    p.voices.max_voices = 1;
    let mut e = ModalPiano::with_profile(SAMPLE_RATE, &p);
    note_on(&mut e, 36, 127);
    let pre = render(&mut e, secs(0.3));
    let tail = &pre[pre.len() - 480..];
    let dmax_before = tail.windows(2).map(|w| (w[1] - w[0]).abs()).fold(0.0f32, f32::max);
    let last = *pre.last().unwrap();
    note_on(&mut e, 84, 1);
    assert_eq!(e.fading_voices(), 1);
    let post = render(&mut e, 480);
    let mut prev = last;
    let mut dmax_after = 0.0f32;
    for &x in &post {
        dmax_after = dmax_after.max((x - prev).abs());
        prev = x;
    }
    println!("max step before {dmax_before}, across steal {dmax_after}");
    assert!(dmax_after <= 2.0 * dmax_before, "{dmax_after} vs {dmax_before}");
    assert_eq!(e.fading_voices(), 0);
    assert!(!e.is_sounding(36));
    assert!(pre.iter().chain(post.iter()).all(|x| x.is_finite()));
}
