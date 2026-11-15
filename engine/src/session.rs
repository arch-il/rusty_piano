//! One live session: MIDI input to audio output, recording, live profile reload and the live event WebSocket.
//! Console live mode (main.rs) and the setup window both use it, so they start and stop the engine the same way.
use crate::audio::{self, Attach, AudioOutput, Backend};
use crate::config;
use crate::live::{self, LiveServer};
use crate::metronome::{self, MetronomeHandle, MetronomeSettings, Notice};
use crate::midi::{self, MidiEvent};
use crate::prompt::{self, PromptHandle};
use crate::record::{self, RecordSender, Recorder, SaveResult};
use crate::setup::Startup;
use crate::sound;
use crate::transpose::{TransposeControl, Transposer};
use crate::wav_record::{self, WavRecorder, WavResult, WavStopper};
use std::path::PathBuf;
use std::sync::mpsc::{Receiver, SyncSender};
use std::sync::Arc;
use std::time::{Duration, Instant};

pub const PORT_HINT: &str = "plug in the SL990 (USB) or choose a port with --port <index|name> or midi_port in engine/setup.ron; use --list to see ports.";

#[derive(Debug, Clone, PartialEq)]
pub struct AudioInfo {
    pub backend: Backend,
    pub device_name: String,
    pub sample_rate: u32,
    pub buffer_frames: Option<u32>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SessionInfo {
    pub port_index: usize,
    pub port_name: String,
    pub audio: Option<AudioInfo>,
    pub profile_name: String,
    pub recording: Option<PathBuf>,
    pub recording_wav: Option<PathBuf>,
    pub ws_url: Option<String>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SessionError {
    pub message: String,
    pub hint: Option<String>,
}

pub struct Session {
    connection: midir::MidiInputConnection<()>,
    audio: Option<AudioOutput>,
    live: Option<LiveServer>,
    recorder: Option<Recorder>,
    wav: Option<WavRecorder>,
    transpose: Arc<TransposeControl>,
    metronome: MetronomeHandle,
    pub info: SessionInfo,
}

#[derive(Debug, Clone, PartialEq)]
pub struct StopReport {
    pub midi: Option<SaveResult>,
    pub wav: Option<WavResult>,
}

impl StopReport {
    pub fn lines(&self) -> Vec<String> {
        let mut v = Vec::new();
        if let Some(m) = &self.midi {
            v.push(save_message(m));
        }
        if let Some(w) = &self.wav {
            v.push(wav_record::save_message(w));
        }
        v
    }
}

pub fn finish_recordings(midi: Option<SaveResult>, wav: Option<WavResult>) -> StopReport {
    let mut wav = wav;
    if let (Some(Ok(None)), Some(Ok(s))) = (&midi, &wav) {
        let _ = std::fs::remove_file(&s.path);
        wav = None;
    }
    StopReport { midi, wav }
}

#[derive(Clone)]
pub struct StopHandles {
    pub record: Option<RecordSender>,
    pub wav: Option<WavStopper>,
}

impl StopHandles {
    pub fn save_now(&self, timeout: Duration) -> Vec<String> {
        let deadline = Instant::now() + timeout;
        let midi = match self.record.as_ref().map(|r| r.flush(timeout)) {
            Some(Err(e)) if e == "recorder already stopped" => None,
            other => other,
        };
        let mut timed_out = false;
        let wav = match &self.wav {
            Some(s) => {
                if let Some(Ok(None)) = &midi {
                    s.discard();
                }
                let left = deadline.saturating_duration_since(Instant::now());
                let r = s.finish_now(left);
                timed_out = r.is_none();
                if r.is_some() && !s.claim_report() {
                    None
                } else {
                    r
                }
            }
            None => None,
        };
        let mut lines = finish_recordings(midi, wav).lines();
        if timed_out {
            lines.push("warning: audio recording did not finish in time".to_string());
        }
        lines
    }
}

/// Prints a line, ignoring a closed pipe (for example `--play file | head`).
pub fn say(line: &str) {
    use std::io::Write;
    let _ = writeln!(std::io::stdout().lock(), "{line}");
}

pub fn ms_since(epoch: Instant, at: Instant) -> u64 {
    at.saturating_duration_since(epoch).as_millis() as u64
}

pub fn command_handler(handle: MetronomeHandle, prompt: PromptHandle) -> live::CommandHandler {
    Arc::new(move |text: &str| {
        if let Some(cmd) = metronome::parse_command(text) {
            handle.apply(cmd);
        } else if let Some(cmd) = prompt::parse_command(text) {
            prompt.apply(cmd);
        }
    })
}

pub fn connect_prompt(prompt: &PromptHandle, sender: live::LiveSender) {
    prompt.set_reply(Arc::new(move |t: String| {
        sender.send_text(t);
    }));
}

pub fn connect_state(handle: &MetronomeHandle, sender: live::LiveSender) {
    let s = sender.clone();
    handle.set_listener(Arc::new(move |st: &MetronomeSettings| {
        s.send_state(metronome::state_json(st));
    }));
    sender.send_state(metronome::state_json(&handle.settings()));
}

pub fn spawn_bridge(
    handle: MetronomeHandle,
    notices: Receiver<Notice>,
    live: Option<live::LiveSender>,
    epoch: Instant,
) -> std::thread::JoinHandle<()> {
    std::thread::Builder::new()
        .name("metronome-events".to_string())
        .spawn(move || {
            for n in notices {
                match n {
                    Notice::Tick(t) => {
                        if let Some(l) = &live {
                            l.send_text(metronome::beat_json(ms_since(epoch, t.at), &t));
                        }
                    }
                    Notice::CountInDone { keep: false, .. } => handle.mark_stopped(),
                    Notice::CountInDone { keep: true, .. } => {}
                }
            }
        })
        .expect("spawn metronome-events thread")
}

pub fn start_live(startup: &Startup, source: live::Source) -> Option<LiveServer> {
    start_live_with(startup, source, None)
}

pub fn start_live_with(
    startup: &Startup,
    source: live::Source,
    handler: Option<live::CommandHandler>,
) -> Option<LiveServer> {
    let port = startup.ws_port?;
    match live::LiveServer::start_with_handler(port, source, handler) {
        Ok(server) => {
            say(&format!("Live events: {} (WebSocket)", server.url()));
            Some(server)
        }
        Err(e) => {
            eprintln!("warning: cannot start the live event WebSocket on 127.0.0.1:{port}: {e}; continuing without it.");
            None
        }
    }
}

pub fn print_audio_info(a: &AudioOutput) {
    say(&a.describe());
    if let Some(n) = &a.buffer_note {
        say(&format!("note: {n}"));
    }
}

pub fn start_live_tuning(startup: &Startup, a: &AudioOutput) {
    if let Some(path) = &startup.profile_path {
        config::spawn_profile_watcher(path.clone(), startup.profile.kind(), a.profile_sender());
        say(&format!(
            "Live tuning: edit {} and save; changes apply within about 0.5 s.",
            path.display()
        ));
    }
}

pub fn save_message(result: &SaveResult) -> String {
    match result {
        Ok(Some((p, n))) => format!("Saved session: {} ({n} events)", p.display()),
        Ok(None) => "No notes played; nothing recorded.".to_string(),
        Err(e) => format!("warning: recording failed: {e}"),
    }
}

/// (label, value) rows for the setup window's status view.
pub fn status_lines(info: &SessionInfo) -> Vec<(String, String)> {
    let audio = match &info.audio {
        Some(a) => format!("{}: {}", a.backend.label(), a.device_name),
        None => "no sound (see the console)".to_string(),
    };
    let buffer = match &info.audio {
        Some(a) => match a.buffer_frames {
            Some(n) => format!(
                "{n} frames, {:.1} ms at {} Hz",
                audio::latency_ms(n, a.sample_rate),
                a.sample_rate
            ),
            None => format!("device default (size unknown), {} Hz", a.sample_rate),
        },
        None => "-".to_string(),
    };
    vec![
        ("MIDI input".to_string(), format!("[{}] {}", info.port_index, info.port_name)),
        ("Audio".to_string(), audio),
        ("Buffer".to_string(), buffer),
        ("Profile".to_string(), info.profile_name.clone()),
        (
            "Recording".to_string(),
            info.recording
                .as_ref()
                .map(|p| p.display().to_string())
                .unwrap_or_else(|| "off".to_string()),
        ),
        (
            "Audio recording".to_string(),
            info.recording_wav
                .as_ref()
                .map(|p| p.display().to_string())
                .unwrap_or_else(|| "off".to_string()),
        ),
        (
            "WebSocket".to_string(),
            info.ws_url.clone().unwrap_or_else(|| "off".to_string()),
        ),
    ]
}

impl Session {
    /// Starts the session like console live mode and prints the same lines. tap gets every MIDI event (try_send, never blocks).
    pub fn start(startup: &Startup, tap: Option<SyncSender<MidiEvent>>) -> Result<Session, SessionError> {
        let mut midi_in = midir::MidiInput::new("rusty_piano").map_err(|e| SessionError {
            message: format!("cannot open MIDI system: {e}"),
            hint: None,
        })?;
        midi_in.ignore(midir::Ignore::All);
        let ports = midi_in.ports();
        let names: Vec<String> = ports
            .iter()
            .map(|port| midi_in.port_name(port).unwrap_or_else(|_| "<unknown>".to_string()))
            .collect();
        let index = midi::select_port(&names, startup.port.as_deref()).map_err(|e| SessionError {
            message: e.to_string(),
            hint: Some(PORT_HINT.to_string()),
        })?;
        let mut warnings = Vec::new();

        let metronome = MetronomeHandle::new(MetronomeSettings { on: false, ..startup.metronome });
        let prompt = PromptHandle::new();
        let mut notices: Option<Receiver<Notice>> = None;
        let profile = startup.profile;
        let audio = match AudioOutput::start(
            startup.backend,
            startup.audio_device.as_deref(),
            startup.buffer,
            move |sr| sound::build_engine(sr, &profile),
        ) {
            Ok(a) => {
                print_audio_info(&a);
                start_live_tuning(startup, &a);
                let (m, rx) = metronome.attach(a.sample_rate);
                if a.attach(Attach::Metronome(Box::new(m))) {
                    notices = Some(rx);
                } else {
                    eprintln!("warning: cannot attach the metronome to the audio output; no click.");
                    warnings.push("cannot attach the metronome; no click".to_string());
                }
                let player = prompt.attach(a.sample_rate, &profile);
                if !a.attach(Attach::Prompt(Box::new(player))) {
                    eprintln!("warning: cannot attach the ear-training player; the page will use a browser tone.");
                    warnings.push("cannot attach the ear-training player; the page will use a browser tone.".to_string());
                }
                Some(a)
            }
            Err(e) => {
                eprintln!("error: cannot open audio output: {e}");
                eprintln!("warning: continuing without sound (MIDI events are still printed); use --list to see audio devices, --audio-device <index|name> to pick one, or --backend wasapi for the default backend.");
                warnings.push(format!("cannot open audio output: {e}; playing without sound"));
                None
            }
        };
        let audio_info = audio.as_ref().map(|a| AudioInfo {
            backend: a.backend,
            device_name: a.device_name.clone(),
            sample_rate: a.sample_rate,
            buffer_frames: a.buffer_frames,
        });
        let tx = audio.as_ref().map(|a| a.sender());

        let mut recording = None;
        let recorder = if !startup.record {
            println!("Recording off (--no-record or record: Some(false) in engine/setup.ron).");
            None
        } else {
            let dir = &startup.record_dir;
            match std::fs::create_dir_all(dir) {
                Ok(()) => {
                    let secs = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_secs())
                        .unwrap_or(0);
                    let path = dir.join(record::session_file_name(secs));
                    println!("Recording to {}", path.display());
                    recording = Some(path.clone());
                    Some(Recorder::start(path))
                }
                Err(e) => {
                    eprintln!(
                        "warning: cannot create recording folder {}: {e}; this session is not recorded.",
                        dir.display()
                    );
                    warnings.push(format!(
                        "cannot create recording folder {}: {e}; not recording",
                        dir.display()
                    ));
                    None
                }
            }
        };
        let rec_tx = recorder.as_ref().map(|r| r.sender());

        let mut wav: Option<WavRecorder> = None;
        let mut recording_wav = None;
        if startup.record_wav {
            if let Some(mid) = &recording {
                if let Some(a) = &audio {
                    let wav_path = wav_record::wav_path_for(mid);
                    match WavRecorder::start(wav_path.clone(), a.sample_rate) {
                        Ok((w, wtap)) => {
                            if a.attach(Attach::Wav(Box::new(wtap))) {
                                say(&format!(
                                    "Recording audio to {} (16-bit stereo, {} Hz, without the metronome click)",
                                    wav_path.display(),
                                    a.sample_rate
                                ));
                                recording_wav = Some(wav_path);
                                wav = Some(w);
                            } else {
                                eprintln!("warning: cannot attach the audio recorder to the audio output; only the .mid is saved.");
                                warnings.push("cannot record audio; only the .mid is saved".to_string());
                                let _ = w.finish();
                                let _ = std::fs::remove_file(&wav_path);
                            }
                        }
                        Err(e) => {
                            eprintln!("warning: cannot record audio: {e}; only the .mid is saved.");
                            warnings.push(format!("cannot record audio: {e}; only the .mid is saved."));
                        }
                    }
                } else {
                    eprintln!("warning: no sound, so no audio (WAV) recording; only the .mid is saved.");
                    warnings.push("no sound, so no audio (WAV) recording; only the .mid is saved.".to_string());
                }
            }
        }

        let live = start_live_with(
            startup,
            live::Source::Live,
            Some(command_handler(metronome.clone(), prompt.clone())),
        );
        if let (Some(port), None) = (startup.ws_port, &live) {
            warnings.push(format!(
                "cannot start the live event WebSocket on port {port} (see the console)"
            ));
        }
        if let Some(server) = &live {
            connect_state(&metronome, server.sender());
            connect_prompt(&prompt, server.sender());
        }
        let ws_url = live.as_ref().map(|l| l.url());
        let live_tx = live.as_ref().map(|l| l.sender());
        let bridge_live = live_tx.clone();

        let transpose = TransposeControl::new(startup.transpose);
        prompt.set_transpose(transpose.clone());
        let control = transpose.clone();
        let mut transposer = Transposer::new();
        let epoch = Instant::now();
        let connection = midi_in.connect(
            &ports[index],
            "rusty_piano-in",
            move |stamp_us, bytes, _| {
                if let Some(ev) = midi::parse_message(bytes) {
                    if let Some(tx) = &tx {
                        if let Some(sev) = transposer.map(ev, control.get().total()) {
                            let _ = tx.try_send(sev);
                        }
                    }
                    if let Some(live_tx) = &live_tx {
                        let _ = live_tx.send(stamp_us / 1000, ev);
                    }
                    if let Some(rec_tx) = &rec_tx {
                        rec_tx.send(stamp_us, ev);
                    }
                    if let Some(tap) = &tap {
                        let _ = tap.try_send(ev);
                    }
                    println!("{:>10} ms  {}", stamp_us / 1000, ev);
                }
            },
            (),
        );
        let connection = match connection {
            Ok(c) => c,
            Err(e) => {
                metronome.clear_listener();
                if let Some(l) = live {
                    l.finish(Duration::from_millis(200));
                }
                if let Some(r) = recorder {
                    let _ = r.finish();
                }
                if let Some(w) = wav {
                    let p = w.path().to_path_buf();
                    let _ = w.finish();
                    let _ = std::fs::remove_file(p);
                }
                return Err(SessionError {
                    message: format!("cannot connect to {}: {e} (is another app using it?)", names[index]),
                    hint: None,
                });
            }
        };
        if let Some(rx) = notices {
            spawn_bridge(metronome.clone(), rx, bridge_live, epoch);
        }
        if startup.metronome.on {
            if audio.is_some() {
                metronome.start();
                say(&format!("Metronome: on, {}", metronome.settings().describe()));
            } else {
                eprintln!("warning: no sound, so no metronome click.");
                warnings.push("no sound, so no metronome click".to_string());
            }
        }
        Ok(Session {
            connection,
            audio,
            live,
            recorder,
            wav,
            transpose,
            metronome,
            info: SessionInfo {
                port_index: index,
                port_name: names[index].clone(),
                audio: audio_info,
                profile_name: startup.profile_name.clone(),
                recording,
                recording_wav,
                ws_url,
                warnings,
            },
        })
    }

    pub fn metronome(&self) -> &MetronomeHandle {
        &self.metronome
    }

    pub fn transpose(&self) -> Arc<TransposeControl> {
        self.transpose.clone()
    }

    pub fn record_sender(&self) -> Option<RecordSender> {
        self.recorder.as_ref().map(|r| r.sender())
    }

    pub fn stop_handles(&self) -> StopHandles {
        StopHandles {
            record: self.record_sender(),
            wav: self.wav.as_ref().map(|w| w.stopper()),
        }
    }

    /// Closes MIDI, stops the sound, closes the WebSocket (2 s for clients) and saves the recordings.
    pub fn stop(self) -> StopReport {
        let Session { connection, audio, live, recorder, wav, metronome, .. } = self;
        metronome.clear_listener();
        let _ = connection.close();
        drop(audio);
        if let Some(l) = live {
            l.finish(Duration::from_secs(2));
        }
        let midi = recorder.map(|r| r.finish());
        let wav = wav.and_then(|w| {
            let first = w.claim_report();
            let r = w.finish();
            first.then_some(r)
        });
        finish_recordings(midi, wav)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::live::{hello_json, Source};
    use tungstenite::stream::MaybeTlsStream;
    use tungstenite::Message;

    type Client = tungstenite::WebSocket<MaybeTlsStream<std::net::TcpStream>>;

    fn ws_connect(server: &LiveServer) -> Client {
        let (ws, _) = tungstenite::connect(server.url()).unwrap();
        if let MaybeTlsStream::Plain(s) = ws.get_ref() {
            s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        }
        ws
    }

    fn read_text(ws: &mut Client) -> String {
        loop {
            if let Message::Text(t) = ws.read().unwrap() {
                return t.as_str().to_string();
            }
        }
    }

    fn read_until(ws: &mut Client, expected: &str, max_reads: usize) {
        for _ in 0..max_reads {
            if read_text(ws) == expected {
                return;
            }
        }
        panic!("did not see {expected}");
    }

    fn wait_until(cond: impl Fn() -> bool, timeout: Duration) {
        let start = Instant::now();
        while !cond() {
            assert!(start.elapsed() < timeout, "timed out waiting for condition");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn ws_command_starts_metronome() {
        let handle = MetronomeHandle::new(MetronomeSettings::default());
        let (_m, _notices) = handle.attach(48000);
        let server = LiveServer::start_with_handler(
            0,
            Source::Live,
            Some(command_handler(handle.clone(), PromptHandle::new())),
        )
        .unwrap();
        connect_state(&handle, server.sender());
        let mut ws = ws_connect(&server);
        assert_eq!(read_text(&mut ws), hello_json(Source::Live));
        assert_eq!(read_text(&mut ws), metronome::state_json(&MetronomeSettings::default()));
        ws.send(Message::text("{\"type\":\"metronome_start\",\"bpm\":120}")).unwrap();
        let on = MetronomeSettings { on: true, bpm: 120, beats_per_bar: 4, volume: 50 };
        read_until(&mut ws, &metronome::state_json(&on), 4);
        assert!(handle.settings().on);
        let before = handle.settings();
        ws.send(Message::text("not json")).unwrap();
        std::thread::sleep(Duration::from_millis(200));
        assert_eq!(handle.settings(), before);
        ws.send(Message::text("{\"type\":\"metronome_stop\"}")).unwrap();
        let off = MetronomeSettings { on: false, ..on };
        read_until(&mut ws, &metronome::state_json(&off), 4);
        assert!(!handle.settings().on);
    }

    #[test]
    fn ws_play_notes_acks_and_sends_no_note_events() {
        let handle = MetronomeHandle::new(MetronomeSettings::default());
        let (_m, _notices) = handle.attach(48000);
        let prompt = PromptHandle::new();
        let server = LiveServer::start_with_handler(
            0,
            Source::Live,
            Some(command_handler(handle.clone(), prompt.clone())),
        )
        .unwrap();
        connect_state(&handle, server.sender());
        connect_prompt(&prompt, server.sender());
        let mut ws = ws_connect(&server);
        assert_eq!(read_text(&mut ws), hello_json(Source::Live));
        assert_eq!(read_text(&mut ws), metronome::state_json(&MetronomeSettings::default()));
        ws.send(Message::text("{\"type\":\"play_notes\",\"id\":\"a1\",\"notes\":\"60:0:200\"}")).unwrap();
        assert_eq!(read_text(&mut ws), prompt::ack_json("a1", false, 0, Some("no sound output")));
        let mut player = prompt.attach(48000, &crate::config::SoundProfile::default());
        ws.send(Message::text(
            "{\"type\":\"play_notes\",\"id\":\"a2\",\"notes\":\"60:0:200:80,64:100:200:90\"}",
        ))
        .unwrap();
        assert_eq!(read_text(&mut ws), prompt::ack_json("a2", true, 2, None));
        if let MaybeTlsStream::Plain(s) = ws.get_ref() {
            s.set_read_timeout(Some(Duration::from_millis(300))).unwrap();
        }
        assert!(ws.read().is_err());
        let mut l = vec![0.0f32; 24000];
        let mut r = vec![0.0f32; 24000];
        player.process(&mut l, &mut r);
        assert!(l.iter().chain(r.iter()).any(|x| x.abs() > 1e-6));
        if let MaybeTlsStream::Plain(s) = ws.get_ref() {
            s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        }
        ws.send(Message::text("{\"type\":\"metronome_start\",\"bpm\":120}")).unwrap();
        let on = MetronomeSettings { on: true, bpm: 120, beats_per_bar: 4, volume: 50 };
        read_until(&mut ws, &metronome::state_json(&on), 4);
        assert!(handle.settings().on);
    }

    #[test]
    fn bridge_sends_beats_with_engine_time() {
        let handle = MetronomeHandle::new(MetronomeSettings { on: true, bpm: 120, beats_per_bar: 4, volume: 100 });
        let (mut m, rx) = handle.attach(48000);
        let server = LiveServer::start(0, Source::Live).unwrap();
        let mut ws = ws_connect(&server);
        assert_eq!(read_text(&mut ws), hello_json(Source::Live));
        assert!(server.wait_for_client(Duration::from_secs(3)));
        let epoch = Instant::now();
        spawn_bridge(handle.clone(), rx, Some(server.sender()), epoch);
        let mut l = vec![0.0f32; 256];
        let mut r = vec![0.0f32; 256];
        m.process(&mut l, &mut r, epoch + Duration::from_millis(1000), 0);
        assert_eq!(
            read_text(&mut ws),
            "{\"type\":\"beat\",\"t\":1000,\"beat\":1,\"bar\":1,\"count_in\":false}"
        );
    }

    #[test]
    fn count_in_stop_marks_metronome_off() {
        let handle = MetronomeHandle::new(MetronomeSettings { on: false, bpm: 300, beats_per_bar: 1, volume: 50 });
        let (mut m, rx) = handle.attach(48000);
        spawn_bridge(handle.clone(), rx, None, Instant::now());
        handle.count_in(1, false);
        assert!(handle.settings().on);
        let mut l = vec![0.0f32; 512];
        let mut r = vec![0.0f32; 512];
        let start = Instant::now();
        for _ in 0..(48000 / 512) {
            m.process(&mut l, &mut r, start, 0);
        }
        wait_until(|| !handle.settings().on, Duration::from_secs(2));
    }

    fn rows(v: &[(&str, &str)]) -> Vec<(String, String)> {
        v.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect()
    }

    fn info() -> SessionInfo {
        SessionInfo {
            port_index: 1,
            port_name: "SL990".into(),
            audio: Some(AudioInfo {
                backend: Backend::WasapiShared,
                device_name: "Speakers".into(),
                sample_rate: 48000,
                buffer_frames: Some(256),
            }),
            profile_name: "sl990".into(),
            recording: Some(PathBuf::from("s.mid")),
            recording_wav: Some(PathBuf::from("s.wav")),
            ws_url: Some("ws://127.0.0.1:8790".into()),
            warnings: vec![],
        }
    }

    #[test]
    fn save_messages() {
        assert_eq!(
            save_message(&Ok(Some((PathBuf::from("a.mid"), 3)))),
            "Saved session: a.mid (3 events)"
        );
        assert_eq!(save_message(&Ok(None)), "No notes played; nothing recorded.");
        assert_eq!(
            save_message(&Err("disk full".to_string())),
            "warning: recording failed: disk full"
        );
    }

    #[test]
    fn status_lines_full() {
        assert_eq!(
            status_lines(&info()),
            rows(&[
                ("MIDI input", "[1] SL990"),
                ("Audio", "WASAPI shared: Speakers"),
                ("Buffer", "256 frames, 5.3 ms at 48000 Hz"),
                ("Profile", "sl990"),
                ("Recording", "s.mid"),
                ("Audio recording", "s.wav"),
                ("WebSocket", "ws://127.0.0.1:8790"),
            ])
        );
    }

    fn real_wav(name: &str) -> (PathBuf, wav_record::WavSummary) {
        let path = std::env::temp_dir().join(format!("rp-session-{}-{}.wav", std::process::id(), name));
        let (w, mut tap) = WavRecorder::start(path.clone(), 48000).unwrap();
        tap.push(&[0.1; 100], &[0.1; 100]);
        let s = w.finish().unwrap();
        (path, s)
    }

    #[test]
    fn stop_report_lines() {
        let (path, s) = real_wav("lines");
        let _ = std::fs::remove_file(&path);
        let r = StopReport {
            midi: Some(Ok(Some((PathBuf::from("a.mid"), 3)))),
            wav: Some(Ok(s.clone())),
        };
        assert_eq!(
            r.lines(),
            vec![
                "Saved session: a.mid (3 events)".to_string(),
                wav_record::save_message(&Ok(s)),
            ]
        );
        assert!(r.lines()[1].starts_with("Saved audio: "));
        assert!(StopReport { midi: None, wav: None }.lines().is_empty());
    }

    #[test]
    fn no_notes_removes_wav() {
        let (path, s) = real_wav("nonotes");
        assert!(path.exists());
        let r = finish_recordings(Some(Ok(None)), Some(Ok(s)));
        assert!(!path.exists());
        assert_eq!(r.lines(), vec!["No notes played; nothing recorded.".to_string()]);
    }

    #[test]
    fn notes_keep_wav() {
        let (path, s) = real_wav("notes");
        let r = finish_recordings(Some(Ok(Some((PathBuf::from("a.mid"), 2)))), Some(Ok(s)));
        let kept = path.exists();
        let _ = std::fs::remove_file(&path);
        assert!(kept);
        assert_eq!(r.lines().len(), 2);
    }

    #[test]
    fn status_lines_without_audio_recording_or_websocket() {
        let mut i = info();
        i.audio = None;
        i.recording = None;
        i.recording_wav = None;
        i.ws_url = None;
        assert_eq!(
            status_lines(&i)[1..],
            rows(&[
                ("Audio", "no sound (see the console)"),
                ("Buffer", "-"),
                ("Profile", "sl990"),
                ("Recording", "off"),
                ("Audio recording", "off"),
                ("WebSocket", "off"),
            ])[..]
        );
        let mut j = info();
        j.audio = Some(AudioInfo {
            backend: Backend::WasapiShared,
            device_name: "Speakers".into(),
            sample_rate: 44100,
            buffer_frames: None,
        });
        assert_eq!(status_lines(&j)[2].1, "device default (size unknown), 44100 Hz");
    }
}
