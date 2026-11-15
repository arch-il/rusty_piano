//! Simple piano-like voice for live playing: up to eight harmonics, a quick
//! attack, exponential decay, a release, a sustain pedal, up to 32-voice
//! polyphony and a soft limiter. All settings come from `crate::config::Profile`.
//! No allocation in `handle` or `render`.

use super::SoundEngine;
use crate::config::{Profile, StealPolicy};
use crate::midi::{MidiEvent, Pedal};
use std::f32::consts::TAU;

pub const MAX_VOICES: usize = 32;
pub const MAX_PARTIALS: usize = 8;

pub fn soft_clip(x: f32) -> f32 {
    if x.abs() <= 0.8 {
        return x;
    }
    x.signum() * (0.8 + 0.2 * ((x.abs() - 0.8) / 0.2).tanh())
}

pub fn limit(x: f32, knee: f32, ceiling: f32) -> f32 {
    let a = x.abs();
    let start = knee * ceiling;
    if a <= start {
        return x;
    }
    let width = ceiling - start;
    if width <= 0.0 {
        return x.signum() * ceiling;
    }
    x.signum() * (start + width * ((a - start) / width).tanh())
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
    amps: [f32; MAX_PARTIALS],
    partials: usize,
    started: u64,
}

pub struct SimplePiano {
    sample_rate: f32,
    voices: [Voice; MAX_VOICES],
    sustain: bool,
    counter: u64,
    profile: Profile,
    gain: f32,
    gain_coef: f32,
}

fn voice_spectrum(note: u8, velocity: u8, sample_rate: f32, p: &Profile) -> (f32, [f32; MAX_PARTIALS]) {
    let full = p.loudness.full_force_velocity.max(1);
    let vel = velocity.min(full) as f32 / full as f32;
    let freq = 440.0 * 2.0_f32.powf((note as f32 - 69.0) / 12.0);
    let below = ((p.bass.pivot_note as f32 - note as f32) / 12.0).max(0.0);
    let key_gain = 10.0_f32.powf((p.bass.gain_db_per_octave * below).min(p.bass.max_gain_db) / 20.0);
    let over_gain =
        10.0_f32.powf((p.bass.overtone_db_per_octave * below).min(p.bass.max_overtone_db) / 20.0);
    let brightness = p.tone.brightness_min + p.tone.brightness_velocity * vel;
    let base = p.tone.harmonics.as_array();
    let mut amps = [0.0f32; MAX_PARTIALS];
    for (k, a) in amps.iter_mut().enumerate() {
        if (k as f32 + 1.0) * freq < 0.45 * sample_rate {
            *a = if k == 0 { base[0] } else { base[k] * brightness * over_gain };
        }
    }
    let sum: f32 = amps.iter().sum();
    if sum > 0.0 {
        for a in amps.iter_mut() {
            *a /= sum;
        }
    }
    let peak = p.loudness.voice_gain * vel.powf(p.loudness.velocity_curve) * key_gain;
    (peak, amps)
}

fn configure(v: &mut Voice, sample_rate: f32, note: u8, velocity: u8, p: &Profile) {
    let (peak, amps) = voice_spectrum(note, velocity, sample_rate, p);
    let freq = 440.0 * 2.0_f32.powf((note as f32 - 69.0) / 12.0);
    let tau = (p.envelope.decay_middle_c_s
        * 2.0_f32.powf((60.0 - note as f32) / p.envelope.decay_doubling_semitones))
    .max(p.envelope.decay_min_s)
    .min(p.envelope.decay_max_s);
    v.note = note;
    v.phase_inc = freq / sample_rate;
    v.attack_inc = 1.0 / (p.envelope.attack_ms / 1000.0 * sample_rate);
    v.decay_coef = (-1.0 / (tau * sample_rate)).exp();
    v.release_coef = (-1.0 / (p.envelope.release_ms / 1000.0 * sample_rate)).exp();
    v.peak = peak;
    v.amps = amps;
    v.partials = amps.iter().rposition(|&a| a != 0.0).map_or(0, |i| i + 1);
}

