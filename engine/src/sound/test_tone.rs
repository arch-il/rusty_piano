use super::SoundEngine;
use crate::midi::MidiEvent;
use std::f32::consts::TAU;

struct Voice {
    note: u8,
    phase: f32,
    step: f32,
    amp: f32,
}

pub struct TestTone {
    sample_rate: u32,
    voices: Vec<Voice>,
}

impl TestTone {
    pub fn new(sample_rate: u32) -> Self {
        Self {
            sample_rate,
            voices: Vec::new(),
        }
    }
}

impl SoundEngine for TestTone {
    fn handle(&mut self, ev: &MidiEvent) {
        match *ev {
            MidiEvent::NoteOn { note, velocity } => {
                self.voices.retain(|v| v.note != note);
                let freq = 440.0_f32 * 2.0_f32.powf((note as f32 - 69.0) / 12.0);
                self.voices.push(Voice {
                    note,
                    phase: 0.0,
                    step: TAU * freq / self.sample_rate as f32,
                    amp: velocity as f32 / 127.0 * 0.2,
                });
            }
            MidiEvent::NoteOff { note } => self.voices.retain(|v| v.note != note),
            MidiEvent::Sustain { .. } | MidiEvent::Pedal { .. } => {}
        }
    }

    fn render(&mut self, out: &mut [f32]) {
        for s in out.iter_mut() {
            *s = 0.0;
        }
        for v in self.voices.iter_mut() {
            for s in out.iter_mut() {
                *s += v.amp * v.phase.sin();
                v.phase += v.step;
                if v.phase >= TAU {
                    v.phase -= TAU;
                }
            }
        }
    }

    fn render_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
        let n = left.len().min(right.len());
        self.render(&mut left[..n]);
        right[..n].copy_from_slice(&left[..n]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn silence_without_notes() {
        let mut t = TestTone::new(48000);
        let mut buf = [1.0f32; 256];
        t.render(&mut buf);
        assert!(buf.iter().all(|&s| s == 0.0));
    }

    #[test]
    fn note_on_makes_sound_and_off_silences() {
        let mut t = TestTone::new(48000);
        t.handle(&MidiEvent::NoteOn { note: 69, velocity: 127 });
        let mut buf = [0.0f32; 1024];
        t.render(&mut buf);
        let peak = buf.iter().fold(0.0f32, |m, s| m.max(s.abs()));
        assert!(peak > 0.0);
        assert!(peak <= 0.2 + 1e-6);
        t.handle(&MidiEvent::NoteOff { note: 69 });
        t.render(&mut buf);
        assert!(buf.iter().all(|&s| s == 0.0));
    }

    #[test]
    fn note_69_is_440hz() {
        let mut t = TestTone::new(48000);
        t.handle(&MidiEvent::NoteOn { note: 69, velocity: 100 });
        let mut buf = vec![0.0f32; 48000];
        t.render(&mut buf);
        let crossings = buf
            .windows(2)
            .filter(|w| w[0] <= 0.0 && w[1] > 0.0)
            .count();
        assert!((crossings as i32 - 440).abs() <= 2, "got {crossings}");
    }

    #[test]
    fn stereo_channels_are_identical() {
        let on = MidiEvent::NoteOn { note: 69, velocity: 100 };
        let mut a = TestTone::new(48000);
        let mut b = TestTone::new(48000);
        a.handle(&on);
        b.handle(&on);
        let mut left = vec![0.0f32; 4800];
        let mut right = vec![0.0f32; 4800];
        a.render_stereo(&mut left, &mut right);
        let mut mono = vec![0.0f32; 4800];
        b.render(&mut mono);
        assert_eq!(left, right);
        assert!(left.iter().any(|&s| s != 0.0));
        assert_eq!(left, mono);
    }
}
