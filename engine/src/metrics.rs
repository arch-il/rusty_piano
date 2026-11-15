//! Sound metrics for tuning: note segments from MIDI events, loudness, decay, release, spectrum (rustfft) and velocity curves. Works at any sample rate.

use crate::midi::MidiEvent;
use rustfft::{num_complex::Complex, FftPlanner};
use std::f64::consts::PI;

pub const DB_FLOOR: f64 = -120.0;

pub const OCTAVE_CENTERS_HZ: [f64; 10] = [31.5, 63.0, 125.0, 250.0, 500.0, 1000.0, 2000.0, 4000.0, 8000.0, 16000.0];

pub fn db(x: f64) -> f64 {
    if x <= 1e-6 {
        -120.0
    } else {
        20.0 * x.log10()
    }
}

pub fn note_hz(note: u8) -> f64 {
    440.0 * 2f64.powf((note as f64 - 69.0) / 12.0)
}

pub fn fft_size(sample_rate: u32) -> usize {
    let limit = 0.2 * sample_rate as f64;
    let mut n = 256;
    while ((n * 2) as f64) <= limit {
        n *= 2;
    }
    n
}

#[derive(Debug, Clone, PartialEq)]
pub struct Segment {
    pub index: usize,
    pub section: String,
    pub onset_s: f64,
    pub end_s: f64,
    pub held_end_s: f64,
    pub notes: Vec<u8>,
    pub velocity: u8,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SegmentMetrics {
    pub index: usize,
    pub section: String,
    pub onset_s: f64,
    pub notes: Vec<u8>,
    pub velocity: u8,
    pub peak_db: f64,
    pub rms_db: f64,
    pub attack_ms: Option<f64>,
    pub decay_db_per_s: Option<f64>,
    pub t60_s: Option<f64>,
    pub release_ms: Option<f64>,
    pub centroid_hz: Option<f64>,
    pub brightness: Option<f64>,
    pub partials_db: Option<[Option<f64>; 8]>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct WholeMetrics {
    pub duration_s: f64,
    pub peak_db: f64,
    pub rms_db: f64,
    pub max_rms_400ms_db: f64,
    pub clipped_samples: usize,
    pub centroid_hz: Option<f64>,
    pub octave_bands_db: [Option<f64>; 10],
}

#[derive(Debug, Clone, PartialEq)]
pub struct VelocityPoint {
    pub velocity: u8,
    pub peak_db: f64,
    pub rms_db: f64,
    pub centroid_hz: Option<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct VelocityCurve {
    pub note: u8,
    pub points: Vec<VelocityPoint>,
    pub dynamic_range_db: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Analysis {
    pub sample_rate: u32,
    pub whole: WholeMetrics,
    pub segments: Vec<SegmentMetrics>,
    pub velocity_curves: Vec<VelocityCurve>,
}

fn held_end_s(events: &[(u64, MidiEvent)], j: usize, note: u8, total_s: f64) -> f64 {
    let rel = events[j + 1..].iter().position(|&(_, ev)| match ev {
        MidiEvent::NoteOff { note: n } | MidiEvent::NoteOn { note: n, .. } => n == note,
        MidiEvent::Sustain { .. } | MidiEvent::Pedal { .. } => false,
    });
    let k = match rel {
        None => return total_s,
        Some(p) => j + 1 + p,
    };
    let pedal_down = events[..k]
        .iter()
        .rev()
        .find_map(|&(_, ev)| ev.sustain_on())
        .unwrap_or(false);
    if pedal_down {
        events[k + 1..]
            .iter()
            .find_map(|&(t, ev)| (ev.sustain_on() == Some(false)).then_some(t))
            .map_or(total_s, |t| t as f64 / 1e6)
    } else {
        events[k].0 as f64 / 1e6
    }
}

pub fn segments_from_events(events: &[(u64, MidiEvent)], sections: &[(&str, u64)], total_s: f64) -> Vec<Segment> {
    let mut ons: Vec<(u64, u8, u8, f64)> = Vec::new();
    for (j, &(t, ev)) in events.iter().enumerate() {
        if let MidiEvent::NoteOn { note, velocity } = ev {
            if velocity > 0 {
                ons.push((t, note, velocity, held_end_s(events, j, note, total_s)));
            }
        }
    }

    let mut groups: Vec<Vec<(u64, u8, u8, f64)>> = Vec::new();
    for on in ons {
        let joins = groups.last().is_some_and(|g| on.0 - g[0].0 <= 5_000);
        if joins {
            groups.last_mut().unwrap().push(on);
        } else {
            groups.push(vec![on]);
        }
    }

    let mut segments = Vec::new();
    for (i, g) in groups.iter().enumerate() {
        let onset_s = g[0].0 as f64 / 1e6;
        let mut notes: Vec<u8> = g.iter().map(|o| o.1).collect();
        notes.sort();
        notes.dedup();
        let velocity = g.iter().map(|o| o.2).max().unwrap_or(0);
        let held_end_s = g.iter().map(|o| o.3).fold(f64::MIN, f64::max);
        let end_s = match groups.get(i + 1) {
            Some(next) => next[0].0 as f64 / 1e6,
            None => held_end_s + 1.0,
        };
        let end_s = end_s.min(onset_s + 4.0).min(total_s);
        let t = g[0].0;
        let section = sections
            .iter()
            .filter(|s| s.1 <= t)
            .next_back()
            .map_or("file", |s| s.0)
            .to_string();
        segments.push(Segment {
            index: segments.len(),
            section,
            onset_s,
            end_s,
            held_end_s,
            notes,
            velocity,
        });
    }
    segments
}

pub fn first_onset_s(samples: &[f32], sample_rate: u32) -> Option<f64> {
    let peak = samples.iter().fold(0.0f64, |m, &x| m.max((x as f64).abs()));
    if peak == 0.0 {
        return None;
    }
    let threshold = peak * 10f64.powf(-50.0 / 20.0);
    samples
        .iter()
        .position(|&x| (x as f64).abs() >= threshold)
        .map(|i| i as f64 / sample_rate as f64)
}

fn rms(x: &[f32]) -> f64 {
    if x.is_empty() {
        return 0.0;
    }
    (x.iter().map(|&v| (v as f64) * (v as f64)).sum::<f64>() / x.len() as f64).sqrt()
}

pub fn analyze(samples: &[f32], sample_rate: u32, segments: &[Segment], time_offset_s: f64) -> Analysis {
    let sr = sample_rate as f64;
    let len = samples.len();
    let n = fft_size(sample_rate);
    let fft = FftPlanner::<f64>::new().plan_fft_forward(n);
    let hann: Vec<f64> = (0..n).map(|i| 0.5 - 0.5 * (2.0 * PI * i as f64 / n as f64).cos()).collect();
    let frame = (0.01 * sr).round() as usize;
    let idx = |t: f64| ((t + time_offset_s) * sr).round().clamp(0.0, len as f64) as usize;
    let freq = |k: usize| k as f64 * sr / n as f64;
    let spectrum = |start: usize, end: usize| -> Vec<f64> {
        let mut buf: Vec<Complex<f64>> = (0..n)
            .map(|i| {
                let p = start + i;
                let x = if p < end && p < len { samples[p] as f64 } else { 0.0 };
                Complex::new(x * hann[i], 0.0)
            })
            .collect();
        fft.process(&mut buf);
        buf[..=n / 2].iter().map(|c| c.norm()).collect()
    };
    let centroid = |mags: &[f64]| -> Option<f64> {
        let (mut num, mut den) = (0.0, 0.0);
        for (k, &m) in mags.iter().enumerate() {
            let f = freq(k);
            if (20.0..=16000f64.min(sr / 2.0)).contains(&f) {
                num += f * m;
                den += m;
            }
        }
        if den < 1e-12 {
            None
        } else {
            Some(num / den)
        }
    };

    let mut seg_metrics: Vec<SegmentMetrics> = Vec::new();
    for seg in segments {
        let s0 = idx(seg.onset_s);
        let s1 = idx(seg.end_s);
        let h1 = idx(seg.held_end_s).min(s1);
        let mut m = SegmentMetrics {
            index: seg.index,
            section: seg.section.clone(),
            onset_s: seg.onset_s,
            notes: seg.notes.clone(),
            velocity: seg.velocity,
            peak_db: DB_FLOOR,
            rms_db: DB_FLOOR,
            attack_ms: None,
            decay_db_per_s: None,
            t60_s: None,
            release_ms: None,
            centroid_hz: None,
            brightness: None,
            partials_db: None,
        };
        if s1 > s0 {
            let x = &samples[s0..s1];
            let peak = x.iter().fold(0.0f64, |p, &v| p.max((v as f64).abs()));
            m.peak_db = db(peak);
            m.rms_db = db(rms(&samples[s0..(s0 + (0.5 * sr).round() as usize).min(s1)]));
            if peak > 0.0 {
                m.attack_ms = x
                    .iter()
                    .position(|&v| (v as f64).abs() >= 0.9 * peak)
                    .map(|p| p as f64 / sr * 1000.0);
            }

            let count = h1.saturating_sub(s0) / frame;
            let mut fit: Vec<(f64, f64)> = Vec::new();
            if count > 0 {
                let frame_db: Vec<f64> = (0..count)
                    .map(|j| db(rms(&samples[s0 + j * frame..s0 + (j + 1) * frame])))
                    .collect();
                let mut jp = 0;
                for j in 1..count {
                    if frame_db[j] > frame_db[jp] {
                        jp = j;
                    }
                }
                for j in jp + 1..count {
                    if frame_db[j] < frame_db[jp] - 60.0 {
                        break;
                    }
                    fit.push((j as f64 * frame as f64 / sr, frame_db[j]));
                }
            }
            if fit.len() >= 5 {
                let cnt_f = fit.len() as f64;
                let sx: f64 = fit.iter().map(|p| p.0).sum();
                let sy: f64 = fit.iter().map(|p| p.1).sum();
                let sxx: f64 = fit.iter().map(|p| p.0 * p.0).sum();
                let sxy: f64 = fit.iter().map(|p| p.0 * p.1).sum();
                let slope = (cnt_f * sxy - sx * sy) / (cnt_f * sxx - sx * sx);
                m.decay_db_per_s = Some(slope);
                if slope < -0.01 {
                    m.t60_s = Some(-60.0 / slope);
                }
            }

            if h1 < s1 {
                let l0 = db(rms(&samples[h1..(h1 + frame).min(len)]));
                if l0 > -100.0 {
                    let mut k = 1;
                    while h1 + (k + 1) * frame <= s1 {
                        if db(rms(&samples[h1 + k * frame..h1 + (k + 1) * frame])) <= l0 - 30.0 {
                            m.release_ms = Some(k as f64 * frame as f64 / sr * 1000.0);
                            break;
                        }
                        k += 1;
                    }
                }
            }

            let mags = spectrum(s0 + (0.02 * sr).round() as usize, s1);
            m.centroid_hz = centroid(&mags);
            if let (Some(c), Some(lo)) = (m.centroid_hz, seg.notes.iter().copied().min()) {
                m.brightness = Some(c / note_hz(lo));
            }
            if seg.notes.len() == 1 {
                let f0 = note_hz(seg.notes[0]);
                let mag_at = |fh: f64| -> f64 {
                    let d = (0.03 * fh).max(1.5 * sr / n as f64).min(0.45 * f0);
                    let (kb, vb) = mags
                        .iter()
                        .enumerate()
                        .filter(|(k, _)| (freq(*k) - fh).abs() <= d)
                        .fold((0, 0.0), |best, (k, &v)| if v > best.1 { (k, v) } else { best });
                    if kb == 0 || kb + 1 >= mags.len() || mags[kb - 1] <= 0.0 || mags[kb + 1] <= 0.0 {
                        return vb;
                    }
                    let (a, b, c) = (mags[kb - 1].ln(), vb.ln(), mags[kb + 1].ln());
                    let den = a - 2.0 * b + c;
                    if den >= 0.0 {
                        return vb;
                    }
                    let p = (0.5 * (a - c) / den).clamp(-0.5, 0.5);
                    (b - 0.25 * (a - c) * p).exp()
                };
                let mag1 = mag_at(f0);
                if mag1 > 1e-12 {
                    let mut e: [Option<f64>; 8] = [None; 8];
                    for h in 1..=8 {
                        let fh = h as f64 * f0;
                        if fh <= 0.45 * sr {
                            e[h - 1] = Some((20.0 * (mag_at(fh).max(1e-12) / mag1).log10()).max(-120.0));
                        }
                    }
                    e[0] = Some(0.0);
                    m.partials_db = Some(e);
                }
            }
        }
        seg_metrics.push(m);
    }

    let peak_all = samples.iter().fold(0.0f64, |p, &x| p.max((x as f64).abs()));
    let frame_energy: Vec<f64> = (0..len / frame)
        .map(|j| rms(&samples[j * frame..(j + 1) * frame]).powi(2))
        .collect();
    let max_rms_400ms_db = if frame_energy.is_empty() {
        DB_FLOOR
    } else {
        let windows: Vec<&[f64]> = if frame_energy.len() < 40 {
            vec![&frame_energy[..]]
        } else {
            (0..=frame_energy.len() - 40)
                .step_by(10)
                .map(|s| &frame_energy[s..s + 40])
                .collect()
        };
        windows
            .iter()
            .map(|w| db((w.iter().sum::<f64>() / w.len() as f64).sqrt()))
            .fold(f64::MIN, f64::max)
    };

    let bins = n / 2 + 1;
    let mut sum_mag = vec![0.0f64; bins];
    let mut sum_pow = vec![0.0f64; bins];
    let mut count = 0usize;
    let mut start = 0;
    while start < len {
        for (k, v) in spectrum(start, len).into_iter().enumerate() {
            sum_mag[k] += v;
            sum_pow[k] += v * v;
        }
        count += 1;
        start += n / 2;
    }
    let cnt = count.max(1) as f64;
    let mean_mag: Vec<f64> = sum_mag.iter().map(|v| v / cnt).collect();
    let mean_pow: Vec<f64> = sum_pow.iter().map(|v| v / cnt).collect();

    let total: f64 = (0..bins).filter(|&k| freq(k) >= 20.0).map(|k| mean_pow[k]).sum();
    let mut octave_bands_db: [Option<f64>; 10] = [None; 10];
    for (b, &c) in OCTAVE_CENTERS_HZ.iter().enumerate() {
        let lo = c / 2f64.sqrt();
        let hi = c * 2f64.sqrt();
        if lo < sr / 2.0 && total > 0.0 {
            let band: f64 = (1..bins)
                .filter(|&k| {
                    let f = freq(k);
                    f >= lo && f < hi && f <= sr / 2.0
                })
                .map(|k| mean_pow[k])
                .sum();
            octave_bands_db[b] = Some((10.0 * (band.max(total * 1e-12) / total).log10()).max(-120.0));
        }
    }

    let whole = WholeMetrics {
        duration_s: len as f64 / sr,
        peak_db: db(peak_all),
        rms_db: db(rms(samples)),
        max_rms_400ms_db,
        clipped_samples: samples.iter().filter(|&&x| (x as f64).abs() >= 0.999).count(),
        centroid_hz: centroid(&mean_mag),
        octave_bands_db,
    };

    let mut cands: Vec<&SegmentMetrics> = seg_metrics.iter().filter(|s| s.notes.len() == 1).collect();
    if cands.iter().any(|s| s.section == "velocity") {
        cands.retain(|s| s.section == "velocity");
    }
    let mut notes: Vec<u8> = cands.iter().map(|s| s.notes[0]).collect();
    notes.sort();
    notes.dedup();
    let mut velocity_curves = Vec::new();
    for note in notes {
        let mut points: Vec<VelocityPoint> = Vec::new();
        for s in cands.iter().filter(|s| s.notes[0] == note) {
            if points.iter().any(|p| p.velocity == s.velocity) {
                continue;
            }
            points.push(VelocityPoint {
                velocity: s.velocity,
                peak_db: s.peak_db,
                rms_db: s.rms_db,
                centroid_hz: s.centroid_hz,
            });
        }
        points.sort_by_key(|p| p.velocity);
        if points.len() >= 2 {
            let dynamic_range_db = points[points.len() - 1].rms_db - points[0].rms_db;
            velocity_curves.push(VelocityCurve {
                note,
                points,
                dynamic_range_db,
            });
        }
    }

    Analysis {
        sample_rate,
        whole,
        segments: seg_metrics,
        velocity_curves,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::midi::MidiEvent;

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-9
    }

    #[test]
    fn segments_split_and_group() {
        let events = vec![
            (0, MidiEvent::NoteOn { note: 60, velocity: 64 }),
            (800_000, MidiEvent::NoteOff { note: 60 }),
            (1_000_000, MidiEvent::NoteOn { note: 48, velocity: 50 }),
            (1_000_000, MidiEvent::NoteOn { note: 52, velocity: 90 }),
            (1_002_000, MidiEvent::NoteOn { note: 55, velocity: 70 }),
            (2_000_000, MidiEvent::NoteOff { note: 48 }),
            (2_000_000, MidiEvent::NoteOff { note: 52 }),
            (2_000_000, MidiEvent::NoteOff { note: 55 }),
        ];
        let segs = segments_from_events(&events, &[], 3.0);
        assert_eq!(segs.len(), 2);
        assert_eq!(segs[0].index, 0);
        assert_eq!(segs[0].section, "file");
        assert_eq!(segs[0].notes, vec![60]);
        assert_eq!(segs[0].velocity, 64);
        assert!(close(segs[0].onset_s, 0.0));
        assert!(close(segs[0].end_s, 1.0));
        assert!(close(segs[0].held_end_s, 0.8));
        assert_eq!(segs[1].index, 1);
        assert_eq!(segs[1].section, "file");
        assert_eq!(segs[1].notes, vec![48, 52, 55]);
        assert_eq!(segs[1].velocity, 90);
        assert!(close(segs[1].onset_s, 1.0));
        assert!(close(segs[1].held_end_s, 2.0));
        assert!(close(segs[1].end_s, 3.0));
    }

    #[test]
    fn held_end_follows_sustain_pedal() {
        let events = vec![
            (0, MidiEvent::Sustain { on: true }),
            (100_000, MidiEvent::NoteOn { note: 60, velocity: 80 }),
            (200_000, MidiEvent::NoteOff { note: 60 }),
            (1_500_000, MidiEvent::Sustain { on: false }),
        ];
        let segs = segments_from_events(&events, &[], 3.0);
        assert_eq!(segs.len(), 1);
        assert!(close(segs[0].held_end_s, 1.5));
        assert!(close(segs[0].end_s, 2.5));
    }

    #[test]
    fn held_end_follows_pedal_values() {
        use crate::midi::Pedal;
        let p = |value| MidiEvent::Pedal { pedal: Pedal::Sustain, value };
        let events = vec![
            (0, p(100)),
            (100_000, MidiEvent::NoteOn { note: 60, velocity: 80 }),
            (200_000, MidiEvent::NoteOff { note: 60 }),
            (800_000, p(90)),
            (1_500_000, p(30)),
            (1_600_000, p(10)),
        ];
        let segs = segments_from_events(&events, &[], 3.0);
        assert_eq!(segs.len(), 1);
        assert!(close(segs[0].held_end_s, 1.5));
        assert!(close(segs[0].end_s, 2.5));
    }

    #[test]
    fn sections_and_windows_of_test_piece() {
        let p = crate::render::test_piece();
        let segs = segments_from_events(&p.events, &p.sections, 52.9);
        assert_eq!(segs.len(), 39);

        let s = &segs[0];
        assert_eq!(s.section, "velocity");
        assert_eq!(s.notes, vec![36]);
        assert_eq!(s.velocity, 16);
        assert!(close(s.onset_s, 0.0));
        assert!(close(s.end_s, 1.1));
        assert!(close(s.held_end_s, 0.6));

        let s = &segs[24];
        assert_eq!(s.section, "keys");
        assert_eq!(s.notes, vec![21]);

        let s = &segs[33];
        assert_eq!(s.section, "chord");
        assert_eq!(s.notes, vec![48, 52, 55, 60, 64, 67, 72]);
        assert_eq!(s.velocity, 90);

        let s = &segs[38];
        assert_eq!(s.section, "sustain");
        assert_eq!(s.notes, vec![72]);
        assert!(close(s.held_end_s, 50.9));
        assert!(close(s.end_s, 51.9));
    }

    fn tone(sr: u32, secs: f64, parts: &[(f64, f64)], tau: Option<f64>) -> Vec<f32> {
        let total = (sr as f64 * secs).round() as usize;
        (0..total)
            .map(|i| {
                let t = i as f64 / sr as f64;
                let s: f64 = parts
                    .iter()
                    .map(|&(hz, a)| a * (2.0 * std::f64::consts::PI * hz * t).sin())
                    .sum();
                let env = tau.map_or(1.0, |tau| (-t / tau).exp());
                (s * env) as f32
            })
            .collect()
    }

    fn seg(section: &str, notes: &[u8], onset: f64, end: f64, held: f64, velocity: u8) -> Segment {
        Segment {
            index: 0,
            section: section.to_string(),
            onset_s: onset,
            end_s: end,
            held_end_s: held,
            notes: notes.to_vec(),
            velocity,
        }
    }

    #[test]
    fn decay_of_known_sine() {
        let x = tone(48000, 2.0, &[(440.0, 0.5)], Some(1.0));
        let a = analyze(&x, 48000, &[seg("file", &[69], 0.0, 2.0, 2.0, 100)], 0.0);
        let m = &a.segments[0];
        assert!((m.peak_db + 6.02).abs() <= 0.1);
        let slope = m.decay_db_per_s.unwrap();
        assert!((-8.9..=-8.45).contains(&slope));
        let t60 = m.t60_s.unwrap();
        assert!((6.7..=7.1).contains(&t60));
        let p = m.partials_db.unwrap();
        assert_eq!(p[0], Some(0.0));
        for e in &p[1..] {
            assert!(e.unwrap() <= -60.0);
        }
        assert!((m.centroid_hz.unwrap() - 440.0).abs() <= 30.0);
        assert!(m.attack_ms.unwrap() < 1.0);
        assert_eq!(m.release_ms, None);
    }

    #[test]
    fn partials_and_centroid_of_two_tones() {
        let x = tone(48000, 1.0, &[(220.0, 0.4), (440.0, 0.2)], None);
        let a = analyze(&x, 48000, &[seg("file", &[57], 0.0, 1.0, 1.0, 100)], 0.0);
        let m = &a.segments[0];
        let p = m.partials_db.unwrap();
        assert!((p[1].unwrap() + 6.02).abs() <= 0.5);
        assert!(p[2].unwrap() <= -60.0);
        assert!((m.centroid_hz.unwrap() - 293.3).abs() <= 30.0);
    }

    #[test]
    fn release_time_after_key_up() {
        let x: Vec<f32> = (0..76800)
            .map(|i| {
                let t = i as f64 / 48000.0;
                let env = if t < 1.0 { 1.0 } else { (-(t - 1.0) / 0.08).exp() };
                (0.5 * env * (2.0 * std::f64::consts::PI * 440.0 * t).sin()) as f32
            })
            .collect();
        let a = analyze(&x, 48000, &[seg("file", &[69], 0.0, 1.6, 1.0, 100)], 0.0);
        let r = a.segments[0].release_ms.unwrap();
        assert!((260.0..=300.0).contains(&r));
    }

    #[test]
    fn same_metrics_at_44100() {
        let x48 = tone(48000, 2.0, &[(440.0, 0.5)], Some(1.0));
        let x44 = tone(44100, 2.0, &[(440.0, 0.5)], Some(1.0));
        let a48 = analyze(&x48, 48000, &[seg("file", &[69], 0.0, 2.0, 2.0, 100)], 0.0);
        let a44 = analyze(&x44, 44100, &[seg("file", &[69], 0.0, 2.0, 2.0, 100)], 0.0);
        let m = &a44.segments[0];
        assert!((m.t60_s.unwrap() - a48.segments[0].t60_s.unwrap()).abs() <= 0.2);
        assert!(m.partials_db.unwrap()[2].unwrap() <= -60.0);
    }

    fn quantise16(x: &[f32]) -> Vec<f32> {
        x.iter().map(|&v| (v * 32768.0).round() / 32768.0).collect()
    }

    #[test]
    fn partials_agree_between_float_48k_and_16bit_44k() {
        let parts: Vec<(f64, f64)> = (1..=8)
            .map(|h| (220.0 * h as f64, 0.3 * 10f64.powf(-(h as f64 - 1.0) * 10.0 / 20.0)))
            .collect();
        let x48 = tone(48000, 2.0, &parts, Some(1.0));
        let x44 = quantise16(&tone(44100, 2.0, &parts, Some(1.0)));
        let s = [seg("file", &[57], 0.0, 2.0, 2.0, 100)];
        let p48 = analyze(&x48, 48000, &s, 0.0).segments[0].partials_db.unwrap();
        let p44 = analyze(&x44, 44100, &s, 0.0).segments[0].partials_db.unwrap();
        for h in 0..8 {
            let (a, b) = (p48[h], p44[h]);
            match (a, b) {
                (Some(a), Some(b)) if a > -60.0 => assert!((a - b).abs() <= 2.0, "partial {} {a} vs {b}", h + 1),
                _ => {}
            }
        }
    }

    #[test]
    fn offset_shifts_windows() {
        let x = tone(48000, 2.0, &[(440.0, 0.5)], Some(1.0));
        let mut shifted = vec![0.0f32; 4800];
        shifted.extend_from_slice(&x);
        let segs = [seg("file", &[69], 0.0, 2.0, 2.0, 100)];
        let a = analyze(&x, 48000, &segs, 0.0);
        let b = analyze(&shifted, 48000, &segs, 0.1);
        let (ma, mb) = (&a.segments[0], &b.segments[0]);
        assert!((ma.peak_db - mb.peak_db).abs() <= 0.05);
        assert!((ma.t60_s.unwrap() - mb.t60_s.unwrap()).abs() <= 0.05);
        assert!((ma.centroid_hz.unwrap() - mb.centroid_hz.unwrap()).abs() <= 0.05);
        let onset = first_onset_s(&shifted, 48000).unwrap();
        assert!((0.099..=0.1005).contains(&onset));
    }

    #[test]
    fn whole_metrics_basics() {
        let zeros = vec![0.0f32; 48000];
        let a = analyze(&zeros, 48000, &[], 0.0);
        let w = &a.whole;
        assert_eq!(w.peak_db, -120.0);
        assert_eq!(w.rms_db, -120.0);
        assert_eq!(w.centroid_hz, None);
        assert!(w.octave_bands_db.iter().all(|b| b.is_none()));
        assert_eq!(w.clipped_samples, 0);

        let mut clipped = vec![0.0f32; 48000];
        clipped[100] = 1.0;
        clipped[200] = 1.0;
        clipped[300] = 1.0;
        assert_eq!(analyze(&clipped, 48000, &[], 0.0).whole.clipped_samples, 3);

        let sine = tone(48000, 1.0, &[(1000.0, 0.5)], None);
        let w = analyze(&sine, 48000, &[], 0.0).whole;
        let top = w.octave_bands_db[5].unwrap();
        assert!(top > -1.0);
        for (i, b) in w.octave_bands_db.iter().enumerate() {
            if i != 5 {
                assert!(b.is_none_or(|v| v < top));
            }
        }
    }

    #[test]
    fn velocity_curve_from_ladder() {
        let mut x = tone(48000, 1.0, &[(440.0, 0.1)], None);
        x.extend(tone(48000, 1.0, &[(440.0, 0.4)], None));
        let segs = [
            seg("velocity", &[69], 0.0, 1.0, 1.0, 40),
            seg("velocity", &[69], 1.0, 2.0, 2.0, 100),
            seg("velocity", &[60, 64], 0.0, 1.0, 1.0, 127),
        ];
        let a = analyze(&x, 48000, &segs, 0.0);
        assert_eq!(a.velocity_curves.len(), 1);
        let c = &a.velocity_curves[0];
        assert_eq!(c.note, 69);
        let vels: Vec<u8> = c.points.iter().map(|p| p.velocity).collect();
        assert_eq!(vels, vec![40, 100]);
        assert!((c.dynamic_range_db - 12.04).abs() <= 0.1);
    }

    #[test]
    fn analyze_is_deterministic() {
        let x = tone(48000, 2.0, &[(440.0, 0.5)], Some(1.0));
        let segs = [seg("file", &[69], 0.0, 2.0, 2.0, 100)];
        assert_eq!(analyze(&x, 48000, &segs, 0.0), analyze(&x, 48000, &segs, 0.0));
    }
}