impl SimplePiano {
    pub fn new(sample_rate: u32) -> Self {
        Self::with_profile(sample_rate, &Profile::default())
    }

    pub fn with_profile(sample_rate: u32, profile: &Profile) -> Self {
        Self {
            sample_rate: sample_rate as f32,
            voices: [Voice::default(); MAX_VOICES],
            sustain: false,
            counter: 0,
            profile: *profile,
            gain: profile.loudness.master_volume,
            gain_coef: 1.0 - (-1.0 / (0.01 * sample_rate as f32)).exp(),
        }
    }

    pub fn set_profile(&mut self, profile: &Profile) {
        self.profile = *profile;
    }

    pub fn profile(&self) -> &Profile {
        &self.profile
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
        let p = self.profile;
        if let Some(v) = self.voices.iter_mut().find(|v| v.active && v.note == note) {
            configure(v, sample_rate, note, velocity, &p);
            v.attacking = true;
            v.releasing = false;
            v.key_down = true;
            v.started = started;
            return;
        }
        let limit = self.profile.voices.max_voices.clamp(1, MAX_VOICES);
        let free = if self.active_voices() < limit {
            self.voices.iter().position(|v| !v.active)
        } else {
            None
        };
        let i = match free {
            Some(i) => i,
            None => self.steal_index(),
        };
        let v = &mut self.voices[i];
        configure(v, sample_rate, note, velocity, &p);
        v.phase = 0.0;
        v.level = 0.0;
        v.attacking = true;
        v.releasing = false;
        v.key_down = true;
        v.active = true;
        v.started = started;
    }

    fn steal_index(&self) -> usize {
        let any_releasing = self.voices.iter().any(|v| v.active && v.releasing);
        let candidates = self
            .voices
            .iter()
            .enumerate()
            .filter(|(_, v)| v.active && (v.releasing || !any_releasing));
        let found = match self.profile.voices.steal {
            StealPolicy::Quietest => candidates
                .min_by(|(_, a), (_, b)| a.level.total_cmp(&b.level).then(a.started.cmp(&b.started))),
            StealPolicy::Oldest => candidates.min_by_key(|(_, v)| v.started),
        };
        found.map(|(i, _)| i).unwrap_or(0)
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

    fn set_sustain(&mut self, on: bool) {
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
}

impl SoundEngine for SimplePiano {
    fn handle(&mut self, ev: &MidiEvent) {
        match *ev {
            MidiEvent::NoteOn { note, velocity: 0 } => self.note_off(note),
            MidiEvent::NoteOn { note, velocity } => self.note_on(note, velocity),
            MidiEvent::NoteOff { note } => self.note_off(note),
            MidiEvent::Sustain { on } => self.set_sustain(on),
            MidiEvent::Pedal {
                pedal: Pedal::Sustain,
                value,
            } => self.set_sustain(value >= 64),
            MidiEvent::Pedal { .. } => {}
        }
    }

    fn apply_profile(&mut self, profile: &Profile) {
        self.set_profile(profile);
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
                let mut prev = 0.0f32;
                let mut cur = s1;
                let mut wave = v.amps[0] * s1;
                for &a in v.amps.iter().take(v.partials).skip(1) {
                    let next = 2.0 * c * cur - prev;
                    prev = cur;
                    cur = next;
                    wave += a * cur;
                }
                *s += wave * v.level * v.peak;
                v.phase += v.phase_inc;
                if v.phase >= 1.0 {
                    v.phase -= 1.0;
                }
            }
        }
        let target = self.profile.loudness.master_volume;
        for s in out.iter_mut() {
            self.gain += (target - self.gain) * self.gain_coef;
            if (target - self.gain).abs() < 1e-6 {
                self.gain = target;
            }
            *s = limit(*s * self.gain, self.profile.limiter.knee, self.profile.limiter.ceiling);
        }
    }

    fn render_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
        let n = left.len().min(right.len());
        self.render(&mut left[..n]);
        right[..n].copy_from_slice(&left[..n]);
    }
}


#[cfg(test)]
mod tests {
    use super::*;

