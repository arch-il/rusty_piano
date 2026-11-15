//! Modal physical-model piano: inharmonic modal strings excited by a nonlinear hammer, a shared soundboard heard by two virtual microphones, and body noise.
//! The lowest partials are coupled two-way to the board through the bridge (see `coupling`); the rest drive it one-way. Mechanical noises, an output EQ and an optional reverb follow.
//! Strings that are not being played but are free to ring (dampers lifted, or no damper) ring along through the same bridge solve (see `resonance`).
//! The output EQ (low shelf, three peaking bands, high shelf; see `eq`) sits on the final mix before the master gain and limiter.
//! The optional reverb (8-line feedback network, off by default; see `reverb`) follows the EQ, also before the master gain and limiter.
//! Mechanical noises (key thump, key release, hammer knock, pedal down and up) are seeded noise bursts, heard directly and driven through the board (see `noises`).
//!
//! Each note is excited by a nonlinear felt hammer (see `hammer`).

pub mod coupling;
pub mod eq;
pub mod hammer;
pub mod noises;
pub mod profile;
pub mod resonance;
pub mod reverb;
pub mod soundboard;
pub mod strings;
pub mod tables;

pub use profile::{parse_modal_profile, ModalProfile};

use crate::midi::{MidiEvent, Pedal};
use crate::sound::simple_piano::limit;
use crate::sound::SoundEngine;
use coupling::CoupledModes;
use eq::OutputEq;
use hammer::{hammer_params, hammer_speed_mps, Hammer};
use noises::{noise_seed, NoiseKind, Noises, NOISE_REF_N};
use profile::MAX_MODAL_VOICES;
use resonance::ResonanceBank;
use reverb::Reverb;
use std::f32::consts::{FRAC_1_SQRT_2, PI};
use soundboard::Soundboard;
use strings::{lerp_note, string_set, string_set_soft, ModeBank};

/// Frames per internal render block.
pub const BLOCK: usize = 64;

const LOWEST_NOTE: u8 = 21;
const HIGHEST_NOTE: u8 = 108;
/// A released voice is culled once its block peak stays below this (at QUIET_REF_GAIN): about 100-110 dB under a velocity-64 strike, so the slow damper tail stays audible.
const QUIET_PEAK: f32 = 1e-7;
/// The output_gain QUIET_PEAK was chosen at; the cull level scales with output_gain so it stays at the same point relative to the music.
const QUIET_REF_GAIN: f32 = 0.0134;
const QUIET_BLOCKS: u32 = 4;
const STEAL_FADE_S: f32 = 0.005;
const FADERS: usize = 4;

struct Voice {
    bank: ModeBank,
    coupled: CoupledModes,
    note: u8,
    active: bool,
    key_down: bool,
    started: u64,
    last_peak: f32,
    quiet_blocks: u32,
    window_peak: f32,
    hammer: Hammer,
    force: [f32; BLOCK],
    raw: [f32; BLOCK],
    gl: f32,
    gr: f32,
    tilt: f32,
    shift: f32,
    two: strings::TwoStage,
    env_t: f64,
    env_seg: usize,
}

impl Voice {
    fn new(sample_rate: f32) -> Self {
        Self {
            bank: ModeBank::new(),
            coupled: CoupledModes::new(),
            note: 0,
            active: false,
            key_down: false,
            started: 0,
            last_peak: 0.0,
            quiet_blocks: 0,
            window_peak: 0.0,
            hammer: Hammer::new(sample_rate),
            force: [0.0; BLOCK],
            raw: [0.0; BLOCK],
            gl: 0.0,
            gr: 0.0,
            tilt: 1.0,
            shift: 0.0,
            two: Default::default(),
            env_t: 0.0,
            env_seg: 0,
        }
    }
}

fn bank_count_for(s: &strings::StringSet) -> usize {
    let max_hz = s.max_hz as f64;
    let mut k = 0usize;
    for st in 0..s.count {
        for n in 1..=s.partials_per_string {
            let f = strings::string_partial_hz(s, st, n);
            if f >= max_hz || k >= profile::MAX_MODES {
                break;
            }
            if !s.is_coupled(n, f) {
                k += 1;
            }
        }
    }
    k
}

/// Equal-power pan of a note: (left, right).
pub(crate) fn note_pan(note: u8, p: &ModalProfile) -> (f32, f32) {
    let x =(p.output.stereo_width * (note as f32 - 64.5) / 43.5).clamp(-1.0, 1.0);
    if x == 0.0 {
        (FRAC_1_SQRT_2, FRAC_1_SQRT_2)
    } else {
        let a = (x + 1.0) * PI / 4.0;
        (a.cos(), a.sin())
    }
}

/// Output gains of a note: (output_gain * tilt * pan_l, output_gain * tilt * pan_r, tilt).
pub(crate) fn note_gains(note: u8, p: &ModalProfile) -> (f32, f32, f32) {
    let (pan_l, pan_r) = note_pan(note, p);
    let tilt = 10f32.powf(p.output.level_tilt_db_per_octave * (note as f32 - 60.0) / 12.0 / 20.0);
    let out_scale = p.output.output_gain * tilt;
    (out_scale * pan_l, out_scale * pan_r, tilt)
}

pub struct ModalPiano {
    sample_rate: f32,
    profile: ModalProfile,
    voices: Vec<Voice>,
    counter: u64,
    sustain_value: u8,
    soft_value: u8,
    keys_down: [bool; 128],
    sostenuto: bool,
    sostenuto_keys: [bool; 128],
    gain: f32,
    gain_coef: f32,
    frame: u64,
    faders: [Box<Voice>; FADERS],
    fade_len: usize,
    fade_left: [usize; FADERS],
    board: Box<Soundboard>,
    bank: Box<ResonanceBank>,
    board_idle: bool,
    board_quiet: u32,
    board_window_peak: f32,
    board_force: [f32; BLOCK],
    body_drive: [f32; BLOCK],
    direct_l: [f32; BLOCK],
    direct_r: [f32; BLOCK],
    mic_l: [f32; BLOCK],
    mic_r: [f32; BLOCK],
    body_l: [f32; BLOCK],
    body_r: [f32; BLOCK],
    noises: Noises,
    noise_l: [f32; BLOCK],
    noise_r: [f32; BLOCK],
    noise_board: [f32; BLOCK],
    pedal_lift_max: f32,
    eq: OutputEq,
    reverb: Box<Reverb>,
}

impl ModalPiano {
    pub fn new(sample_rate: u32) -> Self {
        Self::with_profile(sample_rate, &ModalProfile::default())
    }

    pub fn with_profile(sample_rate: u32, p: &ModalProfile) -> Self {
        let sr = sample_rate as f32;
        let mut board = Box::new(Soundboard::new(sr));
        board.configure(p, sr);
        let mut bank = Box::new(ResonanceBank::new());
        bank.configure(p, sr, &board.mob);
        let mut s = Self {
            sample_rate: sr,
            profile: *p,
            voices: (0..MAX_MODAL_VOICES).map(|_| Voice::new(sr)).collect(),
            counter: 0,
            sustain_value: 0,
            soft_value: 0,
            keys_down: [false; 128],
            sostenuto: false,
            sostenuto_keys: [false; 128],
            gain: p.output.master_volume,
            gain_coef: 1.0 - (-1.0 / (0.01 * sr)).exp(),
            frame: 0,
            faders: std::array::from_fn(|_| Box::new(Voice::new(sr))),
            fade_len: ((STEAL_FADE_S * sr).round() as usize).max(1),
            fade_left: [0; FADERS],
            board,
            bank,
            board_idle: true,
            board_quiet: 0,
            board_window_peak: 0.0,
            board_force: [0.0; BLOCK],
            body_drive: [0.0; BLOCK],
            direct_l: [0.0; BLOCK],
            direct_r: [0.0; BLOCK],
            mic_l: [0.0; BLOCK],
            mic_r: [0.0; BLOCK],
            body_l: [0.0; BLOCK],
            body_r: [0.0; BLOCK],
            noises: Noises::new(sr),
            noise_l: [0.0; BLOCK],
            noise_r: [0.0; BLOCK],
            noise_board: [0.0; BLOCK],
            pedal_lift_max: 0.0,
            eq: OutputEq::new(),
            reverb: Box::new(Reverb::new(sr)),
        };
        s.update_bank_dampers();
        s.eq.configure(&p.eq, sr);
        s.reverb.configure(&p.reverb);
        s
    }

    /// True when the output EQ has at least one band switched on.
    pub fn eq_active(&self) -> bool {
        self.eq.is_active()
    }

    /// True while the reverb is switched on (mix setting above 0.0); after switching off its mix fades out over about 0.3 s (20 ms time constant).
    pub fn reverb_active(&self) -> bool {
        self.reverb.is_active()
    }

    /// New notes use the new profile; master volume ramps; limiter values apply at once.
    /// Board values (bridge impedance, mode_peak, modes, q, aspect, ...) apply at once through board.configure, which runs first
    /// because the coupled string modes take their bridge loss and kg from the board mobility table.
    /// Sounding notes follow these edits: board-only edits, decay edits and coupling-strength edits (soundboard.coupling and
    /// bridge_impedance), tuning and note-table edits, with an unchanged split; their coupled modes and their ModeBank are
    /// re-set up with state kept, so every partial moves to the new pitch.
    /// Split changes apply to new notes only: a change of coupled_partials, coupled_max_hz, string count, partials_per_string
    /// or max_hz, coupling going between zero and non-zero, or a different coupled or uncoupled mode count. A sounding note keeps its
    /// current setup until its next note-on, because the ModeBank of a sounding note keeps its old split.
    /// Resonance edits apply at once: the resonance bank is set up again (state kept where its mode count is unchanged).
    /// EQ and reverb edits apply at once.
    /// Two-stage decay values (prompt_db_per_s, after_level_db) of sounding notes follow note-table edits from the next 64-frame block.
    pub fn set_profile(&mut self, p: &ModalProfile) {
        let cur = &self.profile;
        if p.soundboard != cur.soundboard
            || p.mics.spacing_m != cur.mics.spacing_m
            || p.mics.height_m != cur.mics.height_m
            || p.output.level_tilt_db_per_octave != cur.output.level_tilt_db_per_octave
        {
            self.board.configure(p, self.sample_rate);
        }
        let bank_rerun = p.resonance != cur.resonance
            || p.soundboard != cur.soundboard
            || p.strings != cur.strings
            || p.tuning != cur.tuning
            || p.decay != cur.decay
            || p.notes != cur.notes;
        if bank_rerun {
            self.bank.configure(p, self.sample_rate, &self.board.mob);
        } else if p.output != cur.output {
            self.bank.update_gains(p);
        }
        let rerun = p.soundboard != cur.soundboard || p.strings != cur.strings || p.tuning != cur.tuning || p.decay != cur.decay || p.notes != cur.notes;
        let pedals_changed = p.pedals != cur.pedals;
        let old = *cur;
        let eq_changed = p.eq != self.profile.eq;
        let reverb_changed = p.reverb != self.profile.reverb;
        self.profile = *p;
        if eq_changed {
            self.eq.configure(&p.eq, self.sample_rate);
        }
        if reverb_changed {
            self.reverb.configure(&p.reverb);
        }
        if pedals_changed {
            self.update_dampers();
        }
        if bank_rerun {
            self.update_bank_dampers();
        }
        if rerun {
            let sr = self.sample_rate;
            let zero_changed = (old.soundboard.coupling == 0.0) != (p.soundboard.coupling == 0.0);
            for v in self.voices.iter_mut().filter(|v| v.active) {
                let old_set = string_set_soft(v.note, &old, sr, v.shift);
                let set = string_set_soft(v.note, p, sr, v.shift);
                if zero_changed
                    || set.coupled_partials != old_set.coupled_partials
                    || set.coupled_max_hz != old_set.coupled_max_hz
                    || set.count != old_set.count
                    || set.partials_per_string != old_set.partials_per_string
                    || set.max_hz != old_set.max_hz
                    || CoupledModes::count_for(&set) != v.coupled.len()
                    || bank_count_for(&set) != v.bank.len()
                {
                    continue;
                }
                v.bank.setup(&set, sr, true);
                v.coupled.setup(&set, sr, &p.soundboard, &self.board.mob, true);
                v.two = strings::TwoStage::from_set(&set);
            }
        }
    }

    /// Energy in joules of the voices' coupled modes, the resonance bank and the board modes.
    pub fn coupled_energy(&self) -> f64 {
        self.voices.iter().filter(|v| v.active).map(|v| v.coupled.energy()).sum::<f64>() + self.bank.energy() + self.board.energy()
    }

    /// Energy in joules of the resonance bank's strings of `note`; 0.0 if that key is not ringing.
    pub fn resonance_energy(&self, note: u8) -> f64 {
        self.bank.key_energy(note)
    }

    /// Resonance bank keys processed in the last sub-block.
    pub fn resonating_keys(&self) -> usize {
        self.bank.processed()
    }

    /// Energy in joules of the coupled modes of the voice playing `note`; 0.0 if none.
    pub fn voice_energy(&self, note: u8) -> f64 {
        self.voices.iter().find(|v| v.active && v.note == note).map_or(0.0, |v| v.coupled.energy())
    }

    pub fn board_active(&self) -> bool {
        !self.board_idle
    }

    pub fn profile(&self) -> &ModalProfile {
        &self.profile
    }

    pub fn active_voices(&self) -> usize {
        self.voices.iter().filter(|v| v.active).count()
    }

    pub fn fading_voices(&self) -> usize {
        self.fade_left.iter().filter(|&&f| f > 0).count()
    }

    pub fn is_sounding(&self, note: u8) -> bool {
        self.voices.iter().any(|v| v.active && v.note == note)
    }

    pub fn active_modes(&self) -> usize {
        self.voices.iter().filter(|v| v.active).map(|v| v.bank.len() + v.coupled.len()).sum()
    }

    fn start_voice(&mut self, idx: usize, note: u8, velocity: u8, keep_state: bool) {
        let p = self.profile;
        let sr = self.sample_rate;
        let shift = self.soft_value as f32 / 127.0;
        let set = string_set_soft(note, &p, sr, shift);
        let (gl, gr, tilt) = note_gains(note, &p);
        let params = hammer_params(note, &p, &set);
        let speed = hammer_speed_mps(velocity, &p);
        let counter = self.counter;
        let frame = self.frame;
        let v = &mut self.voices[idx];
        v.bank.setup(&set, sr, keep_state);
        v.coupled.setup(&set, sr, &p.soundboard, &self.board.mob, keep_state);
        v.gl = gl;
        v.gr = gr;
        v.tilt = tilt;
        v.shift = shift;
        v.bank.set_damped(false);
        v.coupled.set_damped(false);
        v.two = strings::TwoStage::from_set(&set);
        v.env_t = 0.0;
        v.env_seg = BLOCK - (frame % BLOCK as u64) as usize;
        let x = v.two.segment_ln(0.0, v.env_seg, 1.0 / sr as f64);
        v.bank.set_extra_decay(x);
        v.coupled.set_extra_decay(x);
        v.note = note;
        v.active = true;
        v.key_down = true;
        v.started = counter;
        v.last_peak = 0.0;
        v.quiet_blocks = 0;
        v.window_peak = 0.0;
        v.hammer.strike(&params, speed, sr);
    }

