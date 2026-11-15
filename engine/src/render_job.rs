//! --render: renders the test piece or a MIDI file offline, keeps the previous render, compares, and writes WAV + JSON.

use crate::config::SoundProfile;
use crate::metrics::{analyze, first_onset_s, segments_from_events, Analysis};
use crate::midi::MidiEvent;
use crate::playback::{latest_recording, parse_smf};
use crate::record::encode_smf;
use crate::render::{read_wav_mono, render_sound_profile, test_piece, write_wav_stereo, SAMPLE_RATE};
use crate::report::{compare, summary, to_json, Comparison, ReferenceComparison, RenderInfo};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq)]
pub enum RenderInput {
    TestSet,
    Midi(PathBuf),
}

#[derive(Debug, Clone)]
pub struct RenderOptions {
    pub input: RenderInput,
    pub out_dir: PathBuf,
    pub reference: Option<PathBuf>,
    pub profile: SoundProfile,
    pub profile_name: String,
    pub profile_path: Option<PathBuf>,
}

#[derive(Debug, Clone)]
pub struct RenderOutcome {
    pub dir: PathBuf,
    pub wav: PathBuf,
    pub json: PathBuf,
    pub midi: Option<PathBuf>,
    pub had_previous: bool,
    pub analysis: Analysis,
    pub vs_previous: Option<Comparison>,
    pub vs_reference: Option<ReferenceComparison>,
    pub summary: String,
}

/// Longest input --render accepts (the WAV is held in memory: 30 min is about 350 MB of f32).
pub const MAX_RENDER_S: f64 = 1800.0;

pub fn check_length(events: &[(u64, MidiEvent)]) -> Result<(), String> {
    let last = events.last().map_or(0, |&(t, _)| t);
    if last as f64 / 1e6 > MAX_RENDER_S {
        return Err(format!(
            "too long to render: {:.1} min (limit {:.0} min)",
            last as f64 / 60e6,
            MAX_RENDER_S / 60.0
        ));
    }
    Ok(())
}

pub fn default_dir(engine_dir: &Path) -> PathBuf {
    engine_dir.join("renders")
}

pub fn resolve_input(value: &str, record_dir: &Path) -> Result<RenderInput, String> {
    if value.trim().is_empty() {
        return Err("--render needs a value: `test`, a .mid file path or `latest`".to_string());
    }
    if value.eq_ignore_ascii_case("test") {
        Ok(RenderInput::TestSet)
    } else if value.eq_ignore_ascii_case("latest") {
        Ok(RenderInput::Midi(latest_recording(record_dir)?))
    } else {
        Ok(RenderInput::Midi(PathBuf::from(value)))
    }
}

pub fn piece_name(input: &RenderInput) -> String {
    match input {
        RenderInput::TestSet => "test".to_string(),
        RenderInput::Midi(p) => {
            let stem = p
                .file_stem()
                .and_then(|s| s.to_str())
                .filter(|s| !s.is_empty())
                .unwrap_or("midi");
            let clean: String = stem
                .chars()
                .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
                .collect();
            format!("mid-{clean}")
        }
    }
}

fn norm_text(p: &Path) -> String {
    let s = p.display().to_string();
    if std::path::MAIN_SEPARATOR == '\\' {
        s.replace('/', "\\")
    } else {
        s
    }
}

fn norm_path(p: &Path) -> PathBuf {
    PathBuf::from(norm_text(p))
}

/// Sections of the built-in test piece when `events` is the same piece (same notes, velocities and order,
/// onsets within 5 ms, constant time offset allowed), else none.
fn test_piece_sections(events: &[(u64, MidiEvent)]) -> Vec<(&'static str, u64)> {
    let piece = test_piece();
    if events.len() != piece.events.len() || events.is_empty() {
        return Vec::new();
    }
    let offset = events[0].0 as i64 - piece.events[0].0 as i64;
    let same = events.iter().zip(piece.events.iter()).all(|(a, b)| {
        a.1.canonical() == b.1.canonical() && ((a.0 as i64 - b.0 as i64) - offset).abs() <= 5_000
    });
    if !same {
        return Vec::new();
    }
    piece
        .sections
        .iter()
        .map(|&(name, t)| (name, (t as i64 + offset).max(0) as u64))
        .collect()
}

fn rename(from: &Path, to: &Path) -> Result<(), String> {
    std::fs::rename(from, to).map_err(|e| {
        format!(
            "cannot rename {} to {}: {e} (close the WAV in other programs and try again)",
            from.display(),
            to.display()
        )
    })
}

