//! Per-note features for fitting: peak level, spectral centroid, pitch and inharmonicity, held drops, tail slope and release time.

use crate::metrics;
use rustfft::{num_complex::Complex, FftPlanner};
use std::f64::consts::PI;

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct NoteFeatures {
    /// Largest level of a 50 ms window (10 ms hop) inside the first 0.5 s, in dB; -150 if none.
    pub peak_db: f64,
    /// Magnitude-spectrum centroid (20 Hz to 16 kHz) of a Hann window starting at 0.02 s.
    pub centroid_hz: Option<f64>,
    /// The same centroid from 1.0 s; only when hold_s >= 1.2.
    pub late_centroid_hz: Option<f64>,
    /// Fundamental from the partial regression over [0.1, min(hold_s, 1.1)] s; only when hold_s >= 1.2.
    pub f0_hz: Option<f64>,
    /// f0_hz relative to equal temperament (A4 = 440 Hz), in cents.
    pub cents: Option<f64>,
    /// Inharmonicity B from the fit (f/n)^2 = A + C n^2, B = C / A; needs 4 or more partials.
    pub inharmonicity: Option<f64>,
    /// peak50 minus the median of nine 50 ms frames centred on 0.975 s, robust to beat nulls; only when hold_s >= 1.2.
    pub d1_db: Option<f64>,
    /// peak50 minus the median of nine 50 ms frames centred on 1.975 s, robust to beat nulls; only when hold_s >= 2.2.
    pub d2_db: Option<f64>,
    /// Negative least-squares slope of 50 ms frame levels in [max(1, hold_s / 2), hold_s - 0.1] s, dB/s.
    pub tail_db_per_s: Option<f64>,
    /// Time after key-up until a 10 ms frame is 30 dB below the first one, in ms.
    pub release_ms: Option<f64>,
    /// Median of the ten 50 ms frame levels from 1.0 s to 1.5 s after key-up, minus peak50 (a negative number); only when the signal extends 1.5 s past key-up and that median is above peak50 - 100 dB.
    pub late_release_db: Option<f64>,
}

fn level_db(x: &[f32]) -> f64 {
    let mean = x.iter().map(|&v| v as f64 * v as f64).sum::<f64>() / x.len().max(1) as f64;
    (10.0 * (mean + 1e-30).log10()).max(-150.0)
}

fn spectrum(x: &[f32], start: usize, len: usize, n: usize) -> Vec<f64> {
    let mut buf: Vec<Complex<f64>> = (0..n)
        .map(|i| {
            let v = if i < len && start + i < x.len() {
                let w = 0.5 - 0.5 * (2.0 * PI * i as f64 / len as f64).cos();
                x[start + i] as f64 * w
            } else {
                0.0
            };
            Complex::new(v, 0.0)
        })
        .collect();
    FftPlanner::<f64>::new().plan_fft_forward(n).process(&mut buf);
    buf[..=n / 2].iter().map(|c| c.norm()).collect()
}

fn centroid(x: &[f32], sample_rate: u32, start: usize) -> Option<f64> {
    let n = if sample_rate <= 48_000 { 8192 } else { metrics::fft_size(sample_rate) };
    let sr = sample_rate as f64;
    let mag = spectrum(x, start, n, n);
    let hi = 16_000f64.min(sr / 2.0);
    let (mut num, mut den) = (0.0, 0.0);
    for (k, &m) in mag.iter().enumerate() {
        let f = k as f64 * sr / n as f64;
        if (20.0..=hi).contains(&f) {
            num += f * m;
            den += m;
        }
    }
    (den >= 1e-12).then(|| num / den)
}

fn slope(points: &[(f64, f64)]) -> f64 {
    let n = points.len() as f64;
    let mx = points.iter().map(|p| p.0).sum::<f64>() / n;
    let my = points.iter().map(|p| p.1).sum::<f64>() / n;
    let sxy: f64 = points.iter().map(|p| (p.0 - mx) * (p.1 - my)).sum();
    let sxx: f64 = points.iter().map(|p| (p.0 - mx) * (p.0 - mx)).sum();
    sxy / sxx
}

