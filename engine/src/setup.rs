//! engine/setup.ron: MIDI port, audio device, buffer, profile name, transpose/octave shift and WebSocket port, read at startup only. CLI flags override it.

use crate::audio::{self, Backend};
use crate::cli::Args;
use crate::config::{self, SoundProfile};
use crate::record;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Default, PartialEq, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Setup {
    #[serde(default)]
    pub midi_port: Option<String>,
    #[serde(default)]
    pub audio_device: Option<String>,
    #[serde(default)]
    pub buffer_frames: Option<u32>,
    #[serde(default)]
    pub profile: Option<String>,
    #[serde(default)]
    pub transpose: Option<i8>,
    #[serde(default)]
    pub octave: Option<i8>,
    #[serde(default)]
    pub metronome: Option<bool>,
    #[serde(default)]
    pub metronome_bpm: Option<u16>,
    #[serde(default)]
    pub metronome_beats_per_bar: Option<u8>,
    #[serde(default)]
    pub metronome_volume: Option<u8>,
    #[serde(default)]
    pub backend: Option<String>,
    #[serde(default)]
    pub ws_port: Option<u16>,
    #[serde(default)]
    pub record: Option<bool>,
    #[serde(default)]
    pub record_wav: Option<bool>,
    #[serde(default)]
    pub record_dir: Option<String>,
}

pub fn parse_setup(text: &str) -> Result<Setup, String> {
    let s = ron::from_str::<Setup>(text).map_err(|e| e.to_string())?;
    if let Some(n) = s.buffer_frames {
        if !(16..=8192).contains(&n) {
            return Err(format!("buffer_frames must be between 16 and 8192, got {n}"));
        }
    }
    if let Some(n) = s.transpose {
        if !(-12..=12).contains(&n) {
            return Err(format!("transpose must be between -12 and 12, got {n}"));
        }
    }
    if let Some(n) = s.octave {
        if !(-2..=2).contains(&n) {
            return Err(format!("octave must be between -2 and 2, got {n}"));
        }
    }
    if let Some(n) = s.metronome_bpm {
        if !(30..=300).contains(&n) {
            return Err(format!("metronome_bpm must be between 30 and 300, got {n}"));
        }
    }
    if let Some(n) = s.metronome_beats_per_bar {
        if !(1..=12).contains(&n) {
            return Err(format!("metronome_beats_per_bar must be between 1 and 12, got {n}"));
        }
    }
    if let Some(n) = s.metronome_volume {
        if n > 100 {
            return Err(format!("metronome_volume must be between 0 and 100, got {n}"));
        }
    }
    if s.ws_port == Some(0) {
        return Err("ws_port must be between 1 and 65535, got 0".to_string());
    }
    for (field, value) in [
        ("midi_port", &s.midi_port),
        ("audio_device", &s.audio_device),
        ("profile", &s.profile),
        ("backend", &s.backend),
        ("record_dir", &s.record_dir),
    ] {
        if value.as_ref().is_some_and(|v| v.trim().is_empty()) {
            return Err(format!("{field} must not be empty"));
        }
    }
    if let Some(b) = &s.backend {
        Backend::parse(b).map_err(|e| format!("backend: {e}"))?;
    }
    Ok(s)
}

pub fn load_setup(path: &Path) -> Result<Option<Setup>, String> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("cannot read {}: {e}", path.display())),
    };
    parse_setup(&text)
        .map(Some)
        .map_err(|e| format!("{}: {e}", path.display()))
}

#[derive(Debug, Clone, PartialEq)]
pub struct Startup {
    pub port: Option<String>,
    pub audio_device: Option<String>,
    pub buffer: Option<u32>,
    pub profile_name: String,
    pub profile_path: Option<PathBuf>,
    pub profile: SoundProfile,
    pub backend: Backend,
    pub ws_port: Option<u16>,
    pub transpose: crate::transpose::Shift,
    pub metronome: crate::metronome::MetronomeSettings,
    pub record: bool,
    pub record_wav: bool,
    pub record_dir: PathBuf,
    pub notes: Vec<String>,
}

pub fn setup_path(engine_dir: &Path) -> PathBuf {
    engine_dir.join("setup.ron")
}

