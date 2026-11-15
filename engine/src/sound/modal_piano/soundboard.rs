//! Shared soundboard tables: plate mode table, mode shapes, microphone positions and delays, velvet-noise body taps and the crossover high-pass.
//! The runtime `Soundboard` that uses them is below.

use super::profile::{ModalMics, ModalProfile, ModalSoundboard};

pub use super::profile::{MAX_BOARD_MODES, MAX_COUPLED_PER_STRING};

/// Length of the soundboard in metres (the width is this divided by the aspect ratio).
pub const BOARD_LENGTH_M: f64 = 1.5;
pub const SPEED_OF_SOUND_MPS: f64 = 343.0;
/// Microphone pair centre along the board length, as a fraction.
pub const MIC_CENTRE_X: f64 = 0.45;
/// Microphone pair position across the board width, as a fraction.
pub const MIC_CENTRE_Y: f64 = 0.4;
/// Velvet-noise taps per second of body response.
pub const BODY_TAPS_PER_S: f64 = 2000.0;
pub const MAX_BODY_T60_MS: f32 = 200.0;
pub const MAX_BODY_TAPS: usize = 512;
pub const BODY_SEED_LEFT: u32 = 0x9E37_79B9;
pub const BODY_SEED_RIGHT: u32 = 0x85EB_CA6B;

const MAX_INDEX: u32 = 64;

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct BoardModeSpec {
    pub m: u32,
    pub n: u32,
    pub hz: f64,
    pub q: f64,
}

fn shape_value(m: u32, n: u32, aspect: f64) -> f64 {
    let a = m as f64 / aspect;
    a * a + (n * n) as f64
}

/// Fills `out` with the lowest plate modes of the profile and returns how many were written.
pub fn board_mode_table(sb: &ModalSoundboard, sample_rate: f32, out: &mut [BoardModeSpec; MAX_BOARD_MODES]) -> usize {
    let aspect = sb.aspect as f64;
    let lo = sb.lowest_hz as f64;
    let hi = sb.highest_hz as f64;
    let modes = sb.modes.min(MAX_BOARD_MODES);

    let mut next_m = [1u32; MAX_INDEX as usize];
    let mut picked = [(0u32, 0u32, 0.0f64); MAX_BOARD_MODES];
    let mut picked_count = 0;
    for _ in 0..modes {
        let mut best: Option<(u32, f64)> = None;
        for n in 1..=MAX_INDEX {
            let m = next_m[(n - 1) as usize];
            if m > MAX_INDEX {
                continue;
            }
            let s = shape_value(m, n, aspect);
            if best.is_none_or(|(_, bs)| s < bs) {
                best = Some((n, s));
            }
        }
        let Some((n, s)) = best else { break };
        let m = next_m[(n - 1) as usize];
        next_m[(n - 1) as usize] += 1;
        picked[picked_count] = (m, n, s);
        picked_count += 1;
    }
    if picked_count == 0 {
        return 0;
    }

    let s_max = picked[picked_count - 1].2;
    let limit = 0.45 * sample_rate as f64;
    let q_low = sb.q_low as f64;
    let q_high = sb.q_high as f64;
    let mut count = 0;
    for &(m, n, s) in &picked[..picked_count] {
        let r = s / s_max;
        let hz = (lo * lo + (hi * hi - lo * lo) * r * r).sqrt();
        if hz >= limit {
            continue;
        }
        let t = ((hz / lo).ln() / (hi / lo).ln()).clamp(0.0, 1.0);
        let q = q_low * (q_high / q_low).powf(t);
        out[count] = BoardModeSpec { m, n, hz, q };
        count += 1;
    }
    count
}

/// Mode shape of a simply supported plate at (x, y), both fractions of the board.
pub fn plate_shape(m: u32, n: u32, x: f64, y: f64) -> f64 {
    (m as f64 * std::f64::consts::PI * x).sin() * (n as f64 * std::f64::consts::PI * y).sin()
}

