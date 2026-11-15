use rusty_piano_engine::midi::MidiEvent;
use rusty_piano_engine::sound::modal_piano::{parse_modal_profile, ModalPiano};
use rusty_piano_engine::sound::SoundEngine;

const PHYSICAL: &str = include_str!("../profiles/physical.ron");

#[test]
#[cfg_attr(debug_assertions, ignore)]
fn pedal_down_with_shipped_profile_is_fast_enough() {
    let p = parse_modal_profile(PHYSICAL).expect("physical.ron");
    let mut e = ModalPiano::with_profile(48000, &p);
    e.handle(&MidiEvent::Sustain { on: true });
    for n in [36u8, 43, 48, 52, 55, 60, 64, 67, 72, 76] {
        e.handle(&MidiEvent::NoteOn { note: n, velocity: 100 });
    }
    let mut l = [0.0f32; 64];
    let mut r = [0.0f32; 64];
    let t = std::time::Instant::now();
    for _ in 0..(4 * 48000 / 64) {
        e.render_stereo(&mut l, &mut r);
    }
    let rtf = 4.0 / t.elapsed().as_secs_f64();
    println!("pedal-down real-time factor {rtf:.1}");
    assert!(rtf >= 5.0, "real-time factor {rtf}");
}
