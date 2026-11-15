//! Audio-thread extras applied after the sound engine: the metronome click, ear-training prompts and the WAV tap (the WAV contains neither click nor prompts). They are attached to a running stream through a small queue, so AudioOutput::start keeps its signature.

use crate::metronome::Metronome;
use crate::wav_record::WavTap;
use std::sync::mpsc::Receiver;
use std::time::Instant;

pub const ATTACH_QUEUE_CAPACITY: usize = 4;

pub enum Attach {
    Metronome(Box<Metronome>),
    Wav(Box<WavTap>),
    Prompt(Box<crate::prompt::PromptPlayer>),
}

#[derive(Default)]
pub struct OutputExtras {
    metronome: Option<Box<Metronome>>,
    wav: Option<Box<WavTap>>,
    prompt: Option<Box<crate::prompt::PromptPlayer>>,
}

impl OutputExtras {
    /// Attach each kind once per stream; a second one replaces the first. The session attaches the WAV tap exactly once per stream, so the replaced box (dropped here) never happens in practice.
    pub fn receive(&mut self, rx: &Receiver<Attach>) {
        while let Ok(a) = rx.try_recv() {
            match a {
                Attach::Metronome(m) => self.metronome = Some(m),
                Attach::Wav(w) => self.wav = Some(w),
                Attach::Prompt(p) => self.prompt = Some(p),
            }
        }
    }

    pub fn is_empty(&self) -> bool {
        self.metronome.is_none() && self.wav.is_none() && self.prompt.is_none()
    }

    /// The WAV tap copies the chunk BEFORE the prompt player and the metronome add their sound, so the recording contains neither prompts nor click.
    pub fn process(
        &mut self,
        left: &mut [f32],
        right: &mut [f32],
        block_start: Instant,
        offset_frames: usize,
    ) {
        if let Some(w) = self.wav.as_mut() {
            w.push(left, right);
        }
        if let Some(p) = self.prompt.as_mut() {
            p.process(left, right);
        }
        if let Some(m) = self.metronome.as_mut() {
            m.process(left, right, block_start, offset_frames);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::metronome::{MetronomeHandle, MetronomeSettings};
    use crate::wav_record::channels;
    use std::sync::mpsc::sync_channel;

    #[test]
    fn wav_tap_is_before_click() {
        let handle = MetronomeHandle::new(MetronomeSettings {
            on: true,
            bpm: 120,
            beats_per_bar: 4,
            volume: 100,
        });
        let (m, _notices) = handle.attach(48000);
        let (tap, ends) = channels(4);
        let (atx, arx) = sync_channel(ATTACH_QUEUE_CAPACITY);
        atx.send(Attach::Metronome(Box::new(m))).unwrap();
        atx.send(Attach::Wav(Box::new(tap))).unwrap();
        let mut extras = OutputExtras::default();
        extras.receive(&arx);
        assert!(!extras.is_empty());
        let mut left = vec![0.0f32; 256];
        let mut right = vec![0.0f32; 256];
        extras.process(&mut left, &mut right, Instant::now(), 0);
        assert!(left.iter().any(|s| s.abs() > 0.01));
        let block = ends.full.try_recv().unwrap();
        assert_eq!(block.frames(), 256);
        assert!(block.samples().iter().all(|s| *s == 0.0));
    }

    #[test]
    fn prompt_is_after_wav_tap() {
        use crate::config::SoundProfile;
        use crate::prompt::{parse_command, PromptHandle};
        let handle = PromptHandle::new();
        let player = handle.attach(48000, &SoundProfile::default());
        handle.apply(parse_command(r#"{"type":"play_notes","id":"q1","notes":"60:0:500"}"#).unwrap());
        let (tap, ends) = channels(4);
        let (atx, arx) = sync_channel(ATTACH_QUEUE_CAPACITY);
        atx.send(Attach::Prompt(Box::new(player))).unwrap();
        atx.send(Attach::Wav(Box::new(tap))).unwrap();
        let mut extras = OutputExtras::default();
        extras.receive(&arx);
        assert!(!extras.is_empty());
        let mut left = vec![0.0f32; 256];
        let mut right = vec![0.0f32; 256];
        extras.process(&mut left, &mut right, Instant::now(), 0);
        assert!(left.iter().any(|s| s.abs() > 1e-6));
        let block = ends.full.try_recv().unwrap();
        assert_eq!(block.frames(), 256);
        assert!(block.samples().iter().all(|s| *s == 0.0));
    }
}
