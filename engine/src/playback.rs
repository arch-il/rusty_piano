//! Playback of Standard MIDI Files.
//!
//! Reads format 0 and 1 files (ticks-per-quarter division) and turns their
//! note and sustain messages into timed `MidiEvent`s, so recorded sessions
//! can be played back through the engine.

use crate::midi::{parse_message, MidiEvent};
use std::path::{Path, PathBuf};

const DEFAULT_TEMPO: u64 = 500_000;

enum Item {
    Tempo(u64),
    Event(MidiEvent),
}

struct Reader<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn byte(&mut self) -> Result<u8, String> {
        let b = *self.data.get(self.pos).ok_or("truncated track")?;
        self.pos += 1;
        Ok(b)
    }

    fn take(&mut self, n: usize) -> Result<&'a [u8], String> {
        let end = self.pos.checked_add(n).ok_or("truncated track")?;
        let s = self.data.get(self.pos..end).ok_or("truncated track")?;
        self.pos = end;
        Ok(s)
    }

    fn vlq(&mut self) -> Result<u32, String> {
        let mut value = 0u32;
        for _ in 0..4 {
            let b = self.byte()?;
            value = (value << 7) | (b & 0x7F) as u32;
            if b & 0x80 == 0 {
                return Ok(value);
            }
        }
        Err("bad variable-length number".to_string())
    }

    fn done(&self) -> bool {
        self.pos >= self.data.len()
    }
}

fn parse_track(data: &[u8], out: &mut Vec<(u64, Item)>) -> Result<(), String> {
    let mut r = Reader { data, pos: 0 };
    let mut tick = 0u64;
    let mut running: Option<u8> = None;
    while !r.done() {
        tick += r.vlq()? as u64;
        let first = r.byte()?;
        let status = if first >= 0x80 {
            first
        } else {
            r.pos -= 1;
            running.ok_or("bad track data")?
        };
        match status {
            0xFF => {
                running = None;
                let kind = r.byte()?;
                let len = r.vlq()? as usize;
                let body = r.take(len)?;
                if kind == 0x51 && len == 3 {
                    let t = ((body[0] as u64) << 16) | ((body[1] as u64) << 8) | body[2] as u64;
                    if t == 0 {
                        return Err("bad tempo".to_string());
                    }
                    out.push((tick, Item::Tempo(t)));
                } else if kind == 0x2F {
                    return Ok(());
                }
            }
            0xF0 | 0xF7 => {
                running = None;
                let len = r.vlq()? as usize;
                r.take(len)?;
            }
            0x80..=0xEF => {
                running = Some(status);
                let count = if matches!(status & 0xF0, 0xC0 | 0xD0) { 1 } else { 2 };
                let d = r.take(count)?;
                let d1 = d[0];
                let d2 = if count == 2 { d[1] } else { 0 };
                if let Some(ev) = parse_message(&[status, d1, d2]) {
                    out.push((tick, Item::Event(ev)));
                }
            }
            _ => return Err("bad track data".to_string()),
        }
    }
    Ok(())
}

/// Parses a MIDI file into (microseconds from start, event) pairs sorted by time.
pub fn parse_smf(bytes: &[u8]) -> Result<Vec<(u64, MidiEvent)>, String> {
    if bytes.len() < 14 || &bytes[0..4] != b"MThd" {
        return Err("bad header".to_string());
    }
    let header_len = u32::from_be_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]) as usize;
    if header_len < 6 {
        return Err("bad header".to_string());
    }
    let format = u16::from_be_bytes([bytes[8], bytes[9]]);
    let division = u16::from_be_bytes([bytes[12], bytes[13]]);
    if format > 1 {
        return Err(format!("MIDI format {format} is not supported"));
    }
    if division & 0x8000 != 0 {
        return Err("SMPTE time division is not supported".to_string());
    }
    if division == 0 {
        return Err("bad header".to_string());
    }
    let mut pos = 8usize.checked_add(header_len).ok_or("bad header")?;

    let mut items: Vec<(u64, Item)> = Vec::new();
    while pos.saturating_add(8) <= bytes.len() {
        let kind = &bytes[pos..pos + 4];
        let len = u32::from_be_bytes([bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]])
            as usize;
        let start = pos + 8;
        let end = start.checked_add(len).ok_or("truncated track")?;
        if end > bytes.len() {
            return Err("truncated track".to_string());
        }
        if kind == b"MTrk" {
            parse_track(&bytes[start..end], &mut items)?;
        }
        pos = end;
    }
    items.sort_by_key(|(tick, _)| *tick);

    let division = division as u128;
    let mut tempo = DEFAULT_TEMPO as u128;
    let mut last_tick = 0u64;
    let mut acc: u128 = 0;
    let mut events = Vec::new();
    for (tick, item) in items {
        acc += (tick - last_tick) as u128 * tempo;
        last_tick = tick;
        match item {
            Item::Tempo(t) => tempo = t as u128,
            Item::Event(ev) => events.push(((acc / division) as u64, ev)),
        }
    }
    Ok(events)
}

