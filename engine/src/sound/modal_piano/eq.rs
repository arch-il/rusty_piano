//! Output EQ: a low shelf, three peaking bands and a high shelf, RBJ cookbook biquads in f64, stereo, allocation-free.

use super::profile::ModalEq;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BandKind {
    LowShelf,
    Peak,
    HighShelf,
}

/// Coefficients [b0, b1, b2, a1, a2], already divided by a0.
pub fn band_coefs(kind: BandKind, f_hz: f64, gain_db: f64, q: f64, sample_rate: f64) -> [f64; 5] {
    let f = f_hz.clamp(10.0, 0.45 * sample_rate);
    let a = 10f64.powf(gain_db / 40.0);
    let w0 = 2.0 * std::f64::consts::PI * f / sample_rate;
    let c = w0.cos();
    let s = w0.sin();
    let (b0, b1, b2, a0, a1, a2) = match kind {
        BandKind::Peak => {
            let alpha = s / (2.0 * q);
            (1.0 + alpha * a, -2.0 * c, 1.0 - alpha * a, 1.0 + alpha / a, -2.0 * c, 1.0 - alpha / a)
        }
        BandKind::LowShelf => {
            let alpha = s / 2.0 * 2f64.sqrt();
            let r = 2.0 * a.sqrt() * alpha;
            (
                a * ((a + 1.0) - (a - 1.0) * c + r),
                2.0 * a * ((a - 1.0) - (a + 1.0) * c),
                a * ((a + 1.0) - (a - 1.0) * c - r),
                (a + 1.0) + (a - 1.0) * c + r,
                -2.0 * ((a - 1.0) + (a + 1.0) * c),
                (a + 1.0) + (a - 1.0) * c - r,
            )
        }
        BandKind::HighShelf => {
            let alpha = s / 2.0 * 2f64.sqrt();
            let r = 2.0 * a.sqrt() * alpha;
            (
                a * ((a + 1.0) + (a - 1.0) * c + r),
                -2.0 * a * ((a - 1.0) + (a + 1.0) * c),
                a * ((a + 1.0) + (a - 1.0) * c - r),
                (a + 1.0) - (a - 1.0) * c + r,
                2.0 * ((a - 1.0) - (a + 1.0) * c),
                (a + 1.0) - (a - 1.0) * c - r,
            )
        }
    };
    [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0]
}

fn band_list(eq: &ModalEq) -> [(BandKind, f64, f64, f64); 5] {
    [
        (BandKind::LowShelf, eq.low_shelf_hz as f64, eq.low_shelf_db as f64, 1.0),
        (BandKind::Peak, eq.peak1_hz as f64, eq.peak1_db as f64, eq.peak1_q as f64),
        (BandKind::Peak, eq.peak2_hz as f64, eq.peak2_db as f64, eq.peak2_q as f64),
        (BandKind::Peak, eq.peak3_hz as f64, eq.peak3_db as f64, eq.peak3_q as f64),
        (BandKind::HighShelf, eq.high_shelf_hz as f64, eq.high_shelf_db as f64, 1.0),
    ]
}

/// Summed dB response of the bands whose gain is not 0.0.
pub fn magnitude_db(eq: &ModalEq, f_hz: f64, sample_rate: f64) -> f64 {
    let w = 2.0 * std::f64::consts::PI * f_hz / sample_rate;
    let (c1, s1) = (w.cos(), -w.sin());
    let (c2, s2) = ((2.0 * w).cos(), -(2.0 * w).sin());
    let mut total = 0.0;
    for (kind, f, g, q) in band_list(eq) {
        if g == 0.0 {
            continue;
        }
        let k = band_coefs(kind, f, g, q, sample_rate);
        let nr = k[0] + k[1] * c1 + k[2] * c2;
        let ni = k[1] * s1 + k[2] * s2;
        let dr = 1.0 + k[3] * c1 + k[4] * c2;
        let di = k[3] * s1 + k[4] * s2;
        total += 10.0 * ((nr * nr + ni * ni) / (dr * dr + di * di)).log10();
    }
    total
}

#[derive(Debug, Clone, Copy, Default)]
struct Biquad {
    c: [f64; 5],
    z1: [f64; 2],
    z2: [f64; 2],
}

pub struct OutputEq {
    bands: [Biquad; 5],
    active: [bool; 5],
    any: bool,
}

impl OutputEq {
    pub fn new() -> Self {
        Self { bands: [Biquad::default(); 5], active: [false; 5], any: false }
    }

    /// Recompute the coefficients; the filter state is kept, except that a band switched off is cleared so switching it on again starts clean.
    pub fn configure(&mut self, eq: &ModalEq, sample_rate: f32) {
        for (k, (kind, f, g, q)) in band_list(eq).into_iter().enumerate() {
            let was = self.active[k];
            self.bands[k].c = band_coefs(kind, f, g, q, sample_rate as f64);
            self.active[k] = g != 0.0;
            if was && !self.active[k] {
                self.bands[k].z1 = [0.0; 2];
                self.bands[k].z2 = [0.0; 2];
            }
        }
        self.any = self.active.iter().any(|&a| a);
    }

