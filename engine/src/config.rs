//! Sound profiles: RON files in engine/profiles/<name>.ron. Types, built-in defaults (the original SimplePiano sound), parsing, validation and file lookup.

use crate::sound::modal_piano::{parse_modal_profile, ModalProfile};
use crate::sound::simple_piano::MAX_VOICES;
use crate::sound::EngineKind;
use std::fmt::Display;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{SyncSender, TrySendError};
use std::time::{Duration, SystemTime};

#[derive(Debug, Clone, Copy, PartialEq, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Profile {
    pub loudness: Loudness,
    pub tone: Tone,
    pub bass: Bass,
    pub envelope: Envelope,
    pub voices: Voices,
    pub limiter: Limiter,
}

#[derive(Debug, Clone, Copy, PartialEq, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Loudness {
    pub master_volume: f32,
    pub voice_gain: f32,
    pub velocity_curve: f32,
    pub full_force_velocity: u8,
}

#[derive(Debug, Clone, Copy, PartialEq, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Tone {
    pub harmonics: Harmonics,
    pub brightness_min: f32,
    pub brightness_velocity: f32,
}

#[derive(Debug, Clone, Copy, PartialEq, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Harmonics {
    pub fundamental: f32,
    pub second: f32,
    pub third: f32,
    pub fourth: f32,
    pub fifth: f32,
    pub sixth: f32,
    pub seventh: f32,
    pub eighth: f32,
}

impl Harmonics {
    pub fn as_array(&self) -> [f32; 8] {
        [
            self.fundamental,
            self.second,
            self.third,
            self.fourth,
            self.fifth,
            self.sixth,
            self.seventh,
            self.eighth,
        ]
    }
}

#[derive(Debug, Clone, Copy, PartialEq, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Bass {
    pub pivot_note: u8,
    pub gain_db_per_octave: f32,
    pub max_gain_db: f32,
    pub overtone_db_per_octave: f32,
    pub max_overtone_db: f32,
}

#[derive(Debug, Clone, Copy, PartialEq, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Envelope {
    pub attack_ms: f32,
    pub decay_middle_c_s: f32,
    pub decay_doubling_semitones: f32,
    pub decay_min_s: f32,
    pub decay_max_s: f32,
    pub release_ms: f32,
}

#[derive(Debug, Clone, Copy, PartialEq, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Voices {
    pub max_voices: usize,
    pub steal: StealPolicy,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
pub enum StealPolicy {
    Quietest,
    Oldest,
}

#[derive(Debug, Clone, Copy, PartialEq, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Limiter {
    pub knee: f32,
    pub ceiling: f32,
}

impl Default for Profile {
    fn default() -> Self {
        Self {
            loudness: Loudness {
                master_volume: 1.0,
                voice_gain: 0.3,
                velocity_curve: 1.5,
                full_force_velocity: 127,
            },
            tone: Tone {
                harmonics: Harmonics {
                    fundamental: 1.0,
                    second: 0.5,
                    third: 0.3,
                    fourth: 0.15,
                    fifth: 0.0,
                    sixth: 0.0,
                    seventh: 0.0,
                    eighth: 0.0,
                },
                brightness_min: 0.35,
                brightness_velocity: 0.65,
            },
            bass: Bass {
                pivot_note: 60,
                gain_db_per_octave: 0.0,
                max_gain_db: 12.0,
                overtone_db_per_octave: 0.0,
                max_overtone_db: 12.0,
            },
            envelope: Envelope {
                attack_ms: 2.0,
                decay_middle_c_s: 1.5,
                decay_doubling_semitones: 24.0,
                decay_min_s: 0.2,
                decay_max_s: 6.0,
                release_ms: 80.0,
            },
            voices: Voices {
                max_voices: 32,
                steal: StealPolicy::Quietest,
            },
            limiter: Limiter {
                knee: 0.8,
                ceiling: 1.0,
            },
        }
    }
}

fn check_f32(field: &str, v: f32, lo: f32, hi: f32) -> Result<(), String> {
    if (lo..=hi).contains(&v) {
        Ok(())
    } else {
        Err(format!("{field} must be between {lo:?} and {hi:?}, got {v:?}"))
    }
}

