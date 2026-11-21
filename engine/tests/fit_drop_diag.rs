use rusty_piano_engine::{
    fit::{
        analysis::analyze_note,
        evaluate::render_note,
        reference::{load_ref_set, parallel_map},
    },
    sound::modal_piano::{parse_modal_profile, tables::NoteTable, ModalProfile},
};
use std::path::Path;

const PHYSICAL: &str = include_str!("../profiles/physical.ron");

#[derive(Clone, Default)]
struct Variant {
    name: String,
    det: Option<f32>,
    aft: Option<f32>,
    t60_mul: Option<f32>,
    spread: Option<f32>,
    clf: Option<f32>,
    cpl: Option<f32>,
    cp: Option<usize>,
}

fn variants() -> Vec<Variant> {
    let mut v = vec![Variant { name: "shipped".into(), ..Default::default() }];
    for (name, d) in [("det0", 0.0), ("det0.25", 0.25), ("det0.5", 0.5), ("det2", 2.0), ("det4", 4.0)] {
        v.push(Variant { name: name.into(), det: Some(d), ..Default::default() });
    }
    for (name, s) in [("spr0", 0.0), ("spr0.1", 0.1), ("spr0.5", 0.5)] {
        v.push(Variant { name: name.into(), spread: Some(s), ..Default::default() });
    }
    for (name, a) in [("aft0.1", 0.1), ("aft0.5", 0.5), ("aft1", 1.0)] {
        v.push(Variant { name: name.into(), aft: Some(a), ..Default::default() });
    }
    for (name, c) in [("clf0.5", 0.5), ("clf0.95", 0.95)] {
        v.push(Variant { name: name.into(), clf: Some(c), ..Default::default() });
    }
    for (name, c) in [("cpl0", 0.0), ("cpl0.5", 0.5)] {
        v.push(Variant { name: name.into(), cpl: Some(c), ..Default::default() });
    }
    for (name, c) in [("cp0", 0usize), ("cp4", 4)] {
        v.push(Variant { name: name.into(), cp: Some(c), ..Default::default() });
    }
    for d in [0.0f32, 0.5, 1.0] {
        for s in [0.0f32, 0.1, 0.25] {
            for t in [0.8f32, 1.0, 1.25] {
                v.push(Variant {
                    name: format!("g d{d:?} s{s:?} t{t:?}"),
                    det: Some(d),
                    spread: Some(s),
                    t60_mul: Some(t),
                    ..Default::default()
                });
            }
        }
    }
    v
}

fn apply(p: &ModalProfile, note: u8, v: &Variant) -> ModalProfile {
    let mut q = *p;
    let idx = (note - 21) as usize;
    let mut a = q.notes.anchors().to_vec();
    if let Some(d) = v.det {
        a[idx].detune = d;
    }
    if let Some(x) = v.aft {
        a[idx].aftersound = x;
    }
    if let Some(m) = v.t60_mul {
        a[idx].t60 *= m;
    }
    q.notes = NoteTable::from_anchors(&a).expect("anchors valid");
    if let Some(s) = v.spread {
        q.strings.unison_decay_spread = s;
    }
    if let Some(c) = v.clf {
        q.soundboard.coupling_loss_fraction = c;
    }
    if let Some(c) = v.cpl {
        q.soundboard.coupling = c;
    }
    if let Some(c) = v.cp {
        q.soundboard.coupled_partials = c;
    }
    q
}

fn cost(d1e: f64, d2e: f64) -> f64 {
    (d1e / 2.0).powi(2) + (d2e / 3.0).powi(2)
}

fn inside(d1e: f64, d2e: f64) -> bool {
    d1e.abs() <= 3.0 && d2e.abs() <= 5.0
}

fn yn(b: bool) -> &'static str {
    if b {
        "yes"
    } else {
        "no"
    }
}

fn median(v: &[f64]) -> f64 {
    if v.is_empty() {
        return f64::NAN;
    }
    let mut s = v.to_vec();
    s.sort_by(|a, b| a.total_cmp(b));
    s[s.len() / 2]
}

fn list(v: &[String]) -> String {
    if v.is_empty() {
        "none".into()
    } else {
        v.join(" ")
    }
}

