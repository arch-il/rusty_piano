//! Setup window (eframe/egui): pick the settings, play a test sound, then Save and start writes engine/setup.ron and runs
//! the same live session as console mode. Stop, closing the window or Ctrl-C saves the recording. Logic lives in
//! setup_form, keyboard, session and timeline; this file only draws.
use crate::cli::Args;
use crate::console;
use crate::flexasio;
use crate::keyboard::{self, KeyboardState};
use crate::midi::MidiEvent;
use crate::session::{self, Session, StopHandles};
use crate::setup::{self, Setup, Startup};
use crate::setup_file;
use crate::setup_form::{self, Field, FieldKind, FieldValue, SetupForm};
use crate::timeline::{self, TestSound};
use eframe::egui;
use std::path::PathBuf;
use std::sync::mpsc::{sync_channel, Receiver};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub const TAP_QUEUE: usize = 1024;
const REPAINT: Duration = Duration::from_millis(30);

struct Running { session: Session, keys_rx: Receiver<MidiEvent> }

pub struct SetupApp { engine_dir: PathBuf, form: SetupForm, message: String, test: Option<TestSound>, running: Option<Running>, keys: KeyboardState, stop_slot: Arc<Mutex<Option<StopHandles>>> }

fn print_line(line: &str) {
    if line.starts_with("warning:") { eprintln!("{line}"); } else { session::say(line); }
}

impl SetupApp {
    pub fn new(engine_dir: PathBuf, initial: &Setup, stop_slot: Arc<Mutex<Option<StopHandles>>>) -> SetupApp {
        let inventory = setup_form::gather_inventory(&engine_dir);
        SetupApp { form: SetupForm::new(initial, inventory), engine_dir, message: "Pick your settings, try Test sound, then Save and start.".to_string(), test: None, running: None, keys: KeyboardState::new(), stop_slot }
    }

    /// Writes the chosen FlexASIO output to %USERPROFILE%\FlexASIO.toml before an ASIO stream opens. Ok(Some(msg)) when the file changed.
    fn apply_flexasio(&self) -> Result<Option<String>, String> {
        let Some(device) = self.form.flexasio_output() else { return Ok(None) };
        let path = flexasio::config_path().ok_or_else(|| "USERPROFILE is not set, cannot find FlexASIO.toml".to_string())?;
        flexasio::apply_output(&path, device.as_deref())
    }

    fn test_sound(&mut self) {
        if self.running.is_some() || self.test.is_some() { return; }
        let flexasio_msg = match self.apply_flexasio() {
            Ok(m) => m,
            Err(e) => { self.message = format!("error: {e}"); return; }
        };
        let startup: Result<Startup, String> = self.form.to_setup().and_then(|s| setup::resolve_from(s, &Args::default(), &self.engine_dir, Vec::new()));
        match startup {
            Ok(st) => {
                self.test = Some(TestSound::start(&st, timeline::test_sound_events()));
                self.message = format!("{}Playing the test sound: C4 up to C5, then a C major chord...", flexasio_msg.map(|m| format!("{m} ")).unwrap_or_default());
            }
            Err(e) => self.message = format!("error: {e}"),
        }
    }