    pub fn is_active(&self) -> bool {
        self.any
    }

    #[inline]
    pub fn process(&mut self, l: f32, r: f32) -> (f32, f32) {
        let mut x = [l as f64, r as f64];
        for k in 0..5 {
            if !self.active[k] {
                continue;
            }
            let b = &mut self.bands[k];
            for (ch, xc) in x.iter_mut().enumerate() {
                let y = b.c[0] * *xc + b.z1[ch];
                b.z1[ch] = b.c[1] * *xc - b.c[3] * y + b.z2[ch];
                b.z2[ch] = b.c[2] * *xc - b.c[4] * y;
                *xc = y;
            }
        }
        (x[0] as f32, x[1] as f32)
    }

    pub fn flush_tiny(&mut self) {
        for b in self.bands.iter_mut() {
            for ch in 0..2 {
                if b.z1[ch].abs() < 1e-30 {
                    b.z1[ch] = 0.0;
                }
                if b.z2[ch].abs() < 1e-30 {
                    b.z2[ch] = 0.0;
                }
            }
        }
    }

    pub fn clear(&mut self) {
        for b in self.bands.iter_mut() {
            b.z1 = [0.0; 2];
            b.z2 = [0.0; 2];
        }
    }
}

impl Default for OutputEq {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: f64 = 48000.0;

    #[test]
    fn eq_response_matches_gain_at_centre() {
        let peak = ModalEq { peak2_hz: 1000.0, peak2_db: 6.0, peak2_q: 1.0, ..ModalEq::default() };
        assert!((magnitude_db(&peak, 1000.0, SR) - 6.0).abs() < 0.05);
        assert!(magnitude_db(&peak, 50.0, SR).abs() < 0.3);
        assert!(magnitude_db(&peak, 15000.0, SR).abs() < 0.3);

        let low = ModalEq { low_shelf_hz: 120.0, low_shelf_db: 4.0, ..ModalEq::default() };
        assert!((magnitude_db(&low, 20.0, SR) - 4.0).abs() < 0.3);
        assert!(magnitude_db(&low, 5000.0, SR).abs() < 0.3);

        let high = ModalEq { high_shelf_hz: 6000.0, high_shelf_db: -3.0, ..ModalEq::default() };
        assert!((magnitude_db(&high, 18000.0, SR) + 3.0).abs() < 0.3);
        assert!(magnitude_db(&high, 100.0, SR).abs() < 0.2);
    }

    #[test]
    fn eq_process_matches_magnitude() {
        let cfg = ModalEq { peak2_hz: 1000.0, peak2_db: 6.0, peak2_q: 1.0, ..ModalEq::default() };
        let mut e = OutputEq::new();
        e.configure(&cfg, 48000.0);
        let n = 48000;
        let (mut pl, mut pr) = (0.0f32, 0.0f32);
        for i in 0..n {
            let x = 0.25 * (2.0 * std::f64::consts::PI * 1000.0 * i as f64 / SR).sin() as f32;
            let (l, r) = e.process(x, x);
            if i >= n - 9600 {
                pl = pl.max(l.abs());
                pr = pr.max(r.abs());
            }
        }
        let want = 10f32.powf(6.0 / 20.0);
        assert!((pl / 0.25 / want - 1.0).abs() < 0.01, "left {}", pl / 0.25);
        assert!((pr / 0.25 / want - 1.0).abs() < 0.01, "right {}", pr / 0.25);
    }

    #[test]
    fn eq_switch_off_clears_state() {
        let on = ModalEq { peak2_hz: 1000.0, peak2_db: 6.0, peak2_q: 1.0, ..ModalEq::default() };
        let mut e = OutputEq::new();
        e.configure(&on, 48000.0);
        for i in 0..1000 {
            let x = 0.25 * (2.0 * std::f64::consts::PI * 1000.0 * i as f64 / SR).sin() as f32;
            e.process(x, x);
        }
        e.configure(&ModalEq::default(), 48000.0);
        e.configure(&on, 48000.0);
        let mut fresh = OutputEq::new();
        fresh.configure(&on, 48000.0);
        for i in 0..200 {
            let x = 0.1 * ((i * 7 % 13) as f32 - 6.0);
            assert_eq!(e.process(x, -x), fresh.process(x, -x), "sample {i}");
        }
    }

    #[test]
    fn eq_flat_is_inactive() {
        let mut e = OutputEq::new();
        e.configure(&ModalEq::default(), 48000.0);
        assert!(!e.is_active());
        assert!(ModalEq::default().is_flat());
    }
}
