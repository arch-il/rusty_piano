use rusty_piano_engine::{midi::MidiEvent, record};
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};

#[test]
fn play_with_closed_pipe_exits_zero() {
    let dir = std::env::temp_dir().join(format!("rusty_piano_play_pipe_{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let events = [
        (0, MidiEvent::NoteOn { note: 60, velocity: 64 }),
        (200_000, MidiEvent::NoteOff { note: 60 }),
        (300_000, MidiEvent::NoteOn { note: 64, velocity: 90 }),
        (500_000, MidiEvent::NoteOff { note: 64 }),
        (600_000, MidiEvent::NoteOn { note: 67, velocity: 90 }),
        (800_000, MidiEvent::NoteOff { note: 67 }),
    ];
    let mid = dir.join("pipe.mid");
    std::fs::write(&mid, record::encode_smf(&events)).unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_rusty_piano_engine"))
        .args(["--play", mid.to_str().unwrap(), "--profile", "default", "--backend", "wasapi"])
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap();
    let mut reader = BufReader::new(child.stdout.take().unwrap());
    let mut line = String::new();
    reader.read_line(&mut line).unwrap();
    drop(reader);
    let status = child.wait().unwrap();
    let _ = std::fs::remove_dir_all(&dir);
    assert_eq!(status.code(), Some(0));
}
