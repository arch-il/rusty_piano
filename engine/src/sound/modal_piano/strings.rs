//! Modal piano strings: pure maths (pitch, stiffness, string data, decay times) and the mode bank that runs the resonators.
//!
//! Physics source: approximate published grand-piano data (Conklin 1996, Chaigne & Askenfelt 1994, Fletcher & Rossing, Bank 2000).
//! Each string is a set of damped modes (two-pole resonators) with stretched partial frequencies.

use super::profile::ModalProfile;
pub use super::profile::MAX_MODES;
use std::f64::consts::PI;

pub const MAX_STRINGS: usize = 3;
pub const LANES: usize = 8;

const LN1000: f64 = 6.9078;
const SUB_BLOCK: usize = 64;

/// Frequency of a MIDI note in hertz (A4 = note 69 = 440 Hz, equal temperament).
pub fn note_hz(note: u8) -> f32 {
    (440.0 * ((note as f64 - 69.0) / 12.0).exp2()) as f32
}

fn note_t(note: u8) -> f64 {
    ((note as f64 - 21.0) / 87.0).clamp(0.0, 1.0)
}

/// Linear blend from `bass` (note 21) to `treble` (note 108), clamped outside.
pub fn lerp_note(note: u8, bass: f32, treble: f32) -> f32 {
    let t = note_t(note);
    (bass as f64 + (treble as f64 - bass as f64) * t) as f32
}

/// Geometric blend from `bass` (note 21) to `treble` (note 108), clamped outside.
pub fn geo_note(note: u8, bass: f32, treble: f32) -> f32 {
    let t = note_t(note);
    (bass as f64 * (treble as f64 / bass as f64).powf(t)) as f32
}

/// Stiffness inharmonicity B of a note, clamped to 0..0.05.
pub fn inharmonicity(note: u8, p: &ModalProfile) -> f32 {
    let s = &p.strings;
    let b0 = s.inharmonicity_middle_c as f64;
    let b = if note >= 60 {
        b0 * (s.inharmonicity_treble_octave_factor as f64).powf((note as f64 - 60.0) / 12.0)
    } else {
        b0 * (s.inharmonicity_bass_octave_factor as f64).powf((60.0 - note as f64) / 12.0)
    };
    (b * p.notes.at(note).inharmonicity as f64).clamp(0.0, 0.05) as f32
}

fn partial_hz_f64(n: usize, f0: f64, b: f64) -> f64 {
    let n = n as f64;
    n * f0 * ((1.0 + b * n * n) / (1.0 + b)).sqrt()
}

/// Stretch of a note in cents relative to equal temperament: octaves match the second partial of the lower note, A4 is fixed.
pub fn stretch_cents(note: u8, p: &ModalProfile) -> f64 {
    let k = p.tuning.stretch as f64;
    if k == 0.0 {
        return 0.0;
    }
    let o = |u: i32| {
        let b = inharmonicity((u - 12) as u8, p) as f64;
        600.0 * ((1.0 + 4.0 * b) / (1.0 + b)).log2()
    };
    let mut n = note as i32;
    let mut s = 0.0;
    while n > 69 {
        s += k * o(n);
        n -= 12;
    }
    while n < 57 {
        s -= k * o(n + 12);
        n += 12;
    }
    s - k * o(69) * (69 - n) as f64 / 12.0
}

/// Tuned fundamental of a note in hertz: A4 at tuning.a4_hz plus the octave stretch.
pub fn tuned_hz(note: u8, p: &ModalProfile) -> f64 {
    let adj = p.notes.at(note);
    p.tuning.a4_hz as f64 * ((note as f64 - 69.0) / 12.0 + (stretch_cents(note, p) + adj.cents as f64) / 1200.0).exp2()
}

/// Frequency of partial n (1 = fundamental) of a stiff string.
pub fn partial_hz(n: usize, f0: f32, b: f32) -> f32 {
    partial_hz_f64(n, f0 as f64, b as f64) as f32
}

fn partial_t60_f64(f_hz: f64, f1_hz: f64, t60_1_s: f64, damping_per_khz2: f64) -> f64 {
    let s1 = LN1000 / t60_1_s;
    let k = f_hz / 1000.0;
    let k1 = f1_hz / 1000.0;
    let sigma = s1.max(s1 + damping_per_khz2 * (k * k - k1 * k1));
    LN1000 / sigma
}

/// Decay time (to -60 dB) of the partial at `f_hz`, given the fundamental's decay time and the extra loss per kHz squared.
pub fn partial_t60_s(f_hz: f32, f1_hz: f32, t60_1_s: f32, damping_per_khz2: f32) -> f32 {
    partial_t60_f64(f_hz as f64, f1_hz as f64, t60_1_s as f64, damping_per_khz2 as f64) as f32
}

