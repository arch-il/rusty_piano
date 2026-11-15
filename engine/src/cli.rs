use crate::audio::Backend;

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Args {
    pub list: bool,
    pub port: Option<String>,
    pub help: bool,
    pub audio_device: Option<String>,
    pub buffer: Option<u32>,
    pub profile: Option<String>,
    pub transpose: Option<i8>,
    pub octave: Option<i8>,
    pub metronome: Option<u16>,
    pub demo: bool,
    pub backend: Option<Backend>,
    pub no_record: bool,
    pub record_wav: bool,
    pub record_dir: Option<String>,
    pub play: Option<String>,
    pub ws_port: Option<u16>,
    pub render: Option<String>,
    pub reference: Option<String>,
    pub render_dir: Option<String>,
    pub setup: bool,
    pub fit: Option<String>,
    pub fit_check: Option<String>,
    pub fit_out: Option<String>,
    pub fit_notes: Option<Vec<u8>>,
    pub fit_passes: Option<usize>,
    pub fit_threads: Option<usize>,
}

pub const USAGE: &str = "Usage: rusty_piano_engine [--list] [--port <index|name>] [--audio-device <index|name>] [--buffer <frames>] [--profile <name>] [--transpose <n>] [--octave <n>] [--metronome <bpm>] [--backend <wasapi|asio|wasapi-exclusive>] [--demo] [--no-record] [--record-wav] [--record-dir <path>] [--play <file|latest>] [--ws-port <port>] [--render <test|file.mid|latest>] [--ref <file.wav>] [--render-dir <path>] [--fit <folder>] [--fit-check <folder>] [--fit-out <dir>] [--fit-notes <list>] [--fit-passes <n>] [--fit-threads <n>] [--setup] [--help]
  --list               list MIDI input ports and audio output devices, then exit
  --port <x>           MIDI input: port index x or the first port whose name contains x (any case); default: SL990
  --audio-device <x>   audio output: device index x (as shown by --list for the selected backend) or the first device whose name contains x (any case); default: system default output
  --buffer <frames>    ask the audio device for this buffer size in frames (e.g. 128); falls back to the device default if refused
  --profile <name>     sound profile engine/profiles/<name>.ron (or a path to a .ron file); default: profile in engine/setup.ron, else default
  --transpose <n>      shift the sound by n semitones (-12 to 12) in live play, --demo and --play; recordings and live events keep the keys you pressed; default: transpose in engine/setup.ron, else 0
  --octave <n>         shift the sound by n octaves (-2 to 2), added to --transpose; default: octave in engine/setup.ron, else 0
  --metronome <bpm>    live sessions start with the metronome click on at this tempo (30-300 bpm); beats per bar and volume come from engine/setup.ron; default: metronome in engine/setup.ron, else off
  --backend <name>     audio backend: wasapi (shared, default), asio (ASIO driver such as FlexASIO; needs a build with --features asio) or wasapi-exclusive (low latency, locks the device)
  --demo               play a short demo through the audio output without any MIDI device, then exit
  --play <file|latest> play a .mid file (latest = newest recording) through the audio output, then exit
  --no-record          do not record this session
  --record-wav         also save the session audio as a .wav next to its .mid (16-bit stereo at the device rate, without the metronome click); default: record_wav in engine/setup.ron, else off
  --record-dir <path>  folder for session recordings; default: coach/data/sessions
  --ws-port <port>     send note events as JSON over a WebSocket on ws://127.0.0.1:<port> (live, --demo and --play); default: ws_port in engine/setup.ron, else off
  --render <x>         render offline without an audio device: test (built-in test piece), a .mid file or latest (newest recording); writes WAV + metrics JSON to engine/renders/<piece>/ and compares with the previous render
  --ref <file.wav>     with --render: also compare with this reference WAV of the same piece (any sample rate, mono or stereo)
  --render-dir <path>  with --render: output folder; default: engine/renders
  --fit <folder>       fit the physical profile to reference renders in <folder> (single-notes-v016 ... v127, test-piece); writes physical.ron, physical_sl990.ron and fit-report.txt to --fit-out
  --fit-check <folder> compare --profile (a modal profile) with the reference renders note by note and print the errors
  --fit-out <dir>      with --fit: output folder; default: engine/renders/fit
  --fit-notes <list>   with --fit or --fit-check: notes, e.g. 60, 21-108 or 36,48,60-72; default: 21-108
  --fit-passes <n>     with --fit: per-note passes, 1-10; default: 5
  --fit-threads <n>    with --fit or --fit-check: worker threads, 1-64; default: all cores
  --setup              open the setup window (MIDI port, audio, profile, recording, WebSocket), then play; opens by itself when engine/setup.ron is missing
  --help               show this help