/// Left and right microphone positions (x, y) as fractions of the board.
pub fn mic_positions(mics: &ModalMics) -> [(f64, f64); 2] {
    let spacing = (mics.spacing_m as f64 * 1e6).round() / 1e6;
    let half = spacing / (2.0 * BOARD_LENGTH_M);
    let left = (MIC_CENTRE_X - half).clamp(0.02, 0.98);
    let right = (MIC_CENTRE_X + half).clamp(0.02, 0.98);
    [(left, MIC_CENTRE_Y), (right, MIC_CENTRE_Y)]
}

/// Sound travel delay in seconds from the bridge to each microphone; the nearer one is 0.
pub fn mic_delays_s(sb: &ModalSoundboard, mics: &ModalMics) -> [f64; 2] {
    let aspect = sb.aspect as f64;
    let height = mics.height_m as f64;
    let pos = mic_positions(mics);
    let dist = |(x, y): (f64, f64)| {
        let dx = (x - sb.bridge_x as f64) * BOARD_LENGTH_M;
        let dy = (y - sb.bridge_y as f64) * BOARD_LENGTH_M / aspect;
        (dx * dx + dy * dy + height * height).sqrt()
    };
    let dl = dist(pos[0]);
    let dr = dist(pos[1]);
    let near = dl.min(dr);
    [(dl - near) / SPEED_OF_SOUND_MPS, (dr - near) / SPEED_OF_SOUND_MPS]
}

/// Velvet-noise taps for the body response: one tap per slot with a random position and sign, decaying by 60 dB over t60. Returns the tap count.
pub fn velvet_taps(
    t60_ms: f32,
    sample_rate: f32,
    seed: u32,
    pos: &mut [u32; MAX_BODY_TAPS],
    amp: &mut [f32; MAX_BODY_TAPS],
) -> usize {
    let t60_s = t60_ms as f64 / 1000.0;
    let count = ((t60_ms as f64 * BODY_TAPS_PER_S / 1000.0).floor() as usize).clamp(1, MAX_BODY_TAPS);
    let fs = sample_rate as f64;
    let td = fs / BODY_TAPS_PER_S;
    let mut state = if seed == 0 { 1 } else { seed };
    let mut next = || {
        state ^= state << 13;
        state ^= state >> 17;
        state ^= state << 5;
        state
    };
    let mut energy = 0.0f64;
    let mut raw = [0.0f64; MAX_BODY_TAPS];
    for i in 0..count {
        let u = (next() >> 8) as f64 / 16777216.0;
        let p = (i as f64 * td + u * (td - 1.0)).floor();
        let sign = if next() & 1 == 0 { 1.0 } else { -1.0 };
        let a = sign * 10f64.powf(-3.0 * (p / fs) / t60_s);
        pos[i] = p as u32;
        raw[i] = a;
        energy += a * a;
    }
    let scale = 1.0 / energy.sqrt();
    for i in 0..count {
        amp[i] = (raw[i] * scale) as f32;
    }
    count
}

/// Second-order Butterworth high-pass as [b0, b1, b2, a1, a2] for y = b0 x + b1 x1 + b2 x2 - a1 y1 - a2 y2.
pub fn highpass_coefs(hz: f32, sample_rate: f32) -> [f32; 5] {
    let fs = sample_rate as f64;
    let f = (hz as f64).min(0.45 * fs);
    let w0 = 2.0 * std::f64::consts::PI * f / fs;
    let (sin, cos) = w0.sin_cos();
    let alpha = sin / (2.0 * std::f64::consts::FRAC_1_SQRT_2);
    let a0 = 1.0 + alpha;
    let b0 = (1.0 + cos) / 2.0 / a0;
    let b1 = -(1.0 + cos) / a0;
    let a1 = -2.0 * cos / a0;
    let a2 = (1.0 - alpha) / a0;
    [b0 as f32, b1 as f32, b0 as f32, a1 as f32, a2 as f32]
}

const LANES: usize = 8;
/// Frequency where the board mobility normalisation keeps the old per-mode peak.
const MIDDLE_C_HZ: f64 = 261.63;
/// Fixed gain of the body response (the 4th-order crossover removes most of the signal, so this restores the level).
const BODY_GAIN: f32 = 3.0;

