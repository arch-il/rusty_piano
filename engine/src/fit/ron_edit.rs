//! Writes fitted values into a profile RON template in place: only the values change, comments and layout stay.

use crate::sound::modal_piano::tables::NoteAnchor;
use crate::sound::modal_piano::ModalProfile;

fn with_point(s: String) -> String {
    if s.contains('.') {
        s
    } else {
        s + ".0"
    }
}

/// Plain decimal with `sig` significant digits, always with a '.'.
pub fn fmt_sig(x: f64, sig: usize) -> String {
    if x == 0.0 || !x.is_finite() {
        return with_point(format!("{x}"));
    }
    let mag = x.abs().log10().floor() as i64;
    let decimals = (sig as i64 - 1 - mag).max(0) as usize;
    with_point(format!("{x:.decimals$}"))
}

/// Plain decimal with `decimals` decimals, always with a '.'.
pub fn fmt_dec(x: f64, decimals: usize) -> String {
    with_point(format!("{x:.decimals$}"))
}

fn is_indented4(line: &str) -> bool {
    line.starts_with("    ") && !line[4..].starts_with(' ')
}

pub fn set_field(text: &str, section: &str, field: &str, value: &str) -> Result<String, String> {
    let mut lines: Vec<&str> = text.split_inclusive('\n').collect();
    let head = format!("{section}: (");
    let start = lines
        .iter()
        .position(|l| is_indented4(l) && l.trim() == head)
        .ok_or_else(|| format!("section {section} not found (field {section}.{field})"))?;
    let key = format!("{field}:");
    let mut found = None;
    for (i, l) in lines.iter().enumerate().skip(start + 1) {
        if is_indented4(l) && l.trim() == ")," {
            break;
        }
        if l.trim().starts_with(&key) {
            found = Some(i);
            break;
        }
    }
    let i = found.ok_or_else(|| format!("field {section}.{field} not found"))?;
    let line = lines[i];
    let body = line.trim_end_matches(['\r', '\n']);
    let ending = &line[body.len()..];
    let colon = body.find(&key).map(|k| k + key.len()).filter(|_| body.trim_end().ends_with(','));
    let colon = colon.ok_or_else(|| format!("field {section}.{field}: cannot read the line {}", body.trim()))?;
    let new_line = format!("{} {value},{ending}", &body[..colon]);
    lines[i] = &new_line;
    Ok(lines.concat())
}

pub fn set_notes(text: &str, anchors: &[NoteAnchor]) -> Result<String, String> {
    let lines: Vec<&str> = text.split_inclusive('\n').collect();
    let start = lines
        .iter()
        .position(|l| l.starts_with("    notes: ["))
        .ok_or_else(|| "notes: the line '    notes: [' was not found".to_string())?;
    let end = if lines[start].trim() == "notes: []," {
        start
    } else {
        (start + 1..lines.len())
            .find(|&i| is_indented4(lines[i]) && lines[i].trim() == "],")
            .ok_or_else(|| "notes: the closing '    ],' was not found".to_string())?
    };
    let nl = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let mut block = format!("    notes: [{nl}");
    for a in anchors {
        block.push_str(&format!(
            "        (note: {}, cents: {}, level_db: {}, t60: {}, damping: {}, inharmonicity: {}, hardness: {}, strike: {}, damper: {}, aftersound: {}, prompt_db_per_s: {}, after_level_db: {}, detune: {}, decay_spread: {}, damper_tail: {}, direct_db: {}),{nl}",
            a.note,
            fmt_dec(a.cents as f64, 2),
            fmt_dec(a.level_db as f64, 2),
            fmt_dec(a.t60 as f64, 3),
            fmt_dec(a.damping as f64, 3),
            fmt_dec(a.inharmonicity as f64, 3),
            fmt_dec(a.hardness as f64, 3),
            fmt_dec(a.strike as f64, 3),
            fmt_dec(a.damper as f64, 3),
            fmt_dec(a.aftersound as f64, 3),
            fmt_dec(a.prompt_db_per_s as f64, 2),
            fmt_dec(a.after_level_db as f64, 2),
            fmt_dec(a.detune as f64, 3),
            fmt_dec(a.decay_spread as f64, 3),
            fmt_dec(a.damper_tail as f64, 3),
            fmt_dec(a.direct_db as f64, 2),
        ));
    }
    block.push_str(&format!("    ],{nl}"));
    let mut out: String = lines[..start].concat();
    out.push_str(&block);
    out.push_str(&lines[end + 1..].concat());
    Ok(out)
}

