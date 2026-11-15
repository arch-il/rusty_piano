//! Offline rendering for sound tuning: runs a sound engine without an audio device, the built-in test piece, and WAV read/write (hound).

use crate::config::{Profile, SoundProfile};
use crate::midi::MidiEvent;
use crate::sound::simple_piano::SimplePiano;
use crate::sound::{build_engine, SoundEngine};
use std::path::Path;

pub const SAMPLE_RATE: u32 = 48_000;
pub const TAIL_S: f64 = 2.0;

pub fn sample_of(us: u64, sample_rate: u32) -> usize {
    ((us as u128 * sample_rate as u128 + 500_000) / 1_000_000) as usize
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct StereoBuf {
    pub left: Vec<f32>,
    pub right: Vec<f32>,
}

impl StereoBuf {
    pub fn len(&self) -> usize {
        self.left.len()
    }

    pub fn is_empty(&self) -> bool {
        self.left.is_empty()
    }

    pub fn mono(&self) -> Vec<f32> {
        self.left
            .iter()
            .zip(self.right.iter())
            .map(|(l, r)| 0.5 * (l + r))
            .collect()
    }
}

pub fn render_events(
    engine: &mut dyn SoundEngine,
    events: &[(u64, MidiEvent)],
    sample_rate: u32,
    tail_s: f64,
) -> Vec<f32> {
    render_events_stereo(engine, events, sample_rate, tail_s).mono()
}

pub fn render_events_stereo(
    engine: &mut dyn SoundEngine,
    events: &[(u64, MidiEvent)],
    sample_rate: u32,
    tail_s: f64,
) -> StereoBuf {
    let last = events.last().map_or(0, |e| sample_of(e.0, sample_rate));
    let total = last + (tail_s * sample_rate as f64).round() as usize;
    let mut out = StereoBuf {
        left: vec![0.0f32; total],
        right: vec![0.0f32; total],
    };
    let mut pos = 0;
    let mut i = 0;
    while pos < total {
        while i < events.len() && sample_of(events[i].0, sample_rate) <= pos {
            engine.handle(&events[i].1);
            i += 1;
        }
        let next = if i < events.len() {
            sample_of(events[i].0, sample_rate).min(total)
        } else {
            total
        };
        let end = next.min(pos + 512);
        engine.render_stereo(&mut out.left[pos..end], &mut out.right[pos..end]);
        pos = end;
    }
    while i < events.len() {
        engine.handle(&events[i].1);
        i += 1;
    }
    out
}

pub fn render_with_profile(profile: &Profile, events: &[(u64, MidiEvent)]) -> Vec<f32> {
    render_stereo_with_profile(profile, events).mono()
}

pub fn render_stereo_with_profile(profile: &Profile, events: &[(u64, MidiEvent)]) -> StereoBuf {
    let mut e = SimplePiano::with_profile(SAMPLE_RATE, profile);
    render_events_stereo(&mut e, events, SAMPLE_RATE, TAIL_S)
}

pub fn render_sound_profile(profile: &SoundProfile, events: &[(u64, MidiEvent)]) -> StereoBuf {
    let mut e = build_engine(SAMPLE_RATE, profile);
    render_events_stereo(&mut e, events, SAMPLE_RATE, TAIL_S)
}

#[derive(Debug, Clone, PartialEq)]
pub struct TestPiece {
    pub events: Vec<(u64, MidiEvent)>,
    pub sections: Vec<(&'static str, u64)>,
}

pub fn test_piece() -> TestPiece {
    let mut events: Vec<(u64, MidiEvent)> = Vec::new();
    let mut at = |ms: u64, ev: MidiEvent| events.push((ms * 1000, ev));

    let mut t = 0u64;
    for note in [36u8, 60, 84] {
        for velocity in [16u8, 32, 48, 64, 80, 96, 112, 127] {
            at(t, MidiEvent::NoteOn { note, velocity });
            at(t + 600, MidiEvent::NoteOff { note });
            t += 1100;
        }
    }

    for (i, note) in [21u8, 24, 36, 48, 60, 72, 84, 96, 108].into_iter().enumerate() {
        let start = 26_400 + 2000 * i as u64;
        at(start, MidiEvent::NoteOn { note, velocity: 80 });
        at(start + 1500, MidiEvent::NoteOff { note });
    }

    let chord = [48u8, 52, 55, 60, 64, 67, 72];
    for &note in &chord {
        at(44_400, MidiEvent::NoteOn { note, velocity: 90 });
    }
    for &note in &chord {
        at(45_900, MidiEvent::NoteOff { note });
    }
    for &note in &chord {
        at(46_400, MidiEvent::NoteOn { note, velocity: 40 });
    }
    for &note in &chord {
        at(47_900, MidiEvent::NoteOff { note });
    }

    at(48_400, MidiEvent::Sustain { on: true });
    for (i, note) in [60u8, 64, 67, 72].into_iter().enumerate() {
        let start = 48_500 + 250 * i as u64;
        at(start, MidiEvent::NoteOn { note, velocity: 70 });
        at(start + 150, MidiEvent::NoteOff { note });
    }
    at(50_900, MidiEvent::Sustain { on: false });

    events.sort_by_key(|e| e.0);
    TestPiece {
        events,
        sections: vec![
            ("velocity", 0),
            ("keys", 26_400_000),
            ("chord", 44_400_000),
            ("sustain", 48_400_000),
        ],
    }
}

pub fn write_wav(path: &Path, samples: &[f32], sample_rate: u32) -> Result<(), String> {
    let err = |e: hound::Error| format!("cannot write {}: {e}", path.display());
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate,
        bits_per_sample: 32,
        sample_format: hound::SampleFormat::Float,
    };
    let mut w = hound::WavWriter::create(path, spec).map_err(err)?;
    for &x in samples {
        w.write_sample(x).map_err(err)?;
    }
    w.finalize().map_err(err)
}

pub fn write_wav_stereo(path: &Path, buf: &StereoBuf, sample_rate: u32) -> Result<(), String> {
    let err = |e: hound::Error| format!("cannot write {}: {e}", path.display());
    let spec = hound::WavSpec {
        channels: 2,
        sample_rate,
        bits_per_sample: 32,
        sample_format: hound::SampleFormat::Float,
    };
    let mut w = hound::WavWriter::create(path, spec).map_err(err)?;
    for (&l, &r) in buf.left.iter().zip(buf.right.iter()) {
        w.write_sample(l).map_err(err)?;
        w.write_sample(r).map_err(err)?;
    }
    w.finalize().map_err(err)
}

fn read_mono_samples<R: std::io::Read>(
    reader: &mut hound::WavReader<R>,
    path: &Path,
    max_samples: usize,
) -> Result<Vec<f32>, String> {
    let spec = reader.spec();
    let read_err = |e: hound::Error| format!("cannot read {}: {e}", path.display());
    if spec.channels == 0 {
        return Err(format!("{}: WAV has no channels", path.display()));
    }
    let interleaved: Vec<f32> = match (spec.sample_format, spec.bits_per_sample) {
        (hound::SampleFormat::Float, 32) => reader
            .samples::<f32>()
            .take(max_samples)
            .collect::<Result<Vec<f32>, _>>()
            .map_err(read_err)?,
        (hound::SampleFormat::Int, 8 | 16 | 24 | 32) => {
            let scale = 1.0 / (1u64 << (spec.bits_per_sample - 1)) as f32;
            reader
                .samples::<i32>()
                .take(max_samples)
                .map(|s| s.map(|v| v as f32 * scale))
                .collect::<Result<Vec<f32>, _>>()
                .map_err(read_err)?
        }
        _ => {
            return Err(format!(
                "{}: unsupported WAV format ({}-bit {:?})",
                path.display(),
                spec.bits_per_sample,
                spec.sample_format
            ))
        }
    };
    let channels = spec.channels as usize;
    Ok(interleaved
        .chunks_exact(channels)
        .map(|f| f.iter().sum::<f32>() / channels as f32)
        .collect())
}

pub fn read_wav_mono(path: &Path) -> Result<(Vec<f32>, u32), String> {
    let mut reader = hound::WavReader::open(path)
        .map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    let mono = read_mono_samples(&mut reader, path, usize::MAX)?;
    Ok((mono, reader.spec().sample_rate))
}

pub fn read_wav_mono_range(path: &Path, start_s: f64, len_s: f64) -> Result<(Vec<f32>, u32), String> {
    let mut reader = hound::WavReader::open(path)
        .map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    let spec = reader.spec();
    let sr = spec.sample_rate as f64;
    let frame0 = (start_s * sr).round().clamp(0.0, reader.duration() as f64) as u32;
    reader
        .seek(frame0)
        .map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    let frames = (len_s * sr).round().max(0.0) as usize;
    let mono = read_mono_samples(&mut reader, path, frames * spec.channels as usize)?;
    Ok((mono, spec.sample_rate))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Profile;
    use crate::midi::MidiEvent;
    use std::path::PathBuf;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "rusty_piano_render_{}_{name}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn render_is_deterministic() {
        let p = test_piece();
        let a = render_with_profile(&Profile::default(), &p.events);
        let b = render_with_profile(&Profile::default(), &p.events);
        assert_eq!(a, b);
        assert_eq!(a.len(), sample_of(50_900_000, 48000) + 96000);
    }

    #[test]
    fn events_start_on_exact_sample() {
        let events = vec![
            (500_000, MidiEvent::NoteOn { note: 69, velocity: 100 }),
            (700_000, MidiEvent::NoteOff { note: 69 }),
        ];
        let out = render_with_profile(&Profile::default(), &events);
        assert_eq!(out.len(), 33600 + 96000);
        assert!(out[..24000].iter().all(|&x| x == 0.0));
        assert!(out[24001] != 0.0);
    }

    #[test]
    fn test_piece_layout() {
        let p = test_piece();
        let expected: Vec<(&str, u64)> = vec![
            ("velocity", 0),
            ("keys", 26_400_000),
            ("chord", 44_400_000),
            ("sustain", 48_400_000),
        ];
        assert_eq!(p.sections, expected);
        assert!(p.events.windows(2).all(|w| w[0].0 <= w[1].0));
        assert!(p.events.iter().all(|e| e.0 % 25_000 == 0));
        let note_ons = p
            .events
            .iter()
            .filter(|e| matches!(e.1, MidiEvent::NoteOn { .. }))
            .count();
        assert_eq!(note_ons, 51);
        assert_eq!(p.events.len(), 104);
        assert_eq!(
            *p.events.last().unwrap(),
            (50_900_000, MidiEvent::Sustain { on: false })
        );
    }

    #[test]
    fn test_piece_round_trips_through_smf() {
        let p = test_piece();
        assert_eq!(
            crate::playback::parse_smf(&crate::record::encode_smf(&p.events)),
            Ok(p.events.iter().map(|&(t, e)| (t, e.canonical())).collect())
        );
    }

    #[test]
    fn wav_round_trip_is_exact() {
        let dir = temp_dir("wav_round_trip");
        let events = vec![
            (0, MidiEvent::NoteOn { note: 69, velocity: 100 }),
            (500_000, MidiEvent::NoteOff { note: 69 }),
        ];
        let samples = render_events(
            &mut SimplePiano::with_profile(SAMPLE_RATE, &Profile::default()),
            &events,
            SAMPLE_RATE,
            1.0,
        );
        let a = dir.join("a.wav");
        let b = dir.join("b.wav");
        write_wav(&a, &samples, SAMPLE_RATE).unwrap();
        let (back, rate) = read_wav_mono(&a).unwrap();
        assert_eq!(rate, 48000);
        assert_eq!(back, samples);
        write_wav(&b, &samples, SAMPLE_RATE).unwrap();
        assert_eq!(std::fs::read(&a).unwrap(), std::fs::read(&b).unwrap());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn reads_int_stereo_wav_as_mono() {
        let dir = temp_dir("int_stereo");
        let path = dir.join("stereo.wav");
        let spec = hound::WavSpec {
            channels: 2,
            sample_rate: 44100,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut w = hound::WavWriter::create(&path, spec).unwrap();
        for v in [16384i16, 0, -32768, -32768] {
            w.write_sample(v).unwrap();
        }
        w.finalize().unwrap();
        let (mono, rate) = read_wav_mono(&path).unwrap();
        assert_eq!(mono, vec![0.25, -1.0]);
        assert_eq!(rate, 44100);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn wav_range_read_matches_whole_read() {
        let dir = temp_dir("wav_range");
        let path = dir.join("range.wav");
        let spec = hound::WavSpec {
            channels: 2,
            sample_rate: 48000,
            bits_per_sample: 24,
            sample_format: hound::SampleFormat::Int,
        };
        let mut w = hound::WavWriter::create(&path, spec).unwrap();
        for i in 0..96_000i32 {
            w.write_sample((i % 1000) * 4000).unwrap();
            w.write_sample(-((i * 7) % 1301) * 3000).unwrap();
        }
        w.finalize().unwrap();
        let (whole, rate) = read_wav_mono(&path).unwrap();
        assert_eq!(rate, 48000);
        assert_eq!(whole.len(), 96_000);

        let (part, rate) = read_wav_mono_range(&path, 0.5, 0.25).unwrap();
        assert_eq!(rate, 48000);
        assert_eq!(part, whole[24_000..36_000].to_vec());

        let (end, _) = read_wav_mono_range(&path, 1.9, 0.5).unwrap();
        assert_eq!(end, whole[91_200..].to_vec());

        let (past, _) = read_wav_mono_range(&path, 3.0, 0.5).unwrap();
        assert!(past.is_empty());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn missing_wav_is_an_error() {
        let path = std::env::temp_dir().join("rusty_piano_render_missing_does_not_exist.wav");
        let err = read_wav_mono(&path).unwrap_err();
        assert!(err.starts_with("cannot read "));
    }

    struct Split;

    impl SoundEngine for Split {
        fn handle(&mut self, _ev: &MidiEvent) {}

        fn render_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
            left.fill(0.5);
            right.fill(-0.25);
        }
    }

    #[test]
    fn stereo_render_keeps_channels() {
        let events = vec![(0, MidiEvent::NoteOn { note: 69, velocity: 100 })];
        let buf = render_events_stereo(&mut Split, &events, SAMPLE_RATE, 0.01);
        assert_eq!(buf.len(), 480);
        assert!(buf.left.iter().all(|&x| x == 0.5));
        assert!(buf.right.iter().all(|&x| x == -0.25));
        assert!(buf.mono().iter().all(|&x| x == 0.125));
    }

    fn rms(buf: &[f32]) -> f32 {
        (buf.iter().map(|x| x * x).sum::<f32>() / buf.len() as f32).sqrt()
    }

    #[test]
    fn sound_profile_render_uses_modal_engine() {
        let events = vec![
            (0, MidiEvent::NoteOn { note: 30, velocity: 100 }),
            (500_000, MidiEvent::NoteOff { note: 30 }),
        ];
        let modal = render_sound_profile(
            &SoundProfile::Modal(crate::sound::modal_piano::ModalProfile::default()),
            &events,
        );
        assert!(modal.left.iter().any(|&x| x != 0.0));
        assert!(rms(&modal.left) > rms(&modal.right));

        let simple = render_sound_profile(&SoundProfile::Simple(Profile::default()), &events);
        assert_eq!(simple, render_stereo_with_profile(&Profile::default(), &events));
    }

    #[test]
    fn stereo_wav_round_trip() {
        let dir = temp_dir("stereo_round_trip");
        let events = vec![
            (0, MidiEvent::NoteOn { note: 69, velocity: 100 }),
            (500_000, MidiEvent::NoteOff { note: 69 }),
        ];
        let buf = render_events_stereo(
            &mut SimplePiano::with_profile(SAMPLE_RATE, &Profile::default()),
            &events,
            SAMPLE_RATE,
            0.0,
        );
        let path = dir.join("stereo.wav");
        write_wav_stereo(&path, &buf, SAMPLE_RATE).unwrap();
        let reader = hound::WavReader::open(&path).unwrap();
        let spec = reader.spec();
        assert_eq!(spec.channels, 2);
        assert_eq!(spec.sample_rate, 48000);
        assert_eq!(spec.bits_per_sample, 32);
        assert_eq!(spec.sample_format, hound::SampleFormat::Float);
        let back: Vec<f32> = reader
            .into_samples::<f32>()
            .collect::<Result<Vec<f32>, _>>()
            .unwrap();
        let expected: Vec<f32> = buf
            .left
            .iter()
            .zip(buf.right.iter())
            .flat_map(|(&l, &r)| [l, r])
            .collect();
        assert_eq!(back, expected);
        let (mono, rate) = read_wav_mono(&path).unwrap();
        assert_eq!(rate, 48000);
        assert_eq!(mono, buf.mono());

        let stub = render_events_stereo(&mut Split, &events, SAMPLE_RATE, 0.01);
        let stub_path = dir.join("split.wav");
        write_wav_stereo(&stub_path, &stub, SAMPLE_RATE).unwrap();
        let first: Vec<f32> = hound::WavReader::open(&stub_path)
            .unwrap()
            .into_samples::<f32>()
            .take(2)
            .collect::<Result<Vec<f32>, _>>()
            .unwrap();
        assert_eq!(first, vec![0.5, -0.25]);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