/// Real part of the bridge mobility (m/s per N) of the board modes plus the 1 / Z_R loss, for the coupled-mode loss estimate.
pub struct MobilityTable {
    pub om: [f64; MAX_BOARD_MODES],
    pub sig: [f64; MAX_BOARD_MODES],
    pub k: [f64; MAX_BOARD_MODES],
    pub len: usize,
    pub inv_zr: f64,
    lookup: [f64; LOOKUP_N],
}

const LOOKUP_N: usize = 1024;
const LOOKUP_LO_HZ: f64 = 20.0;
const LOOKUP_HI_HZ: f64 = 10000.0;

impl MobilityTable {
    pub fn new() -> Self {
        Self {
            om: [0.0; MAX_BOARD_MODES],
            sig: [0.0; MAX_BOARD_MODES],
            k: [0.0; MAX_BOARD_MODES],
            len: 0,
            inv_zr: 0.0,
            lookup: [0.0; LOOKUP_N],
        }
    }

    /// Fills the log-spaced table of smoothed_mobility used by smoothed_lookup.
    pub fn build_lookup(&mut self) {
        let ratio = LOOKUP_HI_HZ / LOOKUP_LO_HZ;
        for i in 0..LOOKUP_N {
            let hz = LOOKUP_LO_HZ * ratio.powf(i as f64 / (LOOKUP_N - 1) as f64);
            self.lookup[i] = self.smoothed_mobility(hz);
        }
    }

    /// smoothed_mobility from the table (linear interpolation on a log axis); exact outside 20 Hz .. 10 kHz.
    pub fn smoothed_lookup(&self, hz: f64) -> f64 {
        if !(LOOKUP_LO_HZ..=LOOKUP_HI_HZ).contains(&hz) {
            return self.smoothed_mobility(hz);
        }
        let x = (hz / LOOKUP_LO_HZ).ln() / (LOOKUP_HI_HZ / LOOKUP_LO_HZ).ln() * (LOOKUP_N - 1) as f64;
        let i = (x.floor() as usize).min(LOOKUP_N - 2);
        let f = x - i as f64;
        self.lookup[i] * (1.0 - f) + self.lookup[i + 1] * f
    }

    /// Re(Y) at `hz`: 1 / Z_R plus every mode's resonance phi^2 / M * 2 sig w^2 / ((om^2 - w^2)^2 + 4 sig^2 w^2).
    pub fn re_mobility(&self, hz: f64) -> f64 {
        let w = 2.0 * std::f64::consts::PI * hz;
        let w2 = w * w;
        let mut y = self.inv_zr;
        for j in 0..self.len {
            let d = self.om[j] * self.om[j] - w2;
            y += self.k[j] * 2.0 * self.sig[j] * w2 / (d * d + 4.0 * self.sig[j] * self.sig[j] * w2);
        }
        y
    }

    /// Mean of re_mobility at hz * {0.96, 0.98, 1.0, 1.02, 1.04}.
    pub fn smoothed_mobility(&self, hz: f64) -> f64 {
        let mut y = 0.0;
        for r in [0.96, 0.98, 1.0, 1.02, 1.04] {
            y += self.re_mobility(hz * r);
        }
        y / 5.0
    }
}

impl Default for MobilityTable {
    fn default() -> Self {
        Self::new()
    }
}

/// The shared soundboard: plate modes driven by the summed bridge force, read by two microphones, plus the body noise response.
/// Each plate mode is a passive rotation-form resonator, state (xr, xi) in velocity units (xr = velocity, xi = Omega * displacement).
pub struct Soundboard {
    len: usize,
    xr: [f32; MAX_BOARD_MODES],
    xi: [f32; MAX_BOARD_MODES],
    rc: [f32; MAX_BOARD_MODES],
    rs: [f32; MAX_BOARD_MODES],
    sb: [f32; MAX_BOARD_MODES],
    ph: [f32; MAX_BOARD_MODES],
    mlr: [f32; MAX_BOARD_MODES],
    mli: [f32; MAX_BOARD_MODES],
    mrr: [f32; MAX_BOARD_MODES],
    mri: [f32; MAX_BOARD_MODES],
    ew: [f64; MAX_BOARD_MODES],
    d_b: f32,
    f_prev: f32,
    hp: [f32; 5],
    hp_x1: f32,
    hp_x2: f32,
    hp_y1: f32,
    hp_y2: f32,
    hp2: [f32; 4],
    ring: Vec<f32>,
    mask: usize,
    head: usize,
    pos_l: [u32; MAX_BODY_TAPS],
    amp_l: [f32; MAX_BODY_TAPS],
    n_l: usize,
    pos_r: [u32; MAX_BODY_TAPS],
    amp_r: [f32; MAX_BODY_TAPS],
    n_r: usize,
    pub mob: MobilityTable,
}