Values not given as flags come from engine/setup.ron (see setup.example.ron).";

/// Parses command-line arguments (without the program name).
pub fn parse_args(args: &[String]) -> Result<Args, String> {
    let mut parsed = Args::default();
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--list" => parsed.list = true,
            "--help" | "-h" => parsed.help = true,
            "--demo" => parsed.demo = true,
            "--no-record" => parsed.no_record = true,
            "--record-wav" => parsed.record_wav = true,
            "--record-dir" => {
                let value = iter.next().ok_or("--record-dir needs a value")?;
                parsed.record_dir = Some(value.clone());
            }
            "--play" => {
                let value = iter.next().ok_or("--play needs a value")?;
                parsed.play = Some(value.clone());
            }
            "--ws-port" => {
                let value = iter.next().ok_or("--ws-port needs a value")?;
                parsed.ws_port = Some(parse_ws_port(value)?);
            }
            "--port" => {
                let value = iter.next().ok_or("--port needs a value")?;
                parsed.port = Some(value.clone());
            }
            "--audio-device" => {
                let value = iter.next().ok_or("--audio-device needs a value")?;
                parsed.audio_device = Some(value.clone());
            }
            "--buffer" => {
                let value = iter.next().ok_or("--buffer needs a value")?;
                parsed.buffer = Some(parse_buffer(value)?);
            }
            "--profile" => {
                let value = iter.next().ok_or("--profile needs a value")?;
                parsed.profile = Some(value.clone());
            }
            "--transpose" => {
                let value = iter.next().ok_or("--transpose needs a value")?;
                parsed.transpose = Some(parse_shift("--transpose", value, 12)?);
            }
            "--octave" => {
                let value = iter.next().ok_or("--octave needs a value")?;
                parsed.octave = Some(parse_shift("--octave", value, 2)?);
            }
            "--metronome" => {
                let value = iter.next().ok_or("--metronome needs a value")?;
                parsed.metronome = Some(parse_metronome(value)?);
            }
            "--backend" => {
                let value = iter.next().ok_or("--backend needs a value")?;
                parsed.backend = Some(parse_backend(value)?);
            }
            "--render" => {
                let value = iter.next().ok_or("--render needs a value")?;
                parsed.render = Some(value.clone());
            }
            "--ref" => {
                let value = iter.next().ok_or("--ref needs a value")?;
                parsed.reference = Some(value.clone());
            }
            "--render-dir" => {
                let value = iter.next().ok_or("--render-dir needs a value")?;
                parsed.render_dir = Some(value.clone());
            }
            "--setup" => parsed.setup = true,
            "--fit" => {
                let value = iter.next().ok_or("--fit needs a value")?;
                parsed.fit = Some(value.clone());
            }
            "--fit-check" => {
                let value = iter.next().ok_or("--fit-check needs a value")?;
                parsed.fit_check = Some(value.clone());
            }
            "--fit-out" => {
                let value = iter.next().ok_or("--fit-out needs a value")?;
                parsed.fit_out = Some(value.clone());
            }
            "--fit-notes" => {
                let value = iter.next().ok_or("--fit-notes needs a value")?;
                parsed.fit_notes = Some(parse_note_list(value)?);
            }
            "--fit-passes" => {
                let value = iter.next().ok_or("--fit-passes needs a value")?;
                parsed.fit_passes = Some(parse_count("--fit-passes", value, 10)?);
            }
            "--fit-threads" => {
                let value = iter.next().ok_or("--fit-threads needs a value")?;
                parsed.fit_threads = Some(parse_count("--fit-threads", value, 64)?);
            }
            _ => {
                if let Some(value) = arg.strip_prefix("--fit-check=") {
                    parsed.fit_check = Some(value.to_string());
                    continue;
                } else if let Some(value) = arg.strip_prefix("--fit-out=") {
                    parsed.fit_out = Some(value.to_string());
                    continue;
                } else if let Some(value) = arg.strip_prefix("--fit-notes=") {
                    parsed.fit_notes = Some(parse_note_list(value)?);
                    continue;
                } else if let Some(value) = arg.strip_prefix("--fit-passes=") {
                    parsed.fit_passes = Some(parse_count("--fit-passes", value, 10)?);
                    continue;
                } else if let Some(value) = arg.strip_prefix("--fit-threads=") {
                    parsed.fit_threads = Some(parse_count("--fit-threads", value, 64)?);
                    continue;
                } else if let Some(value) = arg.strip_prefix("--fit=") {
                    parsed.fit = Some(value.to_string());
                    continue;
                }
                if let Some(value) = arg.strip_prefix("--transpose=") {
                    parsed.transpose = Some(parse_shift("--transpose", value, 12)?);
                } else if let Some(value) = arg.strip_prefix("--octave=") {
                    parsed.octave = Some(parse_shift("--octave", value, 2)?);
                } else if let Some(value) = arg.strip_prefix("--metronome=") {
                    parsed.metronome = Some(parse_metronome(value)?);
                } else if let Some(value) = arg.strip_prefix("--port=") {
                    parsed.port = Some(value.to_string());
                } else if let Some(value) = arg.strip_prefix("--audio-device=") {
                    parsed.audio_device = Some(value.to_string());
                } else if let Some(value) = arg.strip_prefix("--buffer=") {
                    parsed.buffer = Some(parse_buffer(value)?);
                } else if let Some(value) = arg.strip_prefix("--profile=") {
                    parsed.profile = Some(value.to_string());
                } else if let Some(value) = arg.strip_prefix("--record-dir=") {
                    parsed.record_dir = Some(value.to_string());
                } else if let Some(value) = arg.strip_prefix("--play=") {
                    parsed.play = Some(value.to_string());
                } else if let Some(value) = arg.strip_prefix("--backend=") {
                    parsed.backend = Some(parse_backend(value)?);
                } else if let Some(value) = arg.strip_prefix("--ws-port=") {
                    parsed.ws_port = Some(parse_ws_port(value)?);
                } else if let Some(value) = arg.strip_prefix("--render-dir=") {
                    parsed.render_dir = Some(value.to_string());
                } else if let Some(value) = arg.strip_prefix("--render=") {
                    parsed.render = Some(value.to_string());
                } else if let Some(value) = arg.strip_prefix("--ref=") {
                    parsed.reference = Some(value.to_string());
                } else {
                    return Err(format!("unknown argument: {arg}"));
                }
            }
        }
    }
    if parsed.play.is_some() && parsed.demo {
        return Err("--play and --demo cannot be used together".to_string());
    }
    if parsed.render.is_some() && (parsed.list || parsed.demo || parsed.play.is_some()) {
        return Err("--render cannot be used with --list, --demo or --play".to_string());
    }
    if parsed.render.is_none() && (parsed.reference.is_some() || parsed.render_dir.is_some()) {
        return Err("--ref and --render-dir need --render".to_string());
    }
    if parsed.setup && (parsed.list || parsed.demo || parsed.play.is_some() || parsed.render.is_some()) {
        return Err("--setup cannot be used with --list, --demo, --play or --render".to_string());
    }
    let fitting = parsed.fit.is_some() || parsed.fit_check.is_some();
    if parsed.fit.is_some() && parsed.fit_check.is_some() {
        return Err("--fit and --fit-check cannot be used together".to_string());
    }
    if fitting && (parsed.list || parsed.demo || parsed.play.is_some() || parsed.render.is_some() || parsed.setup) {
        return Err("--fit and --fit-check cannot be used with --list, --demo, --play, --render or --setup".to_string());
    }
    if parsed.fit.is_none() && (parsed.fit_out.is_some() || parsed.fit_passes.is_some()) {
        return Err("--fit-out and --fit-passes need --fit".to_string());
    }
    if !fitting && (parsed.fit_notes.is_some() || parsed.fit_threads.is_some()) {
        return Err("--fit-notes and --fit-threads need --fit or --fit-check".to_string());
    }
    Ok(parsed)
}

