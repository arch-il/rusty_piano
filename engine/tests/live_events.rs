use rusty_piano_engine::{live, midi::MidiEvent, playback, record};
use std::io::Read;
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use tungstenite::protocol::frame::coding::CloseCode;
use tungstenite::stream::MaybeTlsStream;
use tungstenite::Message;

fn free_port() -> u16 {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    l.local_addr().unwrap().port()
}

fn write_mid(tag: &str) -> (PathBuf, Vec<u8>) {
    let events = [
        (0, MidiEvent::NoteOn { note: 60, velocity: 1 }),
        (200_000, MidiEvent::NoteOff { note: 60 }),
        (300_000, MidiEvent::Sustain { on: true }),
        (400_000, MidiEvent::Sustain { on: false }),
    ];
    let bytes = record::encode_smf(&events);
    let path = std::env::temp_dir().join(format!(
        "rusty_piano_live_events_{}_{tag}.mid",
        std::process::id()
    ));
    std::fs::write(&path, &bytes).unwrap();
    (path, bytes)
}

struct ChildGuard {
    child: Child,
    out: Option<JoinHandle<String>>,
    err: Option<JoinHandle<String>>,
}

impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn reader<R: Read + Send + 'static>(mut r: R) -> JoinHandle<String> {
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = r.read_to_end(&mut buf);
        String::from_utf8_lossy(&buf).into_owned()
    })
}

fn spawn(path: &PathBuf, port: u16) -> ChildGuard {
    spawn_with(path, port, &[])
}

fn spawn_with(path: &PathBuf, port: u16, extra: &[&str]) -> ChildGuard {
    let mut child = Command::new(env!("CARGO_BIN_EXE_rusty_piano_engine"))
        .arg("--play")
        .arg(path)
        .args(["--ws-port", &port.to_string(), "--backend", "wasapi"])
        .args(extra)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let out = Some(reader(child.stdout.take().unwrap()));
    let err = Some(reader(child.stderr.take().unwrap()));
    ChildGuard { child, out, err }
}

impl ChildGuard {
    fn collect(&mut self) -> (String, String) {
        let out = self.out.take().unwrap().join().unwrap_or_default();
        let err = self.err.take().unwrap().join().unwrap_or_default();
        (out, err)
    }

    fn wait(&mut self, deadline: Duration) -> std::process::ExitStatus {
        let start = Instant::now();
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                return status;
            }
            if start.elapsed() > deadline {
                let _ = self.child.kill();
                let _ = self.child.wait();
                let (out, err) = self.collect();
                panic!("child did not exit in time\nstdout:\n{out}\nstderr:\n{err}");
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}

fn no_audio(err: &str) -> bool {
    err.contains("cannot open audio output")
}

#[test]
fn play_sends_events_to_websocket() {
    ws_flow("ws", &[]);
}

#[test]
fn play_with_transpose_keeps_keys_in_events() {
    ws_flow("shift", &["--transpose", "5", "--octave", "-1"]);
}

fn ws_flow(tag: &str, extra: &[&str]) {
    let (path, bytes) = write_mid(tag);
    let expected: Vec<String> = playback::parse_smf(&bytes)
        .unwrap()
        .iter()
        .map(|(us, ev)| live::event_json(us / 1000, ev))
        .collect();
    let port = free_port();
    let mut guard = spawn_with(&path, port, extra);

    let start = Instant::now();
    let mut ws = loop {
        if let Some(status) = guard.child.try_wait().unwrap() {
            let (out, err) = guard.collect();
            let _ = std::fs::remove_file(&path);
            if no_audio(&err) {
                eprintln!("SKIPPED: no audio output on this machine");
                return;
            }
            panic!("child exited early ({status})\nstdout:\n{out}\nstderr:\n{err}");
        }
        match tungstenite::connect(format!("ws://127.0.0.1:{port}")) {
            Ok((ws, _)) => break ws,
            Err(e) => {
                assert!(start.elapsed() < Duration::from_secs(10), "cannot connect: {e}");
                std::thread::sleep(Duration::from_millis(50));
            }
        }
    };
    if let MaybeTlsStream::Plain(s) = ws.get_ref() {
        let s: &TcpStream = s;
        s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    }
    let read_text = |ws: &mut tungstenite::WebSocket<MaybeTlsStream<TcpStream>>| loop {
        if let Message::Text(t) = ws.read().unwrap() {
            return t.as_str().to_string();
        }
    };
    assert_eq!(read_text(&mut ws), live::hello_json(live::Source::Play));
    for want in &expected {
        assert_eq!(&read_text(&mut ws), want);
    }
    loop {
        match ws.read().unwrap() {
            Message::Close(Some(frame)) => {
                assert_eq!(frame.code, CloseCode::Normal);
                break;
            }
            Message::Close(None) => panic!("close without a frame"),
            _ => {}
        }
    }

    let status = guard.wait(Duration::from_secs(15));
    let (out, err) = guard.collect();
    let _ = std::fs::remove_file(&path);
    assert!(status.success(), "stdout:\n{out}\nstderr:\n{err}");
    assert!(out.contains("Live events: ws://127.0.0.1:"), "{out}");
    assert!(out.contains("Playback done."), "{out}");
}

#[test]
fn busy_port_warns_and_plays_anyway() {
    let (path, _) = write_mid("busy");
    let held = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = held.local_addr().unwrap().port();
    let mut guard = spawn(&path, port);

    let status = guard.wait(Duration::from_secs(15));
    let (out, err) = guard.collect();
    let _ = std::fs::remove_file(&path);
    if !status.success() && no_audio(&err) {
        eprintln!("SKIPPED: no audio output on this machine");
        return;
    }
    assert!(status.success(), "stdout:\n{out}\nstderr:\n{err}");
    assert!(
        err.contains(&format!(
            "warning: cannot start the live event WebSocket on 127.0.0.1:{port}"
        )),
        "{err}"
    );
    assert!(out.contains("Playback done."), "{out}");
    assert!(!out.contains("Waiting up to 10 s"), "{out}");
    drop(held);
}