impl Soundboard {
    pub fn new(sample_rate: f32) -> Self {
        let need = (MAX_BODY_T60_MS as f64 / 1000.0 * sample_rate as f64).ceil() as usize + 2;
        let size = need.next_power_of_two();
        Self {
            len: 0,
            xr: [0.0; MAX_BOARD_MODES],
            xi: [0.0; MAX_BOARD_MODES],
            rc: [0.0; MAX_BOARD_MODES],
            rs: [0.0; MAX_BOARD_MODES],
            sb: [0.0; MAX_BOARD_MODES],
            ph: [0.0; MAX_BOARD_MODES],
            mlr: [0.0; MAX_BOARD_MODES],
            mli: [0.0; MAX_BOARD_MODES],
            mrr: [0.0; MAX_BOARD_MODES],
            mri: [0.0; MAX_BOARD_MODES],
            ew: [0.0; MAX_BOARD_MODES],
            d_b: 0.0,
            f_prev: 0.0,
            hp: [1.0, -2.0, 1.0, 0.0, 0.0],
            hp_x1: 0.0,
            hp_x2: 0.0,
            hp_y1: 0.0,
            hp_y2: 0.0,
            hp2: [0.0; 4],
            ring: vec![0.0; size],
            mask: size - 1,
            head: 0,
            pos_l: [0; MAX_BODY_TAPS],
            amp_l: [0.0; MAX_BODY_TAPS],
            n_l: 0,
            pos_r: [0; MAX_BODY_TAPS],
            amp_r: [0.0; MAX_BODY_TAPS],
            n_r: 0,
            mob: MobilityTable::new(),
        }
    }

