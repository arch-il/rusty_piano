//! Session recording to Standard MIDI Files.
//!
//! Live MIDI events are collected on a background thread and written as a
//! format-0 .mid file (480 ticks per quarter, 120 bpm, so 960 ticks per
//! second). The file is rewritten every few seconds and on exit.

use crate::midi::MidiEvent;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

pub const TICKS_PER_QUARTER: u16 = 480;
pub const TEMPO_US_PER_QUARTER: u32 = 500_000;
const SAVE_INTERVAL: Duration = Duration::from_secs(10);

fn us_to_ticks(us: u64) -> u64 {
    us * 960 / 1_000_000
}

/// Appends a MIDI variable-length quantity.
pub fn write_vlq(out: &mut Vec<u8>, value: u32) {
    let mut groups = [0u8; 5];
    let mut n = 0;
    let mut v = value;
    loop {
        groups[n] = (v & 0x7F) as u8;
        n += 1;
        v >>= 7;
        if v == 0 {
            break;
        }
    }
    for i in (0..n).rev() {
        let cont = if i > 0 { 0x80 } else { 0 };
        out.push(groups[i] | cont);
    }
}

/// Encodes (microseconds since start, event) pairs as a format-0 MIDI file.
pub fn encode_smf(events: &[(u64, MidiEvent)]) -> Vec<u8> {
    let mut sorted = events.to_vec();
    sorted.sort_by_key(|(t, _)| *t);

    let mut track = Vec::new();
    track.extend_from_slice(&[0x00, 0xFF, 0x51, 0x03]);
    track.extend_from_slice(&TEMPO_US_PER_QUARTER.to_be_bytes()[1..]);
    let mut prev_ticks = 0u64;
    for (t, ev) in &sorted {
        let ticks = us_to_ticks(*t);
        write_vlq(&mut track, (ticks - prev_ticks) as u32);
        prev_ticks = ticks;
        match *ev {
            MidiEvent::NoteOn { note, velocity } => track.extend_from_slice(&[0x90, note, velocity]),
            MidiEvent::NoteOff { note } => track.extend_from_slice(&[0x80, note, 64]),
            MidiEvent::Sustain { on } => {
                track.extend_from_slice(&[0xB0, 0x40, if on { 0x7F } else { 0x00 }])
            }
            MidiEvent::Pedal { pedal, value } => {
                track.extend_from_slice(&[0xB0, pedal.cc(), value])
            }
        }
    }
    track.extend_from_slice(&[0x00, 0xFF, 0x2F, 0x00]);

    let mut out = Vec::new();
    out.extend_from_slice(b"MThd");
    out.extend_from_slice(&6u32.to_be_bytes());
    out.extend_from_slice(&0u16.to_be_bytes());
    out.extend_from_slice(&1u16.to_be_bytes());
    out.extend_from_slice(&TICKS_PER_QUARTER.to_be_bytes());
    out.extend_from_slice(b"MTrk");
    out.extend_from_slice(&(track.len() as u32).to_be_bytes());
    out.extend_from_slice(&track);
    out
}

/// File name "session-YYYYMMDD-HHMMSS.mid" for a Unix time, in UTC.
pub fn session_file_name(unix_secs: u64) -> String {
    let days = (unix_secs / 86_400) as i64;
    let rem = unix_secs % 86_400;
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + if month <= 2 { 1 } else { 0 };
    format!("session-{year:04}{month:02}{day:02}-{h:02}{m:02}{s:02}.mid")
}

/// The repo's coach/data/sessions folder, next to the engine folder.
pub fn default_dir(engine_dir: &Path) -> PathBuf {
    let base = match engine_dir.parent() {
        Some(p) => p.to_path_buf(),
        None => engine_dir.join(".."),
    };
    base.join("coach").join("data").join("sessions")
}

fn save(path: &Path, events: &[(u64, MidiEvent)]) -> Result<(), String> {
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    std::fs::write(&tmp, encode_smf(events))
        .and_then(|_| std::fs::rename(&tmp, path))
        .map_err(|e| format!("cannot write {}: {e}", path.display()))
}

pub type SaveResult = Result<Option<(PathBuf, usize)>, String>;

enum Msg {
    Event(u64, MidiEvent),
    Flush(mpsc::Sender<SaveResult>),
    Stop,
}

/// Cloneable handle for sending events to the recorder thread.
#[derive(Clone)]
pub struct RecordSender {
    tx: Sender<Msg>,
}

impl RecordSender {
    pub fn send(&self, stamp_us: u64, ev: MidiEvent) {
        let _ = self.tx.send(Msg::Event(stamp_us, ev));
    }