    fn note_on(&mut self, note: u8, velocity: u8) {
        if !(LOWEST_NOTE..=HIGHEST_NOTE).contains(&note) {
            return;
        }
        self.counter += 1;
        self.board_idle = false;
        self.board_quiet = 0;
        let p = self.profile;
        let s = (hammer_speed_mps(velocity, &p) / p.velocity.hammer_speed_max_mps).clamp(0.0, 1.0);
        let (pl, pr) = note_pan(note, &p);
        self.noises.start(NoiseKind::KeyDown, p.noises.key_down * NOISE_REF_N * s, pl, pr, noise_seed(NoiseKind::KeyDown, note, velocity));
        self.noises.start(
            NoiseKind::HammerKnock,
            p.noises.hammer_knock * NOISE_REF_N * s * lerp_note(note, 0.2, 1.0),
            pl,
            pr,
            noise_seed(NoiseKind::HammerKnock, note, velocity),
        );
        if let Some(idx) = self.voices.iter().position(|v| v.active && v.note == note) {
            self.start_voice(idx, note, velocity, true);
            return;
        }
        let limit_voices = self.profile.voices.max_voices.min(MAX_MODAL_VOICES);
        let idx = if self.active_voices() < limit_voices {
            self.voices.iter().position(|v| !v.active)
        } else {
            None
        };
        let idx = match idx {
            Some(i) => i,
            None => {
                let released = self
                    .voices
                    .iter()
                    .enumerate()
                    .filter(|(_, v)| v.active && !v.key_down)
                    .min_by(|(_, a), (_, b)| a.last_peak.total_cmp(&b.last_peak).then(a.started.cmp(&b.started)))
                    .map(|(i, _)| i);
                let i = match released {
                    Some(i) => i,
                    None => self
                        .voices
                        .iter()
                        .enumerate()
                        .filter(|(_, v)| v.active)
                        .min_by_key(|(_, v)| v.started)
                        .map(|(i, _)| i)
                        .unwrap_or(0),
                };
                // Up to FADERS steals fade at once; one more inside the 5 ms window hard-cuts the oldest fader.
                let k = match self.fade_left.iter().position(|&f| f == 0) {
                    Some(k) => k,
                    None => (0..FADERS).min_by_key(|&k| self.fade_left[k]).unwrap_or(0),
                };
                std::mem::swap(&mut self.voices[i], &mut *self.faders[k]);
                self.fade_left[k] = self.fade_len;
                i
            }
        };
        self.start_voice(idx, note, velocity, false);
    }

    fn note_off(&mut self, note: u8, was_down: bool) {
        let a = self.voice_damping(note, false);
        if was_down && (LOWEST_NOTE..=HIGHEST_NOTE).contains(&note) {
            let p = self.profile;
            let has_damper = string_set(note, &p, self.sample_rate).damper_t60_s.is_some();
            let d = if has_damper { a } else { 0.0 };
            let (pl, pr) = note_pan(note, &p);
            self.noises.start(NoiseKind::KeyUp, p.noises.key_up * NOISE_REF_N * (0.5 + 0.5 * d), pl, pr, noise_seed(NoiseKind::KeyUp, note, 0));
        }
        for v in self.voices.iter_mut().filter(|v| v.active && v.note == note && v.key_down) {
            v.key_down = false;
            v.bank.set_damping(a);
            v.coupled.set_damping(a);
        }
    }

    /// Damper amount of a voice: 0 while its key is down or sostenuto holds its damper, else the sustain pedal's damper engagement.
    fn voice_damping(&self, note: u8, key_down: bool) -> f32 {
        if key_down || (note < 128 && self.sostenuto_keys[note as usize]) {
            0.0
        } else {
            self.profile.pedals.damper_engagement(self.sustain_value)
        }
    }

    fn update_dampers(&mut self) {
        let pedal = self.profile.pedals.damper_engagement(self.sustain_value);
        let sostenuto_keys = self.sostenuto_keys;
        for v in self.voices.iter_mut().filter(|v| v.active) {
            let held = v.key_down || (v.note < 128 && sostenuto_keys[v.note as usize]);
            let a = if held { 0.0 } else { pedal };
            v.bank.set_damping(a);
            v.coupled.set_damping(a);
        }
        self.update_bank_dampers();
    }

    /// Gives every resonance bank key the damper amount a voice on that key would get.
    fn update_bank_dampers(&mut self) {
        for note in LOWEST_NOTE..=HIGHEST_NOTE {
            let a = self.voice_damping(note, self.keys_down[note as usize]);
            self.bank.set_damping(note, a);
        }
    }

    fn update_bank_damper(&mut self, note: u8) {
        if note < 128 {
            let a = self.voice_damping(note, self.keys_down[note as usize]);
            self.bank.set_damping(note, a);
        }
    }

    /// Sets the sustain pedal value; starts the pedal noises when the dampers lift off or land.
    fn set_sustain(&mut self, value: u8) {
        let pd = self.profile.pedals;
        let old_e = pd.damper_engagement(self.sustain_value);
        let new_e = pd.damper_engagement(value);
        self.sustain_value = value;
        self.update_dampers();
        let nz = self.profile.noises;
        let amp_down = nz.pedal_down * NOISE_REF_N;
        if old_e >= 1.0 && new_e < 1.0 {
            self.noises.start(NoiseKind::PedalDown, amp_down, FRAC_1_SQRT_2, FRAC_1_SQRT_2, noise_seed(NoiseKind::PedalDown, 0, 0));
            self.pedal_lift_max = 1.0 - new_e;
            if amp_down > 0.0 {
                self.board_idle = false;
                self.board_quiet = 0;
            }
        } else if old_e < 1.0 && new_e < 1.0 {
            self.pedal_lift_max = self.pedal_lift_max.max(1.0 - new_e);
        } else if old_e < 1.0 && new_e >= 1.0 {
            let amp_up = nz.pedal_up * NOISE_REF_N * self.pedal_lift_max;
            self.noises.start(NoiseKind::PedalUp, amp_up, FRAC_1_SQRT_2, FRAC_1_SQRT_2, noise_seed(NoiseKind::PedalUp, 0, 0));
            self.pedal_lift_max = 0.0;
            if amp_up > 0.0 {
                self.board_idle = false;
                self.board_quiet = 0;
            }
        }
    }

    fn set_sostenuto(&mut self, on: bool) {
        // Sostenuto catches only the keys held at press time, even when the sustain pedal is down (a real grand would also catch every damper the sustain pedal lifted).
        if on && !self.sostenuto {
            self.sostenuto_keys = self.keys_down;
        } else if !on && self.sostenuto {
            self.sostenuto_keys = [false; 128];
        }
        self.sostenuto = on;
        self.update_dampers();
    }
}

impl SoundEngine for ModalPiano {
    fn handle(&mut self, ev: &MidiEvent) {
        match *ev {
            MidiEvent::NoteOn { note, velocity } if velocity > 0 => {
                if note < 128 {
                    self.keys_down[note as usize] = true;
                }
                self.note_on(note, velocity);
                self.update_bank_damper(note);
            }
            MidiEvent::NoteOn { note, .. } | MidiEvent::NoteOff { note } => {
                let was_down = note < 128 && self.keys_down[note as usize];
                if note < 128 {
                    self.keys_down[note as usize] = false;
                }
                self.note_off(note, was_down);
                self.update_bank_damper(note);
            }
            MidiEvent::Sustain { on } => self.set_sustain(if on { 127 } else { 0 }),
            MidiEvent::Pedal {
                pedal: Pedal::Sustain,
                value,
            } => self.set_sustain(value),
            MidiEvent::Pedal {
                pedal: Pedal::Sostenuto,
                value,
            } => self.set_sostenuto(value >= 64),
            MidiEvent::Pedal {
                pedal: Pedal::Soft,
                value,
            } => self.soft_value = value,
        }
    }

