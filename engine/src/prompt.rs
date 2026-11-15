//! Ear-training prompts the page asks the engine to play. Sound only: prompt notes are never sent as live note events and never recorded to .mid, and the player runs after the WAV tap, so the WAV never contains them.
//!
//! The prompt player owns its own sound engine (and so its own limiter, which is not shared with the main engine); its output is added to the main output and the sum is clamped to [-1, 1].

use crate::config::SoundProfile;
use crate::metronome::{get, parse_object, Val};
use crate::midi::MidiEvent;
use crate::sound::{AnyEngine, SoundEngine};
use crate::transpose::TransposeControl;
use std::sync::mpsc::{sync_channel, Receiver, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};

const MAX_NOTES: usize = 128;
const MAX_START_MS: u32 = 60_000;
const MAX_DUR_MS: u32 = 10_000;
const DEFAULT_VELOCITY: u8 = 80;
const QUEUE: usize = 4;
const IDLE_AFTER_MS: u64 = 3_000;
const SCRATCH_FRAMES: usize = 512;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PromptNote {
    pub note: u8,
    pub velocity: u8,
    pub start_ms: u32,
    pub dur_ms: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PromptCommand {
    Play { id: String, notes: Vec<PromptNote> },
    Stop,
}

fn digits(s: &str) -> Option<u32> {
    if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    s.parse::<u32>().ok()
}

fn parse_item(item: &str) -> Option<PromptNote> {
    let parts: Vec<&str> = item.split(':').collect();
    if parts.len() != 3 && parts.len() != 4 {
        return None;
    }
    let note = digits(parts[0])?;
    let start = digits(parts[1])?;
    let dur = digits(parts[2])?;
    let vel = if parts.len() == 4 { digits(parts[3])? } else { DEFAULT_VELOCITY as u32 };
    if note > 127 || start > MAX_START_MS || dur < 1 || dur > MAX_DUR_MS || vel < 1 || vel > 127 {
        return None;
    }
    Some(PromptNote { note: note as u8, velocity: vel as u8, start_ms: start, dur_ms: dur })
}

pub fn parse_command(text: &str) -> Option<PromptCommand> {
    let obj = parse_object(text)?;
    let Some(Val::Str(kind)) = get(&obj, "type") else {
        return None;
    };
    match kind.as_str() {
        "play_stop" => Some(PromptCommand::Stop),
        "play_notes" => {
            let Some(Val::Str(id)) = get(&obj, "id") else {
                return None;
            };
            if id.is_empty()
                || id.len() > 40
                || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'_' || b == b'-')
            {
                return None;
            }
            let Some(Val::Str(list)) = get(&obj, "notes") else {
                return None;
            };
            let mut notes = Vec::new();
            for item in list.split(',') {
                notes.push(parse_item(item)?);
                if notes.len() > MAX_NOTES {
                    return None;
                }
            }
            Some(PromptCommand::Play { id: id.clone(), notes })
        }
        _ => None,
    }
}

pub fn ack_json(id: &str, ok: bool, notes: usize, reason: Option<&str>) -> String {
    match reason {
        Some(r) => format!("{{\"type\":\"play_ack\",\"id\":\"{id}\",\"ok\":{ok},\"notes\":{notes},\"reason\":\"{r}\"}}"),
        None => format!("{{\"type\":\"play_ack\",\"id\":\"{id}\",\"ok\":{ok},\"notes\":{notes}}}"),
    }
}

pub fn shift_notes(notes: &[PromptNote], semitones: i32) -> Vec<PromptNote> {
    notes
        .iter()
        .filter_map(|n| {
            let s = n.note as i32 + semitones;
            if (0..=127).contains(&s) {
                Some(PromptNote { note: s as u8, ..*n })
            } else {
                None
            }
        })
        .collect()
}

#[derive(Clone, Copy)]
pub struct PromptEvent {
    pub at_ms: u32,
    pub note: u8,
    pub velocity: u8,
}

#[derive(Clone, Copy)]
pub struct PromptBatch {
    pub events: [PromptEvent; 2 * MAX_NOTES],
    pub len: usize,
}

