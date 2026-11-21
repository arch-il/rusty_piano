//! Modal piano profile: RON file with the strings, hammer, decay and output settings. Types, built-in defaults, parsing and validation.
//!
//! Sources (approximate published grand-piano data): Conklin 1996, Chaigne & Askenfelt 1994, Fletcher & Rossing, Bank 2000.
//! Values will later be fitted against Pianoteq renders.

use super::tables::NoteTable;
use crate::sound::EngineKind;
use std::fmt::Display;

pub const MAX_MODAL_VOICES: usize = 32;
/// Modes per voice over all strings. Multiple of 8.
pub const MAX_MODES: usize = 192;
/// Most soundboard modes. Multiple of 8.
pub const MAX_BOARD_MODES: usize = 256;
/// Most partials per string coupled to the board.
pub const MAX_COUPLED_PER_STRING: usize = 16;
/// Most partials per string in the sympathetic resonance bank.
pub const MAX_RESONANCE_PARTIALS: usize = 8;
/// Default share of a coupled partial's table loss the bridge may take; the rest stays in the string and carries the aftersound.
pub const DEFAULT_COUPLING_LOSS_FRACTION: f32 = 0.67;

fn default_coupling_loss_fraction() -> f32 {
    DEFAULT_COUPLING_LOSS_FRACTION
}

#[derive(Debug, Clone, Copy, PartialEq, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModalProfile {
    /// Which engine the profile selects. Must be Modal.
    pub engine: EngineKind,
    pub output: ModalOutput,
    pub velocity: ModalVelocity,
    pub strings: ModalStrings,
    #[serde(default)]
    pub tuning: ModalTuning,
    pub decay: ModalDecay,
    pub hammer: ModalHammer,
    pub soundboard: ModalSoundboard,
    pub mics: ModalMics,
    #[serde(default)]
    pub pedals: ModalPedals,
    #[serde(default)]
    pub resonance: ModalResonance,
    #[serde(default)]
    pub noises: ModalNoises,
    #[serde(default)]
    pub eq: ModalEq,
    #[serde(default)]
    pub reverb: ModalReverb,
    pub voices: ModalVoices,
    /// Optional per-note adjustments; empty = none.
    #[serde(default)]
    pub notes: NoteTable,
}

#[derive(Debug, Clone, Copy, PartialEq, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModalTuning {
    /// Octave stretch; 0 = equal temperament; 1 = every note's fundamental equals the second partial of the note an octave below, so octaves on stiff strings do not beat; 2 = twice that stretch. Dimensionless.
    pub stretch: f32,
    /// Pitch of A4 (note 69) in hertz; the stretch is measured from it.
    pub a4_hz: f32,
}

impl Default for ModalTuning {
    fn default() -> Self {
        Self { stretch: 1.0, a4_hz: 440.0 }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModalOutput {
    /// Volume of the whole mix before the limiter. 1.0 = unchanged.
    pub master_volume: f32,
    /// Scales bridge force in newtons to output level (calibrated so a loud pedalled 10-note chord stays below the limiter knee; middle C at velocity 100 peaks near 0.05).
    pub output_gain: f32,
    /// Level tilt in dB per octave around note 60. Positive = treble louder.
    pub level_tilt_db_per_octave: f32,
    /// Stereo spread. 0 = mono, 1 = lowest key fully left, highest fully right.
    pub stereo_width: f32,
    /// Where soft limiting starts, as a fraction of the ceiling.
    pub limiter_knee: f32,
    /// Highest output level (1.0 = full scale).
    pub limiter_ceiling: f32,
}

#[derive(Debug, Clone, Copy, PartialEq, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModalVelocity {
    /// Velocity that counts as full force; harder hits count as this value.
    pub full_force_velocity: u8,
    /// Hammer speed at the softest velocity, metres per second.
    pub hammer_speed_min_mps: f32,
    /// Hammer speed at full force, metres per second.
    pub hammer_speed_max_mps: f32,
    /// speed = min + (max - min) * (velocity / full)^curve. Dimensionless.
    pub speed_curve: f32,
}

#[derive(Debug, Clone, Copy, PartialEq, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModalStrings {
    /// String tension, newtons.
    pub tension_n: f32,
    /// Vibrating length of middle C, metres.
    pub length_middle_c_m: f32,
    /// Length exponent for notes above middle C. Dimensionless.
    pub length_treble_exponent: f32,
    /// Length exponent for notes below middle C. Dimensionless.
    pub length_bass_exponent: f32,
    /// Shortest string length, metres.
    pub length_min_m: f32,
    /// Longest string length, metres.
    pub length_max_m: f32,
    /// Stiffness inharmonicity B at middle C. Dimensionless.
    pub inharmonicity_middle_c: f32,
    /// Inharmonicity growth per octave above middle C. Dimensionless factor.
    pub inharmonicity_treble_octave_factor: f32,
    /// Inharmonicity growth per octave below middle C. Dimensionless factor.
    pub inharmonicity_bass_octave_factor: f32,
    /// First MIDI note with two strings per key.
    pub two_strings_from_note: u8,
    /// First MIDI note with three strings per key.
    pub three_strings_from_note: u8,
    /// Detuning between strings of one unison, cents.
    pub unison_detune_cents: f32,
    /// Decay spread between strings of one unison. Fraction.
    pub unison_decay_spread: f32,
    /// Strike point as a fraction of string length at note 21.
    pub strike_position_bass: f32,
    /// Strike point as a fraction of string length at note 108.
    pub strike_position_treble: f32,
    /// Modes kept per voice over all strings. Count.
    pub max_partials: usize,
    /// Highest mode frequency kept, hertz.
    pub max_mode_hz: f32,
}

fn default_tail_bass() -> f32 {
    2.0
}