pub fn resolve_startup(args: &Args, engine_dir: &Path) -> Result<Startup, String> {
    let mut notes = Vec::new();
    let path = setup_path(engine_dir);
    let setup = match load_setup(&path) {
        Ok(Some(s)) => {
            notes.push(format!("Setup: {}", path.display()));
            s
        }
        Ok(None) => {
            notes.push(format!(
                "Setup: none ({} not found), using built-in defaults",
                path.display()
            ));
            Setup::default()
        }
        Err(e) => return Err(format!("setup file {e}")),
    };
    resolve_from(setup, args, engine_dir, notes)
}

/// Startup settings from an already loaded Setup: flags > setup values > built-in defaults. Also used by the setup window.
pub fn resolve_from(setup: Setup, args: &Args, engine_dir: &Path, mut notes: Vec<String>) -> Result<Startup, String> {
    let record = !args.no_record && setup.record.unwrap_or(true);
    let record_wav = record && (args.record_wav || setup.record_wav == Some(true));
    let record_dir = match (&args.record_dir, &setup.record_dir) {
        (Some(d), _) => PathBuf::from(d),
        (None, Some(d)) => {
            let p = PathBuf::from(d);
            if p.is_absolute() { p } else { engine_dir.join(p) }
        }
        (None, None) => record::default_dir(engine_dir),
    };

    let port = args.port.clone().or(setup.midi_port);
    let audio_device = args.audio_device.clone().or(setup.audio_device);
    let buffer = args.buffer.or(setup.buffer_frames);
    let setup_backend = setup
        .backend
        .as_deref()
        .map(Backend::parse)
        .transpose()
        .map_err(|e| format!("setup file {}: backend: {e}", setup_path(engine_dir).display()))?;
    let backend = args.backend.or(setup_backend).unwrap_or_default();
    audio::check_backend_available(backend)?;
    let ws_port = args.ws_port.or(setup.ws_port);
    let transpose = crate::transpose::Shift {
        semitones: args.transpose.or(setup.transpose).unwrap_or(0),
        octaves: args.octave.or(setup.octave).unwrap_or(0),
    };
    let metronome = crate::metronome::MetronomeSettings {
        on: args.metronome.is_some() || setup.metronome == Some(true),
        bpm: args.metronome.or(setup.metronome_bpm).unwrap_or(crate::metronome::DEFAULT_BPM),
        beats_per_bar: setup.metronome_beats_per_bar.unwrap_or(crate::metronome::DEFAULT_BEATS_PER_BAR),
        volume: setup.metronome_volume.unwrap_or(crate::metronome::DEFAULT_VOLUME),
    };
    if !transpose.is_zero() {
        notes.push(format!(
            "Transpose: {} (sound only; recordings and live events keep the keys you pressed)",
            transpose.label()
        ));
    }

    let explicit = args.profile.clone().or(setup.profile);
    let profile_name = explicit.clone().unwrap_or_else(|| "default".to_string());
    let path = config::profile_path(engine_dir, &profile_name);
    let (profile, profile_path) = if path.exists() {
        let profile = config::load_sound_profile(&path)
            .map_err(|e| format!("sound profile {profile_name}: {e}"))?;
        (profile, Some(path))
    } else if explicit.is_some() {
        let list = config::list_profiles(engine_dir);
        let available = if list.is_empty() {
            "(none)".to_string()
        } else {
            list.join(", ")
        };
        return Err(format!(
            "sound profile \"{profile_name}\" not found at {}; available: {available}",
            path.display()
        ));
    } else {
        notes.push(format!(
            "Sound profile file {} not found; using the built-in default sound",
            path.display()
        ));
        (SoundProfile::default(), None)
    };

    Ok(Startup {
        port,
        audio_device,
        buffer,
        profile_name,
        profile_path,
        profile,
        backend,
        ws_port,
        transpose,
        metronome,
        record,
        record_wav,
        record_dir,
        notes,
    })
}