    fn peak(buf: &[f32]) -> f32 {
        buf.iter().fold(0.0f32, |m, s| m.max(s.abs()))
    }

    #[test]
    fn silence_without_notes() {
        let mut p = SimplePiano::new(48000);
        let mut buf = [1.0f32; 256];
        p.render(&mut buf);
        assert!(buf.iter().all(|&s| s == 0.0));
    }

    #[test]
    fn attack_is_quick_but_not_instant() {
        let mut p = SimplePiano::new(48000);
        p.handle(&MidiEvent::NoteOn { note: 69, velocity: 100 });
        let mut buf = [0.0f32; 4800];
        p.render(&mut buf);
        let max = peak(&buf);
        assert!(peak(&buf[..400]) >= 0.95 * max);
        assert!(peak(&buf[..24]) < 0.5 * max);
    }

    #[test]
    fn decays_naturally_while_held() {
        let mut p = SimplePiano::new(48000);
        p.handle(&MidiEvent::NoteOn { note: 60, velocity: 100 });
        let mut buf = [0.0f32; 4800];
        p.render(&mut buf);
        let a = peak(&buf);
        let mut long = vec![0.0f32; 96000];
        p.render(&mut long);
        let b = peak(&long[91200..]);
        assert!(b < 0.6 * a);
        assert!(b > 0.05 * a);
        assert_eq!(p.active_voices(), 1);
    }

    #[test]
    fn higher_notes_decay_faster() {
        let ratio = |note: u8| {
            let mut p = SimplePiano::new(48000);
            p.handle(&MidiEvent::NoteOn { note, velocity: 100 });
            let mut buf = vec![0.0f32; 48000];
            p.render(&mut buf);
            peak(&buf[43200..]) / peak(&buf[..4800])
        };
        let ratio_48 = ratio(48);
        let ratio_84 = ratio(84);
        assert!(ratio_84 < 0.8 * ratio_48);
    }

    #[test]
    fn release_fades_smoothly_to_silence() {
        let mut p = SimplePiano::new(48000);
        p.handle(&MidiEvent::NoteOn { note: 69, velocity: 100 });
        let mut buf = [0.0f32; 4800];
        p.render(&mut buf);
        let a = peak(&buf[4320..]);
        p.handle(&MidiEvent::NoteOff { note: 69 });
        let mut fade = [0.0f32; 240];
        p.render(&mut fade);
        assert!(peak(&fade) > 0.5 * a);
        let mut long = vec![0.0f32; 48000];
        p.render(&mut long);
        let mut tail = [1.0f32; 512];
        p.render(&mut tail);
        assert!(tail.iter().all(|&s| s == 0.0));
        assert_eq!(p.active_voices(), 0);
    }

    #[test]
    fn sustain_pedal_holds_after_key_up() {
        let mut p = SimplePiano::new(48000);
        p.handle(&MidiEvent::Sustain { on: true });
        p.handle(&MidiEvent::NoteOn { note: 69, velocity: 100 });
        let mut buf = [0.0f32; 4800];
        p.render(&mut buf);
        let a = peak(&buf);
        p.handle(&MidiEvent::NoteOff { note: 69 });
        let mut held = vec![0.0f32; 24000];
        p.render(&mut held);
        assert!(peak(&held[19200..]) > 0.3 * a);
        assert_eq!(p.active_voices(), 1);
        p.handle(&MidiEvent::Sustain { on: false });
        let mut long = vec![0.0f32; 48000];
        p.render(&mut long);
        let mut tail = [1.0f32; 512];
        p.render(&mut tail);
        assert!(tail.iter().all(|&s| s == 0.0));
        assert_eq!(p.active_voices(), 0);
    }

