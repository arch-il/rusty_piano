//! Output EQ fit: the octave-band error against the test-piece spectrum and a regularised Gauss-Newton solve for the five gains.

use crate::metrics::OCTAVE_CENTERS_HZ;
use crate::sound::modal_piano::eq::magnitude_db;
use crate::sound::modal_piano::profile::ModalEq;

pub const BAND_WEIGHTS: [f64; 10] = [0.25, 0.5, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 0.5, 0.25];

// Gain penalty: a band's sensitivity after the free constant is only about 0.75, so 0.5 shrank real tilts by about half;
// 0.05 still bounds the gains, and the SE guard drops the EQ if it does not help.
const LAMBDA: f64 = 0.05;

/// Weighted RMS of (ours - reference) per band after removing the weighted mean; bands missing on either side or with the reference below -60 dB are left out.
pub fn band_error_db(ours: &[Option<f64>; 10], reference: &[Option<f64>; 10]) -> Option<f64> {
    let mut w = [0.0; 10];
    let mut d = [0.0; 10];
    for b in 0..10 {
        if let (Some(o), Some(r)) = (ours[b], reference[b]) {
            if r >= -60.0 {
                w[b] = BAND_WEIGHTS[b];
                d[b] = o - r;
            }
        }
    }
    let sw: f64 = w.iter().sum();
    if sw <= 0.0 {
        return None;
    }
    let c = (0..10).map(|b| w[b] * d[b]).sum::<f64>() / sw;
    Some(((0..10).map(|b| w[b] * (d[b] - c) * (d[b] - c)).sum::<f64>() / sw).sqrt())
}

fn with_gains(base: &ModalEq, g: &[f64]) -> ModalEq {
    ModalEq {
        low_shelf_db: g[0] as f32,
        peak1_db: g[1] as f32,
        peak2_db: g[2] as f32,
        peak3_db: g[3] as f32,
        high_shelf_db: g[4] as f32,
        ..*base
    }
}

fn eq_db(base: &ModalEq, g: &[f64], sample_rate: f64) -> [f64; 10] {
    let eq = with_gains(base, g);
    OCTAVE_CENTERS_HZ.map(|f| magnitude_db(&eq, f, sample_rate))
}

/// Solves a x = y by Gaussian elimination with partial pivoting; a singular pivot gives 0 for that unknown.
fn solve6(mut a: [[f64; 6]; 6], mut y: [f64; 6]) -> [f64; 6] {
    for col in 0..6 {
        let piv = (col..6).max_by(|&i, &j| a[i][col].abs().total_cmp(&a[j][col].abs())).unwrap_or(col);
        a.swap(col, piv);
        y.swap(col, piv);
        if a[col][col].abs() < 1e-12 {
            continue;
        }
        for r in col + 1..6 {
            let f = a[r][col] / a[col][col];
            for k in col..6 {
                a[r][k] -= f * a[col][k];
            }
            y[r] -= f * y[col];
        }
    }
    let mut x = [0.0; 6];
    for r in (0..6).rev() {
        if a[r][r].abs() < 1e-12 {
            continue;
        }
        let s: f64 = (r + 1..6).map(|k| a[r][k] * x[k]).sum();
        x[r] = (y[r] - s) / a[r][r];
    }
    x
}

/// Fits the five EQ gains (frequencies and Q from base) plus a free constant to the residual (reference - ours, dB per band):
/// 3 Gauss-Newton iterations with a 0.5 g^2 penalty on the gains, then each gain clamped to -6..6 and rounded to 0.5 dB.
pub fn solve_gains(residual: &[Option<f64>; 10], weights: &[f64; 10], base: &ModalEq, sample_rate: f64) -> ModalEq {
    let w: [f64; 10] = std::array::from_fn(|b| if residual[b].is_some() { weights[b] } else { 0.0 });
    let r = residual.map(|x| x.unwrap_or(0.0));
    let mut x = [0.0f64; 6];
    for _ in 0..3 {
        let m0 = eq_db(base, &x[..5], sample_rate);
        let mut jac = [[0.0f64; 6]; 10];
        for k in 0..5 {
            let (mut up, mut dn) = (x, x);
            up[k] += 0.5;
            dn[k] -= 0.5;
            let mu = eq_db(base, &up[..5], sample_rate);
            let md = eq_db(base, &dn[..5], sample_rate);
            for b in 0..10 {
                jac[b][k] = mu[b] - md[b];
            }
        }
        for row in jac.iter_mut() {
            row[5] = 1.0;
        }
        let mut a = [[0.0f64; 6]; 6];
        let mut y = [0.0f64; 6];
        for b in 0..10 {
            let e = r[b] - (m0[b] + x[5]);
            for i in 0..6 {
                y[i] += w[b] * jac[b][i] * e;
                for j in 0..6 {
                    a[i][j] += w[b] * jac[b][i] * jac[b][j];
                }
            }
        }
        for k in 0..5 {
            a[k][k] += LAMBDA;
            y[k] -= LAMBDA * x[k];
        }
        let dx = solve6(a, y);
        for i in 0..6 {
            x[i] += dx[i];
        }
    }
    let g: Vec<f64> = x[..5].iter().map(|v| ((v.clamp(-6.0, 6.0) * 2.0).round() / 2.0) + 0.0).collect();
    with_gains(base, &g)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: f64 = 48000.0;

    #[test]
    fn eq_gains_recover_known_tilt() {
        let tilt = ModalEq { low_shelf_db: 3.0, high_shelf_db: -2.0, ..ModalEq::default() };
        let residual = OCTAVE_CENTERS_HZ.map(|f| Some(magnitude_db(&tilt, f, SR) + 1.7));
        let eq = solve_gains(&residual, &BAND_WEIGHTS, &ModalEq::default(), SR);
        assert!((eq.low_shelf_db - 3.0).abs() <= 0.5, "{eq:?}");
        assert!((eq.high_shelf_db + 2.0).abs() <= 0.5, "{eq:?}");
        for g in [eq.peak1_db, eq.peak2_db, eq.peak3_db] {
            assert!(g.abs() <= 0.5, "{eq:?}");
        }
    }

    #[test]
    fn flat_residual_gives_zero_gains() {
        let eq = solve_gains(&[Some(4.0); 10], &BAND_WEIGHTS, &ModalEq::default(), SR);
        for g in [eq.low_shelf_db, eq.peak1_db, eq.peak2_db, eq.peak3_db, eq.high_shelf_db] {
            assert_eq!(g, 0.0, "{eq:?}");
        }
    }
}
