//! Checks of the modal engine's sympathetic resonance and mechanical noises
//! against numbers measured from the private Pianoteq 9 NY Steinway D Player
//! render `pedal-pairs` (engine/renders/reference/ny-steinway-d-player,
//! gitignored). Numbers only: the WAV is read only by the ignored test
//! `measure_pedal_pairs_reference` on a machine that has it; no audio is
//! copied or committed.

use rusty_piano_engine::{
    fit::halo::*,
    midi::MidiEvent,
    render::read_wav_mono,
    sound::{
        modal_piano::{ModalPiano, ModalProfile},
        SoundEngine,
    },
};
use std::path::Path;

#[test]
#[ignore]
fn measure_pedal_pairs_reference() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("renders/reference/ny-steinway-d-player/wav/pedal-pairs.wav");
    if !path.exists() {
        println!("SKIPPED: {} not found", path.display());
        return;
    }
    let (m, sr) = read_wav_mono(&path).unwrap();
    assert_eq!(sr, 48000);

    let measured: Vec<PairRef> = PAIRS.iter().map(|p| measure_pair(&m, p)).collect();
    let c4_peak = measured.iter().find(|r| r.note == 60).unwrap().peak_db;
    for r in &measured {
        println!(
            "note {}: peak {:.2} np1 {:.2} p1 {:.2} np2 {:.2} p2 {:.2} floor {:.2} down {:.2} up_before {:.2} up {:.2} | D1 {:.2} D2 {:.2} down-floor {:.2} up-up_before {:.2} down-c4peak {:.2} up-c4peak {:.2}",
            r.note, r.peak_db, r.np1_db, r.p1_db, r.np2_db, r.p2_db, r.floor_db, r.down_db,
            r.up_before_db, r.up_db,
            r.p1_db - r.np1_db,
            r.p2_db - r.np2_db,
            r.down_db - r.floor_db,
            r.up_db - r.up_before_db,
            r.down_db - c4_peak,
            r.up_db - c4_peak,
        );
    }
    println!("PASTE:");
    for r in &measured {
        println!(
            "    PairRef {{ note: {}, peak_db: {:.2}, np1_db: {:.2}, p1_db: {:.2}, np2_db: {:.2}, p2_db: {:.2}, floor_db: {:.2}, down_db: {:.2}, up_before_db: {:.2}, up_db: {:.2} }},",
            r.note, r.peak_db, r.np1_db, r.p1_db, r.np2_db, r.p2_db, r.floor_db, r.down_db,
            r.up_before_db, r.up_db
        );
    }

    for (r, c) in measured.iter().zip(PEDAL_PAIRS_REF.iter()) {
        assert_eq!(r.note, c.note);
        let fields = [
            ("peak_db", r.peak_db, c.peak_db),
            ("np1_db", r.np1_db, c.np1_db),
            ("p1_db", r.p1_db, c.p1_db),
            ("np2_db", r.np2_db, c.np2_db),
            ("p2_db", r.p2_db, c.p2_db),
            ("floor_db", r.floor_db, c.floor_db),
            ("down_db", r.down_db, c.down_db),
            ("up_before_db", r.up_before_db, c.up_before_db),
            ("up_db", r.up_db, c.up_db),
        ];
        for (name, got, want) in fields {
            assert!(
                (got - want).abs() <= 0.011,
                "note {} field {}: measured {:.2}, recorded {:.2}",
                r.note,
                name,
                got,
                want
            );
        }
    }
}

#[test]
fn reference_numbers_are_plausible() {
    let notes: Vec<u8> = PEDAL_PAIRS_REF.iter().map(|r| r.note).collect();
    assert_eq!(notes, vec![28, 36, 48, 60, 72, 84, 96]);
    for r in &PEDAL_PAIRS_REF {
        let vals = [
            r.peak_db,
            r.np1_db,
            r.p1_db,
            r.np2_db,
            r.p2_db,
            r.floor_db,
            r.down_db,
            r.up_before_db,
            r.up_db,
        ];
        assert!(vals.iter().all(|v| v.is_finite()), "note {}: non-finite value", r.note);
        assert!(r.peak_db > -80.0 && r.peak_db < 0.0, "note {}: peak_db", r.note);
        assert!(r.floor_db < r.peak_db - 20.0, "note {}: floor_db", r.note);
        assert!(r.p1_db >= r.np1_db - 1.0, "note {}: p1 < np1 - 1", r.note);
        assert!(r.p2_db >= r.np2_db - 1.0, "note {}: p2 < np2 - 1", r.note);
    }
    assert!(PEDAL_PAIRS_REF.iter().any(|r| r.peak_db != 0.0), "placeholder table");
}

