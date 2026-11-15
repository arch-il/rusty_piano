//! Nonlinear felt hammer striking a string.
//!
//! The hammer is a point mass with position `x` (positive toward the string) and velocity `v`. The felt is a
//! power-law spring: force `F = K * delta^p` while the compression `delta = x - y` is positive, where `y` is the
//! displacement of the string at the strike point. The state runs in f64 at `OVERSAMPLE` times the output rate.
//!
//! The string point is not taken from the modal bank. A modal feedback would close the loop with a one-sample
//! delay, which goes unstable on short, light treble strings. Instead the string is modelled by its
//! impedance: a force `F` launches waves in both directions on every string, so the point moves with
//! `dy/dt = F / Z` with `Z = 2 * count * impedance`. The near end returns an inverted reflection after
//! `reflection_delay_s`, so `y(t) = (I(t) - I(t - D)) / Z`, with `I` the cumulative impulse of the force.
//! A ring buffer of past `I` values, allocated once in `Hammer::new` for the longest valid delay (`MAX_DELAY_S`),
//! provides the delayed term without allocation. Reads from before the strike count as zero.
//!
//! A restrike ignores the string's current motion: the hammer always starts against a still string model.
//! Contact ends when the felt separates while the hammer moves away, or after 30 ms.

use super::profile::ModalProfile;
use super::strings::{geo_note, lerp_note, StringSet};

pub const OVERSAMPLE: usize = 8;
// Longest delay: strike position 0.5 on the lowest string. 22.0 Hz covers the lowest valid A0: a4_hz 400 (-165 cents),
// table cents -100 and stretch about -3 cents give about 23.4 Hz.
const MAX_DELAY_S: f64 = 0.5 / 22.0;
const MAX_CONTACT_S: f64 = 0.030;