    /// Rebuilds modes, microphone readouts and body taps from the profile. Does not allocate.
    pub fn configure(&mut self, p: &ModalProfile, sample_rate: f32) {
        let sb = &p.soundboard;
        let mut table = [BoardModeSpec::default(); MAX_BOARD_MODES];
        let count = board_mode_table(sb, sample_rate, &mut table);
        let dt = 1.0 / sample_rate as f64;
        let zr = sb.bridge_impedance_kg_s as f64;
        let peak = sb.mode_peak as f64;
        let pos = mic_positions(&p.mics);
        let tau = mic_delays_s(sb, &p.mics);
        let tilt_db = p.output.level_tilt_db_per_octave as f64;
        let (bx, by) = (sb.bridge_x as f64, sb.bridge_y as f64);
        // Each mode's peak mobility is (mode_peak / Z_R) * g with g = norm * 2 q df / (pi f), so the band-averaged
        // mobility peak * (pi f / (2 q)) / df is the same at every frequency (like an infinite plate).
        // df is the plate-law mode spacing, which is constant for a plate, so it cancels in the normalisation.
        // norm makes g = 1 at middle C (q taken from the same q_low..q_high law): g = (q / f) * (f_c / q_c).
        // g > 0 and finite for every mode, so the modal mass stays positive (passive).
        let (lo, hi) = (sb.lowest_hz as f64, sb.highest_hz as f64);
        let t_c = ((MIDDLE_C_HZ / lo).ln() / (hi / lo).ln()).clamp(0.0, 1.0);
        let q_c = sb.q_low as f64 * (sb.q_high as f64 / sb.q_low as f64).powf(t_c);
        let mut d_b = 1.0 / zr;
        self.mob.inv_zr = 1.0 / zr;
        self.mob.len = count;
        for (j, s) in table[..count].iter().enumerate() {
            let om = 2.0 * std::f64::consts::PI * s.hz;
            self.mob.om[j] = om;
            self.mob.sig[j] = om / (2.0 * s.q);
            self.mob.k[j] = 0.0;
            if peak <= 0.0 {
                self.rc[j] = 0.0;
                self.rs[j] = 0.0;
                self.sb[j] = 0.0;
                self.ph[j] = 0.0;
                self.mlr[j] = 0.0;
                self.mli[j] = 0.0;
                self.mrr[j] = 0.0;
                self.mri[j] = 0.0;
                self.ew[j] = 0.0;
                continue;
            }
            let th = om * dt;
            let sig = om / (2.0 * s.q);
            let r = (-sig * dt).exp();
            let g = (s.q / s.hz) * (MIDDLE_C_HZ / q_c);
            let mass = s.q * zr / (om * peak * g);
            let phb = plate_shape(s.m, s.n, bx, by);
            self.rc[j] = (r * th.cos()) as f32;
            self.rs[j] = (r * th.sin()) as f32;
            self.ph[j] = phb as f32;
            self.sb[j] = (dt / mass * phb) as f32;
            self.ew[j] = mass / (2.0 * r * r);
            self.mob.k[j] = phb * phb / mass;
            d_b += phb * phb * dt / (2.0 * mass);
            let tilt = 10f64.powf(tilt_db * (s.hz / 261.63).log2() / 20.0);
            let mut mr_ = [0.0f32; 2];
            let mut mi_ = [0.0f32; 2];
            for c in 0..2 {
                let w = plate_shape(s.m, s.n, pos[c].0, pos[c].1);
                let a = w * zr * tilt;
                mr_[c] = (a * (om * tau[c]).cos()) as f32;
                mi_[c] = (a * (om * tau[c]).sin()) as f32;
            }
            self.mlr[j] = mr_[0];
            self.mli[j] = mi_[0];
            self.mrr[j] = mr_[1];
            self.mri[j] = mi_[1];
        }
        for j in count..MAX_BOARD_MODES {
            self.rc[j] = 0.0;
            self.rs[j] = 0.0;
            self.sb[j] = 0.0;
            self.ph[j] = 0.0;
            self.mlr[j] = 0.0;
            self.mli[j] = 0.0;
            self.mrr[j] = 0.0;
            self.mri[j] = 0.0;
            self.ew[j] = 0.0;
            self.xr[j] = 0.0;
            self.xi[j] = 0.0;
            self.mob.om[j] = 0.0;
            self.mob.sig[j] = 0.0;
            self.mob.k[j] = 0.0;
        }
        self.mob.build_lookup();
        if count != self.len {
            self.xr = [0.0; MAX_BOARD_MODES];
            self.xi = [0.0; MAX_BOARD_MODES];
        }
        self.len = count;
        self.d_b = d_b as f32;
        self.hp = highpass_coefs(sb.body_crossover_hz, sample_rate);
        self.n_l = velvet_taps(sb.body_t60_ms, sample_rate, BODY_SEED_LEFT, &mut self.pos_l, &mut self.amp_l);
        if p.mics.spacing_m == 0.0 {
            self.pos_r = self.pos_l;
            self.amp_r = self.amp_l;
            self.n_r = self.n_l;
        } else {
            self.n_r = velvet_taps(sb.body_t60_ms, sample_rate, BODY_SEED_RIGHT, &mut self.pos_r, &mut self.amp_r);
        }
    }

    /// One sample: applies the previous sample's bridge force, then rotates. Returns (left mic, right mic, p_b = sum of mode shape * velocity at the bridge).
    #[inline]
    pub fn advance(&mut self) -> (f32, f32, f32) {
        let chunks = self.len.div_ceil(LANES);
        let f = self.f_prev;
        let mut ml = [0.0f32; LANES];
        let mut mr = [0.0f32; LANES];
        let mut pb = [0.0f32; LANES];
        for c in 0..chunks {
            let base = c * LANES;
            for l in 0..LANES {
                let i = base + l;
                let t = self.xr[i] + self.sb[i] * f;
                let xi = self.xi[i];
                let nr = self.rc[i] * t - self.rs[i] * xi;
                let ni = self.rs[i] * t + self.rc[i] * xi;
                self.xr[i] = nr;
                self.xi[i] = ni;
                pb[l] += self.ph[i] * nr;
                ml[l] += self.mlr[i] * nr + self.mli[i] * ni;
                mr[l] += self.mrr[i] * nr + self.mri[i] * ni;
            }
        }
        (ml.iter().sum::<f32>(), mr.iter().sum::<f32>(), pb.iter().sum::<f32>())
    }

