# rusty_piano engine

Real-time MIDI to audio engine in Rust for a Studiologic SL990 controller.
Currently: MIDI input via midir drives a live piano voice through cpal audio output; a `SoundEngine` trait and sine `TestTone` exist.

## Build, run, test

Run inside `engine/`:

    cargo run                          auto-connects to a port containing SL990,
                                       plays sound on the default output and prints
                                       NoteOn/NoteOff/Sustain and Pedal lines (for example
                                       "Pedal sustain 100") until Enter
    cargo run -- --demo                hear a demo without a keyboard
    cargo run -- --play <file|latest>  play a .mid file (latest = newest recording), then exit
    cargo run --release -- --render <test|file.mid|latest> [--ref <file.wav>]   render offline to WAV + metrics JSON (see Render and metrics)
    cargo run -- --record-wav          also save the session audio as .wav
    cargo run -- --list                list MIDI ports and audio output devices
    cargo run -- --port <index|name>   connect to a MIDI port by index or name (any case)
    cargo run -- --audio-device <index|name>   pick the audio output
    cargo run -- --buffer <frames>     ask the audio device for this buffer size
    cargo run -- --profile <name>      sound profile engine/profiles/<name>.ron
    cargo run -- --backend <wasapi|asio|wasapi-exclusive>   pick the audio backend (see Audio backends)
    cargo run -- --ws-port <port>      send live note events over a WebSocket (also with --demo/--play)
    cargo run -- --transpose <n> --octave <n>   shift the sound by semitones/octaves (see Transpose and octave shift)
    cargo run -- --metronome <bpm>     live session with the metronome click on (see Metronome)
    cargo run -- --setup               open the setup window, then play (also opens by itself when setup.ron is missing)
    cargo test

Tip: `cargo run --release` gives the smoothest playback.

Windows port names may differ from the product name (winmm can truncate or
prefix e.g. "MIDIIN2 ("), so run --list and use --port if SL990 is not found.

## Audio backends

Pick one with `--backend <name>` or `backend` in `engine/setup.ron` (flag > setup.ron > default `wasapi`).

- `wasapi` (default): WASAPI shared mode via cpal, works everywhere. Windows calls back once per device period (~10 ms) whatever `--buffer` asks, so expect ~10-20 ms latency.
- `asio`: an ASIO driver such as FlexASIO via cpal's ASIO host. Needs a build with the `asio` cargo feature (see below).
- `wasapi-exclusive`: WASAPI exclusive mode via the wasapi crate. Low latency without ASIO, but it locks the device for other apps (see below).

`--audio-device` / `audio_device` and `--buffer` / `buffer_frames` apply to the selected backend. `--list` shows the devices of each backend and marks the selected one. A backend that is not in this build (`asio` in a `--no-default-features` build) stops with exit code 2 and says how to build it. A backend that cannot open its device behaves like any audio failure: a warning and MIDI-only in normal mode, exit 1 with `--demo`.

### ASIO / FlexASIO

    cargo run --release -- --backend asio

The `asio` feature is on by default. bindgen needs libclang (the MSYS2 clang) and the MSVC target argument, otherwise bindgen emits GNU struct layouts and asio-sys fails to build; the repo's `.cargo/config.toml` sets `LIBCLANG_PATH = C:\msys64\ucrt64\bin` and `BINDGEN_EXTRA_CLANG_ARGS = --target=x86_64-pc-windows-msvc` for every cargo command run inside the repo (real environment variables with the same names win). The first asio build downloads the Steinberg ASIO SDK to `%TEMP%\asio_sdk` (or uses the folder in `CPAL_ASIO_DIR`); it is proprietary and never committed. On a machine without MSYS2 clang, build without ASIO: `cargo build --no-default-features`.

Without `--audio-device` the engine prefers a driver named FlexASIO, else the first ASIO driver. `cargo run -- --list --backend asio` lists the drivers.

FlexASIO plays on the output named in `%USERPROFILE%\FlexASIO.toml` (`device` under `[output]`), or on the Windows default output when that line is missing. The setup window can change it for you (see "Setup window").

FlexASIO offers only its `bufferSizeSamples`, so set the size in FlexASIO.toml rather than with `--buffer`; a `--buffer` outside the driver's range prints a note and uses the driver's size. The engine renders at whatever sample rate the driver runs (usually 48 kHz).