/// The newest .mid file in `dir` by modified time.
pub fn latest_recording(dir: &Path) -> Result<PathBuf, String> {
    let entries =
        std::fs::read_dir(dir).map_err(|e| format!("cannot read {}: {e}", dir.display()))?;
    let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
    for entry in entries.flatten() {
        let path = entry.path();
        let is_mid = path
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case("mid"));
        if !is_mid {
            continue;
        }
        let Ok(modified) = entry.metadata().and_then(|m| m.modified()) else {
            continue;
        };
        if best.as_ref().is_none_or(|(t, _)| modified > *t) {
            best = Some((modified, path));
        }
    }
    best.map(|(_, p)| p)
        .ok_or_else(|| format!("no .mid files in {}", dir.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::record::encode_smf;

    fn header(format: u16, division: u16) -> Vec<u8> {
        let mut v = b"MThd".to_vec();
        v.extend_from_slice(&6u32.to_be_bytes());
        v.extend_from_slice(&format.to_be_bytes());
        v.extend_from_slice(&2u16.to_be_bytes());
        v.extend_from_slice(&division.to_be_bytes());
        v
    }

    fn track(body: &[u8]) -> Vec<u8> {
        let mut v = b"MTrk".to_vec();
        v.extend_from_slice(&(body.len() as u32).to_be_bytes());
        v.extend_from_slice(body);
        v
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("rp_playback_{name}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn round_trip_with_record_encoder() {
        let events = vec![
            (0, MidiEvent::NoteOn { note: 60, velocity: 90 }),
            (100_000, MidiEvent::Sustain { on: true }),
            (500_000, MidiEvent::NoteOff { note: 60 }),
            (900_000, MidiEvent::Sustain { on: false }),
        ];
        let back = parse_smf(&encode_smf(&events)).unwrap();
        assert_eq!(back.len(), events.len());
        for ((t1, e1), (t2, e2)) in events.iter().zip(back.iter()) {
            assert_eq!(e1.canonical(), *e2);
            assert!(t1.abs_diff(*t2) <= 1100, "{t1} vs {t2}");
        }
    }

    #[test]
    fn pedal_values_round_trip() {
        use crate::midi::Pedal;
        let events = vec![
            (0, MidiEvent::NoteOn { note: 60, velocity: 90 }),
            (100_000, MidiEvent::Pedal { pedal: Pedal::Sustain, value: 37 }),
            (200_000, MidiEvent::Pedal { pedal: Pedal::Sostenuto, value: 127 }),
            (300_000, MidiEvent::Pedal { pedal: Pedal::Soft, value: 64 }),
            (500_000, MidiEvent::NoteOff { note: 60 }),
            (900_000, MidiEvent::Pedal { pedal: Pedal::Sustain, value: 0 }),
        ];
        assert_eq!(parse_smf(&encode_smf(&events)).unwrap(), events);
    }

    #[test]
    fn format_1_with_tempo_map_and_running_status() {
        let tempo_track = [
            0x00, 0xFF, 0x51, 0x03, 0x07, 0xA1, 0x20, 0x83, 0x60, 0xFF, 0x51, 0x03, 0x0F, 0x42,
            0x40, 0x00, 0xFF, 0x2F, 0x00,
        ];
        let note_track = [
            0x00, 0x90, 0x3C, 0x64, 0x87, 0x40, 0x3C, 0x00, 0x00, 0xFF, 0x2F, 0x00,
        ];
        let mut file = header(1, 480);
        file.extend(track(&tempo_track));
        file.extend(track(&note_track));
        let events = parse_smf(&file).unwrap();
        assert_eq!(
            events,
            vec![
                (0, MidiEvent::NoteOn { note: 60, velocity: 100 }),
                (1_500_000, MidiEvent::NoteOff { note: 60 }),
            ]
        );
    }

    #[test]
    fn rejects_unsupported_and_broken_files() {
        assert_eq!(
            parse_smf(&header(2, 480)),
            Err("MIDI format 2 is not supported".to_string())
        );
        assert_eq!(
            parse_smf(&header(0, 0xE728)),
            Err("SMPTE time division is not supported".to_string())
        );
        let mut bad = header(0, 480);
        bad[0] = b'X';
        assert_eq!(parse_smf(&bad), Err("bad header".to_string()));
        let mut cut = header(0, 480);
        cut.extend(track(&[0x00, 0x90, 0x3C, 0x64]));
        cut.truncate(cut.len() - 2);
        assert_eq!(parse_smf(&cut), Err("truncated track".to_string()));
        let mut short = header(0, 480);
        short.extend(track(&[0x00, 0x90, 0x3C]));
        assert_eq!(parse_smf(&short), Err("truncated track".to_string()));
    }

    #[test]
    fn latest_recording_picks_newest() {
        let dir = temp_dir("latest");
        std::fs::write(dir.join("a.mid"), b"x").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(50));
        std::fs::write(dir.join("b.MID"), b"x").unwrap();
        std::fs::write(dir.join("c.txt"), b"x").unwrap();
        assert_eq!(latest_recording(&dir).unwrap(), dir.join("b.MID"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn latest_recording_errors_on_empty_dir() {
        let dir = temp_dir("empty");
        let err = latest_recording(&dir).unwrap_err();
        assert!(err.starts_with("no .mid files in"), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
