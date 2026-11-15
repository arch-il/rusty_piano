//! Two-way bridge coupling: the lowest string partials of a voice, driven by the hammer and by the bridge velocity, pushing the board back.
//!
//! Each mode is a passive rotation-form resonator with state x = (xr, xi) in velocity units (xr = free velocity, xi = Omega * q).
//! A mode with modal mass m = mu L / 2 pushes the bridge with kg * v (kg at most sqrt(T mu) * sqrt(coupling)) and receives -kg * v_bridge (a gyrator).
//! The bridge loop is solved algebraically per sample in the renderer, so with no drive the total energy never grows.

use super::profile::{ModalSoundboard, MAX_COUPLED_PER_STRING};
use super::soundboard::MobilityTable;
use super::strings::{mode_coefs_sigma, partial_t60_s, string_partial_hz, StringSet, LANES};
use std::f64::consts::PI;

pub const MAX_COUPLED: usize = 3 * MAX_COUPLED_PER_STRING;

const LN1000: f64 = 6.907755278982137;

/// Coupled modes of one voice, struct-of-arrays. Unused tail slots are all zero.
pub struct CoupledModes {
    xr: [f32; MAX_COUPLED],
    xi: [f32; MAX_COUPLED],
    rc: [f32; MAX_COUPLED],
    rs: [f32; MAX_COUPLED],
    rcd: [f32; MAX_COUPLED],
    rsd: [f32; MAX_COUPLED],
    sh: [f32; MAX_COUPLED],
    sk: [f32; MAX_COUPLED],
    kr: [f32; MAX_COUPLED],
    kg: [f32; MAX_COUPLED],
    freq: [f32; MAX_COUPLED],
    ew: [f64; MAX_COUPLED],
    kh: f32,
    gs: f32,
    h_prev: f32,
    v_prev: f32,
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

impl Default for CoupledModes {
    fn default() -> Self {
        Self::new()
    }
}

impl CoupledModes {
    pub fn new() -> Self {
        Self {
            xr: [0.0; MAX_COUPLED],
            xi: [0.0; MAX_COUPLED],
            rc: [0.0; MAX_COUPLED],
            rs: [0.0; MAX_COUPLED],
            rcd: [0.0; MAX_COUPLED],
            rsd: [0.0; MAX_COUPLED],
            sh: [0.0; MAX_COUPLED],
            sk: [0.0; MAX_COUPLED],
            kr: [0.0; MAX_COUPLED],
            kg: [0.0; MAX_COUPLED],
            freq: [0.0; MAX_COUPLED],
            ew: [0.0; MAX_COUPLED],
            kh: 0.0,
            gs: 0.0,
            h_prev: 0.0,
            v_prev: 0.0,
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

    /// Builds the coupled modes (string 0 first, partial ascending). State is kept only if `keep_state` is true and the mode count is unchanged.
    /// The decay table is the total in-phase decay of a coupled partial: the estimated in-phase bridge loss is taken off the
    /// intrinsic loss, and where it would exceed the string set's coupling_loss_fraction of the table the partial's kg is weakened.
    /// Derivation: a mode with modal mass m = mu L / 2 loses sigma = kg^2 Re(Y) / (2 m) = coupling T Y / L per string;
    /// the in-phase unison loses count times that.
    pub fn setup(&mut self, s: &StringSet, sample_rate: f32, sb: &ModalSoundboard, mob: &MobilityTable, keep_state: bool) {
        let dt = 1.0 / sample_rate as f64;
        let coupling = sb.coupling as f64;
        let mut y = [0.0f64; MAX_COUPLED_PER_STRING + 1];
        for (n, yn) in y.iter_mut().enumerate().skip(1) {
            if n <= s.coupled_partials {
                *yn = mob.smoothed_lookup(string_partial_hz(s, 0, n));
            }
        }
        let max_hz = s.max_hz as f64;
        let length = s.length_m as f64;
        let m = s.linear_density as f64 * length / 2.0;
        let s_ = dt / m;
        let g = dt / (2.0 * m);
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
        let kg0 = s.impedance as f64 * (sb.coupling as f64).sqrt();
        let frac = s.coupling_loss_fraction as f64;
        let mut kh = 0.0f64;
        let mut gs = 0.0f64;
        let mut k = 0usize;
        for st in 0..s.count {
            for (n, &yn) in y.iter().enumerate().skip(1).take(s.partials_per_string) {
                let f = string_partial_hz(s, st, n);
                if f >= max_hz {
                    break;
                }
                if !s.is_coupled(n, f) || k >= MAX_COUPLED {
                    continue;
                }
                let t60 = partial_t60_s(f as f32, s.f0_hz, s.t60_fundamental_s, s.damping_per_khz2) as f64;
                let sigma_tab = LN1000 / t60 * s.decay_scale[st] as f64;
                let sigma_in = s.count as f64 * coupling * s.tension_n as f64 * yn / length;
                let a2 = if sigma_in > 0.0 { (frac * sigma_tab / sigma_in).min(1.0) } else { 1.0 };
                let sigma_int = sigma_tab - a2 * sigma_in;
                let kg_i = kg0 * a2.sqrt();
                let c = mode_coefs_sigma(s, st, n, f, dt, sigma_int);
                let shape = (n as f64 * PI * s.strike_position as f64).sin() / s.count as f64 * s.strike_gain[st] as f64;
                let rc = c.r * c.theta.cos();
                let rs = c.r * c.theta.sin();
                self.rc[k] = rc as f32;
                self.rs[k] = rs as f32;
                self.sh[k] = (s_ * shape) as f32;
                self.sk[k] = (s_ * kg_i) as f32;
                self.kg[k] = kg_i as f32;
                self.kr[k] = (c.w / (2.0 * PI * f)) as f32;
                self.ew[k] = m / (2.0 * c.r * c.r);
                self.freq[k] = f as f32;
                kh += kg_i * g * shape;
                gs += kg_i * kg_i * g;
                k += 1;
            }
        }
        for i in k..MAX_COUPLED {
            self.rc[i] = 0.0;
            self.rs[i] = 0.0;
            self.rcd[i] = 0.0;
            self.rsd[i] = 0.0;
            self.sh[i] = 0.0;
            self.sk[i] = 0.0;
            self.kg[i] = 0.0;
            self.kr[i] = 0.0;
            self.ew[i] = 0.0;
            self.freq[i] = 0.0;
            self.xr[i] = 0.0;
            self.xi[i] = 0.0;
        }
        if !(keep_state && k == self.len) {
            self.xr = [0.0; MAX_COUPLED];
            self.xi = [0.0; MAX_COUPLED];
            self.h_prev = 0.0;
            self.v_prev = 0.0;
        }
        self.kh = kh as f32;
        self.gs = gs as f32;
        self.len = k;
        self.apply_damping();
    }

    /// How many coupled modes `setup` would build for this string set; no state is touched.
    pub fn count_for(s: &StringSet) -> usize {
        let max_hz = s.max_hz as f64;
        let mut k = 0usize;
        for st in 0..s.count {
            for n in 1..=s.partials_per_string {
                let f = string_partial_hz(s, st, n);
                if f >= max_hz {
                    break;
                }
                if !s.is_coupled(n, f) || k >= MAX_COUPLED {
                    continue;
                }
                k += 1;
            }
        }
        k
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

    /// Chooses the damped (key up, damper on the string) or the free rotation.
    pub fn set_damped(&mut self, damped: bool) {
        self.set_damping(if damped { 1.0 } else { 0.0 });
    }

    /// Damper pressure: 0 = free string, 1 = full damper. Scales every rotation by lam = exp(amount * ln_lam) <= 1, so the bank stays passive.
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
        self.damped = lam < 1.0;
        if self.damped {
            for i in 0..self.len {
                self.rcd[i] = (lam * self.rc[i] as f64) as f32;
                self.rsd[i] = (lam * self.rs[i] as f64) as f32;
            }
        }
    }

    /// Sum over modes of kg * g * shape: how much of the hammer force reaches the bridge at once.
    pub fn kh(&self) -> f32 {
        self.kh
    }

    /// Sum over modes of kg^2 * g: the instantaneous bridge admittance load of this voice.
    pub fn gs(&self) -> f32 {
        self.gs
    }

    /// One sample: applies the previous sample's input, then rotates. Returns (raw bridge force in N for the direct and body paths, sum of kg * xr).
    #[inline]
    pub fn advance(&mut self) -> (f32, f32) {
        let chunks = self.len.div_ceil(LANES);
        let (rcs, rss) = if self.damped { (&self.rcd, &self.rsd) } else { (&self.rc, &self.rs) };
        let h = self.h_prev;
        let vb = self.v_prev;
        let mut raw = [0.0f32; LANES];
        let mut vel = [0.0f32; LANES];
        for c in 0..chunks {
            let base = c * LANES;
            for l in 0..LANES {
                let i = base + l;
                let t = self.xr[i] + self.sh[i] * h - self.sk[i] * vb;
                let xi = self.xi[i];
                let nr = rcs[i] * t - rss[i] * xi;
                let ni = rss[i] * t + rcs[i] * xi;
                self.xr[i] = nr;
                self.xi[i] = ni;
                raw[l] += self.kr[i] * ni;
                vel[l] += self.kg[i] * nr;
            }
        }
        (raw.iter().sum::<f32>(), vel.iter().sum::<f32>())
    }

    /// Stores this sample's hammer force and bridge velocity; they enter the modes at the next advance.
    #[inline]
    pub fn commit(&mut self, h: f32, v_b: f32) {
        self.h_prev = h;
        self.v_prev = v_b;
        if self.tail_after != 0 && !self.in_tail && self.damping > 0.0 {
            self.tail_count += 1;
            if self.tail_count >= self.tail_after {
                self.in_tail = true;
                self.ln_lam = self.ln_lam_tail;
                self.apply_damping();
            }
        }
    }

    /// Mode i for a shared packed advance: [xr with the pending input already applied (as advance does), xi, rc, rs (damped if damped), sk, kr, kg].
    #[inline]
    pub fn packed_mode(&self, i: usize) -> [f32; 7] {
        let (rc, rs) = if self.damped { (self.rcd[i], self.rsd[i]) } else { (self.rc[i], self.rs[i]) };
        let t = self.xr[i] + self.sh[i] * self.h_prev - self.sk[i] * self.v_prev;
        [t, self.xi[i], rc, rs, self.sk[i], self.kr[i], self.kg[i]]
    }

    /// Writes back mode i's state after a packed advance (its pending input was taken by packed_mode; store the next one with commit).
    #[inline]
    pub fn store_mode(&mut self, i: usize, xr: f32, xi: f32) {
        self.xr[i] = xr;
        self.xi[i] = xi;
    }

    /// Energy of the coupled modes in joules.
    pub fn energy(&self) -> f64 {
        let mut e = 0.0f64;
        for i in 0..self.len {
            let (xr, xi) = (self.xr[i] as f64, self.xi[i] as f64);
            e += self.ew[i] * (xr * xr + xi * xi);
        }
        e
    }

    /// Sets tiny states to zero so they cannot become denormal numbers.
    pub fn flush_tiny(&mut self) {
        for i in 0..self.len {
            if self.xr[i].abs() + self.xi[i].abs() < 1e-15 {
                self.xr[i] = 0.0;
                self.xi[i] = 0.0;
            }
        }
    }

    pub fn clear(&mut self) {
        self.xr = [0.0; MAX_COUPLED];
        self.xi = [0.0; MAX_COUPLED];
        self.h_prev = 0.0;
        self.v_prev = 0.0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sound::modal_piano::profile::ModalProfile;
    use crate::sound::modal_piano::soundboard::Soundboard;
    use crate::sound::modal_piano::strings::{string_set, ModeBank};

    fn board_for(p: &ModalProfile, rate: f32) -> Soundboard {
        let mut b = Soundboard::new(rate);
        b.configure(p, rate);
        b
    }

    #[test]
    fn loss_compensation_respects_table_and_cap() {
        let p = ModalProfile::default();
        let rate = 48000.0f32;
        let sr = rate as f64;
        let board = board_for(&p, rate);
        let mut capped_84 = false;
        for note in [36u8, 48, 60, 72, 84, 96] {
            let s = string_set(note, &p, rate);
            let mut c = CoupledModes::new();
            c.setup(&s, rate, &p.soundboard, &board.mob, false);
            assert!(!c.is_empty(), "note {note}");
            let kg0 = s.impedance as f64 * (p.soundboard.coupling as f64).sqrt();
            let mut k = 0usize;
            for st in 0..s.count {
                for n in 1..=s.partials_per_string {
                    let f = string_partial_hz(&s, st, n);
                    if f >= s.max_hz as f64 {
                        break;
                    }
                    if !s.is_coupled(n, f) || k >= MAX_COUPLED {
                        continue;
                    }
                    let (rc, rs) = (c.rc[k] as f64, c.rs[k] as f64);
                    let r = (rc * rc + rs * rs).sqrt();
                    let sigma_int = -r.ln() * sr;
                    let sigma_tab = LN1000 / partial_t60_s(f as f32, s.f0_hz, s.t60_fundamental_s, s.damping_per_khz2) as f64
                        * s.decay_scale[st] as f64;
                    let kg = c.kg[k] as f64;
                    // f32 rotation coefficients resolve sigma only to about 1e-3 /s at 48 kHz; the f64 design value is exact.
                    let tol = 0.002;
                    assert!(sigma_int <= sigma_tab * 1.001 + tol, "note {note} mode {k}: {sigma_int} > {sigma_tab}");
                    assert!(
                        sigma_int >= (1.0 - s.coupling_loss_fraction as f64) * sigma_tab * 0.999 - tol,
                        "note {note} mode {k}: {sigma_int} vs table {sigma_tab}"
                    );
                    assert!(kg > 0.0 && kg <= kg0 * 1.0001, "note {note} mode {k}: kg {kg} vs {kg0}");
                    if note == 84 && kg < 0.9 * kg0 {
                        capped_84 = true;
                    }
                    k += 1;
                }
            }
            assert_eq!(k, c.len(), "note {note}");
        }
        assert!(capped_84, "no capped mode at note 84");
    }

    /// For each coupled mode of the note: (sigma_int, sigma_tab) at 48 kHz.
    fn sigmas(p: &ModalProfile, note: u8) -> Vec<(f64, f64)> {
        let rate = 48000.0f32;
        let board = board_for(p, rate);
        let s = string_set(note, p, rate);
        let mut c = CoupledModes::new();
        c.setup(&s, rate, &p.soundboard, &board.mob, false);
        let mut out = Vec::new();
        let mut k = 0usize;
        for st in 0..s.count {
            for n in 1..=s.partials_per_string {
                let f = string_partial_hz(&s, st, n);
                if f >= s.max_hz as f64 {
                    break;
                }
                if !s.is_coupled(n, f) || k >= MAX_COUPLED {
                    continue;
                }
                let (rc, rs) = (c.rc[k] as f64, c.rs[k] as f64);
                let r = (rc * rc + rs * rs).sqrt();
                let sigma_int = -r.ln() * rate as f64;
                let sigma_tab = LN1000 / partial_t60_s(f as f32, s.f0_hz, s.t60_fundamental_s, s.damping_per_khz2) as f64
                    * s.decay_scale[st] as f64;
                out.push((sigma_int, sigma_tab));
                k += 1;
            }
        }
        out
    }

    #[test]
    fn fraction_sets_the_intrinsic_floor() {
        let tol = 0.002;
        for frac in [0.3f32, 0.9] {
            let mut p = ModalProfile::default();
            p.soundboard.coupling_loss_fraction = frac;
            let f = frac as f64;
            let mut capped = false;
            for (i, (sigma_int, sigma_tab)) in sigmas(&p, 84).into_iter().enumerate() {
                assert!(sigma_int >= (1.0 - f) * sigma_tab * 0.999 - tol, "frac {frac} mode {i}: {sigma_int} vs {sigma_tab}");
                if sigma_int <= (1.0 - f) * sigma_tab * 1.01 + tol {
                    capped = true;
                }
            }
            assert!(capped, "frac {frac}: no capped mode");
        }
    }

    #[test]
    fn aftersound_changes_the_tail() {
        use crate::midi::MidiEvent;
        use crate::sound::modal_piano::tables::{NoteAnchor, NoteTable};
        use crate::sound::modal_piano::ModalPiano;
        use crate::sound::SoundEngine;
        let rate = 48000u32;
        let slope = |m: &[f32], from_s: f64, to_s: f64| -> f64 {
            let f = (0.05 * rate as f64).round() as usize;
            let from = (from_s * rate as f64).round() as usize;
            let to = ((to_s * rate as f64).round() as usize).min(m.len());
            let pts: Vec<(f64, f64)> = m[from..to]
                .chunks_exact(f)
                .enumerate()
                .map(|(i, c)| {
                    let ms = c.iter().map(|&v| (v as f64) * (v as f64)).sum::<f64>() / c.len() as f64;
                    (from_s + (i as f64 + 0.5) * 0.05, 10.0 * (ms + 1e-30).log10())
                })
                .collect();
            let n = pts.len() as f64;
            let mx = pts.iter().map(|p| p.0).sum::<f64>() / n;
            let my = pts.iter().map(|p| p.1).sum::<f64>() / n;
            let sxy: f64 = pts.iter().map(|p| (p.0 - mx) * (p.1 - my)).sum();
            let sxx: f64 = pts.iter().map(|p| (p.0 - mx) * (p.0 - mx)).sum();
            sxy / sxx
        };
        let mut base = ModalProfile::default();
        base.strings.max_partials = 1;
        base.strings.unison_decay_spread = 0.0;
        base.mics.direct_mix = 1.0;
        base.mics.board_mix = 0.0;
        base.mics.body_mix = 0.0;
        base.output.output_gain = 0.0134;
        let note = [84u8, 72, 60, 48]
            .into_iter()
            .find(|&n| {
                let a2_capped = sigmas(&base, n).iter().any(|&(si, st)| si <= (1.0 - base.soundboard.coupling_loss_fraction as f64) * st * 1.01 + 0.002);
                a2_capped
            })
            .expect("no note reaches the bridge-loss cap");
        println!("aftersound test note {note}");
        let mut late = [0.0f64; 2];
        for (j, a) in [0.5f32, 2.0].into_iter().enumerate() {
            let mut p = base;
            p.notes = NoteTable::from_anchors(&[NoteAnchor { aftersound: a, ..NoteAnchor::neutral(note) }]).unwrap();
            let mut e = ModalPiano::with_profile(rate, &p);
            e.handle(&MidiEvent::NoteOn { note, velocity: 100 });
            let mut mono = Vec::new();
            let (mut l, mut r) = ([0.0f32; 64], [0.0f32; 64]);
            for _ in 0..(4 * rate as usize / 64) {
                e.render_stereo(&mut l, &mut r);
                mono.extend(l.iter().zip(&r).map(|(a, b)| 0.5 * (a + b)));
            }
            late[j] = -slope(&mono, 1.5, 3.5);
        }
        println!("late decay dB/s: aftersound 0.5 = {}, aftersound 2.0 = {}", late[0], late[1]);
        // Direction check: a smaller aftersound share gives a slower late decay (measured 0.805 at note 84).
        assert!(late[0] < 0.9 * late[1], "{late:?}");
    }

    #[test]
    fn coupled_split_keeps_all_modes() {
        let p = ModalProfile::default();
        for rate in [44100.0f32, 48000.0, 96000.0] {
            let board = board_for(&p, rate);
            for note in 21..=108u8 {
                let s = string_set(note, &p, rate);
                let mut split = ModeBank::new();
                split.setup(&s, rate, false);
                let mut coupled = CoupledModes::new();
                coupled.setup(&s, rate, &p.soundboard, &board.mob, false);
                let mut full_set = s;
                full_set.coupled_partials = 0;
                let mut full = ModeBank::new();
                full.setup(&full_set, rate, false);
                assert_eq!(split.len() + coupled.len(), full.len(), "note {note} rate {rate}");
                assert!(coupled.len() <= MAX_COUPLED, "note {note}");
                let mut a: Vec<f32> = (0..split.len()).map(|i| split.mode_hz(i)).chain((0..coupled.len()).map(|i| coupled.mode_hz(i))).collect();
                let mut b: Vec<f32> = (0..full.len()).map(|i| full.mode_hz(i)).collect();
                a.sort_by(f32::total_cmp);
                b.sort_by(f32::total_cmp);
                assert_eq!(a, b, "note {note} rate {rate}");
                for i in 0..coupled.len() {
                    assert!(coupled.mode_hz(i) < p.soundboard.coupled_max_hz, "note {note} mode {i}");
                }
            }
        }
    }

    #[test]
    fn zero_coupling_has_no_feedback() {
        let mut p = ModalProfile::default();
        p.soundboard.coupling = 0.0;
        let s = string_set(60, &p, 48000.0);
        let mut coupled = CoupledModes::new();
        coupled.setup(&s, 48000.0, &p.soundboard, &board_for(&p, 48000.0).mob, false);
        assert_eq!(coupled.len(), 0);
        let mut bank = ModeBank::new();
        bank.setup(&s, 48000.0, false);
        let mut full_set = s;
        full_set.coupled_partials = 0;
        let mut full = ModeBank::new();
        full.setup(&full_set, 48000.0, false);
        assert!(!bank.is_empty());
        assert_eq!(bank.len(), full.len());
    }

    fn impulse_modes() -> CoupledModes {
        let p = ModalProfile::default();
        let s = string_set(60, &p, 48000.0);
        let mut c = CoupledModes::new();
        c.setup(&s, 48000.0, &p.soundboard, &board_for(&p, 48000.0).mob, false);
        assert!(!c.is_empty());
        c.commit(1.0, 0.0);
        c
    }

    #[test]
    fn impulse_response_matches_analytic_oscillator() {
        let mut c = impulse_modes();
        let mut got = Vec::new();
        for _ in 0..200 {
            got.push(c.advance().0 as f64);
            c.commit(0.0, 0.0);
        }
        let want: Vec<f64> = (1..=200)
            .map(|k| {
                (0..c.len())
                    .map(|i| {
                        let (rc, rs) = (c.rc[i] as f64, c.rs[i] as f64);
                        let r = (rc * rc + rs * rs).sqrt();
                        let th = rs.atan2(rc);
                        c.kr[i] as f64 * c.sh[i] as f64 * r.powi(k) * (k as f64 * th).sin()
                    })
                    .sum()
            })
            .collect();
        let max = want.iter().fold(0.0f64, |m, x| m.max(x.abs()));
        assert!(max > 0.0);
        for (k, (g, w)) in got.iter().zip(&want).enumerate() {
            assert!((g - w).abs() <= 1e-3 * max, "step {}: {g} vs {w}", k + 1);
        }
    }

    #[test]
    fn partial_damping_stays_passive() {
        let mut c = impulse_modes();
        c.set_damping(0.3);
        assert!(c.damped);
        c.advance();
        c.commit(0.0, 0.0);
        let start: Vec<f64> = (0..c.len()).map(|i| c.ew[i] * ((c.xr[i] as f64).powi(2) + (c.xi[i] as f64).powi(2))).collect();
        let mut prev = c.energy();
        assert!(prev > 0.0);
        let steps = 5000;
        for k in 0..steps {
            c.advance();
            c.commit(0.0, 0.0);
            let e = c.energy();
            assert!(e <= prev * (1.0 + 1e-6), "step {k}: {prev} -> {e}");
            prev = e;
        }
        let lam = (0.3 * c.ln_lam).exp();
        #[allow(clippy::needless_range_loop)] // index spans several parallel arrays; iterator form would complicate borrows on the audio path
        for i in 0..c.len() {
            if start[i] <= 1e-20 * c.ew[i] {
                continue;
            }
            let end = c.ew[i] * ((c.xr[i] as f64).powi(2) + (c.xi[i] as f64).powi(2));
            let ratio = (end / start[i]).powf(1.0 / steps as f64);
            let r2 = (c.rc[i] as f64).powi(2) + (c.rs[i] as f64).powi(2);
            let want = r2 * lam * lam;
            assert!((ratio / want - 1.0).abs() < 1e-5, "mode {i}: ratio {ratio} vs {want}");
        }
    }

    #[test]
    fn isolated_mode_energy_never_grows() {
        for damped in [false, true] {
            let mut c = impulse_modes();
            c.set_damped(damped);
            c.advance();
            c.commit(0.0, 0.0);
            let start: Vec<f64> = (0..c.len()).map(|i| c.ew[i] * ((c.xr[i] as f64).powi(2) + (c.xi[i] as f64).powi(2))).collect();
            let mut prev = c.energy();
            assert!(prev > 0.0);
            let steps = 5000;
            for k in 0..steps {
                c.advance();
                c.commit(0.0, 0.0);
                let e = c.energy();
                assert!(e <= prev * (1.0 + 1e-6), "damped {damped} step {k}: {prev} -> {e}");
                prev = e;
            }
            if !damped {
                #[allow(clippy::needless_range_loop)] // index spans several parallel arrays; iterator form would complicate borrows on the audio path
                for i in 0..c.len() {
                    if start[i] <= 1e-20 * c.ew[i] {
                        continue;
                    }
                    let end = c.ew[i] * ((c.xr[i] as f64).powi(2) + (c.xi[i] as f64).powi(2));
                    let ratio = (end / start[i]).powf(1.0 / steps as f64);
                    let r2 = (c.rc[i] as f64).powi(2) + (c.rs[i] as f64).powi(2);
                    assert!((ratio / r2 - 1.0).abs() < 1e-6, "mode {i}: ratio {ratio} vs r^2 {r2}");
                }
            }
        }
    }
}