    fn start(&mut self) {
        if self.running.is_some() || self.test.is_some() { return; }
        let s = match self.form.to_setup() { Ok(s) => s, Err(e) => { self.message = format!("error: {e}"); return; } };
        let path = setup::setup_path(&self.engine_dir);
        let mut saved = match setup_file::write_setup(&path, &s) {
            Ok(Some(backup)) => format!("Saved {} (old file kept as {}).", path.display(), backup.display()),
            Ok(None) => format!("Saved {}.", path.display()),
            Err(e) => { eprintln!("error: {e}"); self.message = format!("error: {e}"); return; }
        };
        println!("{saved}");
        match self.apply_flexasio() {
            Ok(Some(m)) => { println!("{m}"); saved = format!("{saved} {m}"); }
            Ok(None) => {}
            Err(e) => { self.message = format!("{saved} FlexASIO.toml was not changed: {e}"); return; }
        }
        let startup = match setup::resolve_from(s, &Args::default(), &self.engine_dir, Vec::new()) { Ok(st) => st, Err(e) => { self.message = format!("{saved} error: {e}"); return; } };
        for note in &startup.notes { println!("{note}"); }
        let (tx, rx) = sync_channel(TAP_QUEUE);
        match Session::start(&startup, Some(tx)) {
            Ok(session) => {
                if let Ok(mut slot) = self.stop_slot.lock() { *slot = Some(session.stop_handles()); }
                println!("Connected to [{}] {}. Play the keyboard; press Stop in the window to finish.", session.info.port_index, session.info.port_name);
                self.keys.clear();
                self.running = Some(Running { session, keys_rx: rx });
                self.message = format!("{saved} Playing.");
            }
            Err(e) => {
                eprintln!("error: {}", e.message);
                self.message = match &e.hint { Some(h) => format!("{saved} error: {} (hint: {h})", e.message), None => format!("{saved} error: {}", e.message) };
            }
        }
    }

    fn stop(&mut self) {
        let Some(running) = self.running.take() else { return };
        if let Ok(mut slot) = self.stop_slot.lock() { *slot = None; }
        let lines = running.session.stop().lines();
        self.message = if lines.is_empty() { "Stopped (recording was off).".to_string() } else { lines.join(" ") };
        if lines.is_empty() { println!("{}", self.message); } else { for l in &lines { print_line(l); } }
        self.keys.clear();
    }

