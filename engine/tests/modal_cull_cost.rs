use rusty_piano_engine::{
    midi::MidiEvent,
    render::{render_events_stereo, test_piece},
    sound::{
        modal_piano::{parse_modal_profile, ModalPiano, ModalProfile},
        SoundEngine,
    },
};
use std::time::Instant;

const SR: u32 = 48000;

fn physical() -> ModalProfile {
    parse_modal_profile(include_str!("../profiles/physical.ron")).unwrap()
}

fn engine_with(quiet: Option<f32>) -> ModalPiano {
    let mut e = ModalPiano::with_profile(SR, &physical());
    if let Some(v) = quiet {
        e.set_quiet_peak(v);
    }
    e
}

#[test]
#[cfg_attr(debug_assertions, ignore = "CPU budget: run with cargo test --release")]
fn default_cull_is_unchanged() {
    let events: Vec<(u64, MidiEvent)> = [36u8, 48, 60, 72, 84]
        .iter()
        .flat_map(|&note| {
            [
                (0u64, MidiEvent::NoteOn { note, velocity: 80 }),
                (300_000u64, MidiEvent::NoteOff { note }),
            ]
        })
        .collect();

    let mut a_engine = engine_with(None);
    let a = render_events_stereo(&mut a_engine, &events, SR, 4.0);
    assert_eq!(a_engine.quiet_peak(), 1e-7);

    let mut b_engine = engine_with(Some(1e-7));
    let b = render_events_stereo(&mut b_engine, &events, SR, 4.0);
    assert_eq!(a.left, b.left);
    assert_eq!(a.right, b.right);

    let mut c_engine = engine_with(Some(1e-5));
    let c = render_events_stereo(&mut c_engine, &events, SR, 4.0);
    assert!(a.left != c.left || a.right != c.right, "cull 1e-5 output equals default cull output");
}

fn median3(mut v: Vec<f64>) -> f64 {
    v.sort_by(f64::total_cmp);
    v[1]
}

fn report(name: &str, run: impl Fn(f32) -> f64) {
    let mut r5 = Vec::new();
    let mut r7 = Vec::new();
    for _ in 0..3 {
        r5.push(run(1e-5));
        r7.push(run(1e-7));
    }
    let rtf_5 = median3(r5);
    let rtf_7 = median3(r7);
    let pct = (rtf_5 / rtf_7 - 1.0) * 100.0;
    println!("{name}: cull 1e-5: {rtf_5:.1}x, cull 1e-7: {rtf_7:.1}x, cost {pct:+.1} %");
}

#[test]
#[ignore = "timing: run on a quiet machine with -- --ignored --nocapture"]
fn cull_cpu_cost() {
    report("test piece", |level| {
        let mut e = engine_with(Some(level));
        let events = test_piece().events;
        let start = Instant::now();
        let buf = render_events_stereo(&mut e, &events, SR, 2.0);
        let wall = start.elapsed().as_secs_f64();
        buf.len() as f64 / SR as f64 / wall
    });

    let pedal_notes = [36u8, 43, 48, 52, 55, 60, 64, 67, 72, 76];
    report("pedal down", |level| {
        let mut e = engine_with(Some(level));
        e.handle(&MidiEvent::Sustain { on: true });
        for note in pedal_notes {
            e.handle(&MidiEvent::NoteOn { note, velocity: 100 });
        }
        let mut l = [0.0f32; 64];
        let mut r = [0.0f32; 64];
        let start = Instant::now();
        for _ in 0..(4 * SR as usize) / 64 {
            e.render_stereo(&mut l, &mut r);
        }
        let wall = start.elapsed().as_secs_f64();
        4.0 / wall
    });

    let staccato: Vec<(u64, MidiEvent)> = (36u8..=67)
        .enumerate()
        .flat_map(|(i, note)| {
            let on = i as u64 * 150_000;
            [
                (on, MidiEvent::NoteOn { note, velocity: 100 }),
                (on + 100_000, MidiEvent::NoteOff { note }),
            ]
        })
        .collect();
    report("staccato", |level| {
        let mut e = engine_with(Some(level));
        let start = Instant::now();
        let buf = render_events_stereo(&mut e, &staccato, SR, 3.0);
        let wall = start.elapsed().as_secs_f64();
        buf.len() as f64 / SR as f64 / wall
    });
}