    #[test]
    fn pedal_values_follow_sustain_threshold() {
        let run = |down: MidiEvent, up: MidiEvent, extra: &[MidiEvent]| {
            let mut p = SimplePiano::new(48000);
            let mut l = Vec::new();
            let mut chunk = |p: &mut SimplePiano, n: usize| {
                let mut b = vec![0.0f32; n * 2];
                p.render(&mut b);
                l.extend_from_slice(&b);
            };
            p.handle(&down);
            p.handle(&MidiEvent::NoteOn { note: 60, velocity: 100 });
            for e in extra {
                p.handle(e);
            }
            chunk(&mut p, 9600);
            p.handle(&MidiEvent::NoteOff { note: 60 });
            chunk(&mut p, 14400);
            p.handle(&up);
            chunk(&mut p, 14400);
            l
        };
        let a = run(
            MidiEvent::Sustain { on: true },
            MidiEvent::Sustain { on: false },
            &[],
        );
        let b = run(
            MidiEvent::Pedal { pedal: Pedal::Sustain, value: 64 },
            MidiEvent::Pedal { pedal: Pedal::Sustain, value: 63 },
            &[
                MidiEvent::Pedal { pedal: Pedal::Soft, value: 127 },
                MidiEvent::Pedal { pedal: Pedal::Sostenuto, value: 127 },
            ],
        );
        assert_eq!(a, b);
    }

    #[test]
    fn pedal_up_keeps_held_keys_sounding() {
        let mut p = SimplePiano::new(48000);
        p.handle(&MidiEvent::Sustain { on: true });
        p.handle(&MidiEvent::NoteOn { note: 69, velocity: 100 });
        let mut buf = [0.0f32; 4800];
        p.render(&mut buf);
        let a = peak(&buf);
        p.handle(&MidiEvent::Sustain { on: false });
        let mut held = vec![0.0f32; 24000];
        p.render(&mut held);
        assert!(peak(&held[19200..]) > 0.3 * a);
        assert_eq!(p.active_voices(), 1);
    }

    #[test]
    fn velocity_scales_loudness() {
        let peak_for = |velocity: u8| {
            let mut p = SimplePiano::new(48000);
            p.handle(&MidiEvent::NoteOn { note: 69, velocity });
            let mut buf = [0.0f32; 2400];
            p.render(&mut buf);
            peak(&buf)
        };
        let p30 = peak_for(30);
        let p64 = peak_for(64);
        let p127 = peak_for(127);
        assert!(p30 < p64);
        assert!(p64 < p127);
        assert!(p30 > 0.0);
        assert!(p127 <= Profile::default().loudness.voice_gain + 1e-3);
    }

    #[test]
    fn polyphony_is_capped_and_steals_oldest() {
        let mut p = SimplePiano::new(48000);
        for n in 40u8..80 {
            p.handle(&MidiEvent::NoteOn { note: n, velocity: 100 });
        }
        assert_eq!(p.active_voices(), MAX_VOICES);
        assert!(p.is_sounding(79));
        assert!(p.is_sounding(48));
        assert!(!p.is_sounding(40));
        assert!(!p.is_sounding(47));
        let mut buf = [0.0f32; 1024];
        p.render(&mut buf);
    }

    #[test]
    fn many_loud_notes_never_exceed_unity() {
        let mut p = SimplePiano::new(48000);
        p.handle(&MidiEvent::Sustain { on: true });
        for n in 30u8..94 {
            p.handle(&MidiEvent::NoteOn { note: n, velocity: 127 });
        }
        for n in 30u8..94 {
            p.handle(&MidiEvent::NoteOff { note: n });
        }
        let mut overall = 0.0f32;
        let mut buf = [0.0f32; 256];
        for _ in 0..(2 * 48000 / 256) {
            p.render(&mut buf);
            for &s in buf.iter() {
                assert!(s.is_finite() && s.abs() <= 1.0);
                overall = overall.max(s.abs());
            }
        }
        assert!(overall > 0.5);
    }

    #[test]
    fn same_note_retrigger_reuses_voice() {
        let mut p = SimplePiano::new(48000);
        p.handle(&MidiEvent::NoteOn { note: 60, velocity: 100 });
        let mut buf = [0.0f32; 480];
        p.render(&mut buf);
        p.handle(&MidiEvent::NoteOn { note: 60, velocity: 100 });
        assert_eq!(p.active_voices(), 1);
    }

