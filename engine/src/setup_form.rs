//! The setup window's settings as a list of field descriptions (pure, no window). To show a new setting
//! (later: sound-profile and modelling parameters), add a Field here and read it in to_setup.
use crate::audio::{self, Backend, OutputDeviceInfo};
use crate::config;
use crate::flexasio::{self, FlexAsioConfig};
use crate::setup::Setup;
use std::path::Path;

pub const KEY_MIDI_PORT: &str = "midi_port";
pub const KEY_BACKEND: &str = "backend";
pub const KEY_AUDIO_DEVICE: &str = "audio_device";
pub const KEY_FLEXASIO_OUTPUT: &str = "flexasio_output";
pub const KEY_BUFFER: &str = "buffer_frames";
pub const KEY_PROFILE: &str = "profile";
pub const KEY_TRANSPOSE: &str = "transpose";
pub const KEY_OCTAVE: &str = "octave";
pub const KEY_METRONOME_ON: &str = "metronome";
pub const KEY_METRONOME_BPM: &str = "metronome_bpm";
pub const KEY_METRONOME_BEATS: &str = "metronome_beats_per_bar";
pub const KEY_METRONOME_VOLUME: &str = "metronome_volume";
pub const KEY_RECORD: &str = "record";
pub const KEY_RECORD_WAV: &str = "record_wav";
pub const KEY_RECORD_DIR: &str = "record_dir";
pub const KEY_WS_ON: &str = "ws_on";
pub const KEY_WS_PORT: &str = "ws_port";
pub const DEFAULT_WS_PORT: u16 = 8790;
pub const BUFFER_CHOICES: [u32; 6] = [32, 64, 128, 256, 512, 1024];

#[derive(Debug, Clone, PartialEq)] pub struct ChoiceOption { pub value: Option<String>, pub label: String }
#[derive(Debug, Clone, PartialEq)] pub enum FieldKind { Choice(Vec<ChoiceOption>), Toggle, Text { hint: String }, Number { min: u32, max: u32 } }
#[derive(Debug, Clone, PartialEq)] pub enum FieldValue { Choice(Option<String>), Toggle(bool), Text(String), Number(u32) }
#[derive(Debug, Clone, PartialEq)] pub struct Field { pub key: &'static str, pub section: &'static str, pub label: &'static str, pub help: &'static str, pub kind: FieldKind, pub value: FieldValue }
#[derive(Debug, Clone, PartialEq)] pub struct Inventory { pub midi_ports: Result<Vec<String>, String>, pub wasapi_devices: Result<Vec<OutputDeviceInfo>, String>, pub asio_devices: Result<Vec<OutputDeviceInfo>, String>, pub asio_available: bool, pub profiles: Vec<String>, pub flexasio: Result<FlexAsioConfig, String> }
#[derive(Debug, Clone, PartialEq)] pub struct SetupForm { pub fields: Vec<Field>, inventory: Inventory, initial: Setup }

fn opt(value: Option<&str>, label: &str) -> ChoiceOption { ChoiceOption { value: value.map(str::to_string), label: label.to_string() } }

/// Adds an option for a value from setup.ron that is not in the list (label "<value> (from setup.ron)").
pub fn with_current(options: Vec<ChoiceOption>, current: &Option<String>) -> Vec<ChoiceOption> {
    with_current_note(options, current, "from setup.ron")
}

fn with_current_note(mut options: Vec<ChoiceOption>, current: &Option<String>, note: &str) -> Vec<ChoiceOption> {
    if let Some(v) = current {
        if !options.iter().any(|o| o.value.as_deref() == Some(v.as_str())) {
            options.push(ChoiceOption { value: Some(v.clone()), label: format!("{v} ({note})") });
        }
    }
    options
}

pub fn device_options(backend: Backend, inventory: &Inventory, current: &Option<String>) -> Vec<ChoiceOption> {
    device_options_note(backend, inventory, current, "from setup.ron")
}

fn device_options_note(backend: Backend, inventory: &Inventory, current: &Option<String>, note: &str) -> Vec<ChoiceOption> {
    let list = match backend { Backend::Asio => &inventory.asio_devices, _ => &inventory.wasapi_devices };
    let mut options = vec![opt(None, "Default")];
    if let Ok(devices) = list {
        for d in devices {
            let label = if d.is_default { format!("{} (default)", d.name) } else { d.name.clone() };
            options.push(ChoiceOption { value: Some(d.name.clone()), label });
        }
    }
    with_current_note(options, current, note)
}

pub fn midi_port_names() -> Result<Vec<String>, String> {
    let midi_in = midir::MidiInput::new("rusty_piano-setup").map_err(|e| format!("cannot open MIDI system: {e}"))?;
    Ok(midi_in.ports().iter().map(|p| midi_in.port_name(p).unwrap_or_else(|_| "<unknown>".to_string())).collect())
}

/// Lists MIDI ports, devices per backend and profiles (touches MIDI and audio; not unit-tested).
pub fn gather_inventory(engine_dir: &Path) -> Inventory {
    Inventory {
        midi_ports: midi_port_names(),
        wasapi_devices: audio::list_backend_devices(Backend::WasapiShared),
        asio_devices: audio::list_backend_devices(Backend::Asio),
        asio_available: audio::check_backend_available(Backend::Asio).is_ok(),
        profiles: config::list_profiles(engine_dir),
        flexasio: flexasio::config_path().ok_or_else(|| "USERPROFILE is not set".to_string()).and_then(|p| flexasio::load(&p)),
    }
}

