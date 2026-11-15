use rusty_piano_engine::{audio, cli, config, console, fit, live, midi, playback, render_job, session, setup, setup_window, sound, timeline, transpose};
use session::say;
use std::time::{Duration, Instant};

const WS_CLIENT_WAIT: Duration = Duration::from_secs(10);

fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let args = match cli::parse_args(&argv) {
        Ok(args) => args,
        Err(e) => {
            eprintln!("error: {e}");
            eprintln!("{}", cli::USAGE);
            std::process::exit(2);
        }
    };
    if args.help {
        println!("{}", cli::USAGE);
        return;
    }

    say("rusty_piano engine");
    if let Some(folder) = &args.fit {
        run_fit(&args, folder);
        return;
    }
    let engine_dir = config::engine_dir();
    if cli::opens_setup_window(&args, setup::setup_path(&engine_dir).exists()) {
        run_setup_window(&args, &engine_dir);
        return;
    }
    let startup = match setup::resolve_startup(&args, &engine_dir) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("error: {e}");
            std::process::exit(2);
        }
    };
    for note in &startup.notes {
        say(note);
    }
    say(&format!(
        "Sound profile: {} ({})",
        startup.profile_name,
        startup
            .profile_path
            .as_ref()
            .map(|p| p.display().to_string())
            .unwrap_or_else(|| "built-in".to_string())
    ));
    say(&format!("Sound engine: {}", startup.profile.kind().label()));
    if let Some(target) = &args.render {
        run_render(&startup, &args, target);
        return;
    }
    if let Some(folder) = &args.fit_check {
        run_fit_check(&startup, &args, folder);
        return;
    }
    if args.demo && !args.list {
        run_demo(&startup);
        return;
    }
    if let (Some(play), false) = (&args.play, args.list) {
        run_play(&startup, play);
        return;
    }
    let mut midi_in = match midir::MidiInput::new("rusty_piano") {
        Ok(midi_in) => midi_in,
        Err(e) => {
            eprintln!("error: cannot open MIDI system: {e}");
            std::process::exit(1);
        }
    };
    midi_in.ignore(midir::Ignore::All);

    let ports = midi_in.ports();
    let names: Vec<String> = ports
        .iter()
        .map(|port| {
            midi_in
                .port_name(port)
                .unwrap_or_else(|_| "<unknown>".to_string())
        })
        .collect();

    println!("MIDI input ports:");
    if names.is_empty() {
        println!("  (none)");
    }
    for (i, name) in names.iter().enumerate() {
        println!("  [{i}] {name}");
    }
    if args.list {
        print_audio_devices(startup.backend);
        return;
    }

    drop(ports);
    #[allow(clippy::drop_non_drop)] // drop early so the MIDI client handle is released before the session opens ports
    drop(midi_in);
    let session = match session::Session::start(&startup, None) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("error: {}", e.message);
            if let Some(hint) = &e.hint {
                eprintln!("hint: {hint}");
            }
            std::process::exit(1);
        }
    };
    let handles = session.stop_handles();
    if let Err(e) = console::on_stop(move |name| {
        println!("{name}: stopping.");
        for line in handles.save_now(Duration::from_secs(3)) {
            print_line(&line);
        }
        handles.stop_audio();
        println!("Closed.");
    }) {
        eprintln!("warning: Ctrl-C will not save the recording ({e}); press Enter to quit.");
    }
    println!(
        "Connected to [{}] {}. Play the keyboard; press Enter to quit.",
        session.info.port_index, session.info.port_name
    );
    let mut line = String::new();
    let _ = std::io::stdin().read_line(&mut line);
    for line in session.stop().lines() {
        print_line(&line);
    }
    println!("Closed.");
}

fn run_setup_window(args: &cli::Args, engine_dir: &std::path::Path) {
    let path = setup::setup_path(engine_dir);
    let loaded = match setup::load_setup(&path) {
        Ok(Some(s)) => { println!("Setup: {}", path.display()); s }
        Ok(None) => { println!("Setup: none ({} not found); opening the setup window.", path.display()); setup::Setup::default() }
        Err(e) => { eprintln!("warning: setup file {e}; the window starts from the built-in defaults."); setup::Setup::default() }
    };
    let initial = setup::overlay_args(&loaded, args);
    println!("Opening the setup window...");
    if let Err(e) = setup_window::run(engine_dir.to_path_buf(), initial) {
        eprintln!("error: {e}");
        eprintln!("hint: if the window cannot open, copy engine/setup.example.ron to engine/setup.ron to start without it, or use flags.");
        std::process::exit(1);
    }
    println!("Setup window closed.");
}

