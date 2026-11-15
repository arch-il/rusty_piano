//! Timed playback of (microseconds, event) lists (used by --demo, --play and the setup window's test sound),
//! and the built-in test sound: a C major scale and chord stored as a .mid file, so a real piece can replace it later.
use crate::audio::AudioOutput;
use crate::midi::MidiEvent;
use crate::setup::Startup;
use crate::sound;
use crate::{playback, record};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

pub const SCALE: [u8; 8] = [60, 62, 64, 65, 67, 69, 71, 72];
pub const CHORD: [u8; 4] = [60, 64, 67, 72];
pub const TAIL: Duration = Duration::from_millis(1500);

/// Waits until each event's time (from the call) and calls emit(time, event). Checks stop at least every 20 ms; returns false if stopped, true when all events were sent.
pub fn play_timeline(events: &[(u64, MidiEvent)], stop: &AtomicBool, mut emit: impl FnMut(Duration, MidiEvent)) -> bool {
    let start = Instant::now();
    for &(us, ev) in events {
        let at = Duration::from_micros(us);
        loop {
            if stop.load(Ordering::Relaxed) { return false; }
            let now = Instant::now();
            let target = start + at;
            if target <= now { break; }
            std::thread::sleep((target - now).min(Duration::from_millis(20)));
        }
        emit(at, ev);
    }
    true
}

/// C4 up to C5 (8 notes, 350 ms apart, each held 300 ms, velocity 80), then C4-E4-G4-C5 at 3.0 s (velocity 90) released at 4.0 s.
pub fn scale_and_chord() -> Vec<(u64, MidiEvent)> {
    let mut events = Vec::new();
    for (i, &note) in SCALE.iter().enumerate() {
        let on = i as u64 * 350_000;
        events.push((on, MidiEvent::NoteOn { note, velocity: 80 }));
        events.push((on + 300_000, MidiEvent::NoteOff { note }));
    }
    for &note in &CHORD { events.push((3_000_000, MidiEvent::NoteOn { note, velocity: 90 })); }
    for &note in &CHORD { events.push((4_000_000, MidiEvent::NoteOff { note })); }
    events
}

/// The test sound as Standard MIDI File bytes.
pub fn test_sound_midi() -> Vec<u8> { record::encode_smf(&scale_and_chord()) }

/// The test sound read back through the .mid parser (the same path as --play).
pub fn test_sound_events() -> Vec<(u64, MidiEvent)> { playback::parse_smf(&test_sound_midi()).unwrap_or_else(|_| scale_and_chord()) }

/// A short-lived audio output that plays events once on its own thread, then lets the sound ring for TAIL.
pub struct TestSound { stop: Arc<AtomicBool>, handle: Option<JoinHandle<Result<String, String>>> }