fn check_int<T: PartialOrd + Display + Copy>(field: &str, v: T, lo: T, hi: T) -> Result<(), String> {
    if (lo..=hi).contains(&v) {
        Ok(())
    } else {
        Err(format!("{field} must be between {lo} and {hi}, got {v}"))
    }
}

impl Profile {
    pub fn validate(&self) -> Result<(), String> {
        let l = &self.loudness;
        check_f32("loudness.master_volume", l.master_volume, 0.0, 4.0)?;
        check_f32("loudness.voice_gain", l.voice_gain, 0.0, 1.0)?;
        check_f32("loudness.velocity_curve", l.velocity_curve, 0.2, 5.0)?;
        check_int("loudness.full_force_velocity", l.full_force_velocity, 1, 127)?;

        let h = &self.tone.harmonics;
        check_f32("tone.harmonics.fundamental", h.fundamental, 0.0, 2.0)?;
        check_f32("tone.harmonics.second", h.second, 0.0, 2.0)?;
        check_f32("tone.harmonics.third", h.third, 0.0, 2.0)?;
        check_f32("tone.harmonics.fourth", h.fourth, 0.0, 2.0)?;
        check_f32("tone.harmonics.fifth", h.fifth, 0.0, 2.0)?;
        check_f32("tone.harmonics.sixth", h.sixth, 0.0, 2.0)?;
        check_f32("tone.harmonics.seventh", h.seventh, 0.0, 2.0)?;
        check_f32("tone.harmonics.eighth", h.eighth, 0.0, 2.0)?;
        if h.as_array().iter().all(|&v| v == 0.0) {
            return Err("tone.harmonics: at least one harmonic must be above 0.0".to_string());
        }
        check_f32("tone.brightness_min", self.tone.brightness_min, 0.0, 1.0)?;
        check_f32("tone.brightness_velocity", self.tone.brightness_velocity, 0.0, 1.0)?;

        let b = &self.bass;
        check_int("bass.pivot_note", b.pivot_note, 21, 108)?;
        check_f32("bass.gain_db_per_octave", b.gain_db_per_octave, 0.0, 12.0)?;
        check_f32("bass.max_gain_db", b.max_gain_db, 0.0, 24.0)?;
        check_f32("bass.overtone_db_per_octave", b.overtone_db_per_octave, 0.0, 12.0)?;
        check_f32("bass.max_overtone_db", b.max_overtone_db, 0.0, 24.0)?;

        let e = &self.envelope;
        check_f32("envelope.attack_ms", e.attack_ms, 0.1, 100.0)?;
        check_f32("envelope.decay_middle_c_s", e.decay_middle_c_s, 0.05, 30.0)?;
        check_f32("envelope.decay_doubling_semitones", e.decay_doubling_semitones, 1.0, 120.0)?;
        check_f32("envelope.decay_min_s", e.decay_min_s, 0.01, 30.0)?;
        check_f32("envelope.decay_max_s", e.decay_max_s, 0.01, 30.0)?;
        if e.decay_min_s > e.decay_max_s {
            return Err(format!(
                "envelope.decay_min_s ({:?}) must not be above envelope.decay_max_s ({:?})",
                e.decay_min_s, e.decay_max_s
            ));
        }
        check_f32("envelope.release_ms", e.release_ms, 1.0, 5000.0)?;

        check_int("voices.max_voices", self.voices.max_voices, 1, MAX_VOICES)?;

        check_f32("limiter.knee", self.limiter.knee, 0.1, 0.99)?;
        check_f32("limiter.ceiling", self.limiter.ceiling, 0.1, 1.0)?;
        Ok(())
    }
}

pub fn parse_profile(text: &str) -> Result<Profile, String> {
    let p = ron::from_str::<Profile>(text).map_err(|e| e.to_string())?;
    p.validate()?;
    Ok(p)
}

pub fn load_profile(path: &Path) -> Result<Profile, String> {
    let text = std::fs::read_to_string(path)
        .map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    parse_profile(&text).map_err(|e| format!("{}: {e}", path.display()))
}