fn print_line(line: &str) {
    if line.starts_with("warning:") {
        eprintln!("{line}");
    } else {
        say(line);
    }
}

fn print_audio_devices(selected: audio::Backend) {
    for section in audio::list_sections(selected) {
        println!("{}", section.heading);
        match section.devices {
            Ok(list) if list.is_empty() => println!("  (none)"),
            Ok(list) => {
                for (i, d) in list.iter().enumerate() {
                    let tag = if d.is_default { " (default)" } else { "" };
                    println!("  [{i}] {}{tag}", d.name);
                }
            }
            Err(e) => println!("  ({e})"),
        }
    }
}

fn run_demo(startup: &setup::Startup) {
    let events = midi::demo_sequence()
        .into_iter()
        .map(|(ms, ev)| (ms * 1000, ev))
        .collect();
    run_timeline(
        startup,
        events,
        "Playing demo (about 7 s): arpeggio soft to loud, a held chord, then notes held by the sustain pedal.",
        "Demo done.",
        live::Source::Demo,
    );
}

fn run_play(startup: &setup::Startup, play: &str) {
    let path = if play.eq_ignore_ascii_case("latest") {
        let dir = startup.record_dir.clone();
        match playback::latest_recording(&dir) {
            Ok(p) => p,
            Err(e) => {
                eprintln!("error: cannot play {play}: {e}");
                std::process::exit(1);
            }
        }
    } else {
        std::path::PathBuf::from(play)
    };
    let parsed = std::fs::read(&path)
        .map_err(|e| e.to_string())
        .and_then(|bytes| playback::parse_smf(&bytes));
    let events = match parsed {
        Ok(events) => events,
        Err(e) => {
            eprintln!("error: cannot play {}: {e}", path.display());
            std::process::exit(1);
        }
    };
    if events.is_empty() {
        say(&format!("Nothing to play in {}.", path.display()));
        return;
    }
    let secs = events.last().map(|(us, _)| *us).unwrap_or(0) as f64 / 1_000_000.0;
    let intro = format!(
        "Playing {} ({} events, {:.1} s)",
        path.display(),
        events.len(),
        secs
    );
    run_timeline(startup, events, &intro, "Playback done.", live::Source::Play);
}

fn run_render(startup: &setup::Startup, args: &cli::Args, target: &str) {
    let record_dir = startup.record_dir.clone();
    let input = match render_job::resolve_input(target, &record_dir) {
        Ok(input) => input,
        Err(e) => {
            eprintln!("error: cannot render {target}: {e}");
            std::process::exit(1);
        }
    };
    let out_dir = match &args.render_dir {
        Some(d) => std::path::PathBuf::from(d),
        None => render_job::default_dir(&config::engine_dir()),
    };
    let opts = render_job::RenderOptions {
        input,
        out_dir,
        reference: args.reference.as_ref().map(std::path::PathBuf::from),
        profile: startup.profile,
        profile_name: startup.profile_name.clone(),
        profile_path: startup.profile_path.clone(),
    };
    println!("Rendering offline at 48000 Hz (no audio device)...");
    let start = Instant::now();
    match render_job::run(&opts) {
        Ok(outcome) => {
            print!("{}", outcome.summary);
            println!("Rendered in {:.1} s.", start.elapsed().as_secs_f64());
        }
        Err(e) => {
            eprintln!("error: {e}");
            std::process::exit(1);
        }
    }
}

fn run_fit_check(startup: &setup::Startup, args: &cli::Args, folder: &str) {
    let profile = match &startup.profile {
        config::SoundProfile::Modal(p) => *p,
        _ => {
            eprintln!("error: --fit-check needs a modal profile (for example --profile physical)");
            std::process::exit(2);
        }
    };
    let notes: Vec<u8> = args.fit_notes.clone().unwrap_or_else(|| (21..=108).collect());
    let threads = args
        .fit_threads
        .unwrap_or_else(|| std::thread::available_parallelism().map_or(4, |n| n.get().min(16)));
    let start = Instant::now();
    println!("Checking {} notes against {folder} with {threads} threads...", notes.len());
    let refs = match fit::reference::load_ref_set(std::path::Path::new(folder), &notes, threads) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("error: {e}");
            std::process::exit(1);
        }
    };
    let eval = fit::evaluate::evaluate(&profile, &refs, &notes, threads);
    print!("{}", fit::evaluate::report_table(&eval, None));
    println!("Checked in {:.1} s.", start.elapsed().as_secs_f64());
}