    /// Stores this sample's total bridge force (newtons); it enters the modes at the next advance.
    #[inline]
    pub fn commit(&mut self, f: f32) {
        self.f_prev = f;
    }

    /// Instantaneous bridge admittance: 1 / Z_R plus the direct part of every board mode (m/s per N).
    pub fn d_b(&self) -> f32 {
        self.d_b
    }

    /// Energy of the board modes in joules.
    pub fn energy(&self) -> f64 {
        let mut e = 0.0f64;
        for i in 0..self.len {
            let (xr, xi) = (self.xr[i] as f64, self.xi[i] as f64);
            e += self.ew[i] * (xr * xr + xi * xi);
        }
        e
    }

    /// High-passes `drive` and convolves it with the left and right velvet-noise taps.
    pub fn process_body(&mut self, drive: &[f32], out_l: &mut [f32], out_r: &mut [f32]) {
        let n = drive.len().min(out_l.len()).min(out_r.len());
        let [b0, b1, b2, a1, a2] = self.hp;
        for t in 0..n {
            let x = drive[t];
            let y = b0 * x + b1 * self.hp_x1 + b2 * self.hp_x2 - a1 * self.hp_y1 - a2 * self.hp_y2;
            self.hp_x2 = self.hp_x1;
            self.hp_x1 = x;
            self.hp_y2 = self.hp_y1;
            self.hp_y1 = y;
            let [x1, x2, y1, y2] = self.hp2;
            let y = b0 * y + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
            self.hp2 = [self.hp_y1, x1, y, y1];
            self.ring[self.head] = y;
            let mut sl = 0.0f32;
            for i in 0..self.n_l {
                sl += self.amp_l[i] * self.ring[self.head.wrapping_sub(self.pos_l[i] as usize) & self.mask];
            }
            let mut sr = 0.0f32;
            for i in 0..self.n_r {
                sr += self.amp_r[i] * self.ring[self.head.wrapping_sub(self.pos_r[i] as usize) & self.mask];
            }
            out_l[t] = sl * BODY_GAIN;
            out_r[t] = sr * BODY_GAIN;
            self.head = (self.head + 1) & self.mask;
        }
    }

