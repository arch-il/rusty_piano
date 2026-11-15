//! MIDI events used by the engine.
//!
//! Parses raw MIDI bytes delivered by midir and selects the input port
//! (the Studiologic SL990 by default).

/// A piano pedal: CC64 damper/sustain pedal, CC66 sostenuto, CC67 soft (una corda).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pedal {
    Sustain,
    Sostenuto,
    Soft,
}

impl Pedal {
    pub fn cc(self) -> u8 {
        match self {
            Pedal::Sustain => 64,
            Pedal::Sostenuto => 66,
            Pedal::Soft => 67,
        }
    }

    pub fn from_cc(cc: u8) -> Option<Pedal> {
        match cc {
            64 => Some(Pedal::Sustain),
            66 => Some(Pedal::Sostenuto),
            67 => Some(Pedal::Soft),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Pedal::Sustain => "sustain",
            Pedal::Sostenuto => "sostenuto",
            Pedal::Soft => "soft",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MidiEvent {
    NoteOn { note: u8, velocity: u8 },
    NoteOff { note: u8 },
    /// Binary sustain used by built-in sequences and tests; means the same as
    /// `Pedal { pedal: Sustain, value: 127 or 0 }`.
    Sustain { on: bool },
    /// Pedal position 0-127 from a MIDI control change, 0 = up.
    Pedal { pedal: Pedal, value: u8 },
}

impl MidiEvent {
    /// The sustain state this event sets, if it is a sustain event.
    pub fn sustain_on(&self) -> Option<bool> {
        match *self {
            MidiEvent::Sustain { on } => Some(on),
            MidiEvent::Pedal {
                pedal: Pedal::Sustain,
                value,
            } => Some(value >= 64),
            _ => None,
        }
    }

    /// The pedal and its position, if this is a pedal event.
    pub fn pedal_value(&self) -> Option<(Pedal, u8)> {
        match *self {
            MidiEvent::Sustain { on } => Some((Pedal::Sustain, if on { 127 } else { 0 })),
            MidiEvent::Pedal { pedal, value } => Some((pedal, value)),
            _ => None,
        }
    }

    /// The form a MIDI file round trip returns: `Sustain` becomes a `Pedal`.
    pub fn canonical(self) -> MidiEvent {
        match self {
            MidiEvent::Sustain { on } => MidiEvent::Pedal {
                pedal: Pedal::Sustain,
                value: if on { 127 } else { 0 },
            },
            other => other,
        }
    }
}

pub const DEFAULT_PORT_MATCH: &str = "SL990";

/// Parses one complete MIDI message. midir delivers complete messages, so a
/// leading data byte (running status) is treated as unsupported and yields `None`.
pub fn parse_message(bytes: &[u8]) -> Option<MidiEvent> {
    let status = *bytes.first()?;
    if status < 0x80 {
        return None;
    }
    let kind = status & 0xF0;
    match kind {
        0x90 | 0x80 | 0xB0 => {
            if bytes.len() < 3 || bytes[1] >= 0x80 || bytes[2] >= 0x80 {
                return None;
            }
            let (data1, data2) = (bytes[1], bytes[2]);
            match kind {
                0x90 if data2 == 0 => Some(MidiEvent::NoteOff { note: data1 }),
                0x90 => Some(MidiEvent::NoteOn {
                    note: data1,
                    velocity: data2,
                }),
                0x80 => Some(MidiEvent::NoteOff { note: data1 }),
                _ => Pedal::from_cc(data1).map(|pedal| MidiEvent::Pedal {
                    pedal,
                    value: data2,
                }),
            }
        }
        _ => None,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PortSelectError {
    NoPorts,
    IndexOutOfRange { index: usize, count: usize },
    NoMatch { pattern: String },
}

impl std::fmt::Display for PortSelectError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PortSelectError::NoPorts => write!(f, "No MIDI input ports found."),
            PortSelectError::IndexOutOfRange { index, count } => write!(
                f,
                "Port index {index} is out of range ({count} input ports)."
            ),
            PortSelectError::NoMatch { pattern } => {
                write!(f, "No MIDI input port matching \"{pattern}\" found.")
            }
        }
    }
}

impl std::error::Error for PortSelectError {}

/// Selects an input port by index or by case-insensitive name substring.
/// With no `wanted` pattern, the default `DEFAULT_PORT_MATCH` is used.
pub fn select_port(names: &[String], wanted: Option<&str>) -> Result<usize, PortSelectError> {
    if names.is_empty() {
        return Err(PortSelectError::NoPorts);
    }
    let pattern = wanted.map(str::trim).unwrap_or(DEFAULT_PORT_MATCH);
    if let Ok(index) = pattern.parse::<usize>() {
        return if index < names.len() {
            Ok(index)
        } else {
            Err(PortSelectError::IndexOutOfRange {
                index,
                count: names.len(),
            })
        };
    }
    if pattern.is_empty() {
        return Err(PortSelectError::NoMatch {
            pattern: String::new(),
        });
    }
    let needle = pattern.to_lowercase();
    names
        .iter()
        .position(|name| name.to_lowercase().contains(&needle))
        .ok_or_else(|| PortSelectError::NoMatch {
            pattern: pattern.to_string(),
        })
}

/// Built-in demo: (ms from start, event), played by `--demo`.
pub fn demo_sequence() -> Vec<(u64, MidiEvent)> {
    vec![
        (0, MidiEvent::NoteOn { note: 60, velocity: 40 }),
        (220, MidiEvent::NoteOff { note: 60 }),
        (250, MidiEvent::NoteOn { note: 64, velocity: 70 }),
        (470, MidiEvent::NoteOff { note: 64 }),
        (500, MidiEvent::NoteOn { note: 67, velocity: 100 }),
        (720, MidiEvent::NoteOff { note: 67 }),
        (750, MidiEvent::NoteOn { note: 72, velocity: 127 }),
        (970, MidiEvent::NoteOff { note: 72 }),
        (1250, MidiEvent::NoteOn { note: 48, velocity: 100 }),
        (1250, MidiEvent::NoteOn { note: 60, velocity: 100 }),
        (1250, MidiEvent::NoteOn { note: 64, velocity: 100 }),
        (1250, MidiEvent::NoteOn { note: 67, velocity: 100 }),
        (2750, MidiEvent::NoteOff { note: 48 }),
        (2750, MidiEvent::NoteOff { note: 60 }),
        (2750, MidiEvent::NoteOff { note: 64 }),
        (2750, MidiEvent::NoteOff { note: 67 }),
        (3250, MidiEvent::Sustain { on: true }),
        (3300, MidiEvent::NoteOn { note: 72, velocity: 80 }),
        (3400, MidiEvent::NoteOff { note: 72 }),
        (3500, MidiEvent::NoteOn { note: 76, velocity: 80 }),
        (3600, MidiEvent::NoteOff { note: 76 }),
        (3700, MidiEvent::NoteOn { note: 79, velocity: 80 }),
        (3800, MidiEvent::NoteOff { note: 79 }),
        (3900, MidiEvent::NoteOn { note: 84, velocity: 80 }),
        (4000, MidiEvent::NoteOff { note: 84 }),
        (5500, MidiEvent::Sustain { on: false }),
    ]
}

impl std::fmt::Display for MidiEvent {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MidiEvent::NoteOn { note, velocity } => {
                write!(f, "NoteOn note={note} vel={velocity}")
            }
            MidiEvent::NoteOff { note } => write!(f, "NoteOff note={note}"),
            MidiEvent::Sustain { on: true } => write!(f, "Sustain on"),
            MidiEvent::Sustain { on: false } => write!(f, "Sustain off"),
            MidiEvent::Pedal { pedal, value } => write!(f, "Pedal {} {value}", pedal.name()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn note_on_any_channel() {
        assert_eq!(
            parse_message(&[0x90, 60, 100]),
            Some(MidiEvent::NoteOn {
                note: 60,
                velocity: 100
            })
        );
        assert_eq!(
            parse_message(&[0x9F, 60, 100]),
            Some(MidiEvent::NoteOn {
                note: 60,
                velocity: 100
            })
        );
    }

    #[test]
    fn velocity_zero_note_on_is_note_off() {
        assert_eq!(
            parse_message(&[0x90, 60, 0]),
            Some(MidiEvent::NoteOff { note: 60 })
        );
        assert_eq!(
            parse_message(&[0x93, 72, 0]),
            Some(MidiEvent::NoteOff { note: 72 })
        );
    }

    #[test]
    fn note_off_message() {
        assert_eq!(
            parse_message(&[0x80, 60, 40]),
            Some(MidiEvent::NoteOff { note: 60 })
        );
        assert_eq!(
            parse_message(&[0x8F, 61, 0]),
            Some(MidiEvent::NoteOff { note: 61 })
        );
    }

    #[test]
    fn sustain_on_off_threshold() {
        let ev = parse_message(&[0xB0, 64, 127]).unwrap();
        assert_eq!(
            ev,
            MidiEvent::Pedal {
                pedal: Pedal::Sustain,
                value: 127
            }
        );
        assert_eq!(ev.sustain_on(), Some(true));
        assert_eq!(
            parse_message(&[0xB0, 64, 64]).unwrap().sustain_on(),
            Some(true)
        );
        assert_eq!(
            parse_message(&[0xB5, 64, 63]).unwrap().sustain_on(),
            Some(false)
        );
        assert_eq!(
            parse_message(&[0xB0, 64, 0]).unwrap().sustain_on(),
            Some(false)
        );
    }

    #[test]
    fn pedal_controls_parse_with_value() {
        assert_eq!(
            parse_message(&[0xB0, 66, 100]),
            Some(MidiEvent::Pedal {
                pedal: Pedal::Sostenuto,
                value: 100
            })
        );
        assert_eq!(
            parse_message(&[0xB3, 67, 0]),
            Some(MidiEvent::Pedal {
                pedal: Pedal::Soft,
                value: 0
            })
        );
        assert_eq!(parse_message(&[0xB0, 65, 127]), None);
        assert_eq!(parse_message(&[0xB0, 68, 127]), None);
        assert_eq!(
            MidiEvent::Sustain { on: false }.pedal_value(),
            Some((Pedal::Sustain, 0))
        );
        assert_eq!(
            MidiEvent::Sustain { on: true }.canonical(),
            MidiEvent::Pedal {
                pedal: Pedal::Sustain,
                value: 127
            }
        );
        let on = MidiEvent::NoteOn {
            note: 60,
            velocity: 90,
        };
        assert_eq!(on.sustain_on(), None);
        assert_eq!(on.canonical(), on);
        assert_eq!(
            MidiEvent::Pedal {
                pedal: Pedal::Soft,
                value: 127
            }
            .sustain_on(),
            None
        );
    }

    #[test]
    fn other_cc_ignored() {
        assert_eq!(parse_message(&[0xB0, 1, 64]), None);
        assert_eq!(parse_message(&[0xB0, 7, 100]), None);
    }

    #[test]
    fn ignores_short_empty_and_other_messages() {
        let cases: [&[u8]; 10] = [
            &[],
            &[0x90, 60],
            &[0x3C, 100, 0],
            &[0x90, 0x80, 0x40],
            &[0xF8],
            &[0xFE],
            &[0xF0, 0x7E, 0x7F, 0xF7],
            &[0xC0, 5],
            &[0xE0, 0, 64],
            &[0xD0, 50],
        ];
        for bytes in cases {
            assert_eq!(parse_message(bytes), None, "bytes: {bytes:?}");
        }
    }

    #[test]
    fn display_format() {
        assert_eq!(
            MidiEvent::NoteOn {
                note: 60,
                velocity: 100
            }
            .to_string(),
            "NoteOn note=60 vel=100"
        );
        assert_eq!(MidiEvent::NoteOff { note: 60 }.to_string(), "NoteOff note=60");
        assert_eq!(MidiEvent::Sustain { on: true }.to_string(), "Sustain on");
        assert_eq!(MidiEvent::Sustain { on: false }.to_string(), "Sustain off");
        assert_eq!(
            MidiEvent::Pedal {
                pedal: Pedal::Sostenuto,
                value: 64
            }
            .to_string(),
            "Pedal sostenuto 64"
        );
    }

    #[test]
    fn select_port_default_finds_sl990_case_insensitive() {
        assert_eq!(
            select_port(&names(&["USB MIDI", "Studiologic sl990 MIDI 1"]), None),
            Ok(1)
        );
        assert_eq!(
            select_port(&names(&["SL990", "MIDIIN2 (SL990)"]), None),
            Ok(0)
        );
    }

    #[test]
    fn select_port_by_index() {
        let list = names(&["A", "B", "C"]);
        assert_eq!(select_port(&list, Some("2")), Ok(2));
        assert_eq!(select_port(&list, Some(" 0 ")), Ok(0));
        assert_eq!(
            select_port(&list, Some("3")),
            Err(PortSelectError::IndexOutOfRange { index: 3, count: 3 })
        );
    }

    #[test]
    fn select_port_by_name_substring() {
        let list = names(&["Microsoft GS Wavetable", "Generic USB Keyboard"]);
        assert_eq!(select_port(&list, Some("usb")), Ok(1));
    }

    #[test]
    fn select_port_no_ports() {
        let empty: Vec<String> = Vec::new();
        assert_eq!(select_port(&empty, None), Err(PortSelectError::NoPorts));
        assert_eq!(select_port(&empty, Some("0")), Err(PortSelectError::NoPorts));
    }

    #[test]
    fn select_port_no_match() {
        let list = names(&["USB MIDI"]);
        assert_eq!(
            select_port(&list, None),
            Err(PortSelectError::NoMatch {
                pattern: "SL990".to_string()
            })
        );
        let err = select_port(&list, Some("zz")).unwrap_err();
        assert_eq!(
            err,
            PortSelectError::NoMatch {
                pattern: "zz".to_string()
            }
        );
        assert!(err.to_string().contains("No MIDI input port matching"));
    }

    #[test]
    fn demo_sequence_is_ordered_and_balanced() {
        let seq = demo_sequence();
        assert!(seq.windows(2).all(|w| w[0].0 <= w[1].0));
        let mut down = [false; 128];
        for (_, ev) in &seq {
            match *ev {
                MidiEvent::NoteOn { note, .. } => {
                    assert!(!down[note as usize], "note {note} pressed twice");
                    down[note as usize] = true;
                }
                MidiEvent::NoteOff { note } => {
                    assert!(down[note as usize], "note {note} released while up");
                    down[note as usize] = false;
                }
                MidiEvent::Sustain { .. } | MidiEvent::Pedal { .. } => {}
            }
        }
        assert!(down.iter().all(|d| !d));
        let (last_ms, last_ev) = seq.last().unwrap();
        assert_eq!(*last_ev, MidiEvent::Sustain { on: false });
        assert!(*last_ms <= 6000);
    }

    #[test]
    fn demo_sequence_uses_sustain_and_varied_velocity() {
        let seq = demo_sequence();
        assert!(seq.iter().any(|(_, ev)| *ev == MidiEvent::Sustain { on: true }));
        assert!(seq.iter().any(|(_, ev)| *ev == MidiEvent::Sustain { on: false }));
        let mut velocities: Vec<u8> = seq
            .iter()
            .filter_map(|(_, ev)| match ev {
                MidiEvent::NoteOn { velocity, .. } => Some(*velocity),
                _ => None,
            })
            .collect();
        velocities.sort();
        velocities.dedup();
        assert!(velocities.len() >= 3);
        assert!(seq.iter().all(|(_, ev)| match ev {
            MidiEvent::NoteOn { note, .. } | MidiEvent::NoteOff { note } => (21..=108).contains(note),
            MidiEvent::Sustain { .. } | MidiEvent::Pedal { .. } => true,
        }));
    }
}