    fn render_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
        let n = left.len().min(right.len());
        let left = &mut left[..n];
        let right = &mut right[..n];
        left.fill(0.0);
        right.fill(0.0);
        let target = self.profile.output.master_volume;
        let knee = self.profile.output.limiter_knee;
        let ceiling = self.profile.output.limiter_ceiling;
        let output_gain = self.profile.output.output_gain;
        let quiet = QUIET_PEAK * (output_gain / QUIET_REF_GAIN);
        let direct_mix = self.profile.mics.direct_mix;
        let board_mix = self.profile.mics.board_mix;
        let body_mix = self.profile.mics.body_mix;
        let mut off = 0;
        let dt = 1.0 / self.sample_rate as f64;
        while off < n {
            // Internal blocks end on multiples of BLOCK in absolute time, so quiet checks do not depend on the render chunk size.
            let b = (n - off).min(BLOCK - (self.frame % BLOCK as u64) as usize);
            let on_grid = (self.frame + b as u64).is_multiple_of(BLOCK as u64);
            self.board_force = [0.0; BLOCK];
            self.body_drive = [0.0; BLOCK];
            self.direct_l = [0.0; BLOCK];
            self.direct_r = [0.0; BLOCK];
            self.mic_l = [0.0; BLOCK];
            self.mic_r = [0.0; BLOCK];
            self.body_l = [0.0; BLOCK];
            self.body_r = [0.0; BLOCK];
            let noise_board_on = self.noises.board_active();
            self.noise_l[..b].fill(0.0);
            self.noise_r[..b].fill(0.0);
            self.noise_board[..b].fill(0.0);
            self.noises.render(&mut self.noise_l[..b], &mut self.noise_r[..b], &mut self.noise_board[..b]);
            for t in 0..b {
                self.direct_l[t] += output_gain * self.noise_l[t];
                self.direct_r[t] += output_gain * self.noise_r[t];
                self.board_force[t] += self.noise_board[t];
                self.body_drive[t] += self.noise_board[t];
            }
            let mut fade_gain = [[0.0f32; BLOCK]; FADERS];
            let mut fading = false;
            let mut act = [0usize; MAX_MODAL_VOICES];
            let mut na = 0;
            for (i, v) in self.voices.iter().enumerate() {
                if v.active && na < MAX_MODAL_VOICES {
                    act[na] = i;
                    na += 1;
                }
            }
            let voices_active = na > 0;
            // (A) strings: raw bridge force of the uncoupled modes of every voice and fader into the board drive.
            for &i in &act[..na] {
                let v = &mut self.voices[i];
                v.raw[..b].fill(0.0);
                for i in 0..b {
                    v.force[i] = if v.hammer.in_contact() { v.hammer.next_force() } else { 0.0 };
                }
                v.bank.process(&v.force[..b], &mut v.raw[..b]);
                for t in 0..b {
                    self.board_force[t] += v.raw[t];
                }
            }
            #[allow(clippy::needless_range_loop)] // index spans several parallel arrays; iterator form would complicate borrows on the audio path
            for k in 0..FADERS {
                let fade_left = self.fade_left[k];
                if fade_left == 0 {
                    continue;
                }
                fading = true;
                for t in 0..b.min(fade_left) {
                    fade_gain[k][t] = (fade_left - t) as f32 / self.fade_len as f32;
                }
                let f = &mut self.faders[k];
                f.raw[..b].fill(0.0);
                for i in 0..b {
                    f.force[i] = if f.hammer.in_contact() { f.hammer.next_force() } else { 0.0 };
                }
                f.bank.process(&f.force[..b], &mut f.raw[..b]);
                for t in 0..b {
                    self.board_force[t] += f.raw[t] * fade_gain[k][t];
                }
            }
            // (B) per sample: coupled string modes and the soundboard; the delay-free bridge loop is solved algebraically each sample.
            let board_ran = voices_active || fading || !self.board_idle || noise_board_on;
            let mut voiced = [false; 128];
            for &i in &act[..na] {
                voiced[self.voices[i].note as usize] = true;
            }
            if board_ran {
                self.bank.begin_block(&voiced);
            } else {
                self.bank.skip_block();
            }
            if board_ran {
                let mut gs = 0.0f32;
                for &i in &act[..na] {
                    gs += self.voices[i].coupled.gs();
                }
                gs += self.bank.gs();
                let d = self.board.d_b();
                for t in 0..b {
                    let (ml, mr, p_b) = self.board.advance();
                    self.mic_l[t] = ml;
                    self.mic_r[t] = mr;
                    let mut f0 = self.board_force[t];
                    for &i in &act[..na] {
                        let v = &mut self.voices[i];
                        let (raw, vel) = v.coupled.advance();
                        v.raw[t] += raw;
                        f0 += vel + v.coupled.kh() * v.force[t];
                    }
                    #[allow(clippy::needless_range_loop)] // index spans several parallel arrays; iterator form would complicate borrows on the audio path
                    for k in 0..FADERS {
                        if self.fade_left[k] == 0 {
                            continue;
                        }
                        let fd = &mut self.faders[k];
                        let (raw, _) = fd.coupled.advance();
                        fd.raw[t] += raw;
                        f0 += raw * fade_gain[k][t];
                        fd.coupled.commit(fd.force[t], 0.0);
                    }
                    f0 += self.bank.advance(t, &mut self.direct_l, &mut self.direct_r, &mut self.body_drive);
                    let v_b = (d * f0 + p_b) / (1.0 + d * gs);
                    let f = f0 - gs * v_b;
                    for &i in &act[..na] {
                        let v = &mut self.voices[i];
                        v.coupled.commit(v.force[t], v_b);
                    }
                    self.bank.commit(v_b);
                    self.board.commit(f);
                }
            }
            // (C) direct sound, body drive and voice bookkeeping.
            for &i in &act[..na] {
                let v = &mut self.voices[i];
                let gmax = v.gl.max(v.gr);
                let mut peak = 0.0f32;
                for t in 0..b {
                    let r = v.raw[t];
                    self.direct_l[t] += r * v.gl;
                    self.direct_r[t] += r * v.gr;
                    self.body_drive[t] += r * v.tilt;
                    peak = peak.max(r.abs() * gmax);
                }
                v.window_peak = v.window_peak.max(peak);
                if on_grid {
                    v.env_t += v.env_seg as f64 * dt;
                    v.env_seg = BLOCK;
                    let x = v.two.segment_ln(v.env_t, BLOCK, dt);
                    v.bank.set_extra_decay(x);
                    v.coupled.set_extra_decay(x);
                    v.last_peak = v.window_peak;
                    if !v.hammer.in_contact() && v.window_peak <= quiet {
                        v.quiet_blocks += 1;
                    } else {
                        v.quiet_blocks = 0;
                    }
                    v.window_peak = 0.0;
                }
                v.bank.flush_tiny();
                v.coupled.flush_tiny();
                if v.quiet_blocks >= QUIET_BLOCKS {
                    v.active = false;
                    v.bank.clear();
                    v.coupled.clear();
                }
            }
            #[allow(clippy::needless_range_loop)] // index spans several parallel arrays; iterator form would complicate borrows on the audio path
            for k in 0..FADERS {
                let fade_left = self.fade_left[k];
                if fade_left == 0 {
                    continue;
                }
                let f = &mut self.faders[k];
                for t in 0..b {
                    let r = f.raw[t] * fade_gain[k][t];
                    self.direct_l[t] += r * f.gl;
                    self.direct_r[t] += r * f.gr;
                    self.body_drive[t] += r * f.tilt;
                }
                self.fade_left[k] = fade_left.saturating_sub(b);
                if self.fade_left[k] == 0 {
                    f.active = false;
                    f.bank.clear();
                    f.coupled.clear();
                }
            }
            if board_ran {
                self.board.process_body(&self.body_drive[..b], &mut self.body_l[..b], &mut self.body_r[..b]);
                // The idle check reads the board itself (not the mix levels): with two-way coupling a silent-in-the-mix board still drives the strings.
                for t in 0..b {
                    let l = output_gain * self.mic_l[t].abs().max(self.body_l[t].abs());
                    let r = output_gain * self.mic_r[t].abs().max(self.body_r[t].abs());
                    self.board_window_peak = self.board_window_peak.max(l).max(r);
                }
            }
            let bank_peak = self.bank.end_block(on_grid, quiet, QUIET_BLOCKS);
            if on_grid && !self.board_idle {
                let any_voice = self.voices.iter().any(|v| v.active);
                let any_fade = self.fade_left.iter().any(|&f| f > 0);
                if !any_voice && !any_fade && self.noises.active() == 0 && self.board_window_peak <= quiet && bank_peak <= quiet {
                    self.board_quiet += 1;
                } else {
                    self.board_quiet = 0;
                }
                self.board_window_peak = 0.0;
                if self.board_quiet >= QUIET_BLOCKS {
                    self.board.clear();
                    self.bank.clear();
                    self.board_idle = true;
                    self.board_quiet = 0;
                }
            }
            self.frame += b as u64;
            // (D) mix, master gain and limiter.
            for t in 0..b {
                let i = off + t;
                let mut l = direct_mix * self.direct_l[t] + output_gain * (board_mix * self.mic_l[t] + body_mix * self.body_l[t]);
                let mut r = direct_mix * self.direct_r[t] + output_gain * (board_mix * self.mic_r[t] + body_mix * self.body_r[t]);
                if self.eq.is_active() {
                    let (eq_l, eq_r) = self.eq.process(l, r);
                    l = eq_l;
                    r = eq_r;
                }
                if self.reverb.is_running() {
                    let (wl, wr) = self.reverb.process(l, r);
                    l += wl;
                    r += wr;
                }
                self.gain += (target - self.gain) * self.gain_coef;
                if (target - self.gain).abs() < 1e-6 {
                    self.gain = target;
                }
                left[i] = limit(l * self.gain, knee, ceiling);
                right[i] = limit(r * self.gain, knee, ceiling);
            }
            if on_grid {
                self.eq.flush_tiny();
            }
            off += b;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use profile::ModalNoises;
    use rustfft::{num_complex::Complex, FftPlanner};
    use strings::{inharmonicity, partial_hz};

    const SR: u32 = 48000;

    fn on(e: &mut ModalPiano, note: u8, velocity: u8) {
        e.handle(&MidiEvent::NoteOn { note, velocity });
    }

    fn off(e: &mut ModalPiano, note: u8) {
        e.handle(&MidiEvent::NoteOff { note });
    }

    fn sustain(e: &mut ModalPiano, on: bool) {
        e.handle(&MidiEvent::Sustain { on });
    }

    /// Renders `frames` frames in 64-frame blocks; returns (left, right).
    fn render(e: &mut ModalPiano, frames: usize) -> (Vec<f32>, Vec<f32>) {
        let mut l = vec![0.0f32; frames];
        let mut r = vec![0.0f32; frames];
        for (cl, cr) in l.chunks_mut(64).zip(r.chunks_mut(64)) {
            e.render_stereo(cl, cr);
        }
        (l, r)
    }

    fn render_mono(e: &mut ModalPiano, frames: usize) -> Vec<f32> {
        let (l, r) = render(e, frames);
        l.iter().zip(&r).map(|(a, b)| 0.5 * (a + b)).collect()
    }

    fn secs(s: f64) -> usize {
        (s * SR as f64).round() as usize
    }

    fn level_db(x: &[f32]) -> f64 {
        let ms = x.iter().map(|&v| (v as f64) * (v as f64)).sum::<f64>() / x.len() as f64;
        10.0 * (ms + 1e-30).log10()
    }

    fn last_50ms_db(x: &[f32]) -> f64 {
        level_db(&x[x.len() - secs(0.05)..])
    }

    fn rms(x: &[f32]) -> f64 {
        (x.iter().map(|&v| (v as f64) * (v as f64)).sum::<f64>() / x.len() as f64).sqrt()
    }

    fn peak_of(p: &ModalProfile, note: u8, vel: u8, from: usize, to: usize) -> f32 {
        let mut e = ModalPiano::with_profile(SR, p);
        on(&mut e, note, vel);
        let (l, r) = render(&mut e, to);
        l[from..].iter().chain(r[from..].iter()).fold(0.0f32, |m, x| m.max(x.abs()))
    }

    fn centroid(p: &ModalProfile, note: u8, vel: u8) -> f64 {
        let mut e = ModalPiano::with_profile(SR, p);
        on(&mut e, note, vel);
        let m = render_mono(&mut e, secs(0.02) + 8192);
        let seg = &m[secs(0.02)..];
        let mut buf: Vec<Complex<f64>> = seg
            .iter()
            .enumerate()
            .map(|(i, &x)| {
                let w = 0.5 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / 8192.0).cos();
                Complex::new(x as f64 * w, 0.0)
            })
            .collect();
        FftPlanner::<f64>::new().plan_fft_forward(8192).process(&mut buf);
        let binw = SR as f64 / 8192.0;
        let (mut num, mut den) = (0.0, 0.0);
        for (k, c) in buf.iter().take(4096).enumerate() {
            let f = k as f64 * binw;
            if (20.0..=16000.0).contains(&f) {
                num += f * c.norm();
                den += c.norm();
            }
        }
        num / den
    }

    fn print_table(p: &ModalProfile) {
        println!("peak per note, velocity 80, first 0.1 s:");
        let mut line = String::new();
        for note in 21u8..=108 {
            line += &format!("{}:{:.4} ", note, peak_of(p, note, 80, 0, secs(0.1)));
            if (note - 21) % 8 == 7 {
                println!("{line}");
                line.clear();
            }
        }
        println!("{line}");
        for vel in [16u8, 100, 127] {
            println!("C4 peak v{vel}: {:.4}", peak_of(p, 60, vel, 0, secs(0.1)));
        }
        let mut audible = *p;
        audible.output.output_gain = 0.0134;
        for note in [36u8, 60, 84] {
            println!("centroid ratio v127/v32 note {note}: {:.3}", centroid(&audible, note, 127) / centroid(&audible, note, 32));
        }
    }

    #[test]
    #[ignore]
    fn print_calibration_table() {
        let mut p = ModalProfile::default();
        p.output.output_gain = 0.001;
        print_table(&p);
    }

    #[test]
    fn level_trim_scales_output() {
        let mut p1 = ModalProfile::default();
        p1.output.output_gain = 0.0005;
        let mut p2 = p1;
        p2.notes = tables::NoteTable::from_anchors(&[tables::NoteAnchor { level_db: 6.0206, ..tables::NoteAnchor::neutral(60) }]).unwrap();
        let a = peak_of(&p1, 60, 100, 0, secs(0.3));
        let b = peak_of(&p2, 60, 100, 0, secs(0.3));
        let ratio = b / a;
        assert!((0.995 * 2.0..=1.005 * 2.0).contains(&ratio), "ratio {ratio}");
    }

    #[test]
    fn middle_c_level_is_calibrated() {
        let pk = peak_of(&ModalProfile::default(), 60, 100, 0, secs(0.3));
        println!("middle C v100 peak {pk}");
        assert!(pk > 0.03 && pk < 0.07, "peak {pk}");
    }

    #[test]
    fn level_is_even_across_keys() {
        let p = ModalProfile::default();
        let mut prev: Option<f32> = None;
        for note in 21u8..=108 {
            let pk = peak_of(&p, note, 80, 0, secs(0.1));
            assert!(pk.is_finite() && pk > 0.01 && pk < 0.9, "note {note}: {pk}");
            if let Some(q) = prev {
                let d = 20.0 * (pk / q).log10();
                assert!(d.abs() <= 6.0, "note {note}: {d} dB from previous");
            }
            prev = Some(pk);
        }
    }

    #[test]
    fn c4_dynamic_range() {
        let p = ModalProfile::default();
        let d = 20.0 * (peak_of(&p, 60, 127, 0, secs(0.1)) / peak_of(&p, 60, 16, 0, secs(0.1))).log10();
        assert!(d > 20.0 && d < 50.0, "dynamic range {d} dB");
    }

    #[test]
    fn brighter_with_velocity() {
        let p = ModalProfile::default();
        for note in [60u8, 84] {
            let r = centroid(&p, note, 127) / centroid(&p, note, 32);
            assert!(r >= 1.10, "note {note}: ratio {r}");
        }
        let r = centroid(&p, 36, 127) / centroid(&p, 36, 32);
        assert!(r > 1.0, "note 36: ratio {r}");
    }

    #[test]
    fn louder_with_velocity() {
        let mut p = ModalProfile::default();
        p.output.output_gain = 0.005;
        for note in [36u8, 60, 84] {
            let mut prev = 0.0f32;
            for vel in [16u8, 32, 48, 64, 80, 96, 112, 127] {
                let pk = peak_of(&p, note, vel, 0, secs(0.15));
                assert!(pk > prev, "note {note} vel {vel}: {pk} <= {prev}");
                prev = pk;
            }
        }
    }

    #[test]
    fn restrike_reuses_voice() {
        let mut p = ModalProfile::default();
        p.output.output_gain = 0.005;
        let mut e = ModalPiano::with_profile(SR, &p);
        on(&mut e, 60, 80);
        let (l0, r0) = render(&mut e, secs(0.3));
        on(&mut e, 60, 100);
        assert_eq!(e.active_voices(), 1);
        let (l1, r1) = render(&mut e, secs(0.1));
        assert_eq!(e.active_voices(), 1);
        assert!(l1.iter().chain(r1.iter()).all(|x| x.is_finite()));
        let pk = |l: &[f32], r: &[f32]| l.iter().chain(r.iter()).fold(0.0f32, |m, x| m.max(x.abs()));
        let before = pk(&l0[l0.len() - secs(0.1)..], &r0[r0.len() - secs(0.1)..]);
        let after = pk(&l1, &r1);
        assert!(after >= before, "{after} < {before}");
    }

    #[test]
    fn silence_without_notes() {
        let mut e = ModalPiano::new(SR);
        let mut l = vec![1.0f32; 256];
        let mut r = vec![1.0f32; 256];
        e.render_stereo(&mut l, &mut r);
        assert!(l.iter().chain(r.iter()).all(|&x| x == 0.0));
    }

    fn peak_hz(spec: &[f64], binw: f64, expected: f64) -> f64 {
        let lo = (expected * 0.985 / binw).floor() as usize;
        let hi = (expected * 1.015 / binw).ceil() as usize;
        let k = (lo..=hi).max_by(|&a, &b| spec[a].total_cmp(&spec[b])).unwrap();
        let (a, b, c) = (spec[k - 1].ln(), spec[k].ln(), spec[k + 1].ln());
        let delta = 0.5 * (a - c) / (a - 2.0 * b + c);
        (k as f64 + delta) * binw
    }

