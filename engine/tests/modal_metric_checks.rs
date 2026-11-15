use rusty_piano_engine::{
    metrics::{analyze, Segment},
    midi::MidiEvent,
    sound::{
        modal_piano::{parse_modal_profile, ModalPiano, ModalProfile},
        SoundEngine,
    },
};

const SR: u32 = 48000;
const PHYSICAL: &str = include_str!("../profiles/physical.ron");
const SL990: &str = include_str!("../profiles/physical_sl990.ron");

fn held(p: &ModalProfile, note: u8, vel: u8, s: f64) -> Vec<f32> {
    let mut e = ModalPiano::with_profile(SR, p);
    e.handle(&MidiEvent::NoteOn { note, velocity: vel });
    let frames = (s * SR as f64) as usize;
    let mut out = Vec::with_capacity(frames);
    let mut done = 0;
    while done < frames {
        let n = (frames - done).min(64);
        let mut l = [0.0f32; 64];
        let mut r = [0.0f32; 64];
        e.render_stereo(&mut l[..n], &mut r[..n]);
        for i in 0..n {
            out.push(0.5 * (l[i] + r[i]));
        }
        done += n;
    }
    out
}

fn window_db(x: &[f32], win_s: f64) -> Vec<f64> {
    let w = (win_s * SR as f64) as usize;
    x.chunks_exact(w)
        .map(|c| 10.0 * (c.iter().map(|&v| (v as f64).powi(2)).sum::<f64>() / w as f64 + 1e-30).log10())
        .collect()
}

fn slope(pts: &[(f64, f64)]) -> f64 {
    let n = pts.len() as f64;
    let sx: f64 = pts.iter().map(|p| p.0).sum();
    let sy: f64 = pts.iter().map(|p| p.1).sum();
    let sxx: f64 = pts.iter().map(|p| p.0 * p.0).sum();
    let sxy: f64 = pts.iter().map(|p| p.0 * p.1).sum();
    (n * sxy - sx * sy) / (n * sxx - sx * sx)
}

// Findings (2026-11-15): note 24 true decay (100 ms windows, 20 s held) is about 2.08 dB/s
// (T60 28.8 s, inside decay.t60_max_s = 30); the 78.6 s of the early report predates the fit.
// The metric over the 1.8 s held window of the test piece reads 31-34 s (a 3 dB fit of a
// 60 dB claim), so it is only an estimate there, not a model bug.
#[test]
fn note_24_true_decay_stays_within_t60_max() {
    for (name, src) in [("physical", PHYSICAL), ("sl990", SL990)] {
        let p = parse_modal_profile(src).unwrap();
        let x = held(&p, 24, 80, 20.0);
        let db = window_db(&x, 0.1);
        let pk = db.iter().cloned().fold(f64::MIN, f64::max);
        let jp = db.iter().position(|&v| v == pk).unwrap();
        let pts: Vec<(f64, f64)> = (jp..db.len()).filter(|&j| db[j] > pk - 40.0).map(|j| (j as f64 * 0.1, db[j])).collect();
        let t60 = -60.0 / slope(&pts);
        println!("{name}: true t60 {t60:.1} s");
        assert!(t60 <= p.decay.t60_max_s as f64 * 1.05, "{name}: true t60 {t60}");
        let seg = Segment { index: 0, section: "k".into(), onset_s: 0.0, end_s: 2.0, held_end_s: 1.8, notes: vec![24], velocity: 80 };
        let m = analyze(&x, SR, &[seg], 0.0).segments[0].t60_s.unwrap();
        assert!(m / t60 < 1.25 && m / t60 > 0.8, "{name}: short-window metric {m} vs true {t60}");
    }
}

#[test]
fn note_84_metric_brightness_grows_with_velocity() {
    for (name, src) in [("physical", PHYSICAL), ("sl990", SL990)] {
        let p = parse_modal_profile(src).unwrap();
        let b: Vec<f64> = [8u8, 16, 24, 32, 48]
            .iter()
            .map(|&v| {
                let x = held(&p, 84, v, 2.0);
                let seg = Segment { index: 0, section: "k".into(), onset_s: 0.0, end_s: 2.0, held_end_s: 1.8, notes: vec![84], velocity: v };
                analyze(&x, SR, &[seg], 0.0).segments[0].brightness.unwrap()
            })
            .collect();
        println!("{name}: n84 metric brightness {b:?}");
        for w in b.windows(2) {
            assert!(w[1] > w[0], "{name}: brightness not rising with velocity {b:?}");
        }
    }
}