fn parse_shift(flag: &str, value: &str, max: i8) -> Result<i8, String> {
    match value.trim().parse::<i8>() {
        Ok(n) if (-max..=max).contains(&n) => Ok(n),
        _ => Err(format!("{flag} must be a whole number from -{max} to {max}, got: {value}")),
    }
}

fn parse_metronome(value: &str) -> Result<u16, String> {
    match value.trim().parse::<u16>() {
        Ok(n) if (30..=300).contains(&n) => Ok(n),
        _ => Err(format!("--metronome must be a tempo in bpm from 30 to 300, got: {value}")),
    }
}

fn parse_count(flag: &str, value: &str, max: usize) -> Result<usize, String> {
    match value.trim().parse::<usize>() {
        Ok(n) if (1..=max).contains(&n) => Ok(n),
        _ => Err(format!("{flag} must be a whole number from 1 to {max}, got: {value}")),
    }
}

/// Parses a note list such as "60", "21-23,60" or "36,48,60-72" into a sorted list without duplicates (notes 21..=108).
pub fn parse_note_list(s: &str) -> Result<Vec<u8>, String> {
    let note = |t: &str, item: &str| -> Result<u8, String> {
        match t.trim().parse::<u8>() {
            Ok(n) if (21..=108).contains(&n) => Ok(n),
            _ => Err(format!("bad note item '{item}' (notes are 21 to 108)")),
        }
    };
    let mut out: Vec<u8> = Vec::new();
    for item in s.split(',') {
        let item = item.trim();
        if item.is_empty() {
            return Err(format!("bad note item '{item}' in '{s}'"));
        }
        if let Some((a, b)) = item.split_once('-') {
            let (a, b) = (note(a, item)?, note(b, item)?);
            if a > b {
                return Err(format!("bad note item '{item}' (range runs backwards)"));
            }
            out.extend(a..=b);
        } else {
            out.push(note(item, item)?);
        }
    }
    out.sort_unstable();
    out.dedup();
    Ok(out)
}