/// Hammer strike speed in m/s for a MIDI velocity.
pub fn hammer_speed_mps(velocity: u8, p: &ModalProfile) -> f32 {
    let v = &p.velocity;
    let full = v.full_force_velocity as f32;
    let t = (velocity as f32).min(full) / full;
    v.hammer_speed_min_mps + (v.hammer_speed_max_mps - v.hammer_speed_min_mps) * t.powf(v.speed_curve)
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct HammerParams {
    pub mass_kg: f32,
    pub stiffness: f32,
    pub exponent: f32,
    pub impedance_total: f32,
    pub reflection_delay_s: f32,
}

pub fn hammer_params(note: u8, p: &ModalProfile, s: &StringSet) -> HammerParams {
    let h = &p.hammer;
    let mass_kg = geo_note(note, h.mass_bass_g, h.mass_treble_g) / 1000.0 * s.hammer_mass_scale;
    let exponent = lerp_note(note, h.exponent_bass, h.exponent_treble);
    let force_1mm = geo_note(note, h.force_1mm_bass_n, h.force_1mm_treble_n) * s.felt_scale;
    let stiffness = (force_1mm as f64 / 0.001f64.powf(exponent as f64)) as f32;
    HammerParams {
        mass_kg,
        stiffness,
        exponent,
        impedance_total: 2.0 * s.struck_strings * s.impedance,
        reflection_delay_s: 2.0 * s.strike_position * s.length_m / s.wave_speed,
    }
}

pub struct Hammer {
    x: f64,
    v: f64,
    impulse: f64,
    ring: Vec<f64>,
    head: usize,
    delay: usize,
    mass: f64,
    stiffness: f64,
    exponent: f64,
    impedance: f64,
    h: f64,
    max_substeps: usize,
    substeps: usize,
    touched: bool,
    contact: bool,
    initial_energy: f64,
}

impl Hammer {
    pub fn new(sample_rate: f32) -> Self {
        let len = (MAX_DELAY_S * sample_rate as f64 * OVERSAMPLE as f64).ceil() as usize + 2;
        Self {
            x: 0.0,
            v: 0.0,
            impulse: 0.0,
            ring: vec![0.0; len],
            head: 0,
            delay: 1,
            mass: 0.005,
            stiffness: 0.0,
            exponent: 2.0,
            impedance: 1.0,
            h: 1.0,
            max_substeps: 0,
            substeps: 0,
            touched: false,
            contact: false,
            initial_energy: 0.0,
        }
    }

    pub fn strike(&mut self, params: &HammerParams, speed_mps: f32, sample_rate: f32) {
        let sub_rate = sample_rate as f64 * OVERSAMPLE as f64;
        self.h = 1.0 / sub_rate;
        self.mass = params.mass_kg as f64;
        self.stiffness = params.stiffness as f64;
        self.exponent = params.exponent as f64;
        self.impedance = params.impedance_total as f64;
        self.delay = ((params.reflection_delay_s as f64 * sub_rate).round() as usize).max(1).min(self.ring.len() - 1); // clamp for extreme stiffness/stretch combinations below 22 Hz
        debug_assert!(self.delay < self.ring.len());
        self.x = 0.0;
        self.v = speed_mps as f64;
        self.impulse = 0.0;
        self.ring[0] = 0.0;
        self.head = 0;
        self.substeps = 0;
        self.max_substeps = (MAX_CONTACT_S * sub_rate).round() as usize;
        self.touched = false;
        self.contact = true;
        self.initial_energy = 0.5 * self.mass * self.v * self.v;
    }

    /// Mean force in newtons over the next output sample; 0.0 when not in contact.
    pub fn next_force(&mut self) -> f32 {
        if !self.contact {
            return 0.0;
        }
        let mut sum = 0.0;
        for _ in 0..OVERSAMPLE {
            if !self.contact {
                break;
            }
            let len = self.ring.len();
            let delayed = if self.substeps >= self.delay { self.ring[(self.head + len - self.delay) % len] } else { 0.0 };
            let y = (self.impulse - delayed) / self.impedance;
            let delta = self.x - y;
            let f = if delta > 0.0 { self.stiffness * delta.powf(self.exponent) } else { 0.0 };
            self.v -= f / self.mass * self.h;
            self.x += self.v * self.h;
            self.impulse += f * self.h;
            self.head = (self.head + 1) % len;
            self.ring[self.head] = self.impulse;
            sum += f;
            self.substeps += 1;
            if f > 0.0 {
                self.touched = true;
            } else if self.touched && self.v < 0.0 {
                self.contact = false;
            }
            if self.substeps >= self.max_substeps {
                self.contact = false;
            }
        }
        (sum / OVERSAMPLE as f64) as f32
    }

    pub fn delay_substeps(&self) -> usize {
        self.delay
    }

    pub fn in_contact(&self) -> bool {
        self.contact
    }

    pub fn kinetic_energy_j(&self) -> f64 {
        0.5 * self.mass * self.v * self.v
    }

    pub fn initial_energy_j(&self) -> f64 {
        self.initial_energy
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sound::modal_piano::strings::string_set;

    const SR: f32 = 48000.0;

    /// (contact time s, peak force N, all forces finite and >= 0, frames until contact ended)
    fn run(note: u8, velocity: u8) -> (f64, f32, bool, usize) {
        let p = ModalProfile::default();
        let s = string_set(note, &p, SR);
        let params = hammer_params(note, &p, &s);
        let mut h = Hammer::new(SR);
        h.strike(&params, hammer_speed_mps(velocity, &p), SR);
        let mut pos = 0usize;
        let mut peak = 0.0f32;
        let mut ok = true;
        let mut n = 0usize;
        while h.in_contact() && n < 5000 {
            let f = h.next_force();
            ok &= f.is_finite() && f >= 0.0;
            if f > 0.0 {
                pos += 1;
            }
            peak = peak.max(f);
            n += 1;
        }
        (pos as f64 / SR as f64, peak, ok, n)
    }

    fn contact_time_at(note: u8, velocity: u8, fs: f32) -> f64 {
        let p = ModalProfile::default();
        let s = string_set(note, &p, fs);
        let params = hammer_params(note, &p, &s);
        let mut h = Hammer::new(fs);
        h.strike(&params, hammer_speed_mps(velocity, &p), fs);
        let mut pos = 0usize;
        let mut n = 0usize;
        while h.in_contact() && n < 20000 {
            if h.next_force() > 0.0 {
                pos += 1;
            }
            n += 1;
        }
        pos as f64 / fs as f64
    }

    #[test]
    fn una_corda_lightens_hammer_load() {
        use crate::sound::modal_piano::strings::string_set_soft;
        let p = ModalProfile::default();
        let rel = |a: f32, b: f32| ((a - b) / b).abs();
        let s0 = string_set_soft(60, &p, SR, 0.0);
        let s1 = string_set_soft(60, &p, SR, 1.0);
        let h0 = hammer_params(60, &p, &s0);
        let h1 = hammer_params(60, &p, &s1);
        assert!(rel(h0.impedance_total, 6.0 * s0.impedance) < 1e-6);
        assert!(rel(h1.impedance_total, 4.0 * s1.impedance) < 1e-6);
        assert!(rel(h1.stiffness, (1.0 - p.pedals.una_corda_felt_softening) * h0.stiffness) < 1e-5, "{} vs {}", h1.stiffness, h0.stiffness);
    }

    #[test]
    fn contact_time_does_not_depend_on_sample_rate() {
        for note in [21u8, 30, 60] {
            let base = contact_time_at(note, 80, 48000.0);
            for fs in [96000.0f32, 192000.0] {
                let t = contact_time_at(note, 80, fs);
                println!("note {note} fs {fs}: {} ms (48k {} ms)", t * 1e3, base * 1e3);
                assert!((t - base).abs() <= 0.03 * base, "note {note} fs {fs}: {t} vs {base}");
            }
        }
    }

    #[test]
    fn long_reflection_delay_is_not_clamped() {
        let mut p = ModalProfile::default();
        p.strings.strike_position_bass = 0.5;
        let s = string_set(21, &p, SR);
        let params = hammer_params(21, &p, &s);
        let mut h = Hammer::new(SR);
        h.strike(&params, hammer_speed_mps(80, &p), SR);
        let expected = (params.reflection_delay_s as f64 * SR as f64 * OVERSAMPLE as f64).round() as usize;
        assert_eq!(h.delay_substeps(), expected);
    }

    #[test]
    fn force_is_never_negative() {
        for note in [21u8, 60, 108] {
            for vel in [1u8, 64, 127] {
                let (_, _, ok, _) = run(note, vel);
                assert!(ok, "note {note} vel {vel}");
            }
        }
    }

    #[test]
    fn contact_time_is_plausible() {
        let (c4, peak, _, _) = run(60, 64);
        println!("C4 v64: contact {} ms, peak {} N", c4 * 1e3, peak);
        assert!(c4 > 0.0005 && c4 < 0.005, "C4 contact {c4}");
        let (low, plow, _, _) = run(21, 64);
        let (high, phigh, _, _) = run(96, 64);
        println!("note 21: {} ms, {} N; note 96: {} ms, {} N", low * 1e3, plow, high * 1e3, phigh);
        assert!(low > high, "{low} vs {high}");
    }

    #[test]
    fn harder_hits_are_shorter_and_stronger() {
        let a = run(60, 20);
        let b = run(60, 64);
        let c = run(60, 127);
        println!("C4 v20 {:?} v64 {:?} v127 {:?}", (a.0, a.1), (b.0, b.1), (c.0, c.1));
        assert!(a.1 < b.1 && b.1 < c.1);
        assert!(c.0 < a.0);
        assert!(b.0 <= a.0 && c.0 <= b.0);
    }

    #[test]
    fn hammer_loses_energy() {
        let p = ModalProfile::default();
        for note in [21u8, 40, 60, 84, 108] {
            for vel in [10u8, 64, 127] {
                let s = string_set(note, &p, SR);
                let params = hammer_params(note, &p, &s);
                let mut h = Hammer::new(SR);
                h.strike(&params, hammer_speed_mps(vel, &p), SR);
                let mut n = 0;
                while h.in_contact() && n < 5000 {
                    h.next_force();
                    n += 1;
                }
                assert!(!h.in_contact());
                assert!(n as f64 / SR as f64 <= 0.020, "note {note} vel {vel}: {n} frames");
                assert!(h.kinetic_energy_j() <= h.initial_energy_j() + 1e-9, "note {note} vel {vel}");
            }
        }
    }

    #[test]
    fn all_keys_and_velocities_are_finite() {
        for note in 21..=108u8 {
            for vel in [1u8, 32, 64, 96, 127] {
                let (_, _, ok, n) = run(note, vel);
                assert!(ok, "note {note} vel {vel}");
                assert!(n as f64 / SR as f64 <= 0.030, "note {note} vel {vel}: {n} frames");
            }
        }
    }

    #[test]
    fn speed_follows_velocity_curve() {
        let p = ModalProfile::default();
        let full = p.velocity.full_force_velocity;
        assert!((hammer_speed_mps(full, &p) - p.velocity.hammer_speed_max_mps).abs() < 1e-6);
        for v in 1..full {
            assert!(hammer_speed_mps(v, &p) < hammer_speed_mps(v + 1, &p), "v {v}");
        }
        assert_eq!(hammer_speed_mps(127, &p), hammer_speed_mps(full, &p));
        assert!(hammer_speed_mps(1, &p) >= p.velocity.hammer_speed_min_mps);
    }
}
