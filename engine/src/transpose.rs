//! Transpose and octave shift for the sound only: the recorder, live events and key strip keep the keys you pressed.

use crate::midi::MidiEvent;
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::Arc;

pub const MAX_SEMITONES: i8 = 12;
pub const MAX_OCTAVES: i8 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Shift {
    pub semitones: i8,
    pub octaves: i8,
}

impl Shift {
    pub fn new(semitones: i32, octaves: i32) -> Shift {
        Shift {
            semitones: semitones.clamp(-(MAX_SEMITONES as i32), MAX_SEMITONES as i32) as i8,
            octaves: octaves.clamp(-(MAX_OCTAVES as i32), MAX_OCTAVES as i32) as i8,
        }
    }

    pub fn total(self) -> i32 {
        self.semitones as i32 + 12 * self.octaves as i32
    }

    pub fn is_zero(self) -> bool {
        self.semitones == 0 && self.octaves == 0
    }

    pub fn label(self) -> String {
        if self.is_zero() {
            return "off".to_string();
        }
        let mut parts = Vec::new();
        if self.semitones != 0 {
            let s = if self.semitones.abs() == 1 { "" } else { "s" };
            parts.push(format!("{:+} semitone{}", self.semitones, s));
        }
        if self.octaves != 0 {
            let s = if self.octaves.abs() == 1 { "" } else { "s" };
            parts.push(format!("{:+} octave{}", self.octaves, s));
        }
        parts.join(", ")
    }
}

pub struct TransposeControl {
    packed: AtomicU16,
}

fn pack(shift: Shift) -> u16 {
    (shift.semitones as u8 as u16) | ((shift.octaves as u8 as u16) << 8)
}

fn unpack(v: u16) -> Shift {
    Shift { semitones: (v & 0xff) as u8 as i8, octaves: (v >> 8) as u8 as i8 }
}

impl TransposeControl {
    pub fn new(shift: Shift) -> Arc<TransposeControl> {
        let shift = Shift::new(shift.semitones as i32, shift.octaves as i32);
        Arc::new(TransposeControl { packed: AtomicU16::new(pack(shift)) })
    }

    pub fn get(&self) -> Shift {
        unpack(self.packed.load(Ordering::Relaxed))
    }

    pub fn set(&self, shift: Shift) {
        let shift = Shift::new(shift.semitones as i32, shift.octaves as i32);
        self.packed.store(pack(shift), Ordering::Relaxed);
    }

    pub fn nudge(&self, semitones: i32, octaves: i32) -> Shift {
        let mut new = Shift::default();
        let _ = self.packed.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |v| {
            let cur = unpack(v);
            new = Shift::new(cur.semitones as i32 + semitones, cur.octaves as i32 + octaves);
            Some(pack(new))
        });
        new
    }
}

#[derive(Clone, Copy)]
enum Key {
    Up,
    Sounding(u8),
    Dropped,
}

pub struct Transposer {
    keys: [Key; 128],
    sounding: [u8; 128],
}

impl Default for Transposer {
    fn default() -> Self {
        Transposer { keys: [Key::Up; 128], sounding: [0; 128] }
    }
}

impl Transposer {
    pub fn new() -> Transposer {
        Transposer::default()
    }