/// setup.ron values with the command-line flags laid over them (used to fill the setup window).
pub fn overlay_args(setup: &Setup, args: &Args) -> Setup {
    Setup {
        midi_port: args.port.clone().or(setup.midi_port.clone()),
        audio_device: args.audio_device.clone().or(setup.audio_device.clone()),
        buffer_frames: args.buffer.or(setup.buffer_frames),
        profile: args.profile.clone().or(setup.profile.clone()),
        transpose: args.transpose.or(setup.transpose),
        octave: args.octave.or(setup.octave),
        metronome: if args.metronome.is_some() { Some(true) } else { setup.metronome },
        metronome_bpm: args.metronome.or(setup.metronome_bpm),
        metronome_beats_per_bar: setup.metronome_beats_per_bar,
        metronome_volume: setup.metronome_volume,
        backend: args.backend.map(|b| b.name().to_string()).or(setup.backend.clone()),
        ws_port: args.ws_port.or(setup.ws_port),
        record: if args.no_record { Some(false) } else { setup.record },
        record_wav: if args.record_wav { Some(true) } else { setup.record_wav },
        record_dir: args.record_dir.clone().or(setup.record_dir.clone()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{self, Profile};
    use crate::cli::Args;
    use crate::sound::EngineKind;
    use std::path::PathBuf;

    const DEFAULT_RON: &str = include_str!("../profiles/default.ron");

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("rusty_piano_setup_{}_{}", std::process::id(), name));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("profiles")).unwrap();
        dir
    }

    const USER_SETUP: &str = r#"(midi_port: Some("USB MIDI Interface"), buffer_frames: Some(128), profile: Some("mine"))"#;

    #[test]
    fn example_file_is_all_defaults() {
        assert_eq!(parse_setup(include_str!("../setup.example.ron")), Ok(Setup::default()));
    }

    #[test]
    fn parses_user_setup() {
        let s = parse_setup(r#"(midi_port: Some("USB MIDI Interface"), profile: Some("sl990"))"#).unwrap();
        assert_eq!(
            s,
            Setup {
                midi_port: Some("USB MIDI Interface".to_string()),
                profile: Some("sl990".to_string()),
                ..Setup::default()
            }
        );
    }

    #[test]
    fn rejects_bad_values() {
        let err = parse_setup("(buffer_frames: Some(0))").unwrap_err();
        assert!(err.contains("buffer_frames"), "{err}");
        let err = parse_setup("(midi_prot: None)").unwrap_err();
        assert!(err.contains("midi_prot"), "{err}");
        let err = parse_setup(r#"(midi_port: Some("  "))"#).unwrap_err();
        assert!(err.contains("midi_port"), "{err}");
    }

    #[test]
    fn missing_setup_uses_builtin_defaults() {
        let dir = temp_dir("missing_setup");
        let s = resolve_startup(&Args::default(), &dir).unwrap();
        assert_eq!(s.port, None);
        assert_eq!(s.audio_device, None);
        assert_eq!(s.buffer, None);
        assert_eq!(s.profile_name, "default");
        assert_eq!(s.profile_path, None);
        assert_eq!(s.profile, SoundProfile::Simple(Profile::default()));
        assert_eq!(s.notes.len(), 2, "{:?}", s.notes);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn setup_values_used() {
        let dir = temp_dir("setup_values_used");
        std::fs::write(dir.join("setup.ron"), USER_SETUP).unwrap();
        let mine = DEFAULT_RON.replace("voice_gain: 0.3", "voice_gain: 0.4");
        assert_ne!(mine, DEFAULT_RON);
        std::fs::write(dir.join("profiles").join("mine.ron"), mine).unwrap();
        let s = resolve_startup(&Args::default(), &dir).unwrap();
        assert_eq!(s.port, Some("USB MIDI Interface".to_string()));
        assert_eq!(s.buffer, Some(128));
        let SoundProfile::Simple(p) = s.profile else {
            panic!("expected a simple profile, got {:?}", s.profile);
        };
        assert_eq!(p.loudness.voice_gain, 0.4);
        assert_eq!(s.profile_path, Some(dir.join("profiles").join("mine.ron")));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn cli_overrides_setup() {
        let dir = temp_dir("cli_overrides_setup");
        std::fs::write(dir.join("setup.ron"), USER_SETUP).unwrap();
        std::fs::write(dir.join("profiles").join("mine.ron"), DEFAULT_RON).unwrap();
        std::fs::write(dir.join("profiles").join("default.ron"), DEFAULT_RON).unwrap();
        let args = Args {
            port: Some("2".to_string()),
            buffer: Some(64),
            profile: Some("default".to_string()),
            ..Args::default()
        };
        let s = resolve_startup(&args, &dir).unwrap();
        assert_eq!(s.port, Some("2".to_string()));
        assert_eq!(s.buffer, Some(64));
        assert_eq!(s.profile_name, "default");
        assert_eq!(s.profile, SoundProfile::Simple(Profile::default()));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn physical_profile_selects_modal_engine() {
        let dir = temp_dir("physical_profile_selects_modal_engine");
        std::fs::write(
            dir.join("profiles").join("physical.ron"),
            include_str!("../profiles/physical.ron"),
        )
        .unwrap();
        let args = Args {
            profile: Some("physical".to_string()),
            ..Args::default()
        };
        let s = resolve_startup(&args, &dir).unwrap();
        assert_eq!(s.profile.kind(), EngineKind::Modal);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn unknown_profile_is_error_listing_available() {
        let dir = temp_dir("unknown_profile");
        std::fs::write(dir.join("profiles").join("mine.ron"), DEFAULT_RON).unwrap();
        let args = Args {
            profile: Some("nope".to_string()),
            ..Args::default()
        };
        let err = resolve_startup(&args, &dir).unwrap_err();
        assert!(err.contains("nope") && err.contains("mine"), "{err}");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn broken_profile_and_setup_are_errors() {
        let dir = temp_dir("broken_profile");
        std::fs::write(dir.join("profiles").join("bad.ron"), "(").unwrap();
        let args = Args {
            profile: Some("bad".to_string()),
            ..Args::default()
        };
        let err = resolve_startup(&args, &dir).unwrap_err();
        assert!(err.contains("bad"), "{err}");
        std::fs::remove_dir_all(&dir).unwrap();

        let dir = temp_dir("broken_setup");
        std::fs::write(dir.join("setup.ron"), "(midi_port: 5)").unwrap();
        let err = resolve_startup(&Args::default(), &dir).unwrap_err();
        assert!(err.contains("setup.ron"), "{err}");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn backend_setup_value_parsed() {
        let s = parse_setup(r#"(backend: Some("asio"))"#).unwrap();
        assert_eq!(s.backend, Some("asio".to_string()));
    }

    #[test]
    fn backend_setup_rejects_bad_values() {
        let err = parse_setup(r#"(backend: Some("nope"))"#).unwrap_err();
        assert!(err.contains("backend"), "{err}");
        let err = parse_setup(r#"(backend: Some(" "))"#).unwrap_err();
        assert!(err.contains("backend"), "{err}");
    }

    #[test]
    fn default_backend_is_wasapi_shared() {
        let dir = temp_dir("default_backend");
        let s = resolve_startup(&Args::default(), &dir).unwrap();
        assert_eq!(s.backend, Backend::WasapiShared);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn setup_backend_used() {
        let dir = temp_dir("setup_backend_used");
        std::fs::write(dir.join("setup.ron"), r#"(backend: Some("wasapi-exclusive"))"#).unwrap();
        let s = resolve_startup(&Args::default(), &dir).unwrap();
        assert_eq!(s.backend, Backend::WasapiExclusive);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn cli_backend_overrides_setup() {
        let dir = temp_dir("cli_backend_overrides_setup");
        std::fs::write(dir.join("setup.ron"), r#"(backend: Some("wasapi-exclusive"))"#).unwrap();
        let args = Args {
            backend: Some(Backend::WasapiShared),
            ..Args::default()
        };
        let s = resolve_startup(&args, &dir).unwrap();
        assert_eq!(s.backend, Backend::WasapiShared);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn cli_asio_backend_needs_feature() {
        let dir = temp_dir("cli_asio_backend");
        let args = Args {
            backend: Some(Backend::Asio),
            ..Args::default()
        };
        let r = resolve_startup(&args, &dir);
        if cfg!(feature = "asio") {
            assert_eq!(r.unwrap().backend, Backend::Asio);
        } else {
            let err = r.unwrap_err();
            assert!(err.contains("--features asio"), "{err}");
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn ws_port_setup_value_parsed() {
        let s = parse_setup("(ws_port: Some(8766))").unwrap();
        assert_eq!(s.ws_port, Some(8766));
    }

    #[test]
    fn ws_port_zero_rejected() {
        let err = parse_setup("(ws_port: Some(0))").unwrap_err();
        assert!(err.contains("ws_port"), "{err}");
    }

    #[test]
    fn ws_port_off_by_default() {
        let dir = temp_dir("ws_port_off_by_default");
        let s = resolve_startup(&Args::default(), &dir).unwrap();
        assert_eq!(s.ws_port, None);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn setup_ws_port_used() {
        let dir = temp_dir("setup_ws_port_used");
        std::fs::write(dir.join("setup.ron"), "(ws_port: Some(8766))").unwrap();
        let s = resolve_startup(&Args::default(), &dir).unwrap();
        assert_eq!(s.ws_port, Some(8766));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn cli_ws_port_overrides_setup() {
        let dir = temp_dir("cli_ws_port_overrides_setup");
        std::fs::write(dir.join("setup.ron"), "(ws_port: Some(8766))").unwrap();
        let args = Args {
            ws_port: Some(9000),
            ..Args::default()
        };
        let s = resolve_startup(&args, &dir).unwrap();
        assert_eq!(s.ws_port, Some(9000));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn local_setup_ron_parses_if_present() {
        let path = config::engine_dir().join("setup.ron");
        if path.exists() {
            let loaded = load_setup(&path);
            assert!(matches!(loaded, Ok(Some(_))), "{loaded:?}");
        }
    }

    #[test]
    fn record_setup_values_parsed() {
        let s = parse_setup(r#"(record: Some(false), record_dir: Some("takes"))"#).unwrap();
        assert_eq!(s.record, Some(false));
        assert_eq!(s.record_dir, Some("takes".to_string()));
        let err = parse_setup(r#"(record_dir: Some(" "))"#).unwrap_err();
        assert!(err.contains("record_dir"), "{err}");
    }

    #[test]
    fn record_defaults_on_and_repo_folder() {
        let dir = temp_dir("record_defaults");
        let s = resolve_startup(&Args::default(), &dir).unwrap();
        assert!(s.record);
        assert_eq!(s.record_dir, crate::record::default_dir(&dir));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn record_values_from_setup() {
        let dir = temp_dir("record_values_from_setup");
        std::fs::write(dir.join("setup.ron"), r#"(record: Some(false), record_dir: Some("takes"))"#).unwrap();
        let s = resolve_startup(&Args::default(), &dir).unwrap();
        assert!(!s.record);
        assert_eq!(s.record_dir, dir.join("takes"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn record_wav_values() {
        let dir = temp_dir("record_wav_values");
        assert!(!resolve_startup(&Args::default(), &dir).unwrap().record_wav);
        let flag = Args { record_wav: true, ..Args::default() };
        assert!(resolve_startup(&flag, &dir).unwrap().record_wav);
        let off = Args { record_wav: true, no_record: true, ..Args::default() };
        assert!(!resolve_startup(&off, &dir).unwrap().record_wav);
        std::fs::write(dir.join("setup.ron"), "(record_wav: Some(true))").unwrap();
        assert!(resolve_startup(&Args::default(), &dir).unwrap().record_wav);
        std::fs::write(dir.join("setup.ron"), "(record: Some(false), record_wav: Some(true))").unwrap();
        assert!(!resolve_startup(&Args::default(), &dir).unwrap().record_wav);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn record_flags_override_setup() {
        let dir = temp_dir("record_flags_override_setup");
        std::fs::write(dir.join("setup.ron"), r#"(record: Some(true), record_dir: Some("takes"))"#).unwrap();
        let args = Args { no_record: true, record_dir: Some("elsewhere".to_string()), ..Args::default() };
        let s = resolve_startup(&args, &dir).unwrap();
        assert!(!s.record);
        assert_eq!(s.record_dir, PathBuf::from("elsewhere"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn absolute_record_dir_is_kept() {
        let dir = temp_dir("absolute_record_dir");
        let abs = std::env::temp_dir().join("rusty_piano_abs_takes");
        let setup = Setup { record_dir: Some(abs.display().to_string()), ..Setup::default() };
        let s = resolve_from(setup, &Args::default(), &dir, Vec::new()).unwrap();
        assert_eq!(s.record_dir, abs);
        assert_eq!(s.notes.len(), 1, "{:?}", s.notes);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn setup_path_is_in_engine_dir() {
        assert_eq!(setup_path(Path::new("e")), Path::new("e").join("setup.ron"));
    }

    #[test]
    fn overlay_args_flags_win() {
        let base = Setup { midi_port: Some("a".to_string()), buffer_frames: Some(128), ws_port: Some(8790), record_dir: Some("x".to_string()), ..Setup::default() };
        assert_eq!(overlay_args(&base, &Args::default()), base);
        let args = Args { port: Some("b".to_string()), backend: Some(Backend::Asio), no_record: true, ..Args::default() };
        assert_eq!(overlay_args(&base, &args), Setup { midi_port: Some("b".to_string()), buffer_frames: Some(128), backend: Some("asio".to_string()), ws_port: Some(8790), record: Some(false), record_dir: Some("x".to_string()), ..Setup::default() });
        let args = Args { transpose: Some(2), ..Args::default() };
        assert_eq!(overlay_args(&base, &args), Setup { transpose: Some(2), ..base.clone() });
        let args = Args { record_wav: true, ..Args::default() };
        assert_eq!(overlay_args(&base, &args), Setup { record_wav: Some(true), ..base.clone() });
        let args = Args { metronome: Some(120), ..Args::default() };
        assert_eq!(overlay_args(&base, &args), Setup { metronome: Some(true), metronome_bpm: Some(120), ..base.clone() });
    }

    #[test]
    fn metronome_setup_values() {
        let dir = temp_dir("metronome_setup_values");
        let start = resolve_from(Setup::default(), &Args::default(), &dir, Vec::new()).unwrap();
        assert_eq!(start.metronome, crate::metronome::MetronomeSettings { on: false, bpm: 100, beats_per_bar: 4, volume: 50 });
        let s = parse_setup("(metronome: Some(true), metronome_bpm: Some(72), metronome_beats_per_bar: Some(3), metronome_volume: Some(40))").unwrap();
        assert_eq!((s.metronome, s.metronome_bpm, s.metronome_beats_per_bar, s.metronome_volume), (Some(true), Some(72), Some(3), Some(40)));
        let start = resolve_from(s, &Args::default(), &dir, Vec::new()).unwrap();
        assert_eq!(start.metronome, crate::metronome::MetronomeSettings { on: true, bpm: 72, beats_per_bar: 3, volume: 40 });
        for (text, field) in [
            ("(metronome_bpm: Some(29))", "metronome_bpm"),
            ("(metronome_bpm: Some(301))", "metronome_bpm"),
            ("(metronome_beats_per_bar: Some(0))", "metronome_beats_per_bar"),
            ("(metronome_beats_per_bar: Some(13))", "metronome_beats_per_bar"),
            ("(metronome_volume: Some(101))", "metronome_volume"),
        ] {
            let err = parse_setup(text).unwrap_err();
            assert!(err.contains(field), "{err}");
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn metronome_flag_overrides_setup() {
        let dir = temp_dir("metronome_flag_overrides_setup");
        let setup = Setup { metronome_bpm: Some(80), metronome_beats_per_bar: Some(3), ..Setup::default() };
        let args = Args { metronome: Some(132), ..Args::default() };
        let start = resolve_from(setup, &args, &dir, Vec::new()).unwrap();
        assert_eq!(start.metronome, crate::metronome::MetronomeSettings { on: true, bpm: 132, beats_per_bar: 3, volume: 50 });
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn transpose_setup_values() {
        let dir = temp_dir("transpose_setup_values");
        let s = parse_setup("(transpose: Some(-3), octave: Some(1))").unwrap();
        assert_eq!((s.transpose, s.octave), (Some(-3), Some(1)));
        let start = resolve_from(s, &Args::default(), &dir, Vec::new()).unwrap();
        assert_eq!(start.transpose, crate::transpose::Shift { semitones: -3, octaves: 1 });
        assert_eq!(start.notes.len(), 2, "{:?}", start.notes);
        assert!(start.notes[0].contains("-3 semitones, +1 octave"), "{:?}", start.notes);
        let err = parse_setup("(transpose: Some(13))").unwrap_err();
        assert!(err.contains("transpose"), "{err}");
        let err = parse_setup("(octave: Some(-3))").unwrap_err();
        assert!(err.contains("octave"), "{err}");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn transpose_flags_override_setup() {
        let dir = temp_dir("transpose_flags_override_setup");
        let setup = Setup { transpose: Some(-3), octave: Some(1), ..Setup::default() };
        let args = Args { transpose: Some(5), octave: Some(-1), ..Args::default() };
        let start = resolve_from(setup, &args, &dir, Vec::new()).unwrap();
        assert_eq!(start.transpose, crate::transpose::Shift { semitones: 5, octaves: -1 });
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
