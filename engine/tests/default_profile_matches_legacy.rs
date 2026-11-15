#[allow(dead_code)]
mod legacy {
    use rusty_piano_engine::midi::MidiEvent;
    use rusty_piano_engine::sound::SoundEngine;
    use std::f32::consts::TAU;

    pub const MAX_VOICES: usize = 32;
    pub const VOICE_GAIN: f32 = 0.3;

    pub fn soft_clip(x: f32) -> f32 {
        if x.abs() <= 0.8 {
            return x;
        }
        x.signum() * (0.8 + 0.2 * ((x.abs() - 0.8) / 0.2).tanh())
    }

    #[derive(Clone, Copy, Default)]
    struct Voice {
        active: bool,
        note: u8,
        key_down: bool,
        attacking: bool,
        releasing: bool,
        phase: f32,
        phase_inc: f32,
        level: f32,
        attack_inc: f32,
        decay_coef: f32,
        release_coef: f32,
        peak: f32,
        amps: [f32; 4],
        started: u64,
    }

    pub struct LegacyPiano {
        sample_rate: f32,
        voices: [Voice; MAX_VOICES],
        sustain: bool,
        counter: u64,
    }

    fn harmonic_amps(freq: f32, vel: f32, sample_rate: f32) -> [f32; 4] {
        let base = [1.0f32, 0.5, 0.3, 0.15];
        let brightness = 0.35 + 0.65 * vel;
        let mut amps = [0.0f32; 4];
        for (k, a) in amps.iter_mut().enumerate() {
            if (k as f32 + 1.0) * freq < 0.45 * sample_rate {
                *a = if k == 0 { base[0] } else { base[k] * brightness };
            }
        }
        let sum: f32 = amps.iter().sum();
        if sum > 0.0 {
            for a in amps.iter_mut() {
                *a /= sum;
            }
        }
        amps
    }

    fn configure(v: &mut Voice, sample_rate: f32, note: u8, velocity: u8) {
        let vel = velocity as f32 / 127.0;
        let freq = 440.0 * 2.0_f32.powf((note as f32 - 69.0) / 12.0);
        let tau = (1.5 * 2.0_f32.powf((60.0 - note as f32) / 24.0)).clamp(0.2, 6.0);
        v.note = note;
        v.phase_inc = freq / sample_rate;
        v.attack_inc = 1.0 / (0.002 * sample_rate);
        v.decay_coef = (-1.0 / (tau * sample_rate)).exp();
        v.release_coef = (-1.0 / (0.08 * sample_rate)).exp();
        v.peak = VOICE_GAIN * vel.powf(1.5);
        v.amps = harmonic_amps(freq, vel, sample_rate);
    }

    impl LegacyPiano {
        pub fn new(sample_rate: u32) -> Self {
            Self {
                sample_rate: sample_rate as f32,
                voices: [Voice::default(); MAX_VOICES],
                sustain: false,
                counter: 0,
            }
        }

        pub fn active_voices(&self) -> usize {
            self.voices.iter().filter(|v| v.active).count()
        }

        pub fn is_sounding(&self, note: u8) -> bool {
            self.voices.iter().any(|v| v.active && v.note == note)
        }

        fn note_on(&mut self, note: u8, velocity: u8) {
            self.counter += 1;
            let started = self.counter;
            let sample_rate = self.sample_rate;
            if let Some(v) = self.voices.iter_mut().find(|v| v.active && v.note == note) {
                configure(v, sample_rate, note, velocity);
                v.attacking = true;
                v.releasing = false;
                v.key_down = true;
                v.started = started;
                return;
            }
            let i = match self.voices.iter().position(|v| !v.active) {
                Some(i) => i,
                None => self.steal_index(),
            };
            let v = &mut self.voices[i];
            configure(v, sample_rate, note, velocity);
            v.phase = 0.0;
            v.level = 0.0;
            v.attacking = true;
            v.releasing = false;
            v.key_down = true;
            v.active = true;
            v.started = started;
        }

        fn steal_index(&self) -> usize {
            let any_releasing = self.voices.iter().any(|v| v.releasing);
            self.voices
                .iter()
                .enumerate()
                .filter(|(_, v)| v.releasing || !any_releasing)
                .min_by(|(_, a), (_, b)| a.level.total_cmp(&b.level).then(a.started.cmp(&b.started)))
                .map(|(i, _)| i)
                .unwrap_or(0)
        }

        fn note_off(&mut self, note: u8) {
            for v in self.voices.iter_mut() {
                if v.active && v.key_down && v.note == note {
                    v.key_down = false;
                    if !self.sustain {
                        v.releasing = true;
                        v.attacking = false;
                    }
                }
            }
        }
    }

    impl SoundEngine for LegacyPiano {
        fn handle(&mut self, ev: &MidiEvent) {
            match *ev {
                MidiEvent::NoteOn { note, velocity: 0 } => self.note_off(note),
                MidiEvent::NoteOn { note, velocity } => self.note_on(note, velocity),
                MidiEvent::NoteOff { note } => self.note_off(note),
                MidiEvent::Sustain { on } => {
                    self.sustain = on;
                    if !on {
                        for v in self.voices.iter_mut() {
                            if v.active && !v.key_down {
                                v.releasing = true;
                                v.attacking = false;
                            }
                        }
                    }
                }
                MidiEvent::Pedal { .. } => {}
            }
        }

