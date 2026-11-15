//! Mechanical noises of the piano: key thump, key release, hammer knock, pedal down and pedal up.
//! Short, deterministic noise bursts (seeded white noise, band-limited, with an attack/decay envelope) in a fixed pool; no samples, no allocation.

use super::soundboard::highpass_coefs;

pub const MAX_NOISES: usize = 32;

/// Peak bridge force in newtons of middle C at velocity 127 with the default profile, measured by noise_reference_force_matches_middle_c; profile noise levels are fractions of it.
pub const NOISE_REF_N: f32 = 50.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NoiseKind {
    KeyDown,
    KeyUp,
    HammerKnock,
    PedalDown,
    PedalUp,
}

const KINDS: usize = 5;
const ALL_KINDS: [NoiseKind; KINDS] = [NoiseKind::KeyDown, NoiseKind::KeyUp, NoiseKind::HammerKnock, NoiseKind::PedalDown, NoiseKind::PedalUp];

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct NoiseShape {
    pub hp_hz: f32,
    pub lp_hz: f32,
    pub attack_s: f32,
    pub decay_s: f32,
    /// Share sent to the direct output.
    pub direct: f32,
    /// Share sent into the board.
    pub board: f32,
}

pub fn shape(kind: NoiseKind) -> NoiseShape {
    match kind {
        // Keybed thud, low.
        NoiseKind::KeyDown => NoiseShape { hp_hz: 40.0, lp_hz: 400.0, attack_s: 0.001, decay_s: 0.012, direct: 1.0, board: 0.0 },
        // Felt contact.
        NoiseKind::KeyUp => NoiseShape { hp_hz: 100.0, lp_hz: 1500.0, attack_s: 0.001, decay_s: 0.020, direct: 1.0, board: 0.0 },
        // Impact of the hammer on the strings, transmitted to the bridge.
        NoiseKind::HammerKnock => NoiseShape { hp_hz: 800.0, lp_hz: 6000.0, attack_s: 0.0002, decay_s: 0.002, direct: 0.0, board: 1.0 },
        // Damper felts leaving all strings, a soft whoosh into the board, plus the trapwork.
        NoiseKind::PedalDown => NoiseShape { hp_hz: 80.0, lp_hz: 2500.0, attack_s: 0.015, decay_s: 0.080, direct: 0.5, board: 1.0 },
        // Dampers landing and the pedal thump.
        NoiseKind::PedalUp => NoiseShape { hp_hz: 40.0, lp_hz: 600.0, attack_s: 0.003, decay_s: 0.050, direct: 0.5, board: 1.0 },
    }
}

/// 2nd-order Butterworth low-pass, the same layout as soundboard::highpass_coefs: [b0, b1, b2, a1, a2].
pub fn lowpass_coefs(hz: f32, sample_rate: f32) -> [f32; 5] {
    let fs = sample_rate as f64;
    let f = (hz as f64).min(0.45 * fs);
    let w0 = 2.0 * std::f64::consts::PI * f / fs;
    let (sin, cos) = w0.sin_cos();
    let alpha = sin / (2.0 / std::f64::consts::SQRT_2);
    let a0 = 1.0 + alpha;
    let b0 = (1.0 - cos) / 2.0 / a0;
    let b1 = (1.0 - cos) / a0;
    let a1 = -2.0 * cos / a0;
    let a2 = (1.0 - alpha) / a0;
    [b0 as f32, b1 as f32, b0 as f32, a1 as f32, a2 as f32]
}

#[derive(Clone, Copy)]
struct KindCoefs {
    hp: [f32; 5],
    lp: [f32; 5],
    norm: f32,
    ed: f32,
    ea: f32,
    len: usize,
    inv_peak: f32,
    direct: f32,
    board: f32,
}

#[derive(Clone, Copy, Default)]
struct Biquad {
    x1: f32,
    x2: f32,
    y1: f32,
    y2: f32,
}

impl Biquad {
    #[inline]
    fn run(&mut self, c: &[f32; 5], x: f32) -> f32 {
        let y = c[0] * x + c[1] * self.x1 + c[2] * self.x2 - c[3] * self.y1 - c[4] * self.y2;
        self.x2 = self.x1;
        self.x1 = x;
        self.y2 = self.y1;
        self.y1 = y;
        y
    }
}

#[derive(Clone, Copy)]
struct Slot {
    active: bool,
    kind: usize,
    amp: f32,
    pan_l: f32,
    pan_r: f32,
    rng: u32,
    d: f32,
    a: f32,
    left: usize,
    hp: Biquad,
    lp: Biquad,
}

const EMPTY: Slot = Slot {
    active: false,
    kind: 0,
    amp: 0.0,
    pan_l: 0.0,
    pan_r: 0.0,
    rng: 1,
    d: 1.0,
    a: 1.0,
    left: 0,
    hp: Biquad { x1: 0.0, x2: 0.0, y1: 0.0, y2: 0.0 },
    lp: Biquad { x1: 0.0, x2: 0.0, y1: 0.0, y2: 0.0 },
};