#[derive(Debug, Clone, Copy, PartialEq)]
#[allow(clippy::large_enum_variant)] // plain Copy config value; the size is deliberate
pub enum SoundProfile {
    Simple(Profile),
    Modal(ModalProfile),
}

impl SoundProfile {
    pub fn kind(&self) -> EngineKind {
        match self {
            SoundProfile::Simple(_) => EngineKind::Simple,
            SoundProfile::Modal(_) => EngineKind::Modal,
        }
    }

    pub fn validate(&self) -> Result<(), String> {
        match self {
            SoundProfile::Simple(p) => p.validate(),
            SoundProfile::Modal(p) => p.validate(),
        }
    }
}

impl Default for SoundProfile {
    fn default() -> Self {
        SoundProfile::Simple(Profile::default())
    }
}

impl From<Profile> for SoundProfile {
    fn from(p: Profile) -> Self {
        SoundProfile::Simple(p)
    }
}

impl From<ModalProfile> for SoundProfile {
    fn from(p: ModalProfile) -> Self {
        SoundProfile::Modal(p)
    }
}

#[derive(serde::Deserialize)]
struct EngineProbe {
    #[serde(default)]
    engine: EngineKind,
}

pub fn probe_engine_kind(text: &str) -> Option<EngineKind> {
    if let Ok(probe) = ron::from_str::<EngineProbe>(text) {
        return Some(probe.engine);
    }
    text.lines()
        .map(str::trim)
        .filter(|l| l.starts_with("engine:"))
        .find_map(|l| {
            if l.contains("Modal") {
                Some(EngineKind::Modal)
            } else if l.contains("Simple") {
                Some(EngineKind::Simple)
            } else {
                None
            }
        })
}

pub fn parse_sound_profile(text: &str) -> Result<SoundProfile, String> {
    let Ok(probe) = ron::from_str::<EngineProbe>(text) else {
        if text.lines().any(|l| l.trim().starts_with("engine:")) {
            return parse_modal_profile(text).map(SoundProfile::Modal);
        }
        return parse_profile(text).map(SoundProfile::Simple);
    };
    match probe.engine {
        EngineKind::Simple => parse_profile(text).map(SoundProfile::Simple),
        EngineKind::Modal => parse_modal_profile(text).map(SoundProfile::Modal),
    }
}

pub fn load_sound_profile(path: &Path) -> Result<SoundProfile, String> {
    let text = std::fs::read_to_string(path)
        .map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    parse_sound_profile(&text).map_err(|e| format!("{}: {e}", path.display()))
}

pub fn engine_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

pub fn profile_path(engine_dir: &Path, name: &str) -> PathBuf {
    if name.to_lowercase().ends_with(".ron") {
        PathBuf::from(name)
    } else {
        engine_dir.join("profiles").join(format!("{name}.ron"))
    }
}

pub fn list_profiles(engine_dir: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(engine_dir.join("profiles")) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|x| x.to_str()) == Some("ron"))
        .filter_map(|p| p.file_stem().map(|s| s.to_string_lossy().into_owned()))
        .collect();
    names.sort();
    names
}

pub const RELOAD_POLL_INTERVAL: Duration = Duration::from_millis(500);

#[derive(Debug, Clone, PartialEq)]
#[allow(clippy::large_enum_variant)] // plain config value; the size is deliberate
pub enum ReloadOutcome {
    Unchanged,
    Reloaded(SoundProfile),
    Failed(String),
}

pub struct ProfileReloader {
    path: PathBuf,
    last_modified: Option<SystemTime>,
    missing_reported: bool,
}