    #[test]
    fn soft_clip_is_bounded_and_transparent_below_knee() {
        assert_eq!(soft_clip(0.5), 0.5);
        assert_eq!(soft_clip(-0.8), -0.8);
        let hi = soft_clip(5.0);
        assert!(hi > 0.95 && hi <= 1.0);
        let lo = soft_clip(-5.0);
        assert!((-1.0..-0.95).contains(&lo));
        let mut prev = f32::NEG_INFINITY;
        for i in 0..=600 {
            let x = -3.0 + i as f32 * 0.01;
            let y = soft_clip(x);
            assert!(y >= prev);
            prev = y;
        }
    }

    fn sl990() -> Profile {
        crate::config::parse_profile(include_str!("../../profiles/sl990.ron")).unwrap()
    }

    fn note_freq(note: u8) -> f32 {
        440.0 * 2.0_f32.powf((note as f32 - 69.0) / 12.0)
    }

    #[test]
    fn limit_matches_soft_clip_for_defaults() {
        for i in 0..=600 {
            let x = -3.0 + i as f32 * 0.01;
            assert!((limit(x, 0.8, 1.0) - soft_clip(x)).abs() <= 1e-6, "x = {x}");
        }
    }

    #[test]
    fn limiter_ceiling_bounds_output() {
        let mut prof = Profile::default();
        prof.limiter.ceiling = 0.5;
        let mut p = SimplePiano::with_profile(48000, &prof);
        p.handle(&MidiEvent::Sustain { on: true });
        for n in 30u8..94 {
            p.handle(&MidiEvent::NoteOn { note: n, velocity: 127 });
        }
        let mut buf = [0.0f32; 256];
        for _ in 0..(48000 / 256) {
            p.render(&mut buf);
            for &s in buf.iter() {
                assert!(s.is_finite() && s.abs() <= 0.5 + 1e-6);
            }
        }
    }

    #[test]
    fn sl990_velocity_90_is_full_force() {
        let s = sl990();
        assert_eq!(voice_spectrum(69, 90, 48000.0, &s), voice_spectrum(69, 127, 48000.0, &s));
    }

    #[test]
    fn sl990_is_about_9_db_louder() {
        let (a, _) = voice_spectrum(69, 60, 48000.0, &sl990());
        let (b, _) = voice_spectrum(69, 60, 48000.0, &Profile::default());
        let ratio = a / b;
        assert!((2.75..=2.85).contains(&ratio), "{ratio}");
    }

    #[test]
    fn bass_compensation_makes_low_notes_more_audible() {
        let audible = |note: u8, p: &Profile| {
            let (peak, amps) = voice_spectrum(note, 100, 48000.0, p);
            let f = note_freq(note);
            let sum: f32 = amps
                .iter()
                .enumerate()
                .filter(|(k, _)| (*k as f32 + 1.0) * f > 200.0)
                .map(|(_, a)| *a)
                .sum();
            peak * sum
        };
        let s = sl990();
        let d = Profile::default();
        assert!(
            audible(36, &s) / audible(72, &s) >= 2.0 * audible(36, &d) / audible(72, &d)
        );
        let rms = |note: u8, p: &Profile| {
            let mut piano = SimplePiano::with_profile(48000, p);
            piano.handle(&MidiEvent::NoteOn { note, velocity: 100 });
            let mut buf = vec![0.0f32; 9600];
            piano.render(&mut buf);
            (buf.iter().map(|x| x * x).sum::<f32>() / buf.len() as f32).sqrt()
        };
        assert!(rms(36, &s) / rms(72, &s) > rms(36, &d) / rms(72, &d));
    }

    #[test]
    fn neutral_bass_is_exactly_unity() {
        let d = Profile::default();
        for note in [21u8, 100] {
            let (peak, _) = voice_spectrum(note, 100, 48000.0, &d);
            assert_eq!(peak, 0.3 * (100.0f32 / 127.0).powf(1.5));
        }
    }

