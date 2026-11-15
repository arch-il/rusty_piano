//! Sound engines. Sampled piano, physical modelling and neural engines
//! will implement `SoundEngine`. Engines render stereo; the mono render is
//! a mix for tests and analysis.

use crate::config::SoundProfile;
use crate::midi::MidiEvent;
use modal_piano::ModalPiano;
use simple_piano::SimplePiano;

/// Simple piano-like voice used for live playing.
pub mod simple_piano;
pub mod test_tone;
pub mod modal_piano;
pub mod waveguide_piano;

/// Frames per chunk used by the provided mono `render`.
pub const MONO_CHUNK: usize = 256;

/// Which engine a profile file selects. A future Waveguide variant goes here.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Deserialize)]
pub enum EngineKind {
    #[default]
    Simple,
    Modal,
}

impl EngineKind {
    pub fn label(self) -> &'static str {
        match self {
            EngineKind::Simple => "simple piano",
            EngineKind::Modal => "modal piano (physical model)",
        }
    }
}

pub trait SoundEngine {
    fn handle(&mut self, ev: &MidiEvent);
    /// Fill (do not add to) the first n = min(left.len(), right.len()) frames of both channels at the engine's sample rate. Must not allocate, lock or block.
    fn render_stereo(&mut self, left: &mut [f32], right: &mut [f32]);
    /// Fill a mono f32 buffer at the engine's sample rate as the mix 0.5 * (l + r).
    fn render(&mut self, out: &mut [f32]) {
        let mut l = [0.0f32; MONO_CHUNK];
        let mut r = [0.0f32; MONO_CHUNK];
        for chunk in out.chunks_mut(MONO_CHUNK) {
            let n = chunk.len();
            self.render_stereo(&mut l[..n], &mut r[..n]);
            for i in 0..n {
                chunk[i] = 0.5 * (l[i] + r[i]);
            }
        }
    }
    /// Apply new settings from the audio thread. Must not allocate, lock or block. Default: ignore.
    fn apply_profile(&mut self, _profile: &crate::config::Profile) {}
    /// Live reload with a profile of any kind. Default: Simple profiles go to apply_profile; other kinds are ignored.
    fn apply_sound_profile(&mut self, profile: &SoundProfile) {
        if let SoundProfile::Simple(p) = profile {
            self.apply_profile(p)
        }
    }
}

#[allow(clippy::large_enum_variant)] // boxing would put a heap indirection on the audio path; the size is deliberate
pub enum AnyEngine {
    Simple(Box<SimplePiano>),
    Modal(ModalPiano),
}

impl AnyEngine {
    pub fn kind(&self) -> EngineKind {
        match self {
            AnyEngine::Simple(_) => EngineKind::Simple,
            AnyEngine::Modal(_) => EngineKind::Modal,
        }
    }
}

impl SoundEngine for AnyEngine {
    fn handle(&mut self, ev: &MidiEvent) {
        match self {
            AnyEngine::Simple(e) => e.handle(ev),
            AnyEngine::Modal(e) => e.handle(ev),
        }
    }

    fn render_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
        match self {
            AnyEngine::Simple(e) => e.render_stereo(left, right),
            AnyEngine::Modal(e) => e.render_stereo(left, right),
        }
    }

    fn render(&mut self, out: &mut [f32]) {
        match self {
            AnyEngine::Simple(e) => e.render(out),
            AnyEngine::Modal(e) => e.render(out),
        }
    }

    fn apply_profile(&mut self, profile: &crate::config::Profile) {
        if let AnyEngine::Simple(e) = self {
            e.apply_profile(profile);
        }
    }

    fn apply_sound_profile(&mut self, profile: &SoundProfile) {
        match (self, profile) {
            (AnyEngine::Simple(e), SoundProfile::Simple(p)) => e.apply_profile(p),
            (AnyEngine::Modal(e), SoundProfile::Modal(p)) => e.set_profile(p),
            _ => {}
        }
    }
}