fn pitch(x: &[f32], sample_rate: u32, note: u8, hold_s: f64) -> (Option<f64>, Option<f64>) {
    let sr = sample_rate as f64;
    let secs = |t: f64| ((t * sr).round().max(0.0) as usize).min(x.len());
    let a = secs(0.1);
    let b = secs(hold_s.min(1.1));
    if b <= a + 2 {
        return (None, None);
    }
    let n_fft = ((2.5 * sr).ceil() as usize).next_power_of_two();
    let mag = spectrum(x, a, b - a, n_fft);
    let w = sr / n_fft as f64;
    let last = mag.len() - 1;
    let f_et = 440.0 * 2f64.powf((note as f64 - 69.0) / 12.0);
    let b0 = if note >= 60 {
        4e-4 * 2.5f64.powf((note as f64 - 60.0) / 12.0)
    } else {
        4e-4 * 0.7f64.powf((60.0 - note as f64) / 12.0)
    };
    let bin_range = |lo: f64, hi: f64| -> (usize, usize) {
        let klo = (lo / w).ceil().max(0.0) as usize;
        let khi = ((hi / w).floor().max(0.0) as usize).min(last);
        (klo.min(last), khi)
    };
    let fmax = 8000f64.min(0.45 * sr);
    let (mut f0e, mut be) = (f_et, b0);
    let mut accepted: Vec<(f64, f64)> = Vec::new();
    for n in 1..=24 {
        let nf = n as f64;
        let fp = nf * f0e * ((1.0 + be * nf * nf) / (1.0 + be)).sqrt();
        if fp > fmax {
            break;
        }
        let rel = if accepted.is_empty() { 2f64.powf(80.0 / 1200.0) - 1.0 } else { 0.006 };
        let half = (rel * fp).max(2.5 * w);
        let (klo, khi) = bin_range(fp - half, fp + half);
        if khi <= klo + 1 {
            continue;
        }
        let mut k = klo;
        for j in klo..=khi {
            if mag[j] > mag[k] {
                k = j;
            }
        }
        if k == klo || k == khi {
            continue;
        }
        let (l1, l2, l3) = (
            (mag[k - 1] + 1e-300).ln(),
            (mag[k] + 1e-300).ln(),
            (mag[k + 1] + 1e-300).ln(),
        );
        let den = l1 - 2.0 * l2 + l3;
        let delta = if den != 0.0 { 0.5 * (l1 - l3) / den } else { 0.0 };
        let f = (k as f64 + delta) * w;
        let (nlo, nhi) = bin_range(fp - f_et / 2.0, fp + f_et / 2.0);
        let mut around: Vec<f64> = mag[nlo..=nhi.max(nlo)].to_vec();
        around.sort_by(|p, q| p.total_cmp(q));
        let noise = around[around.len() / 2];
        if mag[k] < 10.0 * noise {
            continue;
        }
        accepted.push((nf, f));
        if accepted.len() < 3 {
            f0e = accepted
                .iter()
                .map(|&(n, f)| f / (n * ((1.0 + be * n * n) / (1.0 + be)).sqrt()))
                .sum::<f64>()
                / accepted.len() as f64;
        } else {
            let pts: Vec<(f64, f64)> = accepted.iter().map(|&(n, f)| (n * n, (f / n).powi(2))).collect();
            let c = slope(&pts);
            let mx = pts.iter().map(|p| p.0).sum::<f64>() / pts.len() as f64;
            let my = pts.iter().map(|p| p.1).sum::<f64>() / pts.len() as f64;
            let a0 = my - c * mx;
            if a0 > 0.0 {
                be = (c / a0).clamp(0.0, 0.05);
                f0e = (a0 * (1.0 + be)).sqrt();
            }
        }
    }
    match accepted.len() {
        0 => (None, None),
        1..=3 => {
            let f0 = accepted
                .iter()
                .map(|&(n, f)| f / (n * ((1.0 + b0 * n * n) / (1.0 + b0)).sqrt()))
                .sum::<f64>()
                / accepted.len() as f64;
            (Some(f0), None)
        }
        _ => (Some(f0e), Some(be)),
    }
}