pub fn flexasio_options(inventory: &Inventory) -> Vec<ChoiceOption> {
    let mut options = vec![opt(None, "Windows default output")];
    if let Ok(devices) = &inventory.wasapi_devices {
        for d in devices {
            let label = if d.is_default { format!("{} (default)", d.name) } else { d.name.clone() };
            options.push(ChoiceOption { value: Some(d.name.clone()), label });
        }
    }
    if let Ok(config) = &inventory.flexasio {
        if let Some(v) = &config.output_device {
            if !options.iter().any(|o| o.value.as_deref() == Some(v.as_str())) {
                let label = if v.is_empty() { "No output (device = \"\" in FlexASIO.toml)".to_string() } else { format!("{v} (from FlexASIO.toml)") };
                options.push(ChoiceOption { value: Some(v.clone()), label });
            }
        }
    }
    options
}

impl SetupForm {
    pub fn new(setup: &Setup, inventory: Inventory) -> SetupForm {
        let mut backend = setup.backend.as_deref().and_then(|s| Backend::parse(s).ok()).unwrap_or_default();
        if backend == Backend::Asio && !inventory.asio_available {
            backend = Backend::WasapiShared;
        }

        let mut midi = vec![opt(None, "Auto (first port with SL990)")];
        if let Ok(names) = &inventory.midi_ports {
            for n in names {
                midi.push(opt(Some(n.as_str()), n));
            }
        }
        let midi = with_current(midi, &setup.midi_port);

        let backends: Vec<ChoiceOption> = Backend::ALL
            .iter()
            .filter(|b| **b != Backend::Asio || inventory.asio_available)
            .map(|b| opt(Some(b.name()), b.label()))
            .collect();

        let mut buffers = vec![opt(None, "Device default")];
        for n in BUFFER_CHOICES {
            buffers.push(ChoiceOption { value: Some(n.to_string()), label: format!("{n} frames") });
        }
        let buffer_value = setup.buffer_frames.map(|n| n.to_string());
        let buffers = with_current(buffers, &buffer_value);

        let has_default = inventory.profiles.iter().any(|p| p == "default");
        let mut profiles = Vec::new();
        if !has_default {
            profiles.push(opt(None, "default (built-in sound)"));
        }
        for p in &inventory.profiles {
            profiles.push(opt(Some(p.as_str()), p));
        }
        let profile_value = setup.profile.clone().or_else(|| has_default.then(|| "default".to_string()));
        let profiles = with_current(profiles, &profile_value);

        let flexasio_current = inventory.flexasio.as_ref().ok().and_then(|c| c.output_device.clone());
        let mut transposes = Vec::new();
        for n in -12i32..=12 {
            if n == 0 {
                transposes.push(opt(None, "0 (none)"));
            } else {
                let unit = if n.abs() == 1 { "semitone" } else { "semitones" };
                let label = if n < 0 { format!("{n} {unit}") } else { format!("+{n} {unit}") };
                transposes.push(ChoiceOption { value: Some(n.to_string()), label });
            }
        }
        let transpose_value = setup.transpose.filter(|&n| n != 0).map(|n| n.to_string());
        let transposes = with_current(transposes, &transpose_value);

        let octaves = vec![opt(Some("-2"), "-2 octaves"), opt(Some("-1"), "-1 octave"), opt(None, "0 (none)"), opt(Some("1"), "+1 octave"), opt(Some("2"), "+2 octaves")];
        let octave_value = setup.octave.filter(|&n| n != 0).map(|n| n.to_string());
        let octaves = with_current(octaves, &octave_value);

        let fields = vec![
            Field { key: KEY_MIDI_PORT, section: "MIDI", label: "MIDI input port", help: "The keyboard to listen to. Auto picks the first port whose name contains SL990.", kind: FieldKind::Choice(midi), value: FieldValue::Choice(setup.midi_port.clone()) },
            Field { key: KEY_BACKEND, section: "Audio", label: "Audio backend", help: "WASAPI shared works everywhere; ASIO (FlexASIO) and WASAPI exclusive give lower latency. Exclusive locks the device for other apps.", kind: FieldKind::Choice(backends), value: FieldValue::Choice(Some(backend.name().to_string())) },
            Field { key: KEY_AUDIO_DEVICE, section: "Audio", label: "Output device", help: "The speakers, headphones or ASIO driver for the chosen backend.", kind: FieldKind::Choice(device_options(backend, &inventory, &setup.audio_device)), value: FieldValue::Choice(setup.audio_device.clone()) },
            Field { key: KEY_FLEXASIO_OUTPUT, section: "Audio", label: "FlexASIO output", help: "The speakers, headphones or other Windows output FlexASIO plays to. Save and start and Test sound write it to the [output] device line of %USERPROFILE%\\FlexASIO.toml (the old file is kept as FlexASIO.toml.bak).", kind: FieldKind::Choice(flexasio_options(&inventory)), value: FieldValue::Choice(flexasio_current) },
            Field { key: KEY_BUFFER, section: "Audio", label: "Buffer size", help: "Smaller buffers mean lower latency but may crackle. Device default is the safest.", kind: FieldKind::Choice(buffers), value: FieldValue::Choice(buffer_value) },
            Field { key: KEY_PROFILE, section: "Sound", label: "Sound profile", help: "A file in engine/profiles/. Edit it while playing to tune the sound.", kind: FieldKind::Choice(profiles), value: FieldValue::Choice(profile_value) },
            Field { key: KEY_TRANSPOSE, section: "Sound", label: "Transpose", help: "Shift the sound by semitones. The recording, the coach page and the key strip keep the keys you pressed.", kind: FieldKind::Choice(transposes), value: FieldValue::Choice(transpose_value) },
            Field { key: KEY_OCTAVE, section: "Sound", label: "Octave shift", help: "Shift the sound by whole octaves, added to Transpose.", kind: FieldKind::Choice(octaves), value: FieldValue::Choice(octave_value) },
            Field { key: KEY_METRONOME_ON, section: "Metronome", label: "Metronome on at start", help: "A click in time with the audio; beat 1 is higher. It can also be switched on while playing. Never recorded.", kind: FieldKind::Toggle, value: FieldValue::Toggle(setup.metronome == Some(true)) },
            Field { key: KEY_METRONOME_BPM, section: "Metronome", label: "Tempo (bpm)", help: "Beats per minute, 30 to 300.", kind: FieldKind::Number { min: 30, max: 300 }, value: FieldValue::Number(setup.metronome_bpm.unwrap_or(100) as u32) },
            Field { key: KEY_METRONOME_BEATS, section: "Metronome", label: "Beats per bar", help: "1 to 12; beat 1 gets a higher click.", kind: FieldKind::Number { min: 1, max: 12 }, value: FieldValue::Number(setup.metronome_beats_per_bar.unwrap_or(4) as u32) },
            Field { key: KEY_METRONOME_VOLUME, section: "Metronome", label: "Click volume (%)", help: "0 to 100.", kind: FieldKind::Number { min: 0, max: 100 }, value: FieldValue::Number(setup.metronome_volume.unwrap_or(50) as u32) },
            Field { key: KEY_RECORD, section: "Recording", label: "Record sessions", help: "Save every live session as a .mid file.", kind: FieldKind::Toggle, value: FieldValue::Toggle(setup.record.unwrap_or(true)) },
            Field { key: KEY_RECORD_WAV, section: "Recording", label: "Also record audio (WAV)", help: "Save the session's sound as a .wav next to the .mid (16-bit stereo, about 11 MB per minute). The metronome click is not recorded.", kind: FieldKind::Toggle, value: FieldValue::Toggle(setup.record_wav == Some(true)) },
            Field { key: KEY_RECORD_DIR, section: "Recording", label: "Recording folder", help: "Empty = coach/data/sessions in the repo. A relative path is relative to the engine folder.", kind: FieldKind::Text { hint: "coach/data/sessions".to_string() }, value: FieldValue::Text(setup.record_dir.clone().unwrap_or_default()) },
            Field { key: KEY_WS_ON, section: "Live events", label: "Live event WebSocket", help: "Send notes to the coach page over ws://127.0.0.1:<port>.", kind: FieldKind::Toggle, value: FieldValue::Toggle(setup.ws_port.is_some()) },
            Field { key: KEY_WS_PORT, section: "Live events", label: "WebSocket port", help: "The coach page connects to 8790 by default.", kind: FieldKind::Number { min: 1, max: 65535 }, value: FieldValue::Number(setup.ws_port.unwrap_or(DEFAULT_WS_PORT) as u32) },
        ];
        SetupForm { fields, inventory, initial: setup.clone() }
    }