    #[test]
    fn rendered_partial_matches_frequency() {
        let mut p = ModalProfile::default();
        p.strings.unison_detune_cents = 0.0;
        let mut e = ModalPiano::with_profile(SR, &p);
        on(&mut e, 36, 127);
        let m = render_mono(&mut e, secs(2.0));
        let n_fft = 65536;
        let seg = &m[secs(0.1)..secs(0.1) + n_fft];
        let mut buf: Vec<Complex<f64>> = seg
            .iter()
            .enumerate()
            .map(|(i, &x)| {
                let w = 0.5 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / n_fft as f64).cos();
                Complex::new(x as f64 * w, 0.0)
            })
            .collect();
        FftPlanner::<f64>::new().plan_fft_forward(n_fft).process(&mut buf);
        let spec: Vec<f64> = buf.iter().take(n_fft / 2).map(|c| c.norm()).collect();
        let binw = SR as f64 / n_fft as f64;
        let f0 = strings::tuned_hz(36, &p) as f32;
        let b = inharmonicity(36, &p);
        let beta = lerp_note(36, p.strings.strike_position_bass, p.strings.strike_position_treble) as f64;
        let mut ns = [0usize; 3];
        let mut expected = [0.0f64; 3];
        let mut measured = [0.0f64; 3];
        for (i, start) in [1usize, 5, 10].into_iter().enumerate() {
            // A partial near a strike-point node is too weak to measure; use the next one.
            let mut n = start;
            while (n as f64 * std::f64::consts::PI * beta).sin().abs() < 0.3 {
                n += 1;
            }
            ns[i] = n;
            expected[i] = partial_hz(n, f0, b) as f64;
            measured[i] = peak_hz(&spec, binw, expected[i]);
            assert!(((measured[i] - expected[i]) / expected[i]).abs() < 0.002, "partial {n}: {} vs {}", measured[i], expected[i]);
        }
        let ratio = (measured[2] / measured[0]) / (expected[2] / expected[0]);
        assert!((ratio - 1.0).abs() < 0.002, "ratio {ratio}");
    }

    fn frame_db(m: &[f32], from: usize) -> Vec<f64> {
        let f = secs(0.05);
        m[from..].chunks_exact(f).map(level_db).collect()
    }

    #[test]
    fn detuned_unison_beats() {
        let mut p = ModalProfile::default();
        p.strings.max_partials = 1;
        p.strings.unison_decay_spread = 0.0;
        p.strings.unison_detune_cents = 3.0;
        let mut e = ModalPiano::with_profile(SR, &p);
        on(&mut e, 72, 100);
        let m = render_mono(&mut e, secs(3.0));
        let db = frame_db(&m, secs(0.1));
        let dip = (0..db.len()).any(|i| db[..i].iter().any(|&x| x - db[i] >= 3.0) && db[i + 1..].iter().any(|&x| x - db[i] >= 3.0));
        assert!(dip, "no beating dip: {db:?}");

        p.strings.unison_detune_cents = 0.0;
        let mut e = ModalPiano::with_profile(SR, &p);
        on(&mut e, 72, 100);
        let m = render_mono(&mut e, secs(3.0));
        let db = frame_db(&m, secs(0.1));
        for w in db.windows(2) {
            assert!(w[1] - w[0] <= 0.2, "rise {} -> {}", w[0], w[1]);
        }
    }

    #[test]
    fn key_up_damps_and_frees_voice() {
        let mut p = ModalProfile::default();
        // isolates the played strings from the M5 resonance bank
        p.resonance.strength = 0.0;
        let mut e = ModalPiano::with_profile(SR, &p);
        on(&mut e, 60, 100);
        let m = render_mono(&mut e, secs(0.5));
        let l1 = last_50ms_db(&m);
        off(&mut e, 60);
        let m = render_mono(&mut e, secs(0.3));
        let l2 = last_50ms_db(&m);
        assert!(l1 - l2 >= 30.0, "L1 {l1} dB, after {l2} dB");
        let mut freed = false;
        for _ in 0..(3 * SR as usize / 64) {
            render(&mut e, 64);
            if e.active_voices() == 0 && !e.board_active() {
                freed = true;
                break;
            }
        }
        assert!(freed, "voice not freed");
        let (l, r) = render(&mut e, 512);
        assert!(l.iter().chain(r.iter()).all(|&x| x == 0.0));
    }

    #[test]
    fn top_notes_ring_without_dampers() {
        let mut pb = ModalProfile::default();
        pb.decay.undamped_from_note = 109;
        let mut levels = [(0.0, 0.0); 2];
        let mut active_a = 0;
        for (i, p) in [ModalProfile::default(), pb].iter().enumerate() {
            let mut e = ModalPiano::with_profile(SR, p);
            on(&mut e, 96, 100);
            let m = render_mono(&mut e, secs(0.5));
            let l1 = last_50ms_db(&m);
            off(&mut e, 96);
            let m = render_mono(&mut e, secs(0.3));
            levels[i] = (l1, last_50ms_db(&m));
            if i == 0 {
                active_a = e.active_voices();
            }
        }
        let (a1, a2) = levels[0];
        let (_, b2) = levels[1];
        assert!(a1 - a2 <= 20.0, "A: {a1} -> {a2}");
        assert!(active_a >= 1);
        assert!(a2 - b2 >= 30.0, "A {a2} dB, B {b2} dB");
    }

    #[test]
    fn sustain_pedal_holds_notes() {
        let mut e = ModalPiano::new(SR);
        sustain(&mut e, true);
        on(&mut e, 60, 100);
        let m = render_mono(&mut e, secs(0.1));
        off(&mut e, 60);
        let mut all = m;
        all.extend(render_mono(&mut e, secs(0.9)));
        let at_0_2 = level_db(&all[secs(0.15)..secs(0.2)]);
        let at_1_0 = last_50ms_db(&all);
        println!("sustain: {at_0_2:.2} dB at 0.2 s, {at_1_0:.2} dB at 1.0 s, drop {:.2} dB", at_0_2 - at_1_0);
        assert!((at_0_2 - at_1_0).abs() <= 20.0, "{at_0_2} vs {at_1_0}");
        sustain(&mut e, false);
        let m = render_mono(&mut e, secs(0.3));
        let after = last_50ms_db(&m);
        assert!(at_1_0 - after >= 30.0, "{at_1_0} -> {after}");
    }

    fn pedal(e: &mut ModalPiano, pedal: Pedal, value: u8) {
        e.handle(&MidiEvent::Pedal { pedal, value });
    }

    #[test]
    fn half_pedal_damps_between_up_and_down() {
        let drop = |v: u8| -> f64 {
            let mut e = ModalPiano::new(SR);
            pedal(&mut e, Pedal::Sustain, v);
            on(&mut e, 60, 100);
            let l1 = last_50ms_db(&render_mono(&mut e, secs(0.5)));
            off(&mut e, 60);
            let l2 = last_50ms_db(&render_mono(&mut e, secs(0.3)));
            l1 - l2
        };
        let (d0, d64, d127) = (drop(0), drop(64), drop(127));
        println!("half pedal drops over 0.3 s: pedal 0 {d0:.2} dB, pedal 64 {d64:.2} dB, pedal 127 {d127:.2} dB");
        assert!(d0 >= d64 + 10.0, "{d0} vs {d64}");
        assert!(d64 >= d127 + 3.0, "{d64} vs {d127}");
    }

    #[test]
    fn binary_sustain_equals_full_pedal_values() {
        let run = |a: MidiEvent, b: MidiEvent| -> (Vec<f32>, Vec<f32>) {
            let mut e = ModalPiano::new(SR);
            e.handle(&a);
            on(&mut e, 60, 100);
            let (mut l, mut r) = render(&mut e, secs(0.2));
            off(&mut e, 60);
            let (l2, r2) = render(&mut e, secs(0.3));
            l.extend(l2);
            r.extend(r2);
            e.handle(&b);
            let (l3, r3) = render(&mut e, secs(0.3));
            l.extend(l3);
            r.extend(r3);
            (l, r)
        };
        let ped = |value: u8| MidiEvent::Pedal { pedal: Pedal::Sustain, value };
        let full = run(ped(127), ped(0));
        assert_eq!(run(MidiEvent::Sustain { on: true }, MidiEvent::Sustain { on: false }), full);
        assert_eq!(run(ped(127), ped(15)), full);
        assert_eq!(run(ped(100), ped(0)), full);
    }

    #[test]
    fn sostenuto_holds_only_keys_down_at_press() {
        let run = |press: bool| -> (ModalPiano, f64) {
            let mut e = ModalPiano::new(SR);
            on(&mut e, 48, 100);
            render(&mut e, secs(0.2));
            if press {
                pedal(&mut e, Pedal::Sostenuto, 127);
            }
            on(&mut e, 64, 100);
            render(&mut e, secs(0.2));
            let e64 = e.voice_energy(64);
            off(&mut e, 48);
            off(&mut e, 64);
            render(&mut e, secs(0.5));
            (e, e64)
        };
        let free48 = run(false).0.voice_energy(48);
        let (mut e, e64) = run(true);
        let held48 = e.voice_energy(48);
        let after64 = e.voice_energy(64);
        println!("sostenuto: note 48 {held48:e} J (no press {free48:e} J), note 64 {after64:e} J (at key-up {e64:e} J)");
        assert!(held48 > 0.0);
        if free48 > 0.0 {
            assert!(held48 >= 100.0 * free48, "{held48} vs {free48}");
        }
        assert!(after64 <= 1e-3 * e64, "{after64} vs {e64}");
        on(&mut e, 48, 80);
        render(&mut e, secs(0.1));
        off(&mut e, 48);
        render(&mut e, secs(0.3));
        assert!(e.is_sounding(48));
        let held = e.voice_energy(48);
        pedal(&mut e, Pedal::Sostenuto, 0);
        render(&mut e, secs(0.5));
        let released = e.voice_energy(48);
        println!("sostenuto re-strike: note 48 {held:e} J held, {released:e} J 0.5 s after release");
        assert!(released <= 1e-3 * held, "{released} vs {held}");
    }

    #[test]
    fn pedal_events_are_chunk_independent() {
        let total = secs(1.0);
        let events: [(usize, MidiEvent); 9] = [
            (0, MidiEvent::Pedal { pedal: Pedal::Sustain, value: 64 }),
            (0, MidiEvent::NoteOn { note: 48, velocity: 90 }),
            (secs(0.1), MidiEvent::Pedal { pedal: Pedal::Sostenuto, value: 127 }),
            (secs(0.2), MidiEvent::NoteOn { note: 64, velocity: 60 }),
            (secs(0.3), MidiEvent::NoteOff { note: 48 }),
            (secs(0.4), MidiEvent::Pedal { pedal: Pedal::Sustain, value: 100 }),
            (secs(0.5), MidiEvent::NoteOff { note: 64 }),
            (secs(0.6), MidiEvent::Pedal { pedal: Pedal::Sostenuto, value: 0 }),
            (secs(0.7), MidiEvent::Pedal { pedal: Pedal::Sustain, value: 30 }),
        ];
        let run = |chunk: usize| -> (Vec<f32>, Vec<f32>) {
            let mut e = ModalPiano::new(SR);
            let mut l = vec![0.0f32; total];
            let mut r = vec![0.0f32; total];
            let mut pos = 0;
            let mut next = 0;
            while pos < total {
                while next < events.len() && events[next].0 <= pos {
                    e.handle(&events[next].1);
                    next += 1;
                }
                let stop = if next < events.len() { events[next].0 } else { total };
                let end = (pos + chunk).min(stop);
                e.render_stereo(&mut l[pos..end], &mut r[pos..end]);
                pos = end;
            }
            (l, r)
        };
        let (l0, r0) = run(64);
        for chunk in [1000, 7] {
            let (l, r) = run(chunk);
            let diff = l0.iter().zip(&l).chain(r0.iter().zip(&r)).map(|(a, b)| (a - b).abs()).fold(0.0f32, f32::max);
            assert!(diff <= 1e-5, "chunk {chunk}: max diff {diff}");
        }
    }

    fn soft_note(p: &ModalProfile, note: u8, vel: u8, soft: bool) -> Vec<f32> {
        let mut e = ModalPiano::with_profile(SR, p);
        if soft {
            e.handle(&MidiEvent::Pedal { pedal: Pedal::Soft, value: 127 });
        }
        on(&mut e, note, vel);
        render_mono(&mut e, secs(0.3))
    }

    fn centroid_of(m: &[f32]) -> f64 {
        let seg = &m[secs(0.02)..secs(0.02) + 8192];
        let mut buf: Vec<Complex<f64>> = seg
            .iter()
            .enumerate()
            .map(|(i, &x)| {
                let w = 0.5 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / 8192.0).cos();
                Complex::new(x as f64 * w, 0.0)
            })
            .collect();
        FftPlanner::<f64>::new().plan_fft_forward(8192).process(&mut buf);
        let binw = SR as f64 / 8192.0;
        let (mut num, mut den) = (0.0, 0.0);
        for (k, c) in buf.iter().take(4096).enumerate() {
            let f = k as f64 * binw;
            if (20.0..=16000.0).contains(&f) {
                num += f * c.norm();
                den += c.norm();
            }
        }
        num / den
    }

    #[test]
    fn una_corda_is_softer_and_darker() {
        let p = ModalProfile::default();
        for note in [60u8, 84] {
            let normal = soft_note(&p, note, 100, false);
            let soft = soft_note(&p, note, 100, true);
            let pk = |m: &[f32]| m[..secs(0.3).min(m.len())].iter().fold(0.0f32, |a, x| a.max(x.abs()));
            let cr = centroid_of(&soft) / centroid_of(&normal);
            let pr = pk(&soft) / pk(&normal);
            println!("una corda note {note}: centroid ratio {cr:.4}, peak ratio {pr:.4}");
            assert!(cr <= 0.98, "note {note}: centroid ratio {cr}");
            assert!(pr <= 1.06, "note {note}: peak ratio {pr}");
        }
    }

    #[test]
    fn soft_pedal_applies_to_new_notes_only() {
        let run = |soft: bool| {
            let mut e = ModalPiano::new(SR);
            on(&mut e, 60, 100);
            let mut a = render(&mut e, secs(0.1));
            if soft {
                e.handle(&MidiEvent::Pedal { pedal: Pedal::Soft, value: 127 });
            }
            let b = render(&mut e, secs(0.3));
            a.0.extend(b.0);
            a.1.extend(b.1);
            on(&mut e, 64, 100);
            let c = render(&mut e, secs(0.2));
            (a, c)
        };
        let (a, ca) = run(false);
        let (b, cb) = run(true);
        assert_eq!(a.0, b.0);
        assert_eq!(a.1, b.1);
        let diff = ca.0.iter().zip(&cb.0).chain(ca.1.iter().zip(&cb.1)).map(|(x, y)| (x - y).abs()).fold(0.0f32, f32::max);
        assert!(diff > 1e-4, "diff {diff}");
    }

    #[test]
    fn soft_pedal_is_chunk_independent() {
        let total = secs(0.6);
        let events: [(usize, MidiEvent); 3] = [
            (0, MidiEvent::Pedal { pedal: Pedal::Soft, value: 127 }),
            (0, MidiEvent::NoteOn { note: 60, velocity: 90 }),
            (secs(0.2), MidiEvent::NoteOn { note: 40, velocity: 70 }),
        ];
        let run = |chunk: usize| -> (Vec<f32>, Vec<f32>) {
            let mut e = ModalPiano::new(SR);
            let mut l = vec![0.0f32; total];
            let mut r = vec![0.0f32; total];
            let mut pos = 0;
            let mut next = 0;
            while pos < total {
                while next < events.len() && events[next].0 <= pos {
                    e.handle(&events[next].1);
                    next += 1;
                }
                let stop = if next < events.len() { events[next].0 } else { total };
                let end = (pos + chunk).min(stop);
                e.render_stereo(&mut l[pos..end], &mut r[pos..end]);
                pos = end;
            }
            (l, r)
        };
        let (l0, r0) = run(64);
        for chunk in [1000, 7] {
            let (l, r) = run(chunk);
            let diff = l0.iter().zip(&l).chain(r0.iter().zip(&r)).map(|(a, b)| (a - b).abs()).fold(0.0f32, f32::max);
            assert!(diff <= 1e-5, "chunk {chunk}: max diff {diff}");
        }
    }

    #[test]
    fn polyphony_is_capped_and_finite() {
        let p = ModalProfile::default();
        let mut e = ModalPiano::with_profile(SR, &p);
        sustain(&mut e, true);
        let mut all: Vec<f32> = Vec::new();
        for note in 30..=94u8 {
            on(&mut e, note, 127);
            let (l, r) = render(&mut e, 64);
            all.extend(l);
            all.extend(r);
            assert!(e.active_voices() <= 32);
        }
        let (l, r) = render(&mut e, secs(0.25));
        all.extend(l);
        all.extend(r);
        assert!(e.active_voices() <= 32);
        assert!(e.is_sounding(93));
        assert!(!e.is_sounding(30));
        assert!(all.iter().all(|x| x.is_finite() && x.abs() <= p.output.limiter_ceiling + 1e-6));
    }

    #[test]
    fn chunk_size_does_not_change_output() {
        let total = secs(1.0);
        let events: [(usize, MidiEvent); 3] = [
            (0, MidiEvent::NoteOn { note: 48, velocity: 90 }),
            (secs(0.2), MidiEvent::NoteOn { note: 64, velocity: 60 }),
            (secs(0.5), MidiEvent::NoteOff { note: 48 }),
        ];
        let run = |chunk: usize| -> (Vec<f32>, Vec<f32>) {
            let mut e = ModalPiano::new(SR);
            let mut l = vec![0.0f32; total];
            let mut r = vec![0.0f32; total];
            let mut pos = 0;
            let mut next = 0;
            while pos < total {
                while next < events.len() && events[next].0 <= pos {
                    e.handle(&events[next].1);
                    next += 1;
                }
                let stop = if next < events.len() { events[next].0 } else { total };
                let end = (pos + chunk).min(stop);
                e.render_stereo(&mut l[pos..end], &mut r[pos..end]);
                pos = end;
            }
            (l, r)
        };
        let (l0, r0) = run(64);
        for chunk in [1000, 7] {
            let (l, r) = run(chunk);
            let diff = l0.iter().zip(&l).chain(r0.iter().zip(&r)).map(|(a, b)| (a - b).abs()).fold(0.0f32, f32::max);
            let at = l0.iter().zip(&l).position(|(a, b)| (a - b).abs() > 1e-5);
            assert!(diff <= 1e-5, "chunk {chunk}: max diff {diff} at {at:?}");
        }
    }

    fn eq_band_power_db(x: &[f32], lo: f64, hi: f64) -> f64 {
        let n = 16384;
        let seg = &x[secs(0.02)..secs(0.02) + n];
        let mut buf: Vec<Complex<f64>> = seg
            .iter()
            .enumerate()
            .map(|(i, &v)| {
                let w = 0.5 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / n as f64).cos();
                Complex::new(v as f64 * w, 0.0)
            })
            .collect();
        FftPlanner::<f64>::new().plan_fft_forward(n).process(&mut buf);
        let binw = SR as f64 / n as f64;
        let p: f64 = buf.iter().take(n / 2).enumerate().filter(|(k, _)| (lo..hi).contains(&(*k as f64 * binw))).map(|(_, c)| c.norm_sqr()).sum();
        10.0 * (p + 1e-30).log10()
    }

    #[test]
    fn eq_changes_spectrum_as_set() {
        let mut p = ModalProfile::default();
        let mut e0 = ModalPiano::with_profile(SR, &p);
        on(&mut e0, 60, 127);
        let a = render_mono(&mut e0, secs(0.5));
        p.eq.high_shelf_db = 6.0;
        let mut e1 = ModalPiano::with_profile(SR, &p);
        on(&mut e1, 60, 127);
        let b = render_mono(&mut e1, secs(0.5));
        let hi = eq_band_power_db(&b, 8000.0, 24000.0) - eq_band_power_db(&a, 8000.0, 24000.0);
        let lo = eq_band_power_db(&b, 20.0, 1000.0) - eq_band_power_db(&a, 20.0, 1000.0);
        println!("eq high shelf +6 dB: power above 8 kHz {hi:.2} dB, below 1 kHz {lo:.2} dB");
        assert!((3.5..=7.0).contains(&hi), "high {hi}");
        assert!(lo.abs() < 0.5, "low {lo}");
    }

    #[test]
    fn eq_is_chunk_independent() {
        let mut p = ModalProfile::default();
        p.eq.peak2_db = 4.0;
        p.eq.low_shelf_db = -3.0;
        let total = secs(1.0);
        let events: [(usize, MidiEvent); 3] = [
            (0, MidiEvent::NoteOn { note: 48, velocity: 90 }),
            (secs(0.2), MidiEvent::NoteOn { note: 64, velocity: 60 }),
            (secs(0.5), MidiEvent::NoteOff { note: 48 }),
        ];
        let run = |chunk: usize| -> (Vec<f32>, Vec<f32>) {
            let mut e = ModalPiano::with_profile(SR, &p);
            let mut l = vec![0.0f32; total];
            let mut r = vec![0.0f32; total];
            let mut pos = 0;
            let mut next = 0;
            while pos < total {
                while next < events.len() && events[next].0 <= pos {
                    e.handle(&events[next].1);
                    next += 1;
                }
                let stop = if next < events.len() { events[next].0 } else { total };
                let end = (pos + chunk).min(stop);
                e.render_stereo(&mut l[pos..end], &mut r[pos..end]);
                pos = end;
            }
            (l, r)
        };
        let (l0, r0) = run(64);
        for chunk in [1000, 7] {
            let (l, r) = run(chunk);
            let diff = max_diff(&l0, &l).max(max_diff(&r0, &r));
            assert!(diff <= 1e-6, "chunk {chunk}: max diff {diff}");
        }
    }

    #[test]
    fn eq_live_edit_applies_at_once() {
        let p0 = ModalProfile::default();
        let mut a = ModalPiano::with_profile(SR, &p0);
        let mut b = ModalPiano::with_profile(SR, &p0);
        on(&mut a, 60, 100);
        on(&mut b, 60, 100);
        render(&mut a, secs(0.3));
        render(&mut b, secs(0.3));
        let mut p1 = p0;
        p1.eq.peak2_db = 6.0;
        b.set_profile(&p1);
        let (al, ar) = render(&mut a, 64);
        let (bl, br) = render(&mut b, 64);
        assert!(al.iter().chain(&ar).chain(&bl).chain(&br).all(|x| x.is_finite()));
        assert!(max_diff(&al, &bl).max(max_diff(&ar, &br)) > 1e-7);
        assert!(b.eq_active());
        b.set_profile(&p0);
        assert!(!b.eq_active());
        let (l, r) = render(&mut b, 64);
        assert!(l.iter().chain(&r).all(|x| x.is_finite()));
    }

    #[test]
    fn reverb_off_leaves_output_unchanged() {
        let p0 = ModalProfile::default();
        let mut p1 = p0;
        p1.reverb.size = 2.0;
        p1.reverb.decay_s = 5.0;
        p1.reverb.predelay_ms = 100.0;
        p1.reverb.mix = 0.0;
        let mut a = ModalPiano::with_profile(SR, &p0);
        let mut b = ModalPiano::with_profile(SR, &p1);
        on(&mut a, 60, 100);
        on(&mut b, 60, 100);
        let (al, ar) = render(&mut a, secs(0.5));
        let (bl, br) = render(&mut b, secs(0.5));
        assert_eq!(al, bl);
        assert_eq!(ar, br);
    }

    #[test]
    fn reverb_on_adds_tail() {
        let p0 = ModalProfile::default();
        let mut p1 = p0;
        p1.reverb.mix = 0.3;
        let run = |p: &ModalProfile| {
            let mut e = ModalPiano::with_profile(SR, p);
            on(&mut e, 60, 100);
            let (mut l, mut r) = render(&mut e, secs(0.2));
            off(&mut e, 60);
            let (l2, r2) = render(&mut e, secs(1.2));
            l.extend(l2);
            r.extend(r2);
            (l, r)
        };
        let (dl, dr) = run(&p0);
        let (wl, wr) = run(&p1);
        let tail = |l: &[f32], r: &[f32]| {
            let n = l.len();
            let both: Vec<f32> = l[n - secs(0.2)..].iter().chain(&r[n - secs(0.2)..]).copied().collect();
            level_db(&both)
        };
        let dry = tail(&dl, &dr);
        let wet = tail(&wl, &wr);
        println!("last 0.2 s level (both channels): dry {dry:.1} dB, reverb {wet:.1} dB");
        assert!(wet >= dry + 6.0, "dry {dry}, reverb {wet}");
        let ceiling = p1.output.limiter_ceiling;
        assert!(wl.iter().chain(&wr).all(|x| x.is_finite() && x.abs() <= ceiling + 1e-6));
    }

    #[test]
    fn reverb_is_chunk_independent() {
        let mut p = ModalProfile::default();
        p.reverb.mix = 0.3;
        p.reverb.predelay_ms = 20.0;
        p.eq.peak2_db = 3.0;
        let total = secs(1.0);
        let events: [(usize, MidiEvent); 3] = [
            (0, MidiEvent::NoteOn { note: 48, velocity: 90 }),
            (secs(0.2), MidiEvent::NoteOn { note: 64, velocity: 60 }),
            (secs(0.5), MidiEvent::NoteOff { note: 48 }),
        ];
        let run = |chunk: usize| -> (Vec<f32>, Vec<f32>) {
            let mut e = ModalPiano::with_profile(SR, &p);
            let mut l = vec![0.0f32; total];
            let mut r = vec![0.0f32; total];
            let mut pos = 0;
            let mut next = 0;
            while pos < total {
                while next < events.len() && events[next].0 <= pos {
                    e.handle(&events[next].1);
                    next += 1;
                }
                let stop = if next < events.len() { events[next].0 } else { total };
                let end = (pos + chunk).min(stop);
                e.render_stereo(&mut l[pos..end], &mut r[pos..end]);
                pos = end;
            }
            (l, r)
        };
        let (l0, r0) = run(64);
        for chunk in [1000, 7] {
            let (l, r) = run(chunk);
            let diff = max_diff(&l0, &l).max(max_diff(&r0, &r));
            assert!(diff <= 1e-6, "chunk {chunk}: max diff {diff}");
        }
    }

    #[test]
    fn reverb_live_toggle() {
        let p0 = ModalProfile::default();
        let mut p1 = p0;
        p1.reverb.mix = 0.3;
        let mut e = ModalPiano::with_profile(SR, &p0);
        on(&mut e, 60, 100);
        e.set_profile(&p1);
        assert!(e.reverb_active());
        let (l, r) = render(&mut e, secs(0.3));
        assert!(l.iter().chain(&r).all(|x| x.is_finite()));
        e.set_profile(&p0);
        assert!(!e.reverb_active());
        let (l, r) = render(&mut e, secs(0.1));
        assert!(l.iter().chain(&r).all(|x| x.is_finite()));
        e.set_profile(&p1);
        assert!(e.reverb_active());
        let (l, r) = render(&mut e, secs(0.1));
        assert!(l.iter().chain(&r).all(|x| x.is_finite()));
    }

    fn max_step(x: &[f32]) -> f32 {
        x.windows(2).map(|w| (w[1] - w[0]).abs()).fold(0.0f32, f32::max)
    }

    #[test]
    fn stolen_voice_fades_out() {
        let mut p = ModalProfile::default();
        p.voices.max_voices = 1;
        p.mics.board_mix = 0.0;
        p.mics.body_mix = 0.0;
        p.mics.direct_mix = 1.0;
        p.soundboard.coupling = 0.0;
        p.output.output_gain = 0.0134;
        let mut e = ModalPiano::with_profile(SR, &p);
        on(&mut e, 36, 127);
        let (l0, r0) = render(&mut e, secs(0.3));
        let m0: Vec<f32> = l0.iter().zip(&r0).map(|(a, b)| 0.5 * (a + b)).collect();
        let rms_before = rms(&m0[m0.len() - 240..]);
        let dmax_before = max_step(&m0[m0.len() - 480..]);
        on(&mut e, 84, 1);
        assert_eq!(e.active_voices(), 1);
        assert_eq!(e.fading_voices(), 1);
        let (l1, r1) = render(&mut e, 480);
        let m1: Vec<f32> = l1.iter().zip(&r1).map(|(a, b)| 0.5 * (a + b)).collect();
        let mut re = ModalPiano::with_profile(SR, &p);
        on(&mut re, 84, 1);
        let (lr, rr) = render(&mut re, 480);
        let contrib: Vec<f32> = (0..480).map(|t| 0.5 * ((l1[t] - lr[t]) + (r1[t] - rr[t]))).collect();
        let rms_after = rms(&contrib[..120]);
        assert!(rms_after >= 0.4 * rms_before, "rms after {rms_after} vs before {rms_before}");
        assert!(contrib[240..].iter().all(|&x| x.abs() < 1e-6), "contribution not zero after fade");
        let mut seq = vec![m0[m0.len() - 1]];
        seq.extend_from_slice(&m1);
        let step = max_step(&seq);
        assert!(step <= 2.0 * dmax_before, "step {step} vs bound {}", 2.0 * dmax_before);
        assert_eq!(e.fading_voices(), 0);
        assert!(!e.is_sounding(36));
        assert!(e.is_sounding(84));
    }

    #[test]
    fn four_steals_in_one_block_all_fade() {
        let mut p = ModalProfile::default();
        p.voices.max_voices = 4;
        let mut e = ModalPiano::with_profile(SR, &p);
        sustain(&mut e, true);
        for n in [36u8, 40, 43, 48] {
            on(&mut e, n, 127);
        }
        let (l0, r0) = render(&mut e, secs(0.3));
        let m0: Vec<f32> = l0.iter().zip(&r0).map(|(a, b)| 0.5 * (a + b)).collect();
        let dmax_before = max_step(&m0[m0.len() - 480..]);
        for n in [84u8, 86, 88, 90] {
            on(&mut e, n, 1);
        }
        assert_eq!(e.fading_voices(), 4);
        let (l1, r1) = render(&mut e, 480);
        let m1: Vec<f32> = l1.iter().zip(&r1).map(|(a, b)| 0.5 * (a + b)).collect();
        let mut seq = vec![m0[m0.len() - 1]];
        seq.extend_from_slice(&m1);
        let step = max_step(&seq);
        assert!(step <= 2.0 * dmax_before, "step {step} vs bound {}", 2.0 * dmax_before);
        assert_eq!(e.fading_voices(), 0);
    }

    #[test]
    fn stereo_bass_left_treble_right() {
        let mut e = ModalPiano::new(SR);
        on(&mut e, 30, 100);
        let (l, r) = render(&mut e, secs(0.3));
        println!("bass L/R {}", rms(&l) / rms(&r));
        assert!(rms(&l) >= 1.2 * rms(&r), "{} vs {}", rms(&l), rms(&r));
        let mut e = ModalPiano::new(SR);
        on(&mut e, 100, 100);
        let (l, r) = render(&mut e, secs(0.3));
        println!("treble R/L {}", rms(&r) / rms(&l));
        assert!(rms(&r) >= 1.2 * rms(&l), "{} vs {}", rms(&l), rms(&r));
        let mut p = ModalProfile::default();
        p.output.stereo_width = 0.0;
        p.mics.spacing_m = 0.0;
        let mut e = ModalPiano::with_profile(SR, &p);
        on(&mut e, 30, 100);
        let (l, r) = render(&mut e, secs(0.3));
        assert_eq!(l, r);
    }

    const CHORD: [u8; 5] = [48, 55, 60, 64, 67];

    fn chord_render(p: &ModalProfile, frames: usize) -> (Vec<f32>, Vec<f32>) {
        let mut e = ModalPiano::with_profile(SR, p);
        for n in CHORD {
            on(&mut e, n, 90);
        }
        render(&mut e, frames)
    }

    #[test]
    fn soundboard_settings_do_not_touch_direct_only_output() {
        let mut p1 = ModalProfile::default();
        p1.mics.direct_mix = 1.0;
        p1.mics.board_mix = 0.0;
        p1.mics.body_mix = 0.0;
        p1.soundboard.coupling = 0.0;
        let mut p2 = p1;
        p2.soundboard.modes = 64;
        p2.soundboard.q_low = 10.0;
        p2.mics.spacing_m = 1.5;
        p2.soundboard.body_t60_ms = 30.0;
        let run = |p: &ModalProfile| {
            let mut e = ModalPiano::with_profile(SR, p);
            on(&mut e, 60, 100);
            render(&mut e, secs(0.3))
        };
        let (l1, r1) = run(&p1);
        let (l2, r2) = run(&p2);
        assert_eq!(l1, l2);
        assert_eq!(r1, r2);
        assert!(l1.iter().any(|&x| x != 0.0));
        p1.mics.direct_mix = 0.0;
        let (l, r) = run(&p1);
        assert!(l.iter().chain(r.iter()).all(|&x| x == 0.0));
    }

    #[test]
    fn mics_decorrelate_channels() {
        let mut p = ModalProfile::default();
        p.mics.direct_mix = 0.0;
        let (l, r) = chord_render(&p, secs(1.0));
        let (l, r) = (&l[secs(0.05)..], &r[secs(0.05)..]);
        let sum_lr: f64 = l.iter().zip(r).map(|(a, b)| *a as f64 * *b as f64).sum();
        let el: f64 = l.iter().map(|a| (*a as f64).powi(2)).sum();
        let er: f64 = r.iter().map(|a| (*a as f64).powi(2)).sum();
        let corr = sum_lr / (el * er).sqrt();
        println!("L/R correlation {corr}");
        assert!(corr < 0.9, "corr {corr}");
        let em: f64 = l.iter().zip(r).map(|(a, b)| (0.5 * (*a as f64 + *b as f64)).powi(2)).sum();
        println!("mono-sum energy ratio {}", em / (0.5 * (el + er)));
        assert!(em >= 0.3 * 0.5 * (el + er), "mono sum {em} vs {}", 0.5 * (el + er));
    }

    #[test]
    fn board_is_audible() {
        let mut board = ModalProfile::default();
        board.mics.direct_mix = 0.0;
        board.mics.body_mix = 0.0;
        let mut direct = ModalProfile::default();
        direct.mics.board_mix = 0.0;
        direct.mics.body_mix = 0.0;
        let (bl, br) = chord_render(&board, secs(0.5));
        let (dl, dr) = chord_render(&direct, secs(0.5));
        let rb = 0.5 * (rms(&bl) + rms(&br));
        let rd = 0.5 * (rms(&dl) + rms(&dr));
        let db = 20.0 * (rb / rd).log10();
        println!("board vs direct: {db} dB");
        assert!((-15.0..=6.0).contains(&db), "board vs direct {db} dB");
    }

    #[test]
    fn zero_spacing_and_width_give_identical_channels() {
        let mut p = ModalProfile::default();
        p.output.stereo_width = 0.0;
        p.mics.spacing_m = 0.0;
        let (l, r) = chord_render(&p, secs(0.5));
        assert_eq!(l, r);
        assert!(l.iter().any(|&x| x != 0.0));
    }

    #[test]
    fn body_adds_high_band_energy() {
        let band = |body_mix: f32| -> (f64, f64) {
            let mut p = ModalProfile::default();
            p.mics.direct_mix = 1.0;
            p.mics.board_mix = 0.0;
            p.mics.body_mix = body_mix;
            let mut e = ModalPiano::with_profile(SR, &p);
            on(&mut e, 72, 100);
            let m = render_mono(&mut e, secs(0.02) + 16384);
            let mut buf: Vec<Complex<f64>> = m[secs(0.02)..]
                .iter()
                .enumerate()
                .map(|(i, &x)| {
                    let w = 0.5 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / 16384.0).cos();
                    Complex::new(x as f64 * w, 0.0)
                })
                .collect();
            FftPlanner::<f64>::new().plan_fft_forward(16384).process(&mut buf);
            let binw = SR as f64 / 16384.0;
            let (mut hi, mut lo) = (0.0, 0.0);
            for (k, c) in buf.iter().take(8192).enumerate() {
                let f = k as f64 * binw;
                if (3000.0..=12000.0).contains(&f) {
                    hi += c.norm_sqr();
                }
                if f <= 600.0 {
                    lo += c.norm_sqr();
                }
            }
            (hi, lo)
        };
        let (hi0, lo0) = band(0.0);
        let (hi1, lo1) = band(1.0);
        let hi_db = 10.0 * (hi1 / hi0).log10();
        let lo_db = 10.0 * (lo1 / lo0).log10();
        println!("body: high band {hi_db} dB, low band {lo_db} dB");
        assert!(hi_db >= 1.0, "high band +{hi_db} dB");
        assert!(lo_db.abs() <= 0.5, "low band {lo_db} dB");
    }

    fn strongest() -> ModalProfile {
        let mut p = ModalProfile::default();
        p.soundboard.coupling = 4.0;
        p.soundboard.bridge_impedance_kg_s = 300.0;
        p.soundboard.mode_peak = 10.0;
        p
    }

    fn all_coupled(mut p: ModalProfile) -> ModalProfile {
        p.strings.max_partials = 16;
        p.strings.max_mode_hz = 5000.0;
        p.soundboard.coupled_partials = 16;
        p.soundboard.coupled_max_hz = 5000.0;
        // passivity checks the undriven system; noises are an external drive
        p.noises = ModalNoises::off();
        p
    }

    fn frames_at(rate: u32, s: f64) -> usize {
        (s * rate as f64).round() as usize
    }

    fn max_diff(a: &[f32], b: &[f32]) -> f32 {
        a.iter().zip(b).map(|(x, y)| (x - y).abs()).fold(0.0f32, f32::max)
    }

    #[test]
    fn coupling_off_matches_uncoupled_path() {
        let mut a = ModalProfile::default();
        a.mics.board_mix = 0.0;
        a.mics.direct_mix = 1.0;
        a.soundboard.coupling = 0.0;
        let mut b = a;
        b.soundboard.coupled_partials = 0;
        let mut c = a;
        c.soundboard.coupling = 1.0;
        let run = |p: &ModalProfile, note: u8| {
            let mut e = ModalPiano::with_profile(SR, p);
            on(&mut e, note, 100);
            render(&mut e, secs(0.5))
        };
        for note in [36u8, 60, 84] {
            let (la, ra) = run(&a, note);
            let (lb, rb) = run(&b, note);
            let d = max_diff(&la, &lb).max(max_diff(&ra, &rb));
            assert!(d <= 1e-5, "note {note}: {d}");
            let (lc, rc) = run(&c, note);
            let dc = max_diff(&la, &lc).max(max_diff(&ra, &rc));
            assert!(dc > 1e-3, "note {note}: coupling 1.0 vs 0.0 differ by only {dc}");
        }
    }

    #[test]
    fn coupled_energy_never_grows() {
        for rate in [44100u32, 96000] {
            for (name, p) in [("default", all_coupled(ModalProfile::default())), ("strongest", all_coupled(strongest()))] {
                for note in [21u8, 36, 52, 69, 88, 108] {
                    let mut e = ModalPiano::with_profile(rate, &p);
                    on(&mut e, note, 127);
                    render(&mut e, frames_at(rate, 0.05));
                    let e0 = e.coupled_energy();
                    let blocks = frames_at(rate, 0.4) / 64;
                    let mut energies = Vec::with_capacity(blocks);
                    for _ in 0..blocks {
                        render(&mut e, 64);
                        let en = e.coupled_energy();
                        assert!(en.is_finite(), "{name} {rate} note {note}: {en}");
                        energies.push(en);
                    }
                    let mut prev = e0;
                    for (k, &en) in energies.iter().enumerate() {
                        assert!(en <= prev * (1.0 + 1e-4) + 1e-30, "{name} {rate} note {note}: block {k} {prev} -> {en}");
                        prev = en;
                    }
                    let last = energies[energies.len() - 1];
                    println!("{name} {rate} note {note}: E0 {e0:.3e}, last {last:.3e}");
                    assert!(last < 0.9 * e0, "{name} {rate} note {note}: {e0} -> {last}");
                }
            }
        }
    }

    #[test]
    fn strong_coupling_stays_finite_at_all_rates() {
        // All partials coupled (as in coupled_energy_never_grows): an uncoupled ModeBank drives the board one way from outside the
        // measured energy and can feed an exactly tuned free resonance-bank string (stretch tuning, e.g. key 89 partial 2 on note 101).
        let p = all_coupled(strongest());
        let ceiling = p.output.limiter_ceiling + 1e-6;
        let check = |rate: u32, note: u8, vel: u8, len_s: f64| {
            let mut e = ModalPiano::with_profile(rate, &p);
            on(&mut e, note, vel);
            let (l, r) = render(&mut e, frames_at(rate, 0.02));
            let e20 = e.coupled_energy();
            let (l2, r2) = render(&mut e, frames_at(rate, len_s - 0.02));
            let end = e.coupled_energy();
            assert!(
                l.iter().chain(&r).chain(&l2).chain(&r2).all(|x| x.is_finite() && x.abs() <= ceiling),
                "rate {rate} note {note} vel {vel}"
            );
            assert!(e20.is_finite() && end.is_finite(), "rate {rate} note {note} vel {vel}: {e20} {end}");
            assert!(end <= e20, "rate {rate} note {note} vel {vel}: energy {e20} -> {end}");
        };
        for note in 21..=108u8 {
            for vel in [1u8, 127] {
                check(48000, note, vel, 0.1);
            }
        }
        for rate in [44100u32, 96000] {
            for note in (21..=108u8).step_by(5) {
                check(rate, note, 127, 0.05);
            }
        }
    }

    fn slope_db_per_s(m: &[f32], sr: u32, from_s: f64, to_s: f64) -> f64 {
        let f = frames_at(sr, 0.05);
        let from = frames_at(sr, from_s);
        let to = frames_at(sr, to_s).min(m.len());
        let pts: Vec<(f64, f64)> = m[from..to]
            .chunks_exact(f)
            .enumerate()
            .map(|(i, c)| (from_s + (i as f64 + 0.5) * 0.05, level_db(c)))
            .collect();
        let n = pts.len() as f64;
        let mx = pts.iter().map(|p| p.0).sum::<f64>() / n;
        let my = pts.iter().map(|p| p.1).sum::<f64>() / n;
        let sxy: f64 = pts.iter().map(|p| (p.0 - mx) * (p.1 - my)).sum();
        let sxx: f64 = pts.iter().map(|p| (p.0 - mx) * (p.0 - mx)).sum();
        sxy / sxx
    }

    fn early_late(p: &ModalProfile) -> (f64, f64) {
        let mut e = ModalPiano::with_profile(SR, p);
        on(&mut e, 60, 100);
        let m = render_mono(&mut e, secs(5.0));
        (-slope_db_per_s(&m, SR, 0.1, 1.1), -slope_db_per_s(&m, SR, 3.0, 5.0))
    }

    #[test]
    fn double_decay_from_bridge_coupling() {
        let mut p_on = ModalProfile::default();
        p_on.strings.max_partials = 1;
        p_on.strings.unison_decay_spread = 0.0;
        p_on.mics.direct_mix = 1.0;
        p_on.mics.board_mix = 0.0;
        p_on.mics.body_mix = 0.0;
        p_on.output.output_gain = 0.0134;
        let (early, late) = early_late(&p_on);
        println!("coupled: early {early:.2} dB/s, late {late:.2} dB/s, ratio {:.3}", early / late);
        let mut p_off = p_on;
        p_off.soundboard.coupling = 0.0;
        p_off.strings.unison_detune_cents = 0.0;
        let (e_off, l_off) = early_late(&p_off);
        println!("uncoupled: early {e_off:.2} dB/s, late {l_off:.2} dB/s, ratio {:.3}", e_off / l_off);
        assert!(late > 0.0, "late {late}");
        assert!(early >= 1.5 * late, "early {early} late {late}");
        let r = e_off / l_off;
        assert!((0.8..=1.25).contains(&r), "uncoupled ratio {r}");
    }

    #[test]
    fn sympathetic_partial_reaches_other_voice() {
        let run = |p: &ModalProfile, play_c3: bool| {
            let mut e = ModalPiano::with_profile(SR, p);
            sustain(&mut e, true);
            on(&mut e, 60, 1);
            render(&mut e, secs(0.2));
            if play_c3 {
                on(&mut e, 48, 127);
            }
            render(&mut e, secs(1.0));
            e.voice_energy(60)
        };
        let p = ModalProfile::default();
        let mut p_off = p;
        p_off.soundboard.coupling = 0.0;
        let e_on = run(&p, true);
        let e_off = run(&p_off, true);
        let e_alone = run(&p, false);
        println!("C4 energy: with C3 {e_on:.3e} J, coupling off {e_off:.3e} J, without C3 {e_alone:.3e} J");
        assert!(e_alone > 0.0, "{e_alone}");
        assert!(e_on >= 2.0 * e_off, "{e_on} vs {e_off}");
        assert!(e_on >= 2.0 * e_alone, "{e_on} vs {e_alone}");
    }

    fn chord_peak(p: &ModalProfile) -> f32 {
        let mut e = ModalPiano::with_profile(SR, p);
        sustain(&mut e, true);
        for note in [36u8, 43, 48, 52, 55, 60, 64, 67, 72, 76] {
            on(&mut e, note, 127);
        }
        let (l, r) = render(&mut e, secs(1.0));
        assert!(l.iter().chain(r.iter()).all(|x| x.is_finite()), "non-finite sample");
        l.iter().chain(r.iter()).fold(0.0f32, |m, x| m.max(x.abs()))
    }

    fn sl990() -> ModalProfile {
        parse_modal_profile(include_str!("../../../profiles/physical_sl990.ron")).unwrap()
    }

    #[test]
    fn loud_pedalled_chord_is_caught_by_limiter() {
        let p = ModalProfile::default();
        let s = sl990();
        let pp = chord_peak(&p);
        let ps = chord_peak(&s);
        println!("loud pedalled chord peak: physical {pp}, physical_sl990 {ps}");
        assert!(pp <= p.output.limiter_knee * p.output.limiter_ceiling, "physical {pp}");
        // sl990 keeps its gain floor 0.0086 above the test-piece cap, so the limiter is expected to act; see tests/fitted_profiles.rs test_piece_has_headroom.
        assert!(ps <= s.output.limiter_ceiling + 1e-6, "sl990 {ps}");
    }

    /// Held note at v64: (drop from the peak 50 ms frame to the last 50 ms at 1 s, same at 2 s, active voices at 1 s).
    fn held_drops(p: &ModalProfile, note: u8) -> (f64, f64, usize) {
        let mut e = ModalPiano::with_profile(SR, p);
        on(&mut e, note, 64);
        let m = render_mono(&mut e, secs(1.0));
        let active = e.active_voices();
        let peak = frame_db(&m, 0).into_iter().fold(f64::MIN, f64::max);
        let d1 = peak - last_50ms_db(&m);
        let m2 = render_mono(&mut e, secs(1.0));
        let d2 = peak - last_50ms_db(&m2);
        (d1, d2, active)
    }

    #[test]
    fn treble_notes_keep_ringing() {
        // Pianoteq 9 NY Steinway D, v064, 50 ms RMS drop from peak, measured 2026-11-04; numbers only, no audio from the private
        // reference folder is read or committed.
        let p = ModalProfile::default();
        for (note, r1, r2) in [(36u8, 6.2, 10.6), (60, 10.7, 20.5), (72, 16.3, 25.7), (84, 29.1, 36.7), (96, 30.4, 57.5)] {
            let (d1, d2, active) = held_drops(&p, note);
            println!("note {note}: drop at 1 s {d1:.2} dB (ref {r1}), at 2 s {d2:.2} dB (ref {r2}), active {active}");
            assert!(d1 <= r1 + 10.0, "note {note}: drop at 1 s {d1} dB vs ref {r1}");
            assert!(active >= 1, "note {note} not active at 1.0 s");
        }
        let (d1, d2, active) = held_drops(&p, 108);
        println!("note 108: drop at 1 s {d1:.2} dB (ref 48.0), at 2 s {d2:.2} dB (ref 73.8), active {active}");
    }

    #[test]
    fn coupling_keeps_table_decay() {
        let mut p_on = ModalProfile::default();
        p_on.strings.max_partials = 1;
        p_on.strings.unison_decay_spread = 0.0;
        p_on.strings.unison_detune_cents = 0.0;
        p_on.mics.direct_mix = 1.0;
        p_on.mics.board_mix = 0.0;
        p_on.mics.body_mix = 0.0;
        p_on.output.output_gain = 0.0134;
        let mut p_off = p_on;
        p_off.soundboard.coupling = 0.0;
        let early = |p: &ModalProfile, note: u8| {
            let mut e = ModalPiano::with_profile(SR, p);
            on(&mut e, note, 100);
            let m = render_mono(&mut e, secs(1.2));
            -slope_db_per_s(&m, SR, 0.1, 1.1)
        };
        for note in [48u8, 60, 72] {
            let e_on = early(&p_on, note);
            let e_off = early(&p_off, note);
            let r = e_on / e_off;
            println!("note {note}: early slope coupled {e_on:.2} dB/s, uncoupled {e_off:.2} dB/s, ratio {r:.3}");
            assert!((0.65..=1.5).contains(&r), "note {note}: ratio {r} ({e_on} vs {e_off})");
        }
    }

    #[test]
    #[ignore]
    fn print_decay_table() {
        for damping in [0.3f32, 0.2, 0.1] {
            for halving in [15.0f32, 18.0, 22.0, 26.0] {
                for t60_min in [0.4f32, 1.0] {
                    let mut p = ModalProfile::default();
                    p.decay.damping_per_khz2 = damping;
                    p.decay.t60_halving_semitones = halving;
                    p.decay.t60_min_s = t60_min;
                    let mut line = format!("damping {damping} halving {halving} t60_min {t60_min}:");
                    for note in [36u8, 60, 72, 84, 96, 108] {
                        let (d1, d2, _) = held_drops(&p, note);
                        line += &format!(" {note}: {d1:.1}/{d2:.1}");
                    }
                    println!("{line}");
                }
            }
        }
    }

    #[test]
    #[ignore]
    fn print_headroom_table() {
        let mut p = ModalProfile::default();
        p.output.output_gain *= 0.05;
        let mut s = sl990();
        s.output.output_gain *= 0.05;
        let p_phys = 20.0 * chord_peak(&p);
        let p_sl = 20.0 * chord_peak(&s);
        let g_old = ModalProfile::default().output.output_gain;
        let (knee, ceil) = (p.output.limiter_knee, p.output.limiter_ceiling);
        let g_new = g_old * (0.9 * knee * ceil / p_phys).min(0.9 * 0.95 * ceil / p_sl);
        println!("G_old {g_old} P_phys {p_phys} P_sl {p_sl} G_new {g_new}");
    }

    #[test]
    fn live_split_edit_keeps_held_notes() {
        let mut base = ModalProfile::default();
        base.mics.direct_mix = 1.0;
        base.mics.board_mix = 0.0;
        base.mics.body_mix = 0.0;
        base.output.output_gain = 0.0134;
        let mut a = base;
        a.soundboard.coupling = 0.0;
        let mut b = base;
        b.soundboard.coupled_partials = 8;
        let c = base;
        let mut d = base;
        d.soundboard.coupling = 0.5;
        d.soundboard.bridge_impedance_kg_s = 5000.0;
        let mut bad = Vec::new();
        for (name, q) in [("a", a), ("b", b), ("c", c), ("d", d)] {
            let mut e = ModalPiano::with_profile(SR, &base);
            on(&mut e, 48, 100);
            let m0 = render_mono(&mut e, secs(0.5));
            let before = last_50ms_db(&m0);
            e.set_profile(&q);
            let m1 = render_mono(&mut e, secs(0.1));
            let after = last_50ms_db(&m1);
            println!("case {name}: {before:.1} dB -> {after:.1} dB, change {:.1}", after - before);
            if after - before < -3.0 {
                bad.push(name);
            }
        }
        assert!(bad.is_empty(), "held note level dropped by more than 3 dB in cases {bad:?}");
    }

    fn measure_partial(m: &[f32], expected: f64) -> f64 {
        let n_fft = 65536;
        let mut buf: Vec<Complex<f64>> = (0..n_fft)
            .map(|i| {
                if i < m.len() {
                    let w = 0.5 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / m.len() as f64).cos();
                    Complex::new(m[i] as f64 * w, 0.0)
                } else {
                    Complex::new(0.0, 0.0)
                }
            })
            .collect();
        FftPlanner::<f64>::new().plan_fft_forward(n_fft).process(&mut buf);
        let spec: Vec<f64> = buf.iter().take(n_fft / 2).map(|c| c.norm()).collect();
        peak_hz(&spec, SR as f64 / n_fft as f64, expected)
    }

    #[test]
    fn live_retune_moves_all_partials() {
        let base = ModalProfile::default();
        let mut a = base;
        a.tuning.a4_hz = 452.0;
        let mut b = base;
        let mut anchors = base.notes.anchors().to_vec();
        match anchors.iter_mut().find(|x| x.note == 48) {
            Some(x) => x.cents += 30.0,
            None => anchors.push(tables::NoteAnchor { cents: 30.0, ..tables::NoteAnchor::neutral(48) }),
        }
        anchors.sort_by_key(|x| x.note);
        b.notes = tables::NoteTable::from_anchors(&anchors).unwrap();
        assert!(base.soundboard.coupled_partials < 14);
        for (name, q) in [("a4", a), ("cents", b)] {
            let mut e = ModalPiano::with_profile(SR, &base);
            sustain(&mut e, true);
            on(&mut e, 48, 100);
            render_mono(&mut e, secs(0.3));
            e.set_profile(&q);
            render_mono(&mut e, secs(0.4));
            let m = render_mono(&mut e, secs(0.3));
            let f0 = strings::tuned_hz(48, &q) as f32;
            let inh = inharmonicity(48, &q);
            for n in [2usize, 14] {
                let expected = partial_hz(n, f0, inh) as f64;
                let got = measure_partial(&m, expected);
                assert!(((got - expected) / expected).abs() < 0.002, "{name} partial {n}: {got} vs {expected}");
            }
        }
    }

    fn sustain_pedal(e: &mut ModalPiano, v: u8) {
        e.handle(&MidiEvent::Pedal { pedal: Pedal::Sustain, value: v });
    }

    fn bank_sum(e: &ModalPiano, notes: impl Iterator<Item = u8>) -> f64 {
        notes.map(|n| e.resonance_energy(n)).sum()
    }

    #[test]
    fn pedal_lets_other_strings_ring() {
        let run = |pedal: bool| {
            let mut e = ModalPiano::new(SR);
            if pedal {
                sustain(&mut e, true);
            }
            on(&mut e, 48, 110);
            render(&mut e, secs(0.5));
            (e.resonance_energy(60), e.resonance_energy(61), e.resonance_energy(72))
        };
        let (e60, e61, e72) = run(true);
        println!("pedal down: C4 {e60:.3e} J, C#4 {e61:.3e} J, C5 {e72:.3e} J");
        assert!(e60 > 0.0 && e72 > 0.0, "{e60} {e72}");
        assert!(e60 >= 10.0 * e61, "{e60} vs {e61}");
        let (u60, u61, u72) = run(false);
        println!("pedal up: C4 {u60:.3e} J, C#4 {u61:.3e} J, C5 {u72:.3e} J");
        assert_eq!((u60, u61, u72), (0.0, 0.0, 0.0));
    }

    #[test]
    fn resonance_follows_damper_amount() {
        let run = |v: u8| {
            let mut e = ModalPiano::new(SR);
            sustain_pedal(&mut e, v);
            on(&mut e, 48, 110);
            render(&mut e, secs(0.5));
            e.resonance_energy(60)
        };
        let (r127, r64, r0) = (run(127), run(64), run(0));
        println!("C4 resonance: pedal 127 {r127:.3e} J, pedal 64 {r64:.3e} J, pedal 0 {r0:.3e} J");
        assert!(r127 >= 1.5 * r64, "{r127} vs {r64}");
        assert!(r64 > 0.0);
        assert_eq!(r0, 0.0);
    }

    #[test]
    fn undamped_treble_resonates_without_pedal() {
        let mut e = ModalPiano::new(SR);
        on(&mut e, 84, 110);
        render(&mut e, secs(1.0));
        println!("C7 resonance from C6: {:.3e} J", e.resonance_energy(96));
        assert!(e.resonance_energy(96) > 0.0);
        assert_eq!(e.resonance_energy(72), 0.0);
        assert_eq!(e.resonance_energy(60), 0.0);
    }

    #[test]
    fn voiced_key_is_not_in_bank() {
        let mut e = ModalPiano::new(SR);
        sustain(&mut e, true);
        on(&mut e, 60, 100);
        render(&mut e, secs(0.2));
        assert!(e.is_sounding(60));
        assert_eq!(e.resonance_energy(60), 0.0);
        on(&mut e, 48, 110);
        render(&mut e, secs(0.3));
        assert_eq!(e.resonance_energy(60), 0.0);
        assert!(e.resonance_energy(72) > 0.0);
    }

    #[test]
    fn pedal_release_damps_resonance() {
        let mut e = ModalPiano::new(SR);
        sustain(&mut e, true);
        on(&mut e, 48, 110);
        render(&mut e, secs(0.1));
        off(&mut e, 48);
        render(&mut e, secs(1.0));
        let e1 = bank_sum(&e, (21..=88u8).filter(|&n| n != 48));
        assert!(e1 > 0.0);
        sustain(&mut e, false);
        render(&mut e, secs(0.5));
        let e2 = bank_sum(&e, (21..=88u8).filter(|&n| n != 48));
        println!("damped keys' resonance: {e1:.3e} J with pedal, {e2:.3e} J 0.5 s after release");
        assert!(e2 <= 1e-3 * e1, "{e2} vs {e1}");
    }

    #[test]
    fn resonance_off_skips_bank() {
        let run = |p: &ModalProfile| {
            let mut e = ModalPiano::with_profile(SR, p);
            sustain(&mut e, true);
            on(&mut e, 48, 110);
            let out = render(&mut e, secs(0.5));
            (e, out)
        };
        let mut p = ModalProfile::default();
        p.resonance.strength = 0.0;
        let (e, (l0, r0)) = run(&p);
        assert_eq!(e.resonating_keys(), 0);
        assert!((21..=108u8).all(|n| e.resonance_energy(n) == 0.0));
        let (_, (l1, r1)) = run(&ModalProfile::default());
        let d = max_diff(&l0, &l1).max(max_diff(&r0, &r1));
        println!("resonance on vs off: max diff {d:.3e}");
        assert!(d > 1e-6, "{d}");
    }

    #[test]
    fn pedal_resonance_is_chunk_independent() {
        let total = secs(1.2);
        let events: [(usize, MidiEvent); 7] = [
            (0, MidiEvent::Sustain { on: true }),
            (0, MidiEvent::NoteOn { note: 48, velocity: 100 }),
            (secs(0.2), MidiEvent::NoteOff { note: 48 }),
            (secs(0.3), MidiEvent::NoteOn { note: 64, velocity: 80 }),
            (secs(0.5), MidiEvent::Pedal { pedal: Pedal::Sustain, value: 40 }),
            (secs(0.6), MidiEvent::Pedal { pedal: Pedal::Sustain, value: 127 }),
            (secs(0.8), MidiEvent::Sustain { on: false }),
        ];
        let run = |chunk: usize| -> (Vec<f32>, Vec<f32>) {
            let mut e = ModalPiano::new(SR);
            let mut l = vec![0.0f32; total];
            let mut r = vec![0.0f32; total];
            let mut pos = 0;
            let mut next = 0;
            while pos < total {
                while next < events.len() && events[next].0 <= pos {
                    e.handle(&events[next].1);
                    next += 1;
                }
                let stop = if next < events.len() { events[next].0 } else { total };
                let end = (pos + chunk).min(stop);
                e.render_stereo(&mut l[pos..end], &mut r[pos..end]);
                pos = end;
            }
            (l, r)
        };
        let (l0, r0) = run(64);
        for chunk in [1000, 7] {
            let (l, r) = run(chunk);
            let diff = l0.iter().zip(&l).chain(r0.iter().zip(&r)).map(|(a, b)| (a - b).abs()).fold(0.0f32, f32::max);
            assert!(diff <= 1e-5, "chunk {chunk}: max diff {diff}");
        }
    }

    #[test]
    fn resonance_energy_never_grows_with_pedal_down() {
        let mut strong = all_coupled(strongest());
        strong.resonance.strength = 2.0;
        for rate in [44100u32, 96000] {
            for (name, p) in [("default", all_coupled(ModalProfile::default())), ("strongest", strong)] {
                let mut e = ModalPiano::with_profile(rate, &p);
                sustain(&mut e, true);
                for note in [36u8, 60, 84] {
                    on(&mut e, note, 127);
                }
                render(&mut e, frames_at(rate, 0.05));
                let e0 = e.coupled_energy();
                let mut prev = e0;
                for k in 0..frames_at(rate, 0.4) / 64 {
                    render(&mut e, 64);
                    let en = e.coupled_energy();
                    assert!(en.is_finite(), "{name} {rate}: {en}");
                    assert!(en <= prev * (1.0 + 1e-4) + 1e-30, "{name} {rate}: block {k} {prev} -> {en}");
                    prev = en;
                }
                println!("{name} {rate}: E0 {e0:.3e}, last {prev:.3e}, resonating keys {}", e.resonating_keys());
                assert!(e.resonating_keys() >= 60, "{name} {rate}: {} keys", e.resonating_keys());
                assert!(prev < 0.9 * e0, "{name} {rate}: {e0} -> {prev}");
            }
        }
    }

    #[test]
    fn live_resonance_edit_keeps_ringing() {
        let mut e = ModalPiano::new(SR);
        sustain(&mut e, true);
        on(&mut e, 48, 110);
        render(&mut e, secs(0.5));
        let e0 = bank_sum(&e, 0..=127u8);
        let mut p = ModalProfile::default();
        p.resonance.strength = 0.8;
        e.set_profile(&p);
        render(&mut e, 64);
        let e1 = bank_sum(&e, 0..=127u8);
        println!("bank energy {e0:.3e} J, after strength 0.8 {e1:.3e} J");
        assert!(e1 > 0.0 && e1 >= 0.3 * e0, "{e1} vs {e0}");
        p.resonance.strength = 0.0;
        e.set_profile(&p);
        render(&mut e, 64);
        assert_eq!(bank_sum(&e, 0..=127u8), 0.0);
        assert_eq!(e.resonating_keys(), 0);
        e.set_profile(&ModalProfile::default());
        let (l, r) = render(&mut e, secs(0.3));
        assert!(l.iter().chain(&r).all(|x| x.is_finite()));
    }

    #[test]
    fn sustain_with_resonance_stays_close() {
        let run = |p: &ModalProfile| {
            let mut e = ModalPiano::with_profile(SR, p);
            sustain(&mut e, true);
            on(&mut e, 60, 100);
            let m = render_mono(&mut e, secs(0.1));
            off(&mut e, 60);
            let mut all = m;
            all.extend(render_mono(&mut e, secs(0.9)));
            let at_0_2 = level_db(&all[secs(0.15)..secs(0.2)]);
            let at_1_0 = last_50ms_db(&all);
            sustain(&mut e, false);
            let after = last_50ms_db(&render_mono(&mut e, secs(0.3)));
            (at_0_2 - at_1_0, at_1_0, after)
        };
        let (drop, at_1_0, after) = run(&ModalProfile::default());
        let mut off_p = ModalProfile::default();
        off_p.resonance.strength = 0.0;
        let (drop_off, _, _) = run(&off_p);
        println!("sustain drop: default {drop:.2} dB, resonance off {drop_off:.2} dB; default {at_1_0:.2} dB -> {after:.2} dB 0.3 s after release");
        assert!(drop.abs() <= 20.0, "drop {drop}");
        assert!(at_1_0 - after >= 30.0, "{at_1_0} -> {after}");
    }

    /// Profile whose output is the bare string force on the direct path: no board, no body, no pan.
    fn direct_only() -> ModalProfile {
        let mut p = ModalProfile::default();
        p.mics.direct_mix = 1.0;
        p.mics.board_mix = 0.0;
        p.mics.body_mix = 0.0;
        p.output.stereo_width = 0.0;
        p.soundboard.coupling = 0.0;
        p.noises = ModalNoises::off();
        p.resonance.strength = 0.0;
        p
    }

    #[test]
    fn noise_reference_force_matches_middle_c() {
        let mut p = direct_only();
        p.output.output_gain = 0.0005;
        let mut e = ModalPiano::with_profile(SR, &p);
        on(&mut e, 60, 127);
        let l = render_mono(&mut e, secs(0.3));
        let raw = l.iter().fold(0.0f32, |m, x| m.max(x.abs())) / (0.0005 * FRAC_1_SQRT_2 * p.output.master_volume);
        println!("noise reference force: raw {raw:.4} N, NOISE_REF_N {NOISE_REF_N}");
        assert!((0.75 * NOISE_REF_N..=1.25 * NOISE_REF_N).contains(&raw), "raw {raw} vs {NOISE_REF_N}");
    }

    fn noise_base() -> ModalProfile {
        let mut p = direct_only();
        p.output.output_gain = 0.0134;
        p
    }

    fn noise_diff(a: &ModalProfile, b: &ModalProfile, script: impl Fn(&mut ModalPiano) -> Vec<f32>) -> Vec<f32> {
        let mut ea = ModalPiano::with_profile(SR, a);
        let mut eb = ModalPiano::with_profile(SR, b);
        let xa = script(&mut ea);
        let xb = script(&mut eb);
        xa.iter().zip(&xb).map(|(x, y)| y - x).collect()
    }

    fn rms_range(x: &[f32], from: usize, to: usize) -> f64 {
        (x[from..to].iter().map(|&v| (v as f64) * (v as f64)).sum::<f64>() / (to - from) as f64).sqrt()
    }

    #[test]
    fn key_noise_starts_and_ends_with_the_key() {
        let a = noise_base();
        let mut b = a;
        b.noises.key_down = 0.05;
        let d = noise_diff(&a, &b, |e| {
            on(e, 60, 100);
            let (l, r) = render(e, secs(0.3));
            l.into_iter().chain(r).collect()
        });
        let n = secs(0.3);
        for ch in 0..2 {
            let dc = &d[ch * n..(ch + 1) * n];
            let early = rms_range(dc, 0, secs(0.02));
            println!("key down noise: channel {ch} rms {early:.3e}");
            assert!(early > 0.0);
            assert!(dc[secs(0.15)..].iter().all(|&v| v == 0.0));
        }
    }

    #[test]
    fn key_up_noise_follows_release() {
        let a = noise_base();
        let mut b = a;
        b.noises.key_up = 0.05;
        let d = noise_diff(&a, &b, |e| {
            on(e, 60, 100);
            let mut m = render_mono(e, secs(0.2));
            off(e, 60);
            m.extend(render_mono(e, secs(0.2)));
            m
        });
        assert!(d[..secs(0.2)].iter().all(|&v| v == 0.0));
        let r = rms_range(&d, secs(0.2), secs(0.23));
        println!("key up noise rms {r:.3e}");
        assert!(r > 0.0);
    }

    #[test]
    fn key_up_without_key_down_is_silent() {
        let p = ModalProfile {
            noises: ModalNoises { key_up: 0.05, ..ModalNoises::off() },
            ..Default::default()
        };
        let mut e = ModalPiano::with_profile(SR, &p);
        off(&mut e, 60);
        assert_eq!(e.noises.active(), 0);
        let m = render_mono(&mut e, secs(0.1));
        assert!(m.iter().all(|&v| v == 0.0));
    }

    #[test]
    fn pedal_noise_wakes_board_and_rings_free_strings() {
        let p = ModalProfile {
            noises: ModalNoises { pedal_down: 0.05, ..ModalNoises::off() },
            ..Default::default()
        };
        let mut e = ModalPiano::with_profile(SR, &p);
        render(&mut e, 64);
        assert!(!e.board_active());
        sustain(&mut e, true);
        let m = render_mono(&mut e, secs(0.3));
        let peak = m.iter().fold(0.0f32, |a, x| a.max(x.abs()));
        let ringing = bank_sum(&e, 21..=108u8);
        println!("pedal down: peak {peak:.3e}, free strings ring with {ringing:.3e} J");
        assert!(peak > 0.0);
        assert!(e.board_active());
        assert!(ringing > 0.0);
        sustain(&mut e, false);
        let mut blocks = 0;
        while e.board_active() && blocks < secs(15.0) / 64 {
            render(&mut e, 64);
            blocks += 1;
        }
        println!("board idle {:.2} s after pedal up, keys {} voices {} noises {} e {:.3e}", blocks as f64 * 64.0 / SR as f64, e.resonating_keys(), e.active_voices(), e.noises.active(), e.coupled_energy());
        assert!(!e.board_active());
        let m = render_mono(&mut e, 512);
        assert!(m.iter().all(|&v| v == 0.0));
    }

    #[test]
    fn pedal_up_noise_scales_with_lift() {
        let mut p = ModalProfile {
            noises: ModalNoises { pedal_up: 0.05, ..ModalNoises::off() },
            ..Default::default()
        };
        p.resonance.strength = 0.0;
        let run = |v: u8| -> (f64, bool) {
            let mut e = ModalPiano::with_profile(SR, &p);
            pedal(&mut e, Pedal::Sustain, v);
            let first = render_mono(&mut e, secs(0.3));
            pedal(&mut e, Pedal::Sustain, 0);
            let second = render_mono(&mut e, secs(0.3));
            let energy = second.iter().map(|&x| (x as f64) * (x as f64)).sum::<f64>();
            (energy, first.iter().chain(&second).all(|&x| x == 0.0))
        };
        let (full, _) = run(127);
        let (half, _) = run(50);
        let (dead, dead_zero) = run(10);
        println!("pedal up noise energy: full {full:.3e}, half {half:.3e}, dead {dead:.3e}");
        assert!(full > half && half > 0.0, "{full} {half}");
        assert!(dead_zero);
    }

    #[test]
    fn hammer_knock_grows_toward_treble_and_velocity() {
        let mut a = ModalProfile {
            noises: ModalNoises::off(),
            ..Default::default()
        };
        a.resonance.strength = 0.0;
        let mut b = a;
        b.noises.hammer_knock = 0.05;
        let energy = |note: u8, vel: u8| -> f64 {
            let d = noise_diff(&a, &b, |e| {
                on(e, note, vel);
                render_mono(e, secs(0.03))
            });
            d.iter().map(|&x| (x as f64) * (x as f64)).sum()
        };
        let (e96, e36, e96_soft) = (energy(96, 127), energy(36, 127), energy(96, 40));
        println!("hammer knock energy: note 96 v127 {e96:.3e}, note 36 v127 {e36:.3e}, note 96 v40 {e96_soft:.3e}");
        assert!(e96 >= 2.0 * e36, "{e96} vs {e36}");
        assert!(e96 >= 4.0 * e96_soft, "{e96} vs {e96_soft}");
    }

    #[test]
    fn noises_are_chunk_independent() {
        let total = secs(0.9);
        let events: [(usize, MidiEvent); 7] = [
            (0, MidiEvent::Sustain { on: true }),
            (secs(0.05), MidiEvent::NoteOn { note: 72, velocity: 110 }),
            (secs(0.25), MidiEvent::NoteOff { note: 72 }),
            (secs(0.3), MidiEvent::NoteOn { note: 90, velocity: 60 }),
            (secs(0.5), MidiEvent::Pedal { pedal: Pedal::Sustain, value: 40 }),
            (secs(0.55), MidiEvent::Sustain { on: false }),
            (secs(0.6), MidiEvent::NoteOff { note: 90 }),
        ];
        let run = |chunk: usize| -> (Vec<f32>, Vec<f32>) {
            let mut e = ModalPiano::new(SR);
            let mut l = vec![0.0f32; total];
            let mut r = vec![0.0f32; total];
            let mut pos = 0;
            let mut next = 0;
            while pos < total {
                while next < events.len() && events[next].0 <= pos {
                    e.handle(&events[next].1);
                    next += 1;
                }
                let stop = if next < events.len() { events[next].0 } else { total };
                let end = (pos + chunk).min(stop);
                e.render_stereo(&mut l[pos..end], &mut r[pos..end]);
                pos = end;
            }
            (l, r)
        };
        let (l0, r0) = run(64);
        for chunk in [1000, 7] {
            let (l, r) = run(chunk);
            let diff = l0.iter().zip(&l).chain(r0.iter().zip(&r)).map(|(a, b)| (a - b).abs()).fold(0.0f32, f32::max);
            assert!(diff <= 1e-5, "chunk {chunk}: max diff {diff}");
        }
    }

    #[test]
    fn pedal_down_resonance_cull_is_chunk_independent() {
        let total = secs(6.0);
        let events: [(usize, MidiEvent); 4] = [
            (0, MidiEvent::Sustain { on: true }),
            (0, MidiEvent::NoteOn { note: 48, velocity: 100 }),
            (secs(0.5), MidiEvent::NoteOff { note: 48 }),
            (secs(3.0), MidiEvent::Sustain { on: false }),
        ];
        let mid = secs(1.0);
        let run = |chunk: usize| -> (Vec<f32>, Vec<f32>, usize, usize) {
            let mut e = ModalPiano::new(SR);
            let mut l = vec![0.0f32; total];
            let mut r = vec![0.0f32; total];
            let mut pos = 0;
            let mut next = 0;
            let mut mid_keys = 0;
            while pos < total {
                while next < events.len() && events[next].0 <= pos {
                    e.handle(&events[next].1);
                    next += 1;
                }
                if pos == mid {
                    mid_keys = e.resonating_keys();
                }
                let mut stop = if next < events.len() { events[next].0 } else { total };
                if pos < mid {
                    stop = stop.min(mid);
                }
                let end = (pos + chunk).min(stop);
                e.render_stereo(&mut l[pos..end], &mut r[pos..end]);
                pos = end;
            }
            let keys = e.resonating_keys();
            (l, r, keys, mid_keys)
        };
        let (l0, r0, k0, m0) = run(64);
        assert!(m0 > 0, "no resonating keys at 1.0 s");
        for chunk in [7, 13, 1000] {
            let (l, r, k, m) = run(chunk);
            let diff = l0.iter().zip(&l).chain(r0.iter().zip(&r)).map(|(a, b)| (a - b).abs()).fold(0.0f32, f32::max);
            println!("pedal-down chunk {chunk}: max diff {diff:.3e}, resonating keys {k} (64: {k0}), at 1.0 s {m} (64: {m0})");
            assert!(diff <= 1e-5, "chunk {chunk}: max diff {diff}");
            assert_eq!(k, k0, "chunk {chunk}");
            assert_eq!(m, m0, "chunk {chunk} at 1.0 s");
        }
    }
}
