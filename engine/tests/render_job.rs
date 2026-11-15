use rusty_piano_engine::{config::{Profile, SoundProfile}, midi::MidiEvent, record, render_job::*, sound::modal_piano::ModalProfile};
use std::path::{Path, PathBuf};

fn temp(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("rusty_piano_render_job_{}_{tag}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn small_mid(dir: &Path) -> PathBuf {
    let events: [(u64, MidiEvent); 4] = [
        (0, MidiEvent::NoteOn { note: 60, velocity: 64 }),
        (300_000, MidiEvent::NoteOff { note: 60 }),
        (400_000, MidiEvent::NoteOn { note: 64, velocity: 100 }),
        (700_000, MidiEvent::NoteOff { note: 64 }),
    ];
    let path = dir.join("phrase.mid");
    std::fs::write(&path, record::encode_smf(&events)).unwrap();
    path
}

fn opts(input: RenderInput, out_dir: &Path) -> RenderOptions {
    RenderOptions {
        input,
        out_dir: out_dir.to_path_buf(),
        reference: None,
        profile: Profile::default().into(),
        profile_name: "default".to_string(),
        profile_path: None,
    }
}

#[test]
fn test_set_writes_wav_json_and_midi() {
    let dir = temp("test_set");
    let out = dir.join("out");
    let o = run(&opts(RenderInput::TestSet, &out)).unwrap();
    let piece = out.join("test");
    assert!(piece.join("render.wav").exists());
    assert!(piece.join("render.json").exists());
    assert!(piece.join("test.mid").exists());
    assert!(!o.had_previous);
    assert!(o.vs_previous.is_none());
    assert_eq!(o.analysis.segments.len(), 39);
    assert_eq!(o.analysis.velocity_curves.len(), 3);
    let json = std::fs::read_to_string(&o.json).unwrap();
    assert!(json.contains("\"section\":\"velocity\""));
    assert!(json.contains("\"vs_previous\":null"));
    assert!(o.summary.contains("vs previous: none (first render)"));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn second_run_compares_with_previous() {
    let dir = temp("second_run");
    let input = RenderInput::Midi(small_mid(&dir));
    let out = dir.join("out");
    run(&opts(input.clone(), &out)).unwrap();
    let second = run(&opts(input, &out)).unwrap();
    let piece = out.join("mid-phrase");
    assert_eq!(second.dir, piece);
    assert!(second.had_previous);
    assert_eq!(
        std::fs::read(piece.join("previous.wav")).unwrap(),
        std::fs::read(piece.join("render.wav")).unwrap()
    );
    let c = second.vs_previous.as_ref().unwrap();
    assert_eq!(c.segments_compared, 2);
    assert_eq!(c.mean_abs.rms_db, Some(0.0));
    let json = std::fs::read_to_string(piece.join("render.json")).unwrap();
    assert!(json.contains("\"vs_previous\":{"));
    assert!(piece.join("previous.json").exists());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn reference_of_same_audio_matches_exactly() {
    let dir = temp("reference");
    let input = RenderInput::Midi(small_mid(&dir));
    let out = dir.join("out");
    let first = run(&opts(input.clone(), &out)).unwrap();
    let refwav = dir.join("ref.wav");
    std::fs::copy(&first.wav, &refwav).unwrap();
    let second = run(&RenderOptions {
        reference: Some(refwav),
        ..opts(input, &out)
    })
    .unwrap();
    let r = second.vs_reference.as_ref().unwrap();
    assert_eq!(r.offset_ms, 0.0);
    assert_eq!(r.comparison.mean_abs.rms_db, Some(0.0));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn missing_reference_fails_before_writing() {
    let dir = temp("missing_ref");
    let input = RenderInput::Midi(small_mid(&dir));
    let out = dir.join("out");
    let err = run(&RenderOptions {
        reference: Some(dir.join("missing.wav")),
        ..opts(input, &out)
    })
    .unwrap_err();
    assert!(err.contains("reference WAV"), "{err}");
    assert!(!out.join("mid-phrase").join("render.wav").exists());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn midi_without_notes_is_an_error() {
    let dir = temp("no_notes");
    let path = dir.join("empty.mid");
    let events: [(u64, MidiEvent); 2] = [
        (0, MidiEvent::Sustain { on: true }),
        (100_000, MidiEvent::Sustain { on: false }),
    ];
    std::fs::write(&path, record::encode_smf(&events)).unwrap();
    let err = run(&opts(RenderInput::Midi(path), &dir.join("out"))).unwrap_err();
    assert!(err.contains("no notes in"), "{err}");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn resolve_input_variants() {
    let dir = temp("resolve");
    assert_eq!(resolve_input("test", &dir), Ok(RenderInput::TestSet));
    assert_eq!(resolve_input("TEST", &dir), Ok(RenderInput::TestSet));
    assert_eq!(
        resolve_input("x.mid", &dir),
        Ok(RenderInput::Midi(PathBuf::from("x.mid")))
    );

    let mid = small_mid(&dir);
    assert_eq!(resolve_input("latest", &dir), Ok(RenderInput::Midi(mid)));

    let empty = temp("resolve_empty");
    assert!(resolve_input("latest", &empty).is_err());

    assert_eq!(
        piece_name(&RenderInput::Midi(PathBuf::from("a b/c d.mid"))),
        "mid-c_d"
    );
    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_dir_all(&empty);
}

#[test]
fn too_long_midi_is_refused_before_writing() {
    let dir = temp("too_long");
    let path = dir.join("long.mid");
    let events: [(u64, MidiEvent); 2] = [
        (250_000_000_000, MidiEvent::NoteOn { note: 60, velocity: 64 }),
        (250_000_500_000, MidiEvent::NoteOff { note: 60 }),
    ];
    std::fs::write(&path, record::encode_smf(&events)).unwrap();
    let out = dir.join("out");
    let err = run(&opts(RenderInput::Midi(path), &out)).unwrap_err();
    assert!(err.contains("too long to render"), "{err}");
    assert!(!out.join("mid-long").exists());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn max_length_piece_is_allowed_by_limit_check() {
    let ok: [(u64, MidiEvent); 2] = [
        (0, MidiEvent::NoteOn { note: 60, velocity: 64 }),
        (1_800_000_000, MidiEvent::NoteOff { note: 60 }),
    ];
    assert_eq!(check_length(&ok), Ok(()));
    let too_long: [(u64, MidiEvent); 2] = [
        (0, MidiEvent::NoteOn { note: 60, velocity: 64 }),
        (1_800_000_001, MidiEvent::NoteOff { note: 60 }),
    ];
    assert!(check_length(&too_long).is_err());
}

#[test]
fn modal_profile_renders_stereo() {
    let dir = temp("modal_stereo");
    let input = RenderInput::Midi(small_mid(&dir));
    let o = run(&RenderOptions {
        profile: SoundProfile::Modal(ModalProfile::default()),
        ..opts(input, &dir.join("out"))
    })
    .unwrap();
    assert_eq!(o.analysis.segments.len(), 2);
    let reader = hound::WavReader::open(&o.wav).unwrap();
    assert_eq!(reader.spec().channels, 2);
    let samples: Vec<f32> = reader
        .into_samples::<f32>()
        .collect::<Result<Vec<f32>, _>>()
        .unwrap();
    assert!(samples.chunks(2).any(|f| f[0] != f[1]));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn render_wav_is_stereo() {
    let dir = temp("wav_stereo");
    let input = RenderInput::Midi(small_mid(&dir));
    let o = run(&opts(input, &dir.join("out"))).unwrap();
    let reader = hound::WavReader::open(&o.wav).unwrap();
    assert_eq!(reader.spec().channels, 2);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn test_piece_midi_reuses_test_sections() {
    let dir = temp("test_mid_sections");
    let reference = run(&opts(RenderInput::TestSet, &dir.join("out_test"))).unwrap();
    let mid = dir.join("piece.mid");
    std::fs::write(&mid, record::encode_smf(&rusty_piano_engine::render::test_piece().events)).unwrap();
    let o = run(&opts(RenderInput::Midi(mid.clone()), &dir.join("out_mid"))).unwrap();
    assert_eq!(o.analysis.velocity_curves, reference.analysis.velocity_curves);
    let sections = |a: &rusty_piano_engine::metrics::Analysis| -> Vec<String> {
        a.segments.iter().map(|s| s.section.clone()).collect()
    };
    assert_eq!(sections(&o.analysis), sections(&reference.analysis));
    assert!(o.summary.contains("Velocity: note 36"), "{}", o.summary);

    let other = small_mid(&dir);
    let o2 = run(&opts(RenderInput::Midi(other), &dir.join("out_other"))).unwrap();
    assert!(o2.analysis.segments.iter().all(|s| s.section == "file"));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn empty_render_value_names_choices() {
    let dir = temp("empty_value");
    let err = resolve_input("", &dir).unwrap_err();
    assert!(err.contains("test") && err.contains(".mid") && err.contains("latest"), "{err}");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn paths_use_one_separator_style() {
    let dir = temp("separators");
    let mid = small_mid(&dir);
    let out = format!("{}/out/nested", dir.display().to_string().replace('\\', "/"));
    let o = run(&opts(RenderInput::Midi(mid), Path::new(&out))).unwrap();
    if std::path::MAIN_SEPARATOR == '\\' {
        for text in [o.wav.display().to_string(), o.json.display().to_string(), o.summary.clone()] {
            assert!(!text.contains("nested/"), "{text}");
        }
        let json = std::fs::read_to_string(&o.json).unwrap();
        assert!(!json.contains("nested/"), "{json}");
    }
    assert!(o.summary.contains("nested"), "{}", o.summary);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn failed_json_rename_restores_wav() {
    let dir = temp("rename_undo");
    let input = RenderInput::Midi(small_mid(&dir));
    let out = dir.join("out");
    run(&opts(input.clone(), &out)).unwrap();
    let piece = out.join("mid-phrase");
    let wav_before = std::fs::read(piece.join("render.wav")).unwrap();
    let blocker = piece.join("previous.json");
    std::fs::create_dir_all(&blocker).unwrap();
    std::fs::write(blocker.join("x"), "x").unwrap();
    let err = run(&opts(input, &out)).unwrap_err();
    assert!(err.contains("cannot rename"), "{err}");
    assert_eq!(std::fs::read(piece.join("render.wav")).unwrap(), wav_before);
    assert!(!piece.join("previous.wav").exists());
    assert!(piece.join("render.json").exists());
    let _ = std::fs::remove_dir_all(&dir);
}
