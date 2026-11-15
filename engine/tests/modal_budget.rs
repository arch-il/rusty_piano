use rusty_piano_engine::{
    config::SoundProfile,
    metrics::{analyze, segments_from_events},
    midi::MidiEvent,
    render::{render_sound_profile, test_piece, SAMPLE_RATE},
    sound::{
        modal_piano::{parse_modal_profile, ModalPiano, ModalProfile},
        SoundEngine,
    },
};
use std::sync::Mutex;
use std::time::Instant;

static LOCK: Mutex<()> = Mutex::new(());

#[test]
#[cfg_attr(debug_assertions, ignore = "CPU budget: run with cargo test --release")]
fn test_piece_renders_fast_enough() {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let piece = test_piece();
    let profile = SoundProfile::Modal(ModalProfile::default());

    let start = Instant::now();
    let stereo = render_sound_profile(&profile, &piece.events);
    let render_s = start.elapsed().as_secs_f64();
    let audio_s = stereo.len() as f64 / SAMPLE_RATE as f64;
    let factor = audio_s / render_s;
    println!("test piece: audio {audio_s:.2} s, render {render_s:.3} s, real-time factor {factor:.1}x");
    assert!(
        render_s <= audio_s / 15.0,
        "test piece real-time factor {factor:.1}x is below 15x"
    );

    let mono = stereo.mono();
    let segments = segments_from_events(&piece.events, &piece.sections, audio_s);
    let a = analyze(&mono, SAMPLE_RATE, &segments, 0.0);

    for note in [36u8, 60, 84] {
        let curve = a
            .velocity_curves
            .iter()
            .find(|c| c.note == note)
            .expect("velocity curve");
        assert!(
            curve.points.windows(2).all(|w| w[0].peak_db < w[1].peak_db),
            "note {note}: peak_db not strictly increasing: {:?}",
            curve.points
        );
        let range = if note == 60 { 20.0..=50.0 } else { 15.0..=60.0 };
        assert!(
            range.contains(&curve.dynamic_range_db),
            "note {note}: dynamic range {} dB",
            curve.dynamic_range_db
        );
    }

    assert_eq!(a.whole.clipped_samples, 0);
    println!("test piece peak {} dB, clipped {}", a.whole.peak_db, a.whole.clipped_samples);
    assert!(a.whole.peak_db <= 20.0 * (0.8f64 * 0.98).log10() + 0.01, "test piece peak {} dB above the knee", a.whole.peak_db);

    let t60 = |note: u8| {
        a.segments
            .iter()
            .find(|s| s.section == "keys" && s.notes == vec![note])
            .and_then(|s| s.t60_s)
            .unwrap_or_else(|| panic!("no t60 for note {note} in section keys"))
    };
    let (t36, t60_60, t96) = (t60(36), t60(60), t60(96));
    // The default prior keeps 36 > 60 and 36 > 96; the strict 36 > 60 > 96 order of the fitted profile is checked in tests/fitted_profiles.rs.
    assert!(t36 > t60_60 && t36 > t96, "t60 {t36} {t60_60} {t96}");
}

#[test]
#[cfg_attr(debug_assertions, ignore = "CPU budget: run with cargo test --release")]
fn test_piece_with_reverb_renders_fast_enough() {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let piece = test_piece();
    let mut p = parse_modal_profile(include_str!("../profiles/physical.ron")).expect("physical.ron");
    p.reverb.mix = 0.25;
    let profile = SoundProfile::Modal(p);

    let start = Instant::now();
    let stereo = render_sound_profile(&profile, &piece.events);
    let render_s = start.elapsed().as_secs_f64();
    let audio_s = stereo.len() as f64 / SAMPLE_RATE as f64;
    let factor = audio_s / render_s;
    println!("test piece with reverb: audio {audio_s:.2} s, render {render_s:.3} s, real-time factor {factor:.1}x");
    assert!(
        render_s <= audio_s / 15.0,
        "test piece with reverb real-time factor {factor:.1}x is below 15x"
    );

    let mono = stereo.mono();
    let segments = segments_from_events(&piece.events, &piece.sections, audio_s);
    let a = analyze(&mono, SAMPLE_RATE, &segments, 0.0);

    for note in [36u8, 60, 84] {
        let curve = a
            .velocity_curves
            .iter()
            .find(|c| c.note == note)
            .expect("velocity curve");
        assert!(
            curve.points.windows(2).all(|w| w[0].peak_db < w[1].peak_db),
            "note {note}: peak_db not strictly increasing: {:?}",
            curve.points
        );
    }

    assert_eq!(a.whole.clipped_samples, 0);
    println!("test piece with reverb peak {} dB, clipped {}", a.whole.peak_db, a.whole.clipped_samples);
    // The fitted level matches Pianoteq: the limiter may act on rare peaks; the pre-limiter headroom check is in tests/fitted_profiles.rs.
    assert!(a.whole.peak_db <= 20.0 * (0.98f64).log10() + 0.01, "peak {} dB above the limiter ceiling", a.whole.peak_db);
}