pub struct Noises {
    slots: [Slot; MAX_NOISES],
    coefs: [KindCoefs; KINDS],
}

fn kind_coefs(kind: NoiseKind, fs: f32) -> KindCoefs {
    let s = shape(kind);
    let hp = highpass_coefs(s.hp_hz, fs);
    let lp = lowpass_coefs(s.lp_hz, fs);
    let (mut h, mut l) = ([0.0f64; 5], [0.0f64; 5]);
    for i in 0..5 {
        h[i] = hp[i] as f64;
        l[i] = lp[i] as f64;
    }
    let mut e = 0.0f64;
    let (mut hx1, mut hx2, mut hy1, mut hy2) = (0.0f64, 0.0f64, 0.0f64, 0.0f64);
    let (mut lx1, mut lx2, mut ly1, mut ly2) = (0.0f64, 0.0f64, 0.0f64, 0.0f64);
    for n in 0..8192 {
        let x = if n == 0 { 1.0 } else { 0.0 };
        let y = h[0] * x + h[1] * hx1 + h[2] * hx2 - h[3] * hy1 - h[4] * hy2;
        hx2 = hx1;
        hx1 = x;
        hy2 = hy1;
        hy1 = y;
        let z = l[0] * y + l[1] * lx1 + l[2] * lx2 - l[3] * ly1 - l[4] * ly2;
        lx2 = lx1;
        lx1 = y;
        ly2 = ly1;
        ly1 = z;
        e += z * z;
    }
    let norm = (1.0 / (e / 3.0).sqrt()) as f32;
    let fs64 = fs as f64;
    let ed = (-1.0 / (s.decay_s as f64 * fs64)).exp();
    let ea = (-1.0 / (s.attack_s as f64 * fs64)).exp();
    let len = ((s.attack_s as f64 + 7.0 * s.decay_s as f64) * fs64).ceil() as usize;
    let mut peak = 0.0f64;
    for i in 0..len {
        peak = peak.max(ed.powi(i as i32) - ea.powi(i as i32));
    }
    KindCoefs { hp, lp, norm, ed: ed as f32, ea: ea as f32, len, inv_peak: (1.0 / peak) as f32, direct: s.direct, board: s.board }
}

impl Noises {
    pub fn new(sample_rate: f32) -> Self {
        Self { slots: [EMPTY; MAX_NOISES], coefs: ALL_KINDS.map(|k| kind_coefs(k, sample_rate)) }
    }

    pub fn start(&mut self, kind: NoiseKind, amp_n: f32, pan_l: f32, pan_r: f32, seed: u32) {
        if amp_n.is_nan() || amp_n <= 0.0 {
            return;
        }
        let i = match self.slots.iter().position(|s| !s.active) {
            Some(i) => i,
            None => self.slots.iter().enumerate().min_by_key(|(_, s)| s.left).map_or(0, |(i, _)| i),
        };
        let k = kind as usize;
        self.slots[i] = Slot {
            active: true,
            kind: k,
            amp: amp_n,
            pan_l,
            pan_r,
            rng: if seed == 0 { 1 } else { seed },
            d: 1.0,
            a: 1.0,
            left: self.coefs[k].len,
            hp: Biquad::default(),
            lp: Biquad::default(),
        };
    }

    /// Adds every active burst into the slices.
    pub fn render(&mut self, direct_l: &mut [f32], direct_r: &mut [f32], board: &mut [f32]) {
        let n = direct_l.len().min(direct_r.len()).min(board.len());
        for s in self.slots.iter_mut().filter(|s| s.active) {
            let c = &self.coefs[s.kind];
            let m = n.min(s.left);
            for t in 0..m {
                s.rng ^= s.rng << 13;
                s.rng ^= s.rng >> 17;
                s.rng ^= s.rng << 5;
                let u = (s.rng >> 8) as f32 / 8388608.0 - 1.0;
                let x = s.hp.run(&c.hp, u);
                let y = s.lp.run(&c.lp, x);
                let v = y * c.norm * (s.d - s.a) * c.inv_peak * s.amp;
                direct_l[t] += v * c.direct * s.pan_l;
                direct_r[t] += v * c.direct * s.pan_r;
                board[t] += v * c.board;
                s.d *= c.ed;
                s.a *= c.ea;
            }
            s.left -= m;
            if s.left == 0 {
                s.active = false;
            }
        }
    }

    pub fn active(&self) -> usize {
        self.slots.iter().filter(|s| s.active).count()
    }

    /// True while any active burst has a board part.
    pub fn board_active(&self) -> bool {
        self.slots.iter().any(|s| s.active && self.coefs[s.kind].board > 0.0)
    }

    pub fn clear(&mut self) {
        self.slots = [EMPTY; MAX_NOISES];
    }
}