    fn settings_ui(&mut self, ui: &mut egui::Ui) {
        ui.heading("rusty_piano setup");
        let mut changes: Vec<(&'static str, FieldValue)> = Vec::new();
        let mut section = "";
        let mut refresh = false;
        let can_refresh = self.running.is_none();
        egui::Grid::new("setup_fields").num_columns(2).spacing([12.0, 6.0]).show(ui, |ui| {
            for field in &self.form.fields {
                if !self.form.visible(field.key) { continue; }
                if field.section != section { section = field.section; ui.strong(section); ui.end_row(); }
                let enabled = self.form.enabled(field.key);
                ui.label(field.label).on_hover_text(field.help);
                ui.add_enabled_ui(enabled, |ui| { if let Some(v) = field_widget(ui, field) { changes.push((field.key, v)); } });
                ui.end_row();
                if field.key == setup_form::KEY_AUDIO_DEVICE {
                    ui.label("");
                    if ui.add_enabled(can_refresh, egui::Button::new("Refresh devices")).clicked() { refresh = true; }
                    ui.end_row();
                    if let Some(note) = self.form.audio_note() { ui.label(""); ui.add(egui::Label::new(note).wrap()); ui.end_row(); }
                }
            }
        });
        for (key, value) in changes { self.form.set(key, value); }
        if refresh {
            self.form.refresh(setup_form::gather_inventory(&self.engine_dir));
            self.message = "Device lists refreshed.".to_string();
        }
        ui.separator();
        let busy = self.test.is_some();
        ui.horizontal(|ui| {
            if ui.add_enabled(!busy, egui::Button::new("Test sound")).clicked() { self.test_sound(); }
            if ui.add_enabled(!busy, egui::Button::new("Save and start")).clicked() { self.start(); }
        });
        ui.label(&self.message);
    }

    fn running_ui(&mut self, ui: &mut egui::Ui) {
        ui.heading("rusty_piano is playing");
        if let Some(r) = &self.running {
            egui::Grid::new("status").num_columns(2).spacing([12.0, 4.0]).show(ui, |ui| {
                for (label, value) in session::status_lines(&r.session.info) { ui.label(label); ui.label(value); ui.end_row(); }
                ui.label("Last note"); ui.label(self.keys.last_note_text()); ui.end_row();
            });
            for w in &r.session.info.warnings { ui.colored_label(egui::Color32::from_rgb(220, 120, 0), w.as_str()); }
            let ctl = r.session.transpose();
            let before = ctl.get();
            ui.horizontal(|ui| {
                ui.label(format!("Transpose: {}", before.label()))
                    .on_hover_text("Live change, not saved. Set Transpose and Octave shift in the settings and use Save and start to keep them.");
                if ui.button("-1 semitone").clicked() { ctl.nudge(-1, 0); }
                if ui.button("+1 semitone").clicked() { ctl.nudge(1, 0); }
                if ui.button("-1 octave").clicked() { ctl.nudge(0, -1); }
                if ui.button("+1 octave").clicked() { ctl.nudge(0, 1); }
                if ui.button("Reset").clicked() { ctl.set(crate::transpose::Shift::default()); }
            });
            let after = ctl.get();
            if after != before { println!("Transpose: {}", after.label()); }
            let met = r.session.metronome();
            let st = met.settings();
            let hint = "Live change, not saved. Set the Metronome fields in the settings and use Save and start to keep them.";
            ui.horizontal(|ui| {
                ui.label("Metronome").on_hover_text(hint);
                let mut on = st.on;
                if ui.checkbox(&mut on, "").on_hover_text(hint).changed() {
                    if on { met.start(); } else { met.stop(); }
                }
                let mut bpm = st.bpm;
                if ui.add(egui::DragValue::new(&mut bpm).range(30..=300).suffix(" bpm")).on_hover_text(hint).changed() { met.set_bpm(bpm); }
                let mut beats = st.beats_per_bar;
                if ui.add(egui::DragValue::new(&mut beats).range(1..=12).suffix(" beats")).on_hover_text(hint).changed() { met.set_beats_per_bar(beats); }
                let mut volume = st.volume;
                if ui.add(egui::Slider::new(&mut volume, 0..=100).suffix(" %")).on_hover_text(hint).changed() { met.set_volume(volume); }
                if r.session.info.audio.is_none() { ui.label("(no sound, no click)"); }
            });
        }
        ui.add_space(8.0);
        draw_keyboard(ui, &self.keys);
        ui.add_space(8.0);
        if ui.button("Stop").clicked() { self.stop(); }
        ui.label(&self.message);
    }
}

fn field_widget(ui: &mut egui::Ui, field: &Field) -> Option<FieldValue> {
    match (&field.kind, &field.value) {
        (FieldKind::Choice(options), FieldValue::Choice(current)) => {
            let mut selected = current.clone();
            let text = options.iter().find(|o| &o.value == current).map(|o| o.label.clone()).unwrap_or_default();
            egui::ComboBox::from_id_salt(field.key).selected_text(text).width(320.0).show_ui(ui, |ui| {
                for o in options { ui.selectable_value(&mut selected, o.value.clone(), o.label.as_str()); }
            });
            if &selected != current { Some(FieldValue::Choice(selected)) } else { None }
        }
        (FieldKind::Toggle, FieldValue::Toggle(on)) => {
            let mut v = *on;
            if ui.checkbox(&mut v, "").changed() { Some(FieldValue::Toggle(v)) } else { None }
        }
        (FieldKind::Text { hint }, FieldValue::Text(text)) => {
            let mut t = text.clone();
            let r = ui.add(egui::TextEdit::singleline(&mut t).hint_text(hint.as_str()).desired_width(320.0));
            if r.changed() { Some(FieldValue::Text(t)) } else { None }
        }
        (FieldKind::Number { min, max }, FieldValue::Number(n)) => {
            let mut v = *n;
            if ui.add(egui::DragValue::new(&mut v).range(*min..=*max)).changed() { Some(FieldValue::Number(v)) } else { None }
        }
        _ => { ui.label("?"); None }
    }
}

fn draw_keyboard(ui: &mut egui::Ui, keys: &KeyboardState) {
    let width = ui.available_width().max(260.0);
    let white_w = width / keyboard::WHITE_KEYS as f32;
    let height = 70.0;
    let (response, painter) = ui.allocate_painter(egui::vec2(width, height + 22.0), egui::Sense::hover());
    let origin = response.rect.min;
    let lit = egui::Color32::from_rgb(70, 140, 255);
    for note in keyboard::LOWEST..=keyboard::HIGHEST {
        if keyboard::is_black_key(note) { continue; }
        if let Some((x, w)) = keyboard::key_span(note, white_w) {
            let rect = egui::Rect::from_min_size(origin + egui::vec2(x, 0.0), egui::vec2(w - 1.0, height));
            painter.rect_filled(rect, 2.0, if keys.is_held(note) { lit } else { egui::Color32::WHITE });
        }
    }
    for note in keyboard::LOWEST..=keyboard::HIGHEST {
        if !keyboard::is_black_key(note) { continue; }
        if let Some((x, w)) = keyboard::key_span(note, white_w) {
            let rect = egui::Rect::from_min_size(origin + egui::vec2(x, 0.0), egui::vec2(w, height * 0.62));
            painter.rect_filled(rect, 2.0, if keys.is_held(note) { lit } else { egui::Color32::BLACK });
        }
    }
    let pedal = egui::Rect::from_min_size(origin + egui::vec2(0.0, height + 6.0), egui::vec2(16.0, 14.0));
    painter.rect_filled(pedal, 3.0, if keys.sustain { lit } else { egui::Color32::DARK_GRAY });
    painter.text(origin + egui::vec2(22.0, height + 13.0), egui::Align2::LEFT_CENTER, if keys.sustain { "Pedal down" } else { "Pedal up" }, egui::FontId::proportional(13.0), ui.visuals().text_color());
}

impl eframe::App for SetupApp {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        if let Some(r) = &self.running { while let Ok(ev) = r.keys_rx.try_recv() { self.keys.apply(&ev); } }
        let finished = match &mut self.test { Some(t) => t.take_result(), None => None };
        if let Some(result) = finished {
            self.test = None;
            self.message = match result { Ok(desc) => format!("Test sound done. {desc}"), Err(e) => format!("error: test sound: {e}") };
        }
        if ctx.input(|i| i.viewport().close_requested()) {
            if let Some(t) = &self.test { t.stop(); }
            self.stop();
        }
        egui::CentralPanel::default().show(ctx, |ui| { if self.running.is_some() { self.running_ui(ui); } else { self.settings_ui(ui); } });
        if self.running.is_some() || self.test.is_some() { ctx.request_repaint_after(REPAINT); }
    }
    fn on_exit(&mut self, _gl: Option<&eframe::glow::Context>) {
        if let Some(t) = &self.test { t.stop(); }
        self.stop();
    }
}