impl ProfileReloader {
    pub fn new(path: PathBuf) -> Self {
        let last_modified = std::fs::metadata(&path).and_then(|m| m.modified()).ok();
        Self {
            path,
            last_modified,
            missing_reported: false,
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn poll(&mut self) -> ReloadOutcome {
        match std::fs::metadata(&self.path).and_then(|m| m.modified()) {
            Err(e) => {
                if self.missing_reported {
                    ReloadOutcome::Unchanged
                } else {
                    self.missing_reported = true;
                    self.last_modified = None;
                    ReloadOutcome::Failed(format!("cannot read {}: {e}", self.path.display()))
                }
            }
            Ok(t) => {
                self.missing_reported = false;
                if Some(t) == self.last_modified {
                    ReloadOutcome::Unchanged
                } else {
                    self.last_modified = Some(t);
                    match load_sound_profile(&self.path) {
                        Ok(p) => ReloadOutcome::Reloaded(p),
                        Err(e) => ReloadOutcome::Failed(e),
                    }
                }
            }
        }
    }
}

pub fn spawn_profile_watcher(
    path: PathBuf,
    kind: EngineKind,
    tx: SyncSender<SoundProfile>,
) -> std::thread::JoinHandle<()> {
    let mut reloader = ProfileReloader::new(path.clone());
    std::thread::Builder::new()
        .name("profile-watcher".into())
        .spawn(move || loop {
            std::thread::sleep(RELOAD_POLL_INTERVAL);
            match reloader.poll() {
                ReloadOutcome::Reloaded(p) if p.kind() != kind => eprintln!(
                    "warning: {} now selects the {} engine; restart the engine to switch (keeping the current settings)",
                    path.display(),
                    p.kind().label()
                ),
                ReloadOutcome::Reloaded(p) => match tx.try_send(p) {
                    Ok(()) => println!("Sound profile reloaded: {}", path.display()),
                    Err(TrySendError::Full(_)) => eprintln!(
                        "warning: sound engine busy, profile change not applied; save the file again"
                    ),
                    Err(TrySendError::Disconnected(_)) => return,
                },
                ReloadOutcome::Failed(e) => {
                    let other = std::fs::read_to_string(&path)
                        .ok()
                        .and_then(|t| probe_engine_kind(&t))
                        .filter(|k| *k != kind);
                    match other {
                        Some(k) => eprintln!(
                            "warning: {} now selects the {} engine; restart the engine to switch (keeping the current settings)",
                            path.display(),
                            k.label()
                        ),
                        None => eprintln!("error: {e} (keeping the last good settings)"),
                    }
                }
                ReloadOutcome::Unchanged => {}
            }
        })
        .expect("spawn profile watcher")
}

#[cfg(test)]
mod tests {
    use super::*;

    const DEFAULT_RON: &str = include_str!("../profiles/default.ron");
    const SL990_RON: &str = include_str!("../profiles/sl990.ron");

    #[test]
    fn default_ron_equals_builtin_default() {
        assert_eq!(parse_profile(DEFAULT_RON), Ok(Profile::default()));
    }

    #[test]
    fn sl990_ron_values() {
        let mut expected = Profile::default();
        expected.loudness.voice_gain = 0.5;
        expected.loudness.full_force_velocity = 90;
        expected.tone.harmonics.fifth = 0.1;
        expected.tone.harmonics.sixth = 0.07;
        expected.tone.harmonics.seventh = 0.05;
        expected.tone.harmonics.eighth = 0.035;
        expected.bass.gain_db_per_octave = 2.0;
        expected.bass.max_gain_db = 6.0;
        expected.bass.overtone_db_per_octave = 4.0;
        assert_eq!(parse_profile(SL990_RON), Ok(expected));
    }

    #[test]
    fn every_number_has_a_comment() {
        for (name, text) in [("default.ron", DEFAULT_RON), ("sl990.ron", SL990_RON)] {
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
                if !(is_number_line || t.starts_with("steal:")) {
                    continue;
                }
                let prev = lines[..i].iter().rev().map(|l| l.trim()).find(|l| !l.is_empty());
                assert!(
                    prev.is_some_and(|p| p.starts_with("//")),
                    "{name}: no comment above line: {t}"
                );
            }
        }
    }

    #[test]
    fn validation_names_field_and_range() {
        type Case = (fn(&mut Profile), &'static str, bool);
        let cases: Vec<Case> = vec![
            (|p| p.loudness.voice_gain = 1.5, "loudness.voice_gain", true),
            (|p| p.loudness.master_volume = f32::NAN, "loudness.master_volume", true),
            (|p| p.loudness.full_force_velocity = 0, "loudness.full_force_velocity", true),
            (|p| p.tone.harmonics.fifth = -0.1, "tone.harmonics.fifth", true),
            (|p| p.bass.pivot_note = 10, "bass.pivot_note", true),
            (|p| p.bass.gain_db_per_octave = 13.0, "bass.gain_db_per_octave", true),
            (|p| p.envelope.attack_ms = 0.0, "envelope.attack_ms", true),
            (|p| p.voices.max_voices = 0, "voices.max_voices", true),
            (|p| p.voices.max_voices = 33, "voices.max_voices", true),
            (|p| p.limiter.knee = 1.0, "limiter.knee", true),
            (|p| p.limiter.ceiling = f32::INFINITY, "limiter.ceiling", true),
            (
                |p| {
                    let h = &mut p.tone.harmonics;
                    h.fundamental = 0.0;
                    h.second = 0.0;
                    h.third = 0.0;
                    h.fourth = 0.0;
                },
                "at least one harmonic",
                false,
            ),
            (|p| p.envelope.decay_min_s = 7.0, "must not be above", false),
        ];
        for (mutate, expect, ranged) in cases {
            let mut p = Profile::default();
            mutate(&mut p);
            let err = p.validate().unwrap_err();
            assert!(err.contains(expect), "expected '{expect}' in: {err}");
            if ranged {
                assert!(err.contains("between"), "expected 'between' in: {err}");
            }
        }
    }

    #[test]
    fn default_is_valid() {
        assert!(Profile::default().validate().is_ok());
    }

    #[test]
    fn parse_errors_are_reported() {
        assert!(parse_profile("(").is_err());
        let misspelled = DEFAULT_RON.replace("voice_gain:", "voice_gian:");
        let err = parse_profile(&misspelled).unwrap_err();
        assert!(err.contains("voice_gian"), "{err}");
        let out_of_range = DEFAULT_RON.replace("voice_gain: 0.3", "voice_gain: 5.0");
        let err = parse_profile(&out_of_range).unwrap_err();
        assert!(err.contains("loudness.voice_gain"), "{err}");
    }

    #[test]
    fn load_missing_file_is_error() {
        let path = std::env::temp_dir().join("rusty_piano_no_such_profile.ron");
        let err = load_profile(&path).unwrap_err();
        assert!(err.contains("cannot read"), "{err}");
    }

    #[test]
    fn profile_path_rules() {
        assert_eq!(
            profile_path(Path::new("E"), "sl990"),
            Path::new("E").join("profiles").join("sl990.ron")
        );
        assert_eq!(profile_path(Path::new("E"), "x/my.RON"), PathBuf::from("x/my.RON"));
    }

    #[test]
    fn shipped_profiles_are_listed() {
        let names = list_profiles(&engine_dir());
        assert!(names.contains(&"default".to_string()), "{names:?}");
        assert!(names.contains(&"sl990".to_string()), "{names:?}");
        assert!(names.contains(&"physical".to_string()), "{names:?}");
    }

    const PHYSICAL_RON: &str = include_str!("../profiles/physical.ron");

    #[test]
    fn shipped_profiles_parse_by_kind() {
        assert_eq!(
            parse_sound_profile(DEFAULT_RON),
            parse_profile(DEFAULT_RON).map(SoundProfile::Simple)
        );
        assert!(matches!(parse_sound_profile(SL990_RON), Ok(SoundProfile::Simple(_))));
        match parse_sound_profile(PHYSICAL_RON) {
            Ok(SoundProfile::Modal(p)) => assert_eq!(crate::fit::ron_edit::unfitted(&p), ModalProfile::default()),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn modal_errors_name_the_field() {
        let renamed = PHYSICAL_RON.replace("max_partials:", "max_partials_x:");
        let err = parse_sound_profile(&renamed).unwrap_err();
        assert!(err.contains("max_partials_x"), "{err}");

        let zero: String = PHYSICAL_RON
            .lines()
            .map(|l| {
                if l.trim_start().starts_with("full_force_velocity:") {
                    "full_force_velocity: 0,"
                } else {
                    l
                }
            })
            .collect::<Vec<&str>>()
            .join("\n");
        let err = parse_sound_profile(&zero).unwrap_err();
        assert!(err.contains("velocity.full_force_velocity"), "{err}");
    }

    #[test]
    fn modal_syntax_error_is_reported_as_modal() {
        let broken = PHYSICAL_RON.replace("engine: Modal,", "engine: Modal");
        assert_ne!(broken, PHYSICAL_RON);
        let err = parse_sound_profile(&broken).unwrap_err();
        assert!(!(err.contains("unknown field") && err.contains("engine")), "{err}");
    }

    fn write_at(path: &Path, text: &str, when: SystemTime) {
        std::fs::write(path, text).unwrap();
        std::fs::File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(when)
            .unwrap();
    }

    #[test]
    fn reloader_detects_change_and_keeps_last_good() {
        let t0 = SystemTime::now();
        let path = std::env::temp_dir().join(format!(
            "rusty_piano_reload_{}_reloader_detects_change_and_keeps_last_good.ron",
            std::process::id()
        ));
        let louder = DEFAULT_RON.replace("voice_gain: 0.3", "voice_gain: 0.5");
        assert_ne!(louder, DEFAULT_RON);
        let broken_gain = DEFAULT_RON.replace("voice_gain: 0.3", "voice_gain: 5.0");

        std::fs::write(&path, DEFAULT_RON).unwrap();
        let mut r = ProfileReloader::new(path.clone());
        assert_eq!(r.poll(), ReloadOutcome::Unchanged);

        write_at(&path, &louder, t0 + Duration::from_secs(2));
        match r.poll() {
            ReloadOutcome::Reloaded(SoundProfile::Simple(p)) => assert_eq!(p.loudness.voice_gain, 0.5),
            other => panic!("expected Reloaded, got {other:?}"),
        }
        assert_eq!(r.poll(), ReloadOutcome::Unchanged);

        write_at(&path, "(loudness: (", t0 + Duration::from_secs(4));
        match r.poll() {
            ReloadOutcome::Failed(e) => assert!(!e.is_empty()),
            other => panic!("expected Failed, got {other:?}"),
        }
        assert_eq!(r.poll(), ReloadOutcome::Unchanged);

        write_at(&path, &broken_gain, t0 + Duration::from_secs(6));
        match r.poll() {
            ReloadOutcome::Failed(e) => assert!(e.contains("loudness.voice_gain"), "{e}"),
            other => panic!("expected Failed, got {other:?}"),
        }

        std::fs::remove_file(&path).unwrap();
        match r.poll() {
            ReloadOutcome::Failed(e) => assert!(e.contains("cannot read"), "{e}"),
            other => panic!("expected Failed, got {other:?}"),
        }
        assert_eq!(r.poll(), ReloadOutcome::Unchanged);

        write_at(&path, &louder, t0 + Duration::from_secs(8));
        assert!(matches!(r.poll(), ReloadOutcome::Reloaded(_)));

        std::fs::remove_file(&path).unwrap();
    }

    #[test]
    fn watcher_thread_sends_reloaded_profile() {
        let t0 = SystemTime::now();
        let path = std::env::temp_dir().join(format!(
            "rusty_piano_reload_{}_watcher_thread_sends_reloaded_profile.ron",
            std::process::id()
        ));
        let louder = DEFAULT_RON.replace("voice_gain: 0.3", "voice_gain: 0.5");

        std::fs::write(&path, DEFAULT_RON).unwrap();
        let (tx, rx) = std::sync::mpsc::sync_channel(4);
        spawn_profile_watcher(path.clone(), EngineKind::Simple, tx);
        std::thread::sleep(Duration::from_millis(100));
        write_at(&path, &louder, t0 + Duration::from_secs(2));

        let p = rx
            .recv_timeout(Duration::from_secs(3))
            .expect("no reloaded profile received");
        match p {
            SoundProfile::Simple(p) => assert_eq!(p.loudness.voice_gain, 0.5),
            other => panic!("expected Simple, got {other:?}"),
        }

        std::fs::remove_file(&path).unwrap();
    }

    #[test]
    fn reloader_reloads_modal_profile() {
        let t0 = SystemTime::now();
        let path = std::env::temp_dir().join(format!(
            "rusty_piano_reload_{}_reloader_reloads_modal_profile.ron",
            std::process::id()
        ));
        let louder = PHYSICAL_RON.replace("master_volume: 1.0", "master_volume: 1.5");
        assert_ne!(louder, PHYSICAL_RON);
        let broken = PHYSICAL_RON.replace("master_volume: 1.0", "master_volume: 9.0");

        std::fs::write(&path, PHYSICAL_RON).unwrap();
        let mut r = ProfileReloader::new(path.clone());
        assert_eq!(r.poll(), ReloadOutcome::Unchanged);

        write_at(&path, &louder, t0 + Duration::from_secs(2));
        match r.poll() {
            ReloadOutcome::Reloaded(SoundProfile::Modal(p)) => assert_eq!(p.output.master_volume, 1.5),
            other => panic!("expected Reloaded modal, got {other:?}"),
        }

        write_at(&path, &broken, t0 + Duration::from_secs(4));
        match r.poll() {
            ReloadOutcome::Failed(e) => assert!(e.contains("output.master_volume"), "{e}"),
            other => panic!("expected Failed, got {other:?}"),
        }

        std::fs::remove_file(&path).unwrap();
    }

    #[test]
    fn watcher_refuses_engine_switch() {
        let t0 = SystemTime::now();
        let path = std::env::temp_dir().join(format!(
            "rusty_piano_reload_{}_watcher_refuses_engine_switch.ron",
            std::process::id()
        ));
        let louder = DEFAULT_RON.replace("voice_gain: 0.3", "voice_gain: 0.5");

        std::fs::write(&path, DEFAULT_RON).unwrap();
        let (tx, rx) = std::sync::mpsc::sync_channel(4);
        spawn_profile_watcher(path.clone(), EngineKind::Simple, tx);
        std::thread::sleep(Duration::from_millis(100));
        write_at(&path, PHYSICAL_RON, t0 + Duration::from_secs(2));
        assert!(rx.recv_timeout(Duration::from_secs(2)).is_err());

        write_at(&path, &louder, t0 + Duration::from_secs(4));
        match rx.recv_timeout(Duration::from_secs(3)) {
            Ok(SoundProfile::Simple(p)) => assert_eq!(p.loudness.voice_gain, 0.5),
            other => panic!("expected Simple, got {other:?}"),
        }

        std::fs::remove_file(&path).unwrap();
    }

    #[test]
    fn probe_engine_kind_reads_the_line() {
        let edited = PHYSICAL_RON.replace("engine: Modal,", "engine: Simple,");
        assert_ne!(edited, PHYSICAL_RON);
        assert_eq!(probe_engine_kind(PHYSICAL_RON), Some(EngineKind::Modal));
        assert_eq!(probe_engine_kind(DEFAULT_RON), Some(EngineKind::Simple));
        assert_eq!(probe_engine_kind(&edited), Some(EngineKind::Simple));
        assert_eq!(probe_engine_kind("((("), None);
    }

    #[test]
    fn watcher_warns_when_engine_line_changes() {
        let t0 = SystemTime::now();
        let path = std::env::temp_dir().join(format!(
            "rusty_piano_reload_{}_watcher_warns_when_engine_line_changes.ron",
            std::process::id()
        ));
        let edited = PHYSICAL_RON.replace("engine: Modal,", "engine: Simple,");
        assert_ne!(edited, PHYSICAL_RON);
        let narrower = PHYSICAL_RON.replace("stereo_width: 0.5,", "stereo_width: 0.25,");
        assert_ne!(narrower, PHYSICAL_RON);

        std::fs::write(&path, PHYSICAL_RON).unwrap();
        let (tx, rx) = std::sync::mpsc::sync_channel(4);
        spawn_profile_watcher(path.clone(), EngineKind::Modal, tx);
        std::thread::sleep(Duration::from_millis(100));
        write_at(&path, &edited, t0 + Duration::from_secs(2));
        assert!(rx.recv_timeout(Duration::from_secs(2)).is_err());

        write_at(&path, &narrower, t0 + Duration::from_secs(4));
        match rx.recv_timeout(Duration::from_secs(3)) {
            Ok(SoundProfile::Modal(p)) => assert_eq!(p.output.stereo_width, 0.25),
            other => panic!("expected Modal, got {other:?}"),
        }

        std::fs::remove_file(&path).unwrap();
    }
}