`%USERPROFILE%\FlexASIO.toml` verified by ear on this laptop (Realtek speakers, SL990), clean at 64 samples:

    backend = "Windows WASAPI"
    bufferSizeSamples = 64
    [input]
    device = ""
    [output]
    device = "Speakers (Realtek(R) Audio)"

What was tried on the Realtek laptop and why it is not used:
- `wasapiExclusiveMode = true`: first needs 'Allow applications to take exclusive control' on the device (otherwise FlexASIO reports no sample rate and is missing from `--list`). With it allowed, the stream stops after a few buffers at 64 and 160 samples (`WAIT_TIMEOUT - probably bad audio driver` in the FlexASIO log): silence, and killing the engine left Windows audio hung until a reboot.
- `backend = "Windows WDM-KS"` (device "Speakers 1 (Realtek HD Audio output with HAP)"): plays, but crackles at 128 and 256 samples.
- Other hardware may do better with these; raise `bufferSizeSamples` if you hear crackles.
- Restart the engine after editing.
- Debugging: an empty `%USERPROFILE%\FlexASIO.log` makes FlexASIO log everything (remove it afterwards; logging every buffer can itself cause crackles).
- Full options: https://github.com/dechamps/FlexASIO/blob/master/CONFIGURATION.md

### WASAPI exclusive