/// d1_db and d2_db use the median of nine 50 ms frames centred on 0.975 s and 1.975 s, robust to beat nulls.
pub fn analyze_note(x: &[f32], sample_rate: u32, note: u8, hold_s: f64) -> NoteFeatures {
    let sr = sample_rate as f64;
    let secs = |t: f64| (t * sr).round().max(0.0) as usize;
    let len = x.len();
    let mut out = NoteFeatures { peak_db: -150.0, ..NoteFeatures::default() };

    let win = secs(0.05);
    let hop = secs(0.01);
    let half_s = secs(0.5);
    let mut j = 0;
    let mut peak: Option<f64> = None;
    while hop > 0 && j * hop + win <= half_s.min(len) {
        let l = level_db(&x[j * hop..j * hop + win]);
        peak = Some(peak.map_or(l, |p: f64| p.max(l)));
        j += 1;
    }
    out.peak_db = peak.unwrap_or(-150.0);

    let frame = |i: usize| -> Option<f64> {
        let (a, b) = (i * win, (i + 1) * win);
        (win > 0 && b <= len).then(|| level_db(&x[a..b]))
    };
    let one_s = secs(1.0);
    let peak50 = (0..)
        .take_while(|&i| win > 0 && (i + 1) * win <= one_s.min(len))
        .filter_map(frame)
        .fold(None, |m: Option<f64>, l| Some(m.map_or(l, |p| p.max(l))));

    let median_frame = |range: std::ops::RangeInclusive<usize>| -> Option<f64> {
        let mut v: Vec<f64> = range.map(frame).collect::<Option<Vec<f64>>>()?;
        v.sort_by(|p, q| p.total_cmp(q));
        Some(v[v.len() / 2])
    };

    if let Some(p50) = peak50 {
        if hold_s >= 1.2 {
            out.d1_db = median_frame(15..=23).map(|m| p50 - m);
        }
        if hold_s >= 2.2 {
            out.d2_db = median_frame(35..=43).map(|m| p50 - m);
        }
        if hold_s >= 2.0 {
            let lo = secs(1f64.max(hold_s / 2.0));
            let hi = secs(hold_s - 0.1);
            let pts: Vec<(f64, f64)> = (0..)
                .take_while(|&i| (i + 1) * win <= hi.min(len))
                .filter(|&i| i * win >= lo)
                .filter_map(|i| frame(i).map(|l| ((i as f64 + 0.5) * win as f64 / sr, l)))
                .filter(|&(_, l)| l >= p50 - 70.0)
                .collect();
            if pts.len() >= 5 {
                out.tail_db_per_s = Some(-slope(&pts));
            }
        }
        let h1 = secs(hold_s);
        if win > 0 && h1 + secs(1.5) <= len {
            let mut v: Vec<f64> = (0..10)
                .map(|i| {
                    let a = h1 + secs(1.0) + i * win;
                    level_db(&x[a..a + win])
                })
                .collect();
            v.sort_by(|p, q| p.total_cmp(q));
            let m = v[v.len() / 2];
            if m >= p50 - 100.0 {
                out.late_release_db = Some(m - p50);
            }
        }
        if hop > 0 && h1 + hop <= len {
            let l0 = level_db(&x[h1..h1 + hop]);
            if l0 > p50 - 90.0 {
                let mut k = 1;
                while h1 + (k + 1) * hop <= len {
                    if level_db(&x[h1 + k * hop..h1 + (k + 1) * hop]) <= l0 - 30.0 {
                        out.release_ms = Some(10.0 * k as f64);
                        break;
                    }
                    k += 1;
                }
            }
        }
    }

    out.centroid_hz = centroid(x, sample_rate, secs(0.02));
    if hold_s >= 1.2 {
        out.late_centroid_hz = centroid(x, sample_rate, secs(1.0));
        let (f0, b) = pitch(x, sample_rate, note, hold_s);
        let f_et = 440.0 * 2f64.powf((note as f64 - 69.0) / 12.0);
        out.f0_hz = f0;
        out.cents = f0.map(|f| 1200.0 * (f / f_et).log2());
        out.inharmonicity = b;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f64::consts::PI;

    const SR: u32 = 48_000;

    fn signal(len_s: f64, f: impl Fn(f64) -> f64) -> Vec<f32> {
        let n = (len_s * SR as f64).round() as usize;
        (0..n).map(|i| f(i as f64 / SR as f64) as f32).collect()
    }

    fn stiff_string(f0: f64, b: f64, max_hz: f64) -> Vec<f32> {
        let partials: Vec<(f64, f64)> = (1..=12)
            .map(|n| {
                let n = n as f64;
                (n * f0 * ((1.0 + b * n * n) / (1.0 + b)).sqrt(), 1.0 / n)
            })
            .filter(|&(f, _)| f <= max_hz)
            .collect();
        signal(3.0, |t| {
            let env = (-t / 2.0).exp();
            env * partials.iter().map(|&(f, a)| a * (2.0 * PI * f * t).sin()).sum::<f64>()
        })
    }

    #[test]
    fn pitch_and_b_of_stiff_string() {
        let f0 = 110.0 * 2f64.powf(7.0 / 1200.0);
        let a = analyze_note(&stiff_string(f0, 3e-4, 24_000.0), SR, 45, 3.0);
        assert!((a.cents.unwrap() - 7.0).abs() <= 0.5, "{a:?}");
        assert!((a.inharmonicity.unwrap() / 3e-4 - 1.0).abs() <= 0.05, "{a:?}");

        let a = analyze_note(&stiff_string(110.0, 5e-4, 24_000.0), SR, 45, 3.0);
        assert!((a.inharmonicity.unwrap() / 5e-4 - 1.0).abs() <= 0.10, "{a:?}");

        let a = analyze_note(&stiff_string(880.0, 1e-3, 8000.0), SR, 81, 3.0);
        assert!(a.cents.unwrap().abs() <= 0.5, "{a:?}");
        assert!((a.inharmonicity.unwrap() / 1e-3 - 1.0).abs() <= 0.10, "{a:?}");
    }

    #[test]
    fn pitch_of_stretched_top_octave_tone() {
        for note in [96u8, 102, 108] {
            let f_et = 440.0 * 2f64.powf((note as f64 - 69.0) / 12.0);
            let f0 = f_et * 2f64.powf(35.0 / 1200.0);
            let a = analyze_note(&stiff_string(f0, 0.015, 1.5 * f0), SR, note, 3.0);
            assert!((a.cents.unwrap() - 35.0).abs() <= 1.0, "note {note} {a:?}");
        }
    }

    #[test]
    fn drops_and_tail_of_exponential_decay() {
        let x = signal(3.0, |t| 10f64.powf(-t) * (2.0 * PI * 440.0 * t).sin());
        let a = analyze_note(&x, SR, 69, 3.0);
        assert!((a.d1_db.unwrap() - 19.0).abs() <= 0.6, "{a:?}");
        assert!((a.d2_db.unwrap() - 39.0).abs() <= 0.6, "{a:?}");
        assert!((a.tail_db_per_s.unwrap() - 20.0).abs() <= 0.5, "{a:?}");
    }

    #[test]
    fn drops_robust_to_beat_nulls() {
        let x = signal(3.0, |t| {
            let s = 10f64.powf(-t) * (2.0 * PI * 440.0 * t).sin();
            if (0.95..1.0).contains(&t) || (1.95..2.0).contains(&t) {
                s * 0.01
            } else {
                s
            }
        });
        let a = analyze_note(&x, SR, 69, 3.0);
        // One null shifts the median by at most one frame (1 dB at 20 dB/s); a single-frame reading would be off by about 40 dB.
        assert!((a.d1_db.unwrap() - 19.0).abs() <= 1.1, "{a:?}");
        assert!((a.d2_db.unwrap() - 39.0).abs() <= 1.1, "{a:?}");
    }

    #[test]
    fn release_after_key_up() {
        let x = signal(1.6, |t| {
            let env = if t < 1.0 { 1.0 } else { (-(t - 1.0) / 0.08).exp() };
            0.5 * env * (2.0 * PI * 440.0 * t).sin()
        });
        let r = analyze_note(&x, SR, 69, 1.0).release_ms.unwrap();
        assert!((260.0..=300.0).contains(&r), "{r}");
    }

    #[test]
    fn late_release_level_after_key_up() {
        let x = signal(3.0, |t| {
            let env = if t < 1.0 { 1.0 } else { 10f64.powf(-(t - 1.0) * 2.0) };
            0.5 * env * (2.0 * PI * 440.0 * t).sin()
        });
        // 40 dB/s after key-up: the median over 1.0..1.5 s after key-up is at 1.25 s, about -50 dB.
        let a = analyze_note(&x, SR, 69, 1.0);
        assert!((a.late_release_db.unwrap() + 50.0).abs() <= 2.0, "{a:?}");
        let a = analyze_note(&x[..(2.4 * SR as f64) as usize], SR, 69, 1.0);
        assert_eq!(a.late_release_db, None);
        let x = signal(3.0, |t| if t < 1.0 { (2.0 * PI * 440.0 * t).sin() } else { 0.0 });
        assert_eq!(analyze_note(&x, SR, 69, 1.0).late_release_db, None);
    }

    #[test]
    fn peak_level_of_sine() {
        let x = signal(0.6, |t| 0.5 * (2.0 * PI * 1000.0 * t).sin());
        let a = analyze_note(&x, SR, 84, 0.5);
        assert!((a.peak_db + 9.03).abs() <= 0.1, "{a:?}");
        assert_eq!(a.d1_db, None);
        assert_eq!(a.d2_db, None);
        assert_eq!(a.tail_db_per_s, None);
        assert_eq!(a.release_ms, None);
        assert_eq!(a.f0_hz, None);
        assert_eq!(a.inharmonicity, None);
    }

    #[test]
    fn centroid_of_tones() {
        let x = signal(0.5, |t| 0.5 * (2.0 * PI * 1000.0 * t).sin());
        let c = analyze_note(&x, SR, 84, 0.5).centroid_hz.unwrap();
        assert!((c - 1000.0).abs() <= 30.0, "{c}");

        let x = signal(0.5, |t| {
            0.4 * (2.0 * PI * 220.0 * t).sin() + 0.2 * (2.0 * PI * 440.0 * t).sin()
        });
        let c = analyze_note(&x, SR, 57, 0.5).centroid_hz.unwrap();
        assert!((c - 293.3).abs() <= 30.0, "{c}");
    }

    #[test]
    fn short_or_silent_input_is_safe() {
        for (x, hold) in [(vec![], 0.5), (vec![0.0f32; 100], 0.5), (vec![0.0f32; 96_000], 1.5)] {
            let a = analyze_note(&x, SR, 60, hold);
            assert!(a.peak_db <= -149.0, "{a:?}");
            assert_eq!(a.centroid_hz, None);
            assert_eq!(a.f0_hz, None);
        }
    }
}