pub fn noise_seed(kind: NoiseKind, note: u8, velocity: u8) -> u32 {
    let s = (kind as u32 + 1).wrapping_mul(0x9E37_79B9) ^ (note as u32).wrapping_mul(0x85EB_CA6B) ^ (velocity as u32 + 1).wrapping_mul(0xC2B2_AE35);
    if s == 0 {
        1
    } else {
        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rustfft::{num_complex::Complex, FftPlanner};

    const FS: f32 = 48000.0;

    fn run(kind: NoiseKind, amp: f32, frames: usize) -> (Noises, Vec<f32>, Vec<f32>) {
        let mut n = Noises::new(FS);
        n.start(kind, amp, 0.7, 0.7, 1234);
        let mut dl = vec![0.0f32; frames];
        let mut dr = vec![0.0f32; frames];
        let mut bd = vec![0.0f32; frames];
        for o in (0..frames).step_by(64) {
            let e = (o + 64).min(frames);
            n.render(&mut dl[o..e], &mut dr[o..e], &mut bd[o..e]);
        }
        let main = if shape(kind).board > 0.0 { bd } else { dl };
        (n, main, dr)
    }

    #[test]
    fn noise_bursts_repeat_and_stay_bounded() {
        for kind in ALL_KINDS {
            let (n1, a, _) = run(kind, 1.0, 48000);
            let (_, b, _) = run(kind, 1.0, 48000);
            assert_eq!(a, b, "{kind:?}");
            assert!(a.iter().all(|x| x.is_finite()), "{kind:?}");
            assert_eq!(n1.active(), 0, "{kind:?}");
            let c = kind_coefs(kind, FS);
            let sh = shape(kind);
            let mut expected = 0.0f64;
            for i in 0..c.len {
                let env = (c.ed as f64).powi(i as i32) - (c.ea as f64).powi(i as i32);
                let env = env * c.inv_peak as f64;
                expected += env * env;
            }
            if sh.board > 0.0 {
                expected *= (sh.board as f64).powi(2);
            } else {
                expected *= (sh.direct as f64).powi(2) * 0.49;
            }
            let energy: f64 = a.iter().map(|&x| (x as f64) * (x as f64)).sum();
            let ratio = energy / expected;
            println!("{kind:?}: energy ratio {ratio:.3}");
            assert!(ratio > 0.25 && ratio < 4.0, "{kind:?} ratio {ratio}");
        }
    }

    #[test]
    fn zero_level_starts_nothing() {
        let mut n = Noises::new(FS);
        n.start(NoiseKind::KeyDown, 0.0, 0.7, 0.7, 5);
        n.start(NoiseKind::KeyDown, f32::NAN, 0.7, 0.7, 5);
        assert_eq!(n.active(), 0);
        let (mut a, mut b, mut c) = ([0.0f32; 64], [0.0f32; 64], [0.0f32; 64]);
        n.render(&mut a, &mut b, &mut c);
        assert!(a.iter().chain(b.iter()).chain(c.iter()).all(|&x| x == 0.0));
    }

    #[test]
    fn pool_overflow_keeps_thirty_two() {
        let mut n = Noises::new(FS);
        for i in 0..40u32 {
            n.start(NoiseKind::KeyUp, 1.0, 0.7, 0.7, i + 1);
        }
        assert_eq!(n.active(), MAX_NOISES);
        let (mut a, mut b, mut c) = (vec![0.0f32; 48000], vec![0.0f32; 48000], vec![0.0f32; 48000]);
        for o in (0..48000).step_by(64) {
            let e = o + 64;
            n.render(&mut a[o..e], &mut b[o..e], &mut c[o..e]);
        }
        assert_eq!(n.active(), 0);
        assert!(a.iter().chain(b.iter()).chain(c.iter()).all(|x| x.is_finite()));
    }

    fn centroid(x: &[f32]) -> f64 {
        let n = x.len();
        let mut buf: Vec<Complex<f32>> = (0..n)
            .map(|i| {
                let w = 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / n as f32).cos();
                Complex::new(x[i] * w, 0.0)
            })
            .collect();
        FftPlanner::<f32>::new().plan_fft_forward(n).process(&mut buf);
        let (mut num, mut den) = (0.0f64, 0.0f64);
        for (k, c) in buf.iter().enumerate().take(n / 2) {
            let m = c.norm() as f64;
            num += m * k as f64;
            den += m;
        }
        num / den * FS as f64 / n as f64
    }

    #[test]
    fn spectra_follow_kind() {
        let (_, knock, _) = run(NoiseKind::HammerKnock, 1.0, 4096);
        let (_, thump, _) = run(NoiseKind::KeyDown, 1.0, 4096);
        let (ck, ct) = (centroid(&knock), centroid(&thump));
        println!("centroid knock {ck:.0} Hz, thump {ct:.0} Hz");
        assert!(ck >= 4.0 * ct, "knock {ck} thump {ct}");
    }
}