fn jitter(note: u8, s: usize) -> f32 {
    ((((note as u32).wrapping_mul(2654435761) ^ (s as u32 + 1).wrapping_mul(40503)) >> 8) & 0xFFFF) as f32 / 32767.5 - 1.0
}

/// Everything about the strings of one key.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct StringSet {
    pub count: usize,
    pub f0_hz: f32,
    pub inharmonicity: f32,
    pub length_m: f32,
    pub tension_n: f32,
    pub linear_density: f32,
    /// One string, sqrt(T mu), kg/s.
    pub impedance: f32,
    pub wave_speed: f32,
    pub strike_position: f32,
    pub detune_cents: [f32; 3],
    pub decay_scale: [f32; 3],
    pub t60_fundamental_s: f32,
    pub damping_per_khz2: f32,
    pub damper_t60_s: Option<f32>,
    /// dB of damping after which the damper weakens to the tail rate; 0.0 = single damper.
    pub damper_tail_db: f32,
    /// Damper T60 of the residual stage, seconds (the per-note damper multiplier applied).
    pub damper_tail_t60_s: f32,
    pub partials_per_string: usize,
    pub max_hz: f32,
    /// Partials per string coupled two-way to the board (0 = one-way board).
    pub coupled_partials: usize,
    pub coupled_max_hz: f32,
    /// Share of the table loss of a coupled partial the bridge may take, with the note's aftersound value applied, 0 - 0.95.
    pub coupling_loss_fraction: f32,
    /// Hammer drive of string st relative to an equal share, including the level trim (1.0 = no change).
    pub strike_gain: [f32; 3],
    /// Sum of the strike weights of the strings (the count at no soft pedal).
    pub struck_strings: f32,
    /// Multiplier of the felt force at 1 mm.
    pub felt_scale: f32,
    /// Multiplier of the hammer mass.
    pub hammer_mass_scale: f32,
    /// Extra decay of the prompt part in dB per second; 0.0 = no prompt part.
    pub prompt_db_per_s: f32,
    /// Level of the aftersound part relative to the start in dB, -60..0; 0.0 = single decay.
    pub after_level_db: f32,
}

impl StringSet {
    /// True if partial n (frequency f) runs in the coupled bank instead of the ModeBank.
    pub fn is_coupled(&self, n: usize, f: f64) -> bool {
        n <= self.coupled_partials && f < self.coupled_max_hz as f64
    }
}

/// Per-mode coefficients shared by ModeBank and the coupled bank.
#[derive(Debug, Clone, Copy)]
pub(crate) struct ModeCoefs {
    pub a1: f64,
    pub a2: f64,
    pub b: f64,
    pub w: f64,
    pub r: f64,
    pub theta: f64,
}

pub(crate) fn mode_coefs(s: &StringSet, st: usize, n: usize, f: f64, dt: f64) -> ModeCoefs {
    let t60 = partial_t60_f64(f, s.f0_hz as f64, s.t60_fundamental_s as f64, s.damping_per_khz2 as f64);
    let sigma = LN1000 / t60 * s.decay_scale[st] as f64;
    mode_coefs_sigma(s, st, n, f, dt, sigma)
}

/// Like `mode_coefs`, with the decay rate sigma (1/s) given instead of taken from the decay table.
pub(crate) fn mode_coefs_sigma(s: &StringSet, st: usize, n: usize, f: f64, dt: f64, sigma: f64) -> ModeCoefs {
    let strike_gain = s.strike_gain[st] as f64;
    let length = s.length_m as f64;
    let mu = s.linear_density as f64;
    let beta = s.strike_position as f64;
    let theta = 2.0 * PI * f * dt;
    let r = (-sigma * dt).exp();
    let (a1, a2) = (2.0 * r * theta.cos(), -r * r);
    let b = (2.0 / (mu * length)) * (n as f64 * PI * beta).sin() * dt * r * theta.sin() / (2.0 * PI * f) / s.count as f64 * strike_gain;
    let w = s.tension_n as f64 * n as f64 * PI / length;
    ModeCoefs { a1, a2, b, w, r, theta }
}

/// Frequency of partial n of string st (detuned).
pub(crate) fn string_partial_hz(s: &StringSet, st: usize, n: usize) -> f64 {
    let f0 = s.f0_hz as f64 * (s.detune_cents[st] as f64 / 1200.0).exp2();
    partial_hz_f64(n, f0, s.inharmonicity as f64)
}

pub fn string_set(note: u8, p: &ModalProfile, sample_rate: f32) -> StringSet {
    string_set_soft(note, p, sample_rate, 0.0)
}