    /// Swaps in a freshly gathered inventory and rebuilds the MIDI port and audio device choices. The current
    /// selections are kept; one that no longer exists stays selected and is shown as "<value> (not found)".
    pub fn refresh(&mut self, inventory: Inventory) {
        self.inventory = inventory;
        let mut midi = vec![opt(None, "Auto (first port with SL990)")];
        if let Ok(names) = &self.inventory.midi_ports {
            for n in names {
                midi.push(opt(Some(n.as_str()), n));
            }
        }
        let current_midi = self.choice(KEY_MIDI_PORT);
        let current_device = self.choice(KEY_AUDIO_DEVICE);
        let devices = device_options_note(self.backend(), &self.inventory, &current_device, "not found");
        if let Some(f) = self.fields.iter_mut().find(|f| f.key == KEY_MIDI_PORT) {
            f.kind = FieldKind::Choice(with_current_note(midi, &current_midi, "not found"));
        }
        if let Some(f) = self.fields.iter_mut().find(|f| f.key == KEY_AUDIO_DEVICE) {
            f.kind = FieldKind::Choice(devices);
        }
    }

    pub fn field(&self, key: &str) -> Option<&Field> {
        self.fields.iter().find(|f| f.key == key)
    }

    pub fn backend(&self) -> Backend {
        self.choice(KEY_BACKEND).and_then(|v| Backend::parse(&v).ok()).unwrap_or_default()
    }

    pub fn asio_driver(&self) -> Option<String> {
        if self.backend() != Backend::Asio { return None; }
        let devices: &[OutputDeviceInfo] = match &self.inventory.asio_devices { Ok(d) => d, Err(_) => &[] };
        let names: Vec<String> = devices.iter().map(|d| d.name.clone()).collect();
        match self.choice(KEY_AUDIO_DEVICE) {
            None => devices.iter().find(|d| d.is_default).or_else(|| devices.first()).map(|d| d.name.clone()),
            Some(v) => audio::select_output_device(&names, &v).ok().map(|i| names[i].clone()).or(Some(v)),
        }
    }

    fn flexasio_selected(&self) -> bool {
        self.asio_driver().is_some_and(|d| d.to_lowercase().contains("flexasio"))
    }

    pub fn visible(&self, key: &str) -> bool {
        match key {
            KEY_FLEXASIO_OUTPUT => self.flexasio_selected() && matches!(&self.inventory.flexasio, Ok(c) if c.uses_wasapi()),
            _ => true,
        }
    }