    pub fn clear(&mut self) {
        self.xr = [0.0; MAX_BOARD_MODES];
        self.xi = [0.0; MAX_BOARD_MODES];
        self.f_prev = 0.0;
        self.hp_x1 = 0.0;
        self.hp_x2 = 0.0;
        self.hp_y1 = 0.0;
        self.hp_y2 = 0.0;
        self.hp2 = [0.0; 4];
        self.ring.fill(0.0);
        self.head = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sound::modal_piano::profile::ModalProfile;

    #[test]
    fn mobility_lookup_is_within_one_percent() {
        let mut sb = Soundboard::new(48000.0);
        sb.configure(&ModalProfile::default(), 48000.0);
        let mut worst = 0.0f64;
        for i in 0..500 {
            let hz = 30.0 * (5000.0f64 / 30.0).powf(i as f64 / 499.0);
            let exact = sb.mob.smoothed_mobility(hz);
            let err = (sb.mob.smoothed_lookup(hz) - exact).abs() / exact;
            worst = worst.max(err);
        }
        println!("worst lookup error {worst:.5}");
        assert!(worst <= 0.01, "worst lookup error {worst}");
    }

    #[test]
    fn board_mode_table_is_sane() {
        let sb = ModalProfile::default().soundboard;
        for rate in [44100.0f32, 48000.0, 96000.0] {
            let mut out = [BoardModeSpec::default(); MAX_BOARD_MODES];
            let n = board_mode_table(&sb, rate, &mut out);
            assert_eq!(n, 150);
            let t = &out[..n];
            assert!(t.windows(2).all(|w| w[0].hz <= w[1].hz));
            assert!((50.0..=60.0).contains(&t[0].hz), "first {}", t[0].hz);
            assert!((t[n - 1].hz / 1500.0 - 1.0).abs() < 1e-6);
            assert!(t.iter().all(|s| s.hz < 0.45 * rate as f64));
            assert!(t.iter().all(|s| (12.0..=20.0).contains(&s.q)));
            for (i, a) in t.iter().enumerate() {
                for b in &t[i + 1..] {
                    assert!((a.m, a.n) != (b.m, b.n));
                }
            }
            let below = t.iter().filter(|s| s.hz < 500.0).count();
            assert!(below * 100 >= n * 15 && below * 100 <= n * 50, "below 500 Hz: {below}");
            let mut again = [BoardModeSpec::default(); MAX_BOARD_MODES];
            let n2 = board_mode_table(&sb, rate, &mut again);
            assert_eq!(n, n2);
            assert_eq!(&out[..n], &again[..n2]);
        }
        let mut big = sb;
        big.modes = MAX_BOARD_MODES;
        let mut out = [BoardModeSpec::default(); MAX_BOARD_MODES];
        assert_eq!(board_mode_table(&big, 48000.0, &mut out), 256);
    }

    #[test]
    fn mic_positions_mirror_and_merge_at_zero_spacing() {
        let p = ModalProfile::default();
        let mut mics = p.mics;
        mics.spacing_m = 0.0;
        let pos = mic_positions(&mics);
        assert_eq!(pos[0], pos[1]);
        assert_eq!(mic_delays_s(&p.soundboard, &mics), [0.0, 0.0]);

        let pos = mic_positions(&p.mics);
        assert!(pos[0].0 < 0.45 && 0.45 < pos[1].0);
        assert!((pos[1].0 - pos[0].0 - 0.4).abs() < 1e-9);
        let d = mic_delays_s(&p.soundboard, &p.mics);
        assert_eq!(d[0].min(d[1]), 0.0);
        assert!(d[0].max(d[1]) > 0.0);
    }

    #[test]
    fn velvet_taps_repeat_and_have_unit_energy() {
        let mut pos = [0u32; MAX_BODY_TAPS];
        let mut amp = [0.0f32; MAX_BODY_TAPS];
        let n = velvet_taps(80.0, 48000.0, BODY_SEED_LEFT, &mut pos, &mut amp);
        assert_eq!(n, 160);
        assert!(pos[..n].windows(2).all(|w| w[0] < w[1]));
        assert!((pos[n - 1] as f32) < 0.08 * 48000.0);
        let energy: f64 = amp[..n].iter().map(|a| (*a as f64) * (*a as f64)).sum();
        assert!((energy - 1.0).abs() < 1e-4, "energy {energy}");
        assert!(amp[0].abs() >= 100.0 * amp[n - 1].abs());

        let mut pos2 = [0u32; MAX_BODY_TAPS];
        let mut amp2 = [0.0f32; MAX_BODY_TAPS];
        let n2 = velvet_taps(80.0, 48000.0, BODY_SEED_LEFT, &mut pos2, &mut amp2);
        assert_eq!(n, n2);
        assert_eq!(&pos[..n], &pos2[..n2]);
        assert_eq!(&amp[..n], &amp2[..n2]);

        let n3 = velvet_taps(80.0, 48000.0, BODY_SEED_RIGHT, &mut pos2, &mut amp2);
        assert_eq!(n, n3);
        let differ = (0..n).filter(|&i| pos[i] != pos2[i] || (amp[i] < 0.0) != (amp2[i] < 0.0)).count();
        assert!(differ * 2 >= n, "only {differ} taps differ");

        let n4 = velvet_taps(200.0, 96000.0, BODY_SEED_LEFT, &mut pos2, &mut amp2);
        assert_eq!(n4, 400);
    }

    fn gain_db(c: &[f32; 5], hz: f64, rate: f64) -> f64 {
        let w = 2.0 * std::f64::consts::PI * hz / rate;
        let (c1, s1) = (w.cos(), w.sin());
        let (c2, s2) = ((2.0 * w).cos(), (2.0 * w).sin());
        let (b0, b1, b2, a1, a2) = (c[0] as f64, c[1] as f64, c[2] as f64, c[3] as f64, c[4] as f64);
        let nr = b0 + b1 * c1 + b2 * c2;
        let ni = -(b1 * s1 + b2 * s2);
        let dr = 1.0 + a1 * c1 + a2 * c2;
        let di = -(a1 * s1 + a2 * s2);
        10.0 * ((nr * nr + ni * ni) / (dr * dr + di * di)).log10()
    }

    #[test]
    fn board_absorbs_at_least_its_stored_energy() {
        let mut strong = ModalProfile::default();
        strong.soundboard.mode_peak = 10.0;
        strong.soundboard.highest_hz = 3000.0;
        for (name, p) in [("default", ModalProfile::default()), ("strong", strong)] {
            for rate in [44100.0f32, 96000.0] {
                let mut board = Soundboard::new(rate);
                board.configure(&p, rate);
                let dt = 1.0 / rate as f64;
                let zr = p.soundboard.bridge_impedance_kg_s as f64;
                let mut seed = 12345u32;
                let mut absorbed = 0.0f64;
                let mut worst = 0.0f64;
                for t in 0..20000 {
                    seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
                    let f = ((seed >> 8) as f64 / 8388608.0 - 1.0) as f32;
                    let (_, _, p_b) = board.advance();
                    let v = board.d_b() * f + p_b;
                    board.commit(f);
                    absorbed += dt * f as f64 * (v as f64 - f as f64 / zr);
                    if t % 100 == 99 {
                        let e = board.energy();
                        worst = worst.max(e / absorbed);
                        assert!(e <= absorbed * 1.001 + 1e-12, "{name} {rate} sample {t}: stored {e} > absorbed {absorbed}");
                    }
                }
                println!("{name} {rate}: stored {:.4e} J, absorbed {absorbed:.4e} J, worst stored/absorbed {worst:.4}", board.energy());
            }
        }
    }

    #[test]
    fn mobility_matches_analytic_resonance() {
        let mut p = ModalProfile::default();
        p.soundboard.modes = 1;
        p.soundboard.lowest_hz = 200.0;
        p.soundboard.highest_hz = 200.0;
        p.soundboard.q_low = 20.0;
        p.soundboard.q_high = 20.0;
        p.soundboard.mode_peak = 2.0;
        p.soundboard.bridge_impedance_kg_s = 6000.0;
        let mut board = Soundboard::new(48000.0);
        board.configure(&p, 48000.0);
        let mut table = [BoardModeSpec::default(); MAX_BOARD_MODES];
        assert_eq!(board_mode_table(&p.soundboard, 48000.0, &mut table), 1);
        let m = table[0];
        let zr = 6000.0f64;
        let phi = plate_shape(m.m, m.n, p.soundboard.bridge_x as f64, p.soundboard.bridge_y as f64);
        let g = (20.0 / 200.0) * (261.63 / 20.0);
        let want = phi * phi * 2.0 * g / zr;
        let got = board.mob.re_mobility(200.0) - 1.0 / zr;
        println!("mobility at 200 Hz: got {got:.4e}, want {want:.4e}");
        assert!((got / want - 1.0).abs() < 0.02, "got {got} want {want}");

        p.soundboard.mode_peak = 0.0;
        board.configure(&p, 48000.0);
        for hz in [100.0, 200.0, 1000.0] {
            assert_eq!(board.mob.re_mobility(hz), 1.0 / zr);
        }
        let d = ModalProfile::default();
        board.configure(&d, 48000.0);
        for i in 0..50 {
            let hz = 30.0 * (8000.0f64 / 30.0).powf(i as f64 / 49.0);
            let y = board.mob.re_mobility(hz);
            assert!(y.is_finite() && y > 0.0, "{hz} Hz: {y}");
        }
    }

    #[test]
    fn highpass_has_flat_top_and_steep_skirt() {
        let c = highpass_coefs(1500.0, 48000.0);
        assert!(gain_db(&c, 15000.0, 48000.0).abs() < 0.1);
        let corner = gain_db(&c, 1500.0, 48000.0);
        assert!((-3.2..=-2.8).contains(&corner), "corner {corner}");
        assert!(gain_db(&c, 150.0, 48000.0) <= -35.0);
    }
}
