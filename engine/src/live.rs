//! Local WebSocket on 127.0.0.1 that sends a hello message and note events as JSON.
//!
//! `t` is integer milliseconds of engine time: live, it is the midir timestamp, which
//! counts from when the MIDI port opened; with --demo/--play it is the time since
//! playback start. Only differences matter. The MIDI thread never blocks: events are
//! dropped when a queue is full. Clients may also send text commands, which go to
//! the optional command handler.

use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{
    sync_channel, Receiver, RecvTimeoutError, SyncSender, TrySendError,
};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tungstenite::protocol::frame::coding::CloseCode;
use tungstenite::protocol::frame::CloseFrame;
use tungstenite::protocol::WebSocketConfig;
use tungstenite::Message;

use crate::midi::{MidiEvent, Pedal};

pub const PROTOCOL_VERSION: u32 = 1;
pub const HUB_QUEUE: usize = 1024;
pub const CLIENT_QUEUE: usize = 256;
pub const MAX_CLIENTS: usize = 16;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    Live,
    Demo,
    Play,
}

impl Source {
    pub fn as_str(self) -> &'static str {
        match self {
            Source::Live => "live",
            Source::Demo => "demo",
            Source::Play => "play",
        }
    }
}

pub fn hello_json(source: Source) -> String {
    format!(
        "{{\"type\":\"hello\",\"version\":{},\"engine\":\"rusty_piano\",\"source\":\"{}\",\"time_unit\":\"ms\"}}",
        PROTOCOL_VERSION,
        source.as_str()
    )
}

pub fn event_json(t_ms: u64, ev: &MidiEvent) -> String {
    match *ev {
        MidiEvent::NoteOn { note, velocity } => format!(
            "{{\"type\":\"note_on\",\"t\":{t_ms},\"note\":{note},\"velocity\":{velocity}}}"
        ),
        MidiEvent::NoteOff { note } => {
            format!("{{\"type\":\"note_off\",\"t\":{t_ms},\"note\":{note}}}")
        }
        MidiEvent::Sustain { on } => {
            format!("{{\"type\":\"sustain\",\"t\":{t_ms},\"on\":{on}}}")
        }
        MidiEvent::Pedal {
            pedal: Pedal::Sustain,
            value,
        } => {
            let on = value >= 64;
            format!("{{\"type\":\"sustain\",\"t\":{t_ms},\"on\":{on}}}")
        }
        MidiEvent::Pedal { pedal, value } => format!(
            "{{\"type\":\"pedal\",\"t\":{t_ms},\"pedal\":\"{}\",\"value\":{value}}}",
            pedal.name()
        ),
    }
}

/// Lets a continuous sustain pedal through only when its on/off state changes,
/// so clients get the same sustain messages as with a switch pedal. All other
/// events pass.
#[derive(Debug, Default)]
pub struct SustainGate {
    last: Option<bool>,
}

impl SustainGate {
    pub fn admit(&mut self, ev: &MidiEvent) -> bool {
        match ev.sustain_on() {
            Some(on) if self.last == Some(on) => false,
            Some(on) => {
                self.last = Some(on);
                true
            }
            None => true,
        }
    }
}

pub type CommandHandler = Arc<dyn Fn(&str) + Send + Sync>;

enum Msg {
    Event(u64, MidiEvent),
    Text(String),
    State(String),
    Join(SyncSender<String>),
    Shutdown,
}

#[derive(Clone)]
pub struct LiveSender {
    tx: SyncSender<Msg>,
}

impl LiveSender {
    pub fn send(&self, t_ms: u64, ev: MidiEvent) -> bool {
        self.tx.try_send(Msg::Event(t_ms, ev)).is_ok()
    }

    pub fn send_text(&self, text: String) -> bool {
        self.tx.try_send(Msg::Text(text)).is_ok()
    }

    pub fn send_state(&self, text: String) -> bool {
        self.tx.try_send(Msg::State(text)).is_ok()
    }
}