    /// Saves now (covering every event sent before this call) and returns the
    /// save result; recording continues afterwards.
    pub fn flush(&self, timeout: Duration) -> SaveResult {
        let (ack_tx, ack_rx) = mpsc::channel();
        if self.tx.send(Msg::Flush(ack_tx)).is_err() {
            return Err("recorder already stopped".to_string());
        }
        match ack_rx.recv_timeout(timeout) {
            Ok(result) => result,
            Err(RecvTimeoutError::Timeout) => Err("recorder did not answer in time".to_string()),
            Err(RecvTimeoutError::Disconnected) => Err("recorder already stopped".to_string()),
        }
    }
}

/// Background recorder that periodically saves events to a .mid file.
pub struct Recorder {
    tx: Sender<Msg>,
    handle: JoinHandle<SaveResult>,
}

impl Recorder {
    /// Starts recording to `path`, saving every 10 seconds.
    pub fn start(path: PathBuf) -> Recorder {
        Recorder::start_with_interval(path, SAVE_INTERVAL)
    }

    pub fn start_with_interval(path: PathBuf, interval: Duration) -> Recorder {
        let (tx, rx) = mpsc::channel::<Msg>();
        let handle = std::thread::Builder::new()
            .name("recorder".to_string())
            .spawn(move || {
                let mut events: Vec<(u64, MidiEvent)> = Vec::new();
                let mut unsaved = false;
                let mut last_error: Option<String> = None;
                let mut last_save = Instant::now();
                let save_now = |events: &[(u64, MidiEvent)],
                                unsaved: &mut bool,
                                last_error: &mut Option<String>| {
                    if *unsaved {
                        match save(&path, events) {
                            Ok(()) => {
                                *unsaved = false;
                                *last_error = None;
                            }
                            Err(e) => *last_error = Some(e),
                        }
                    }
                };
                let result = |events: &[(u64, MidiEvent)], last_error: &Option<String>| -> SaveResult {
                    match last_error {
                        Some(e) => Err(e.clone()),
                        None if events.is_empty() => Ok(None),
                        None => Ok(Some((path.clone(), events.len()))),
                    }
                };
                loop {
                    let wait = interval.saturating_sub(last_save.elapsed());
                    let mut done = false;
                    match rx.recv_timeout(wait) {
                        Ok(Msg::Event(t, ev)) => {
                            events.push((t, ev));
                            unsaved = true;
                        }
                        Ok(Msg::Flush(ack)) => {
                            save_now(&events, &mut unsaved, &mut last_error);
                            last_save = Instant::now();
                            let _ = ack.send(result(&events, &last_error));
                        }
                        Ok(Msg::Stop) | Err(RecvTimeoutError::Disconnected) => done = true,
                        Err(RecvTimeoutError::Timeout) => {}
                    }
                    if done || last_save.elapsed() >= interval {
                        save_now(&events, &mut unsaved, &mut last_error);
                        last_save = Instant::now();
                    }
                    if done {
                        break;
                    }
                }
                result(&events, &last_error)
            })
            .expect("cannot start recorder thread");
        Recorder { tx, handle }
    }

    pub fn sender(&self) -> RecordSender {
        RecordSender { tx: self.tx.clone() }
    }