/// Opens the window and blocks until it is closed.
pub fn run(engine_dir: PathBuf, initial: Setup) -> Result<(), String> {
    let stop_slot: Arc<Mutex<Option<StopHandles>>> = Arc::new(Mutex::new(None));
    let slot = stop_slot.clone();
    if let Err(e) = console::on_stop(move |name| {
        println!("{name}: stopping.");
        let handles = slot.lock().ok().and_then(|s| s.clone());
        if let Some(h) = handles {
            for l in h.save_now(Duration::from_secs(3)) { print_line(&l); }
        }
        println!("Closed.");
    }) {
        eprintln!("warning: Ctrl-C will not save the recording ({e}); use the Stop button in the window.");
    }
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default().with_title("rusty_piano setup").with_inner_size([760.0, 600.0]).with_min_inner_size([560.0, 440.0]),
        ..Default::default()
    };
    let app = SetupApp::new(engine_dir, &initial, stop_slot);
    eframe::run_native(
        "rusty_piano setup",
        options,
        Box::new(move |_cc: &eframe::CreationContext<'_>| -> Result<Box<dyn eframe::App>, Box<dyn std::error::Error + Send + Sync>> { Ok(Box::new(app)) }),
    )
    .map_err(|e| format!("cannot open the setup window: {e}"))
}
