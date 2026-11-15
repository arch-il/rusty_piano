//! Metronome: a click generated on the audio thread and counted in samples, so it stays exactly in time with the sound; a control handle for the UI and WebSocket threads.

use std::sync::mpsc::{sync_channel, Receiver, SyncSender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const MIN_BPM: u16 = 30;
pub const MAX_BPM: u16 = 300;
pub const MAX_BEATS_PER_BAR: u8 = 12;
pub const MAX_COUNT_IN_BARS: u8 = 8;
pub const DEFAULT_BPM: u16 = 100;
pub const DEFAULT_BEATS_PER_BAR: u8 = 4;
pub const DEFAULT_VOLUME: u8 = 50;
pub const COMMAND_QUEUE: usize = 32;
pub const NOTICE_QUEUE: usize = 64;
pub const CLICK_SECONDS: f64 = 0.030;
pub const ACCENT_HZ: f32 = 1600.0;
pub const BEAT_HZ: f32 = 1000.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MetronomeSettings {
    pub on: bool,
    pub bpm: u16,
    pub beats_per_bar: u8,
    pub volume: u8,
}

impl Default for MetronomeSettings {
    fn default() -> Self {
        MetronomeSettings {
            on: false,
            bpm: DEFAULT_BPM,
            beats_per_bar: DEFAULT_BEATS_PER_BAR,
            volume: DEFAULT_VOLUME,
        }
    }
}

impl MetronomeSettings {
    pub fn clamped(self) -> Self {
        MetronomeSettings {
            on: self.on,
            bpm: self.bpm.clamp(MIN_BPM, MAX_BPM),
            beats_per_bar: self.beats_per_bar.clamp(1, MAX_BEATS_PER_BAR),
            volume: self.volume.min(100),
        }
    }

    pub fn describe(&self) -> String {
        format!(
            "{} bpm, {} beats per bar, volume {} %",
            self.bpm, self.beats_per_bar, self.volume
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Command {
    Start,
    Stop,
    Tempo { bpm: u16, beats_per_bar: u8 },
    Volume(u8),
    CountIn { bars: u8, keep: bool },
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Tick {
    pub at: Instant,
    pub beat: u8,
    pub bar: u32,
    pub count_in: bool,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Notice {
    Tick(Tick),
    CountInDone { at: Instant, keep: bool },
}

pub struct Metronome {
    sample_rate: f64,
    bpm: u16,
    beats_per_bar: u8,
    volume: u8,
    commands: Receiver<Command>,
    notices: SyncSender<Notice>,
    running: bool,
    pos: u64,
    next_beat: f64,
    interval: f64,
    beat_index: u8,
    bar: u32,
    count_in_active: bool,
    count_in_left: u32,
    count_in_keep: bool,
    click_active: bool,
    click_start: u64,
    click_freq: f32,
    click_amp: f32,
}

impl Metronome {
    pub fn new(
        sample_rate: u32,
        settings: MetronomeSettings,
        commands: Receiver<Command>,
        notices: SyncSender<Notice>,
    ) -> Metronome {
        let s = settings.clamped();
        let sr = sample_rate as f64;
        Metronome {
            sample_rate: sr,
            bpm: s.bpm,
            beats_per_bar: s.beats_per_bar,
            volume: s.volume,
            commands,
            notices,
            running: s.on,
            pos: 0,
            next_beat: 0.0,
            interval: sr * 60.0 / s.bpm as f64,
            beat_index: 0,
            bar: 1,
            count_in_active: false,
            count_in_left: 0,
            count_in_keep: false,
            click_active: false,
            click_start: 0,
            click_freq: BEAT_HZ,
            click_amp: 0.0,
        }
    }

    fn apply(&mut self, command: Command) {
        match command {
            Command::Start => {
                self.running = true;
                self.count_in_active = false;
                self.beat_index = 0;
                self.bar = 1;
                self.next_beat = self.pos as f64;
            }
            Command::Stop => {
                self.running = false;
                self.count_in_active = false;
            }
            Command::Tempo { bpm, beats_per_bar } => {
                self.bpm = bpm;
                self.beats_per_bar = beats_per_bar;
                let new_interval = self.sample_rate * 60.0 / bpm as f64;
                if self.running {
                    let last = self.next_beat - self.interval;
                    self.next_beat = (last + new_interval).max(self.pos as f64);
                }
                self.interval = new_interval;
                if self.beat_index >= beats_per_bar {
                    self.beat_index = 0;
                    self.bar += 1;
                }
            }
            Command::Volume(v) => self.volume = v,
            Command::CountIn { bars, keep } => {
                self.running = true;
                self.count_in_active = true;
                self.count_in_left = bars as u32 * self.beats_per_bar as u32;
                self.count_in_keep = keep;
                self.beat_index = 0;
                self.bar = 1;
                self.next_beat = self.pos as f64;
            }
        }
    }

    pub fn process(
        &mut self,
        left: &mut [f32],
        right: &mut [f32],
        block_start: Instant,
        offset_frames: usize,
    ) {
        while let Ok(c) = self.commands.try_recv() {
            self.apply(c);
        }
        let n = left.len().min(right.len());
        for i in 0..n {
            let f = self.pos + i as u64;
            if self.running && f as f64 >= self.next_beat {
                let at = block_start
                    + Duration::from_secs_f64((offset_frames + i) as f64 / self.sample_rate);
                let mut play = true;
                if self.count_in_active && self.count_in_left == 0 {
                    let keep = self.count_in_keep;
                    let _ = self.notices.try_send(Notice::CountInDone { at, keep });
                    self.count_in_active = false;
                    if keep {
                        self.beat_index = 0;
                        self.bar = 1;
                    } else {
                        self.running = false;
                        play = false;
                    }
                }
                if play {
                    let accent = self.beat_index == 0;
                    self.click_active = true;
                    self.click_start = f;
                    self.click_freq = if accent { ACCENT_HZ } else { BEAT_HZ };
                    self.click_amp =
                        self.volume as f32 / 100.0 * if accent { 0.5 } else { 0.35 };
                    let _ = self.notices.try_send(Notice::Tick(Tick {
                        at,
                        beat: self.beat_index + 1,
                        bar: self.bar,
                        count_in: self.count_in_active,
                    }));
                    if self.count_in_active {
                        self.count_in_left -= 1;
                    }
                    self.beat_index += 1;
                    if self.beat_index >= self.beats_per_bar {
                        self.beat_index = 0;
                        self.bar += 1;
                    }
                    self.next_beat += self.interval;
                }
            }
            if self.click_active {
                let t = (f - self.click_start) as f64 / self.sample_rate;
                if t >= CLICK_SECONDS {
                    self.click_active = false;
                } else {
                    let s = self.click_amp as f64
                        * (-t / 0.006).exp()
                        * (2.0 * std::f64::consts::PI * self.click_freq as f64 * t).sin();
                    let s = s as f32;
                    left[i] = (left[i] + s).clamp(-1.0, 1.0);
                    right[i] = (right[i] + s).clamp(-1.0, 1.0);
                }
            }
        }
        self.pos += n as u64;
    }
}

pub type Listener = Arc<dyn Fn(&MetronomeSettings) + Send + Sync>;

struct Inner {
    settings: MetronomeSettings,
    commands: Option<SyncSender<Command>>,
    pending: Option<SyncSender<Command>>,
    requested_on: bool,
    listener: Option<Listener>,
    attached: bool,
}

#[derive(Clone)]
pub struct MetronomeHandle {
    inner: Arc<Mutex<Inner>>,
}

impl MetronomeHandle {
    pub fn new(settings: MetronomeSettings) -> Self {
        MetronomeHandle {
            inner: Arc::new(Mutex::new(Inner {
                settings: MetronomeSettings {
                    on: false,
                    ..settings.clamped()
                },
                commands: None,
                pending: None,
                requested_on: settings.on,
                listener: None,
                attached: false,
            })),
        }
    }

    pub fn settings(&self) -> MetronomeSettings {
        self.inner.lock().unwrap().settings
    }

    pub fn attach(&self, sample_rate: u32) -> (Metronome, Receiver<Notice>) {
        let (ctx, crx) = sync_channel(COMMAND_QUEUE);
        let (ntx, nrx) = sync_channel(NOTICE_QUEUE);
        let mut inner = self.inner.lock().unwrap();
        inner.pending = Some(ctx);
        let requested = MetronomeSettings {
            on: inner.requested_on,
            ..inner.settings
        };
        let m = Metronome::new(sample_rate, requested, crx, ntx);
        (m, nrx)
    }

    pub fn confirm_attached(&self) {
        let (new, old, listener) = {
            let mut inner = self.inner.lock().unwrap();
            if inner.pending.is_none() {
                return;
            }
            let old = inner.settings;
            inner.commands = inner.pending.take();
            inner.attached = true;
            inner.settings.on = inner.requested_on;
            (inner.settings, old, inner.listener.clone())
        };
        if new != old {
            if let Some(l) = listener {
                l(&new);
            }
        }
    }

    pub fn set_listener(&self, f: Listener) {
        self.inner.lock().unwrap().listener = Some(f);
    }

    pub fn clear_listener(&self) {
        self.inner.lock().unwrap().listener = None;
    }

    fn change(&self, edit: impl FnOnce(&mut MetronomeSettings) -> Option<Command>) {
        let (new, old, listener) = {
            let mut inner = self.inner.lock().unwrap();
            let old = inner.settings;
            if !inner.attached {
                inner.settings.on = inner.requested_on;
            }
            let command = edit(&mut inner.settings);
            if !inner.attached {
                inner.requested_on = inner.settings.on;
            }
            inner.settings = inner.settings.clamped();
            if !inner.attached {
                inner.settings.on = false;
            }
            if let (Some(c), Some(tx)) = (command, inner.commands.as_ref()) {
                let _ = tx.try_send(c);
            }
            (inner.settings, old, inner.listener.clone())
        };
        if new != old {
            if let Some(l) = listener {
                l(&new);
            }
        }
    }

    pub fn start(&self) {
        self.change(|s| {
            s.on = true;
            Some(Command::Start)
        });
    }

    pub fn stop(&self) {
        self.change(|s| {
            s.on = false;
            Some(Command::Stop)
        });
    }

    pub fn set_bpm(&self, bpm: u16) {
        self.set_tempo(Some(bpm), None);
    }

    pub fn set_beats_per_bar(&self, beats_per_bar: u8) {
        self.set_tempo(None, Some(beats_per_bar));
    }

    pub fn set_tempo(&self, bpm: Option<u16>, beats_per_bar: Option<u8>) {
        self.change(|s| {
            if let Some(b) = bpm {
                s.bpm = b;
            }
            if let Some(b) = beats_per_bar {
                s.beats_per_bar = b;
            }
            let c = s.clamped();
            Some(Command::Tempo {
                bpm: c.bpm,
                beats_per_bar: c.beats_per_bar,
            })
        });
    }

    pub fn set_volume(&self, volume: u8) {
        self.change(|s| {
            s.volume = volume;
            Some(Command::Volume(volume.min(100)))
        });
    }

    pub fn count_in(&self, bars: u8, keep: bool) {
        let bars = bars.clamp(1, MAX_COUNT_IN_BARS);
        self.change(|s| {
            s.on = true;
            Some(Command::CountIn { bars, keep })
        });
    }

    pub fn mark_stopped(&self) {
        self.change(|s| {
            s.on = false;
            None
        });
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClientCommand {
    Start {
        bpm: Option<u16>,
        beats_per_bar: Option<u8>,
    },
    Stop,
    Tempo {
        bpm: Option<u16>,
        beats_per_bar: Option<u8>,
    },
    CountIn {
        bars: u8,
        keep: bool,
        bpm: Option<u16>,
        beats_per_bar: Option<u8>,
    },
}

const MAX_COMMAND_BYTES: usize = 4096;

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Val {
    Str(String),
    Int(i64),
    Other,
}

fn skip_ws(b: &[u8], i: &mut usize) {
    while *i < b.len() && matches!(b[*i], b' ' | b'\t' | b'\r' | b'\n') {
        *i += 1;
    }
}

fn parse_string(text: &str, i: &mut usize) -> Option<String> {
    let b = text.as_bytes();
    if b.get(*i) != Some(&b'"') {
        return None;
    }
    let start = *i + 1;
    let mut j = start;
    while j < b.len() && b[j] != b'"' {
        if b[j] == b'\\' {
            return None;
        }
        j += 1;
    }
    if j >= b.len() {
        return None;
    }
    let s = text.get(start..j)?.to_string();
    *i = j + 1;
    Some(s)
}

fn parse_value(text: &str, i: &mut usize) -> Option<Val> {
    let b = text.as_bytes();
    match *b.get(*i)? {
        b'"' => parse_string(text, i).map(Val::Str),
        b'-' | b'0'..=b'9' => {
            let start = *i;
            if b[*i] == b'-' {
                *i += 1;
            }
            let digits = *i;
            while *i < b.len() && b[*i].is_ascii_digit() {
                *i += 1;
            }
            if *i == digits || *i - digits > 15 {
                return None;
            }
            if matches!(b.get(*i), Some(b'.') | Some(b'e') | Some(b'E')) {
                return None;
            }
            text.get(start..*i)?.parse::<i64>().ok().map(Val::Int)
        }
        _ => {
            for lit in ["true", "false", "null"] {
                if text.get(*i..)?.starts_with(lit) {
                    *i += lit.len();
                    return Some(Val::Other);
                }
            }
            None
        }
    }
}

pub(crate) fn parse_object(text: &str) -> Option<Vec<(String, Val)>> {
    if text.len() > MAX_COMMAND_BYTES {
        return None;
    }
    let b = text.as_bytes();
    let mut i = 0;
    let mut out: Vec<(String, Val)> = Vec::new();
    skip_ws(b, &mut i);
    if b.get(i) != Some(&b'{') {
        return None;
    }
    i += 1;
    skip_ws(b, &mut i);
    if b.get(i) == Some(&b'}') {
        i += 1;
    } else {
        loop {
            skip_ws(b, &mut i);
            let key = parse_string(text, &mut i)?;
            skip_ws(b, &mut i);
            if b.get(i) != Some(&b':') {
                return None;
            }
            i += 1;
            skip_ws(b, &mut i);
            let val = parse_value(text, &mut i)?;
            out.retain(|(k, _)| *k != key);
            out.push((key, val));
            skip_ws(b, &mut i);
            match b.get(i) {
                Some(b',') => i += 1,
                Some(b'}') => {
                    i += 1;
                    break;
                }
                _ => return None,
            }
        }
    }
    skip_ws(b, &mut i);
    if i != b.len() {
        return None;
    }
    Some(out)
}

pub(crate) fn get<'a>(obj: &'a [(String, Val)], key: &str) -> Option<&'a Val> {
    obj.iter().find(|(k, _)| k == key).map(|(_, v)| v)
}

fn opt_int(obj: &[(String, Val)], key: &str, lo: i64, hi: i64) -> Option<Option<i64>> {
    match get(obj, key) {
        None => Some(None),
        Some(Val::Int(n)) if *n >= lo && *n <= hi => Some(Some(*n)),
        _ => None,
    }
}

pub fn parse_command(text: &str) -> Option<ClientCommand> {
    let obj = parse_object(text)?;
    let kind = match get(&obj, "type")? {
        Val::Str(s) => s.as_str(),
        _ => return None,
    };
    let bpm = opt_int(&obj, "bpm", MIN_BPM as i64, MAX_BPM as i64)?.map(|n| n as u16);
    let beats_per_bar =
        opt_int(&obj, "beats_per_bar", 1, MAX_BEATS_PER_BAR as i64)?.map(|n| n as u8);
    match kind {
        "metronome_start" => Some(ClientCommand::Start { bpm, beats_per_bar }),
        "metronome_stop" => Some(ClientCommand::Stop),
        "metronome_tempo" => {
            if bpm.is_none() && beats_per_bar.is_none() {
                return None;
            }
            Some(ClientCommand::Tempo { bpm, beats_per_bar })
        }
        "count_in" => {
            let bars = opt_int(&obj, "bars", 1, MAX_COUNT_IN_BARS as i64)?.unwrap_or(1) as u8;
            let keep = match get(&obj, "then") {
                None => false,
                Some(Val::Str(s)) if s == "stop" => false,
                Some(Val::Str(s)) if s == "keep" => true,
                _ => return None,
            };
            Some(ClientCommand::CountIn {
                bars,
                keep,
                bpm,
                beats_per_bar,
            })
        }
        _ => None,
    }
}

impl MetronomeHandle {
    pub fn apply(&self, cmd: ClientCommand) {
        match cmd {
            ClientCommand::Start { bpm, beats_per_bar } => {
                if bpm.is_some() || beats_per_bar.is_some() {
                    self.set_tempo(bpm, beats_per_bar);
                }
                self.start();
            }
            ClientCommand::Stop => self.stop(),
            ClientCommand::Tempo { bpm, beats_per_bar } => self.set_tempo(bpm, beats_per_bar),
            ClientCommand::CountIn {
                bars,
                keep,
                bpm,
                beats_per_bar,
            } => {
                if bpm.is_some() || beats_per_bar.is_some() {
                    self.set_tempo(bpm, beats_per_bar);
                }
                self.count_in(bars, keep);
            }
        }
    }
}

pub fn beat_json(t_ms: u64, tick: &Tick) -> String {
    format!(
        "{{\"type\":\"beat\",\"t\":{},\"beat\":{},\"bar\":{},\"count_in\":{}}}",
        t_ms, tick.beat, tick.bar, tick.count_in
    )
}

pub fn state_json(s: &MetronomeSettings) -> String {
    format!(
        "{{\"type\":\"metronome\",\"on\":{},\"bpm\":{},\"beats_per_bar\":{},\"volume\":{}}}",
        s.on, s.bpm, s.beats_per_bar, s.volume
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: u32 = 48000;

    #[test]
    fn parse_commands() {
        assert_eq!(
            parse_command(r#"{"type":"metronome_start"}"#),
            Some(ClientCommand::Start {
                bpm: None,
                beats_per_bar: None
            })
        );
        assert_eq!(
            parse_command(
                r#" { "type" : "metronome_start", "bpm": 96, "beats_per_bar": 3, "extra": "x" } "#
            ),
            Some(ClientCommand::Start {
                bpm: Some(96),
                beats_per_bar: Some(3)
            })
        );
        assert_eq!(
            parse_command(r#"{"type":"metronome_stop"}"#),
            Some(ClientCommand::Stop)
        );
        assert_eq!(
            parse_command(r#"{"type":"metronome_tempo","bpm":72}"#),
            Some(ClientCommand::Tempo {
                bpm: Some(72),
                beats_per_bar: None
            })
        );
        assert_eq!(
            parse_command(r#"{"type":"count_in"}"#),
            Some(ClientCommand::CountIn {
                bars: 1,
                keep: false,
                bpm: None,
                beats_per_bar: None
            })
        );
        assert_eq!(
            parse_command(r#"{"type":"count_in","bars":2,"then":"keep","bpm":80}"#),
            Some(ClientCommand::CountIn {
                bars: 2,
                keep: true,
                bpm: Some(80),
                beats_per_bar: None
            })
        );
    }

    #[test]
    fn parse_rejects_malformed() {
        let long = "a".repeat(5000);
        let backslashed = format!("{{\"type\":\"metro{}u006eome_stop\"}}", '\u{5c}');
        let cases: Vec<&str> = vec![
            "",
            "not json",
            "[1]",
            r#"{"type":"metronome_start","bpm":10}"#,
            r#"{"type":"metronome_start","bpm":0}"#,
            r#"{"type":"metronome_start","beats_per_bar":0}"#,
            r#"{"type":"metronome_start","bpm":"fast"}"#,
            r#"{"type":"metronome_start","bpm":1.5}"#,
            r#"{"type":"metronome_tempo"}"#,
            r#"{"type":"count_in","bars":9}"#,
            r#"{"type":"count_in","then":"later"}"#,
            r#"{"type":"nope"}"#,
            r#"{"bpm":100}"#,
            r#"{"type":"metronome_start","x":{"a":1}}"#,
            r#"{"type":"metronome_stop"} x"#,
            &backslashed,
            &long,
        ];
        for c in cases {
            assert_eq!(parse_command(c), None, "{}", &c[..c.len().min(60)]);
        }
    }

    #[test]
    fn apply_commands() {
        let handle = MetronomeHandle::new(MetronomeSettings::default());
        let (_m, _rx) = handle.attach(SR);
        handle.confirm_attached();
        handle.apply(ClientCommand::Start {
            bpm: Some(120),
            beats_per_bar: Some(3),
        });
        let s = handle.settings();
        assert_eq!((s.on, s.bpm, s.beats_per_bar), (true, 120, 3));
        handle.apply(ClientCommand::Tempo {
            bpm: None,
            beats_per_bar: Some(5),
        });
        assert_eq!(handle.settings().beats_per_bar, 5);
        handle.apply(ClientCommand::Stop);
        assert!(!handle.settings().on);
        handle.apply(ClientCommand::CountIn {
            bars: 2,
            keep: true,
            bpm: None,
            beats_per_bar: None,
        });
        assert!(handle.settings().on);
    }

    #[test]
    fn new_with_on_reports_off_before_attach() {
        let handle = MetronomeHandle::new(MetronomeSettings {
            on: true,
            ..MetronomeSettings::default()
        });
        assert!(!handle.settings().on);
    }

    #[test]
    fn attach_without_confirm_keeps_start_off() {
        let handle = MetronomeHandle::new(MetronomeSettings::default());
        let (_m, _rx) = handle.attach(SR);
        handle.start();
        assert!(!handle.settings().on);
        handle.confirm_attached();
        handle.start();
        assert!(handle.settings().on);
    }

    #[test]
    fn requested_on_reports_only_after_confirm() {
        let handle = MetronomeHandle::new(MetronomeSettings {
            on: true,
            ..MetronomeSettings::default()
        });
        let seen: Arc<Mutex<Vec<MetronomeSettings>>> = Arc::new(Mutex::new(Vec::new()));
        let s2 = seen.clone();
        handle.set_listener(Arc::new(move |s| s2.lock().unwrap().push(*s)));
        let (_m, _rx) = handle.attach(SR);
        assert!(!handle.settings().on);
        assert!(seen.lock().unwrap().is_empty());
        handle.confirm_attached();
        assert!(handle.settings().on);
        assert_eq!(seen.lock().unwrap().len(), 1);
        assert!(seen.lock().unwrap()[0].on);
    }

    #[test]
    fn tempo_edit_before_attach_keeps_requested_on() {
        let handle = MetronomeHandle::new(MetronomeSettings {
            on: true,
            ..MetronomeSettings::default()
        });
        handle.set_bpm(100);
        let (_m, _rx) = handle.attach(SR);
        handle.confirm_attached();
        assert!(handle.settings().on);
        assert_eq!(handle.settings().bpm, 100);
    }

    #[test]
    fn stop_before_attach_wins_over_new_on() {
        let handle = MetronomeHandle::new(MetronomeSettings {
            on: true,
            ..MetronomeSettings::default()
        });
        handle.stop();
        let (_m, _rx) = handle.attach(SR);
        handle.confirm_attached();
        assert!(!handle.settings().on);
    }

    #[test]
    fn start_before_attach_applies_on_confirm() {
        let handle = MetronomeHandle::new(MetronomeSettings::default());
        handle.start();
        assert!(!handle.settings().on);
        let (_m, _rx) = handle.attach(SR);
        handle.confirm_attached();
        assert!(handle.settings().on);
    }

    #[test]
    fn confirm_without_attach_does_nothing() {
        let handle = MetronomeHandle::new(MetronomeSettings::default());
        handle.confirm_attached();
        handle.start();
        assert!(!handle.settings().on);
    }

    #[test]
    fn unattached_handle_never_reports_on() {
        let handle = MetronomeHandle::new(MetronomeSettings::default());
        handle.apply(ClientCommand::Start {
            bpm: Some(120),
            beats_per_bar: None,
        });
        assert!(!handle.settings().on);
        assert_eq!(handle.settings().bpm, 120);
        let (_m, _rx) = handle.attach(SR);
        handle.confirm_attached();
        handle.apply(ClientCommand::Start {
            bpm: None,
            beats_per_bar: None,
        });
        assert!(handle.settings().on);
    }

    #[test]
    fn out_of_range_values_never_reach_audio_unclamped() {
        let handle = MetronomeHandle::new(MetronomeSettings::default());
        let (mut m, _rx) = handle.attach(SR);
        handle.confirm_attached();
        handle.apply(ClientCommand::Start {
            bpm: Some(0),
            beats_per_bar: Some(0),
        });
        handle.apply(ClientCommand::CountIn {
            bars: 0,
            keep: false,
            bpm: Some(0),
            beats_per_bar: Some(200),
        });
        let s = handle.settings();
        assert_eq!((s.bpm, s.beats_per_bar), (MIN_BPM, MAX_BEATS_PER_BAR));
        let mut l = vec![0.0f32; 512];
        let mut r = vec![0.0f32; 512];
        m.process(&mut l, &mut r, Instant::now(), 0);
        assert_eq!(m.bpm, MIN_BPM);
        assert_eq!(m.beats_per_bar, MAX_BEATS_PER_BAR);
        assert!(m.interval.is_finite());
    }

    #[test]
    fn json_messages() {
        let tick = Tick {
            at: Instant::now(),
            beat: 1,
            bar: 1,
            count_in: false,
        };
        assert_eq!(
            beat_json(1000, &tick),
            r#"{"type":"beat","t":1000,"beat":1,"bar":1,"count_in":false}"#
        );
        let s = MetronomeSettings {
            on: true,
            bpm: 100,
            beats_per_bar: 4,
            volume: 50,
        };
        assert_eq!(
            state_json(&s),
            r#"{"type":"metronome","on":true,"bpm":100,"beats_per_bar":4,"volume":50}"#
        );
    }

    fn run(m: &mut Metronome, base: Instant, done: &mut usize, frames: usize) -> Vec<f32> {
        let mut out = Vec::new();
        let mut left_frames = frames;
        while left_frames > 0 {
            let n = left_frames.min(256);
            let mut l = vec![0.0f32; n];
            let mut r = vec![0.0f32; n];
            m.process(&mut l, &mut r, base, *done);
            out.extend_from_slice(&l);
            *done += n;
            left_frames -= n;
        }
        out
    }

    fn settings(on: bool, bpm: u16, volume: u8) -> MetronomeSettings {
        MetronomeSettings {
            on,
            bpm,
            beats_per_bar: 4,
            volume,
        }
    }

    fn ticks(rx: &Receiver<Notice>) -> Vec<Notice> {
        rx.try_iter().collect()
    }

    fn crossings(s: &[f32]) -> usize {
        s.windows(2).filter(|w| w[0] * w[1] < 0.0).count()
    }

    #[test]
    fn clicks_on_every_beat_at_120_bpm() {
        let handle = MetronomeHandle::new(settings(true, 120, 100));
        let (mut m, rx) = handle.attach(SR);
        handle.confirm_attached();
        let base = Instant::now();
        let mut done = 0;
        let out = run(&mut m, base, &mut done, 3 * SR as usize);
        let t: Vec<Tick> = ticks(&rx)
            .into_iter()
            .map(|n| match n {
                Notice::Tick(t) => t,
                _ => panic!("unexpected notice"),
            })
            .collect();
        assert_eq!(t.len(), 6);
        let beats: Vec<u8> = t.iter().map(|x| x.beat).collect();
        let bars: Vec<u32> = t.iter().map(|x| x.bar).collect();
        assert_eq!(beats, vec![1, 2, 3, 4, 1, 2]);
        assert_eq!(bars, vec![1, 1, 1, 1, 2, 2]);
        for (k, tick) in t.iter().enumerate() {
            let ms = (tick.at - base).as_secs_f64() * 1000.0;
            assert!((ms - k as f64 * 500.0).abs() < 0.1, "tick {k} at {ms}");
            let start = k * 24000;
            assert!(out[start..start + 96].iter().any(|s| s.abs() > 0.01));
            let quiet_from = start + 1920;
            let end = (start + 24000).min(out.len());
            assert!(out[quiet_from..end].iter().all(|s| s.abs() < 1e-6));
        }
    }

    #[test]
    fn accent_is_higher_than_other_beats() {
        let handle = MetronomeHandle::new(settings(true, 120, 100));
        let (mut m, _rx) = handle.attach(SR);
        handle.confirm_attached();
        let base = Instant::now();
        let mut done = 0;
        let out = run(&mut m, base, &mut done, 30000);
        let accent = crossings(&out[0..960]);
        let other = crossings(&out[24000..24960]);
        assert!(accent > other, "{accent} vs {other}");
    }

    #[test]
    fn volume_scales_and_zero_is_silent_but_ticks() {
        let base = Instant::now();
        let handle = MetronomeHandle::new(settings(true, 120, 0));
        let (mut m, rx) = handle.attach(SR);
        handle.confirm_attached();
        let mut done = 0;
        let out = run(&mut m, base, &mut done, 36000);
        assert!(out.iter().all(|s| *s == 0.0));
        assert_eq!(ticks(&rx).len(), 2);

        let peak = |v: u8| {
            let handle = MetronomeHandle::new(settings(true, 120, v));
            let (mut m, _rx) = handle.attach(SR);
            handle.confirm_attached();
            let mut done = 0;
            let out = run(&mut m, base, &mut done, 2000);
            out.iter().fold(0.0f32, |a, s| a.max(s.abs()))
        };
        let ratio = peak(50) / peak(100);
        assert!(ratio > 0.45 && ratio < 0.55, "{ratio}");
    }

    #[test]
    fn adds_to_existing_audio() {
        let handle = MetronomeHandle::new(settings(true, 120, 100));
        let (mut m, _rx) = handle.attach(SR);
        handle.confirm_attached();
        let base = Instant::now();
        let mut l = vec![0.25f32; 2000];
        let mut r = vec![0.25f32; 2000];
        m.process(&mut l, &mut r, base, 0);
        assert!(l.iter().any(|s| (*s - 0.25).abs() > 0.01));
        assert!(l[1920..].iter().all(|s| *s == 0.25));
        assert!(r[1920..].iter().all(|s| *s == 0.25));
    }

    #[test]
    fn stop_and_start_commands() {
        let handle = MetronomeHandle::new(settings(false, 120, 100));
        let (mut m, rx) = handle.attach(SR);
        handle.confirm_attached();
        let base = Instant::now();
        let mut done = 0;
        let out = run(&mut m, base, &mut done, 1024);
        assert!(out.iter().all(|s| *s == 0.0));
        assert!(ticks(&rx).is_empty());

        handle.start();
        let out = run(&mut m, base, &mut done, 256);
        assert!(out.iter().any(|s| s.abs() > 0.01));
        let t = ticks(&rx);
        assert_eq!(t.len(), 1);
        match t[0] {
            Notice::Tick(tick) => {
                assert_eq!((tick.beat, tick.bar), (1, 1));
                let ms = (tick.at - base).as_secs_f64() * 1000.0;
                assert!((ms - 1024.0 / 48.0).abs() < 0.1, "{ms}");
            }
            _ => panic!("expected tick"),
        }

        handle.stop();
        run(&mut m, base, &mut done, 3 * SR as usize);
        assert!(ticks(&rx).is_empty());
    }

    #[test]
    fn tempo_change_applies_from_next_beat() {
        let handle = MetronomeHandle::new(settings(true, 120, 100));
        let (mut m, rx) = handle.attach(SR);
        handle.confirm_attached();
        let base = Instant::now();
        let mut done = 0;
        run(&mut m, base, &mut done, 12000);
        assert_eq!(ticks(&rx).len(), 1);
        handle.set_bpm(60);
        run(&mut m, base, &mut done, 60000);
        let t = ticks(&rx);
        match t[0] {
            Notice::Tick(tick) => {
                let ms = (tick.at - base).as_secs_f64() * 1000.0;
                assert!((ms - 1000.0).abs() < 0.1, "{ms}");
            }
            _ => panic!("expected tick"),
        }
    }

    #[test]
    fn count_in_then_stop() {
        let handle = MetronomeHandle::new(settings(false, 120, 100));
        let (mut m, rx) = handle.attach(SR);
        handle.confirm_attached();
        let base = Instant::now();
        let mut done = 0;
        handle.count_in(1, false);
        run(&mut m, base, &mut done, 3 * SR as usize);
        let n = ticks(&rx);
        assert_eq!(n.len(), 5);
        for (k, notice) in n.iter().take(4).enumerate() {
            match notice {
                Notice::Tick(t) => {
                    assert!(t.count_in);
                    assert_eq!(t.beat as usize, k + 1);
                    assert_eq!(t.bar, 1);
                }
                _ => panic!("expected tick"),
            }
        }
        match n[4] {
            Notice::CountInDone { at, keep } => {
                assert!(!keep);
                let ms = (at - base).as_secs_f64() * 1000.0;
                assert!((ms - 2000.0).abs() < 0.1, "{ms}");
            }
            _ => panic!("expected done"),
        }
        assert!(handle.settings().on);
        handle.mark_stopped();
        assert!(!handle.settings().on);
    }

    #[test]
    fn count_in_then_keep() {
        let handle = MetronomeHandle::new(settings(false, 120, 100));
        let (mut m, rx) = handle.attach(SR);
        handle.confirm_attached();
        let base = Instant::now();
        let mut done = 0;
        handle.count_in(1, true);
        run(&mut m, base, &mut done, 3 * SR as usize);
        let n = ticks(&rx);
        assert!(n.len() >= 7);
        for notice in n.iter().take(4) {
            match notice {
                Notice::Tick(t) => assert!(t.count_in),
                _ => panic!("expected tick"),
            }
        }
        match n[4] {
            Notice::CountInDone { at, keep } => {
                assert!(keep);
                assert!(((at - base).as_secs_f64() * 1000.0 - 2000.0).abs() < 0.1);
            }
            _ => panic!("expected done"),
        }
        match n[5] {
            Notice::Tick(t) => {
                assert_eq!((t.bar, t.beat, t.count_in), (1, 1, false));
                assert!(((t.at - base).as_secs_f64() * 1000.0 - 2000.0).abs() < 0.1);
            }
            _ => panic!("expected tick"),
        }
        match n[6] {
            Notice::Tick(t) => {
                assert_eq!(t.beat, 2);
                assert!(((t.at - base).as_secs_f64() * 1000.0 - 2500.0).abs() < 0.1);
            }
            _ => panic!("expected tick"),
        }
    }

    #[test]
    fn handle_notifies_listener_on_change() {
        let handle = MetronomeHandle::new(MetronomeSettings::default());
        let (_m, _rx) = handle.attach(SR);
        handle.confirm_attached();
        let seen: Arc<Mutex<Vec<MetronomeSettings>>> = Arc::new(Mutex::new(Vec::new()));
        let s2 = seen.clone();
        handle.set_listener(Arc::new(move |s| s2.lock().unwrap().push(*s)));
        handle.set_bpm(90);
        assert_eq!(seen.lock().unwrap().len(), 1);
        assert_eq!(seen.lock().unwrap()[0].bpm, 90);
        handle.set_bpm(90);
        assert_eq!(seen.lock().unwrap().len(), 1);
        handle.start();
        assert!(seen.lock().unwrap().last().unwrap().on);
        handle.stop();
        assert!(!seen.lock().unwrap().last().unwrap().on);
    }

    #[test]
    fn settings_are_clamped() {
        let handle = MetronomeHandle::new(settings(false, 10, 50));
        assert_eq!(handle.settings().bpm, 30);
        handle.set_bpm(1000);
        assert_eq!(handle.settings().bpm, 300);
        handle.set_beats_per_bar(0);
        assert_eq!(handle.settings().beats_per_bar, 1);
        handle.set_volume(200);
        assert_eq!(handle.settings().volume, 100);
    }
}