    #[test]
    fn max_voices_limit_is_respected() {
        let mut prof = Profile::default();
        prof.voices.max_voices = 8;
        let mut p = SimplePiano::with_profile(48000, &prof);
        for n in 40u8..60 {
            p.handle(&MidiEvent::NoteOn { note: n, velocity: 100 });
        }
        assert_eq!(p.active_voices(), 8);
        assert!(p.is_sounding(59));
        assert!(!p.is_sounding(40));
    }

    #[test]
    fn oldest_vs_quietest_steal_policy() {
        let run = |steal: StealPolicy| {
            let mut prof = Profile::default();
            prof.voices.max_voices = 4;
            prof.voices.steal = steal;
            let mut p = SimplePiano::with_profile(48000, &prof);
            p.handle(&MidiEvent::NoteOn { note: 36, velocity: 100 });
            p.handle(&MidiEvent::NoteOn { note: 96, velocity: 100 });
            p.render(&mut vec![0.0f32; 48000]);
            p.handle(&MidiEvent::NoteOn { note: 64, velocity: 100 });
            p.render(&mut [0.0f32; 480]);
            p.handle(&MidiEvent::NoteOn { note: 65, velocity: 100 });
            p.render(&mut [0.0f32; 480]);
            p.handle(&MidiEvent::NoteOn { note: 67, velocity: 100 });
            p
        };
        let oldest = run(StealPolicy::Oldest);
        assert!(!oldest.is_sounding(36));
        assert!(oldest.is_sounding(96));
        assert_eq!(oldest.active_voices(), 4);
        let quietest = run(StealPolicy::Quietest);
        assert!(!quietest.is_sounding(96));
        assert!(quietest.is_sounding(36));
        assert_eq!(quietest.active_voices(), 4);
    }

    #[test]
    fn set_profile_affects_new_notes_only() {
        let mut loud = Profile::default();
        loud.loudness.voice_gain = 0.6;
        let on = MidiEvent::NoteOn { note: 69, velocity: 100 };
        let mut a = SimplePiano::new(48000);
        let mut b = SimplePiano::new(48000);
        a.handle(&on);
        b.handle(&on);
        b.set_profile(&loud);
        let mut ba = vec![0.0f32; 2400];
        let mut bb = vec![0.0f32; 2400];
        a.render(&mut ba);
        b.render(&mut bb);
        assert_eq!(ba, bb);
        let mut c = SimplePiano::new(48000);
        c.set_profile(&loud);
        c.handle(&on);
        let mut bc = vec![0.0f32; 2400];
        c.render(&mut bc);
        let ratio = peak(&bc) / peak(&ba);
        assert!((1.95..2.05).contains(&ratio), "{ratio}");
    }

    #[test]
    fn master_volume_ramps_smoothly() {
        let on = MidiEvent::NoteOn { note: 69, velocity: 100 };
        let mut a = SimplePiano::new(48000);
        let mut b = SimplePiano::new(48000);
        a.handle(&on);
        b.handle(&on);
        let mut buf = vec![0.0f32; 4800];
        a.render(&mut buf);
        b.render(&mut buf);
        let mut half = Profile::default();
        half.loudness.master_volume = 0.5;
        b.set_profile(&half);
        let mut ba = vec![0.0f32; 4800];
        let mut bb = vec![0.0f32; 4800];
        a.render(&mut ba);
        b.render(&mut bb);
        assert!((bb[0] - ba[0]).abs() <= 0.01);
        let ratio = peak(&bb[3600..]) / peak(&ba[3600..]);
        assert!((0.48..=0.52).contains(&ratio), "{ratio}");
    }

    #[test]
    fn stereo_channels_are_identical() {
        let on = MidiEvent::NoteOn { note: 60, velocity: 100 };
        let mut a = SimplePiano::new(48000);
        let mut b = SimplePiano::new(48000);
        a.handle(&on);
        b.handle(&on);
        let mut left = vec![0.0f32; 4800];
        let mut right = vec![0.0f32; 4800];
        a.render_stereo(&mut left, &mut right);
        let mut mono = vec![0.0f32; 4800];
        b.render(&mut mono);
        assert_eq!(left, right);
        assert!(peak(&left) > 0.0);
        assert_eq!(left, mono);
    }
}
