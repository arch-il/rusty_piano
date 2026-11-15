//! Held keys, pedal and last note for the setup window's 88-key strip, plus the key layout (pure, no window).
use crate::midi::MidiEvent;

pub const LOWEST: u8 = 21; // A0
pub const HIGHEST: u8 = 108; // C8
pub const WHITE_KEYS: usize = 52;
const NAMES: [&str; 12] = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

#[derive(Debug, Clone, PartialEq)]
pub struct KeyboardState {
    held: [bool; 128],
    pub sustain: bool,
    pub last: Option<(u8, u8)>,
}

impl Default for KeyboardState {
    fn default() -> Self {
        Self::new()
    }
}

impl KeyboardState {
    pub fn new() -> Self {
        KeyboardState {
            held: [false; 128],
            sustain: false,
            last: None,
        }
    }

    pub fn apply(&mut self, ev: &MidiEvent) {
        match *ev {
            MidiEvent::NoteOn { note, velocity } => {
                if (note as usize) < 128 {
                    self.held[note as usize] = true;
                    self.last = Some((note, velocity));
                }
            }
            MidiEvent::NoteOff { note } => {
                if (note as usize) < 128 {
                    self.held[note as usize] = false;
                }
            }
            MidiEvent::Sustain { .. } | MidiEvent::Pedal { .. } => {
                if let Some(on) = ev.sustain_on() {
                    self.sustain = on;
                }
            }
        }
    }

    pub fn is_held(&self, note: u8) -> bool {
        (note as usize) < 128 && self.held[note as usize]
    }

    pub fn held_notes(&self) -> Vec<u8> {
        (0..128u8).filter(|n| self.held[*n as usize]).collect()
    }

    pub fn clear(&mut self) {
        *self = Self::new();
    }

    pub fn last_note_text(&self) -> String {
        match self.last {
            None => "-".to_string(),
            Some((note, velocity)) => format!("{} (velocity {velocity})", note_name(note)),
        }
    }
}

pub fn note_name(note: u8) -> String {
    format!("{}{}", NAMES[(note % 12) as usize], (note / 12) as i32 - 1)
}

pub fn is_black_key(note: u8) -> bool {
    matches!(note % 12, 1 | 3 | 6 | 8 | 10)
}

/// Index of a white key from A0 (0) to C8 (51); None for black keys and notes outside 21..=108.
pub fn white_index(note: u8) -> Option<usize> {
    if !(LOWEST..=HIGHEST).contains(&note) || is_black_key(note) {
        return None;
    }
    Some((LOWEST..note).filter(|n| !is_black_key(*n)).count())
}

/// (x from the left edge, width) of a key when white keys are white_w wide. Black keys are white_w / 2 wide and centred on the line after their left white neighbour.
pub fn key_span(note: u8, white_w: f32) -> Option<(f32, f32)> {
    if !(LOWEST..=HIGHEST).contains(&note) {
        return None;
    }
    if is_black_key(note) {
        let left = white_index(note - 1)?;
        Some(((left + 1) as f32 * white_w - white_w / 4.0, white_w / 2.0))
    } else {
        let i = white_index(note)?;
        Some((i as f32 * white_w, white_w))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn note_names() {
        assert_eq!(note_name(21), "A0");
        assert_eq!(note_name(60), "C4");
        assert_eq!(note_name(61), "C#4");
        assert_eq!(note_name(69), "A4");
        assert_eq!(note_name(108), "C8");
    }

    #[test]
    fn black_and_white_keys() {
        assert!(is_black_key(61));
        assert!(is_black_key(22));
        assert!(!is_black_key(60));
        assert!(!is_black_key(21));
        let all: Vec<u8> = (LOWEST..=HIGHEST).collect();
        let whites = all.iter().filter(|n| !is_black_key(**n)).count();
        assert_eq!(whites, WHITE_KEYS);
        assert_eq!(all.len() - whites, 36);
    }

    #[test]
    fn white_indexes() {
        assert_eq!(white_index(21), Some(0));
        assert_eq!(white_index(23), Some(1));
        assert_eq!(white_index(24), Some(2));
        assert_eq!(white_index(60), Some(23));
        assert_eq!(white_index(108), Some(51));
        assert_eq!(white_index(22), None);
        assert_eq!(white_index(20), None);
        assert_eq!(white_index(109), None);
    }

    #[test]
    fn key_spans() {
        assert_eq!(key_span(21, 10.0), Some((0.0, 10.0)));
        assert_eq!(key_span(108, 10.0), Some((510.0, 10.0)));
        assert_eq!(key_span(60, 10.0), Some((230.0, 10.0)));
        assert_eq!(key_span(22, 10.0), Some((7.5, 5.0)));
        assert_eq!(key_span(61, 10.0), Some((237.5, 5.0)));
        assert_eq!(key_span(20, 10.0), None);
    }

    #[test]
    fn pedal_values_set_sustain_display() {
        use crate::midi::Pedal;
        let mut k = KeyboardState::new();
        k.apply(&MidiEvent::Pedal { pedal: Pedal::Sustain, value: 100 });
        assert!(k.sustain);
        k.apply(&MidiEvent::Pedal { pedal: Pedal::Sustain, value: 63 });
        assert!(!k.sustain);
        k.apply(&MidiEvent::Pedal { pedal: Pedal::Soft, value: 127 });
        k.apply(&MidiEvent::Pedal { pedal: Pedal::Sostenuto, value: 127 });
        assert!(!k.sustain);
    }

    #[test]
    fn state_follows_events() {
        let mut k = KeyboardState::new();
        k.apply(&MidiEvent::NoteOn { note: 64, velocity: 70 });
        k.apply(&MidiEvent::NoteOn { note: 60, velocity: 100 });
        assert_eq!(k.held_notes(), vec![60, 64]);
        assert!(k.is_held(60));
        assert_eq!(k.last_note_text(), "C4 (velocity 100)");
        k.apply(&MidiEvent::NoteOff { note: 60 });
        assert!(!k.is_held(60));
        assert_eq!(k.held_notes(), vec![64]);
        assert_eq!(k.last, Some((60, 100)));
        k.apply(&MidiEvent::Sustain { on: true });
        assert!(k.sustain);
        k.apply(&MidiEvent::Sustain { on: false });
        assert!(!k.sustain);
        k.apply(&MidiEvent::NoteOn { note: 200, velocity: 1 });
        assert!(!k.is_held(200));
        k.clear();
        assert_eq!(k, KeyboardState::new());
        assert_eq!(k.last_note_text(), "-");
    }
}