pub(crate) fn batch_for(notes: &[PromptNote]) -> PromptBatch {
    let mut list: Vec<PromptEvent> = Vec::with_capacity(2 * MAX_NOTES);
    for n in notes.iter().take(MAX_NOTES) {
        list.push(PromptEvent { at_ms: n.start_ms, note: n.note, velocity: n.velocity });
        list.push(PromptEvent { at_ms: n.start_ms + n.dur_ms, note: n.note, velocity: 0 });
    }
    list.sort_by_key(|e| (e.at_ms, e.velocity != 0));
    let mut events = [PromptEvent { at_ms: 0, note: 0, velocity: 0 }; 2 * MAX_NOTES];
    events[..list.len()].copy_from_slice(&list);
    PromptBatch { events, len: list.len() }
}

#[derive(Clone, Copy)]
pub enum PromptMsg {
    Play(PromptBatch),
    Stop,
}

pub struct PromptPlayer {
    engine: AnyEngine,
    sample_rate: u32,
    rx: Receiver<PromptMsg>,
    batch: PromptBatch,
    next: usize,
    pos: u64,
    sounding: [bool; 128],
    active: bool,
    quiet: u64,
    last_frame: u64,
    scratch_l: Vec<f32>,
    scratch_r: Vec<f32>,
}

impl PromptPlayer {
    pub fn new(engine: AnyEngine, sample_rate: u32, rx: Receiver<PromptMsg>) -> Self {
        PromptPlayer {
            engine,
            sample_rate,
            rx,
            batch: PromptBatch { events: [PromptEvent { at_ms: 0, note: 0, velocity: 0 }; 2 * MAX_NOTES], len: 0 },
            next: 0,
            pos: 0,
            sounding: [false; 128],
            active: false,
            quiet: 0,
            last_frame: 0,
            scratch_l: vec![0.0; SCRATCH_FRAMES],
            scratch_r: vec![0.0; SCRATCH_FRAMES],
        }
    }

    fn frame_of(&self, at_ms: u32) -> u64 {
        at_ms as u64 * self.sample_rate as u64 / 1000
    }

    fn release_all(&mut self) {
        for n in 0..128 {
            if self.sounding[n] {
                self.engine.handle(&MidiEvent::NoteOff { note: n as u8 });
                self.sounding[n] = false;
            }
        }
    }

    /// Adds the prompt sound to the first min(len) frames, then clamps each sample to [-1, 1]. Does not allocate, lock or block.
    pub fn process(&mut self, left: &mut [f32], right: &mut [f32]) {
        while let Ok(msg) = self.rx.try_recv() {
            self.release_all();
            self.quiet = 0;
            match msg {
                PromptMsg::Play(b) => {
                    self.batch = b;
                    self.pos = 0;
                    self.next = 0;
                    self.active = true;
                    self.last_frame = if b.len > 0 { self.frame_of(b.events[b.len - 1].at_ms) } else { 0 };
                }
                PromptMsg::Stop => {
                    self.batch.len = 0;
                    self.next = 0;
                    self.pos = 0;
                    self.last_frame = 0;
                }
            }
        }
        if !self.active {
            return;
        }
        let n = left.len().min(right.len());
        let mut done = 0;
        while done < n {
            while self.next < self.batch.len {
                let e = self.batch.events[self.next];
                if self.frame_of(e.at_ms) > self.pos {
                    break;
                }
                if e.velocity > 0 {
                    self.engine.handle(&MidiEvent::NoteOn { note: e.note, velocity: e.velocity });
                    self.sounding[e.note as usize] = true;
                } else {
                    self.engine.handle(&MidiEvent::NoteOff { note: e.note });
                    self.sounding[e.note as usize] = false;
                }
                self.next += 1;
            }
            let mut chunk = (n - done).min(SCRATCH_FRAMES);
            if self.next < self.batch.len {
                let until = self.frame_of(self.batch.events[self.next].at_ms) - self.pos;
                chunk = chunk.min(until.max(1) as usize);
            }
            self.engine.render_stereo(&mut self.scratch_l[..chunk], &mut self.scratch_r[..chunk]);
            let mut peak = 0.0f32;
            for i in 0..chunk {
                let l = self.scratch_l[i];
                let r = self.scratch_r[i];
                peak = peak.max(l.abs()).max(r.abs());
                left[done + i] = (left[done + i] + l).clamp(-1.0, 1.0);
                right[done + i] = (right[done + i] + r).clamp(-1.0, 1.0);
            }
            self.pos += chunk as u64;
            done += chunk;
            if self.next >= self.batch.len && !self.sounding.iter().any(|s| *s) {
                if peak < 1e-5 {
                    self.quiet += chunk as u64;
                } else {
                    self.quiet = 0;
                }
                let sr = self.sample_rate as u64;
                if self.quiet >= sr / 10 || self.pos >= self.last_frame + sr * IDLE_AFTER_MS / 1000 {
                    self.active = false;
                    break;
                }
            }
        }
    }
}