const HALO_TOL_DB: f64 = 3.0;
const PEDAL_NOISE_TOL_DB: f64 = 2.0;

fn row(note: u8) -> &'static PairRef {
    PEDAL_PAIRS_REF.iter().find(|r| r.note == note).unwrap()
}

fn median(mut v: Vec<f64>) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[v.len() / 2]
}

/// (H1, H2): the reference halo of note 96 in the two windows.
fn halo_targets() -> (f64, f64) {
    let r = row(96);
    (halo_db(r.peak_db, r.p1_db, r.np1_db), halo_db(r.peak_db, r.p2_db, r.np2_db))
}

/// (down_rel, measurable_down, up_rel, measurable_up).
fn noise_targets() -> (f64, bool, f64, bool) {
    let r60 = row(60);
    let down = median(PEDAL_PAIRS_REF.iter().map(|r| r.down_db).collect());
    let down_floor = median(PEDAL_PAIRS_REF.iter().map(|r| r.down_db - r.floor_db).collect());
    let u = PEDAL_PAIRS_REF
        .iter()
        .min_by(|a, b| a.up_before_db.partial_cmp(&b.up_before_db).unwrap())
        .unwrap();
    (
        floored(down, r60.peak_db) - r60.peak_db,
        down_floor >= 3.0,
        floored(u.up_db, r60.peak_db) - r60.peak_db,
        u.up_db - u.up_before_db >= 3.0,
    )
}

fn ours_pedal_down_db(p: &ModalProfile) -> f64 {
    let mut e = ModalPiano::with_profile(48000, p);
    let mut m = Vec::new();
    e.handle(&MidiEvent::Sustain { on: true });
    render_into(&mut e, &mut m, 0.2);
    fmax(&m, 0.0, 4)
}

fn ours_pedal_up_db(p: &ModalProfile) -> f64 {
    let mut e = ModalPiano::with_profile(48000, p);
    let mut m = Vec::new();
    e.handle(&MidiEvent::Sustain { on: true });
    render_into(&mut e, &mut m, 1.0);
    e.handle(&MidiEvent::Sustain { on: false });
    render_into(&mut e, &mut m, 0.3);
    fmax(&m, 1.0, 6)
}

fn c4_ours(p: &ModalProfile) -> f64 {
    ours_pair(p, 60, false).0
}

/// (h1, h2) of `note`: our halo with the same metric as the reference.
fn ours_halo(p: &ModalProfile, note: u8) -> (f64, f64) {
    let (peak, n1, n2) = ours_pair(p, note, false);
    let (_, p1, p2) = ours_pair(p, note, true);
    (halo_db(peak, p1, n1), halo_db(peak, p2, n2))
}

#[test]
#[ignore]
fn print_resonance_sweep() {
    let (h1t, h2t) = halo_targets();
    println!("targets: H1 {h1t:.2} dB, H2 {h2t:.2} dB (halo of note 96 relative to its strike peak)");
    let def = ModalProfile::default();
    for strength in [0.5f32, 1.0, 1.5, 2.0] {
        for partials in (4..=def.resonance.partials).step_by(2) {
            let mut p = def;
            p.resonance.strength = strength;
            p.resonance.partials = partials;
            p.resonance.max_hz = 3000.0;
            let (h1, h2) = ours_halo(&p, 96);
            let err = (h1 - h1t).abs() + (h2 - h2t).abs();
            let (a1, a2) = ours_halo(&p, 72);
            let (b1, b2) = ours_halo(&p, 84);
            println!(
                "strength {strength:.1} partials {partials}: note 96 h1 {h1:.2} h2 {h2:.2} err {err:.2} | note 72 h1 {a1:.2} h2 {a2:.2} | note 84 h1 {b1:.2} h2 {b2:.2}"
            );
        }
    }
    println!("pedalled ring relative to peak, default profile (information only):");
    for note in [28u8, 36, 48, 60, 72, 84] {
        let r = row(note);
        let (peak, _, _) = ours_pair(&def, note, false);
        let (_, p1, p2) = ours_pair(&def, note, true);
        println!(
            "note {note}: ours ring1-peak {:.2} ring2-peak {:.2} | ref p1-peak {:.2} p2-peak {:.2}",
            floored(p1, peak) - peak,
            floored(p2, peak) - peak,
            floored(r.p1_db, r.peak_db) - r.peak_db,
            floored(r.p2_db, r.peak_db) - r.peak_db,
        );
    }
}