    pub fn audio_note(&self) -> Option<String> {
        if self.backend() != Backend::Asio { return None; }
        let driver = self.asio_driver()?;
        if driver.to_lowercase().contains("asio4all") {
            return Some("ASIO4ALL picks its output (speakers, headphones) in its own panel: open it from the ASIO4ALL icon in the taskbar tray while the engine plays.".to_string());
        }
        if !self.flexasio_selected() { return None; }
        match &self.inventory.flexasio {
            Err(e) => Some(format!("Cannot read FlexASIO.toml ({e}); FlexASIO keeps its current output.")),
            Ok(c) if !c.uses_wasapi() => {
                let b = c.backend.clone().unwrap_or_default();
                let d = c.output_device.clone().unwrap_or_else(|| "its default".to_string());
                Some(format!("FlexASIO uses the backend \"{b}\" (output: {d}); this list covers only Windows WASAPI outputs, so change the [output] device in %USERPROFILE%\\FlexASIO.toml by hand."))
            }
            Ok(_) => None,
        }
    }

    /// The output to write to FlexASIO.toml: Some(None) removes the device line (Windows default), Some(Some(d)) sets it,
    /// None when nothing should be written.
    pub fn flexasio_output(&self) -> Option<Option<String>> {
        if self.visible(KEY_FLEXASIO_OUTPUT) { Some(self.choice(KEY_FLEXASIO_OUTPUT)) } else { None }
    }

    pub fn set(&mut self, key: &str, value: FieldValue) {
        let backend_changed = key == KEY_BACKEND && self.field(key).map(|f| &f.value) != Some(&value);
        if let Some(f) = self.fields.iter_mut().find(|f| f.key == key) {
            f.value = value;
        }
        if backend_changed {
            let mut initial_backend = self.initial.backend.as_deref().and_then(|s| Backend::parse(s).ok()).unwrap_or_default();
            if initial_backend == Backend::Asio && !self.inventory.asio_available {
                initial_backend = Backend::WasapiShared;
            }
            let device = if self.backend() == initial_backend { self.initial.audio_device.clone() } else { None };
            let options = device_options(self.backend(), &self.inventory, &device);
            if let Some(f) = self.fields.iter_mut().find(|f| f.key == KEY_AUDIO_DEVICE) {
                f.kind = FieldKind::Choice(options);
                f.value = FieldValue::Choice(device);
            }
        }
    }

    pub fn enabled(&self, key: &str) -> bool {
        match key {
            KEY_RECORD_DIR | KEY_RECORD_WAV => self.toggle(KEY_RECORD),
            KEY_WS_PORT => self.toggle(KEY_WS_ON),
            _ => true,
        }
    }

    fn choice(&self, key: &str) -> Option<String> {
        match self.field(key).map(|f| &f.value) {
            Some(FieldValue::Choice(v)) => v.clone(),
            _ => None,
        }
    }

    fn toggle(&self, key: &str) -> bool {
        matches!(self.field(key).map(|f| &f.value), Some(FieldValue::Toggle(true)))
    }

    fn text(&self, key: &str) -> String {
        match self.field(key).map(|f| &f.value) {
            Some(FieldValue::Text(t)) => t.clone(),
            _ => String::new(),
        }
    }

    fn number(&self, key: &str) -> u32 {
        match self.field(key).map(|f| &f.value) {
            Some(FieldValue::Number(n)) => *n,
            _ => 0,
        }
    }