pub const FITTED_FIELDS: &[(&str, &str)] = &[
    ("output", "output_gain"),
    ("velocity", "hammer_speed_min_mps"),
    ("velocity", "hammer_speed_max_mps"),
    ("velocity", "speed_curve"),
    ("hammer", "exponent_bass"),
    ("hammer", "exponent_treble"),
    ("soundboard", "coupling_loss_fraction"),
    ("eq", "low_shelf_db"),
    ("eq", "peak1_db"),
    ("eq", "peak2_db"),
    ("eq", "peak3_db"),
    ("eq", "high_shelf_db"),
    ("decay", "damper_tail_db"),
    ("decay", "damper_tail_t60_bass_s"),
    ("decay", "damper_tail_t60_treble_s"),
];

fn field_mut<'a>(p: &'a mut ModalProfile, section: &str, field: &str) -> Option<&'a mut f32> {
    match (section, field) {
        ("output", "output_gain") => Some(&mut p.output.output_gain),
        ("velocity", "hammer_speed_min_mps") => Some(&mut p.velocity.hammer_speed_min_mps),
        ("velocity", "hammer_speed_max_mps") => Some(&mut p.velocity.hammer_speed_max_mps),
        ("velocity", "speed_curve") => Some(&mut p.velocity.speed_curve),
        ("hammer", "exponent_bass") => Some(&mut p.hammer.exponent_bass),
        ("hammer", "exponent_treble") => Some(&mut p.hammer.exponent_treble),
        ("soundboard", "coupling_loss_fraction") => Some(&mut p.soundboard.coupling_loss_fraction),
        ("eq", "low_shelf_db") => Some(&mut p.eq.low_shelf_db),
        ("eq", "peak1_db") => Some(&mut p.eq.peak1_db),
        ("eq", "peak2_db") => Some(&mut p.eq.peak2_db),
        ("eq", "peak3_db") => Some(&mut p.eq.peak3_db),
        ("eq", "high_shelf_db") => Some(&mut p.eq.high_shelf_db),
        ("decay", "damper_tail_db") => Some(&mut p.decay.damper_tail_db),
        ("decay", "damper_tail_t60_bass_s") => Some(&mut p.decay.damper_tail_t60_bass_s),
        ("decay", "damper_tail_t60_treble_s") => Some(&mut p.decay.damper_tail_t60_treble_s),
        _ => None,
    }
}

pub fn field_value(p: &ModalProfile, section: &str, field: &str) -> Option<f64> {
    let mut q = *p;
    field_mut(&mut q, section, field).map(|v| *v as f64)
}

pub fn set_value(p: &mut ModalProfile, section: &str, field: &str, v: f64) -> bool {
    match field_mut(p, section, field) {
        Some(x) => {
            *x = v as f32;
            true
        }
        None => false,
    }
}

pub fn write_fitted(template: &str, p: &ModalProfile) -> Result<String, String> {
    let mut text = template.to_string();
    for &(s, f) in FITTED_FIELDS {
        let v = field_value(p, s, f).ok_or_else(|| format!("field {s}.{f} has no value"))?;
        let value = if (s, f) == ("output", "output_gain") {
            fmt_sig(v, 4)
        } else if s == "eq" {
            fmt_dec(v, 1)
        } else {
            fmt_dec(v, 3)
        };
        text = set_field(&text, s, f, &value)?;
    }
    text = set_field(&text, "decay", "undamped_from_note", &p.decay.undamped_from_note.to_string())?;
    set_notes(&text, p.notes.anchors())
}