fn run_fit(args: &cli::Args, folder: &str) {
    let fail = |e: String| -> ! {
        eprintln!("error: {e}");
        std::process::exit(1);
    };
    let notes: Vec<u8> = args.fit_notes.clone().unwrap_or_else(|| (21..=108).collect());
    let passes = args.fit_passes.unwrap_or(5);
    let threads = args
        .fit_threads
        .unwrap_or_else(|| std::thread::available_parallelism().map_or(4, |n| n.get().min(16)));
    let engine_dir = config::engine_dir();
    let read = |name: &str| {
        let path = engine_dir.join("profiles").join(name);
        std::fs::read_to_string(&path).unwrap_or_else(|e| fail(format!("cannot read {}: {e}", path.display())))
    };
    let physical = read("physical.ron");
    let sl990 = read("physical_sl990.ron");
    let out = args
        .fit_out
        .as_ref()
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| engine_dir.join("renders").join("fit"));
    if let Err(e) = std::fs::create_dir_all(&out) {
        fail(format!("cannot create {}: {e}", out.display()));
    }
    println!("Fitting {} notes to {folder} with {passes} passes and {threads} threads...", notes.len());
    let refs = fit::reference::load_ref_set(std::path::Path::new(folder), &notes, threads).unwrap_or_else(|e| fail(e));
    let opts = fit::fitter::FitOptions { folder: std::path::PathBuf::from(folder), notes, passes, threads };
    let outcome = fit::fitter::fit(&opts, &refs, &physical, &sl990).unwrap_or_else(|e| fail(e));
    let paths = [out.join("physical.ron"), out.join("physical_sl990.ron"), out.join("fit-report.txt")];
    for (path, text) in paths.iter().zip([&outcome.physical_ron, &outcome.sl990_ron, &outcome.report]) {
        if let Err(e) = std::fs::write(path, text) {
            fail(format!("cannot write {}: {e}", path.display()));
        }
    }
    print!("{}", outcome.report);
    for path in &paths {
        println!("Wrote {}", path.display());
    }
}

fn run_timeline(
    startup: &setup::Startup,
    events: Vec<(u64, midi::MidiEvent)>,
    intro: &str,
    done: &str,
    source: live::Source,
) {
    let profile = startup.profile;
    let audio = match audio::AudioOutput::start(
        startup.backend,
        startup.audio_device.as_deref(),
        startup.buffer,
        move |sr| sound::build_engine(sr, &profile),
    ) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("error: cannot open audio output: {e}");
            eprintln!("hint: use --list to see audio output devices and --audio-device <index|name> to pick one.");
            std::process::exit(1);
        }
    };
    session::print_audio_info(&audio);
    session::start_live_tuning(startup, &audio);
    let live = session::start_live(startup, source);
    if let Some(l) = &live {
        say("Waiting up to 10 s for a WebSocket client...");
        if l.wait_for_client(WS_CLIENT_WAIT) {
            say("WebSocket client connected.");
        } else {
            say("No WebSocket client yet; playing anyway.");
        }
    }
    say(intro);
    let tx = audio.sender();
    let live_tx = live.as_ref().map(|l| l.sender());
    let never = std::sync::atomic::AtomicBool::new(false);
    let mut transposer = transpose::Transposer::new();
    let total = startup.transpose.total();
    timeline::play_timeline(&events, &never, |at, ev| {
        say(&format!("{:>10} ms  {}", at.as_millis(), ev));
        if let Some(sev) = transposer.map(ev, total) {
            let _ = tx.try_send(sev);
        }
        if let Some(live_tx) = &live_tx {
            let _ = live_tx.send(at.as_millis() as u64, ev);
        }
    });
    std::thread::sleep(Duration::from_millis(1500));
    drop(audio);
    if let Some(l) = live {
        l.finish(Duration::from_secs(2));
    }
    say(done);
}
