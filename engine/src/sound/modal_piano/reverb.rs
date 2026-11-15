//! Optional room reverb: a feedback network of 8 delay lines with an orthogonal (scaled Hadamard) mixing matrix,
//! a one-pole lowpass and a decay gain per line, a mono input with a pre-gap and two decorrelated output taps.
//! It is passive by design: the mixing matrix is orthogonal, every decay gain is below 1 and the lowpass gain is at most 1.
//! All buffers are allocated once in `new()`; `configure` and `process` never allocate.

use super::profile::ModalReverb;

pub const LINES: usize = 8;
const BASE_MS: [f32; LINES] = [29.7, 37.1, 41.1, 43.7, 53.3, 59.9, 67.1, 79.3];
pub const MAX_SIZE: f32 = 2.0;
pub const MAX_PRE_MS: f32 = 200.0;
const IN_SIGN: [f32; LINES] = [1.0, -1.0, 1.0, -1.0, 1.0, -1.0, 1.0, -1.0];
const LEFT_SIGN: [f32; LINES] = [1.0, 1.0, -1.0, -1.0, 1.0, 1.0, -1.0, -1.0];
const RIGHT_SIGN: [f32; LINES] = [1.0, -1.0, 1.0, -1.0, -1.0, 1.0, -1.0, 1.0];
const TINY: f32 = 1e-20;
const T60_CAL: f32 = 1.144;
const CAL_HZ: [f32; 7] = [1000.0, 2000.0, 3000.0, 5000.0, 8000.0, 12000.0, 20000.0];
const CAL_EXTRA: [f32; 7] = [0.124, 0.086, 0.074, 0.064, 0.042, 0.024, 0.0];

/// Decay-gain calibration: the in-loop lowpass shortens T60 by a factor 1 / (1 + extra), where `extra` is measured
/// at decay 1 s (table, interpolated in log-frequency) and falls off as decay^-0.57.
fn t60_cal(damping_hz: f32, decay_s: f32) -> f32 {
    let f = damping_hz.clamp(CAL_HZ[0], CAL_HZ[CAL_HZ.len() - 1]);
    let mut extra = CAL_EXTRA[CAL_EXTRA.len() - 1];
    for i in 1..CAL_HZ.len() {
        if f <= CAL_HZ[i] {
            let t = (f / CAL_HZ[i - 1]).ln() / (CAL_HZ[i] / CAL_HZ[i - 1]).ln();
            extra = CAL_EXTRA[i - 1] + t * (CAL_EXTRA[i] - CAL_EXTRA[i - 1]);
            break;
        }
    }
    T60_CAL * (1.0 + extra * decay_s.clamp(0.3, 10.0).powf(-0.57))
}

#[inline]
fn flush(v: f32) -> f32 {
    if v.abs() < TINY {
        0.0
    } else {
        v
    }
}

pub struct Reverb {
    lines: [Vec<f32>; LINES],
    pos: [usize; LINES],
    d: [usize; LINES],
    g: [f32; LINES],
    lp: [f32; LINES],
    a: f32,
    pre: Vec<f32>,
    pre_pos: usize,
    pre_d: usize,
    mix: f32,
    target: f32,
    coef: f32,
    ran: bool,
    sample_rate: f32,
}

impl Reverb {
    pub fn new(sample_rate: f32) -> Self {
        let sr = sample_rate;
        let lines = std::array::from_fn(|i| vec![0.0f32; (BASE_MS[i] * MAX_SIZE * sr / 1000.0).ceil() as usize + 2]);
        let pre = vec![0.0f32; (MAX_PRE_MS * sr / 1000.0).ceil() as usize + 2];
        Self {
            lines,
            pos: [0; LINES],
            d: [1; LINES],
            g: [0.0; LINES],
            lp: [0.0; LINES],
            a: 0.0,
            pre,
            pre_pos: 0,
            pre_d: 0,
            mix: 0.0,
            target: 0.0,
            coef: 1.0 - (-1.0 / (0.02 * sr)).exp(),
            ran: false,
            sample_rate: sr,
        }
    }

    pub fn configure(&mut self, r: &ModalReverb) {
        let sr = self.sample_rate;
        if self.mix == 0.0 && r.mix > 0.0 {
            self.clear();
        }
        let cal = t60_cal(r.damping_hz, r.decay_s);
        #[allow(clippy::needless_range_loop)] // index spans several parallel arrays; iterator form would complicate borrows on the audio path
        for i in 0..LINES {
            let cap = self.lines[i].len();
            let d = ((BASE_MS[i] * r.size * sr / 1000.0).round() as usize).clamp(1, cap - 1);
            self.d[i] = d;
            self.g[i] = 10f32.powf(-3.0 * d as f32 / (r.decay_s * cal * sr));
        }
        self.a = (-2.0 * std::f32::consts::PI * r.damping_hz / sr).exp();
        self.pre_d = (r.predelay_ms * sr / 1000.0).round() as usize;
        self.target = r.mix;
        if !self.ran {
            self.mix = r.mix;
        }
    }

