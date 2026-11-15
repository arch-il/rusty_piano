//! Writes engine/setup.ron in the commented layout of setup.example.ron (used by the setup window).
use crate::setup::Setup;
use std::path::{Path, PathBuf};

pub const TEMPLATE: &str = include_str!("../setup.example.ron");

pub fn ron_string(v: &str) -> String {
    let mut out = String::from("\"");
    for c in v.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            _ => out.push(c),
        }
    }
    out.push('"');
    out
}

fn opt_str(v: &Option<String>) -> String {
    match v {
        None => "None".to_string(),
        Some(s) => format!("Some({})", ron_string(s)),
    }
}

fn opt_num<T: std::fmt::Display>(v: &Option<T>) -> String {
    match v {
        None => "None".to_string(),
        Some(n) => format!("Some({n})"),
    }
}

/// (field name, RON value) for every Setup field, in template order.
pub fn field_values(s: &Setup) -> Vec<(&'static str, String)> {
    vec![
        ("midi_port", opt_str(&s.midi_port)),
        ("audio_device", opt_str(&s.audio_device)),
        ("buffer_frames", opt_num(&s.buffer_frames)),
        ("backend", opt_str(&s.backend)),
        ("profile", opt_str(&s.profile)),
        ("transpose", opt_num(&s.transpose)),
        ("octave", opt_num(&s.octave)),
        ("metronome", opt_num(&s.metronome)),
        ("metronome_bpm", opt_num(&s.metronome_bpm)),
        ("metronome_beats_per_bar", opt_num(&s.metronome_beats_per_bar)),
        ("metronome_volume", opt_num(&s.metronome_volume)),
        ("ws_port", opt_num(&s.ws_port)),
        ("record", opt_num(&s.record)),
        ("record_wav", opt_num(&s.record_wav)),
        ("record_dir", opt_str(&s.record_dir)),
    ]
}

/// The template text with each '<field>: None,' value line replaced by the value from s. Comments and line endings are kept.
pub fn render_setup(s: &Setup) -> String {
    let values = field_values(s);
    let mut out = String::with_capacity(TEMPLATE.len() + 256);
    for line in TEMPLATE.split_inclusive('\n') {
        let trimmed = line.trim_start();
        let indent = &line[..line.len() - trimmed.len()];
        let ending = if line.ends_with("\r\n") {
            "\r\n"
        } else if line.ends_with('\n') {
            "\n"
        } else {
            ""
        };
        let found = if trimmed.starts_with("//") {
            None
        } else {
            values
                .iter()
                .find(|(key, _)| trimmed.starts_with(&format!("{key}: ")))
        };
        match found {
            Some((key, value)) => {
                out.push_str(indent);
                out.push_str(key);
                out.push_str(": ");
                out.push_str(value);
                out.push(',');
                out.push_str(ending);
            }
            None => out.push_str(line),
        }
    }
    out
}

pub fn backup_path(path: &Path) -> PathBuf {
    let mut p = path.as_os_str().to_owned();
    p.push(".bak");
    PathBuf::from(p)
}

/// Writes s to path in the template layout. An existing file is first copied to <path>.bak. Returns the backup path if one was made.
pub fn write_setup(path: &Path, s: &Setup) -> Result<Option<PathBuf>, String> {
    let backup = if path.exists() {
        let b = backup_path(path);
        std::fs::copy(path, &b)
            .map_err(|e| format!("cannot back up {} to {}: {e}", path.display(), b.display()))?;
        Some(b)
    } else {
        None
    };
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    std::fs::write(&tmp, render_setup(s))
        .and_then(|_| std::fs::rename(&tmp, path))
        .map_err(|e| format!("cannot write {}: {e}", path.display()))?;
    Ok(backup)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::setup::{load_setup, parse_setup};

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "rusty_piano_setup_file_{}_{}",
            std::process::id(),
            name
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn full() -> Setup {
        Setup {
            midi_port: Some("SL990 MIDI".to_string()),
            audio_device: Some("Speakers (Realtek(R) Audio)".to_string()),
            buffer_frames: Some(128),
            profile: Some("sl990".to_string()),
            transpose: Some(-3),
            octave: Some(1),
            metronome: Some(true),
            metronome_bpm: Some(72),
            metronome_beats_per_bar: Some(3),
            metronome_volume: Some(40),
            backend: Some("wasapi-exclusive".to_string()),
            ws_port: Some(8790),
            record: Some(false),
            record_wav: Some(true),
            record_dir: Some(r#"C:\piano\takes "one""#.to_string()),
        }
    }

    #[test]
    fn default_render_is_the_template() {
        assert_eq!(render_setup(&Setup::default()), TEMPLATE);
    }

    #[test]
    fn every_field_has_one_line() {
        for (key, _) in field_values(&Setup::default()) {
            let n = TEMPLATE
                .lines()
                .filter(|l| l.trim_start().starts_with(&format!("{key}: ")))
                .count();
            assert_eq!(n, 1, "{key}");
        }
    }

    #[test]
    fn round_trips_all_fields() {
        let s = full();
        assert_eq!(parse_setup(&render_setup(&s)), Ok(s.clone()));
    }

    #[test]
    fn rendered_lines_show_values() {
        let text = render_setup(&full());
        assert!(text.contains("    buffer_frames: Some(128),"), "{text}");
        assert!(text.contains("    record: Some(false),"), "{text}");
        assert!(text.contains("    record_wav: Some(true),"), "{text}");
        assert!(text.contains("    transpose: Some(-3),"), "{text}");
        assert!(text.contains("    octave: Some(1),"), "{text}");
        assert!(text.contains("    metronome_bpm: Some(72),"), "{text}");
        assert!(text.contains("    ws_port: Some(8790),"), "{text}");
        assert!(
            text.contains(r#"    record_dir: Some("C:\\piano\\takes \"one\""),"#),
            "{text}"
        );
        assert!(text.contains("// MIDI input port:"), "{text}");
    }

    #[test]
    fn ron_string_escapes() {
        assert_eq!(ron_string(r#"a"b\c"#), r#""a\"b\\c""#);
        assert_eq!(ron_string("plain"), "\"plain\"");
    }

    #[test]
    fn write_keeps_a_backup() {
        let dir = temp_dir("backup");
        let p = dir.join("setup.ron");
        let a = Setup {
            ws_port: Some(8790),
            ..Setup::default()
        };
        let b = Setup {
            buffer_frames: Some(64),
            ..Setup::default()
        };
        assert_eq!(write_setup(&p, &a), Ok(None));
        assert_eq!(write_setup(&p, &b), Ok(Some(dir.join("setup.ron.bak"))));
        assert_eq!(load_setup(&p), Ok(Some(b)));
        assert_eq!(load_setup(&dir.join("setup.ron.bak")), Ok(Some(a)));
        assert!(!dir.join("setup.ron.tmp").exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