fn default_tail_treble() -> f32 {
    0.5
}

#[derive(Debug, Clone, Copy, PartialEq, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModalDecay {
    /// Time for middle C to fall by 60 dB (T60, in seconds). For coupled partials this is the in-phase (prompt) decay; the bridge takes up to two thirds of it and the rest stays in the string.
    pub t60_middle_c_s: f32,
    /// Semitones per halving of the decay time (higher notes decay faster).
    pub t60_halving_semitones: f32,
    /// Shortest decay time any note gets, seconds.
    pub t60_min_s: f32,
    /// Longest decay time any note gets, seconds.
    pub t60_max_s: f32,
    /// Extra loss in 1/s per kHz squared, so high partials die faster.
    pub damping_per_khz2: f32,
    /// Damper decay time at the bass end, seconds.
    pub damper_t60_bass_s: f32,
    /// Damper decay time at the treble end, seconds.
    pub damper_t60_treble_s: f32,
    /// dB of damping after which the damper's grip weakens to the tail rate, 0 - 80. 0 = off (single damper).
    #[serde(default)]
    pub damper_tail_db: f32,
    /// Damper decay time of the residual stage at the bass end, seconds, 0.02 - 20.
    #[serde(default = "default_tail_bass")]
    pub damper_tail_t60_bass_s: f32,
    /// Damper decay time of the residual stage at the treble end, seconds, 0.02 - 20.
    #[serde(default = "default_tail_treble")]
    pub damper_tail_t60_treble_s: f32,
    /// First MIDI note without dampers. 109 = all keys damped.
    pub undamped_from_note: u8,
}

#[derive(Debug, Clone, Copy, PartialEq, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModalHammer {
    /// Hammer mass at the bass end, grams.
    pub mass_bass_g: f32,
    /// Hammer mass at the treble end, grams.
    pub mass_treble_g: f32,
    /// Felt force at 1 mm compression, bass end, newtons.
    pub force_1mm_bass_n: f32,
    /// Felt force at 1 mm compression, treble end, newtons.
    pub force_1mm_treble_n: f32,
    /// Felt stiffness exponent, bass end. Dimensionless.
    pub exponent_bass: f32,
    /// Felt stiffness exponent, treble end. Dimensionless.
    pub exponent_treble: f32,
}

#[derive(Debug, Clone, Copy, PartialEq, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModalSoundboard {
    /// Number of soundboard modes, spread like a plate up to highest_hz. Count.
    pub modes: usize,
    /// Frequency of the lowest soundboard mode, hertz.
    pub lowest_hz: f32,
    /// Frequency of the highest soundboard mode, hertz; above it the body noise takes over.
    pub highest_hz: f32,
    /// Length to width ratio of the plate that sets the mode pattern. Dimensionless.
    pub aspect: f32,
    /// Sharpness (quality factor Q) of the lowest board mode. Dimensionless.
    pub q_low: f32,
    /// Sharpness (quality factor Q) of the highest board mode. Dimensionless.
    pub q_high: f32,
    /// Peak mobility of one board mode relative to the plain bridge; 0 = no board modes. Dimensionless. The peak relative to the bridge holds at middle C; board modes are normalised so the average mobility is the same at every frequency.
    pub mode_peak: f32,
    /// Mean impedance of bridge and soundboard seen by the strings, kg/s; lower = stronger coupling: more of the decay goes through the bridge, giving a longer aftersound and more sympathetic links.
    pub bridge_impedance_kg_s: f32,
    /// Bridge point along the board length, as a fraction.
    pub bridge_x: f32,
    /// Bridge point across the board width, as a fraction.
    pub bridge_y: f32,
    /// Bridge coupling: 1 = physical, 0 = one-way (strings drive the board, no feedback); values between scale both directions together. Dimensionless.
    pub coupling: f32,
    /// Lowest partials of each string that feel the board (two-way coupling). Count.
    pub coupled_partials: usize,
    /// Only partials below this frequency feel the board, hertz.
    pub coupled_max_hz: f32,
    /// Decay time of the body noise response (upper range), milliseconds.
    pub body_t60_ms: f32,
    /// The body noise starts above this frequency (high-pass), hertz.
    pub body_crossover_hz: f32,
    /// Share of a coupled partial's table loss the bridge may take (the prompt, in-phase decay); the rest stays in the string and carries the aftersound; lower = longer aftersound. Fraction.
    #[serde(default = "default_coupling_loss_fraction")]
    pub coupling_loss_fraction: f32,
}

#[derive(Debug, Clone, Copy, PartialEq, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModalMics {
    /// Distance between the left and right microphones, metres; 0 = mono board sound.
    pub spacing_m: f32,
    /// Height of the microphones above the soundboard, metres.
    pub height_m: f32,
    /// Level of the direct string sound, panned by pitch with output.stereo_width.
    pub direct_mix: f32,
    /// Level of the soundboard modes heard by the two microphones.
    pub board_mix: f32,
    /// Level of the body noise response above body_crossover_hz.
    pub body_mix: f32,
}

#[derive(Debug, Clone, Copy, PartialEq, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModalPedals {
    /// Sustain pedal travel (0 = up, 1 = fully down; CC64 / 127) where the dampers start to leave the strings; below it they damp fully. Fraction.
    pub sustain_lift_start: f32,
    /// Sustain pedal travel where the dampers are fully off the strings. Fraction.
    pub sustain_lift_full: f32,
    /// Half-pedal shape: damping = (1 - x)^curve with x = 0 at lift start and 1 at full lift. Dimensionless.
    pub half_pedal_curve: f32,
    /// Soft pedal (una corda) at full shift: how much of the third string of a three-string note the hammer still strikes (0 = missed). Fraction.
    pub una_corda_third_string: f32,
    /// Soft pedal at full shift: how much of the shifted string of a two-string note the hammer still strikes. Fraction.
    pub una_corda_two_string: f32,
    /// Soft pedal at full shift: the hammer hits softer, less packed felt; felt force scales by (1 - this). Fraction.
    pub una_corda_felt_softening: f32,
}