- `cargo run --release -- --backend wasapi-exclusive` (no special build).
- It takes the device for itself: other apps cannot play on it while the engine runs.
- If Windows refuses, tick 'Allow applications to take exclusive control of this device' (Sound settings > More sound settings > device > Properties > Advanced).
- Without `--buffer` it uses the device's minimum period; `--buffer` asks for another size, rounded to what the device accepts, and the actual size is printed.
- The format is picked automatically (f32, i32, i24, i16 at the device's rate first, then 48000 and 44100 Hz).
- If another app already holds the device exclusively, it fails with a hint.
- Some USB devices stutter in exclusive event mode; use asio for those.

## Sound profiles and setup

- `profiles/default.ron` is the original sound; `profiles/sl990.ron` is tuned for the SL990 + laptop speakers (+8.9 dB, velocity 90 = full force, bass compensation). Every number is commented with its range.
- Live tuning: save the profile file while playing and it applies within about 0.5 s. `master_volume` and the limiter act at once, everything else on the next notes. A broken edit prints an error and keeps the last good settings.
- `engine/setup.ron` (copy from `setup.example.ron`, or let the setup window write it; not committed) holds `midi_port`, `audio_device`, `buffer_frames`, `backend`, `profile`, `ws_port`, `record` and `record_dir`. It is read at startup; flags override it; if it is missing, built-in defaults are used and a live start opens the setup window.
- A broken `setup.ron` or a missing/broken chosen profile stops every mode with exit code 2, including `--list` (fix the file or pass flags), except `--setup`, which warns and opens the window from the built-in defaults.
- Files are looked up in the engine folder (CARGO_MANIFEST_DIR) wherever `cargo run` is started.

## Modal piano engine (physical model)

A second engine, selected with `--profile physical` (or `profile: Some("physical")` in `engine/setup.ron`, or the setup window). Its profile is `profiles/physical.ron`; its first setting, `engine: Modal,` (just below the header comment), picks the engine.

- What it models now: inharmonic modal strings (stiffness per register), 1 to 3 detuned unison strings per key, per-partial decay (frequency-dependent damping), strike position, a nonlinear felt hammer with velocity-dependent speed, dampers and the sustain pedal, stereo pan (bass left, treble right), a shared soundboard (board modes plus a two-way coupled low-partial bank through the bridge), two virtual microphones with a body path, sympathetic resonance of free strings (sustain pedal, held keys, sostenuto, and the undamped treble) and key, hammer and pedal noises.
- Also available: an output EQ and an optional room reverb (see below). The shipped `physical` and `physical_sl990` are fitted to Pianoteq 9 NY Steinway D Player renders (see `## Fitting to reference renders`); the rest of the values are approximate published grand-piano data. Hammer mass and unison detune are not fitted.
- Choose it: `cargo run -- --profile physical`, or `profile: Some("physical")` in `engine/setup.ron`, or pick the profile in the setup window. The engine is printed on startup as `Sound engine: modal piano (physical model)`.
- Tuning loop: `cargo run --release -- --render test --profile physical` renders the test piece with metrics, and `engine/renders/test/render.wav` is 2-channel. While playing, save `engine/profiles/physical.ron`: board and mics edits apply at once, decay edits reach the coupled low partials of sounding notes at once (other partials on the next note-on), coupled modes of sounding notes are updated unless the coupled split changes (then new notes only), resonance edits re-set the free strings at once (a short CPU spike), noise levels apply to the next noise, and other edits apply to new notes within about 0.5 s; a broken or out-of-range edit prints an error and the last good settings stay active. Changing `engine` needs a restart.
- SL990 variant: `--profile physical_sl990` (`profiles/physical_sl990.ron`) is the same engine with `full_force_velocity` 90 (the SL990's hardest hits reach about 85, so playing is louder and brighter through the hammer physics) and a bass lift of `level_tilt_db_per_octave: -1.5` for laptop speakers. For headphones set `level_tilt_db_per_octave` back to 0.0.
- Main knobs by section:
  - `output`: `master_volume`, `output_gain` (overall level; fitted toward Pianoteq's level and capped so the test piece stays below the limiter ceiling, about 6.6 dB below Pianoteq for `physical`; `physical_sl990` keeps a gain floor of 0.0086 (raised +6 dB from 0.0043 on 2026-11-08) and relies on the limiter for peaks), `level_tilt_db_per_octave` (brighter or darker keys), `stereo_width`, `limiter_knee`, `limiter_ceiling`.
  - `velocity`: `full_force_velocity`, `hammer_speed_min_mps` and `hammer_speed_max_mps` (hammer speed range), `speed_curve`.
  - `strings`: `tension_n`, `length_*` (string lengths by register), `inharmonicity_*`, `two_strings_from_note` and `three_strings_from_note` (unison count), `unison_detune_cents`, `unison_decay_spread`, `strike_position_bass` and `strike_position_treble`, `max_partials`, `max_mode_hz`.
  - `decay`: `t60_*` (decay times; the table is the total in-phase decay, and `physical_sl990` shares the same board), `damping_per_khz2` (high partials die faster), `damper_t60_bass_s` and `damper_t60_treble_s`, `undamped_from_note` (keys from here up ring without dampers; fitted from the references, 97 in the shipped profiles); in the notes table, `damper` goes up to 30.
  - `notes`: per-note table (88 anchors in the shipped profiles) with, among others, `strike` (strike position factor), and the explicit two-stage decay fields `prompt_db_per_s` (prompt decay rate) and `after_level_db` (aftersound level).
  - `hammer`: `mass_*_g`, `force_1mm_*_n` (felt stiffness), `exponent_*` (felt nonlinearity).
  - `eq`: output EQ before the limiter (see below).
  - `reverb`: optional room reverb (see below).
  - `voices`: `max_voices` (at most 32).
  - `soundboard`: `modes` (number of board modes), `lowest_hz` and `highest_hz` (mode frequency range), `q_low` and `q_high` (mode sharpness), `mode_peak` (peak mobility of a board mode relative to the bridge), `bridge_impedance_kg_s` (lower = stronger coupling: longer aftersound, more sympathetic links), `coupling` (0 = one-way board, 1 = full two-way coupling), `coupled_partials` and `coupled_max_hz` (how many low partials per string are coupled two-way), `body_*` (the body resonance path).
  - `mics`: `spacing_m` and `height_m` (microphone placement), `direct_mix` (bridge force heard directly), `board_mix` (soundboard through the microphones), `body_mix` (body path).
  - `resonance`: `strength` (coupling of free strings relative to `soundboard.coupling`; 0 = off), `partials` and `max_hz` (how many low partials of each free string ring along). Costs CPU while the pedal is down.
  - `noises`: `key_down`, `key_up`, `hammer_knock`, `pedal_down`, `pedal_up` (fractions of the middle C fortissimo bridge force; 0 = off).
- CPU budget check: `cargo test --release --test modal_budget -- --nocapture` (prints the real-time factors; see modal_budget output). It is skipped in debug builds.
- A future digital waveguide engine goes in `engine/src/sound/waveguide_piano/` (placeholder for now). Changing the engine kind needs a restart.

### EQ

`eq` is a low shelf, three peaking bands and a high shelf applied to the output before the limiter. A band with gain 0.0 is off; all gains 0.0 gives exactly the dry sound. Frequencies are in hertz (20 to 20000), gains in dB (-12 to 12), Q 0.1 to 10. Live: edits apply while playing.

    eq: (low_shelf_hz: 120.0, low_shelf_db: 0.0, ..., high_shelf_hz: 6000.0, high_shelf_db: 2.0),

### Reverb

`reverb` is an 8-line feedback room reverb added before the limiter. It is off by default (`mix: 0.0` is exactly the dry sound).

    reverb: (mix: 0.25, size: 1.0, decay_s: 1.6, damping_hz: 5000.0, predelay_ms: 15.0),

- `mix` is the wet level, `size` scales the reflections, `decay_s` is the time to -60 dB, `damping_hz` is where the tail darkens, `predelay_ms` is the gap before it starts.
- Live toggle: setting `mix` to 0.0 while the tail is sounding may click, because the wet signal is cut and no ramp is implemented. Change `mix` between phrases, or lower it in steps.
- CPU: the test piece with `mix: 0.25` is checked by `test_piece_with_reverb_renders_fast_enough` in `tests/modal_budget.rs` (at least 15x real time).

### Absolute level

The shipped `physical` output gain is fitted to match Pianoteq's level, then capped so the test piece stays below the limiter ceiling before the limiter (the limiter catches rare louder chords). This leaves `physical` about 6.6 dB below Pianoteq (fit of 2026-11-06: level match 0.0278, cap 0.0130). `physical_sl990` keeps a gain floor of 0.0086 (raised +6 dB from 0.0043 on 2026-11-08) (its test-piece cap at the reference velocities, about 0.0016, would make it quieter than before because of `master_volume` 4.0 and the bass tilt), so the limiter catches its loud peaks. `output.master_volume` is the knob: raise it if you never play that loud.

## Setup window

`cargo run --release -- --setup` (or `make setup` in the repo root) opens a small window. It also opens by itself on a live start when `engine/setup.ron` does not exist yet (never with --list, --demo, --play or --render); otherwise startup stays console-only. Flags given with it only fill in the starting values. A missing `setup.ron` therefore also opens the window from `make engine` and `make dev`.

- Settings: MIDI input port (Auto = first port containing SL990), audio backend, output device or ASIO driver of that backend, buffer size, sound profile, recording on/off and folder, Also record audio (WAV), live event WebSocket on/off and port (8790 for the coach page), Transpose and Octave shift, Metronome on at start, Tempo (bpm), Beats per bar and Click volume (%).
- FlexASIO output: with backend ASIO and the FlexASIO driver (picked, or Default when FlexASIO is installed) on FlexASIO's Windows WASAPI backend, a row under the output device lists "Windows default output" and the Windows outputs (speakers, headphones...), starting on the current one. Save and start and Test sound change only the `device` line under `[output]` in `%USERPROFILE%\FlexASIO.toml` before the sound opens. The old file is kept as `FlexASIO.toml.bak`, and nothing is written when the choice is unchanged. "Windows default output" removes the line. The choice is not stored in `setup.ron`. With ASIO4ALL a note says to pick the output in its tray panel. With another FlexASIO backend (such as WDM-KS) or an unreadable file, a note says to edit the file by hand.
- Test sound plays C4 up to C5, then a held C major chord (about 4 s), through the chosen backend, device, buffer and profile. It is a built-in .mid file played through the same timeline as --play.
- Save and start writes `engine/setup.ron` in the commented layout of `setup.example.ron` (the old file is kept as `setup.ron.bak`; comments added by hand are lost), then starts the engine like console live mode: sound, recording, live profile reload and the WebSocket.
- While playing, the window shows the MIDI port, backend and device, the real buffer and latency, the profile, the recording file, the audio recording file, the WebSocket address, the last note, a Transpose row (-1/+1 semitone, -1/+1 octave and Reset buttons, live and not saved), a Metronome row (on/off checkbox, bpm, beats per bar and volume, live and not saved; it reads "(no sound, no click)" when no audio runs) and an 88-key strip with the held keys and the pedal.
- Stop, closing the window or Ctrl-C in the console saves the recording like Enter does in console mode. After Stop you can change settings and start again.
- The first `make setup` (or any first `cargo run --release`) builds eframe in release once, which takes a few minutes.
- If the window cannot open, the engine prints `error: cannot open the setup window: ...` and exits with code 1. Copy `setup.example.ron` to `setup.ron` to start in console mode without it.
- The settings list is built from field descriptions in `src/setup_form.rs`, so sound-profile and modelling parameters can be added there later.

## Transpose and octave shift

- `--transpose <n>` shifts the sound by n semitones (-12 to 12) and `--octave <n>` by n octaves (-2 to 2), and the two add up; the same values can come from `transpose` / `octave` in setup.ron or from the setup window (flag > setup.ron > 0).
- Only the sound shifts: the .mid recording, the live events for the coach page, the console lines and the setup window's key strip keep the keys you pressed, so the score follower still follows the written notes.
- In the setup window's running view, -1/+1 semitone, -1/+1 octave and Reset change it live; live changes are not saved (Save and start writes the settings fields).
- A key keeps the shift it was pressed with until you release it, so changing the shift while holding keys never leaves notes hanging; a note shifted below 0 or above 127 is not sent. The physical profiles also ignore notes outside the piano range 21-108, but the default (simple) engine still plays them, so keep shifts small near the ends of the keyboard.
- Applies to live sessions, --demo, --play and the setup window's Test sound, not to --render.

## Metronome

- Start it with `--metronome <bpm>` or `metronome: Some(true)` in setup.ron; `metronome_bpm`, `metronome_beats_per_bar` and `metronome_volume` set the rest, and the setup window's settings have the same fields (saved by Save and start).
- Live sessions only (console live mode and the setup window); --demo, --play, Test sound and --render have no click, and --metronome is ignored there.
- While playing, the setup window's running view switches it on or off and changes tempo, beats per bar and volume live (not saved); a WebSocket client can send commands (see Live events).
- The click is made on the audio thread and counted in samples, so it stays exactly in time with the sound even when the page or the window lags. Beat 1 is a higher click (1600 Hz) than the others (1000 Hz), about 30 ms each.
- The click is not in the .mid recording (and not in the WAV recording).
- A tempo change re-times the pending beat; the click never jumps back. Start while running restarts at beat 1.
- Without sound there is no click and no beat events, and `on` stays false (the setup window's running view shows "(no sound, no click)").

## Session recording

Every live MIDI session is recorded: note on/off and pedal (CC64/66/67) events with their values.

- Files go to `coach/data/sessions/` in the repo (override with `--record-dir <path>`), named `session-YYYYMMDD-HHMMSS.mid` (UTC start time).
- Format 0, 480 ticks per quarter at 120 bpm, so about 1 ms per tick.
- The file is rewritten every 10 s and on exit. Enter, Ctrl-C, Ctrl-Break and closing the console window all save the recording before exiting; only a hard kill (Task Manager, power loss) can lose up to the last 10 s.
- A session with no notes writes nothing.
- `--record-wav` or `record_wav: Some(true)` also saves the session audio as `session-YYYYMMDD-HHMMSS.wav` next to the .mid (same name); off by default.
- The WAV is 16-bit stereo at the device's sample rate (about 11 MB per minute); it is what the sound engine played, without the metronome click.
- The WAV header is updated every 10 s; Enter, Ctrl-C, Ctrl-Break, closing the console window and Stop or close in the setup window finish it. A session with no notes keeps neither file.
- `--no-record` (or `record: Some(false)`) turns the WAV off too; without sound there is no WAV. The audio thread never waits for the disk: if the writer falls behind, frames are dropped and the save message says how many.
- `--no-record` turns recording off. Nothing is recorded (neither .mid nor WAV) in `--demo`, `--play` or `--list`.
- Play the last session: `cargo run -- --play latest` (or `--play <file.mid>`); it uses the same sound profile and audio options as live play.

## Render and metrics (sound tuning)

Renders a piece offline to a WAV file and prints sound metrics, so a profile can be tuned by editing, rendering and comparing without listening to every step. It uses the same `SimplePiano` and sound profile (`--profile` / setup.ron) as live play. There is no audio device, and it is faster than real time.

    cargo run --release -- --render test                   built-in test piece
    cargo run --release -- --render <file.mid>             any MIDI file
    cargo run --release -- --render latest                 newest session recording
    cargo run --release -- --render test --ref <file.wav>  also compare with a reference WAV

- Inputs: `test` is the built-in test piece (about 53 s): a velocity ladder on notes 36/60/84 at velocities 16 to 127; A0 and C1 to C8 at velocity 80; a C major chord at 90 and at 40; a sustain-pedal phrase.
- Inputs longer than 30 minutes are refused (the whole WAV is kept in memory).
- Output: `engine/renders/<piece>/` (gitignored; the piece is `test` or `mid-<file stem>`; change the folder with `--render-dir <path>`). It holds `render.wav` (48 kHz mono 32-bit float; the same profile and input give identical files), `render.json`, and `test.mid` for the test piece. The earlier render is kept as `previous.wav` and `previous.json` and compared automatically.
- Metrics:
  - per note segment (notes starting within 5 ms of each other): peak_db; rms_db (first 0.5 s); attack_ms (time to 90% of peak); decay_db_per_s and t60_s (line fit while the key or pedal is held); release_ms (time to fall 30 dB after key up); centroid_hz and brightness (centroid / fundamental); partials_db (partials 1 to 8 relative to the fundamental, single notes only);
  - velocity_curves with dynamic_range_db (per note, from the velocity ladder);
  - whole file: peak, RMS, loudest 400 ms, clipped samples, centroid, octave bands 31.5 Hz to 16 kHz relative to the total.
- Comparisons are current minus other. rms_offset_db is the overall level difference; rms_db_rel is the shape after removing it.
- Reference: render `engine/renders/test/test.mid` in Pianoteq 9, export a WAV (any sample rate, stereo is fine), then run `--render test --ref <file.wav>`. The two are aligned by their first onset; offset_ms is reported.
- Known limits: partials_db picks the strongest FFT bin near each partial and refines it by parabolic interpolation of the log magnitudes. Before that refinement the Hann-window scalloping (up to 1.4 dB per partial, depending on where the partial falls between bins, which differs between sample rates) made near-identical audio at 48 kHz and 44.1 kHz differ by several dB, which was the cause of the reference mismatch. Now partials well above the noise agree within 2 dB across sample rates and 16-bit quantisation. Partials below about -80 dB relative to the fundamental sit near the 16-bit noise floor and still differ between a float render and a 16-bit reference; read them with caution. The input `.mid` is treated as the built-in test piece (and gets its sections) only when its notes, velocities and order match and onsets are within 5 ms of a constant offset.

Example console output (`--render test`, default profile, first render):

    Render: test with profile default -> engine/renders/test/render.wav (52.9 s, 48000 Hz)
    Whole: peak -2.5 dB, RMS -25.9 dB, loudest 400 ms -12.9 dB, clipped samples 0, centroid 684 Hz
    Velocity: note 36 range 25.28 dB, note 60 range 25.25 dB, note 84 range 25.23 dB
    Decay T60: n21 35.1 s, n24 31.4 s, n36 20.8 s, n48 14.7 s, n60 10.4 s, n72 7.3 s, n84 5.2 s, n96 3.7 s, n108 2.6 s
    vs previous: none (first render)
    JSON: engine/renders/test/render.json

A second run with no change in the profile prints `vs previous: 39 segments, mean |change| RMS 0.00 dB, T60 0.00 s, centroid 0.0 Hz, partials 0.00 dB`.

## Fitting to reference renders

EXPERIMENTAL. A fitter compares the physical model with Pianoteq 9 renders (single notes at velocities 16 to 127 plus the test piece) and tunes the per-note table and a few globals. Status: `profiles/physical.ron` and `profiles/physical_sl990.ron` ship the fit (88 notes, 2026-11-06). The shipped-profile gate is `cargo test --release --test fitted_profiles` (needs the private references for the full per-note gate; it is skipped without them). Per-note gate misses that were accepted are listed in `tests/fitted_profiles.rs` (`EXCEPTIONS`) and in `docs/reports/2026-11-06-physical-engine-m6-fit.md`.

Commands, from `engine/`:

    cargo run --release -- --fit-check renders/reference/ny-steinway-d-player --profile physical [--fit-notes 48-72]
    cargo run --release -- --fit renders/reference/ny-steinway-d-player

- `--fit-check <folder>` measures `--profile` (a modal profile) against the reference renders note by note and prints the errors.
- `--fit <folder>` fits and writes `physical.ron`, `physical_sl990.ron` and `fit-report.txt` to `--fit-out` (default `engine/renders/fit`). Nothing in `profiles/` is overwritten; copy files by hand if you want to try them.
- Flags: `--fit-out <dir>` (with --fit), `--fit-notes <list>` (e.g. `60`, `21-108`, `36,48,60-72`; default 21-108), `--fit-passes <n>` (with --fit, 1 to 10, default 5), `--fit-threads <n>` (1 to 64, default all cores, at most 16).
- The single-note measurement (`render_note`) renders with noises and resonance off.
- The fit tunes the per-note table (cents, level, t60, damping, inharmonicity, hardness, damper, aftersound, and now prompt_db_per_s, after_level_db) and these globals: undamped_from_note, the velocity curve (hammer_speed_min_mps, hammer_speed_max_mps, speed_curve), hammer.exponent_bass/exponent_treble, soundboard.coupling_loss_fraction, output_gain and the five EQ gains. Hammer mass and unison detune are not fitted.
- The reference WAVs are private: they stay in the gitignored `renders/reference/` folder, are only read to derive numbers, and are never copied or committed.

## Live events (WebSocket)

- Off unless `ws_port: Some(n)` in setup.ron or `--ws-port <n>` is given (the flag wins).
- Binds 127.0.0.1 only. URL: `ws://127.0.0.1:<port>`.
- Messages (JSON text), first one on connect, then one per event:

      {"type":"hello","version":1,"engine":"rusty_piano","source":"live","time_unit":"ms"}
      {"type":"note_on","t":1250,"note":60,"velocity":100}
      {"type":"note_off","t":1470,"note":60}
      {"type":"sustain","t":3250,"on":true}
      {"type":"pedal","t":3300,"pedal":"sostenuto","value":127}
      {"type":"metronome","on":true,"bpm":100,"beats_per_bar":4,"volume":50}
      {"type":"beat","t":5230,"beat":1,"bar":3,"count_in":false}

- `pedal` is `"sostenuto"` or `"soft"` with `value` 0-127; `sustain` is sent only when the sustain pedal flips at 64.
- `source` is `live`, `demo` or `play`.
- `t` is integer ms of engine time: live, it comes from the MIDI port timestamp; with --demo/--play it is the time since playback start. Compare differences only.
- Events are dropped rather than ever delaying sound (engine queue 1024, per-client queue 256).
- Up to 16 clients at a time; further connections are refused until one closes.
- When the engine stops (end of --demo/--play, or Enter in live mode) each client gets a close frame with code 1000 and reason "engine stopped". Ctrl-C or closing the window may still end the connection without one.
- A client that connects late does not learn the current pedal state.
- Browser pages are accepted only from http://localhost or http://127.0.0.1 origins (any port). Pages opened from file:// (Origin null) are refused; use the Vite server on http://localhost:5173.
- --demo/--play wait up to 10 s for the first client before playing.
- A busy port prints a warning and the engine continues without it.
- In live sessions every client gets a metronome state message right after hello, and again whenever the state changes (setup window, a client command, a count-in that ends with then stop).
- `beat`: one per click; `beat` is 1..beats_per_bar (1 = accented); `bar` counts from 1 at each start; count-in clicks have `count_in` true with bars 1..N, and after a count-in that keeps going, bar starts at 1 again.
- `t` of a beat is engine time in ms on the same clock as note events; in a live session both count from when the MIDI port opened. Note times come from the MIDI driver's timestamps, beat times from the PC's high-resolution clock; the beat clock starts just before the MIDI port is opened and the note clock when the driver starts the port, so the two differ by a constant offset (usually a few ms, possibly tens of ms) for the whole session; a beat's t also jitters by a few ms. A beat's t is when its click was put into the audio buffer (the audio callback start plus the click's sample offset); you hear it about one output buffer later (the Buffer row in the running window), the same delay as the notes the engine plays. Clicks are spaced exactly in samples.
- Commands (client to engine), JSON text:
  - `{"type":"metronome_start"}` (optional `bpm` 30-300, `beats_per_bar` 1-12)
  - `{"type":"metronome_stop"}`
  - `{"type":"metronome_tempo","bpm":96}` (`bpm` and/or `beats_per_bar`)
  - `{"type":"count_in","bars":1,"then":"stop"}` (`bars` 1-8, default 1; `then` is `stop` (default) or `keep`; optional `bpm` and `beats_per_bar`)
  - `{"type":"play_notes","id":"q1","notes":"60:0:800:80,64:800:800"}` (`id` 1-40 of letters, digits `.` `_` `-`; `notes` = up to 128 `note:start_ms:dur_ms[:velocity]` items; note 0-127, start 0-60000, dur 1-10000, velocity 1-127, default 80)
  - `{"type":"play_stop"}`
- Reply to `play_notes` (sent to every client): `{"type":"play_ack","id":"q1","ok":true,"notes":2}`; `ok` is false with a `reason` of `no sound output`, `notes out of range` or `busy`.
- `play_notes` is used by the coach page's ear training. It is played by a second sound engine built with the startup profile (live profile edits do not reach it until restart), shifted by the session transpose (notes shifted outside 0-127 are dropped and `notes` in the ack counts only the rest). It is sound only: never sent as note events, not in the .mid, not in the WAV (which is tapped before it). The prompt engine has its own limiter and the summed output is clamped to [-1, 1]; it stops rendering shortly after the last note fades. A new `play_notes` cuts the previous one. Live sessions only (--demo/--play ignore it, so the page falls back to a browser tone).
- Unknown, malformed or out-of-range text is ignored. With --demo/--play there is no metronome: no state or beat messages, and commands are ignored.
- Quick test: `cargo run -- --demo --ws-port 8790` and connect a client.

## Module map

- `cli`    - command-line argument parsing (`--list`, `--port`, `--audio-device`, `--buffer`, `--profile`, `--backend`, `--demo`, `--no-record`, `--record-dir`, `--record-wav`, `--play`, `--ws-port`, `--render`, `--ref`, `--render-dir`, `--setup`, `--transpose`, `--octave`, `--metronome`, `--help`)
- `midi`   - `MidiEvent`, MIDI byte parsing, port selection (midir input is wired in the binary)
- `audio`  - backend selection and dispatch (WASAPI shared via cpal in audio.rs, `audio/asio.rs` ASIO via cpal's asio feature, `audio/wasapi_exclusive.rs` via the wasapi crate), device list/selection, MIDI-to-audio queue
- `sound`  - `SoundEngine` trait, `simple_piano` live voice, `test_tone` sine, `modal_piano` physical-model piano (`--profile physical`), `waveguide_piano` placeholder for a future waveguide engine
- `fit`    - experimental fitter: `--fit` and `--fit-check` against reference renders
- `sound/modal_piano/eq` - output EQ (shelves and peaking bands)
- `sound/modal_piano/reverb` - 8-line room reverb
- `console` - console stop events (Ctrl-C, Ctrl-Break, window close) so a live session can save before exiting
- `playback` - Standard MIDI File reader and newest-recording lookup for `--play`
- `record` - session recording: hand-written MIDI file encoder and background saver
- `render` - offline rendering (no audio device), built-in test piece, WAV read/write (hound)
- `metrics` - sound metrics: note segments, loudness, decay, release, spectrum (rustfft), velocity curves
- `report` - render report: compares two analyses, hand-written JSON and console summary
- `render_job` - `--render` job: input resolution, output folder with the previous render, reference WAV, JSON file
- `config` - RON sound profiles: types, validation, live reload
- `setup`  - setup.ron and startup settings (flags > setup.ron > built-in)
- `setup_file` - writes setup.ron in the commented template layout, with a setup.ron.bak backup
- `setup_form` - the setup window's settings as field descriptions (device lists, choices, checks)
- `setup_window` - the eframe/egui setup window: settings, Test sound, status, transpose row, 88-key strip, Stop
- `session` - one live session (MIDI in, audio, recording, live reload, WebSocket) shared by console mode and the window
- `timeline` - timed event playback for --demo/--play and the built-in C major test sound
- `transpose` - transpose and octave shift of the sound: shift control, per-key note mapping
- `metronome` - sample-counted click on the audio thread, control handle, WebSocket command parsing and state/beat JSON
- `prompt` - (src/prompt.rs) ear-training prompts: `play_notes`/`play_stop` parsing, second sound engine on the audio thread, `play_ack` JSON
- `wav_record` - session audio to WAV: non-blocking block hand-off (the audio thread never waits) from the audio thread to a writer thread (hound), finish and save message
- `audio/extras` - extra audio-thread processors (metronome click and WAV tap) attached to the output
- `keyboard` - held keys, pedal and last note for the 88-key strip
- `live`   - live event WebSocket: JSON encoder and broadcast server (tungstenite, 127.0.0.1)

Dependencies: midir, cpal, wasapi, serde, ron, tungstenite, hound (WAV), rustfft (FFT) and eframe/egui (setup window, OpenGL glow renderer).
