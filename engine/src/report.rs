//! Render report: compares two analyses, writes the metrics JSON by hand and the short console summary.

use crate::metrics::{Analysis, SegmentMetrics, VelocityCurve, OCTAVE_CENTERS_HZ};

#[derive(Debug, Clone, PartialEq)]
pub struct SegmentDiff {
    pub index: usize,
    pub peak_db: f64,
    pub rms_db: f64,
    pub rms_db_rel: f64,
    pub t60_s: Option<f64>,
    pub centroid_hz: Option<f64>,
    pub partials_db: Option<[Option<f64>; 8]>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct MeanAbs {
    pub peak_db: Option<f64>,
    pub rms_db: Option<f64>,
    pub rms_db_rel: Option<f64>,
    pub t60_s: Option<f64>,
    pub centroid_hz: Option<f64>,
    pub partials_db: Option<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct WholeDiff {
    pub peak_db: f64,
    pub rms_db: f64,
    pub max_rms_400ms_db: f64,
    pub centroid_hz: Option<f64>,
    pub octave_bands_db: [Option<f64>; 10],
}

#[derive(Debug, Clone, PartialEq)]
pub struct Comparison {
    pub segments_compared: usize,
    pub rms_offset_db: Option<f64>,
    pub mean_abs: MeanAbs,
    pub whole: WholeDiff,
    pub segments: Vec<SegmentDiff>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ReferenceComparison {
    pub wav: String,
    pub sample_rate: u32,
    pub offset_ms: f64,
    pub comparison: Comparison,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RenderInfo {
    pub piece: String,
    pub input: String,
    pub sample_rate: u32,
    pub wav: String,
    pub json: String,
    pub midi: Option<String>,
    pub profile_name: String,
    pub profile_path: Option<String>,
    pub profile_ron: Option<String>,
}

fn mean(vals: impl Iterator<Item = f64>) -> Option<f64> {
    let (sum, n) = vals.fold((0.0, 0usize), |(s, n), v| (s + v, n + 1));
    if n == 0 {
        None
    } else {
        Some(sum / n as f64)
    }
}

fn diff(a: Option<f64>, b: Option<f64>) -> Option<f64> {
    a.zip(b).map(|(x, y)| x - y)
}

pub fn compare(current: &Analysis, other: &Analysis) -> Comparison {
    let pairs: Vec<(&SegmentMetrics, &SegmentMetrics)> = current
        .segments
        .iter()
        .zip(other.segments.iter())
        .filter(|(a, b)| a.notes == b.notes && a.velocity == b.velocity)
        .collect();
    let changes: Vec<f64> = pairs.iter().map(|(a, b)| a.rms_db - b.rms_db).collect();
    let rms_offset_db = mean(changes.iter().copied());
    let offset = rms_offset_db.unwrap_or(0.0);
    let segments: Vec<SegmentDiff> = pairs
        .iter()
        .zip(changes.iter())
        .map(|(&(a, b), &rms)| SegmentDiff {
            index: a.index,
            peak_db: a.peak_db - b.peak_db,
            rms_db: rms,
            rms_db_rel: rms - offset,
            t60_s: diff(a.t60_s, b.t60_s),
            centroid_hz: diff(a.centroid_hz, b.centroid_hz),
            partials_db: match (a.partials_db, b.partials_db) {
                (Some(x), Some(y)) => Some(std::array::from_fn(|i| diff(x[i], y[i]))),
                _ => None,
            },
        })
        .collect();
    let mean_abs = MeanAbs {
        peak_db: mean(segments.iter().map(|s| s.peak_db.abs())),
        rms_db: mean(segments.iter().map(|s| s.rms_db.abs())),
        rms_db_rel: mean(segments.iter().map(|s| s.rms_db_rel.abs())),
        t60_s: mean(segments.iter().filter_map(|s| s.t60_s).map(f64::abs)),
        centroid_hz: mean(segments.iter().filter_map(|s| s.centroid_hz).map(f64::abs)),
        partials_db: mean(
            segments
                .iter()
                .filter_map(|s| s.partials_db)
                .flat_map(|p| p[1..].to_vec())
                .flatten()
                .map(f64::abs),
        ),
    };
    let (w, o) = (&current.whole, &other.whole);
    let whole = WholeDiff {
        peak_db: w.peak_db - o.peak_db,
        rms_db: w.rms_db - o.rms_db,
        max_rms_400ms_db: w.max_rms_400ms_db - o.max_rms_400ms_db,
        centroid_hz: diff(w.centroid_hz, o.centroid_hz),
        octave_bands_db: std::array::from_fn(|i| diff(w.octave_bands_db[i], o.octave_bands_db[i])),
    };
    Comparison {
        segments_compared: segments.len(),
        rms_offset_db,
        mean_abs,
        whole,
        segments,
    }
}

pub fn fmt_num(x: f64, decimals: usize) -> String {
    if !x.is_finite() {
        return "null".to_string();
    }
    let s = format!("{:.*}", decimals, x);
    if s.starts_with('-') && s.parse::<f64>().is_ok_and(|v| v == 0.0) {
        s[1..].to_string()
    } else {
        s
    }
}

pub fn fmt_opt(x: Option<f64>, decimals: usize) -> String {
    x.map_or("null".to_string(), |v| fmt_num(v, decimals))
}

pub fn json_string(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u00{:02x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn kv(key: &str, value: String) -> String {
    format!("{}:{}", json_string(key), value)
}

fn obj(members: Vec<String>) -> String {
    format!("{{{}}}", members.join(","))
}

fn arr(items: Vec<String>) -> String {
    format!("[{}]", items.join(","))
}

fn multi_arr(items: Vec<String>) -> String {
    if items.is_empty() {
        "[]".to_string()
    } else {
        format!("[\n{}\n]", items.join(",\n"))
    }
}

fn num_arr(vals: &[Option<f64>], decimals: usize) -> String {
    arr(vals.iter().map(|&v| fmt_opt(v, decimals)).collect())
}

fn partials_json(p: Option<[Option<f64>; 8]>) -> String {
    p.map_or("null".to_string(), |p| num_arr(&p, 2))
}

fn json_opt(s: Option<&str>) -> String {
    s.map_or("null".to_string(), json_string)
}

fn segment_json(s: &SegmentMetrics) -> String {
    obj(vec![
        kv("index", s.index.to_string()),
        kv("section", json_string(&s.section)),
        kv("onset_s", fmt_num(s.onset_s, 3)),
        kv("notes", arr(s.notes.iter().map(|n| n.to_string()).collect())),
        kv("velocity", s.velocity.to_string()),
        kv("peak_db", fmt_num(s.peak_db, 2)),
        kv("rms_db", fmt_num(s.rms_db, 2)),
        kv("attack_ms", fmt_opt(s.attack_ms, 1)),
        kv("decay_db_per_s", fmt_opt(s.decay_db_per_s, 3)),
        kv("t60_s", fmt_opt(s.t60_s, 3)),
        kv("release_ms", fmt_opt(s.release_ms, 1)),
        kv("centroid_hz", fmt_opt(s.centroid_hz, 1)),
        kv("brightness", fmt_opt(s.brightness, 3)),
        kv("partials_db", partials_json(s.partials_db)),
    ])
}

fn curve_json(c: &VelocityCurve) -> String {
    let points = arr(c
        .points
        .iter()
        .map(|p| {
            obj(vec![
                kv("velocity", p.velocity.to_string()),
                kv("peak_db", fmt_num(p.peak_db, 2)),
                kv("rms_db", fmt_num(p.rms_db, 2)),
                kv("centroid_hz", fmt_opt(p.centroid_hz, 1)),
            ])
        })
        .collect());
    obj(vec![
        kv("note", c.note.to_string()),
        kv("dynamic_range_db", fmt_num(c.dynamic_range_db, 2)),
        kv("points", points),
    ])
}

fn segment_diff_json(s: &SegmentDiff) -> String {
    obj(vec![
        kv("index", s.index.to_string()),
        kv("peak_db", fmt_num(s.peak_db, 2)),
        kv("rms_db", fmt_num(s.rms_db, 2)),
        kv("rms_db_rel", fmt_num(s.rms_db_rel, 2)),
        kv("t60_s", fmt_opt(s.t60_s, 3)),
        kv("centroid_hz", fmt_opt(s.centroid_hz, 1)),
        kv("partials_db", partials_json(s.partials_db)),
    ])
}

fn comparison_json(c: &Comparison) -> String {
    let m = &c.mean_abs;
    let w = &c.whole;
    obj(vec![
        kv("segments_compared", c.segments_compared.to_string()),
        kv("rms_offset_db", fmt_opt(c.rms_offset_db, 2)),
        kv(
            "mean_abs",
            obj(vec![
                kv("peak_db", fmt_opt(m.peak_db, 2)),
                kv("rms_db", fmt_opt(m.rms_db, 2)),
                kv("rms_db_rel", fmt_opt(m.rms_db_rel, 2)),
                kv("t60_s", fmt_opt(m.t60_s, 3)),
                kv("centroid_hz", fmt_opt(m.centroid_hz, 1)),
                kv("partials_db", fmt_opt(m.partials_db, 2)),
            ]),
        ),
        kv(
            "whole",
            obj(vec![
                kv("peak_db", fmt_num(w.peak_db, 2)),
                kv("rms_db", fmt_num(w.rms_db, 2)),
                kv("max_rms_400ms_db", fmt_num(w.max_rms_400ms_db, 2)),
                kv("centroid_hz", fmt_opt(w.centroid_hz, 1)),
                kv("octave_bands_db", num_arr(&w.octave_bands_db, 2)),
            ]),
        ),
        kv(
            "segments",
            multi_arr(c.segments.iter().map(segment_diff_json).collect()),
        ),
    ])
}

fn reference_json(r: &ReferenceComparison) -> String {
    obj(vec![
        kv("wav", json_string(&r.wav)),
        kv("sample_rate", r.sample_rate.to_string()),
        kv("offset_ms", fmt_num(r.offset_ms, 1)),
        kv("comparison", comparison_json(&r.comparison)),
    ])
}

pub fn to_json(
    info: &RenderInfo,
    a: &Analysis,
    vs_previous: Option<&Comparison>,
    vs_reference: Option<&ReferenceComparison>,
) -> String {
    let w = &a.whole;
    let members = vec![
        kv("version", "1".to_string()),
        kv("piece", json_string(&info.piece)),
        kv("input", json_string(&info.input)),
        kv("sample_rate", info.sample_rate.to_string()),
        kv("wav", json_string(&info.wav)),
        kv("json", json_string(&info.json)),
        kv("midi", json_opt(info.midi.as_deref())),
        kv(
            "profile",
            obj(vec![
                kv("name", json_string(&info.profile_name)),
                kv("path", json_opt(info.profile_path.as_deref())),
                kv("ron", json_opt(info.profile_ron.as_deref())),
            ]),
        ),
        kv(
            "whole",
            obj(vec![
                kv("duration_s", fmt_num(w.duration_s, 3)),
                kv("peak_db", fmt_num(w.peak_db, 2)),
                kv("rms_db", fmt_num(w.rms_db, 2)),
                kv("max_rms_400ms_db", fmt_num(w.max_rms_400ms_db, 2)),
                kv("clipped_samples", w.clipped_samples.to_string()),
                kv("centroid_hz", fmt_opt(w.centroid_hz, 1)),
                kv(
                    "octave_bands_hz",
                    arr(OCTAVE_CENTERS_HZ.iter().map(|&c| fmt_num(c, 1)).collect()),
                ),
                kv("octave_bands_db", num_arr(&w.octave_bands_db, 2)),
            ]),
        ),
        kv(
            "segments",
            multi_arr(a.segments.iter().map(segment_json).collect()),
        ),
        kv(
            "velocity_curves",
            multi_arr(a.velocity_curves.iter().map(curve_json).collect()),
        ),
        kv(
            "vs_previous",
            vs_previous.map_or("null".to_string(), comparison_json),
        ),
        kv(
            "vs_reference",
            vs_reference.map_or("null".to_string(), reference_json),
        ),
    ];
    format!("{{\n{}\n}}\n", members.join(",\n"))
}

fn dash(x: Option<f64>, decimals: usize) -> String {
    x.map_or("-".to_string(), |v| fmt_num(v, decimals))
}

fn dash_signed(x: Option<f64>, decimals: usize) -> String {
    x.map_or("-".to_string(), |v| signed(v, decimals))
}

fn signed(v: f64, decimals: usize) -> String {
    let s = fmt_num(v, decimals);
    if s.starts_with('-') || s == "null" {
        s
    } else {
        format!("+{s}")
    }
}

pub fn summary(
    info: &RenderInfo,
    a: &Analysis,
    vs_previous: Option<&Comparison>,
    vs_reference: Option<&ReferenceComparison>,
) -> String {
    let w = &a.whole;
    let mut lines = vec![
        format!(
            "Render: {} with profile {} -> {} ({} s, {} Hz)",
            info.piece, info.profile_name, info.wav, fmt_num(w.duration_s, 1), info.sample_rate
        ),
        format!(
            "Whole: peak {} dB, RMS {} dB, loudest 400 ms {} dB, clipped samples {}, centroid {} Hz",
            fmt_num(w.peak_db, 1),
            fmt_num(w.rms_db, 1),
            fmt_num(w.max_rms_400ms_db, 1),
            w.clipped_samples,
            dash(w.centroid_hz, 0)
        ),
    ];

    if a.velocity_curves.is_empty() {
        lines.push("Velocity: no velocity ladder".to_string());
    } else {
        let parts: Vec<String> = a
            .velocity_curves
            .iter()
            .map(|c| format!("note {} range {} dB", c.note, fmt_num(c.dynamic_range_db, 2)))
            .collect();
        lines.push(format!("Velocity: {}", parts.join(", ")));
    }

    let single: Vec<&SegmentMetrics> = a.segments.iter().filter(|s| s.notes.len() == 1).collect();
    let keys: Vec<&SegmentMetrics> = single.iter().copied().filter(|s| s.section == "keys").collect();
    let pick = if keys.is_empty() { single } else { keys };
    if pick.is_empty() {
        lines.push("Decay T60: -".to_string());
    } else {
        let parts: Vec<String> = pick
            .iter()
            .take(12)
            .map(|s| match s.t60_s {
                Some(t) => format!("n{} {} s", s.notes[0], fmt_num(t, 1)),
                None => format!("n{} -", s.notes[0]),
            })
            .collect();
        lines.push(format!("Decay T60: {}", parts.join(", ")));
    }

    match vs_previous {
        None => lines.push("vs previous: none (first render)".to_string()),
        Some(c) => {
            let m = &c.mean_abs;
            lines.push(format!(
                "vs previous: {} segments, mean |change| RMS {} dB, T60 {} s, centroid {} Hz, partials {} dB",
                c.segments_compared,
                dash(m.rms_db, 2),
                dash(m.t60_s, 2),
                dash(m.centroid_hz, 1),
                dash(m.partials_db, 2)
            ));
            if c.segments.iter().any(|s| s.rms_db.abs() >= 0.01) {
                let mut top: Vec<&SegmentDiff> = c.segments.iter().collect();
                top.sort_by(|x, y| {
                    y.rms_db
                        .abs()
                        .total_cmp(&x.rms_db.abs())
                        .then(x.index.cmp(&y.index))
                });
                let label = |idx: usize| -> String {
                    a.segments
                        .iter()
                        .find(|m| m.index == idx)
                        .map_or(String::new(), |m| {
                            let notes: Vec<String> = m.notes.iter().map(|n| format!("n{n}")).collect();
                            format!("{} v{}", notes.join("+"), m.velocity)
                        })
                };
                let parts: Vec<String> = top
                    .iter()
                    .take(3)
                    .map(|s| format!("#{} {} {} dB", s.index, label(s.index), signed(s.rms_db, 2)))
                    .collect();
                lines.push(format!("  largest RMS changes: {}", parts.join(", ")));
            }
        }
    }

    if let Some(r) = vs_reference {
        let m = &r.comparison.mean_abs;
        lines.push(format!(
            "vs reference: {} ({} Hz), offset {} ms, level {} dB, mean |change| RMS shape {} dB, T60 {} s, centroid {} Hz, partials {} dB",
            r.wav,
            r.sample_rate,
            fmt_num(r.offset_ms, 1),
            dash_signed(r.comparison.rms_offset_db, 1),
            dash(m.rms_db_rel, 2),
            dash(m.t60_s, 2),
            dash(m.centroid_hz, 1),
            dash(m.partials_db, 2)
        ));
    }

    lines.push(format!("JSON: {}", info.json));
    let mut out = lines.join("\n");
    out.push('\n');
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Profile;
    use crate::metrics::{analyze, segments_from_events};
    use crate::midi::MidiEvent;
    use crate::render::render_with_profile;

    fn sample_analysis(profile: &Profile) -> Analysis {
        let events = vec![
            (0, MidiEvent::NoteOn { note: 60, velocity: 64 }),
            (300_000, MidiEvent::NoteOff { note: 60 }),
            (400_000, MidiEvent::NoteOn { note: 60, velocity: 100 }),
            (700_000, MidiEvent::NoteOff { note: 60 }),
        ];
        let samples = render_with_profile(profile, &events);
        let total_s = samples.len() as f64 / 48000.0;
        let segs = segments_from_events(&events, &[], total_s);
        analyze(&samples, 48000, &segs, 0.0)
    }

    fn quiet_profile() -> Profile {
        Profile::default()
    }

    fn loud_profile() -> Profile {
        let mut p = Profile::default();
        p.loudness.voice_gain = 0.6;
        p
    }

    fn render_info(wav: &str) -> RenderInfo {
        RenderInfo {
            piece: "test".to_string(),
            input: "built-in test set".to_string(),
            sample_rate: 48000,
            wav: wav.to_string(),
            json: r"C:\out\render.json".to_string(),
            midi: None,
            profile_name: "default".to_string(),
            profile_path: None,
            profile_ron: None,
        }
    }

    fn reference(a: &Analysis) -> ReferenceComparison {
        ReferenceComparison {
            wav: "ref.wav".to_string(),
            sample_rate: 44100,
            offset_ms: 12.5,
            comparison: compare(a, a),
        }
    }

    fn is_valid_json(s: &str) -> bool {
        let b = s.as_bytes();
        let mut i = 0;
        if !value(b, &mut i) {
            return false;
        }
        skip_ws(b, &mut i);
        i == b.len()
    }

    fn skip_ws(b: &[u8], i: &mut usize) {
        while *i < b.len() && matches!(b[*i], b' ' | b'\t' | b'\n' | b'\r') {
            *i += 1;
        }
    }

    fn value(b: &[u8], i: &mut usize) -> bool {
        skip_ws(b, i);
        match b.get(*i) {
            Some(b'{') => {
                *i += 1;
                skip_ws(b, i);
                if b.get(*i) == Some(&b'}') {
                    *i += 1;
                    return true;
                }
                loop {
                    skip_ws(b, i);
                    if !string(b, i) {
                        return false;
                    }
                    skip_ws(b, i);
                    if b.get(*i) != Some(&b':') {
                        return false;
                    }
                    *i += 1;
                    if !value(b, i) {
                        return false;
                    }
                    skip_ws(b, i);
                    match b.get(*i) {
                        Some(b',') => *i += 1,
                        Some(b'}') => {
                            *i += 1;
                            return true;
                        }
                        _ => return false,
                    }
                }
            }
            Some(b'[') => {
                *i += 1;
                skip_ws(b, i);
                if b.get(*i) == Some(&b']') {
                    *i += 1;
                    return true;
                }
                loop {
                    if !value(b, i) {
                        return false;
                    }
                    skip_ws(b, i);
                    match b.get(*i) {
                        Some(b',') => *i += 1,
                        Some(b']') => {
                            *i += 1;
                            return true;
                        }
                        _ => return false,
                    }
                }
            }
            Some(b'"') => string(b, i),
            Some(b't') => literal(b, i, b"true"),
            Some(b'f') => literal(b, i, b"false"),
            Some(b'n') => literal(b, i, b"null"),
            Some(b'-' | b'0'..=b'9') => number(b, i),
            _ => false,
        }
    }

    fn literal(b: &[u8], i: &mut usize, lit: &[u8]) -> bool {
        if b[*i..].starts_with(lit) {
            *i += lit.len();
            true
        } else {
            false
        }
    }

    fn string(b: &[u8], i: &mut usize) -> bool {
        if b.get(*i) != Some(&b'"') {
            return false;
        }
        *i += 1;
        loop {
            match b.get(*i) {
                None => return false,
                Some(b'"') => {
                    *i += 1;
                    return true;
                }
                Some(b'\\') => match b.get(*i + 1) {
                    Some(b'u') => {
                        if b.len() < *i + 6 || !b[*i + 2..*i + 6].iter().all(|c| c.is_ascii_hexdigit()) {
                            return false;
                        }
                        *i += 6;
                    }
                    Some(b'"' | b'\\' | b'/' | b'b' | b'f' | b'n' | b'r' | b't') => *i += 2,
                    _ => return false,
                },
                Some(&c) if c < 0x20 => return false,
                Some(_) => *i += 1,
            }
        }
    }

    fn digits(b: &[u8], i: &mut usize) -> bool {
        let start = *i;
        while *i < b.len() && b[*i].is_ascii_digit() {
            *i += 1;
        }
        *i > start
    }

    fn number(b: &[u8], i: &mut usize) -> bool {
        if b.get(*i) == Some(&b'-') {
            *i += 1;
        }
        if !digits(b, i) {
            return false;
        }
        if b.get(*i) == Some(&b'.') {
            *i += 1;
            if !digits(b, i) {
                return false;
            }
        }
        if matches!(b.get(*i), Some(b'e' | b'E')) {
            *i += 1;
            if matches!(b.get(*i), Some(b'+' | b'-')) {
                *i += 1;
            }
            if !digits(b, i) {
                return false;
            }
        }
        true
    }

    #[test]
    fn compare_same_is_zero() {
        let a = sample_analysis(&quiet_profile());
        let c = compare(&a, &a);
        assert_eq!(c.segments_compared, 2);
        assert_eq!(c.rms_offset_db, Some(0.0));
        assert_eq!(c.mean_abs.peak_db, Some(0.0));
        assert_eq!(c.mean_abs.rms_db, Some(0.0));
        assert_eq!(c.mean_abs.rms_db_rel, Some(0.0));
        assert_eq!(c.mean_abs.t60_s, Some(0.0));
        assert_eq!(c.mean_abs.centroid_hz, Some(0.0));
    }

    #[test]
    fn comparison_of_double_gain_is_6_db() {
        let a = sample_analysis(&quiet_profile());
        let b = sample_analysis(&loud_profile());
        let c = compare(&b, &a);
        for s in &c.segments {
            assert!((s.rms_db - 6.02).abs() <= 0.1);
            assert!(s.rms_db_rel.abs() <= 0.05);
        }
        assert!((c.rms_offset_db.unwrap() - 6.02).abs() <= 0.1);
    }

    #[test]
    fn json_is_valid() {
        let a = sample_analysis(&quiet_profile());
        let b = sample_analysis(&loud_profile());
        let prev = compare(&b, &a);
        let reference = reference(&a);
        let info = render_info(r"C:\r\x.wav");
        let json = to_json(&info, &a, Some(&prev), Some(&reference));
        assert!(is_valid_json(&json));
        assert!(json.contains(r#""wav":"C:\\r\\x.wav""#));
        assert!(json.contains(r#""section":"file""#));
        assert!(json.contains(r#""vs_previous":{"#));
    }

    #[test]
    fn json_none_is_null() {
        let a = sample_analysis(&quiet_profile());
        let json = to_json(&render_info(r"C:\r\x.wav"), &a, None, None);
        assert!(json.contains("\"vs_previous\":null"));
        assert!(json.contains("\"vs_reference\":null"));
        assert!(is_valid_json(&json));
    }

    #[test]
    fn fmt_num_rules() {
        assert_eq!(fmt_num(-0.0001, 2), "0.00");
        assert_eq!(fmt_num(f64::NAN, 2), "null");
        assert_eq!(fmt_num(1.23456, 3), "1.235");
    }

    #[test]
    fn negative_zero_never_printed() {
        assert_eq!(fmt_num(-0.04, 1), "0.0");
        assert_eq!(signed(-0.004, 2), "+0.00");
        let mut a = sample_analysis(&quiet_profile());
        a.whole.peak_db = -0.01;
        a.whole.rms_db = -0.04;
        let text = summary(&render_info("x.wav"), &a, None, None);
        assert!(!text.contains("-0.0"), "{text}");
        assert!(text.contains("peak 0.0 dB, RMS 0.0 dB"));
    }

    #[test]
    fn summary_lines() {
        let a = sample_analysis(&quiet_profile());
        let info = render_info(r"C:\r\x.wav");

        let plain = summary(&info, &a, None, None);
        assert!(plain.contains("vs previous: none (first render)"));
        assert!(!plain.contains("vs reference"));
        assert!(plain.ends_with(format!("JSON: {}\n", info.json).as_str()));

        let b = sample_analysis(&loud_profile());
        let prev = compare(&b, &a);
        assert!(summary(&info, &b, Some(&prev), None).contains("largest RMS changes: #"));

        let with_ref = summary(&info, &a, None, Some(&reference(&a)));
        assert!(with_ref.contains("vs reference: "));
        assert!(with_ref.contains("offset "));
    }
}