    /// Stops recording and does the final save. Works even while
    /// `RecordSender` clones are still alive.
    pub fn finish(self) -> SaveResult {
        let Recorder { tx, handle } = self;
        let _ = tx.send(Msg::Stop);
        handle
            .join()
            .unwrap_or_else(|_| Err("recorder thread panicked".to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vlq(v: u32) -> Vec<u8> {
        let mut out = Vec::new();
        write_vlq(&mut out, v);
        out
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("rp-record-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn sample() -> Vec<(u64, MidiEvent)> {
        vec![
            (0, MidiEvent::NoteOn { note: 60, velocity: 100 }),
            (1_000_000, MidiEvent::NoteOff { note: 60 }),
            (1_500_000, MidiEvent::Sustain { on: true }),
        ]
    }

    #[test]
    fn vlq_values() {
        assert_eq!(vlq(0), [0x00]);
        assert_eq!(vlq(127), [0x7F]);
        assert_eq!(vlq(128), [0x81, 0x00]);
        assert_eq!(vlq(16383), [0xFF, 0x7F]);
        assert_eq!(vlq(2_097_152), [0x81, 0x80, 0x80, 0x00]);
    }

    #[test]
    fn smf_exact_bytes() {
        let bytes = encode_smf(&sample());
        let expected_track: Vec<u8> = vec![
            0x00, 0xFF, 0x51, 0x03, 0x07, 0xA1, 0x20, //
            0x00, 0x90, 60, 100, //
            0x87, 0x40, 0x80, 60, 64, //
            0x83, 0x60, 0xB0, 0x40, 0x7F, //
            0x00, 0xFF, 0x2F, 0x00,
        ];
        let mut expected = b"MThd".to_vec();
        expected.extend_from_slice(&[0, 0, 0, 6, 0, 0, 0, 1, 0x01, 0xE0]);
        expected.extend_from_slice(b"MTrk");
        expected.extend_from_slice(&(expected_track.len() as u32).to_be_bytes());
        expected.extend_from_slice(&expected_track);
        assert_eq!(bytes, expected);
    }

    #[test]
    fn pedal_events_encode_as_control_changes() {
        use crate::midi::Pedal;
        let bytes = encode_smf(&[
            (0, MidiEvent::Pedal { pedal: Pedal::Sostenuto, value: 100 }),
            (1000, MidiEvent::Pedal { pedal: Pedal::Soft, value: 127 }),
            (2000, MidiEvent::Pedal { pedal: Pedal::Sustain, value: 37 }),
        ]);
        for triple in [[0xB0u8, 66, 100], [0xB0, 67, 127], [0xB0, 64, 37]] {
            assert!(bytes.windows(3).any(|w| w == triple), "missing {triple:?}");
        }
    }

    #[test]
    fn unsorted_input_is_sorted() {
        let mut shuffled = sample();
        shuffled.reverse();
        assert_eq!(encode_smf(&shuffled), encode_smf(&sample()));
    }

    #[test]
    fn file_names() {
        assert_eq!(session_file_name(0), "session-19700101-000000.mid");
        assert_eq!(session_file_name(951_782_400), "session-20000229-000000.mid");
        assert_eq!(
            session_file_name(951_782_400 + 3723),
            "session-20000229-010203.mid"
        );
    }

    #[test]
    fn default_dir_is_sibling_of_engine() {
        assert_eq!(
            default_dir(Path::new("/a/engine")),
            Path::new("/a").join("coach").join("data").join("sessions")
        );
    }

    #[test]
    fn recorder_writes_file_on_finish() {
        let dir = temp_dir("finish");
        let path = dir.join("s.mid");
        let rec = Recorder::start(path.clone());
        let tx = rec.sender();
        for e in sample() {
            tx.send(e.0, e.1);
        }
        let result = rec.finish().unwrap();
        assert_eq!(result, Some((path.clone(), 3)));
        assert_eq!(std::fs::read(&path).unwrap(), encode_smf(&sample()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn recorder_without_events_writes_nothing() {
        let dir = temp_dir("empty");
        let path = dir.join("s.mid");
        let rec = Recorder::start(path.clone());
        assert_eq!(rec.finish(), Ok(None));
        assert!(!path.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn recorder_saves_periodically() {
        let dir = temp_dir("periodic");
        let path = dir.join("s.mid");
        let rec = Recorder::start_with_interval(path.clone(), Duration::from_millis(50));
        rec.sender().send(sample()[0].0, sample()[0].1);
        std::thread::sleep(Duration::from_millis(400));
        assert!(path.exists());
        assert_eq!(rec.finish().unwrap().map(|(_, n)| n), Some(1));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn flush_saves_and_recording_continues() {
        let dir = temp_dir("flush");
        let path = dir.join("s.mid");
        let rec = Recorder::start(path.clone());
        let tx = rec.sender();
        let s = sample();
        tx.send(s[0].0, s[0].1);
        tx.send(s[1].0, s[1].1);
        let r = tx.flush(Duration::from_secs(5)).unwrap();
        assert_eq!(r, Some((path.clone(), 2)));
        assert_eq!(std::fs::read(&path).unwrap(), encode_smf(&s[..2]));
        tx.send(s[2].0, s[2].1);
        let r = rec.finish().unwrap();
        assert_eq!(r, Some((path.clone(), 3)));
        assert_eq!(std::fs::read(&path).unwrap(), encode_smf(&s));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn flush_without_events_writes_nothing() {
        let dir = temp_dir("flush-empty");
        let path = dir.join("s.mid");
        let rec = Recorder::start(path.clone());
        let tx = rec.sender();
        assert_eq!(tx.flush(Duration::from_secs(5)), Ok(None));
        assert!(!path.exists());
        let _ = rec.finish();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn finish_returns_while_sender_clone_alive() {
        let dir = temp_dir("finish-alive");
        let path = dir.join("s.mid");
        let rec = Recorder::start(path.clone());
        let tx = rec.sender();
        tx.send(sample()[0].0, sample()[0].1);
        let (done_tx, done_rx) = mpsc::channel();
        std::thread::spawn(move || {
            let _ = done_tx.send(rec.finish());
        });
        let r = done_rx.recv_timeout(Duration::from_secs(5)).expect("finish hung");
        assert_eq!(r, Ok(Some((path.clone(), 1))));
        drop(tx);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn flush_after_finish_is_error() {
        let dir = temp_dir("flush-after");
        let rec = Recorder::start(dir.join("s.mid"));
        let tx = rec.sender();
        let _ = rec.finish();
        assert!(tx.flush(Duration::from_secs(1)).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