fn channel(capacity: usize) -> (LiveSender, Receiver<Msg>) {
    let (tx, rx) = sync_channel(capacity);
    (LiveSender { tx }, rx)
}

pub struct LiveServer {
    addr: SocketAddr,
    tx: SyncSender<Msg>,
    clients: Arc<AtomicUsize>,
    stop: Arc<AtomicBool>,
}

impl LiveServer {
    pub fn start(port: u16, source: Source) -> std::io::Result<LiveServer> {
        Self::start_with_handler(port, source, None)
    }

    pub fn start_with_handler(
        port: u16,
        source: Source,
        handler: Option<CommandHandler>,
    ) -> std::io::Result<LiveServer> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, port))?;
        let addr = listener.local_addr()?;
        listener.set_nonblocking(true)?;
        let (sender, rx) = channel(HUB_QUEUE);
        let tx = sender.tx;
        let clients = Arc::new(AtomicUsize::new(0));
        let stop = Arc::new(AtomicBool::new(false));
        let accept_stop = stop.clone();

        std::thread::Builder::new()
            .name("ws-hub".to_string())
            .spawn(move || {
                let mut subs: Vec<SyncSender<String>> = Vec::new();
                let mut gate = SustainGate::default();
                let mut state: Option<String> = None;
                fn broadcast(subs: &mut Vec<SyncSender<String>>, text: &str) {
                    subs.retain(|c| {
                        !matches!(
                            c.try_send(text.to_string()),
                            Err(TrySendError::Disconnected(_))
                        )
                    });
                }
                for msg in rx {
                    match msg {
                        Msg::Join(c) => {
                            if let Some(s) = &state {
                                let _ = c.try_send(s.clone());
                            }
                            subs.push(c);
                        }
                        Msg::Shutdown => subs.clear(),
                        Msg::Text(t) => broadcast(&mut subs, &t),
                        Msg::State(t) => {
                            broadcast(&mut subs, &t);
                            state = Some(t);
                        }
                        Msg::Event(t, ev) => {
                            if !gate.admit(&ev) {
                                continue;
                            }
                            broadcast(&mut subs, &event_json(t, &ev));
                        }
                    }
                }
            })?;

        let hub_tx = tx.clone();
        let counter = clients.clone();
        std::thread::Builder::new()
            .name("ws-accept".to_string())
            .spawn(move || {
                let in_flight = Arc::new(AtomicUsize::new(0));
                loop {
                    if accept_stop.load(Ordering::SeqCst) {
                        break;
                    }
                    let stream = match listener.accept() {
                        Ok((s, _)) => s,
                        Err(_) => {
                            std::thread::sleep(Duration::from_millis(20));
                            continue;
                        }
                    };
                    if stream.set_nonblocking(false).is_err() {
                        continue;
                    }
                    if in_flight.load(Ordering::SeqCst) >= MAX_CLIENTS {
                        drop(stream);
                        continue;
                    }
                    in_flight.fetch_add(1, Ordering::SeqCst);
                    let guard = CountGuard(in_flight.clone());
                    let hub_tx = hub_tx.clone();
                    let counter = counter.clone();
                    let handler = handler.clone();
                    let spawned = std::thread::Builder::new()
                        .name("ws-client".to_string())
                        .spawn(move || {
                            let _guard = guard;
                            let _ = run_client(stream, hub_tx, counter, source, handler);
                        });
                    if spawned.is_err() {
                        // the closure (and its guard) was dropped by the failed spawn
                        continue;
                    }
                }
            })?;

        Ok(LiveServer {
            addr,
            tx,
            clients,
            stop,
        })
    }

    pub fn local_addr(&self) -> SocketAddr {
        self.addr
    }

    pub fn url(&self) -> String {
        format!("ws://127.0.0.1:{}", self.addr.port())
    }

    pub fn sender(&self) -> LiveSender {
        LiveSender {
            tx: self.tx.clone(),
        }
    }

    pub fn client_count(&self) -> usize {
        self.clients.load(Ordering::SeqCst)
    }

    /// Tells every client the engine stopped: each gets a close frame (1000,
    /// "engine stopped"). Waits up to `timeout` for the clients to go. The
    /// listening port is released within about 20 ms.
    pub fn finish(self, timeout: Duration) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = self.tx.send(Msg::Shutdown);
        let start = Instant::now();
        while self.client_count() > 0 && start.elapsed() < timeout {
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    pub fn wait_for_client(&self, timeout: Duration) -> bool {
        let start = Instant::now();
        loop {
            if self.client_count() > 0 {
                return true;
            }
            if start.elapsed() >= timeout {
                return false;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

impl Drop for LiveServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

struct CountGuard(Arc<AtomicUsize>);

impl Drop for CountGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

fn run_client(
    stream: TcpStream,
    hub: SyncSender<Msg>,
    clients: Arc<AtomicUsize>,
    source: Source,
    handler: Option<CommandHandler>,
) -> Option<()> {
    stream.set_nodelay(true).ok()?;
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .ok()?;
    stream
        .set_write_timeout(Some(Duration::from_secs(2)))
        .ok()?;

    let config = WebSocketConfig::default()
        .max_message_size(Some(64 * 1024))
        .max_frame_size(Some(64 * 1024));
    let callback = |req: &Request, response: Response| -> Result<Response, ErrorResponse> {
        let origin = req.headers().get("origin").and_then(|v| v.to_str().ok());
        if !origin_allowed(origin) {
            return Err(tungstenite::http::Response::builder()
                .status(403)
                .body(Some("origin not allowed".to_string()))
                .unwrap());
        }
        Ok(response)
    };
    let mut ws = tungstenite::accept_hdr_with_config(stream, callback, Some(config)).ok()?;
    ws.send(Message::text(hello_json(source))).ok()?;

    let (ctx, crx) = sync_channel::<String>(CLIENT_QUEUE);
    hub.send(Msg::Join(ctx)).ok()?;
    clients.fetch_add(1, Ordering::SeqCst);
    let _count = CountGuard(clients);

    'outer: loop {
        match crx.recv_timeout(Duration::from_millis(20)) {
            Ok(text) => {
                ws.write(Message::text(text)).ok()?;
                while let Ok(more) = crx.try_recv() {
                    ws.write(Message::text(more)).ok()?;
                }
                ws.flush().ok()?;
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                close_politely(&mut ws);
                break;
            }
        }
        for _ in 0..16 {
            ws.get_mut().set_nonblocking(true).ok()?;
            let r = ws.read();
            ws.get_mut().set_nonblocking(false).ok()?;
            match r {
                Ok(Message::Close(_)) => {
                    let _ = ws.flush();
                    break 'outer;
                }
                Ok(Message::Text(t)) => {
                    if let Some(h) = &handler {
                        h(t.as_str());
                    }
                }
                Ok(_) => {}
                Err(tungstenite::Error::Io(e))
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) =>
                {
                    break;
                }
                Err(_) => break 'outer,
            }
        }
    }
    Some(())
}

fn close_politely(ws: &mut tungstenite::WebSocket<TcpStream>) {
    let frame = CloseFrame {
        code: CloseCode::Normal,
        reason: "engine stopped".into(),
    };
    if ws.close(Some(frame)).is_err() {
        return;
    }
    let _ = ws.flush();
    let _ = ws
        .get_mut()
        .set_read_timeout(Some(Duration::from_millis(200)));
    let deadline = Instant::now() + Duration::from_secs(1);
    while Instant::now() < deadline {
        match ws.read() {
            Ok(_) => {}
            Err(tungstenite::Error::Io(e))
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) => {}
            Err(_) => return,
        }
    }
}

pub fn origin_allowed(origin: Option<&str>) -> bool {
    let Some(origin) = origin else {
        return true;
    };
    let lower = origin.to_ascii_lowercase();
    let Some(rest) = lower.strip_prefix("http://") else {
        return false;
    };
    let host = match rest.split_once(':') {
        Some((host, port)) => {
            if port.is_empty() || port.len() > 5 || !port.bytes().all(|b| b.is_ascii_digit()) {
                return false;
            }
            host
        }
        None => rest,
    };
    host == "localhost" || host == "127.0.0.1"
}

#[cfg(test)]
mod tests {
    use super::*;
    use tungstenite::client::IntoClientRequest;
    use tungstenite::stream::MaybeTlsStream;
    use tungstenite::WebSocket;

    type Client = WebSocket<MaybeTlsStream<TcpStream>>;

    fn connect(server: &LiveServer) -> Client {
        let (ws, _) = tungstenite::connect(server.url()).unwrap();
        set_timeout(&ws);
        ws
    }

    fn set_timeout(ws: &Client) {
        if let MaybeTlsStream::Plain(s) = ws.get_ref() {
            s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        }
    }

    fn read_text(ws: &mut Client) -> String {
        loop {
            if let Message::Text(t) = ws.read().unwrap() {
                return t.as_str().to_string();
            }
        }
    }

    fn wait_until(cond: impl Fn() -> bool, timeout: Duration) {
        let start = Instant::now();
        while !cond() {
            assert!(start.elapsed() < timeout, "timed out waiting for condition");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    const NOTE_ON: MidiEvent = MidiEvent::NoteOn {
        note: 60,
        velocity: 100,
    };

    #[test]
    fn encodes_note_on_note_off_sustain() {
        assert_eq!(
            event_json(1250, &NOTE_ON),
            r#"{"type":"note_on","t":1250,"note":60,"velocity":100}"#
        );
        assert_eq!(
            event_json(1250, &MidiEvent::NoteOff { note: 60 }),
            r#"{"type":"note_off","t":1250,"note":60}"#
        );
        assert_eq!(
            event_json(3250, &MidiEvent::Sustain { on: true }),
            r#"{"type":"sustain","t":3250,"on":true}"#
        );
        assert_eq!(
            event_json(3250, &MidiEvent::Sustain { on: false }),
            r#"{"type":"sustain","t":3250,"on":false}"#
        );
    }

    #[test]
    fn encodes_pedal_events() {
        use crate::midi::Pedal;
        assert_eq!(
            event_json(10, &MidiEvent::Pedal { pedal: Pedal::Sustain, value: 100 }),
            r#"{"type":"sustain","t":10,"on":true}"#
        );
        assert_eq!(
            event_json(10, &MidiEvent::Pedal { pedal: Pedal::Sustain, value: 63 }),
            r#"{"type":"sustain","t":10,"on":false}"#
        );
        assert_eq!(
            event_json(10, &MidiEvent::Pedal { pedal: Pedal::Sostenuto, value: 127 }),
            r#"{"type":"pedal","t":10,"pedal":"sostenuto","value":127}"#
        );
        assert_eq!(
            event_json(10, &MidiEvent::Pedal { pedal: Pedal::Soft, value: 0 }),
            r#"{"type":"pedal","t":10,"pedal":"soft","value":0}"#
        );
    }

    #[test]
    fn sustain_gate_passes_only_changes() {
        use crate::midi::Pedal;
        let p = |pedal, value| MidiEvent::Pedal { pedal, value };
        let mut g = SustainGate::default();
        assert!(g.admit(&p(Pedal::Sustain, 10)));
        assert!(!g.admit(&p(Pedal::Sustain, 20)));
        assert!(g.admit(&p(Pedal::Sustain, 70)));
        assert!(!g.admit(&MidiEvent::Sustain { on: true }));
        assert!(g.admit(&p(Pedal::Sustain, 0)));
        assert!(g.admit(&NOTE_ON));
        assert!(g.admit(&p(Pedal::Soft, 5)));
        assert!(g.admit(&p(Pedal::Soft, 5)));
    }

    #[test]
    fn repeated_sustain_values_are_sent_once() {
        use crate::midi::Pedal;
        let server = LiveServer::start(0, Source::Demo).unwrap();
        let mut ws = connect(&server);
        assert_eq!(read_text(&mut ws), hello_json(Source::Demo));
        assert!(server.wait_for_client(Duration::from_secs(3)));
        let evs = [
            (0, MidiEvent::Pedal { pedal: Pedal::Sustain, value: 100 }),
            (1, MidiEvent::Pedal { pedal: Pedal::Sustain, value: 110 }),
            (2, MidiEvent::Pedal { pedal: Pedal::Sustain, value: 20 }),
            (3, MidiEvent::NoteOn { note: 60, velocity: 90 }),
        ];
        let sender = server.sender();
        for (t, ev) in evs {
            assert!(sender.send(t, ev));
        }
        for i in [0, 2, 3] {
            assert_eq!(read_text(&mut ws), event_json(evs[i].0, &evs[i].1));
        }
    }

    #[test]
    fn hello_names_the_source() {
        assert_eq!(
            hello_json(Source::Live),
            r#"{"type":"hello","version":1,"engine":"rusty_piano","source":"live","time_unit":"ms"}"#
        );
        assert_eq!(
            hello_json(Source::Demo),
            r#"{"type":"hello","version":1,"engine":"rusty_piano","source":"demo","time_unit":"ms"}"#
        );
        assert_eq!(
            hello_json(Source::Play),
            r#"{"type":"hello","version":1,"engine":"rusty_piano","source":"play","time_unit":"ms"}"#
        );
    }

    #[test]
    fn sender_never_blocks_when_full() {
        let (s, _rx) = channel(2);
        let start = Instant::now();
        let a = s.send(0, NOTE_ON);
        let b = s.send(1, NOTE_ON);
        let c = s.send(2, NOTE_ON);
        assert!(start.elapsed() < Duration::from_millis(100));
        assert_eq!((a, b, c), (true, true, false));
    }

    #[test]
    fn client_gets_hello_then_events() {
        let server = LiveServer::start(0, Source::Demo).unwrap();
        let mut ws = connect(&server);
        assert_eq!(read_text(&mut ws), hello_json(Source::Demo));
        assert!(server.wait_for_client(Duration::from_secs(3)));
        let evs = [
            (0, MidiEvent::NoteOn { note: 60, velocity: 90 }),
            (220, MidiEvent::NoteOff { note: 60 }),
            (300, MidiEvent::Sustain { on: true }),
        ];
        let sender = server.sender();
        for (t, ev) in evs {
            assert!(sender.send(t, ev));
        }
        for (t, ev) in evs {
            assert_eq!(read_text(&mut ws), event_json(t, &ev));
        }
    }

    #[test]
    fn several_clients_get_every_event() {
        let server = LiveServer::start(0, Source::Live).unwrap();
        let mut clients: Vec<Client> = (0..3).map(|_| connect(&server)).collect();
        for ws in clients.iter_mut() {
            assert_eq!(read_text(ws), hello_json(Source::Live));
        }
        wait_until(|| server.client_count() == 3, Duration::from_secs(3));
        let sender = server.sender();
        let evs: Vec<(u64, MidiEvent)> = (0..5u8)
            .map(|i| {
                (
                    u64::from(i) * 10,
                    MidiEvent::NoteOn {
                        note: 60 + i,
                        velocity: 80,
                    },
                )
            })
            .collect();
        for (t, ev) in &evs {
            assert!(sender.send(*t, *ev));
        }
        for ws in clients.iter_mut() {
            for (t, ev) in &evs {
                assert_eq!(read_text(ws), event_json(*t, ev));
            }
        }
    }

    #[test]
    fn closed_client_is_dropped() {
        let server = LiveServer::start(0, Source::Live).unwrap();
        let mut a = connect(&server);
        let mut b = connect(&server);
        read_text(&mut a);
        read_text(&mut b);
        wait_until(|| server.client_count() == 2, Duration::from_secs(3));
        let _ = a.close(None);
        while a.read().is_ok() {}
        wait_until(|| server.client_count() == 1, Duration::from_secs(3));
        let ev = MidiEvent::NoteOff { note: 61 };
        assert!(server.sender().send(5, ev));
        assert_eq!(read_text(&mut b), event_json(5, &ev));
    }

    fn expect_close(ws: &mut Client) {
        loop {
            match ws.read().unwrap() {
                Message::Close(Some(frame)) => {
                    assert_eq!(frame.code, CloseCode::Normal);
                    assert_eq!(frame.reason.as_str(), "engine stopped");
                    return;
                }
                Message::Close(None) => panic!("close without a frame"),
                _ => {}
            }
        }
    }

    #[test]
    fn finish_sends_close_frame() {
        let server = LiveServer::start(0, Source::Demo).unwrap();
        let mut ws = connect(&server);
        assert_eq!(read_text(&mut ws), hello_json(Source::Demo));
        assert!(server.wait_for_client(Duration::from_secs(3)));
        assert!(server.sender().send(7, NOTE_ON));
        server.finish(Duration::from_secs(2));
        assert_eq!(read_text(&mut ws), event_json(7, &NOTE_ON));
        expect_close(&mut ws);
    }

    #[test]
    fn finish_returns_quickly_without_clients() {
        let server = LiveServer::start(0, Source::Live).unwrap();
        let start = Instant::now();
        server.finish(Duration::from_secs(2));
        assert!(start.elapsed() < Duration::from_millis(500));
    }

    #[test]
    fn finish_with_several_clients() {
        let server = LiveServer::start(0, Source::Live).unwrap();
        let mut clients: Vec<Client> = (0..3).map(|_| connect(&server)).collect();
        for ws in clients.iter_mut() {
            read_text(ws);
        }
        wait_until(|| server.client_count() == 3, Duration::from_secs(3));
        let counter = server.clients.clone();
        server.finish(Duration::from_secs(2));
        for ws in clients.iter_mut() {
            expect_close(ws);
        }
        wait_until(|| counter.load(Ordering::SeqCst) == 0, Duration::from_secs(2));
    }

    fn port_is_free(addr: SocketAddr) -> bool {
        let start = Instant::now();
        while start.elapsed() < Duration::from_secs(3) {
            if TcpListener::bind(addr).is_ok() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        false
    }

    #[test]
    fn finish_frees_the_port() {
        let server = LiveServer::start(0, Source::Live).unwrap();
        let addr = server.local_addr();
        server.finish(Duration::from_millis(100));
        assert!(port_is_free(addr), "port {} still in use after finish", addr.port());
    }

    #[test]
    fn drop_frees_the_port() {
        let server = LiveServer::start(0, Source::Live).unwrap();
        let addr = server.local_addr();
        drop(server);
        assert!(port_is_free(addr), "port {} still in use after drop", addr.port());
    }

    #[test]
    fn busy_port_is_an_error() {
        let held = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = held.local_addr().unwrap().port();
        assert!(LiveServer::start(port, Source::Live).is_err());
    }

    #[test]
    fn binds_loopback_only() {
        let server = LiveServer::start(0, Source::Live).unwrap();
        assert_eq!(server.local_addr().ip(), Ipv4Addr::LOCALHOST);
        assert!(server.url().starts_with("ws://127.0.0.1:"));
    }

    #[test]
    fn origin_rules() {
        for ok in [
            None,
            Some("http://localhost"),
            Some("http://localhost:5173"),
            Some("http://127.0.0.1:8765"),
            Some("HTTP://LOCALHOST:5173"),
        ] {
            assert!(origin_allowed(ok), "{ok:?}");
        }
        for bad in [
            "https://example.com",
            "null",
            "http://localhost.example.com",
            "http://127.0.0.1.example.com:80",
            "http://localhost:5173/x",
            "http://localhost:",
            "https://localhost:5173",
        ] {
            assert!(!origin_allowed(Some(bad)), "{bad}");
        }
    }

    #[test]
    fn foreign_origin_is_refused() {
        let server = LiveServer::start(0, Source::Live).unwrap();
        let mut req = server.url().into_client_request().unwrap();
        req.headers_mut()
            .insert("Origin", "https://example.com".parse().unwrap());
        assert!(tungstenite::connect(req).is_err());

        let mut req = server.url().into_client_request().unwrap();
        req.headers_mut()
            .insert("Origin", "http://localhost:5173".parse().unwrap());
        let (mut ws, _) = tungstenite::connect(req).unwrap();
        set_timeout(&ws);
        assert_eq!(read_text(&mut ws), hello_json(Source::Live));
    }

    use std::sync::Mutex;

    fn collecting_handler() -> (CommandHandler, Arc<Mutex<Vec<String>>>) {
        let got = Arc::new(Mutex::new(Vec::<String>::new()));
        let g = got.clone();
        let handler: CommandHandler = Arc::new(move |s: &str| g.lock().unwrap().push(s.to_string()));
        (handler, got)
    }

    #[test]
    fn client_text_goes_to_handler() {
        let (handler, got) = collecting_handler();
        let server = LiveServer::start_with_handler(0, Source::Live, Some(handler)).unwrap();
        let mut ws = connect(&server);
        assert_eq!(read_text(&mut ws), hello_json(Source::Live));
        let cmd = "{\"type\":\"metronome_stop\"}";
        ws.send(Message::text(cmd)).unwrap();
        wait_until(
            || *got.lock().unwrap() == vec![cmd.to_string()],
            Duration::from_secs(3),
        );
    }

    #[test]
    fn commands_arrive_while_events_stream() {
        let (handler, got) = collecting_handler();
        let server = LiveServer::start_with_handler(0, Source::Live, Some(handler)).unwrap();
        let mut ws = connect(&server);
        assert_eq!(read_text(&mut ws), hello_json(Source::Live));
        assert!(server.wait_for_client(Duration::from_secs(3)));
        let sender = server.sender();
        let streamer = std::thread::spawn(move || {
            let start = Instant::now();
            let mut t = 0;
            while start.elapsed() < Duration::from_millis(1500) {
                sender.send(t, NOTE_ON);
                t += 2;
                std::thread::sleep(Duration::from_millis(2));
            }
        });
        std::thread::sleep(Duration::from_millis(100));
        ws.send(Message::text("cmd")).unwrap();
        let sent = Instant::now();
        while got.lock().unwrap().is_empty() {
            let _ = ws.read();
            assert!(sent.elapsed() < Duration::from_secs(1), "command not delivered");
        }
        streamer.join().unwrap();
    }

    #[test]
    fn state_is_sent_after_hello_to_late_clients() {
        let server = LiveServer::start(0, Source::Live).unwrap();
        let sender = server.sender();
        assert!(sender.send_state("s1".to_string()));
        let mut a = connect(&server);
        assert_eq!(read_text(&mut a), hello_json(Source::Live));
        assert_eq!(read_text(&mut a), "s1");
        assert!(sender.send_state("s2".to_string()));
        assert_eq!(read_text(&mut a), "s2");
        let mut b = connect(&server);
        assert_eq!(read_text(&mut b), hello_json(Source::Live));
        assert_eq!(read_text(&mut b), "s2");
    }

    #[test]
    fn send_text_reaches_every_client() {
        let server = LiveServer::start(0, Source::Live).unwrap();
        let mut a = connect(&server);
        let mut b = connect(&server);
        read_text(&mut a);
        read_text(&mut b);
        wait_until(|| server.client_count() == 2, Duration::from_secs(3));
        assert!(server.sender().send_text("x".to_string()));
        assert_eq!(read_text(&mut a), "x");
        assert_eq!(read_text(&mut b), "x");
    }

    #[test]
    fn client_text_without_handler_is_ignored() {
        let server = LiveServer::start(0, Source::Live).unwrap();
        let mut ws = connect(&server);
        assert_eq!(read_text(&mut ws), hello_json(Source::Live));
        assert!(server.wait_for_client(Duration::from_secs(3)));
        ws.send(Message::text("hello?")).unwrap();
        std::thread::sleep(Duration::from_millis(100));
        assert!(server.sender().send(9, NOTE_ON));
        assert_eq!(read_text(&mut ws), event_json(9, &NOTE_ON));
    }
}