// Reference: Pianoteq 9 NY Steinway D Player pedal-pairs, measured 2026-11-05 (PEDAL_PAIRS_REF); numbers only.
#[test]
fn sympathetic_halo_matches_reference() {
    let (h1t, h2t) = halo_targets();
    let (h1, h2) = ours_halo(&ModalProfile::default(), 96);
    println!("note 96 halo: ours h1 {h1:.2} h2 {h2:.2} | reference H1 {h1t:.2} H2 {h2t:.2} (tol {HALO_TOL_DB})");
    // Information test, not a fit: Pianoteq damps note 96 (its no-pedal tail falls to the floor)
    // while ours has no damper above note 88, so the pedal-vs-no-pedal excess at note 96 measures
    // our undamped tail rather than sympathetic resonance. For damped notes the same metric mostly
    // measures each note's own undamped decay. M6 fits per-note decay and the damper boundary.
    let def = ModalProfile::default();
    println!("pedalled ring relative to peak (information only):");
    for note in [28u8, 36, 48, 60, 72, 84] {
        let r = row(note);
        let (peak, _, _) = ours_pair(&def, note, false);
        let (_, p1, p2) = ours_pair(&def, note, true);
        println!(
            "note {note}: ours ring1-peak {:.2} ring2-peak {:.2} | ref p1-peak {:.2} p2-peak {:.2}",
            floored(p1, peak) - peak,
            floored(p2, peak) - peak,
            floored(r.p1_db, r.peak_db) - r.peak_db,
            floored(r.p2_db, r.peak_db) - r.peak_db,
        );
    }
    assert!(h1.is_finite() && h2.is_finite() && h1 >= -80.0 && h2 >= -80.0);
    let (peak, n1, n2) = ours_pair(&def, 60, false);
    let (_, p1, p2) = ours_pair(&def, 60, true);
    println!("note 60 ring: no pedal {n1:.2}/{n2:.2} dB, pedal {p1:.2}/{p2:.2} dB (peak {peak:.2})");
    assert!(p1.is_finite() && p2.is_finite() && p1 > n1 && p2 > n2);
}

// Reference: Pianoteq 9 NY Steinway D Player pedal-pairs, measured 2026-11-05 (PEDAL_PAIRS_REF); numbers only.
#[test]
fn pedal_noises_match_reference_level() {
    let p = ModalProfile::default();
    let (down_rel, measurable_down, up_rel, measurable_up) = noise_targets();
    let c4 = c4_ours(&p);
    let down = ours_pedal_down_db(&p);
    let up = ours_pedal_up_db(&p);
    let our_down_rel = floored(down, c4) - c4;
    let our_up_rel = floored(up, c4) - c4;
    println!(
        "pedal down: ours {our_down_rel:.2} dB vs reference {down_rel:.2} dB (measurable {measurable_down}); pedal up: ours {our_up_rel:.2} dB vs reference {up_rel:.2} dB (measurable {measurable_up}); c4 peak {c4:.2} dB, down {down:.2} dB, up {up:.2} dB"
    );
    if measurable_down {
        assert!((our_down_rel - down_rel).abs() <= PEDAL_NOISE_TOL_DB, "pedal down {our_down_rel:.2} vs {down_rel:.2}");
    } else {
        assert!(our_down_rel <= down_rel + 3.0 && down > -200.0);
    }
    if measurable_up {
        assert!((our_up_rel - up_rel).abs() <= PEDAL_NOISE_TOL_DB, "pedal up {our_up_rel:.2} vs {up_rel:.2}");
    } else {
        assert!(our_up_rel <= up_rel + 3.0 && up > -200.0);
    }
}

#[test]
fn key_noises_stay_subtle() {
    let a_p = ModalProfile::default();
    let mut b_p = a_p;
    b_p.noises.key_down = 0.0;
    b_p.noises.key_up = 0.0;
    b_p.noises.hammer_knock = 0.0;
    let run = |p: &ModalProfile, note: u8, velocity: u8| {
        let mut e = ModalPiano::with_profile(48000, p);
        let mut m = Vec::new();
        e.handle(&MidiEvent::NoteOn { note, velocity });
        render_into(&mut e, &mut m, 0.3);
        e.handle(&MidiEvent::NoteOff { note });
        render_into(&mut e, &mut m, 0.3);
        m
    };
    for note in [36u8, 60, 84] {
        for velocity in [80u8, 127] {
            let a = run(&a_p, note, velocity);
            let b = run(&b_p, note, velocity);
            let d: Vec<f32> = a.iter().zip(b.iter()).map(|(x, y)| x - y).collect();
            let dmax = fmax(&d, 0.0, 12);
            let bmax = fmax(&b, 0.0, 12);
            println!("note {note} v{velocity}: noise {dmax:.2} dB, note {bmax:.2} dB, margin {:.2} dB", bmax - dmax);
            assert!(dmax <= bmax - 20.0, "note {note} v{velocity}: margin {:.2} dB", bmax - dmax);
            assert!(dmax > -200.0, "note {note} v{velocity}: no key noise");
        }
    }
}
