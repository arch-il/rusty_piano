use rusty_piano_engine::{
    fit::{
        analysis::analyze_note,
        evaluate::render_note,
        reference::{load_ref_set, parallel_map, VELOCITIES},
    },
    sound::modal_piano::{parse_modal_profile, ModalProfile},
};
use std::path::Path;

const PHYSICAL: &str = include_str!("../profiles/physical.ron");
const NOTES: [u8; 18] = [21, 24, 28, 33, 36, 40, 45, 52, 60, 72, 84, 88, 91, 93, 96, 100, 104, 108];
const DIRECT_DB: [f32; 8] = [-24.0, -18.0, -12.0, -6.0, 6.0, 12.0, 18.0, 24.0];
const NAMES: [&str; 12] = [
    "shipped", "d-24", "d-18", "d-12", "d-6", "d+6", "d+12", "d+18", "d+24", "board0", "body4", "peak0",
];

fn median(v: &[f64]) -> f64 {
    if v.is_empty() {
        return f64::NAN;
    }
    let mut s = v.to_vec();
    s.sort_by(|a, b| a.total_cmp(b));
    s[s.len() / 2]
}

fn variants(p: &ModalProfile) -> Vec<ModalProfile> {
    let mut out = vec![*p];
    for db in DIRECT_DB {
        let mut q = *p;
        q.mics.direct_mix = p.mics.direct_mix * 10f32.powf(db / 20.0);
        out.push(q);
    }
    let mut q = *p;
    q.mics.board_mix = 0.0;
    out.push(q);
    let mut q = *p;
    q.mics.body_mix = 4.0 * p.mics.body_mix;
    out.push(q);
    let mut q = *p;
    q.soundboard.mode_peak = 0.0;
    out.push(q);
    out
}

fn finite_abs(v: &[f64]) -> Vec<f64> {
    v.iter().filter(|x| x.is_finite()).map(|x| x.abs()).collect()
}

fn signed(v: &[f64], keep: impl Fn(u8) -> bool) -> Vec<f64> {
    NOTES
        .iter()
        .zip(v)
        .filter(|(n, x)| keep(**n) && x.is_finite())
        .map(|(_, x)| *x)
        .collect()
}

#[test]
#[cfg_attr(debug_assertions, ignore)]
fn brightness_diag_direct_board_balance() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("renders/reference/ny-steinway-d-player");
    if !dir.is_dir() {
        println!("SKIPPED: reference folder {} is missing", dir.display());
        return;
    }
    let p = parse_modal_profile(PHYSICAL).unwrap();
    let refs = load_ref_set(&dir, &NOTES, 4).expect("load references");
    let vars = variants(&p);

    let nv = VELOCITIES.len();
    let nvar = vars.len();
    let kv64 = VELOCITIES.iter().position(|&v| v == 64).unwrap();
    let total = NOTES.len() * nvar * nv;
    let res: Vec<(Option<f64>, f64)> = parallel_map(total, 4, |i| {
        let ni = i / (nvar * nv);
        let vi = (i / nv) % nvar;
        let k = i % nv;
        let (note, vel) = (NOTES[ni], VELOCITIES[k]);
        let rf = &refs.get(note, vel).unwrap().1;
        let x = render_note(&vars[vi], note, vel, 0.5, 0.0);
        let o = analyze_note(&x, 48000, note, 0.5);
        let err = match (o.centroid_hz, rf.centroid_hz) {
            (Some(a), Some(b)) if a > 0.0 && b > 0.0 => Some(12.0 * (a / b).log2()),
            _ => None,
        };
        (err, o.peak_db)
    });

    let mut cell = vec![vec![f64::NAN; nvar]; NOTES.len()];
    let mut peak = vec![vec![f64::NAN; nvar]; NOTES.len()];
    for ni in 0..NOTES.len() {
        for vi in 0..nvar {
            let vals: Vec<f64> = (0..nv).filter_map(|k| res[(ni * nvar + vi) * nv + k].0).collect();
            if !vals.is_empty() {
                cell[ni][vi] = vals.iter().sum::<f64>() / vals.len() as f64;
            }
            peak[ni][vi] = res[(ni * nvar + vi) * nv + kv64].1;
        }
    }

    let db_of = |vi: usize| -> f64 {
        if vi == 0 {
            0.0
        } else {
            DIRECT_DB[vi - 1] as f64
        }
    };
    let mut best_vi: Vec<Option<usize>> = Vec::new();
    for row in cell.iter() {
        let bv = (0..=8usize)
            .filter(|&vi| row[vi].is_finite())
            .min_by(|&a, &b| row[a].abs().total_cmp(&row[b].abs()));
        best_vi.push(bv);
    }
    let best_cell: Vec<f64> = (0..NOTES.len()).map(|ni| best_vi[ni].map_or(f64::NAN, |vi| cell[ni][vi])).collect();

    println!("brightness diag table: centroid error in semitones (ours - reference), mean over velocities");
    print!("{:>4}", "note");
    for name in NAMES.iter() {
        print!(" {:>8}", name);
    }
    println!(" {:>8} {:>8} {:>8}", "bestdB", "bestcell", "shift_dB");
    for (ni, n) in NOTES.iter().enumerate() {
        print!("{n:>4}");
        for vi in 0..nvar {
            print!(" {:>8.2}", cell[ni][vi]);
        }
        let bdb = best_vi[ni].map_or(f64::NAN, db_of);
        let shift = best_vi[ni].map_or(f64::NAN, |vi| peak[ni][vi] - peak[ni][0]);
        println!(" {:>8.1} {:>8.2} {:>8.2}", bdb, best_cell[ni], shift);
    }

    let shipped: Vec<f64> = (0..NOTES.len()).map(|ni| cell[ni][0]).collect();
    let board0: Vec<f64> = (0..NOTES.len()).map(|ni| cell[ni][9]).collect();
    let peak0: Vec<f64> = (0..NOTES.len()).map(|ni| cell[ni][11]).collect();
    println!(
        "brightness diag: shipped median |err| {:.2} st; best-direct median |err| {:.2} st; median signed notes<=40 shipped {:.2} best {:.2} st; median signed notes>=88 shipped {:.2} best {:.2} st; board0 median |err| {:.2} st; peak0 median |err| {:.2} st",
        median(&finite_abs(&shipped)),
        median(&finite_abs(&best_cell)),
        median(&signed(&shipped, |n| n <= 40)),
        median(&signed(&best_cell, |n| n <= 40)),
        median(&signed(&shipped, |n| n >= 88)),
        median(&signed(&best_cell, |n| n >= 88)),
        median(&finite_abs(&board0)),
        median(&finite_abs(&peak0)),
    );

    assert_eq!(NOTES.len(), 18);
    for row in cell.iter() {
        assert!(row[0].is_finite());
    }
}