pub fn run(opts: &RenderOptions) -> Result<RenderOutcome, String> {
    let (events, sections, input_text) = match &opts.input {
        RenderInput::TestSet => {
            let p = test_piece();
            (p.events, p.sections, "built-in test set".to_string())
        }
        RenderInput::Midi(path) => {
            let bytes = std::fs::read(path).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
            let events = parse_smf(&bytes).map_err(|e| format!("cannot parse {}: {e}", path.display()))?;
            let sections = test_piece_sections(&events);
            (events, sections, norm_text(path))
        }
    };
    if !events.iter().any(|&(_, ev)| matches!(ev, MidiEvent::NoteOn { velocity, .. } if velocity > 0)) {
        return Err(format!("no notes in {input_text}"));
    }
    check_length(&events).map_err(|e| format!("{input_text}: {e}"))?;

    let reference = match &opts.reference {
        Some(path) => Some(read_wav_mono(path).map_err(|e| format!("reference WAV: {e}"))?),
        None => None,
    };

    let piece = piece_name(&opts.input);
    let dir = norm_path(&opts.out_dir).join(&piece);
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;

    let stereo = render_sound_profile(&opts.profile, &events);
    let samples = stereo.mono();

    let wav = dir.join("render.wav");
    let json = dir.join("render.json");
    let previous_wav = dir.join("previous.wav");
    let previous_json = dir.join("previous.json");
    let had_previous = wav.exists();
    if had_previous {
        rename(&wav, &previous_wav)?;
    }
    if json.exists() {
        if let Err(e) = rename(&json, &previous_json) {
            if had_previous {
                let _ = std::fs::rename(&previous_wav, &wav);
            }
            return Err(e);
        }
    }

    write_wav_stereo(&wav, &stereo, SAMPLE_RATE)?;
    let midi = match &opts.input {
        RenderInput::TestSet => {
            let path = dir.join("test.mid");
            std::fs::write(&path, encode_smf(&events)).map_err(|e| format!("cannot write {}: {e}", path.display()))?;
            Some(path)
        }
        RenderInput::Midi(_) => None,
    };

    let total_s = samples.len() as f64 / SAMPLE_RATE as f64;
    let segs = segments_from_events(&events, &sections, total_s);
    let analysis = analyze(&samples, SAMPLE_RATE, &segs, 0.0);

    let mut warning = None;
    let vs_previous = if had_previous {
        match read_wav_mono(&previous_wav) {
            Ok((prev, prev_sr)) => Some(compare(&analysis, &analyze(&prev, prev_sr, &segs, 0.0))),
            Err(e) => {
                warning = Some(format!("warning: cannot read previous render: {e}"));
                None
            }
        }
    } else {
        None
    };

    let vs_reference = match (&opts.reference, &reference) {
        (Some(path), Some((ref_samples, ref_sr))) => {
            let offset_s = match (first_onset_s(ref_samples, *ref_sr), first_onset_s(&samples, SAMPLE_RATE)) {
                (Some(r), Some(s)) => r - s,
                _ => 0.0,
            };
            let ref_analysis = analyze(ref_samples, *ref_sr, &segs, offset_s);
            Some(ReferenceComparison {
                wav: norm_text(path),
                sample_rate: *ref_sr,
                offset_ms: offset_s * 1000.0,
                comparison: compare(&analysis, &ref_analysis),
            })
        }
        _ => None,
    };

    let info = RenderInfo {
        piece,
        input: input_text,
        sample_rate: SAMPLE_RATE,
        wav: norm_text(&wav),
        json: norm_text(&json),
        midi: midi.as_ref().map(|p| norm_text(p)),
        profile_name: opts.profile_name.clone(),
        profile_path: opts.profile_path.as_ref().map(|p| norm_text(p)),
        profile_ron: opts.profile_path.as_ref().and_then(|p| std::fs::read_to_string(p).ok()),
    };
    let json_text = to_json(&info, &analysis, vs_previous.as_ref(), vs_reference.as_ref());
    std::fs::write(&json, json_text).map_err(|e| format!("cannot write {}: {e}", json.display()))?;

    let mut summary_text = summary(&info, &analysis, vs_previous.as_ref(), vs_reference.as_ref());
    if let Some(w) = warning {
        summary_text.push_str(&format!("{w}\n"));
    }

    Ok(RenderOutcome {
        dir,
        wav,
        json,
        midi,
        had_previous,
        analysis,
        vs_previous,
        vs_reference,
        summary: summary_text,
    })
}