#[test]
#[cfg_attr(debug_assertions, ignore)]
fn drop_diag_unison_and_coupling() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("renders/reference/ny-steinway-d-player");
    if !dir.is_dir() {
        println!("SKIPPED: reference folder {} is missing", dir.display());
        return;
    }
    let p = parse_modal_profile(PHYSICAL).expect("physical.ron parses");
    let notes: Vec<u8> = vec![57, 60, 64, 65, 67, 68, 70, 71, 73, 76];
    let refs = load_ref_set(&dir, &notes, 4).expect("load references");
    let vars = variants();
    let nvar = vars.len();
    let total = notes.len() * nvar;

    let res: Vec<Option<(f64, f64)>> = parallel_map(total, 4, |i| {
        let (note, v) = (notes[i / nvar], &vars[i % nvar]);
        let q = apply(&p, note, v);
        let x = render_note(&q, note, 64, 2.5, 0.0);
        let o = analyze_note(&x, 48000, note, 2.5);
        let r = &refs.get(note, 64)?.1;
        Some((o.d1_db? - r.d1_db?, o.d2_db? - r.d2_db?))
    });
    let cell = |ni: usize, vi: usize| res[ni * nvar + vi];

    let mut shipped_outside: Vec<String> = Vec::new();
    let mut best_single_inside: Vec<String> = Vec::new();
    let mut best_grid_inside: Vec<String> = Vec::new();
    let mut shipped_costs: Vec<f64> = Vec::new();
    let mut grid_costs: Vec<f64> = Vec::new();
    let mut single_wins: Vec<usize> = Vec::new();

    let groups: [(&str, std::ops::Range<usize>); 6] = [
        ("unison detune", 1..6),
        ("unison spread", 6..9),
        ("aftersound", 9..12),
        ("coupling loss fraction", 12..14),
        ("coupling", 14..16),
        ("coupled partials", 16..18),
    ];

    for (ni, &n) in notes.iter().enumerate() {
        assert!(cell(ni, 0).is_some(), "note {n}: shipped d1e/d2e missing");
        let (sd1, sd2) = cell(ni, 0).unwrap();
        let sc = cost(sd1, sd2);
        shipped_costs.push(sc);
        if !inside(sd1, sd2) {
            shipped_outside.push(n.to_string());
        }
        let a = &p.notes.anchors()[(n - 21) as usize];
        println!(
            "note {n}: shipped t60={:.3} aftersound={:.3} damping={:.3} detune={:.3} prompt_db_per_s={:.3} after_level_db={:.3} d1e={sd1:+.1} d2e={sd2:+.1} cost={sc:.2} inside={}",
            a.t60,
            a.aftersound,
            a.damping,
            a.detune,
            a.prompt_db_per_s,
            a.after_level_db,
            yn(inside(sd1, sd2))
        );

        for (gname, range) in groups.iter() {
            let mut line = format!("  {gname}:");
            for vi in range.clone() {
                match cell(ni, vi) {
                    Some((e1, e2)) => line += &format!(" {} {:.1}/{:.1}", vars[vi].name, e1, e2),
                    None => line += &format!(" {} n/a", vars[vi].name),
                }
            }
            println!("{line}");
        }

        let best = |range: std::ops::Range<usize>| -> Option<(usize, f64, f64, f64)> {
            range
                .filter_map(|vi| cell(ni, vi).map(|(e1, e2)| (vi, e1, e2, cost(e1, e2))))
                .min_by(|a, b| a.3.total_cmp(&b.3))
        };

        match best(1..nvar.min(18)) {
            Some((vi, e1, e2, c)) => {
                println!(
                    "  best single: {} d1e={e1:+.1} d2e={e2:+.1} cost={c:.2} inside={}",
                    vars[vi].name,
                    yn(inside(e1, e2))
                );
                single_wins.push(vi);
                if inside(e1, e2) {
                    best_single_inside.push(format!("{n}:{}", vars[vi].name));
                }
            }
            None => println!("  best single: none"),
        }

        match best(18..nvar) {
            Some((vi, e1, e2, c)) => {
                println!(
                    "  best grid: {} d1e={e1:+.1} d2e={e2:+.1} cost={c:.2} inside={}",
                    vars[vi].name,
                    yn(inside(e1, e2))
                );
                grid_costs.push(c);
                if inside(e1, e2) {
                    best_grid_inside.push(format!("{n}:{}", vars[vi].name));
                }
            }
            None => println!("  best grid: none"),
        }
    }

    let (top_vi, top_n) = (1..nvar.min(18))
        .map(|vi| (vi, single_wins.iter().filter(|&&w| w == vi).count()))
        .fold((1, 0), |acc, e| if e.1 > acc.1 { e } else { acc });
    println!(
        "drop diag: shipped outside gate {}; best single inside {}; best grid inside {}; median shipped cost {:.2}; median best-grid cost {:.2}; most-often best single {} ({} of {} notes)",
        list(&shipped_outside),
        list(&best_single_inside),
        list(&best_grid_inside),
        median(&shipped_costs),
        median(&grid_costs),
        vars[top_vi].name,
        top_n,
        notes.len()
    );
}
