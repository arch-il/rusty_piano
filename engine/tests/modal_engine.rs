use rusty_piano_engine::{
    config::SoundProfile,
    midi::MidiEvent,
    record,
    render_job::{run, RenderInput, RenderOptions},
    sound::modal_piano::ModalProfile,
};
use std::path::{Path, PathBuf};
use std::process::Command;

fn temp(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("rusty_piano_modal_engine_{}_{tag}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn write_notes(dir: &Path) -> PathBuf {
    let mut events: Vec<(u64, MidiEvent)> = Vec::new();
    let mut t = 0u64;
    for note in [36u8, 60, 84] {
        for velocity in [40u8, 110] {
            events.push((t, MidiEvent::NoteOn { note, velocity }));
            events.push((t + 1_000_000, MidiEvent::NoteOff { note }));
            t += 2_000_000;
        }
    }
    let path = dir.join("notes.mid");
    std::fs::write(&path, record::encode_smf(&events)).unwrap();
    path
}

#[test]
fn render_cli_plays_physical_profile() {
    let dir = temp("cli");
    let mid = write_notes(&dir);
    let out = dir.join("out");
    let result = Command::new(env!("CARGO_BIN_EXE_rusty_piano_engine"))
        .args([
            "--render",
            mid.to_str().unwrap(),
            "--render-dir",
            out.to_str().unwrap(),
            "--profile",
            "physical",
            "--backend",
            "wasapi",
        ])
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&result.stdout);
    let stderr = String::from_utf8_lossy(&result.stderr);
    assert!(result.status.success(), "stderr: {stderr}");
    assert!(stdout.contains("Sound engine: modal piano"), "{stdout}");
    let reader = hound::WavReader::open(out.join("mid-notes").join("render.wav")).unwrap();
    assert_eq!(reader.spec().channels, 2);
    assert_eq!(reader.spec().sample_rate, 48_000);
    let samples: Vec<f32> = reader
        .into_samples::<f32>()
        .collect::<Result<Vec<f32>, _>>()
        .unwrap();
    assert!(samples.chunks(2).any(|f| f[0] != f[1]));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn render_job_metrics_for_single_notes() {
    let dir = temp("metrics");
    let mid = write_notes(&dir);
    let o = run(&RenderOptions {
        input: RenderInput::Midi(mid),
        out_dir: dir.join("out"),
        reference: None,
        profile: SoundProfile::Modal(ModalProfile::default()),
        profile_name: "physical".to_string(),
        profile_path: None,
    })
    .unwrap();
    let a = &o.analysis;
    let segs = &a.segments;
    assert_eq!(segs.len(), 6);
    for s in segs {
        assert!(!s.peak_db.is_nan() && !s.rms_db.is_nan());
        for v in [s.centroid_hz, s.t60_s, s.release_ms, s.attack_ms, s.decay_db_per_s].into_iter().flatten() {
            assert!(!v.is_nan(), "NaN in segment {}", s.index);
        }
        println!("segment {} notes {:?}: peak {:.1} dB, rms {:.1} dB, release_ms {:?}", s.index, s.notes, s.peak_db, s.rms_db, s.release_ms);
        let r = s.release_ms.expect("release_ms");
        assert!(r <= 500.0,"release {r} ms for note {:?}", s.notes);
    }
    assert!(!a.whole.peak_db.is_nan() && !a.whole.rms_db.is_nan());
    assert_eq!(a.whole.clipped_samples, 0);

    for (i, note) in [36u8, 60, 84].into_iter().enumerate() {
        let soft = &segs[2 * i];
        let loud = &segs[2 * i + 1];
        assert_eq!(soft.notes, vec![note]);
        assert_eq!(loud.notes, vec![note]);
        assert!(
            loud.peak_db >= soft.peak_db + 10.0,
            "note {note}: peak {} vs {}",
            loud.peak_db,
            soft.peak_db
        );
        let c_soft = soft.centroid_hz.expect("centroid");
        let c_loud = loud.centroid_hz.expect("centroid");
        if note == 36 {
            assert!(c_loud >= 0.95 * c_soft, "note 36 centroid {c_loud} vs {c_soft}");
        } else {
            assert!(c_loud > c_soft, "note {note} centroid {c_loud} vs {c_soft}");
        }
    }

    let t36 = segs[1].t60_s.expect("t60 note 36");
    let t60 = segs[3].t60_s.expect("t60 note 60");
    let t84 = segs[5].t60_s.expect("t60 note 84");
    assert!(t36 > t60 && t60 > t84, "t60 {t36} {t60} {t84}");
    let _ = std::fs::remove_dir_all(&dir);
}