impl TestSound {
    pub fn start(startup: &Startup, events: Vec<(u64, MidiEvent)>) -> TestSound {
        let stop = Arc::new(AtomicBool::new(false));
        let flag = stop.clone();
        let backend = startup.backend;
        let device = startup.audio_device.clone();
        let buffer = startup.buffer;
        let profile = startup.profile;
        let total = startup.transpose.total();
        let handle = std::thread::Builder::new()
            .name("test-sound".to_string())
            .spawn(move || -> Result<String, String> {
                let audio = AudioOutput::start(backend, device.as_deref(), buffer, move |sr| sound::build_engine(sr, &profile))?;
                let tx = audio.sender();
                let mut transposer = crate::transpose::Transposer::new();
                play_timeline(&events, &flag, |_, ev| {
                    if let Some(sev) = transposer.map(ev, total) { let _ = tx.try_send(sev); }
                });
                let tail = Instant::now();
                while tail.elapsed() < TAIL && !flag.load(Ordering::Relaxed) { std::thread::sleep(Duration::from_millis(20)); }
                Ok(audio.describe())
            })
            .expect("cannot start test sound thread");
        TestSound { stop, handle: Some(handle) }
    }
    pub fn stop(&self) { self.stop.store(true, Ordering::Relaxed); }
    pub fn is_finished(&self) -> bool { self.handle.as_ref().is_none_or(|h| h.is_finished()) }
    /// Once finished: Some(Ok(audio description)) or Some(Err(message)); None while still playing or after the result was taken.
    pub fn take_result(&mut self) -> Option<Result<String, String>> {
        if !self.is_finished() { return None; }
        let handle = self.handle.take()?;
        Some(handle.join().unwrap_or_else(|_| Err("test sound thread panicked".to_string())))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ON: MidiEvent = MidiEvent::NoteOn { note: 60, velocity: 100 };
    const OFF: MidiEvent = MidiEvent::NoteOff { note: 60 };

    #[test]
    fn scale_then_chord() {
        let ev = scale_and_chord();
        assert_eq!(ev.len(), 24);
        assert_eq!(ev[0], (0, MidiEvent::NoteOn { note: 60, velocity: 80 }));
        assert_eq!(ev[1], (300_000, MidiEvent::NoteOff { note: 60 }));
        assert_eq!(ev[14], (2_450_000, MidiEvent::NoteOn { note: 72, velocity: 80 }));
        assert_eq!(ev[15], (2_750_000, MidiEvent::NoteOff { note: 72 }));
        assert_eq!(ev[16], (3_000_000, MidiEvent::NoteOn { note: 60, velocity: 90 }));
        assert_eq!(ev[23], (4_000_000, MidiEvent::NoteOff { note: 72 }));
        let scale: Vec<u8> = ev[..16]
            .iter()
            .filter_map(|(_, e)| match e {
                MidiEvent::NoteOn { note, .. } => Some(*note),
                _ => None,
            })
            .collect();
        assert_eq!(scale, SCALE.to_vec());
        assert!(ev.windows(2).all(|w| w[0].0 <= w[1].0));
    }

    #[test]
    fn test_sound_round_trips_through_midi() {
        assert!(playback::parse_smf(&test_sound_midi()).is_ok());
        assert_eq!(test_sound_events(), scale_and_chord());
        assert_eq!(test_sound_events().last().unwrap().0, 4_000_000);
    }

    #[test]
    fn plays_in_order_and_on_time() {
        let events = [(0, ON), (30_000, OFF), (60_000, ON)];
        let stop = AtomicBool::new(false);
        let mut got = Vec::new();
        let start = Instant::now();
        assert!(play_timeline(&events, &stop, |at, ev| got.push((at, ev))));
        let elapsed = start.elapsed();
        assert_eq!(got, vec![(Duration::ZERO, ON), (Duration::from_millis(30), OFF), (Duration::from_millis(60), ON)]);
        assert!(elapsed >= Duration::from_millis(60));
        assert!(elapsed < Duration::from_secs(2));
    }

    #[test]
    fn stop_before_start_plays_nothing() {
        let stop = AtomicBool::new(true);
        let mut count = 0;
        assert!(!play_timeline(&[(0, ON)], &stop, |_, _| count += 1));
        assert_eq!(count, 0);
    }

    #[test]
    fn stop_during_playback() {
        let events = [(0, ON), (500_000, OFF)];
        let stop = AtomicBool::new(false);
        let mut count = 0;
        let start = Instant::now();
        let finished = play_timeline(&events, &stop, |_, _| {
            count += 1;
            stop.store(true, Ordering::Relaxed);
        });
        assert!(!finished);
        assert_eq!(count, 1);
        assert!(start.elapsed() < Duration::from_millis(400));
    }

    #[test]
    fn empty_timeline_is_done() {
        assert!(play_timeline(&[], &AtomicBool::new(false), |_, _| {}));
    }

    #[test]
    fn test_sound_reports_a_bad_device() {
        let setup = crate::setup::Setup { audio_device: Some("zz-no-such-device-zz".to_string()), ..Default::default() };
        let startup = crate::setup::resolve_from(setup, &crate::cli::Args::default(), &std::env::temp_dir().join("rusty_piano_timeline_no_engine"), Vec::new()).unwrap();
        let mut t = TestSound::start(&startup, scale_and_chord());
        let started = Instant::now();
        let result = loop {
            if let Some(r) = t.take_result() { break r; }
            assert!(started.elapsed() < Duration::from_secs(10), "test sound did not finish");
            std::thread::sleep(Duration::from_millis(20));
        };
        assert!(result.is_err(), "{result:?}");
    }
}