#[derive(Default)]
struct Inner {
    tx: Option<SyncSender<PromptMsg>>,
    reply: Option<Arc<dyn Fn(String) + Send + Sync>>,
    transpose: Option<Arc<TransposeControl>>,
}

#[derive(Clone, Default)]
pub struct PromptHandle {
    inner: Arc<Mutex<Inner>>,
}

impl PromptHandle {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn attach(&self, sample_rate: u32, profile: &SoundProfile) -> PromptPlayer {
        let engine = crate::sound::build_engine(sample_rate, profile);
        let (tx, rx) = sync_channel(QUEUE);
        self.inner.lock().unwrap().tx = Some(tx);
        PromptPlayer::new(engine, sample_rate, rx)
    }

    pub fn set_reply(&self, f: Arc<dyn Fn(String) + Send + Sync>) {
        self.inner.lock().unwrap().reply = Some(f);
    }

    pub fn set_transpose(&self, t: Arc<TransposeControl>) {
        self.inner.lock().unwrap().transpose = Some(t);
    }

    pub fn apply(&self, cmd: PromptCommand) {
        let (tx, reply, transpose) = {
            let g = self.inner.lock().unwrap();
            (g.tx.clone(), g.reply.clone(), g.transpose.clone())
        };
        match cmd {
            PromptCommand::Stop => {
                if let Some(tx) = tx {
                    let _ = tx.try_send(PromptMsg::Stop);
                }
            }
            PromptCommand::Play { id, notes } => {
                let shift = transpose.map(|t| t.get().total()).unwrap_or(0);
                let shifted = shift_notes(&notes, shift);
                let text = match tx {
                    None => ack_json(&id, false, 0, Some("no sound output")),
                    Some(_) if shifted.is_empty() => ack_json(&id, false, 0, Some("notes out of range")),
                    Some(tx) => match tx.try_send(PromptMsg::Play(batch_for(&shifted))) {
                        Ok(()) => ack_json(&id, true, shifted.len(), None),
                        Err(TrySendError::Full(_)) => ack_json(&id, false, 0, Some("busy")),
                        Err(TrySendError::Disconnected(_)) => ack_json(&id, false, 0, Some("no sound output")),
                    },
                };
                if let Some(r) = reply {
                    r(text);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sound::modal_piano::ModalProfile;
    use crate::transpose::Shift;

    fn play(id: &str, spec: &str) -> String {
        format!("{{\"type\":\"play_notes\",\"id\":\"{id}\",\"notes\":\"{spec}\"}}")
    }

    fn collect(h: &PromptHandle) -> Arc<Mutex<Vec<String>>> {
        let acks = Arc::new(Mutex::new(Vec::new()));
        let a = acks.clone();
        h.set_reply(Arc::new(move |s| a.lock().unwrap().push(s)));
        acks
    }

    fn cmd(spec: &str) -> PromptCommand {
        parse_command(&play("q1", spec)).unwrap()
    }

    #[test]
    fn parse_ok() {
        let c = parse_command(&play("q1", "60:0:200")).unwrap();
        assert_eq!(
            c,
            PromptCommand::Play { id: "q1".into(), notes: vec![PromptNote { note: 60, velocity: 80, start_ms: 0, dur_ms: 200 }] }
        );
        match parse_command(&play("q1", "60:10:200:99,61:20:30")).unwrap() {
            PromptCommand::Play { notes, .. } => {
                assert_eq!(notes.len(), 2);
                assert_eq!(notes[0].velocity, 99);
                assert_eq!(notes[1].velocity, 80);
            }
            _ => panic!(),
        }
        assert!(parse_command(&play("a.b_C-9", "0:60000:10000:127")).is_some());
        assert!(parse_command(&play(&"x".repeat(40), "60:0:1")).is_some());
        let c = parse_command(r#"{"type":"play_notes","id":"ear-1","notes":"60:0:675:80,64:750:675:80"}"#).unwrap();
        match c {
            PromptCommand::Play { id, notes } => {
                assert_eq!(id, "ear-1");
                assert_eq!(notes.len(), 2);
                assert_eq!(notes[1], PromptNote { note: 64, velocity: 80, start_ms: 750, dur_ms: 675 });
            }
            _ => panic!(),
        }
    }

    #[test]
    fn parse_rejects() {
        assert!(parse_command(r#"{"type":"play_notes","notes":"60:0:100"}"#).is_none());
        assert!(parse_command(&play("a b", "60:0:100")).is_none());
        assert!(parse_command(&play(&"x".repeat(41), "60:0:100")).is_none());
        assert!(parse_command(&play("", "60:0:100")).is_none());
        for bad in ["", "60:0:0", "128:0:100", "60:60001:100", "60:0:10001", "60:0:100:0", "60:0:100:128", "60:0:100;62:0:100", "60:0", "60:0:100:80:1", "60:0:100,", "6x:0:100", "-1:0:100"] {
            assert!(parse_command(&play("q1", bad)).is_none(), "{bad}");
        }
        let many = vec!["60:0:100"; 129].join(",");
        assert!(parse_command(&play("q1", &many)).is_none());
        let ok = vec!["60:0:100"; 128].join(",");
        assert!(parse_command(&play("q1", &ok)).is_some());
        assert!(parse_command(r#"{"type":"play_notes","id":"q1","notes":60}"#).is_none());
        assert!(parse_command(r#"{"type":"other"}"#).is_none());
    }

    #[test]
    fn parse_stop() {
        assert_eq!(parse_command(r#"{"type":"play_stop"}"#), Some(PromptCommand::Stop));
    }

    #[test]
    fn ack_exact() {
        assert_eq!(ack_json("q1", true, 3, None), r#"{"type":"play_ack","id":"q1","ok":true,"notes":3}"#);
        assert_eq!(
            ack_json("q1", false, 0, Some("no sound output")),
            r#"{"type":"play_ack","id":"q1","ok":false,"notes":0,"reason":"no sound output"}"#
        );
        assert_eq!(ack_json("ear-1", true, 2, None), r#"{"type":"play_ack","id":"ear-1","ok":true,"notes":2}"#);
    }

    #[test]
    fn shift_drops_out_of_range() {
        let n = |note| PromptNote { note, velocity: 80, start_ms: 0, dur_ms: 10 };
        let up = shift_notes(&[n(60), n(127)], 2);
        assert_eq!(up.len(), 1);
        assert_eq!(up[0].note, 62);
        let down = shift_notes(&[n(60), n(61)], -61);
        assert_eq!(down.len(), 1);
        assert_eq!(down[0].note, 0);
    }

    #[test]
    fn batch_orders_offs_before_ons() {
        let n = |note, start_ms, dur_ms| PromptNote { note, velocity: 80, start_ms, dur_ms };
        let b = batch_for(&[n(62, 100, 50), n(60, 0, 100)]);
        assert_eq!(b.len, 4);
        let ev: Vec<(u32, u8, bool)> = b.events[..4].iter().map(|e| (e.at_ms, e.note, e.velocity > 0)).collect();
        assert_eq!(ev, vec![(0, 60, true), (100, 60, false), (100, 62, true), (150, 62, false)]);
    }

    #[test]
    fn no_player_replies_no_sound_output() {
        let h = PromptHandle::new();
        let acks = collect(&h);
        h.apply(cmd("60:0:100"));
        let a = acks.lock().unwrap();
        assert_eq!(a.len(), 1);
        assert!(a[0].contains("no sound output"));
    }

    #[test]
    fn plays_after_start_time() {
        let h = PromptHandle::new();
        let acks = collect(&h);
        let mut p = h.attach(48000, &SoundProfile::default());
        h.apply(cmd("60:100:200"));
        assert_eq!(acks.lock().unwrap()[0], r#"{"type":"play_ack","id":"q1","ok":true,"notes":1}"#);
        let mut l = vec![0.0f32; 9600];
        let mut r = vec![0.0f32; 9600];
        p.process(&mut l, &mut r);
        assert!(l[..4800].iter().all(|s| *s == 0.0));
        assert!(l[4800..].iter().any(|s| s.abs() > 1e-6));
    }

    #[test]
    fn transpose_drops_out_of_range() {
        let h = PromptHandle::new();
        let acks = collect(&h);
        let _p = h.attach(48000, &SoundProfile::default());
        h.set_transpose(TransposeControl::new(Shift::new(0, 1)));
        h.apply(cmd("60:0:100,120:0:100"));
        assert!(acks.lock().unwrap()[0].ends_with(r#""ok":true,"notes":1}"#));
    }

    #[test]
    fn idle_player_leaves_buffers() {
        let h = PromptHandle::new();
        let mut p = h.attach(48000, &SoundProfile::default());
        let mut l = vec![0.25f32; 480];
        let mut r = vec![0.25f32; 480];
        p.process(&mut l, &mut r);
        assert!(l.iter().chain(r.iter()).all(|s| *s == 0.25));
    }

    #[test]
    fn process_adds() {
        let h = PromptHandle::new();
        let _acks = collect(&h);
        let mut p = h.attach(48000, &SoundProfile::default());
        h.apply(cmd("60:100:200"));
        let mut l = vec![0.25f32; 9600];
        let mut r = vec![0.25f32; 9600];
        p.process(&mut l, &mut r);
        assert!(l[..4800].iter().all(|s| *s == 0.25));
        assert!(l[4800..].iter().any(|s| *s != 0.25));
    }

    #[test]
    fn stop_before_processing_is_silent() {
        let h = PromptHandle::new();
        let mut p = h.attach(48000, &SoundProfile::default());
        h.apply(cmd("60:0:500"));
        h.apply(PromptCommand::Stop);
        let mut l = vec![0.0f32; 48000];
        let mut r = vec![0.0f32; 48000];
        p.process(&mut l, &mut r);
        assert!(l.iter().chain(r.iter()).all(|s| *s == 0.0));
    }

    #[test]
    fn goes_idle() {
        let h = PromptHandle::new();
        let mut p = h.attach(48000, &SoundProfile::default());
        h.apply(cmd("60:0:100"));
        let mut untouched_from = None;
        for i in 0..(48000 * 6 / 480) {
            let mut l = vec![0.5f32; 480];
            let mut r = vec![0.5f32; 480];
            p.process(&mut l, &mut r);
            let same = l.iter().chain(r.iter()).all(|s| *s == 0.5);
            if same && untouched_from.is_none() {
                untouched_from = Some(i);
            }
            if untouched_from.is_some() {
                assert!(same);
            }
        }
        let i = untouched_from.expect("never went idle");
        assert!(i as u64 * 480 <= 48000 * 3 + 480 * 2);
    }

    #[test]
    fn busy_when_queue_full() {
        let h = PromptHandle::new();
        let acks = collect(&h);
        let _p = h.attach(48000, &SoundProfile::default());
        for _ in 0..5 {
            h.apply(cmd("60:0:100"));
        }
        let a = acks.lock().unwrap();
        assert_eq!(a.len(), 5);
        assert!(a[3].contains(r#""ok":true"#));
        assert!(a[4].contains("busy"));
    }

    #[test]
    fn output_is_clamped() {
        let h = PromptHandle::new();
        let mut p = h.attach(48000, &SoundProfile::default());
        let spec = (48..72).map(|n| format!("{n}:0:500:127")).collect::<Vec<_>>().join(",");
        h.apply(cmd(&spec));
        for _ in 0..50 {
            let mut l = vec![0.9f32; 480];
            let mut r = vec![0.9f32; 480];
            p.process(&mut l, &mut r);
            assert!(l.iter().chain(r.iter()).all(|s| s.abs() <= 1.0));
        }
    }

    #[test]
    fn modal_profile_plays() {
        let h = PromptHandle::new();
        let mut p = h.attach(48000, &SoundProfile::Modal(ModalProfile::default()));
        h.apply(cmd("60:0:300"));
        let mut loud = false;
        for _ in 0..30 {
            let mut l = vec![0.0f32; 480];
            let mut r = vec![0.0f32; 480];
            p.process(&mut l, &mut r);
            assert!(l.iter().chain(r.iter()).all(|s| s.is_finite() && s.abs() <= 1.0));
            loud |= l.iter().any(|s| s.abs() > 1e-6);
        }
        assert!(loud);
    }
}
