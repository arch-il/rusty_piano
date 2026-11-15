use rusty_piano_engine::{
    midi::MidiEvent,
    sound::{
        modal_piano::{soundboard::Soundboard, ModalPiano, ModalProfile},
        SoundEngine,
    },
};
use std::time::Instant;

const SAMPLE_RATE: u32 = 48_000;

#[test]
#[cfg_attr(debug_assertions, ignore = "needs release")]
fn thirty_two_note_ons_are_cheap() {
    let mut times = Vec::new();
    for _ in 0..5 {
        let mut e = ModalPiano::new(SAMPLE_RATE);
        e.handle(&MidiEvent::Sustain { on: true });
        let mut l = [0.0f32; 64];
        let mut r = [0.0f32; 64];
        e.render_stereo(&mut l, &mut r);
        let t = Instant::now();
        for note in 36..=67u8 {
            e.handle(&MidiEvent::NoteOn { note, velocity: 100 });
        }
        times.push(t.elapsed().as_secs_f64() * 1000.0);
    }
    times.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let ms = times[2];
    println!("32 note-ons: median {ms:.3} ms (all: {times:?})");

    let p = ModalProfile::default();
    let mut sb = Soundboard::new(SAMPLE_RATE as f32);
    let mut cfg = Vec::new();
    for _ in 0..5 {
        let t = Instant::now();
        sb.configure(&p, SAMPLE_RATE as f32);
        cfg.push(t.elapsed().as_secs_f64() * 1000.0);
    }
    cfg.sort_by(|a, b| a.partial_cmp(b).unwrap());
    println!("Soundboard::configure: median {:.3} ms (all: {cfg:?})", cfg[2]);
    assert!(cfg[2] <= 10.0, "configure took {:.3} ms", cfg[2]);
    // Measured 2026-11-06: 0.98 ms before the mobility lookup table, 0.39 ms after (median of 5, machine under load from other jobs); 0.6 ms is a regression guard.
    assert!(ms <= 0.6, "32 note-ons took {ms:.3} ms");
}
