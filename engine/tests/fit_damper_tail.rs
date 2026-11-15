use rusty_piano_engine::fit::analysis::analyze_note;
use rusty_piano_engine::fit::evaluate::{build_errors, render_note, Job};
use rusty_piano_engine::fit::reference::{RefNote, RefSet};
use rusty_piano_engine::sound::modal_piano::{parse_modal_profile, ModalProfile};

const SR: u32 = 48000;

fn physical() -> ModalProfile {
    let mut p = parse_modal_profile(include_str!("../profiles/physical.ron")).unwrap();
    p.decay.undamped_from_note = 90;
    p.decay.damper_tail_db = 0.0;
    p
}

#[test]
fn late_release_is_measured_for_damped_notes_only_and_follows_the_tail() {
    let p = physical();
    let x36 = render_note(&p, 36, 64, 1.0, 2.0);
    let x96 = render_note(&p, 96, 64, 1.0, 2.0);
    let f36 = analyze_note(&x36, SR, 36, 1.0);
    let f96 = analyze_note(&x96, SR, 96, 1.0);
    println!("late_release_db off: note 36 {:?}, note 96 {:?}", f36.late_release_db, f96.late_release_db);
    let refs = RefSet {
        items: [(36u8, f36), (96u8, f96)]
            .iter()
            .map(|&(note, f)| (RefNote { note, velocity: 64, on_s: 0.0, off_s: 1.0 }, f))
            .collect(),
    };
    let jobs = [36u8, 96].map(|note| Job { note, velocity: 64, hold_s: 1.0, full: true });
    let errors = build_errors(&refs, &jobs, &[f36, f96], &[36, 96], &p);
    assert_eq!(errors[1].late_release_db, None);
    assert!(f96.late_release_db.is_some());

    let mut q = p;
    q.decay.damper_tail_db = 40.0;
    q.decay.damper_tail_t60_bass_s = 3.0;
    let f_on = analyze_note(&render_note(&q, 36, 64, 1.0, 2.0), SR, 36, 1.0);
    let on = f_on.late_release_db.expect("damped note 36 late_release_db with tail");
    // Off, the damper takes note 36 below the -100 dB floor (None); the floor value stands in for it.
    let off = f36.late_release_db.unwrap_or(-100.0);
    println!("late_release_db note 36 off {off:.1}, on {on:.1}");
    assert!(on >= off + 10.0, "off {off} on {on}");

    let refs = RefSet { items: vec![(RefNote { note: 36, velocity: 64, on_s: 0.0, off_s: 1.0 }, f_on)] };
    let e = build_errors(&refs, &jobs[..1], &[f_on], &[36], &p);
    assert_eq!(e[0].late_release_db, Some(0.0));
}