    pub fn map(&mut self, ev: MidiEvent, total: i32) -> Option<MidiEvent> {
        match ev {
            MidiEvent::NoteOn { note, velocity: 0 } => self.map(MidiEvent::NoteOff { note }, total),
            MidiEvent::NoteOn { note, velocity } => {
                let slot = &mut self.keys[(note & 0x7f) as usize];
                match *slot {
                    Key::Sounding(s) => Some(MidiEvent::NoteOn { note: s, velocity }),
                    Key::Dropped => None,
                    Key::Up => {
                        let target = note as i32 + total;
                        if (0..=127).contains(&target) {
                            *slot = Key::Sounding(target as u8);
                            self.sounding[target as usize] = self.sounding[target as usize].saturating_add(1);
                            Some(MidiEvent::NoteOn { note: target as u8, velocity })
                        } else {
                            *slot = Key::Dropped;
                            None
                        }
                    }
                }
            }
            MidiEvent::NoteOff { note } => {
                let slot = &mut self.keys[(note & 0x7f) as usize];
                match *slot {
                    Key::Sounding(s) => {
                        *slot = Key::Up;
                        let count = &mut self.sounding[(s & 0x7f) as usize];
                        *count = count.saturating_sub(1);
                        if *count == 0 {
                            Some(MidiEvent::NoteOff { note: s })
                        } else {
                            None
                        }
                    }
                    Key::Dropped => {
                        *slot = Key::Up;
                        None
                    }
                    Key::Up => {
                        let target = note as i32 + total;
                        if (0..=127).contains(&target) {
                            Some(MidiEvent::NoteOff { note: target as u8 })
                        } else {
                            None
                        }
                    }
                }
            }
            other => Some(other),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::midi::Pedal;

    fn sh(s: i8, o: i8) -> Shift {
        Shift { semitones: s, octaves: o }
    }

    #[test]
    fn shift_clamps_and_totals() {
        assert_eq!(Shift::new(15, -3), sh(12, -2));
        assert_eq!(sh(3, -1).total(), -9);
        assert_eq!(Shift::new(-12, 2).total(), 12);
    }

    #[test]
    fn shift_labels() {
        assert_eq!(Shift::default().label(), "off");
        assert_eq!(sh(1, 0).label(), "+1 semitone");
        assert_eq!(sh(-3, 0).label(), "-3 semitones");
        assert_eq!(sh(0, 2).label(), "+2 octaves");
        assert_eq!(sh(3, -1).label(), "+3 semitones, -1 octave");
        assert_eq!(sh(-1, 1).label(), "-1 semitone, +1 octave");
    }

    #[test]
    fn control_set_get_nudge() {
        let c = TransposeControl::new(Shift::default());
        assert_eq!(c.get(), Shift::default());
        assert_eq!(c.nudge(5, 0), sh(5, 0));
        assert_eq!(c.nudge(10, 3), sh(12, 2));
        c.set(sh(-20, 0));
        assert_eq!(c.get(), sh(-12, 0));
    }

    #[test]
    fn pack_unpack_round_trips_and_set_get_is_exact() {
        let c = TransposeControl::new(Shift::default());
        for s in -MAX_SEMITONES..=MAX_SEMITONES {
            for o in -MAX_OCTAVES..=MAX_OCTAVES {
                assert_eq!(unpack(pack(sh(s, o))), sh(s, o));
                c.set(sh(s, o));
                assert_eq!(c.get(), sh(s, o));
            }
        }
    }

    #[test]
    fn shared_output_note_is_released_by_last_key() {
        let mut t = Transposer::new();
        assert_eq!(
            t.map(MidiEvent::NoteOn { note: 60, velocity: 90 }, 0),
            Some(MidiEvent::NoteOn { note: 60, velocity: 90 })
        );
        assert_eq!(
            t.map(MidiEvent::NoteOn { note: 48, velocity: 80 }, 12),
            Some(MidiEvent::NoteOn { note: 60, velocity: 80 })
        );
        assert_eq!(t.map(MidiEvent::NoteOff { note: 60 }, 12), None);
        assert_eq!(
            t.map(MidiEvent::NoteOff { note: 48 }, 12),
            Some(MidiEvent::NoteOff { note: 60 })
        );
    }

    #[test]
    fn zero_shift_is_identity() {
        let mut t = Transposer::new();
        let evs = [
            MidiEvent::NoteOn { note: 60, velocity: 90 },
            MidiEvent::NoteOff { note: 60 },
            MidiEvent::Sustain { on: true },
            MidiEvent::Pedal { pedal: Pedal::Soft, value: 40 },
        ];
        for ev in evs {
            assert_eq!(t.map(ev, 0), Some(ev));
        }
    }

    #[test]
    fn note_off_uses_shift_from_note_on() {
        let mut t = Transposer::new();
        assert_eq!(
            t.map(MidiEvent::NoteOn { note: 60, velocity: 90 }, 3),
            Some(MidiEvent::NoteOn { note: 63, velocity: 90 })
        );
        assert_eq!(
            t.map(MidiEvent::NoteOff { note: 60 }, -5),
            Some(MidiEvent::NoteOff { note: 63 })
        );
    }

    #[test]
    fn out_of_range_notes_are_dropped_with_their_note_off() {
        let mut t = Transposer::new();
        assert_eq!(t.map(MidiEvent::NoteOn { note: 120, velocity: 80 }, 12), None);
        assert_eq!(t.map(MidiEvent::NoteOff { note: 120 }, 0), None);
        assert_eq!(t.map(MidiEvent::NoteOn { note: 5, velocity: 80 }, -12), None);
        assert_eq!(
            t.map(MidiEvent::NoteOn { note: 120, velocity: 80 }, 0),
            Some(MidiEvent::NoteOn { note: 120, velocity: 80 })
        );
    }

    #[test]
    fn repeated_note_on_reuses_sounding_note() {
        let mut t = Transposer::new();
        assert_eq!(
            t.map(MidiEvent::NoteOn { note: 60, velocity: 80 }, 3),
            Some(MidiEvent::NoteOn { note: 63, velocity: 80 })
        );
        assert_eq!(
            t.map(MidiEvent::NoteOn { note: 60, velocity: 80 }, 5),
            Some(MidiEvent::NoteOn { note: 63, velocity: 80 })
        );
        assert_eq!(
            t.map(MidiEvent::NoteOff { note: 60 }, 5),
            Some(MidiEvent::NoteOff { note: 63 })
        );
        assert_eq!(
            t.map(MidiEvent::NoteOff { note: 60 }, 5),
            Some(MidiEvent::NoteOff { note: 65 })
        );
    }

    #[test]
    fn pedals_pass_unchanged() {
        let mut t = Transposer::new();
        let a = MidiEvent::Sustain { on: true };
        let b = MidiEvent::Pedal { pedal: Pedal::Soft, value: 40 };
        assert_eq!(t.map(a, 7), Some(a));
        assert_eq!(t.map(b, 7), Some(b));
    }

    #[test]
    fn velocity_zero_note_on_acts_as_note_off() {
        let mut t = Transposer::new();
        assert_eq!(
            t.map(MidiEvent::NoteOn { note: 60, velocity: 90 }, 3),
            Some(MidiEvent::NoteOn { note: 63, velocity: 90 })
        );
        assert_eq!(
            t.map(MidiEvent::NoteOn { note: 60, velocity: 0 }, 9),
            Some(MidiEvent::NoteOff { note: 63 })
        );
    }
}
