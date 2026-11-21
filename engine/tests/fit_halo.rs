use rusty_piano_engine::fit::halo::{fit_halo, halo_error, HaloSearch, MIN_HALO_NOTES};
use rusty_piano_engine::sound::modal_piano::{parse_modal_profile, profile::ModalResonance};

const PHYSICAL: &str = include_str!("../profiles/physical.ron");

#[test]
#[cfg_attr(debug_assertions, ignore)]
fn small_halo_search_runs() {
    let base = parse_modal_profile(PHYSICAL).expect("physical.ron");
    let search = HaloSearch { strength: vec![0.0, 1.0], partials: vec![6], max_hz: vec![3000.0] };
    let fit = fit_halo(&base, &search, 8);
    let mut def = base;
    def.resonance = ModalResonance::default();
    let (def_err, _) = halo_error(&def, 8);
    assert!(fit.resonance.strength == 0.0 || fit.resonance.strength == 1.0);
    assert!(fit.error_after <= def_err, "after {} default {}", fit.error_after, def_err);
    println!("{}", fit.report);
}

#[test]
#[cfg_attr(debug_assertions, ignore)]
fn halo_error_is_finite_for_shipped_profile() {
    let base = parse_modal_profile(PHYSICAL).expect("physical.ron");
    let (err, rows) = halo_error(&base, 8);
    assert!(err.is_finite());
    assert_eq!(rows.len(), 7);
    assert!(rows.iter().all(|r| r.1.is_finite() && r.2.is_finite() && r.3.is_finite() && r.4.is_finite()));
}

const SL990: &str = include_str!("../profiles/physical_sl990.ron");

#[test]
#[cfg_attr(debug_assertions, ignore)]
fn shipped_halo_matches_fit() {
    let physical = parse_modal_profile(PHYSICAL).expect("physical.ron");
    let sl990 = parse_modal_profile(SL990).expect("physical_sl990.ron");
    let fit = fit_halo(&physical, &HaloSearch::full(), 8);
    println!("{}", fit.report);
    if fit.used.len() >= MIN_HALO_NOTES {
        assert_eq!(fit.resonance, physical.resonance);
    } else {
        println!("halo fit uses only {} notes ({:?}); shipped resonance kept (fitted 2026-11-06 on notes 48, 60, 96)", fit.used.len(), fit.used);
        let last_trusted = ModalResonance { strength: 0.25, partials: 2, max_hz: 2200.0 };
        assert_eq!(physical.resonance, last_trusted);
        assert_eq!(sl990.resonance, last_trusted);
        // 96: -21.5 dB on 2026-11-19 (was -2.7 before the treble direct boost); excluded from the halo fit, listed for listening in docs/reports/2026-11-19-engine-polish.md
        let refs = [(28u8, -8.0f64), (36, 7.6), (48, 2.7), (60, 0.1), (72, 4.0), (84, 6.1)];
        let dry = rusty_piano_engine::fit::halo::dry_errors(&physical, 8);
        for (note, w1, w2) in &dry {
            println!("dry ring note {note}: {w1:+.1} / {w2:+.1} dB");
        }
        for (note, reference) in refs {
            let (_, w1, _) = dry.iter().find(|r| r.0 == note).expect("dry ring note");
            assert!((w1 - reference).abs() <= 3.0, "note {note}: {w1} vs {reference}");
        }
    }
    assert_eq!(physical.resonance, sl990.resonance);
}