    pub fn to_setup(&self) -> Result<Setup, String> {
        let buffer_frames = match self.choice(KEY_BUFFER) {
            None => None,
            Some(v) => {
                let n: u32 = v.trim().parse().map_err(|_| format!("buffer_frames must be a whole number, got {v}"))?;
                if !(16..=8192).contains(&n) {
                    return Err(format!("buffer_frames must be between 16 and 8192, got {n}"));
                }
                Some(n)
            }
        };
        let ws_port = if self.toggle(KEY_WS_ON) {
            let n = self.number(KEY_WS_PORT);
            if !(1..=65535).contains(&n) {
                return Err(format!("ws_port must be between 1 and 65535, got {n}"));
            }
            Some(n as u16)
        } else {
            None
        };
        let record = if !self.toggle(KEY_RECORD) { Some(false) } else if self.initial.record == Some(true) { Some(true) } else { None };
        let record_wav = if self.toggle(KEY_RECORD_WAV) { Some(true) } else if self.initial.record_wav.is_some() { Some(false) } else { None };
        let dir = self.text(KEY_RECORD_DIR);
        let record_dir = if dir.trim().is_empty() { None } else { Some(dir.trim().to_string()) };
        let backend = self.choice(KEY_BACKEND).filter(|b| !(self.initial.backend.is_none() && b == Backend::default().name()));
        let profile = self.choice(KEY_PROFILE).filter(|p| !(self.initial.profile.is_none() && p == "default"));
        let shift = |key: &str, max: i8| -> Result<Option<i8>, String> {
            match self.choice(key) {
                None => Ok(None),
                Some(v) => {
                    let n: i8 = v.trim().parse().map_err(|_| format!("{key} must be a whole number, got {v}"))?;
                    if !(-max..=max).contains(&n) {
                        return Err(format!("{key} must be between -{max} and {max}, got {n}"));
                    }
                    Ok(Some(n))
                }
            }
        };
        let transpose = shift(KEY_TRANSPOSE, 12)?;
        let octave = shift(KEY_OCTAVE, 2)?;
        let metronome = if self.toggle(KEY_METRONOME_ON) { Some(true) } else if self.initial.metronome.is_some() { Some(false) } else { None };
        let num = |key: &str, unset: bool, default: u32, min: u32, max: u32, name: &str| -> Result<Option<u32>, String> {
            let n = self.number(key);
            if !(min..=max).contains(&n) {
                return Err(format!("{name} must be between {min} and {max}, got {n}"));
            }
            Ok(Some(n).filter(|v| !(unset && *v == default)))
        };
        Ok(Setup {
            midi_port: self.choice(KEY_MIDI_PORT),
            audio_device: self.choice(KEY_AUDIO_DEVICE),
            buffer_frames,
            profile,
            transpose,
            octave,
            metronome,
            metronome_bpm: num(KEY_METRONOME_BPM, self.initial.metronome_bpm.is_none(), 100, 30, 300, "metronome_bpm")?.map(|n| n as u16),
            metronome_beats_per_bar: num(KEY_METRONOME_BEATS, self.initial.metronome_beats_per_bar.is_none(), 4, 1, 12, "metronome_beats_per_bar")?.map(|n| n as u8),
            metronome_volume: num(KEY_METRONOME_VOLUME, self.initial.metronome_volume.is_none(), 50, 0, 100, "metronome_volume")?.map(|n| n as u8),
            backend,
            ws_port,
            record,
            record_wav,
            record_dir,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dev(name: &str, is_default: bool) -> OutputDeviceInfo {
        OutputDeviceInfo { name: name.to_string(), is_default }
    }

    fn inventory() -> Inventory {
        Inventory {
            midi_ports: Ok(vec!["Microsoft GS".to_string(), "SL990 MIDI".to_string()]),
            wasapi_devices: Ok(vec![dev("Speakers", true), dev("Headphones", false)]),
            asio_devices: Ok(vec![dev("FlexASIO", false)]),
            asio_available: true,
            profiles: vec!["default".to_string(), "sl990".to_string()],
            flexasio: Ok(FlexAsioConfig { backend: Some("Windows WASAPI".into()), output_device: Some("Speakers".into()) }),
        }
    }

    fn labels(form: &SetupForm, key: &str) -> Vec<String> {
        match &form.field(key).unwrap().kind {
            FieldKind::Choice(o) => o.iter().map(|o| o.label.clone()).collect(),
            other => panic!("{other:?}"),
        }
    }

    fn values(form: &SetupForm, key: &str) -> Vec<Option<String>> {
        match &form.field(key).unwrap().kind {
            FieldKind::Choice(o) => o.iter().map(|o| o.value.clone()).collect(),
            other => panic!("{other:?}"),
        }
    }

    fn value(form: &SetupForm, key: &str) -> FieldValue {
        form.field(key).unwrap().value.clone()
    }

    #[test]
    fn fields_from_default_setup() {
        let form = SetupForm::new(&Setup::default(), inventory());
        let keys: Vec<&str> = form.fields.iter().map(|f| f.key).collect();
        assert_eq!(keys, vec!["midi_port", "backend", "audio_device", "flexasio_output", "buffer_frames", "profile", "transpose", "octave", "metronome", "metronome_bpm", "metronome_beats_per_bar", "metronome_volume", "record", "record_wav", "record_dir", "ws_on", "ws_port"]);
        assert_eq!(labels(&form, KEY_MIDI_PORT), vec!["Auto (first port with SL990)", "Microsoft GS", "SL990 MIDI"]);
        assert_eq!(value(&form, KEY_MIDI_PORT), FieldValue::Choice(None));
        assert_eq!(values(&form, KEY_BACKEND), vec![Some("wasapi".to_string()), Some("asio".to_string()), Some("wasapi-exclusive".to_string())]);
        assert_eq!(value(&form, KEY_BACKEND), FieldValue::Choice(Some("wasapi".to_string())));
        assert_eq!(labels(&form, KEY_AUDIO_DEVICE), vec!["Default", "Speakers (default)", "Headphones"]);
        assert_eq!(labels(&form, KEY_BUFFER), vec!["Device default", "32 frames", "64 frames", "128 frames", "256 frames", "512 frames", "1024 frames"]);
        assert_eq!(labels(&form, KEY_PROFILE), vec!["default", "sl990"]);
        assert_eq!(value(&form, KEY_PROFILE), FieldValue::Choice(Some("default".to_string())));
        assert_eq!(value(&form, KEY_RECORD), FieldValue::Toggle(true));
        assert_eq!(value(&form, KEY_RECORD_DIR), FieldValue::Text(String::new()));
        assert_eq!(value(&form, KEY_WS_ON), FieldValue::Toggle(false));
        assert_eq!(value(&form, KEY_WS_PORT), FieldValue::Number(8790));
        assert_eq!(form.to_setup(), Ok(Setup::default()));
    }

    #[test]
    fn values_from_setup_ron_are_kept() {
        let setup = Setup {
            midi_port: Some("SL990 MIDI".into()),
            audio_device: Some("2".into()),
            buffer_frames: Some(100),
            ws_port: Some(9000),
            record: Some(false),
            record_dir: Some("takes".into()),
            profile: Some("sl990".into()),
            ..Setup::default()
        };
        let form = SetupForm::new(&setup, inventory());
        assert_eq!(labels(&form, KEY_AUDIO_DEVICE).last().unwrap(), "2 (from setup.ron)");
        assert_eq!(labels(&form, KEY_BUFFER).last().unwrap(), "100 (from setup.ron)");
        assert_eq!(labels(&form, KEY_MIDI_PORT).len(), 3);
        assert_eq!(form.to_setup(), Ok(setup.clone()));
    }

    #[test]
    fn backend_change_resets_device() {
        let setup = Setup { audio_device: Some("Headphones".into()), ..Setup::default() };
        let mut form = SetupForm::new(&setup, inventory());
        form.set(KEY_BACKEND, FieldValue::Choice(Some("wasapi".into())));
        assert_eq!(value(&form, KEY_AUDIO_DEVICE), FieldValue::Choice(Some("Headphones".into())));
        form.set(KEY_BACKEND, FieldValue::Choice(Some("asio".into())));
        assert_eq!(form.backend(), Backend::Asio);
        assert_eq!(labels(&form, KEY_AUDIO_DEVICE), vec!["Default", "FlexASIO"]);
        assert_eq!(value(&form, KEY_AUDIO_DEVICE), FieldValue::Choice(None));
        form.set(KEY_BACKEND, FieldValue::Choice(Some("wasapi-exclusive".into())));
        assert_eq!(labels(&form, KEY_AUDIO_DEVICE), vec!["Default", "Speakers (default)", "Headphones"]);
    }

    #[test]
    fn backend_round_trip_restores_initial_device() {
        let setup = Setup { audio_device: Some("Headphones".into()), ..Setup::default() };
        let mut form = SetupForm::new(&setup, inventory());
        form.set(KEY_BACKEND, FieldValue::Choice(Some("wasapi-exclusive".into())));
        assert_eq!(value(&form, KEY_AUDIO_DEVICE), FieldValue::Choice(None));
        form.set(KEY_BACKEND, FieldValue::Choice(Some("wasapi".into())));
        assert_eq!(value(&form, KEY_AUDIO_DEVICE), FieldValue::Choice(Some("Headphones".into())));
    }

    #[test]
    fn record_wav_field() {
        let mut form = SetupForm::new(&Setup::default(), inventory());
        assert_eq!(form.to_setup().unwrap().record_wav, None);
        form.set(KEY_RECORD_WAV, FieldValue::Toggle(true));
        assert_eq!(form.to_setup().unwrap().record_wav, Some(true));
        let setup = Setup { record_wav: Some(false), ..Setup::default() };
        assert_eq!(SetupForm::new(&setup, inventory()).to_setup().unwrap().record_wav, Some(false));
        form.set(KEY_RECORD, FieldValue::Toggle(false));
        assert!(!form.enabled(KEY_RECORD_WAV));
    }

    #[test]
    fn record_some_true_is_kept() {
        let setup = Setup { record: Some(true), ..Setup::default() };
        let mut form = SetupForm::new(&setup, inventory());
        assert_eq!(form.to_setup().unwrap().record, Some(true));
        form.set(KEY_RECORD, FieldValue::Toggle(false));
        assert_eq!(form.to_setup().unwrap().record, Some(false));
        assert_eq!(SetupForm::new(&Setup::default(), inventory()).to_setup().unwrap().record, None);
    }

    #[test]
    fn to_setup_backend_changes_and_explicit_values() {
        let mut form = SetupForm::new(&Setup::default(), inventory());
        form.set(KEY_BACKEND, FieldValue::Choice(Some("asio".into())));
        assert_eq!(form.to_setup().unwrap().backend, Some("asio".to_string()));
        let setup = Setup { backend: Some("wasapi".into()), profile: Some("default".into()), ..Setup::default() };
        assert_eq!(SetupForm::new(&setup, inventory()).to_setup(), Ok(setup));
    }

    #[test]
    fn refresh_keeps_and_rebuilds_choices() {
        let setup = Setup { midi_port: Some("SL990 MIDI".into()), audio_device: Some("Headphones".into()), ..Setup::default() };
        let mut form = SetupForm::new(&setup, inventory());
        let mut inv2 = inventory();
        inv2.midi_ports = Ok(vec!["SL990 MIDI".to_string(), "New Port".to_string()]);
        inv2.wasapi_devices = Ok(vec![dev("Speakers", true), dev("USB DAC", false)]);
        form.refresh(inv2);
        assert_eq!(labels(&form, KEY_MIDI_PORT), vec!["Auto (first port with SL990)", "SL990 MIDI", "New Port"]);
        assert_eq!(value(&form, KEY_MIDI_PORT), FieldValue::Choice(Some("SL990 MIDI".into())));
        assert_eq!(labels(&form, KEY_AUDIO_DEVICE), vec!["Default", "Speakers (default)", "USB DAC", "Headphones (not found)"]);
        assert_eq!(value(&form, KEY_AUDIO_DEVICE), FieldValue::Choice(Some("Headphones".into())));
    }

    #[test]
    fn asio_hidden_when_not_built() {
        let mut inv = inventory();
        inv.asio_available = false;
        let setup = Setup { backend: Some("asio".into()), ..Setup::default() };
        let form = SetupForm::new(&setup, inv);
        assert_eq!(values(&form, KEY_BACKEND), vec![Some("wasapi".to_string()), Some("wasapi-exclusive".to_string())]);
        assert_eq!(value(&form, KEY_BACKEND), FieldValue::Choice(Some("wasapi".to_string())));
    }

    #[test]
    fn to_setup_collects_every_field() {
        let mut form = SetupForm::new(&Setup::default(), inventory());
        form.set(KEY_MIDI_PORT, FieldValue::Choice(Some("SL990 MIDI".into())));
        form.set(KEY_BUFFER, FieldValue::Choice(Some("128".into())));
        form.set(KEY_TRANSPOSE, FieldValue::Choice(Some("-2".into())));
        form.set(KEY_OCTAVE, FieldValue::Choice(Some("1".into())));
        form.set(KEY_METRONOME_ON, FieldValue::Toggle(true));
        form.set(KEY_METRONOME_BPM, FieldValue::Number(72));
        form.set(KEY_METRONOME_BEATS, FieldValue::Number(3));
        form.set(KEY_METRONOME_VOLUME, FieldValue::Number(40));
        form.set(KEY_RECORD, FieldValue::Toggle(false));
        form.set(KEY_RECORD_WAV, FieldValue::Toggle(true));
        form.set(KEY_RECORD_DIR, FieldValue::Text("  D:/takes  ".into()));
        form.set(KEY_WS_ON, FieldValue::Toggle(true));
        form.set(KEY_WS_PORT, FieldValue::Number(8791));
        assert_eq!(form.to_setup(), Ok(Setup {
            midi_port: Some("SL990 MIDI".into()),
            audio_device: None,
            buffer_frames: Some(128),
            profile: None,
            transpose: Some(-2),
            octave: Some(1),
            metronome: Some(true),
            metronome_bpm: Some(72),
            metronome_beats_per_bar: Some(3),
            metronome_volume: Some(40),
            backend: None,
            ws_port: Some(8791),
            record: Some(false),
            record_wav: Some(true),
            record_dir: Some("D:/takes".into()),
        }));
    }

    #[test]
    fn transpose_fields() {
        let form = SetupForm::new(&Setup::default(), inventory());
        assert_eq!(labels(&form, KEY_OCTAVE), vec!["-2 octaves", "-1 octave", "0 (none)", "+1 octave", "+2 octaves"]);
        assert_eq!(labels(&form, KEY_TRANSPOSE).len(), 25);
        assert_eq!(value(&form, KEY_TRANSPOSE), FieldValue::Choice(None));
        assert_eq!(value(&form, KEY_OCTAVE), FieldValue::Choice(None));
        let setup = Setup { transpose: Some(5), ..Setup::default() };
        let form = SetupForm::new(&setup, inventory());
        assert_eq!(value(&form, KEY_TRANSPOSE), FieldValue::Choice(Some("5".to_string())));
        assert_eq!(form.to_setup().unwrap().transpose, Some(5));
    }

    #[test]
    fn zero_transpose_and_octave_have_no_duplicate_choice() {
        let setup = Setup { transpose: Some(0), octave: Some(0), ..Setup::default() };
        let form = SetupForm::new(&setup, inventory());
        for key in [KEY_TRANSPOSE, KEY_OCTAVE] {
            assert!(labels(&form, key).iter().all(|l| !l.contains("from setup.ron")));
            assert_eq!(value(&form, key), FieldValue::Choice(None));
        }
        assert_eq!(labels(&form, KEY_TRANSPOSE).len(), 25);
        assert_eq!(labels(&form, KEY_OCTAVE).len(), 5);
    }

    #[test]
    fn metronome_fields() {
        let mut form = SetupForm::new(&Setup::default(), inventory());
        assert_eq!(value(&form, KEY_METRONOME_ON), FieldValue::Toggle(false));
        assert_eq!(value(&form, KEY_METRONOME_BPM), FieldValue::Number(100));
        assert_eq!(value(&form, KEY_METRONOME_BEATS), FieldValue::Number(4));
        assert_eq!(value(&form, KEY_METRONOME_VOLUME), FieldValue::Number(50));
        let s = form.to_setup().unwrap();
        assert_eq!((s.metronome, s.metronome_bpm, s.metronome_beats_per_bar, s.metronome_volume), (None, None, None, None));
        form.set(KEY_METRONOME_BPM, FieldValue::Number(72));
        assert_eq!(form.to_setup().unwrap().metronome_bpm, Some(72));
        form.set(KEY_METRONOME_BPM, FieldValue::Number(100));
        form.set(KEY_METRONOME_ON, FieldValue::Toggle(true));
        assert_eq!(form.to_setup().unwrap().metronome, Some(true));
        form.set(KEY_METRONOME_ON, FieldValue::Toggle(false));
        assert_eq!(form.to_setup().unwrap().metronome, None);
        form.set(KEY_METRONOME_BPM, FieldValue::Number(20));
        assert!(form.to_setup().unwrap_err().contains("metronome_bpm"));
        let loaded = Setup { metronome: Some(false), metronome_bpm: Some(100), ..Setup::default() };
        let form = SetupForm::new(&loaded, inventory());
        let s = form.to_setup().unwrap();
        assert_eq!((s.metronome, s.metronome_bpm), (Some(false), Some(100)));
    }

    #[test]
    fn bad_numbers_are_errors() {
        let mut form = SetupForm::new(&Setup::default(), inventory());
        form.set(KEY_WS_PORT, FieldValue::Number(0));
        assert!(form.to_setup().is_ok());
        form.set(KEY_WS_ON, FieldValue::Toggle(true));
        assert!(form.to_setup().unwrap_err().contains("ws_port"));
        form.set(KEY_WS_PORT, FieldValue::Number(70000));
        assert!(form.to_setup().unwrap_err().contains("ws_port"));
        form.set(KEY_WS_PORT, FieldValue::Number(8790));
        form.set(KEY_BUFFER, FieldValue::Choice(Some("8".into())));
        assert!(form.to_setup().unwrap_err().contains("buffer_frames"));
    }

    #[test]
    fn enabled_follows_toggles() {
        let mut form = SetupForm::new(&Setup::default(), inventory());
        assert!(form.enabled(KEY_RECORD_DIR));
        assert!(form.enabled(KEY_RECORD_WAV));
        assert!(!form.enabled(KEY_WS_PORT));
        assert!(form.enabled(KEY_MIDI_PORT));
        form.set(KEY_RECORD, FieldValue::Toggle(false));
        assert!(!form.enabled(KEY_RECORD_DIR));
        assert!(!form.enabled(KEY_RECORD_WAV));
        form.set(KEY_WS_ON, FieldValue::Toggle(true));
        assert!(form.enabled(KEY_WS_PORT));
    }

    #[test]
    fn empty_inventory() {
        let inv = Inventory {
            midi_ports: Err("no MIDI".into()),
            wasapi_devices: Err("no audio".into()),
            asio_devices: Err("not in this build".into()),
            asio_available: false,
            profiles: Vec::new(),
            flexasio: Err("USERPROFILE is not set".into()),
        };
        let form = SetupForm::new(&Setup::default(), inv);
        assert_eq!(labels(&form, KEY_MIDI_PORT), vec!["Auto (first port with SL990)"]);
        assert_eq!(labels(&form, KEY_AUDIO_DEVICE), vec!["Default"]);
        assert_eq!(labels(&form, KEY_PROFILE), vec!["default (built-in sound)"]);
        assert_eq!(value(&form, KEY_PROFILE), FieldValue::Choice(None));
        assert_eq!(form.to_setup().unwrap().profile, None);
    }

    #[test]
    fn flexasio_field_only_for_flexasio() {
        let mut form = SetupForm::new(&Setup::default(), inventory());
        assert!(!form.visible(KEY_FLEXASIO_OUTPUT));
        assert_eq!(form.audio_note(), None);
        assert_eq!(form.flexasio_output(), None);
        form.set(KEY_BACKEND, FieldValue::Choice(Some("asio".into())));
        assert!(form.visible(KEY_FLEXASIO_OUTPUT));
        assert_eq!(labels(&form, KEY_FLEXASIO_OUTPUT), vec!["Windows default output", "Speakers (default)", "Headphones"]);
        assert_eq!(value(&form, KEY_FLEXASIO_OUTPUT), FieldValue::Choice(Some("Speakers".to_string())));
        assert_eq!(form.flexasio_output(), Some(Some("Speakers".to_string())));
        assert_eq!(form.audio_note(), None);
        form.set(KEY_FLEXASIO_OUTPUT, FieldValue::Choice(Some("Headphones".into())));
        assert_eq!(form.flexasio_output(), Some(Some("Headphones".to_string())));
        assert_eq!(form.to_setup(), Ok(Setup { backend: Some("asio".to_string()), ..Setup::default() }));
        form.set(KEY_FLEXASIO_OUTPUT, FieldValue::Choice(None));
        assert_eq!(form.flexasio_output(), Some(None));
    }

    #[test]
    fn flexasio_current_not_in_list() {
        let mut inv = inventory();
        inv.flexasio = Ok(FlexAsioConfig { backend: None, output_device: Some("Speakers 2 (USB)".into()) });
        let form = SetupForm::new(&Setup { backend: Some("asio".into()), ..Setup::default() }, inv);
        assert_eq!(labels(&form, KEY_FLEXASIO_OUTPUT).last().unwrap(), "Speakers 2 (USB) (from FlexASIO.toml)");
        assert_eq!(value(&form, KEY_FLEXASIO_OUTPUT), FieldValue::Choice(Some("Speakers 2 (USB)".into())));

        let mut inv = inventory();
        inv.flexasio = Ok(FlexAsioConfig { backend: None, output_device: Some(String::new()) });
        let form = SetupForm::new(&Setup::default(), inv);
        assert_eq!(labels(&form, KEY_FLEXASIO_OUTPUT).last().unwrap(), "No output (device = \"\" in FlexASIO.toml)");

        let mut inv = inventory();
        inv.flexasio = Ok(FlexAsioConfig { backend: None, output_device: None });
        let form = SetupForm::new(&Setup::default(), inv);
        assert_eq!(value(&form, KEY_FLEXASIO_OUTPUT), FieldValue::Choice(None));
    }

    #[test]
    fn asio4all_gets_a_note() {
        let mut inv = inventory();
        inv.asio_devices = Ok(vec![dev("ASIO4ALL v2", false), dev("FlexASIO", true)]);
        let setup = Setup { backend: Some("asio".into()), audio_device: Some("ASIO4ALL v2".into()), ..Setup::default() };
        let mut form = SetupForm::new(&setup, inv);
        assert!(!form.visible(KEY_FLEXASIO_OUTPUT));
        let note = form.audio_note().unwrap();
        assert!(note.contains("ASIO4ALL") && note.contains("tray"));
        assert_eq!(form.flexasio_output(), None);
        form.set(KEY_AUDIO_DEVICE, FieldValue::Choice(Some("FlexASIO".into())));
        assert!(form.visible(KEY_FLEXASIO_OUTPUT));
        assert_eq!(form.audio_note(), None);
        form.set(KEY_AUDIO_DEVICE, FieldValue::Choice(None));
        assert_eq!(form.asio_driver(), Some("FlexASIO".to_string()));
        form.set(KEY_AUDIO_DEVICE, FieldValue::Choice(Some("0".into())));
        assert_eq!(form.asio_driver(), Some("ASIO4ALL v2".to_string()));
    }

    #[test]
    fn flexasio_other_backend_note() {
        let mut inv = inventory();
        inv.flexasio = Ok(FlexAsioConfig { backend: Some("Windows WDM-KS".into()), output_device: Some("Speakers 1 (Realtek HD Audio output with HAP)".into()) });
        let form = SetupForm::new(&Setup { backend: Some("asio".into()), ..Setup::default() }, inv);
        assert!(!form.visible(KEY_FLEXASIO_OUTPUT));
        assert_eq!(form.flexasio_output(), None);
        let note = form.audio_note().unwrap();
        assert!(note.contains("Windows WDM-KS") && note.contains("Speakers 1") && note.contains("FlexASIO.toml"));
    }

    #[test]
    fn flexasio_unreadable_note() {
        let mut inv = inventory();
        inv.flexasio = Err("bad".into());
        let form = SetupForm::new(&Setup { backend: Some("asio".into()), ..Setup::default() }, inv);
        assert!(!form.visible(KEY_FLEXASIO_OUTPUT));
        assert!(form.audio_note().unwrap().starts_with("Cannot read FlexASIO.toml"));
    }

    #[test]
    fn other_asio_driver_no_note() {
        let mut inv = inventory();
        inv.asio_devices = Ok(vec![dev("Realtek ASIO", true)]);
        let form = SetupForm::new(&Setup { backend: Some("asio".into()), ..Setup::default() }, inv);
        assert!(!form.visible(KEY_FLEXASIO_OUTPUT));
        assert_eq!(form.audio_note(), None);
    }
}