#[test]
#[cfg_attr(debug_assertions, ignore = "CPU budget: run with cargo test --release")]
fn thirty_two_voices_render_fast_enough() {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut e = ModalPiano::new(SAMPLE_RATE);
    e.handle(&MidiEvent::Sustain { on: true });
    for note in 36u8..=67 {
        e.handle(&MidiEvent::NoteOn { note, velocity: 100 });
    }

    let mut l = [0.0f32; 64];
    let mut r = [0.0f32; 64];
    let start = Instant::now();
    for _ in 0..(4 * SAMPLE_RATE as usize) / 64 {
        e.render_stereo(&mut l, &mut r);
    }
    let render_s = start.elapsed().as_secs_f64();
    let factor = 4.0 / render_s;
    println!(
        "32 voices: active_modes {}, render {render_s:.3} s for 4.0 s audio, real-time factor {factor:.1}x",
        e.active_modes()
    );
    assert!(
        render_s <= 4.0 / 3.0,
        "32 voices real-time factor {factor:.1}x is below 3x"
    );
    assert_eq!(e.active_voices(), 32);
}

fn median3(mut f: impl FnMut() -> f64) -> f64 {
    let mut v = [f(), f(), f()];
    v.sort_by(f64::total_cmp);
    v[1]
}

fn test_piece_factor() -> f64 {
    let piece = test_piece();
    let profile = SoundProfile::Modal(ModalProfile::default());
    let start = Instant::now();
    let stereo = render_sound_profile(&profile, &piece.events);
    stereo.len() as f64 / SAMPLE_RATE as f64 / start.elapsed().as_secs_f64()
}

fn thirty_two_voices_factor() -> f64 {
    let mut e = ModalPiano::new(SAMPLE_RATE);
    e.handle(&MidiEvent::Sustain { on: true });
    for note in 36u8..=67 {
        e.handle(&MidiEvent::NoteOn { note, velocity: 100 });
    }
    let mut l = [0.0f32; 64];
    let mut r = [0.0f32; 64];
    let start = Instant::now();
    for _ in 0..(4 * SAMPLE_RATE as usize) / 64 {
        e.render_stereo(&mut l, &mut r);
    }
    4.0 / start.elapsed().as_secs_f64()
}

#[test]
#[cfg_attr(debug_assertions, ignore = "CPU budget: run with cargo test --release")]
fn pedal_down_resonance_renders_fast_enough() {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut keys = 0usize;
    let factor = median3(|| {
        let mut e = ModalPiano::new(SAMPLE_RATE);
        e.handle(&MidiEvent::Sustain { on: true });
        for note in [36u8, 43, 48, 52, 55, 60, 64, 67, 72, 76] {
            e.handle(&MidiEvent::NoteOn { note, velocity: 100 });
        }

        let mut l = [0.0f32; 64];
        let mut r = [0.0f32; 64];
        let start = Instant::now();
        for _ in 0..(4 * SAMPLE_RATE as usize) / 64 {
            e.render_stereo(&mut l, &mut r);
        }
        let render_s = start.elapsed().as_secs_f64();
        println!(
            "pedal down: active_modes {}, resonating_keys {}, render {render_s:.3} s for 4.0 s audio, real-time factor {:.1}x",
            e.active_modes(),
            e.resonating_keys(),
            4.0 / render_s
        );
        keys = e.resonating_keys();
        4.0 / render_s
    });
    let piece = median3(test_piece_factor);
    let voices = median3(thirty_two_voices_factor);
    println!("budget medians of 3: test piece {piece:.1}x, 32 voices {voices:.1}x, pedal down {factor:.1}x");
    assert!(factor >= 5.0, "pedal-down real-time factor {factor:.1}x is below 5x");
    assert!(piece >= 18.0, "test piece real-time factor {piece:.1}x is below 18x"); // 18x leaves room on a busy laptop; budget minimum is 15x
    assert!(voices >= 3.5, "32 voices real-time factor {voices:.1}x is below 3.5x");
    assert!(keys >= 60, "resonating keys {keys}");
}

#[test]
#[cfg_attr(debug_assertions, ignore = "CPU budget: run with cargo test --release")]
fn resonance_profile_change_is_fast() {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut e = ModalPiano::new(SAMPLE_RATE);
    e.handle(&MidiEvent::Sustain { on: true });
    for note in [36u8, 43, 48, 52, 55, 60, 64, 67, 72, 76] {
        e.handle(&MidiEvent::NoteOn { note, velocity: 100 });
    }
    let mut l = [0.0f32; 64];
    let mut r = [0.0f32; 64];
    for _ in 0..(SAMPLE_RATE as usize) / 2 / 64 {
        e.render_stereo(&mut l, &mut r);
    }
    let mut times = Vec::new();
    for i in 0..20 {
        let mut p = ModalProfile::default();
        p.resonance.strength = if i % 2 == 0 { 0.9 } else { 1.0 };
        let start = Instant::now();
        e.set_profile(&p);
        times.push(start.elapsed().as_secs_f64() * 1000.0);
        e.render_stereo(&mut l, &mut r);
    }
    let mean = times.iter().sum::<f64>() / times.len() as f64;
    let max = times.iter().cloned().fold(0.0, f64::max);
    println!("resonance profile change: mean {mean:.3} ms, max {max:.3} ms");
    assert!(mean <= 5.0, "mean {mean} ms");
    assert!(max <= 25.0, "max {max} ms");
}
