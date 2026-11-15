use rusty_piano_engine::{midi::MidiEvent, record};
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

fn temp_dir(tag: &str) -> PathBuf {
    std::env::temp_dir().join(format!("rusty_piano_render_bin_{}_{tag}", std::process::id()))
}

fn write_phrase(dir: &Path) -> PathBuf {
    std::fs::create_dir_all(dir).unwrap();
    let events = [
        (0, MidiEvent::NoteOn { note: 60, velocity: 64 }),
        (300_000, MidiEvent::NoteOff { note: 60 }),
        (400_000, MidiEvent::NoteOn { note: 64, velocity: 100 }),
        (700_000, MidiEvent::NoteOff { note: 64 }),
    ];
    let path = dir.join("phrase.mid");
    std::fs::write(&path, record::encode_smf(&events)).unwrap();
    path
}

fn run(args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_rusty_piano_engine"))
        .args(args)
        .output()
        .unwrap()
}

#[test]
fn render_binary_writes_outputs() {
    let tmp = temp_dir("writes");
    let _ = std::fs::remove_dir_all(&tmp);
    let mid = write_phrase(&tmp);
    let out = tmp.join("out");
    let result = run(&[
        "--render",
        mid.to_str().unwrap(),
        "--render-dir",
        out.to_str().unwrap(),
        "--profile",
        "default",
        "--backend",
        "wasapi",
    ]);
    let stdout = String::from_utf8_lossy(&result.stdout);
    let stderr = String::from_utf8_lossy(&result.stderr);
    assert!(result.status.success(), "stderr: {stderr}");
    assert!(stdout.contains("Render: mid-phrase"), "{stdout}");
    assert!(stdout.contains("JSON: "), "{stdout}");
    assert!(out.join("mid-phrase").join("render.json").exists());
    assert!(out.join("mid-phrase").join("render.wav").exists());
    let _ = std::fs::remove_dir_all(&tmp);
}

#[test]
fn render_binary_bad_reference_exits_1() {
    let tmp = temp_dir("badref");
    let _ = std::fs::remove_dir_all(&tmp);
    let mid = write_phrase(&tmp);
    let out = tmp.join("out");
    let missing = tmp.join("missing.wav");
    let result = run(&[
        "--render",
        mid.to_str().unwrap(),
        "--render-dir",
        out.to_str().unwrap(),
        "--ref",
        missing.to_str().unwrap(),
        "--profile",
        "default",
        "--backend",
        "wasapi",
    ]);
    let stderr = String::from_utf8_lossy(&result.stderr);
    assert_eq!(result.status.code(), Some(1), "stderr: {stderr}");
    assert!(stderr.contains("reference WAV"), "stderr: {stderr}");
    let _ = std::fs::remove_dir_all(&tmp);
}

#[test]
fn ref_without_render_is_usage_error() {
    let result = run(&["--ref", "x.wav"]);
    let stderr = String::from_utf8_lossy(&result.stderr);
    assert_eq!(result.status.code(), Some(2), "stderr: {stderr}");
    assert!(stderr.contains("--ref and --render-dir need --render"), "stderr: {stderr}");
}

#[test]
fn render_binary_empty_value_names_choices() {
    let result = run(&["--render", "", "--backend", "wasapi"]);
    let stderr = String::from_utf8_lossy(&result.stderr);
    assert_eq!(result.status.code(), Some(1), "stderr: {stderr}");
    assert!(stderr.contains("latest") && stderr.contains(".mid"), "stderr: {stderr}");
}

#[test]
fn render_binary_forward_slash_dir_prints_one_style() {
    let tmp = temp_dir("slashes");
    let _ = std::fs::remove_dir_all(&tmp);
    let mid = write_phrase(&tmp);
    let out = format!("{}/out/sub", tmp.display().to_string().replace('\\', "/"));
    let result = run(&[
        "--render",
        mid.to_str().unwrap(),
        "--render-dir",
        &out,
        "--profile",
        "default",
        "--backend",
        "wasapi",
    ]);
    let stdout = String::from_utf8_lossy(&result.stdout);
    assert!(result.status.success(), "stderr: {}", String::from_utf8_lossy(&result.stderr));
    if std::path::MAIN_SEPARATOR == '\\' {
        assert!(!stdout.contains("sub/"), "{stdout}");
        assert!(stdout.contains("sub\\mid-phrase\\render.json"), "{stdout}");
    }
    let _ = std::fs::remove_dir_all(&tmp);
}