/// Resets every fitted field, plus `resonance` (the halo is fitted separately by fit::halo).
pub fn unfitted(p: &ModalProfile) -> ModalProfile {
    let d = ModalProfile::default();
    let mut q = *p;
    for &(s, f) in FITTED_FIELDS {
        if let Some(v) = field_value(&d, s, f) {
            set_value(&mut q, s, f, v);
        }
    }
    q.decay.undamped_from_note = d.decay.undamped_from_note;
    q.notes = d.notes;
    q.resonance = d.resonance;
    q
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sound::modal_piano::parse_modal_profile;
    use crate::sound::modal_piano::tables::NoteTable;

    const PHYSICAL_RON: &str = include_str!("../../profiles/physical.ron");

    fn comment_lines(text: &str) -> usize {
        text.lines().filter(|l| l.trim_start().starts_with("//")).count()
    }

    fn assert_numbers_have_comments(text: &str) {
        let lines: Vec<&str> = text.lines().collect();
        for (i, line) in lines.iter().enumerate() {
            let t = line.trim();
            let is_number_line = match t.split_once(": ") {
                Some((key, value)) => {
                    key.starts_with(|c: char| c.is_ascii_lowercase())
                        && key.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
                        && (value.starts_with(|c: char| c.is_ascii_digit()) || value.starts_with('-'))
                }
                None => false,
            };
            if !is_number_line {
                continue;
            }
            let prev = lines[..i].iter().rev().map(|l| l.trim()).find(|l| !l.is_empty());
            assert!(prev.is_some_and(|p| p.starts_with("//")), "no comment above line: {t}");
        }
    }

    #[test]
    fn number_formats_have_a_point() {
        assert_eq!(fmt_sig(0.004512, 4), "0.004512");
        assert_eq!(fmt_sig(5.512, 4), "5.512");
        assert_eq!(fmt_sig(0.0, 4), "0.0");
        assert_eq!(fmt_sig(1200.0, 3), "1200.0");
        assert_eq!(fmt_dec(1.85, 3), "1.850");
        assert_eq!(fmt_dec(-3.0, 2), "-3.00");
        assert_eq!(fmt_dec(7.0, 0), "7.0");
    }

    #[test]
    fn ron_field_edit_keeps_comments() {
        let text = set_field(PHYSICAL_RON, "output", "output_gain", &fmt_sig(0.004512, 4)).unwrap();
        let text = set_field(&text, "velocity", "speed_curve", &fmt_dec(1.85, 3)).unwrap();
        let mut expected = parse_modal_profile(PHYSICAL_RON).unwrap();
        expected.output.output_gain = 0.004512;
        expected.velocity.speed_curve = 1.85;
        assert_eq!(parse_modal_profile(&text).unwrap(), expected);
        assert_eq!(comment_lines(&text), comment_lines(PHYSICAL_RON));
        assert_eq!(text.lines().count(), PHYSICAL_RON.lines().count());
        assert_numbers_have_comments(&text);
    }

    #[test]
    fn notes_block_round_trip() {
        let a = [
            NoteAnchor {
                cents: -3.21,
                level_db: 1.5,
                t60: 1.234,
                damping: 0.8,
                inharmonicity: 2.5,
                hardness: 0.75,
                damper: 1.6,
                aftersound: 0.9,
                strike: 0.8,
                prompt_db_per_s: 42.5,
                after_level_db: -12.25,
                detune: 0.5,
                decay_spread: 0.4,
                damper_tail: 2.5,
                direct_db: 6.25,
                ..NoteAnchor::neutral(21)
            },
            NoteAnchor { cents: 4.0, level_db: -2.25, t60: 0.5, hardness: 1.333, ..NoteAnchor::neutral(60) },
            NoteAnchor { cents: 12.34, inharmonicity: 0.3, damper: 3.0, aftersound: 2.0, ..NoteAnchor::neutral(108) },
        ];
        let mut p = parse_modal_profile(PHYSICAL_RON).unwrap();
        p.notes = NoteTable::from_anchors(&a).unwrap();
        p.output.output_gain = 0.003141;
        p.hammer.exponent_bass = 2.45;
        p.decay.undamped_from_note = 97;
        let text = write_fitted(PHYSICAL_RON, &p).unwrap();
        let q = parse_modal_profile(&text).unwrap();
        assert_eq!(q.notes.len(), 3);
        for (x, y) in a.iter().zip(q.notes.anchors()) {
            assert_eq!(x.note, y.note);
            assert!((x.cents - y.cents).abs() <= 0.005 && (x.level_db - y.level_db).abs() <= 0.005, "{x:?} {y:?}");
            for (u, v) in [
                (x.t60, y.t60),
                (x.damping, y.damping),
                (x.inharmonicity, y.inharmonicity),
                (x.hardness, y.hardness),
                (x.damper, y.damper),
                (x.aftersound, y.aftersound),
            ] {
                assert!((u - v).abs() <= 0.0005, "{x:?} {y:?}");
            }
            assert!((x.strike - y.strike).abs() <= 0.0005, "{x:?} {y:?}");
            assert!((x.prompt_db_per_s - y.prompt_db_per_s).abs() <= 0.005, "{x:?} {y:?}");
            assert!((x.after_level_db - y.after_level_db).abs() <= 0.005, "{x:?} {y:?}");
            for (u, v) in [(x.detune, y.detune), (x.decay_spread, y.decay_spread), (x.damper_tail, y.damper_tail)] {
                assert!((u - v).abs() <= 0.0005, "{x:?} {y:?}");
            }
            assert!((x.direct_db - y.direct_db).abs() <= 0.005, "{x:?} {y:?}");
            assert_eq!(y.hammer_mass, 1.0);
        }
        assert_eq!(q.output.output_gain, 0.003141);
        assert_eq!(q.hammer.exponent_bass, 2.45);
        assert_eq!(q.decay.undamped_from_note, 97);
        assert_eq!(comment_lines(&text), comment_lines(PHYSICAL_RON));
        assert_numbers_have_comments(&text);
        assert_eq!(text.lines().filter(|l| l.trim_start().starts_with("(note: ")).count(), 3);
        let again = write_fitted(&text, &q).unwrap();
        assert_eq!(again, text);
    }

    #[test]
    fn unknown_field_is_an_error() {
        let e = set_field(PHYSICAL_RON, "output", "nope", "1.0").unwrap_err();
        assert!(e.contains("output") && e.contains("nope"), "{e}");
        let e = set_field(PHYSICAL_RON, "nosection", "x", "1.0").unwrap_err();
        assert!(e.contains("nosection"), "{e}");
    }

    #[test]
    fn fitted_fields_read_and_write() {
        let mut p = ModalProfile::default();
        for &(s, f) in FITTED_FIELDS {
            let v = field_value(&p, s, f).unwrap();
            assert!(set_value(&mut p, s, f, v * 0.5), "{s}.{f}");
            assert!((field_value(&p, s, f).unwrap() - v * 0.5).abs() < 1e-6, "{s}.{f}");
        }
        assert_eq!(field_value(&p, "output", "nope"), None);
        assert!(!set_value(&mut p, "output", "nope", 1.0));
    }

    #[test]
    fn unfitted_resets_fitted_fields() {
        let mut p = ModalProfile::default();
        p.output.output_gain = 0.01;
        p.eq.peak1_db = -3.0;
        p.decay.undamped_from_note = 97;
        p.resonance.strength = 0.5;
        p.notes = NoteTable::from_anchors(&[NoteAnchor { cents: 2.0, ..NoteAnchor::neutral(60) }]).unwrap();
        assert_eq!(unfitted(&p), ModalProfile::default());
        p.strings.tension_n *= 1.5;
        let u = unfitted(&p);
        assert_ne!(u, ModalProfile::default());
        assert_eq!(u.strings.tension_n, p.strings.tension_n);
    }
}