/// Like `string_set`, with the soft pedal (una corda) shifted by `shift` (0 = up, 1 = fully down).
pub fn string_set_soft(note: u8, p: &ModalProfile, sample_rate: f32, shift: f32) -> StringSet {
    let shift = shift.clamp(0.0, 1.0);
    let s = &p.strings;
    let d = &p.decay;
    let adj = p.notes.at(note);
    let count = if note < s.two_strings_from_note {
        1
    } else if note < s.three_strings_from_note {
        2
    } else {
        3
    };
    let f0 = tuned_hz(note, p);
    let e =if note >= 60 { s.length_treble_exponent } else { s.length_bass_exponent } as f64;
    let length = (s.length_middle_c_m as f64 * (-(note as f64 - 60.0) / 12.0 * e).exp2())
        .clamp(s.length_min_m as f64, s.length_max_m as f64);
    let tension = s.tension_n as f64;
    let mu = tension / (4.0 * length * length * f0 * f0);

    let base: [f32; 3] = match count {
        1 => [0.0, 0.0, 0.0],
        2 => [-0.5, 0.5, 0.0],
        _ => [-1.0, 0.0, 1.0],
    };
    let mut detune_cents = [0.0f32; 3];
    for (i, c) in detune_cents.iter_mut().enumerate().take(count) {
        *c = base[i] * s.unison_detune_cents * adj.detune * (1.0 + 0.3 * jitter(note, i));
    }
    let sp = (s.unison_decay_spread * adj.decay_spread).min(0.9);
    let decay_scale = match count {
        1 => [1.0, 1.0, 1.0],
        2 => [1.0 - sp, 1.0 + sp, 1.0],
        _ => [1.0 - sp, 1.0, 1.0 + sp],
    };
    let t60 = (d.t60_middle_c_s as f64 * (-(note as f64 - 60.0) / d.t60_halving_semitones as f64).exp2())
        .clamp(d.t60_min_s as f64, d.t60_max_s as f64)
        * adj.t60 as f64;
    let damper = if note >= d.undamped_from_note {
        None
    } else {
        Some(geo_note(note, d.damper_t60_bass_s, d.damper_t60_treble_s) * adj.damper)
    };
    let trim = 10f32.powf(adj.level_db / 20.0);
    let pd = &p.pedals;
    let w: [f32; 3] = match count {
        1 => [1.0, 0.0, 0.0],
        2 => [1.0, 1.0 - shift * (1.0 - pd.una_corda_two_string), 0.0],
        _ => [1.0, 1.0, 1.0 - shift * (1.0 - pd.una_corda_third_string)],
    };
    let sum_w = w[0] + w[1] + w[2];
    let mut strike_gain = [trim; 3];
    for st in 0..count {
        strike_gain[st] = trim * (w[st] * count as f32 / sum_w);
    }
    let partials_per_string = s.max_partials.min(MAX_MODES / count);
    let max_hz = s.max_mode_hz.min(0.45 * sample_rate);
    StringSet {
        count,
        f0_hz: f0 as f32,
        inharmonicity: inharmonicity(note, p),
        length_m: length as f32,
        tension_n: tension as f32,
        linear_density: mu as f32,
        impedance: (tension * mu).sqrt() as f32,
        wave_speed: (2.0 * length * f0) as f32,
        strike_position: (lerp_note(note, s.strike_position_bass, s.strike_position_treble) * adj.strike).clamp(0.02, 0.5),
        detune_cents,
        decay_scale,
        t60_fundamental_s: t60 as f32,
        damping_per_khz2: d.damping_per_khz2 * adj.damping,
        damper_t60_s: damper,
        damper_tail_db: d.damper_tail_db,
        damper_tail_t60_s: geo_note(note, d.damper_tail_t60_bass_s, d.damper_tail_t60_treble_s) * adj.damper * adj.damper_tail,
        partials_per_string,
        max_hz,
        coupled_partials: if p.soundboard.coupling > 0.0 { p.soundboard.coupled_partials.min(partials_per_string) } else { 0 },
        coupled_max_hz: p.soundboard.coupled_max_hz.min(max_hz),
        coupling_loss_fraction: (1.0 - (1.0 - p.soundboard.coupling_loss_fraction) * adj.aftersound).clamp(0.0, 0.95),
        strike_gain,
        struck_strings: sum_w,
        felt_scale: adj.hardness * (1.0 - pd.una_corda_felt_softening * shift),
        hammer_mass_scale: adj.hammer_mass,
        prompt_db_per_s: adj.prompt_db_per_s,
        after_level_db: adj.after_level_db,
    }
}

/// Two-stage envelope g(t) = (1 - m) e^(-sigma t) + m on top of the mode decay.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct TwoStage {
    pub m: f64,
    pub sigma: f64,
}

impl TwoStage {
    pub fn from_set(s: &StringSet) -> TwoStage {
        TwoStage {
            m: 10f64.powf(s.after_level_db as f64 / 20.0).clamp(0.0, 1.0),
            sigma: (s.prompt_db_per_s as f64).max(0.0) * std::f64::consts::LN_10 / 20.0,
        }
    }

    pub fn is_on(&self) -> bool {
        self.m < 1.0 - 1e-9 && self.sigma > 0.0
    }