        fn render(&mut self, out: &mut [f32]) {
            for s in out.iter_mut() {
                *s = 0.0;
            }
            for v in self.voices.iter_mut() {
                if !v.active {
                    continue;
                }
                for s in out.iter_mut() {
                    if v.attacking {
                        v.level += v.attack_inc;
                        if v.level >= 1.0 {
                            v.level = 1.0;
                            v.attacking = false;
                        }
                    } else if v.releasing {
                        v.level *= v.release_coef;
                    } else {
                        v.level *= v.decay_coef;
                    }
                    if !v.attacking && v.level < 1e-4 {
                        v.active = false;
                        break;
                    }
                    let x = TAU * v.phase;
                    let s1 = x.sin();
                    let c = x.cos();
                    let s2 = 2.0 * c * s1;
                    let s3 = 2.0 * c * s2 - s1;
                    let s4 = 2.0 * c * s3 - s2;
                    let wave = v.amps[0] * s1 + v.amps[1] * s2 + v.amps[2] * s3 + v.amps[3] * s4;
                    *s += wave * v.level * v.peak;
                    v.phase += v.phase_inc;
                    if v.phase >= 1.0 {
                        v.phase -= 1.0;
                    }
                }
            }
            for s in out.iter_mut() {
                *s = soft_clip(*s);
            }
        }

        fn render_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
            let n = left.len().min(right.len());
            self.render(&mut left[..n]);
            right[..n].copy_from_slice(&left[..n]);
        }
    }
}

use legacy::LegacyPiano;
use rusty_piano_engine::midi::{demo_sequence, MidiEvent};
use rusty_piano_engine::sound::simple_piano::SimplePiano;
use rusty_piano_engine::sound::SoundEngine;

fn script(sample_rate: u32) -> Vec<(usize, MidiEvent)> {
    let at = |ms: u64| (ms * sample_rate as u64 / 1000) as usize;
    let mut ev: Vec<(usize, MidiEvent)> = demo_sequence()
        .into_iter()
        .map(|(ms, e)| (at(ms), e))
        .collect();
    ev.push((at(7000), MidiEvent::Sustain { on: true }));
    for n in 30u8..94 {
        ev.push((at(7000), MidiEvent::NoteOn { note: n, velocity: 127 }));
    }
    for n in 30u8..94 {
        ev.push((at(7500), MidiEvent::NoteOff { note: n }));
    }
    ev.push((at(8000), MidiEvent::Sustain { on: false }));
    ev.push((at(8500), MidiEvent::NoteOn { note: 60, velocity: 50 }));
    ev.push((at(8510), MidiEvent::NoteOn { note: 60, velocity: 90 }));
    ev.push((at(8700), MidiEvent::NoteOff { note: 60 }));
    ev.sort_by_key(|(t, _)| *t);
    ev
}

fn run(engine: &mut dyn SoundEngine, sample_rate: u32) -> Vec<f32> {
    let events = script(sample_rate);
    let total = (9.0 * sample_rate as f64) as usize;
    let mut out = Vec::with_capacity(total + 256);
    let mut next = 0;
    let mut buf = [0.0f32; 256];
    let mut start = 0usize;
    while start < total {
        while next < events.len() && events[next].0 <= start {
            engine.handle(&events[next].1);
            next += 1;
        }
        engine.render(&mut buf);
        out.extend_from_slice(&buf);
        start += 256;
    }
    out
}

fn compare(sr: u32, new: &mut dyn SoundEngine) {
    let mut legacy = LegacyPiano::new(sr);
    let a = run(&mut legacy, sr);
    let b = run(new, sr);
    assert_eq!(a.len(), b.len());
    let mut max_diff = 0.0f32;
    for (i, (x, y)) in a.iter().zip(b.iter()).enumerate() {
        let d = (x - y).abs();
        max_diff = max_diff.max(d);
        assert!(d <= 1e-6, "sr {sr}: first mismatch at {i}: legacy {x} new {y}");
    }
    println!("sr {sr}: max diff {max_diff}");
    let peak = a.iter().fold(0.0f32, |m, s| m.max(s.abs()));
    assert!(peak > 0.5, "legacy output too quiet: {peak}");
}

#[test]
fn default_ron_renders_identically_to_legacy() {
    let profile = rusty_piano_engine::config::load_profile(
        &std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("profiles")
            .join("default.ron"),
    )
    .unwrap();
    for sr in [48000u32, 44100] {
        compare(sr, &mut SimplePiano::with_profile(sr, &profile));
    }
}

#[test]
fn builtin_default_renders_identically_to_legacy() {
    for sr in [48000u32, 44100] {
        compare(sr, &mut SimplePiano::new(sr));
    }
}