    pub fn is_active(&self) -> bool {
        self.target > 0.0
    }

    pub fn is_running(&self) -> bool {
        self.mix > 0.0 || self.target > 0.0
    }

    pub fn clear(&mut self) {
        for l in self.lines.iter_mut() {
            l.fill(0.0);
        }
        self.pre.fill(0.0);
        self.lp = [0.0; LINES];
    }

    #[inline]
    pub fn process(&mut self, l: f32, r: f32) -> (f32, f32) {
        let k = 1.0 / (LINES as f32).sqrt();
        let x = 0.5 * (l + r);
        let pc = self.pre.len();
        self.pre[self.pre_pos] = x;
        let xp = if self.pre_d == 0 { x } else { self.pre[(self.pre_pos + pc - self.pre_d) % pc] };
        self.pre_pos = (self.pre_pos + 1) % pc;

        let mut o = [0.0f32; LINES];
        let mut y = [0.0f32; LINES];
        for i in 0..LINES {
            let cap = self.lines[i].len();
            o[i] = self.lines[i][(self.pos[i] + cap - self.d[i]) % cap];
            self.lp[i] = flush((1.0 - self.a) * o[i] + self.a * self.lp[i]);
            y[i] = self.g[i] * self.lp[i];
        }
        let mut h = 1;
        while h < LINES {
            let mut i = 0;
            while i < LINES {
                for j in i..i + h {
                    let (p, q) = (y[j], y[j + h]);
                    y[j] = p + q;
                    y[j + h] = p - q;
                }
                i += 2 * h;
            }
            h *= 2;
        }
        let (mut wl, mut wr) = (0.0f32, 0.0f32);
        for i in 0..LINES {
            let cap = self.lines[i].len();
            self.lines[i][self.pos[i]] = flush(k * y[i] + IN_SIGN[i] * k * xp);
            self.pos[i] = (self.pos[i] + 1) % cap;
            wl += LEFT_SIGN[i] * o[i];
            wr += RIGHT_SIGN[i] * o[i];
        }
        let out = (self.mix * k * wl, self.mix * k * wr);
        self.ran = true;
        self.mix += (self.target - self.mix) * self.coef;
        if (self.target - self.mix).abs() < 1e-6 {
            self.mix = self.target;
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(mix: f32, size: f32, decay_s: f32, damping_hz: f32, predelay_ms: f32) -> ModalReverb {
        ModalReverb { mix, size, decay_s, damping_hz, predelay_ms }
    }

    fn impulse_response(rv: &mut Reverb, n: usize) -> (Vec<f32>, Vec<f32>) {
        let mut l = Vec::with_capacity(n);
        let mut r = Vec::with_capacity(n);
        for i in 0..n {
            let x = if i == 0 { 1.0 } else { 0.0 };
            let (a, b) = rv.process(x, x);
            l.push(a);
            r.push(b);
        }
        (l, r)
    }

    fn measure_t60(sr: f32, decay_s: f32, damping_hz: f32) -> f64 {
        let mut rv = Reverb::new(sr);
        rv.configure(&cfg(1.0, 1.0, decay_s, damping_hz, 0.0));
        let n = (1.5 * decay_s * sr) as usize;
        let (l, r) = impulse_response(&mut rv, n);
        let frame = (0.05 * sr) as usize;
        let energy: Vec<f64> = l
            .chunks(frame)
            .zip(r.chunks(frame))
            .map(|(a, b)| a.iter().zip(b).map(|(&x, &y)| (x as f64).powi(2) + (y as f64).powi(2)).sum::<f64>())
            .collect();
        let mut sch = vec![0.0f64; energy.len()];
        let mut acc = 0.0;
        for i in (0..energy.len()).rev() {
            acc += energy[i];
            sch[i] = acc;
        }
        let db: Vec<f64> = sch.iter().map(|&e| 10.0 * (e / sch[0]).log10()).collect();
        let i0 = db.iter().position(|&v| v <= -5.0).unwrap();
        let i1 = db.iter().position(|&v| v <= -35.0).unwrap();
        let pts: Vec<(f64, f64)> = (i0..=i1).map(|i| (i as f64 * 0.05, db[i])).collect();
        let m = pts.len() as f64;
        let mx = pts.iter().map(|p| p.0).sum::<f64>() / m;
        let my = pts.iter().map(|p| p.1).sum::<f64>() / m;
        let sxy: f64 = pts.iter().map(|p| (p.0 - mx) * (p.1 - my)).sum();
        let sxx: f64 = pts.iter().map(|p| (p.0 - mx).powi(2)).sum();
        60.0 / -(sxy / sxx)
    }

    #[test]
    fn reverb_decay_time_matches_setting() {
        let sr = 48000.0f32;
        for damping_hz in [1000.0f32, 2000.0, 3000.0, 5000.0, 8000.0, 12000.0, 20000.0] {
            for decay_s in [1.0f32, 3.0] {
                let t60 = measure_t60(sr, decay_s, damping_hz);
                println!("reverb damping {damping_hz} decay_s {decay_s}: measured T60 {t60:.3} s");
                assert!((t60 / decay_s as f64 - 1.0).abs() <= 0.02, "damping {damping_hz} decay_s {decay_s}: T60 {t60}");
            }
        }
    }

    #[test]
    fn reverb_is_stable_at_extremes() {
        for sr in [44100.0f32, 96000.0] {
            for size in [0.5f32, 2.0] {
                let mut rv = Reverb::new(sr);
                rv.configure(&cfg(1.0, size, 10.0, 20000.0, 15.0));
                let mut seed: u32 = 12345;
                let input = (0.5 * sr) as usize;
                let win = sr as usize;
                let mut energies = Vec::new();
                let mut e = 0.0f64;
                let mut count = 0;
                for i in 0..input + 10 * win {
                    let x = if i < input {
                        seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
                        (seed >> 8) as f32 / (1u32 << 24) as f32 - 0.5
                    } else {
                        0.0
                    };
                    let (l, r) = rv.process(x, x);
                    assert!(l.is_finite() && r.is_finite(), "sr {sr} size {size}: not finite at {i}");
                    if i >= input {
                        e += (l as f64).powi(2) + (r as f64).powi(2);
                        count += 1;
                        if count == win {
                            energies.push(e);
                            e = 0.0;
                            count = 0;
                        }
                    }
                }
                for w in energies.windows(2) {
                    assert!(w[1] <= 1.01 * w[0], "sr {sr} size {size}: energy {} after {}", w[1], w[0]);
                }
            }
        }
    }

    #[test]
    fn reverb_silent_input_gives_silence() {
        let mut rv = Reverb::new(48000.0);
        rv.configure(&cfg(0.3, 1.0, 1.6, 5000.0, 15.0));
        for _ in 0..4096 {
            assert_eq!(rv.process(0.0, 0.0), (0.0, 0.0));
        }
    }

    #[test]
    fn reverb_waits_for_lead_in() {
        let mut rv = Reverb::new(48000.0);
        rv.configure(&cfg(1.0, 1.0, 1.6, 5000.0, 50.0));
        let (l, r) = impulse_response(&mut rv, 48000);
        let first = l.iter().zip(&r).position(|(&a, &b)| a != 0.0 || b != 0.0).unwrap();
        let want = (0.05f64 * 48000.0).round() as usize + (29.7f64 * 48.0).round() as usize - 1;
        assert!(first >= want, "first non-zero {first}, want >= {want}");
    }

    #[test]
    fn reverb_channels_differ() {
        let mut rv = Reverb::new(48000.0);
        rv.configure(&cfg(1.0, 1.0, 1.6, 5000.0, 15.0));
        let (l, r) = impulse_response(&mut rv, 48000);
        let n = l.len() as f64;
        let ml = l.iter().map(|&x| x as f64).sum::<f64>() / n;
        let mr = r.iter().map(|&x| x as f64).sum::<f64>() / n;
        let (mut sxy, mut sxx, mut syy) = (0.0, 0.0, 0.0);
        for (&a, &b) in l.iter().zip(&r) {
            let (x, y) = (a as f64 - ml, b as f64 - mr);
            sxy += x * y;
            sxx += x * x;
            syy += y * y;
        }
        let c = sxy / (sxx * syy).sqrt();
        println!("reverb L/R correlation {c:.4}");
        assert!(c.abs() < 0.5, "correlation {c}");
    }

    #[test]
    fn mix_to_zero_fades_without_click() {
        let sr = 48000.0f32;
        let mut a = Reverb::new(sr);
        let mut b = Reverb::new(sr);
        a.configure(&cfg(0.5, 1.0, 2.0, 8000.0, 0.0));
        b.configure(&cfg(0.5, 1.0, 2.0, 8000.0, 0.0));
        let mut seed: u32 = 777;
        for _ in 0..(0.2 * sr) as usize {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            let x = (seed >> 8) as f32 / (1u32 << 24) as f32 - 0.5;
            a.process(x, x);
            b.process(x, x);
        }
        for _ in 0..(0.3 * sr) as usize {
            a.process(0.0, 0.0);
            b.process(0.0, 0.0);
        }
        a.configure(&cfg(0.0, 1.0, 2.0, 8000.0, 0.0));
        let n = (0.3 * sr) as usize;
        let hundred = (0.1 * sr) as usize;
        for i in 0..n {
            let (ya, _) = a.process(0.0, 0.0);
            let (yb, _) = b.process(0.0, 0.0);
            if i == 0 {
                assert!(ya.abs() / yb.abs() >= 0.9, "first ratio {}", ya / yb);
            }
            if i == hundred {
                assert!(ya.abs() / yb.abs() <= 0.01, "ratio at 100 ms {}", ya / yb);
            }
        }
        assert!(!a.is_running());
    }

    #[test]
    fn reverb_off_by_default() {
        assert_eq!(ModalReverb::default().mix, 0.0);
        let mut rv = Reverb::new(48000.0);
        rv.configure(&ModalReverb::default());
        assert!(!rv.is_active());
    }
}