impl Default for ModalPedals {
    fn default() -> Self {
        Self {
            sustain_lift_start: 0.15,
            sustain_lift_full: 0.75,
            half_pedal_curve: 2.0,
            una_corda_third_string: 0.0,
            una_corda_two_string: 0.5,
            una_corda_felt_softening: 0.7,
        }
    }
}

impl ModalPedals {
    /// How firmly the dampers rest on the strings at sustain pedal value `value` (0 - 127): 1.0 = fully on, 0.0 = fully off.
    pub fn damper_engagement(&self, value: u8) -> f32 {
        let d = value as f32 / 127.0;
        if d <= self.sustain_lift_start {
            1.0
        } else if d >= self.sustain_lift_full {
            0.0
        } else {
            (1.0 - (d - self.sustain_lift_start) / (self.sustain_lift_full - self.sustain_lift_start)).powf(self.half_pedal_curve)
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModalResonance {
    /// Bridge coupling of strings that are not being played but are free to ring (dampers lifted by the sustain pedal, a held key or sostenuto, or no damper in the top treble), relative to soundboard.coupling; 0 = no sympathetic resonance, 1 = the same as played strings. Dimensionless.
    pub strength: f32,
    /// The lowest partials of each such string that ring along. Count.
    pub partials: usize,
    /// Only partials below this frequency ring along, hertz.
    pub max_hz: f32,
}

impl Default for ModalResonance {
    fn default() -> Self {
        Self { strength: 1.0, partials: 6, max_hz: 3000.0 }
    }
}

/// Mechanical noises. Every level is the noise force as a fraction of noises::NOISE_REF_N (the peak bridge force of middle C at full velocity, so 0.01 = -40 dB); 0 = off.
#[derive(Debug, Clone, Copy, PartialEq, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModalNoises {
    /// The key bottoming on the keybed at a press, heard directly; grows with hammer speed.
    pub key_down: f32,
    /// Key return and damper felt landing at release, heard directly.
    pub key_up: f32,
    /// The hammer hitting the strings, driven into the bridge and board; grows with hammer speed and is strongest in the treble.
    pub hammer_knock: f32,
    /// Sustain pedal pressed; the dampers lift off the strings, through the board (so free strings ring along) plus a direct thump.
    pub pedal_down: f32,
    /// Sustain pedal released; dampers land and the pedal thumps, through the board plus a direct part, scaled by how far the dampers had lifted.
    pub pedal_up: f32,
}

impl Default for ModalNoises {
    fn default() -> Self {
        Self { key_down: 0.0016, key_up: 0.0008, hammer_knock: 0.01, pedal_down: 0.00153, pedal_up: 0.00147 }
    }
}

impl ModalNoises {
    pub const fn off() -> Self {
        Self { key_down: 0.0, key_up: 0.0, hammer_knock: 0.0, pedal_down: 0.0, pedal_up: 0.0 }
    }
}

/// Output EQ before the limiter: a low shelf, three peaking bands and a high shelf. A gain of 0.0 switches a band off.
#[derive(Debug, Clone, Copy, PartialEq, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModalEq {
    /// Low shelf corner frequency, hertz.
    pub low_shelf_hz: f32,
    /// Low shelf gain, dB; positive = more bass.
    pub low_shelf_db: f32,
    /// Peaking band 1 centre frequency, hertz.
    pub peak1_hz: f32,
    /// Peaking band 1 gain, dB.
    pub peak1_db: f32,
    /// Peaking band 1 Q (larger = narrower).
    pub peak1_q: f32,
    /// Peaking band 2 centre frequency, hertz.
    pub peak2_hz: f32,
    /// Peaking band 2 gain, dB.
    pub peak2_db: f32,
    /// Peaking band 2 Q (larger = narrower).
    pub peak2_q: f32,
    /// Peaking band 3 centre frequency, hertz.
    pub peak3_hz: f32,
    /// Peaking band 3 gain, dB.
    pub peak3_db: f32,
    /// Peaking band 3 Q (larger = narrower).
    pub peak3_q: f32,
    /// High shelf corner frequency, hertz.
    pub high_shelf_hz: f32,
    /// High shelf gain, dB; positive = brighter.
    pub high_shelf_db: f32,
}

impl Default for ModalEq {
    fn default() -> Self {
        Self {
            low_shelf_hz: 120.0,
            low_shelf_db: 0.0,
            peak1_hz: 400.0,
            peak1_db: 0.0,
            peak1_q: 1.0,
            peak2_hz: 1200.0,
            peak2_db: 0.0,
            peak2_q: 1.0,
            peak3_hz: 3500.0,
            peak3_db: 0.0,
            peak3_q: 1.0,
            high_shelf_hz: 6000.0,
            high_shelf_db: 0.0,
        }
    }
}

impl ModalEq {
    /// True when every band gain is exactly 0.0 (no EQ).
    pub fn is_flat(&self) -> bool {
        self.low_shelf_db == 0.0
            && self.peak1_db == 0.0
            && self.peak2_db == 0.0
            && self.peak3_db == 0.0
            && self.high_shelf_db == 0.0
    }
}

/// Optional room reverb (8-line feedback network) added to the sound before the limiter. Off by default.
#[derive(Debug, Clone, Copy, PartialEq, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModalReverb {
    /// Wet level relative to the dry sound; 0.0 = off (exactly the dry sound).
    pub mix: f32,
    /// Room size: scales the reflection paths.
    pub size: f32,
    /// Reverb decay time to -60 dB, seconds.
    pub decay_s: f32,
    /// High frequencies above this die faster in the reverb tail, hertz.
    pub damping_hz: f32,
    /// Gap before the reverb starts, milliseconds.
    pub predelay_ms: f32,
}