    pub fn g(&self, t: f64) -> f64 {
        (1.0 - self.m) * (-self.sigma * t).exp() + self.m
    }

    /// Natural log of the amplitude factor per sample over the next `frames` samples from time t (<= 0).
    pub fn segment_ln(&self, t: f64, frames: usize, dt: f64) -> f64 {
        if !self.is_on() || frames == 0 || (1.0 - self.m) * (-self.sigma * t).exp() < 1e-4 * self.m {
            return 0.0;
        }
        (self.g(t + frames as f64 * dt).ln() - self.g(t).ln()) / frames as f64
    }
}

/// All modes of one voice, struct-of-arrays so `process` vectorises. Unused tail slots are all zero.
pub struct ModeBank {
    a1: [f32; MAX_MODES],
    a2: [f32; MAX_MODES],
    a1_damped: [f32; MAX_MODES],
    a2_damped: [f32; MAX_MODES],
    b: [f32; MAX_MODES],
    y1: [f32; MAX_MODES],
    y2: [f32; MAX_MODES],
    w: [f32; MAX_MODES],
    freq: [f32; MAX_MODES],
    partial: [f32; MAX_MODES],
    len: usize,
    damped: bool,
    ln_lam: f64,
    damping: f32,
    extra_ln: f64,
    ln_lam_fast: f64,
    ln_lam_tail: f64,
    tail_after: u64,
    tail_count: u64,
    in_tail: bool,
}

impl Default for ModeBank {
    fn default() -> Self {
        Self::new()
    }
}

impl ModeBank {
    pub fn new() -> Self {
        Self {
            a1: [0.0; MAX_MODES],
            a2: [0.0; MAX_MODES],
            a1_damped: [0.0; MAX_MODES],
            a2_damped: [0.0; MAX_MODES],
            b: [0.0; MAX_MODES],
            y1: [0.0; MAX_MODES],
            y2: [0.0; MAX_MODES],
            w: [0.0; MAX_MODES],
            freq: [0.0; MAX_MODES],
            partial: [0.0; MAX_MODES],
            len: 0,
            damped: false,
            ln_lam: 0.0,
            damping: 0.0,
            extra_ln: 0.0,
            ln_lam_fast: 0.0,
            ln_lam_tail: 0.0,
            tail_after: 0,
            tail_count: 0,
            in_tail: false,
        }
    }

    /// Builds the modes of all strings (string 0 first). State is kept only if `keep_state` is true and the mode count is unchanged.
    pub fn setup(&mut self, s: &StringSet, sample_rate: f32, keep_state: bool) {
        let dt = 1.0 / sample_rate as f64;
        let max_hz = s.max_hz as f64;
        let mut k = 0usize;
        // The (-1)^n sign of the bridge-force weight is intentionally left out (it only changes waveform phase, not the spectrum).
        // Coefficients are computed in f64 and cast once. In f32, A0 can still be off by up to about 8 cents; this is accepted.
        // Modes coupled two-way to the board run in the coupled bank instead.
        for st in 0..s.count {
            for n in 1..=s.partials_per_string {
                let f = string_partial_hz(s, st, n);
                if f >= max_hz || k >= MAX_MODES {
                    break;
                }
                if s.is_coupled(n, f) {
                    continue;
                }
                let c = mode_coefs(s, st, n, f, dt);
                self.a1[k] = c.a1 as f32;
                self.a2[k] = c.a2 as f32;
                self.b[k] = c.b as f32;
                self.w[k] = c.w as f32;
                self.freq[k] = f as f32;
                self.partial[k] = n as f32;
                k += 1;
            }
        }
        for i in k..MAX_MODES {
            self.a1[i] = 0.0;
            self.a2[i] = 0.0;
            self.a1_damped[i] = 0.0;
            self.a2_damped[i] = 0.0;
            self.b[i] = 0.0;
            self.w[i] = 0.0;
            self.freq[i] = 0.0;
            self.partial[i] = 0.0;
            self.y1[i] = 0.0;
            self.y2[i] = 0.0;
        }
        if !(keep_state && k == self.len) {
            self.y1 = [0.0; MAX_MODES];
            self.y2 = [0.0; MAX_MODES];
        }
        self.len = k;
        self.ln_lam = match s.damper_t60_s {
            Some(td) => -LN1000 / td as f64 * dt,
            None => 0.0,
        };
        self.ln_lam_fast = self.ln_lam;
        self.in_tail = false;
        self.tail_count = 0;
        self.tail_after = 0;
        if let Some(td) = s.damper_t60_s {
            if s.damper_tail_db > 0.0 {
                self.ln_lam_tail = -LN1000 / s.damper_tail_t60_s as f64 * dt;
                self.tail_after = ((td as f64 * s.damper_tail_db as f64 / 60.0 / dt).round() as u64).max(1);
            }
        }
        self.apply_damping();
    }