/// True when the setup window should open: --setup, or a live start with no setup.ron.
pub fn opens_setup_window(args: &Args, setup_file_exists: bool) -> bool {
    if args.help || args.list || args.demo || args.play.is_some() || args.render.is_some() || args.fit.is_some() || args.fit_check.is_some() {
        return false;
    }
    args.setup || !setup_file_exists
}

fn parse_backend(value: &str) -> Result<Backend, String> {
    Backend::parse(value).map_err(|e| format!("--backend: {e}"))
}

fn parse_buffer(value: &str) -> Result<u32, String> {
    match value.trim().parse::<u32>() {
        Ok(n) if n > 0 => Ok(n),
        _ => Err(format!(
            "--buffer must be a whole number of frames above 0, got: {value}"
        )),
    }
}

fn parse_ws_port(value: &str) -> Result<u16, String> {
    match value.trim().parse::<u16>() {
        Ok(n) if n > 0 => Ok(n),
        _ => Err(format!(
            "--ws-port must be a port number from 1 to 65535, got: {value}"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(list: &[&str]) -> Result<Args, String> {
        let owned: Vec<String> = list.iter().map(|s| s.to_string()).collect();
        parse_args(&owned)
    }

    #[test]
    fn no_args_is_default() {
        assert_eq!(parse(&[]), Ok(Args::default()));
    }

    #[test]
    fn no_record_flag() {
        assert_eq!(
            parse(&["--no-record"]),
            Ok(Args {
                no_record: true,
                ..Args::default()
            })
        );
    }

    #[test]
    fn record_wav_flag() {
        assert_eq!(parse(&["--record-wav"]), Ok(Args { record_wav: true, ..Args::default() }));
    }

    #[test]
    fn usage_mentions_record_wav() {
        assert!(USAGE.contains("[--no-record] [--record-wav]"), "{USAGE}");
        assert!(USAGE.contains("  --record-wav         also save the session audio"), "{USAGE}");
    }

    #[test]
    fn record_dir_separate_and_equals() {
        let want = Ok(Args {
            record_dir: Some("out".to_string()),
            ..Args::default()
        });
        assert_eq!(parse(&["--record-dir", "out"]), want);
        assert_eq!(parse(&["--record-dir=out"]), want);
    }

    #[test]
    fn record_dir_missing_value() {
        assert_eq!(
            parse(&["--record-dir"]),
            Err("--record-dir needs a value".to_string())
        );
    }

    #[test]
    fn play_separate_and_equals() {
        let want = Ok(Args {
            play: Some("latest".to_string()),
            ..Args::default()
        });
        assert_eq!(parse(&["--play", "latest"]), want);
        assert_eq!(parse(&["--play=latest"]), want);
    }

    #[test]
    fn play_missing_value() {
        assert_eq!(parse(&["--play"]), Err("--play needs a value".to_string()));
    }

    #[test]
    fn play_and_demo_conflict() {
        assert_eq!(
            parse(&["--play", "x.mid", "--demo"]),
            Err("--play and --demo cannot be used together".to_string())
        );
    }

    #[test]
    fn list_flag() {
        assert_eq!(
            parse(&["--list"]),
            Ok(Args {
                list: true,
                ..Args::default()
            })
        );
    }

    #[test]
    fn port_with_separate_value() {
        assert_eq!(
            parse(&["--port", "2"]),
            Ok(Args {
                port: Some("2".to_string()),
                ..Args::default()
            })
        );
    }

    #[test]
    fn port_with_equals_value() {
        assert_eq!(
            parse(&["--port=sl"]),
            Ok(Args {
                port: Some("sl".to_string()),
                ..Args::default()
            })
        );
    }

    #[test]
    fn last_port_wins() {
        assert_eq!(
            parse(&["--port", "1", "--port=2"]),
            Ok(Args {
                port: Some("2".to_string()),
                ..Args::default()
            })
        );
    }

    #[test]
    fn port_missing_value_is_error() {
        assert_eq!(parse(&["--port"]), Err("--port needs a value".to_string()));
    }

    #[test]
    fn unknown_argument_is_error() {
        assert_eq!(
            parse(&["--bogus"]),
            Err("unknown argument: --bogus".to_string())
        );
    }

    #[test]
    fn help_flags() {
        assert_eq!(
            parse(&["-h"]),
            Ok(Args {
                help: true,
                ..Args::default()
            })
        );
        assert_eq!(
            parse(&["--help"]),
            Ok(Args {
                help: true,
                ..Args::default()
            })
        );
    }

    #[test]
    fn audio_device_with_separate_value() {
        assert_eq!(
            parse(&["--audio-device", "1"]),
            Ok(Args {
                audio_device: Some("1".to_string()),
                ..Args::default()
            })
        );
    }

    #[test]
    fn audio_device_with_equals_value() {
        assert_eq!(
            parse(&["--audio-device=realtek"]),
            Ok(Args {
                audio_device: Some("realtek".to_string()),
                ..Args::default()
            })
        );
    }

    #[test]
    fn audio_device_missing_value_is_error() {
        assert_eq!(
            parse(&["--audio-device"]),
            Err("--audio-device needs a value".to_string())
        );
    }

    #[test]
    fn buffer_value_parsed() {
        assert_eq!(
            parse(&["--buffer", "128"]),
            Ok(Args {
                buffer: Some(128),
                ..Args::default()
            })
        );
    }

    #[test]
    fn buffer_with_equals_value() {
        assert_eq!(
            parse(&["--buffer=256"]),
            Ok(Args {
                buffer: Some(256),
                ..Args::default()
            })
        );
    }

    #[test]
    fn buffer_rejects_zero_and_non_numbers() {
        for case in [&["--buffer", "0"][..], &["--buffer", "abc"][..], &["--buffer=-5"][..]] {
            let err = parse(case).unwrap_err();
            assert!(
                err.starts_with("--buffer must be a whole number of frames above 0"),
                "error: {err}"
            );
        }
    }

    #[test]
    fn buffer_missing_value_is_error() {
        assert_eq!(
            parse(&["--buffer"]),
            Err("--buffer needs a value".to_string())
        );
    }

    #[test]
    fn demo_flag() {
        assert_eq!(
            parse(&["--demo"]),
            Ok(Args {
                demo: true,
                ..Args::default()
            })
        );
        assert_eq!(
            parse(&["--demo", "--port", "2"]),
            Ok(Args {
                demo: true,
                port: Some("2".to_string()),
                ..Args::default()
            })
        );
    }

    #[test]
    fn profile_with_separate_value() {
        assert_eq!(
            parse(&["--profile", "sl990"]),
            Ok(Args {
                profile: Some("sl990".to_string()),
                ..Args::default()
            })
        );
    }

    #[test]
    fn profile_with_equals_value() {
        assert_eq!(
            parse(&["--profile=sl990"]),
            Ok(Args {
                profile: Some("sl990".to_string()),
                ..Args::default()
            })
        );
    }

    #[test]
    fn profile_missing_value_is_error() {
        assert_eq!(
            parse(&["--profile"]),
            Err("--profile needs a value".to_string())
        );
    }

    #[test]
    fn backend_with_separate_value() {
        assert_eq!(
            parse(&["--backend", "asio"]),
            Ok(Args {
                backend: Some(Backend::Asio),
                ..Args::default()
            })
        );
    }

    #[test]
    fn backend_with_equals_value() {
        assert_eq!(
            parse(&["--backend=wasapi-exclusive"]),
            Ok(Args {
                backend: Some(Backend::WasapiExclusive),
                ..Args::default()
            })
        );
    }

    #[test]
    fn backend_missing_value_is_error() {
        assert_eq!(
            parse(&["--backend"]),
            Err("--backend needs a value".to_string())
        );
    }

    #[test]
    fn backend_bad_value_is_error() {
        assert_eq!(
            parse(&["--backend", "asoi"]),
            Err("--backend: unknown audio backend \"asoi\"; choose wasapi, asio or wasapi-exclusive".to_string())
        );
    }

    #[test]
    fn ws_port_separate_and_equals() {
        let want = Ok(Args {
            ws_port: Some(8766),
            ..Args::default()
        });
        assert_eq!(parse(&["--ws-port", "8766"]), want);
        assert_eq!(parse(&["--ws-port=8766"]), want);
    }

    #[test]
    fn ws_port_missing_value() {
        assert_eq!(
            parse(&["--ws-port"]),
            Err("--ws-port needs a value".to_string())
        );
    }

    #[test]
    fn ws_port_rejects_bad_values() {
        for case in ["0", "65536", "abc", "-1"] {
            let err = parse(&["--ws-port", case]).unwrap_err();
            assert!(
                err.starts_with("--ws-port must be a port number from 1 to 65535"),
                "error: {err}"
            );
        }
    }

    #[test]
    fn usage_mentions_ws_port() {
        assert!(USAGE.contains("[--ws-port <port>]"), "{USAGE}");
        assert!(USAGE.contains("  --ws-port <port>     send note events"), "{USAGE}");
    }

    #[test]
    fn render_separate_and_equals() {
        let want = Ok(Args {
            render: Some("test".to_string()),
            ..Args::default()
        });
        assert_eq!(parse(&["--render", "test"]), want);
        assert_eq!(parse(&["--render=test"]), want);
    }

    #[test]
    fn ref_and_render_dir_parsed() {
        assert_eq!(
            parse(&["--render", "test", "--ref", "a.wav", "--render-dir=out"]),
            Ok(Args {
                render: Some("test".to_string()),
                reference: Some("a.wav".to_string()),
                render_dir: Some("out".to_string()),
                ..Args::default()
            })
        );
        assert_eq!(
            parse(&["--render", "test", "--ref=b.wav", "--render-dir", "out"]),
            Ok(Args {
                render: Some("test".to_string()),
                reference: Some("b.wav".to_string()),
                render_dir: Some("out".to_string()),
                ..Args::default()
            })
        );
    }

    #[test]
    fn render_conflicts_with_demo_play_list() {
        for case in [
            &["--render", "test", "--demo"][..],
            &["--render", "test", "--play", "x.mid"][..],
            &["--render", "test", "--list"][..],
        ] {
            assert_eq!(
                parse(case),
                Err("--render cannot be used with --list, --demo or --play".to_string())
            );
        }
    }

    #[test]
    fn ref_without_render_is_error() {
        assert_eq!(
            parse(&["--ref", "x.wav"]),
            Err("--ref and --render-dir need --render".to_string())
        );
        assert_eq!(
            parse(&["--render-dir", "out"]),
            Err("--ref and --render-dir need --render".to_string())
        );
    }

    #[test]
    fn render_missing_value() {
        assert_eq!(parse(&["--render"]), Err("--render needs a value".to_string()));
        assert_eq!(parse(&["--ref"]), Err("--ref needs a value".to_string()));
        assert_eq!(
            parse(&["--render-dir"]),
            Err("--render-dir needs a value".to_string())
        );
    }

    #[test]
    fn usage_mentions_render() {
        assert!(USAGE.contains("[--render <test|file.mid|latest>]"), "{USAGE}");
        assert!(USAGE.contains("  --render <x>         render offline"), "{USAGE}");
        assert!(USAGE.contains("  --ref <file.wav>     with --render"), "{USAGE}");
        assert!(USAGE.contains("  --render-dir <path>  with --render"), "{USAGE}");
    }

    #[test]
    fn setup_flag() {
        assert_eq!(parse(&["--setup"]), Ok(Args { setup: true, ..Args::default() }));
        assert_eq!(parse(&["--setup", "--ws-port", "8790"]), Ok(Args { setup: true, ws_port: Some(8790), ..Args::default() }));
    }

    #[test]
    fn setup_conflicts_with_other_modes() {
        for case in [&["--setup", "--demo"][..], &["--setup", "--list"][..], &["--setup", "--play", "x.mid"][..], &["--setup", "--render", "test"][..]] {
            assert_eq!(parse(case), Err("--setup cannot be used with --list, --demo, --play or --render".to_string()));
        }
    }

    #[test]
    fn opens_window_rules() {
        assert!(opens_setup_window(&Args { setup: true, ..Args::default() }, true));
        assert!(opens_setup_window(&Args::default(), false));
        assert!(!opens_setup_window(&Args::default(), true));
        for args in [Args { demo: true, ..Args::default() }, Args { list: true, ..Args::default() }, Args { play: Some("latest".to_string()), ..Args::default() }, Args { render: Some("test".to_string()), ..Args::default() }, Args { help: true, ..Args::default() }] {
            assert!(!opens_setup_window(&args, false), "{args:?}");
        }
    }

    #[test]
    fn parses_fit_flags() {
        let want = Ok(Args {
            fit_check: Some("ref".to_string()),
            fit_notes: Some(vec![60, 72]),
            fit_threads: Some(4),
            ..Args::default()
        });
        assert_eq!(parse(&["--fit-check", "ref", "--fit-notes", "60,72", "--fit-threads", "4"]), want);
        assert_eq!(parse(&["--fit-check=ref", "--fit-notes=72,60", "--fit-threads=4"]), want);
        let want = Ok(Args {
            fit: Some("ref".to_string()),
            fit_out: Some("out".to_string()),
            fit_passes: Some(3),
            ..Args::default()
        });
        assert_eq!(parse(&["--fit", "ref", "--fit-out", "out", "--fit-passes", "3"]), want);
        assert_eq!(parse(&["--fit=ref", "--fit-out=out", "--fit-passes=3"]), want);
        assert!(parse(&["--fit", "r", "--fit-passes", "11"]).is_err());
        assert!(parse(&["--fit", "r", "--fit-threads=0"]).is_err());
    }

    #[test]
    fn fit_modes_conflict_with_other_modes() {
        assert!(parse(&["--fit", "a", "--fit-check", "b"]).is_err());
        for other in [&["--list"][..], &["--demo"][..], &["--play", "x.mid"][..], &["--render", "test"][..], &["--setup"][..]] {
            for mode in ["--fit", "--fit-check"] {
                let mut v = vec![mode, "ref"];
                v.extend_from_slice(other);
                assert!(parse(&v).is_err(), "{v:?}");
            }
        }
        assert!(parse(&["--fit-out", "o"]).is_err());
        assert!(parse(&["--fit-passes", "2"]).is_err());
        assert!(parse(&["--fit-check", "r", "--fit-out", "o"]).is_err());
        assert!(parse(&["--fit-notes", "60"]).is_err());
        assert!(parse(&["--fit-threads", "2"]).is_err());
        assert!(!opens_setup_window(&Args { fit: Some("r".to_string()), ..Args::default() }, false));
        assert!(!opens_setup_window(&Args { fit_check: Some("r".to_string()), ..Args::default() }, false));
    }

    #[test]
    fn note_list_parsing() {
        assert_eq!(parse_note_list("60"), Ok(vec![60]));
        assert_eq!(parse_note_list("21-23,60"), Ok(vec![21, 22, 23, 60]));
        assert_eq!(parse_note_list("60,59"), Ok(vec![59, 60]));
        assert!(parse_note_list("20").unwrap_err().contains("20"));
        assert!(parse_note_list("70-60x").unwrap_err().contains("70-60x"));
        assert!(parse_note_list("").is_err());
    }

    #[test]
    fn transpose_and_octave_flags() {
        let want = Ok(Args { transpose: Some(3), octave: Some(2), ..Args::default() });
        assert_eq!(parse(&["--transpose", "+3", "--octave", "2"]), want);
        assert_eq!(parse(&["--transpose=3", "--octave=2"]), want);
        assert_eq!(parse(&["--transpose", "-12"]), Ok(Args { transpose: Some(-12), ..Args::default() }));
        assert_eq!(parse(&["--octave=-2"]), Ok(Args { octave: Some(-2), ..Args::default() }));
    }

    #[test]
    fn transpose_and_octave_reject_bad_values() {
        for v in ["13", "-13", "x"] {
            let err = parse(&["--transpose", v]).unwrap_err();
            assert!(err.starts_with("--transpose must be a whole number from -12 to 12"), "{err}");
        }
        let err = parse(&["--octave", "3"]).unwrap_err();
        assert!(err.starts_with("--octave must be a whole number from -2 to 2"), "{err}");
        assert_eq!(parse(&["--transpose"]), Err("--transpose needs a value".to_string()));
        assert_eq!(parse(&["--octave"]), Err("--octave needs a value".to_string()));
    }

    #[test]
    fn usage_mentions_transpose() {
        assert!(USAGE.contains("[--profile <name>] [--transpose <n>] [--octave <n>]"), "{USAGE}");
        assert!(USAGE.contains("  --transpose <n>      shift the sound"), "{USAGE}");
        assert!(USAGE.contains("  --octave <n>         shift the sound"), "{USAGE}");
    }

    #[test]
    fn metronome_flag() {
        let want = Ok(Args { metronome: Some(132), ..Args::default() });
        assert_eq!(parse(&["--metronome", "132"]), want);
        assert_eq!(parse(&["--metronome=132"]), want);
    }

    #[test]
    fn metronome_flag_rejects_bad_values() {
        for v in ["29", "301", "x"] {
            let err = parse(&["--metronome", v]).unwrap_err();
            assert!(err.starts_with("--metronome must be a tempo in bpm from 30 to 300"), "{err}");
        }
        assert_eq!(parse(&["--metronome"]), Err("--metronome needs a value".to_string()));
    }

    #[test]
    fn usage_mentions_metronome() {
        assert!(USAGE.contains("[--octave <n>] [--metronome <bpm>]"), "{USAGE}");
        assert!(USAGE.contains("  --metronome <bpm>    live sessions start with the metronome"), "{USAGE}");
    }

    #[test]
    fn usage_mentions_setup() {
        assert!(USAGE.contains("[--setup] [--help]"), "{USAGE}");
        assert!(USAGE.contains("  --setup              open the setup window"), "{USAGE}");
    }
}