impl Default for ModalReverb {
    fn default() -> Self {
        Self { mix: 0.0, size: 1.0, decay_s: 1.6, damping_hz: 5000.0, predelay_ms: 15.0 }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModalVoices {
    /// Most notes sounding at once. Count.
    pub max_voices: usize,
}

impl Default for ModalProfile {
    fn default() -> Self {
        Self {
            engine: EngineKind::Modal,
            output: ModalOutput {
                master_volume: 1.0,
                output_gain: 0.00216,
                level_tilt_db_per_octave: 0.0,
                stereo_width: 0.5,
                limiter_knee: 0.8,
                limiter_ceiling: 0.98,
            },
            velocity: ModalVelocity {
                full_force_velocity: 127,
                hammer_speed_min_mps: 0.2,
                hammer_speed_max_mps: 5.5,
                speed_curve: 2.0,
            },
            strings: ModalStrings {
                tension_n: 700.0,
                length_middle_c_m: 0.62,
                length_treble_exponent: 0.9,
                length_bass_exponent: 0.75,
                length_min_m: 0.05,
                length_max_m: 2.0,
                inharmonicity_middle_c: 0.0004,
                inharmonicity_treble_octave_factor: 2.5,
                inharmonicity_bass_octave_factor: 0.7,
                two_strings_from_note: 31,
                three_strings_from_note: 47,
                unison_detune_cents: 1.0,
                unison_decay_spread: 0.25,
                strike_position_bass: 0.12,
                strike_position_treble: 0.07,
                max_partials: 64,
                max_mode_hz: 16000.0,
            },
            tuning: ModalTuning::default(),
            decay: ModalDecay {
                t60_middle_c_s: 10.0,
                t60_halving_semitones: 26.0,
                t60_min_s: 0.4,
                t60_max_s: 30.0,
                damping_per_khz2: 0.1,
                damper_t60_bass_s: 0.6,
                damper_t60_treble_s: 0.15,
                damper_tail_db: 0.0,
                damper_tail_t60_bass_s: 2.0,
                damper_tail_t60_treble_s: 0.5,
                undamped_from_note: 89,
            },
            hammer: ModalHammer {
                mass_bass_g: 10.0,
                mass_treble_g: 2.0,
                force_1mm_bass_n: 8.0,
                force_1mm_treble_n: 100.0,
                exponent_bass: 2.3,
                exponent_treble: 3.0,
            },
            soundboard: ModalSoundboard {
                modes: 150,
                lowest_hz: 50.0,
                highest_hz: 1500.0,
                aspect: 1.4,
                q_low: 20.0,
                q_high: 12.0,
                mode_peak: 2.0,
                bridge_impedance_kg_s: 6000.0,
                bridge_x: 0.37,
                bridge_y: 0.61,
                coupling: 1.0,
                coupled_partials: 12,
                coupled_max_hz: 2500.0,
                body_t60_ms: 80.0,
                body_crossover_hz: 1500.0,
                coupling_loss_fraction: DEFAULT_COUPLING_LOSS_FRACTION,
            },
            mics: ModalMics { spacing_m: 0.6, height_m: 1.0, direct_mix: 1.0, board_mix: 0.5, body_mix: 0.1 },
            pedals: ModalPedals::default(),
            resonance: ModalResonance::default(),
            noises: ModalNoises::default(),
            eq: ModalEq::default(),
            reverb: ModalReverb::default(),
            voices: ModalVoices { max_voices: 32 },
            notes: NoteTable::default(),
        }
    }
}

fn check_f32(field: &str, v: f32, lo: f32, hi: f32) -> Result<(), String> {
    if (lo..=hi).contains(&v) {
        Ok(())
    } else {
        Err(format!("{field} must be between {lo:?} and {hi:?}, got {v:?}"))
    }
}

fn check_int<T: PartialOrd + Display + Copy>(field: &str, v: T, lo: T, hi: T) -> Result<(), String> {
    if (lo..=hi).contains(&v) {
        Ok(())
    } else {
        Err(format!("{field} must be between {lo} and {hi}, got {v}"))
    }
}

impl ModalProfile {
    pub fn validate(&self) -> Result<(), String> {
        if self.engine != EngineKind::Modal {
            return Err("engine must be Modal in a modal profile".to_string());
        }

        let o = &self.output;
        check_f32("output.master_volume", o.master_volume, 0.0, 4.0)?;
        check_f32("output.output_gain", o.output_gain, 0.0, 10.0)?;
        check_f32("output.level_tilt_db_per_octave", o.level_tilt_db_per_octave, -12.0, 12.0)?;
        check_f32("output.stereo_width", o.stereo_width, 0.0, 1.0)?;
        check_f32("output.limiter_knee", o.limiter_knee, 0.1, 0.99)?;
        check_f32("output.limiter_ceiling", o.limiter_ceiling, 0.1, 1.0)?;

        let v = &self.velocity;
        check_int("velocity.full_force_velocity", v.full_force_velocity, 1, 127)?;
        check_f32("velocity.hammer_speed_min_mps", v.hammer_speed_min_mps, 0.05, 2.0)?;
        check_f32("velocity.hammer_speed_max_mps", v.hammer_speed_max_mps, 0.5, 10.0)?;
        check_f32("velocity.speed_curve", v.speed_curve, 0.2, 5.0)?;
        if v.hammer_speed_min_mps >= v.hammer_speed_max_mps {
            return Err(format!(
                "velocity.hammer_speed_min_mps ({:?}) must be below velocity.hammer_speed_max_mps ({:?})",
                v.hammer_speed_min_mps, v.hammer_speed_max_mps
            ));
        }

        let s = &self.strings;
        check_f32("strings.tension_n", s.tension_n, 100.0, 2000.0)?;
        check_f32("strings.length_middle_c_m", s.length_middle_c_m, 0.2, 1.5)?;
        check_f32("strings.length_treble_exponent", s.length_treble_exponent, 0.3, 1.0)?;
        check_f32("strings.length_bass_exponent", s.length_bass_exponent, 0.3, 1.0)?;
        check_f32("strings.length_min_m", s.length_min_m, 0.02, 0.5)?;
        check_f32("strings.length_max_m", s.length_max_m, 0.5, 3.0)?;
        if s.length_min_m >= s.length_max_m {
            return Err(format!(
                "strings.length_min_m ({:?}) must be below strings.length_max_m ({:?})",
                s.length_min_m, s.length_max_m
            ));
        }
        check_f32("strings.inharmonicity_middle_c", s.inharmonicity_middle_c, 0.0, 0.01)?;
        check_f32(
            "strings.inharmonicity_treble_octave_factor",
            s.inharmonicity_treble_octave_factor,
            1.0,
            5.0,
        )?;
        check_f32("strings.inharmonicity_bass_octave_factor", s.inharmonicity_bass_octave_factor, 0.2, 2.0)?;
        check_int("strings.two_strings_from_note", s.two_strings_from_note, 21, 109)?;
        check_int("strings.three_strings_from_note", s.three_strings_from_note, 21, 109)?;
        if s.two_strings_from_note > s.three_strings_from_note {
            return Err(format!(
                "strings.two_strings_from_note ({}) must not be above strings.three_strings_from_note ({})",
                s.two_strings_from_note, s.three_strings_from_note
            ));
        }
        check_f32("strings.unison_detune_cents", s.unison_detune_cents, 0.0, 10.0)?;
        check_f32("strings.unison_decay_spread", s.unison_decay_spread, 0.0, 0.9)?;
        check_f32("strings.strike_position_bass", s.strike_position_bass, 0.02, 0.5)?;
        check_f32("strings.strike_position_treble", s.strike_position_treble, 0.02, 0.5)?;
        check_int("strings.max_partials", s.max_partials, 1, MAX_MODES)?;
        check_f32("strings.max_mode_hz", s.max_mode_hz, 1000.0, 22000.0)?;
        check_f32("tuning.stretch", self.tuning.stretch, 0.0, 3.0)?;
        check_f32("tuning.a4_hz", self.tuning.a4_hz, 400.0, 480.0)?;

        let d = &self.decay;
        check_f32("decay.t60_middle_c_s", d.t60_middle_c_s, 0.1, 60.0)?;
        check_f32("decay.t60_halving_semitones", d.t60_halving_semitones, 1.0, 120.0)?;
        check_f32("decay.t60_min_s", d.t60_min_s, 0.05, 60.0)?;
        check_f32("decay.t60_max_s", d.t60_max_s, 0.05, 120.0)?;
        if d.t60_min_s > d.t60_max_s {
            return Err(format!(
                "decay.t60_min_s ({:?}) must not be above decay.t60_max_s ({:?})",
                d.t60_min_s, d.t60_max_s
            ));
        }
        check_f32("decay.damping_per_khz2", d.damping_per_khz2, 0.0, 10.0)?;
        check_f32("decay.damper_t60_bass_s", d.damper_t60_bass_s, 0.02, 5.0)?;
        check_f32("decay.damper_t60_treble_s", d.damper_t60_treble_s, 0.02, 5.0)?;
        check_f32("decay.damper_tail_db", d.damper_tail_db, 0.0, 80.0)?;
        check_f32("decay.damper_tail_t60_bass_s", d.damper_tail_t60_bass_s, 0.02, 20.0)?;
        check_f32("decay.damper_tail_t60_treble_s", d.damper_tail_t60_treble_s, 0.02, 20.0)?;
        check_int("decay.undamped_from_note", d.undamped_from_note, 21, 109)?;

        let h = &self.hammer;
        check_f32("hammer.mass_bass_g", h.mass_bass_g, 1.0, 30.0)?;
        check_f32("hammer.mass_treble_g", h.mass_treble_g, 1.0, 30.0)?;
        check_f32("hammer.force_1mm_bass_n", h.force_1mm_bass_n, 0.5, 500.0)?;
        check_f32("hammer.force_1mm_treble_n", h.force_1mm_treble_n, 0.5, 500.0)?;
        check_f32("hammer.exponent_bass", h.exponent_bass, 1.5, 4.0)?;
        check_f32("hammer.exponent_treble", h.exponent_treble, 1.5, 4.0)?;

        let b = &self.soundboard;
        check_int("soundboard.modes", b.modes, 8, MAX_BOARD_MODES)?;
        check_f32("soundboard.lowest_hz", b.lowest_hz, 20.0, 200.0)?;
        check_f32("soundboard.highest_hz", b.highest_hz, 300.0, 5000.0)?;
        check_f32("soundboard.aspect", b.aspect, 1.0, 4.0)?;
        check_f32("soundboard.q_low", b.q_low, 2.0, 200.0)?;
        check_f32("soundboard.q_high", b.q_high, 2.0, 200.0)?;
        check_f32("soundboard.mode_peak", b.mode_peak, 0.0, 10.0)?;
        check_f32("soundboard.bridge_impedance_kg_s", b.bridge_impedance_kg_s, 300.0, 50000.0)?;
        check_f32("soundboard.bridge_x", b.bridge_x, 0.02, 0.98)?;
        check_f32("soundboard.bridge_y", b.bridge_y, 0.02, 0.98)?;
        check_f32("soundboard.coupling", b.coupling, 0.0, 4.0)?;
        check_int("soundboard.coupled_partials", b.coupled_partials, 0, MAX_COUPLED_PER_STRING)?;
        check_f32("soundboard.coupled_max_hz", b.coupled_max_hz, 100.0, 5000.0)?;
        check_f32("soundboard.body_t60_ms", b.body_t60_ms, 10.0, 200.0)?;
        check_f32("soundboard.body_crossover_hz", b.body_crossover_hz, 200.0, 8000.0)?;
        check_f32("soundboard.coupling_loss_fraction", b.coupling_loss_fraction, 0.0, 0.95)?;
        if b.lowest_hz >= b.highest_hz {
            return Err(format!(
                "soundboard.lowest_hz ({:?}) must be below soundboard.highest_hz ({:?})",
                b.lowest_hz, b.highest_hz
            ));
        }

        let m = &self.mics;
        check_f32("mics.spacing_m", m.spacing_m, 0.0, 3.0)?;
        check_f32("mics.height_m", m.height_m, 0.1, 5.0)?;
        check_f32("mics.direct_mix", m.direct_mix, 0.0, 4.0)?;
        check_f32("mics.board_mix", m.board_mix, 0.0, 4.0)?;
        check_f32("mics.body_mix", m.body_mix, 0.0, 4.0)?;

        let pd = &self.pedals;
        check_f32("pedals.sustain_lift_start", pd.sustain_lift_start, 0.0, 0.9)?;
        check_f32("pedals.sustain_lift_full", pd.sustain_lift_full, 0.1, 1.0)?;
        check_f32("pedals.half_pedal_curve", pd.half_pedal_curve, 0.2, 5.0)?;
        check_f32("pedals.una_corda_third_string", pd.una_corda_third_string, 0.0, 1.0)?;
        check_f32("pedals.una_corda_two_string", pd.una_corda_two_string, 0.0, 1.0)?;
        check_f32("pedals.una_corda_felt_softening", pd.una_corda_felt_softening, 0.0, 0.8)?;
        if pd.sustain_lift_full < pd.sustain_lift_start + 0.05 {
            return Err(format!(
                "pedals.sustain_lift_full ({:?}) must be at least 0.05 above pedals.sustain_lift_start ({:?})",
                pd.sustain_lift_full, pd.sustain_lift_start
            ));
        }

        let rs = &self.resonance;
        check_f32("resonance.strength", rs.strength, 0.0, 2.0)?;
        check_int("resonance.partials", rs.partials, 1, MAX_RESONANCE_PARTIALS)?;
        check_f32("resonance.max_hz", rs.max_hz, 200.0, 5000.0)?;
        let nz = &self.noises;
        check_f32("noises.key_down", nz.key_down, 0.0, 1.0)?;
        check_f32("noises.key_up", nz.key_up, 0.0, 1.0)?;
        check_f32("noises.hammer_knock", nz.hammer_knock, 0.0, 1.0)?;
        check_f32("noises.pedal_down", nz.pedal_down, 0.0, 1.0)?;
        check_f32("noises.pedal_up", nz.pedal_up, 0.0, 1.0)?;

        let q = &self.eq;
        check_f32("eq.low_shelf_hz", q.low_shelf_hz, 20.0, 20000.0)?;
        check_f32("eq.low_shelf_db", q.low_shelf_db, -12.0, 12.0)?;
        check_f32("eq.peak1_hz", q.peak1_hz, 20.0, 20000.0)?;
        check_f32("eq.peak1_db", q.peak1_db, -12.0, 12.0)?;
        check_f32("eq.peak1_q", q.peak1_q, 0.1, 10.0)?;
        check_f32("eq.peak2_hz", q.peak2_hz, 20.0, 20000.0)?;
        check_f32("eq.peak2_db", q.peak2_db, -12.0, 12.0)?;
        check_f32("eq.peak2_q", q.peak2_q, 0.1, 10.0)?;
        check_f32("eq.peak3_hz", q.peak3_hz, 20.0, 20000.0)?;
        check_f32("eq.peak3_db", q.peak3_db, -12.0, 12.0)?;
        check_f32("eq.peak3_q", q.peak3_q, 0.1, 10.0)?;
        check_f32("eq.high_shelf_hz", q.high_shelf_hz, 20.0, 20000.0)?;
        check_f32("eq.high_shelf_db", q.high_shelf_db, -12.0, 12.0)?;

        let rv = &self.reverb;
        check_f32("reverb.mix", rv.mix, 0.0, 1.0)?;
        check_f32("reverb.size", rv.size, 0.5, 2.0)?;
        check_f32("reverb.decay_s", rv.decay_s, 0.2, 10.0)?;
        check_f32("reverb.damping_hz", rv.damping_hz, 500.0, 20000.0)?;
        check_f32("reverb.predelay_ms", rv.predelay_ms, 0.0, 200.0)?;

        check_int("voices.max_voices", self.voices.max_voices, 1, MAX_MODAL_VOICES)?;

        for (i, a) in self.notes.anchors().iter().enumerate() {
            check_int(&format!("notes[{i}].note"), a.note, 21, 108)?;
            if i >= 1 {
                let prev = self.notes.anchors()[i - 1].note;
                if a.note <= prev {
                    return Err(format!(
                        "notes[{i}].note ({}) must be above notes[{}].note ({})",
                        a.note,
                        i - 1,
                        prev
                    ));
                }
            }
            check_f32(&format!("notes[{i}].cents"), a.cents, -100.0, 100.0)?;
            check_f32(&format!("notes[{i}].level_db"), a.level_db, -24.0, 24.0)?;
            check_f32(&format!("notes[{i}].t60"), a.t60, 0.1, 10.0)?;
            check_f32(&format!("notes[{i}].damping"), a.damping, 0.0, 10.0)?;
            check_f32(&format!("notes[{i}].inharmonicity"), a.inharmonicity, 0.0, 10.0)?;
            check_f32(&format!("notes[{i}].hardness"), a.hardness, 0.1, 10.0)?;
            check_f32(&format!("notes[{i}].hammer_mass"), a.hammer_mass, 0.25, 4.0)?;
            check_f32(&format!("notes[{i}].strike"), a.strike, 0.25, 4.0)?;
            check_f32(&format!("notes[{i}].detune"), a.detune, 0.0, 10.0)?;
            check_f32(&format!("notes[{i}].damper"), a.damper, 0.1, 30.0)?;
            check_f32(&format!("notes[{i}].aftersound"), a.aftersound, 0.1, 5.0)?;
            check_f32(&format!("notes[{i}].prompt_db_per_s"), a.prompt_db_per_s, 0.0, 400.0)?;
            check_f32(&format!("notes[{i}].after_level_db"), a.after_level_db, -60.0, 0.0)?;
            check_f32(&format!("notes[{i}].decay_spread"), a.decay_spread, 0.0, 4.0)?;
            check_f32(&format!("notes[{i}].damper_tail"), a.damper_tail, 0.1, 10.0)?;
            check_f32(&format!("notes[{i}].direct_db"), a.direct_db, -30.0, 30.0)?;
        }
        Ok(())
    }
}

pub fn parse_modal_profile(text: &str) -> Result<ModalProfile, String> {
    let p = ron::from_str::<ModalProfile>(text).map_err(|e| e.to_string())?;
    p.validate()?;
    Ok(p)
}

#[cfg(test)]
mod tests {
    use super::*;

    const PHYSICAL_RON: &str = include_str!("../../../profiles/physical.ron");

    fn with_notes(inner: &str) -> String {
        let start = PHYSICAL_RON.find("    notes: [").unwrap();
        let rest = &PHYSICAL_RON[start..];
        let end = if rest.starts_with("    notes: [],") {
            "    notes: [],".len()
        } else {
            rest.find("\n    ],").unwrap() + "\n    ],".len()
        };
        format!("{}    notes: [{inner}],{}", &PHYSICAL_RON[..start], &rest[end..])
    }

    #[test]
    fn physical_ron_is_prior_plus_fitted_fields() {
        assert_eq!(crate::fit::ron_edit::unfitted(&parse_modal_profile(PHYSICAL_RON).unwrap()), ModalProfile::default());
    }

    #[test]
    fn default_is_valid() {
        assert!(ModalProfile::default().validate().is_ok());
    }

    #[test]
    fn validation_names_field_and_range() {
        type Case = (fn(&mut ModalProfile), &'static str, bool);
        let cases: Vec<Case> = vec![
            (|p| p.output.master_volume = f32::NAN, "output.master_volume", true),
            (|p| p.velocity.full_force_velocity = 0, "velocity.full_force_velocity", true),
            (|p| p.strings.max_partials = MAX_MODES + 1, "strings.max_partials", true),
            (|p| p.tuning.stretch = 5.0, "tuning.stretch", true),
            (|p| p.tuning.a4_hz = 300.0, "tuning.a4_hz", true),
            (|p| p.decay.undamped_from_note = 110, "decay.undamped_from_note", true),
            (|p| p.voices.max_voices = 0, "voices.max_voices", true),
            (|p| p.hammer.exponent_bass = 5.0, "hammer.exponent_bass", true),
            (|p| p.output.limiter_knee = 1.0, "output.limiter_knee", true),
            (|p| p.strings.inharmonicity_middle_c = -0.1, "strings.inharmonicity_middle_c", true),
            (|p| p.soundboard.modes = 0, "soundboard.modes", true),
            (|p| p.soundboard.modes = MAX_BOARD_MODES + 1, "soundboard.modes", true),
            (|p| p.soundboard.coupled_partials = MAX_COUPLED_PER_STRING + 1, "soundboard.coupled_partials", true),
            (|p| p.mics.spacing_m = -1.0, "mics.spacing_m", true),
            (|p| p.soundboard.bridge_impedance_kg_s = 10.0, "soundboard.bridge_impedance_kg_s", true),
            (|p| p.pedals.half_pedal_curve = 9.0, "pedals.half_pedal_curve", true),
            (|p| p.pedals.una_corda_felt_softening = 0.95, "pedals.una_corda_felt_softening", true),
            (|p| p.pedals.sustain_lift_start = -0.1, "pedals.sustain_lift_start", true),
            (|p| p.resonance.strength = 3.0, "resonance.strength", true),
            (|p| p.resonance.partials = 0, "resonance.partials", true),
            (|p| p.noises.pedal_up = -0.1, "noises.pedal_up", true),
            (|p| p.eq.peak2_db = 20.0, "eq.peak2_db", true),
            (|p| p.eq.peak1_q = 0.0, "eq.peak1_q", true),
            (|p| p.reverb.size = 3.0, "reverb.size", true),
            (|p| p.soundboard.coupling_loss_fraction = 0.99, "soundboard.coupling_loss_fraction", true),
            (
                |p| {
                    p.pedals.sustain_lift_start = 0.5;
                    p.pedals.sustain_lift_full = 0.52;
                },
                "pedals.sustain_lift_full",
                false,
            ),
            (
                |p| {
                    p.velocity.hammer_speed_min_mps = 1.0;
                    p.velocity.hammer_speed_max_mps = 0.5;
                },
                "velocity.hammer_speed_min_mps",
                false,
            ),
            (
                |p| {
                    p.strings.length_min_m = 0.5;
                    p.strings.length_max_m = 0.5;
                },
                "strings.length_max_m",
                false,
            ),
            (
                |p| {
                    p.strings.two_strings_from_note = 50;
                    p.strings.three_strings_from_note = 40;
                },
                "strings.two_strings_from_note",
                false,
            ),
            (
                |p| {
                    p.decay.t60_min_s = 20.0;
                    p.decay.t60_max_s = 10.0;
                },
                "must not be above",
                false,
            ),
            (|p| p.engine = EngineKind::Simple, "engine must be Modal", false),
        ];
        for (mutate, expect, ranged) in cases {
            let mut p = ModalProfile::default();
            mutate(&mut p);
            let err = p.validate().unwrap_err();
            assert!(err.contains(expect), "expected '{expect}' in: {err}");
            if ranged {
                assert!(err.contains("between"), "expected 'between' in: {err}");
            }
        }
    }

    #[test]
    fn parse_errors_name_unknown_fields() {
        let misspelled = PHYSICAL_RON.replace("stereo_width:", "stereo_widht:");
        let err = parse_modal_profile(&misspelled).unwrap_err();
        assert!(err.contains("stereo_widht"), "{err}");
    }

    #[test]
    fn physical_sl990_ron_is_tuned_modal_profile() {
        let p = parse_modal_profile(include_str!("../../../profiles/physical_sl990.ron")).unwrap();
        let u = crate::fit::ron_edit::unfitted(&p);
        let d = ModalProfile::default();
        assert_eq!(p.engine, EngineKind::Modal);
        assert_eq!(p.velocity.full_force_velocity, 90);
        assert!(p.output.level_tilt_db_per_octave < 0.0);
        assert_eq!(u.strings, d.strings);
        assert_eq!(u.tuning, d.tuning);
        assert_eq!(u.decay, d.decay);
        assert_eq!(u.hammer, d.hammer);
        assert_eq!(u.soundboard, d.soundboard);
        assert_eq!(u.mics, d.mics);
        assert_eq!(u.voices, d.voices);
        assert_eq!(u.notes, d.notes);
        assert_eq!(u.pedals, d.pedals);
        assert_eq!(u.resonance, d.resonance);
        assert_eq!(u.noises, d.noises);
        assert_eq!(u.eq, d.eq);
        assert_eq!(u.reverb, d.reverb);
    }

    #[test]
    fn damper_engagement_curve() {
        let p = ModalPedals::default();
        assert_eq!(p.damper_engagement(0), 1.0);
        assert_eq!(p.damper_engagement(127), 0.0);
        for v in 0..=19u8 {
            assert_eq!(p.damper_engagement(v), 1.0, "value {v}");
        }
        for v in 96..=127u8 {
            assert_eq!(p.damper_engagement(v), 0.0, "value {v}");
        }
        for v in 0..127u8 {
            assert!(p.damper_engagement(v + 1) <= p.damper_engagement(v), "value {v}");
        }
        let h = p.damper_engagement(64);
        assert!(h > 0.1 && h < 0.3, "{h}");
    }

    #[test]
    fn notes_table_parses_from_ron() {
        let text = with_notes("(note: 30, t60: 1.5), (note: 90, level_db: -2.0)");
        let p = parse_modal_profile(&text).unwrap();
        assert_eq!(p.notes.len(), 2);
        assert_eq!(p.notes.at(30).t60, 1.5);
        assert_eq!(p.notes.at(90).level_db, -2.0);
        assert!((p.notes.at(60).t60 - 1.25).abs() < 1e-6);
        assert_eq!(p.notes.at(60).hardness, 1.0);
    }

    #[test]
    fn notes_table_validation_names_entry() {
        let with = |n: &str| with_notes(n);
        let err = parse_modal_profile(&with("(note: 50), (note: 40)")).unwrap_err();
        assert!(err.contains("notes[1].note"), "{err}");
        let err = parse_modal_profile(&with("(note: 50, t60: 20.0)")).unwrap_err();
        assert!(err.contains("notes[0].t60") && err.contains("between"), "{err}");
        let err = parse_modal_profile(&with("(note: 50, aftersound: 9.0)")).unwrap_err();
        assert!(err.contains("notes[0].aftersound") && err.contains("between"), "{err}");
        let many: Vec<String> = (0..89).map(|i| format!("(note: {})", 21 + i)).collect();
        let err = parse_modal_profile(&with(&many.join(", "))).unwrap_err();
        assert!(err.contains("at most 88"), "{err}");
        let err = parse_modal_profile(&with("(note: 50, tilt: 1.0)")).unwrap_err();
        assert!(err.contains("tilt"), "{err}");
    }

    #[test]
    fn physical_sl990_ron_numbers_have_comments() {
        assert_numbers_have_comments(include_str!("../../../profiles/physical_sl990.ron"));
    }

    #[test]
    fn physical_ron_numbers_have_comments() {
        assert_numbers_have_comments(PHYSICAL_RON);
    }

    fn assert_numbers_have_comments(text: &str) {
        let lines: Vec<&str> = text.lines().collect();
        for (i, line) in lines.iter().enumerate() {
            let t = line.trim();
            let is_number_line = match t.split_once(": ") {
                Some((key, value)) => {
                    key.starts_with(|c: char| c.is_ascii_lowercase())
                        && key.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
                        && (value.starts_with(|c: char| c.is_ascii_digit()) || value.starts_with('-'))
                }
                None => false,
            };
            if !is_number_line {
                continue;
            }
            let prev = lines[..i].iter().rev().map(|l| l.trim()).find(|l| !l.is_empty());
            assert!(prev.is_some_and(|p| p.starts_with("//")), "no comment above line: {t}");
        }
    }
}