pub fn build_engine(sample_rate: u32, profile: &SoundProfile) -> AnyEngine {
    match profile {
        SoundProfile::Simple(p) => AnyEngine::Simple(Box::new(SimplePiano::with_profile(sample_rate, p))),
        SoundProfile::Modal(p) => AnyEngine::Modal(ModalPiano::with_profile(sample_rate, p)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Profile;
    use crate::midi::MidiEvent;
    use crate::render::render_events_stereo;
    use crate::sound::modal_piano::ModalProfile;

    struct Split;

    impl SoundEngine for Split {
        fn handle(&mut self, _ev: &MidiEvent) {}

        fn render_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
            left.fill(0.5);
            right.fill(-0.25);
        }
    }

    #[test]
    fn default_mono_render_mixes_channels() {
        let mut buf = vec![9.0f32; 1000];
        Split.render(&mut buf);
        assert!(buf.iter().all(|&x| x == 0.125));
    }

    #[test]
    fn engine_kind_labels() {
        assert_eq!(EngineKind::Simple.label(), "simple piano");
        assert_eq!(EngineKind::Modal.label(), "modal piano (physical model)");
        assert_eq!(EngineKind::default(), EngineKind::Simple);
        assert_eq!(ron::from_str::<EngineKind>("Modal"), Ok(EngineKind::Modal));
    }

    fn note_c4() -> Vec<(u64, MidiEvent)> {
        vec![
            (0, MidiEvent::NoteOn { note: 60, velocity: 100 }),
            (300_000, MidiEvent::NoteOff { note: 60 }),
        ]
    }

    fn peak_of(e: &mut AnyEngine, frames: usize) -> f32 {
        let mut l = vec![0.0f32; frames];
        let mut r = vec![0.0f32; frames];
        e.render_stereo(&mut l, &mut r);
        l.iter().chain(r.iter()).fold(0.0f32, |m, s| m.max(s.abs()))
    }

    #[test]
    fn build_engine_picks_the_engine() {
        assert_eq!(build_engine(48000, &SoundProfile::default()).kind(), EngineKind::Simple);
        let modal = SoundProfile::Modal(ModalProfile::default());
        assert_eq!(build_engine(48000, &modal).kind(), EngineKind::Modal);
    }

    #[test]
    fn simple_engine_matches_simple_piano() {
        let events = note_c4();
        let mut a = build_engine(48000, &SoundProfile::Simple(Profile::default()));
        let mut b = SimplePiano::with_profile(48000, &Profile::default());
        let x = render_events_stereo(&mut a, &events, 48000, 0.5);
        let y = render_events_stereo(&mut b, &events, 48000, 0.5);
        assert_eq!(x, y);
    }

    #[test]
    fn mismatched_profile_is_ignored() {
        let events = note_c4();
        let mut a = build_engine(48000, &SoundProfile::Simple(Profile::default()));
        let mut a_twin = build_engine(48000, &SoundProfile::Simple(Profile::default()));
        a.apply_sound_profile(&SoundProfile::Modal(ModalProfile::default()));
        let x = render_events_stereo(&mut a, &events, 48000, 0.5);
        let y = render_events_stereo(&mut a_twin, &events, 48000, 0.5);
        assert_eq!(x, y);

        let mut loud = Profile::default();
        loud.loudness.master_volume = 0.5;
        let mut m = build_engine(48000, &SoundProfile::Modal(ModalProfile::default()));
        let mut m_twin = build_engine(48000, &SoundProfile::Modal(ModalProfile::default()));
        m.apply_sound_profile(&SoundProfile::Simple(loud));
        let x = render_events_stereo(&mut m, &events, 48000, 0.5);
        let y = render_events_stereo(&mut m_twin, &events, 48000, 0.5);
        assert_eq!(x, y);
    }

    #[test]
    fn modal_profile_reaches_modal_engine() {
        let base = ModalProfile::default();
        let mut quiet = base;
        quiet.output.master_volume = 0.5;
        let mut a = build_engine(48000, &SoundProfile::Modal(base));
        let mut b = build_engine(48000, &SoundProfile::Modal(base));
        b.apply_sound_profile(&SoundProfile::Modal(quiet));
        a.handle(&MidiEvent::NoteOn { note: 60, velocity: 100 });
        b.handle(&MidiEvent::NoteOn { note: 60, velocity: 100 });
        peak_of(&mut a, 9600);
        peak_of(&mut b, 9600);
        let pa = peak_of(&mut a, 4800);
        let pb = peak_of(&mut b, 4800);
        let ratio = pb / pa;
        assert!((ratio - 0.5).abs() < 0.03, "ratio {ratio}");
    }
}
