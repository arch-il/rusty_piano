use rusty_piano_engine::{
    fit::{
        analysis::analyze_note,
        reference::{load_ref_set, parallel_map, AFTER_KEY_UP_S},
    },
    midi::MidiEvent,
    render::render_events_stereo,
    sound::modal_piano::{parse_modal_profile, profile::ModalNoises, ModalPiano, ModalProfile},
};
use std::path::Path;

const PHYSICAL: &str = include_str!("../profiles/physical.ron");
const RATE: u32 = 48000;
const VELS: [u8; 5] = [16, 40, 64, 96, 127];

fn render(p: &ModalProfile, noises: ModalNoises, note: u8, velocity: u8, hold_s: f64, tail_s: f64) -> Vec<f32> {
    let mut q = *p;
    q.output.master_volume = 0.05;
    q.noises = noises;
    q.resonance.strength = 0.0;
    q.reverb.mix = 0.0;
    let mut e = ModalPiano::with_profile(RATE, &q);
    let events = vec![
        (0u64, MidiEvent::NoteOn { note, velocity }),
        ((hold_s * 1e6).round() as u64, MidiEvent::NoteOff { note }),
    ];
    let buf = render_events_stereo(&mut e, &events, RATE, tail_s);
    buf.left.iter().zip(buf.right.iter()).map(|(l, r)| 0.5 * (l + r) * 20.0).collect()
}

fn median(v: &[f64]) -> f64 {
    if v.is_empty() {
        return f64::NAN;
    }
    let mut s = v.to_vec();
    s.sort_by(|a, b| a.total_cmp(b));
    s[s.len() / 2]
}

#[test]
#[cfg_attr(debug_assertions, ignore)]
fn centroid_error_by_noise_variant() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("renders/reference/ny-steinway-d-player");
    if !dir.is_dir() {
        println!("SKIPPED: reference folder {} is missing", dir.display());
        return;
    }
    let p = parse_modal_profile(PHYSICAL).expect("physical.ron parses");
    let notes: Vec<u8> = vec![21, 24, 28, 33, 36, 40, 45, 48, 52, 57, 60, 64, 69, 72, 76, 81, 84, 88, 93, 96, 100, 105, 108];
    let refs = load_ref_set(&dir, &notes, 8).expect("load references");

    let hk = p.noises.hammer_knock;
    let off = ModalNoises::off();
    let variants: [ModalNoises; 5] = [
        off,
        ModalNoises { hammer_knock: hk, ..off },
        p.noises,
        ModalNoises { hammer_knock: hk * 4.0, ..off },
        ModalNoises { hammer_knock: hk * 16.0, ..off },
    ];

    let nv = VELS.len();
    let nvar = variants.len();
    let total = notes.len() * nvar * nv;
    let res: Vec<Option<f64>> = parallel_map(total, 8, |i| {
        let ni = i / (nvar * nv);
        let vi = (i / nv) % nvar;
        let k = i % nv;
        let (note, vel) = (notes[ni], VELS[k]);
        let (_, rf) = refs.get(note, vel)?;
        let (hold, tail) = if vel == 64 {
            (refs.get(note, 64)?.0.hold_s(), AFTER_KEY_UP_S)
        } else {
            (0.5, 0.0)
        };
        let x = render(&p, variants[vi], note, vel, hold, tail);
        let o = analyze_note(&x, RATE, note, hold);
        let (a, b) = (o.centroid_hz?, rf.centroid_hz?);
        if a > 0.0 && b > 0.0 {
            Some(12.0 * (a / b).log2())
        } else {
            None
        }
    });

    let mut err = vec![vec![f64::NAN; nvar]; notes.len()];
    for (ni, row) in err.iter_mut().enumerate() {
        for (vi, cell) in row.iter_mut().enumerate() {
            let vals: Vec<f64> = (0..nv).filter_map(|k| res[(ni * nvar + vi) * nv + k]).collect();
            if !vals.is_empty() {
                *cell = vals.iter().sum::<f64>() / vals.len() as f64;
            }
        }
    }

    println!("hammer_knock {hk}; centroid error in semitones (ours - reference)");
    println!("note       a       b       c       d       e");
    for (ni, n) in notes.iter().enumerate() {
        let r = &err[ni];
        println!("{n:>4} {:>7.2} {:>7.2} {:>7.2} {:>7.2} {:>7.2}", r[0], r[1], r[2], r[3], r[4]);
    }
    let names = ["a (all off)", "b (knock only)", "c (all on)", "d (knock x4)", "e (knock x16)"];
    for (vi, name) in names.iter().enumerate().take(nvar) {
        let col = |f: &dyn Fn(u8) -> bool| -> Vec<f64> {
            notes.iter().enumerate().filter(|(_, n)| f(**n)).map(|(ni, _)| err[ni][vi]).filter(|x| x.is_finite()).collect()
        };
        let abs: Vec<f64> = col(&|_| true).iter().map(|x| x.abs()).collect();
        println!(
            "{}: median |error| {:.2}; median signed notes<=40 {:.2}; median signed notes>=88 {:.2}",
            name,
            median(&abs),
            median(&col(&|n| n <= 40)),
            median(&col(&|n| n >= 88))
        );
    }
}