    /// Counts samples of a damping episode and switches the damper to the tail rate once, after the fast stage.
    fn tail_tick(&mut self, frames: usize) {
        if self.tail_after == 0 || self.in_tail || self.damping <= 0.0 {
            return;
        }
        self.tail_count += frames as u64;
        if self.tail_count >= self.tail_after {
            self.in_tail = true;
            self.ln_lam = self.ln_lam_tail;
            self.apply_damping();
        }
    }

    pub fn len(&self) -> usize {
        self.len
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    pub fn mode_hz(&self, i: usize) -> f32 {
        self.freq[i]
    }

    pub fn mode_partial(&self, i: usize) -> usize {
        self.partial[i] as usize
    }

    /// Input gain of mode i (the b value).
    pub fn input_gain(&self, i: usize) -> f32 {
        self.b[i]
    }

    /// Chooses the damped (key up, damper on the string) or the free coefficient pair.
    pub fn set_damped(&mut self, damped: bool) {
        self.set_damping(if damped { 1.0 } else { 0.0 });
    }

    /// Damper pressure: 0 = free string, 1 = full damper. Adds amount * ln(1000) / damper T60 to every mode's decay rate.
    pub fn set_damping(&mut self, amount: f32) {
        let amount = amount.clamp(0.0, 1.0);
        if amount == self.damping {
            return;
        }
        if self.tail_after != 0 && (amount == 0.0 || self.damping == 0.0) {
            self.tail_count = 0;
            if self.in_tail {
                self.in_tail = false;
                self.ln_lam = self.ln_lam_fast;
            }
        }
        self.damping = amount;
        self.apply_damping();
    }

    /// Extra time-varying decay of every mode, natural log of the amplitude factor per sample (<= 0).
    pub fn set_extra_decay(&mut self, ln_per_sample: f64) {
        let x = ln_per_sample.min(0.0);
        if x == self.extra_ln {
            return;
        }
        self.extra_ln = x;
        self.apply_damping();
    }

    fn apply_damping(&mut self) {
        let lam = (self.damping as f64 * self.ln_lam + self.extra_ln).exp();
        if lam >= 1.0 {
            self.damped = false;
        } else {
            self.damped = true;
            for i in 0..self.len {
                self.a1_damped[i] = (lam * self.a1[i] as f64) as f32;
                self.a2_damped[i] = (lam * lam * self.a2[i] as f64) as f32;
            }
        }
    }

    /// Adds the raw bridge force (newtons) of all modes into out for force.len() frames.
    pub fn process(&mut self, force: &[f32], out: &mut [f32]) {
        let total = force.len().min(out.len());
        self.tail_tick(total);
        let chunks = self.len.div_ceil(LANES);
        let mut start = 0;
        while start < total {
            let n = (total - start).min(SUB_BLOCK);
            let f = &force[start..start + n];
            let mut tmp = [0.0f32; SUB_BLOCK];
            for c in 0..chunks {
                let base = c * LANES;
                let mut a1 = [0.0f32; LANES];
                let mut a2 = [0.0f32; LANES];
                let mut b = [0.0f32; LANES];
                let mut y1 = [0.0f32; LANES];
                let mut y2 = [0.0f32; LANES];
                let mut w = [0.0f32; LANES];
                let (src1, src2) = if self.damped {
                    (&self.a1_damped, &self.a2_damped)
                } else {
                    (&self.a1, &self.a2)
                };
                a1.copy_from_slice(&src1[base..base + LANES]);
                a2.copy_from_slice(&src2[base..base + LANES]);
                b.copy_from_slice(&self.b[base..base + LANES]);
                y1.copy_from_slice(&self.y1[base..base + LANES]);
                y2.copy_from_slice(&self.y2[base..base + LANES]);
                w.copy_from_slice(&self.w[base..base + LANES]);
                for t in 0..n {
                    let ft = f[t];
                    let mut acc = [0.0f32; LANES];
                    for l in 0..LANES {
                        let y = a1[l] * y1[l] + a2[l] * y2[l] + b[l] * ft;
                        y2[l] = y1[l];
                        y1[l] = y;
                        acc[l] = w[l] * y;
                    }
                    tmp[t] += acc.iter().sum::<f32>();
                }
                self.y1[base..base + LANES].copy_from_slice(&y1);
                self.y2[base..base + LANES].copy_from_slice(&y2);
            }
            for t in 0..n {
                out[start + t] += tmp[t];
            }
            start += n;
        }
    }

    /// Sets tiny states to zero so they cannot become denormal numbers.
    pub fn flush_tiny(&mut self) {
        for i in 0..self.len {
            if self.y1[i].abs() + self.y2[i].abs() < 1e-15 {
                self.y1[i] = 0.0;
                self.y2[i] = 0.0;
            }
        }
    }

    pub fn clear(&mut self) {
        self.y1 = [0.0; MAX_MODES];
        self.y2 = [0.0; MAX_MODES];
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bank_for(note: u8, p: &ModalProfile, rate: f32) -> (StringSet, ModeBank) {
        let mut s = string_set(note, p, rate);
        s.coupled_partials = 0;
        let mut bank = ModeBank::new();
        bank.setup(&s, rate, false);
        (s, bank)
    }

    #[test]
    fn octaves_match_second_partial() {
        let p = ModalProfile::default();
        for n in 21..=96u8 {
            let s = string_set(n, &p, 48000.0);
            let u = string_set(n + 12, &p, 48000.0);
            let c = 1200.0 * (partial_hz_f64(2, s.f0_hz as f64, s.inharmonicity as f64) / u.f0_hz as f64).log2();
            assert!(c.abs() < 0.01, "note {n}: {c} cents");
        }
    }

    fn table_profile(a: &[super::super::tables::NoteAnchor]) -> ModalProfile {
        ModalProfile {
            notes: super::super::tables::NoteTable::from_anchors(a).unwrap(),
            ..Default::default()
        }
    }

    #[test]
    fn neutral_anchors_change_nothing() {
        use super::super::hammer::hammer_params;
        use super::super::tables::NoteAnchor;
        let base = ModalProfile::default();
        let p = table_profile(&[NoteAnchor::neutral(21), NoteAnchor::neutral(60), NoteAnchor::neutral(108)]);
        for n in 21..=108u8 {
            let (a, b) = (string_set(n, &base, 48000.0), string_set(n, &p, 48000.0));
            assert_eq!(a, b, "note {n}");
            assert_eq!(hammer_params(n, &base, &a), hammer_params(n, &p, &b), "note {n}");
        }
    }

    #[test]
    fn table_values_reach_string_and_hammer() {
        use super::super::hammer::hammer_params;
        use super::super::tables::NoteAnchor;
        let base = ModalProfile::default();
        let anchor = NoteAnchor {
            note: 60,
            cents: 10.0,
            level_db: 6.0,
            t60: 2.0,
            damping: 0.5,
            inharmonicity: 2.0,
            hardness: 2.0,
            hammer_mass: 0.5,
            strike: 0.5,
            detune: 0.0,
            damper: 2.0,
            aftersound: 1.0,
            prompt_db_per_s: 0.0,
            after_level_db: 0.0,
            decay_spread: 1.0,
            damper_tail: 1.0,
            direct_db: 0.0,
        };
        let p = table_profile(&[anchor]);
        let close = |a: f32, b: f32| ((a - b) / b).abs() < 1e-5;
        for n in [40u8, 70] {
            let (a, b) = (string_set(n, &base, 48000.0), string_set(n, &p, 48000.0));
            assert!(b.t60_fundamental_s > 1.2 * a.t60_fundamental_s, "note {n}");
            assert!(b.damping_per_khz2 < 0.8 * a.damping_per_khz2, "note {n}");
            assert!(close(b.inharmonicity, (2.0 * a.inharmonicity).min(0.05)), "note {n}");
            assert!(close(b.strike_position, (0.5 * a.strike_position).max(0.02)), "note {n}");
            assert!(b.detune_cents.iter().all(|&c| c == 0.0), "note {n}");
            assert!(close(b.damper_t60_s.unwrap(), 2.0 * a.damper_t60_s.unwrap()), "note {n}");
            let pc = table_profile(&[NoteAnchor { cents: 10.0, ..NoteAnchor::neutral(60) }]);
            let ratio = string_set(n, &pc, 48000.0).f0_hz as f64 / a.f0_hz as f64;
            assert!((ratio / (10.0f64 / 1200.0).exp2() - 1.0).abs() < 1e-6, "note {n}: {ratio}");
            assert!((b.strike_gain[0] - 10f32.powf(6.0 / 20.0)).abs() < 1e-6, "note {n}");
            let (ha, hb) = (hammer_params(n, &base, &a), hammer_params(n, &p, &b));
            assert!(close(hb.stiffness, 2.0 * ha.stiffness), "note {n}");
            assert!(close(hb.mass_kg, 0.5 * ha.mass_kg), "note {n}");
        }
    }

    #[test]
    fn aftersound_scales_intrinsic_share() {
        use super::super::tables::NoteAnchor;
        let p = ModalProfile::default();
        assert!((string_set(60, &p, 48000.0).coupling_loss_fraction - 0.67).abs() < 1e-6);
        let p = table_profile(&[NoteAnchor { aftersound: 0.5, ..NoteAnchor::neutral(60) }]);
        assert!((string_set(60, &p, 48000.0).coupling_loss_fraction - 0.835).abs() < 1e-5);
        let p = table_profile(&[NoteAnchor { aftersound: 4.0, ..NoteAnchor::neutral(60) }]);
        assert_eq!(string_set(60, &p, 48000.0).coupling_loss_fraction, 0.0);
        let mut p = table_profile(&[NoteAnchor { aftersound: 0.2, ..NoteAnchor::neutral(60) }]);
        p.soundboard.coupling_loss_fraction = 0.95;
        assert_eq!(string_set(60, &p, 48000.0).coupling_loss_fraction, 0.95);
    }

    #[test]
    fn una_corda_shares_by_register() {
        let p = ModalProfile::default();
        let near = |a: &[f32], b: &[f32]| a.iter().zip(b).all(|(x, y)| (x - y).abs() < 1e-6);
        let s = string_set_soft(60, &p, 48000.0, 1.0);
        assert!(near(&s.strike_gain, &[1.5, 1.5, 0.0]), "{:?}", s.strike_gain);
        assert!((s.struck_strings - 2.0).abs() < 1e-6);
        let want = string_set_soft(60, &p, 48000.0, 0.0).felt_scale * (1.0 - p.pedals.una_corda_felt_softening);
        assert!((s.felt_scale - want).abs() < 1e-6, "{} vs {}", s.felt_scale, want);
        let s = string_set_soft(40, &p, 48000.0, 1.0);
        assert!(near(&s.strike_gain[..2], &[4.0 / 3.0, 2.0 / 3.0]), "{:?}", s.strike_gain);
        assert!((s.struck_strings - 1.5).abs() < 1e-6);
        let s = string_set_soft(25, &p, 48000.0, 1.0);
        assert!(near(&s.strike_gain[..1], &[1.0]));
        assert!((s.struck_strings - 1.0).abs() < 1e-6);
        let s = string_set_soft(60, &p, 48000.0, 0.5);
        assert!(near(&s.strike_gain, &[1.2, 1.2, 0.6]), "{:?}", s.strike_gain);
        for note in [25u8, 40, 60] {
            let s = string_set_soft(note, &p, 48000.0, 0.0);
            for st in 0..s.count {
                assert_eq!(s.strike_gain[st], 1.0, "note {note}");
            }
            assert_eq!(s.struck_strings, s.count as f32, "note {note}");
        }
        let len_at = |shift: f32| {
            let mut s = string_set_soft(60, &p, 48000.0, shift);
            s.coupled_partials = 0;
            let mut bank = ModeBank::new();
            bank.setup(&s, 48000.0, false);
            bank.len()
        };
        assert_eq!(len_at(0.0), len_at(1.0));
    }

    #[test]
    fn stretch_zero_is_equal_temperament() {
        let mut p = ModalProfile::default();
        p.tuning.stretch = 0.0;
        for n in 21..=108u8 {
            assert_eq!(string_set(n, &p, 48000.0).f0_hz, note_hz(n), "note {n}");
        }
    }

    #[test]
    fn stretch_widens_toward_the_ends() {
        let mut p = ModalProfile::default();
        assert_eq!(string_set(69, &p, 48000.0).f0_hz, 440.0);
        let mut prev = f64::NEG_INFINITY;
        for n in 21..=108u8 {
            let c = stretch_cents(n, &p);
            assert!(c >= prev, "note {n}");
            prev = c;
        }
        for n in [21u8, 33, 45, 57, 69, 81, 93, 108] {
            println!("stretch note {n}: {:.3} cents", stretch_cents(n, &p));
        }
        assert!(stretch_cents(108, &p) > 10.0);
        assert!(stretch_cents(21, &p) < 0.0);
        p.tuning.a4_hz = 442.0;
        assert_eq!(string_set(69, &p, 48000.0).f0_hz, 442.0);
    }

    #[test]
    fn fundamental_equals_note_pitch() {
        for b in [0.0f32, 4e-4, 0.02] {
            let f0 = 123.456f32;
            let f = partial_hz(1, f0, b);
            assert!(((f - f0) / f0).abs() < 1e-6, "b {b}: {f}");
        }
        assert_eq!(note_hz(69), 440.0);
        assert!((note_hz(60) - 261.6256).abs() < 0.001);
    }

    #[test]
    fn partials_are_stretched() {
        let f0 = 100.0f32;
        let b = 4e-4f32;
        let mut last = 0.0f32;
        for n in 1..=40usize {
            let ratio = partial_hz(n, f0, b) / (n as f32 * f0);
            assert!(ratio > last, "n {n}");
            last = ratio;
            let expect = ((1.0 + b * (n * n) as f32) / (1.0 + b)).sqrt();
            assert!((ratio - expect).abs() < 1e-5, "n {n}: {ratio} vs {expect}");
            assert_eq!(partial_hz(n, f0, 0.0), n as f32 * f0);
        }
    }

    #[test]
    fn stiffness_grows_toward_treble() {
        let p = ModalProfile::default();
        assert!(inharmonicity(108, &p) > inharmonicity(60, &p));
        assert!(inharmonicity(60, &p) > inharmonicity(36, &p));
        assert_eq!(inharmonicity(60, &p), 0.0004);
    }

    #[test]
    fn string_count_by_register() {
        let p = ModalProfile::default();
        assert_eq!(string_set(21, &p, 48000.0).count, 1);
        assert_eq!(string_set(40, &p, 48000.0).count, 2);
        let s = string_set(60, &p, 48000.0);
        assert_eq!(s.count, 3);
        assert_eq!(s.detune_cents[1], 0.0);
    }

    #[test]
    fn partial_t60_matches_coefficients() {
        let p = ModalProfile::default();
        let (s, bank) = bank_for(60, &p, 48000.0);
        let fs = 48000.0f64;
        let sigma_of = |i: usize| -> f64 { -(-(bank.a2[i] as f64)).sqrt().ln() * fs };
        for i in 0..bank.len() {
            let r = (-(bank.a2[i] as f64)).sqrt();
            let t60 = 6.9078 / sigma_of(i);
            let v = r.powf(t60 * fs);
            assert!((v / 0.001 - 1.0).abs() < 0.02, "mode {i}: {v}");
        }
        let mut i = 0;
        while i < bank.len() && (i == 0 || bank.mode_partial(i) > bank.mode_partial(i - 1)) {
            let expect = 6.9078
                / partial_t60_s(bank.mode_hz(i), s.f0_hz, s.t60_fundamental_s, p.decay.damping_per_khz2) as f64
                * s.decay_scale[0] as f64;
            assert!((sigma_of(i) / expect - 1.0).abs() < 0.03, "mode {i}: {} vs {expect}", sigma_of(i));
            i += 1;
        }
        let first = (0..bank.len()).find(|&i| bank.mode_partial(i) == 1).unwrap();
        let tenth = (0..bank.len()).find(|&i| bank.mode_partial(i) == 10).unwrap();
        assert!(6.9078 / sigma_of(tenth) < 6.9078 / sigma_of(first));
        assert!((partial_t60_s(261.0, 261.0, 10.0, 0.3) - 10.0).abs() < 1e-4);
    }

    #[test]
    fn damping_scales_damper_rate() {
        let p = ModalProfile::default();
        let (_, mut bank) = bank_for(60, &p, 48000.0);
        let fs = 48000.0f64;
        let sigma = |a2: f32| -> f64 { -(-(a2 as f64)).sqrt().ln() * fs };
        bank.set_damping(1.0);
        assert!(bank.damped);
        let full: Vec<f64> = (0..bank.len()).map(|i| sigma(bank.a2_damped[i]) - sigma(bank.a2[i])).collect();
        for amount in [0.5f32, 0.3] {
            bank.set_damping(amount);
            assert!(bank.damped);
            #[allow(clippy::needless_range_loop)] // index spans several parallel arrays; iterator form would complicate borrows on the audio path
            for i in 0..bank.len() {
                let extra = sigma(bank.a2_damped[i]) - sigma(bank.a2[i]);
                let want = amount as f64 * full[i];
                assert!((extra - want).abs() <= 0.002 * full[i], "amount {amount} mode {i}: {extra} vs {want}");
            }
        }
        bank.set_damping(0.0);
        assert!(!bank.damped);
    }

    #[test]
    fn strike_point_silences_partials() {
        let mut p = ModalProfile::default();
        p.strings.strike_position_bass = 0.125;
        p.strings.strike_position_treble = 0.125;
        let (_, bank) = bank_for(60, &p, 48000.0);
        let gain = |n: usize| {
            let i = (0..bank.len()).find(|&i| bank.mode_partial(i) == n).unwrap();
            (bank.b[i] * bank.w[i]).abs()
        };
        assert!(gain(8) < 1e-3 * gain(7), "{} vs {}", gain(8), gain(7));
    }

    #[test]
    fn mode_count_stays_in_budget() {
        let p = ModalProfile::default();
        for rate in [44100.0f32, 48000.0, 96000.0] {
            for note in 21..=108u8 {
                let (s, bank) = bank_for(note, &p, rate);
                assert!(bank.len() <= MAX_MODES, "note {note}");
                assert!(bank.len() <= s.count * s.partials_per_string, "note {note}");
                for i in 0..bank.len() {
                    assert!(bank.mode_hz(i) < 0.45 * rate, "note {note} mode {i}");
                }
            }
        }
    }

    #[test]
    fn two_stage_neutral_is_zero() {
        let t = TwoStage::default();
        assert!(!t.is_on());
        assert_eq!(t.segment_ln(0.0, 64, 1.0 / 48000.0), 0.0);
    }

    #[test]
    fn two_stage_segments_sum_to_envelope() {
        let t = TwoStage { m: 0.25, sigma: 5.0 };
        let dt = 1.0 / 48000.0;
        let mut sum = 0.0;
        for k in 0..750 {
            sum += t.segment_ln(k as f64 * 64.0 * dt, 64, dt) * 64.0;
        }
        let want = (t.g(1.0) / t.g(0.0)).ln();
        assert!((sum - want).abs() < 1e-9, "{sum} {want}");
    }
}
