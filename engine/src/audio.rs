//! Audio output via cpal (default host = WASAPI shared on Windows). All cpal code lives in this module, so an ASIO (cpal asio feature, e.g. FlexASIO) or WASAPI-exclusive backend can be added later by changing only this file.

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::BufferSize;

use crate::config::SoundProfile;
use crate::midi::MidiEvent;
use crate::sound::SoundEngine;
use std::sync::mpsc::{sync_channel, Receiver, SyncSender};
use std::sync::{Arc, Mutex, Weak};
use std::time::Instant;

#[cfg(feature = "asio")]
mod asio;
mod extras;
mod wasapi_exclusive;

pub use extras::{Attach, OutputExtras, ATTACH_QUEUE_CAPACITY};

pub const EVENT_QUEUE_CAPACITY: usize = 1024;
pub const PROFILE_QUEUE_CAPACITY: usize = 4;
pub const MAX_CHUNK_FRAMES: usize = 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Backend {
    #[default]
    WasapiShared,
    Asio,
    WasapiExclusive,
}

impl Backend {
    pub const ALL: [Backend; 3] = [Backend::WasapiShared, Backend::Asio, Backend::WasapiExclusive];

    pub fn name(self) -> &'static str {
        match self {
            Backend::WasapiShared => "wasapi",
            Backend::Asio => "asio",
            Backend::WasapiExclusive => "wasapi-exclusive",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Backend::WasapiShared => "WASAPI shared",
            Backend::Asio => "ASIO",
            Backend::WasapiExclusive => "WASAPI exclusive",
        }
    }

    pub fn parse(s: &str) -> Result<Backend, String> {
        let t = s.trim();
        match t.to_lowercase().as_str() {
            "wasapi" | "wasapi-shared" | "shared" => Ok(Backend::WasapiShared),
            "asio" | "flexasio" => Ok(Backend::Asio),
            "wasapi-exclusive" | "exclusive" => Ok(Backend::WasapiExclusive),
            _ => Err(format!(
                "unknown audio backend \"{t}\"; choose wasapi, asio or wasapi-exclusive"
            )),
        }
    }
}

pub const ASIO_BUILD_HINT: &str = "rebuild with the asio feature: in engine/ run $env:LIBCLANG_PATH='C:\\msys64\\ucrt64\\bin'; $env:BINDGEN_EXTRA_CLANG_ARGS='--target=x86_64-pc-windows-msvc'; cargo run --features asio -- --backend asio (see engine/README.md, section ASIO / FlexASIO)";

pub fn check_backend_available(b: Backend) -> Result<(), String> {
    if b == Backend::Asio && !cfg!(feature = "asio") {
        return Err(format!(
            "the asio audio backend is not in this build; {ASIO_BUILD_HINT}"
        ));
    }
    Ok(())
}

#[derive(Debug)]
pub struct AudioSettings {
    pub sample_rate: u32,
    pub buffer_frames: u32,
}

impl Default for AudioSettings {
    fn default() -> Self {
        Self {
            sample_rate: 48000,
            buffer_frames: 256,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutputDeviceInfo {
    pub name: String,
    pub is_default: bool,
}

fn device_name(d: &cpal::Device) -> String {
    d.description()
        .map(|desc| desc.name().to_string())
        .unwrap_or_else(|_| "<unknown>".to_string())
}

fn device_id(d: &cpal::Device) -> Option<String> {
    d.id().ok().map(|id| id.to_string())
}

fn default_flags(
    devices: &[(Option<String>, String)],
    default: Option<&(Option<String>, String)>,
) -> Vec<bool> {
    devices
        .iter()
        .map(|(id, name)| match default {
            None => false,
            Some((default_id, default_name)) => match (id, default_id) {
                (Some(a), Some(b)) => a == b,
                _ => name == default_name,
            },
        })
        .collect()
}

pub fn list_output_devices() -> Result<Vec<OutputDeviceInfo>, String> {
    let host = cpal::default_host();
    let default = host
        .default_output_device()
        .map(|d| (device_id(&d), device_name(&d)));
    let devices = host
        .output_devices()
        .map_err(|e| format!("cannot list audio devices: {e}"))?;
    let list: Vec<(Option<String>, String)> = devices
        .map(|d| (device_id(&d), device_name(&d)))
        .collect();
    let flags = default_flags(&list, default.as_ref());
    Ok(list
        .into_iter()
        .zip(flags)
        .map(|((_, name), is_default)| OutputDeviceInfo { name, is_default })
        .collect())
}

pub struct DeviceSection {
    pub heading: String,
    pub devices: Result<Vec<OutputDeviceInfo>, String>,
}

pub fn section_heading(backend: Backend, selected: Backend) -> String {
    match backend {
        Backend::WasapiShared | Backend::WasapiExclusive => {
            let sel = match selected {
                Backend::WasapiShared => " [selected: wasapi]",
                Backend::WasapiExclusive => " [selected: wasapi-exclusive]",
                Backend::Asio => "",
            };
            format!("Audio output devices (backends wasapi and wasapi-exclusive){sel}:")
        }
        Backend::Asio => {
            let sel = if selected == Backend::Asio {
                " [selected: asio]"
            } else {
                ""
            };
            format!("ASIO drivers (backend asio){sel}:")
        }
    }
}

pub fn list_sections(selected: Backend) -> Vec<DeviceSection> {
    #[cfg(feature = "asio")]
    let asio_devices = asio::list_devices();
    #[cfg(not(feature = "asio"))]
    let asio_devices =
        Err("not in this build; build with --features asio (see engine/README.md)".to_string());
    vec![
        DeviceSection {
            heading: section_heading(Backend::WasapiShared, selected),
            devices: list_output_devices(),
        },
        DeviceSection {
            heading: section_heading(Backend::Asio, selected),
            devices: asio_devices,
        },
    ]
}

/// Output devices (or ASIO drivers) of one backend; WASAPI shared and exclusive share the same list.
pub fn list_backend_devices(backend: Backend) -> Result<Vec<OutputDeviceInfo>, String> {
    match backend {
        Backend::WasapiShared | Backend::WasapiExclusive => list_output_devices(),
        Backend::Asio => {
            #[cfg(feature = "asio")]
            {
                asio::list_devices()
            }
            #[cfg(not(feature = "asio"))]
            {
                Err("not in this build; build with --features asio (see engine/README.md)".to_string())
            }
        }
    }
}

pub fn select_output_device(names: &[String], wanted: &str) -> Result<usize, String> {
    if names.is_empty() {
        return Err("No audio output devices found.".to_string());
    }
    let w = wanted.trim();
    if let Ok(i) = w.parse::<usize>() {
        return if i < names.len() {
            Ok(i)
        } else {
            Err(format!(
                "Audio device index {i} is out of range ({} output devices).",
                names.len()
            ))
        };
    }
    let lower = w.to_lowercase();
    if lower.is_empty() {
        return Err(format!("No audio output device matching \"{w}\" found."));
    }
    names
        .iter()
        .position(|n| n.to_lowercase() == lower)
        .or_else(|| names.iter().position(|n| n.to_lowercase().contains(&lower)))
        .ok_or_else(|| format!("No audio output device matching \"{w}\" found."))
}

pub fn latency_ms(frames: u32, sample_rate: u32) -> f64 {
    if sample_rate == 0 {
        0.0
    } else {
        frames as f64 * 1000.0 / sample_rate as f64
    }
}

pub fn render_interleaved<T>(
    engine: &mut dyn SoundEngine,
    events: &Receiver<MidiEvent>,
    profiles: &Receiver<SoundProfile>,
    left: &mut [f32],
    right: &mut [f32],
    out: &mut [T],
    channels: usize,
) where
    T: cpal::Sample + cpal::FromSample<f32>,
{
    render_core(engine, events, profiles, None, left, right, out, channels);
}

#[allow(clippy::too_many_arguments)] // the audio callback passes its owned pieces separately
pub fn render_interleaved_with<T>(
    engine: &mut dyn SoundEngine,
    events: &Receiver<MidiEvent>,
    profiles: &Receiver<SoundProfile>,
    attach: &Receiver<Attach>,
    extras: &mut OutputExtras,
    left: &mut [f32],
    right: &mut [f32],
    out: &mut [T],
    channels: usize,
) where
    T: cpal::Sample + cpal::FromSample<f32>,
{
    extras.receive(attach);
    render_core(engine, events, profiles, Some(extras), left, right, out, channels);
}

#[allow(clippy::too_many_arguments)]
fn render_core<T>(
    engine: &mut dyn SoundEngine,
    events: &Receiver<MidiEvent>,
    profiles: &Receiver<SoundProfile>,
    mut extras: Option<&mut OutputExtras>,
    left: &mut [f32],
    right: &mut [f32],
    out: &mut [T],
    channels: usize,
) where
    T: cpal::Sample + cpal::FromSample<f32>,
{
    let block_start = match extras.as_deref() {
        Some(x) if !x.is_empty() => Some(Instant::now()),
        _ => None,
    };
    let mut latest = None;
    while let Ok(p) = profiles.try_recv() {
        latest = Some(p);
    }
    if let Some(p) = latest {
        engine.apply_sound_profile(&p);
    }
    while let Ok(ev) = events.try_recv() {
        engine.handle(&ev);
    }
    let max = left.len().min(right.len());
    if max == 0 {
        return;
    }
    let ch = channels.max(1);
    let frames = out.len() / ch;
    let mut done = 0;
    while done < frames {
        let n = (frames - done).min(max);
        engine.render_stereo(&mut left[..n], &mut right[..n]);
        if let (Some(t0), Some(x)) = (block_start, extras.as_deref_mut()) {
            x.process(&mut left[..n], &mut right[..n], t0, done);
        }
        for i in 0..n {
            let (l, r) = (left[i], right[i]);
            let mix = 0.5 * (l + r);
            let base = (done + i) * ch;
            for c in 0..ch {
                let x = if c == 0 && ch > 1 {
                    l
                } else if c == 1 {
                    r
                } else {
                    mix
                };
                out[base + c] = T::from_sample(x);
            }
        }
        done += n;
    }
}

/// Dropping this stops the sound.
type StreamBox = Box<dyn std::any::Any + Send>;

/// The running audio stream; dropping it stops the sound.
pub struct StreamSlot(Arc<Mutex<Option<StreamBox>>>);

impl StreamSlot {
    pub fn new(stream: StreamBox) -> Self {
        StreamSlot(Arc::new(Mutex::new(Some(stream))))
    }

    /// A handle that can stop the stream from another thread without keeping it alive.
    pub fn stopper(&self) -> AudioStopper {
        AudioStopper(Arc::downgrade(&self.0))
    }
}

/// Stops the audio stream early, e.g. from the Ctrl-C handler before the process exits.
#[derive(Clone)]
pub struct AudioStopper(Weak<Mutex<Option<StreamBox>>>);

impl AudioStopper {
    pub fn stop(&self) {
        if let Some(slot) = self.0.upgrade() {
            let stream = slot.lock().unwrap_or_else(|e| e.into_inner()).take();
            drop(stream);
        }
    }
}

pub struct AudioOutput {
    stream: StreamSlot,
    events: SyncSender<MidiEvent>,
    profiles: SyncSender<SoundProfile>,
    attachments: SyncSender<Attach>,
    pub backend: Backend,
    pub device_name: String,
    pub sample_rate: u32,
    pub channels: u16,
    pub sample_format: String,
    pub buffer_frames: Option<u32>,
    pub buffer_note: Option<String>,
}

fn build_stream<T, E>(
    device: &cpal::Device,
    config: cpal::StreamConfig,
    engine: E,
    rx: Receiver<MidiEvent>,
    prx: Receiver<SoundProfile>,
    arx: Receiver<Attach>,
) -> Result<cpal::Stream, cpal::Error>
where
    T: cpal::SizedSample + cpal::FromSample<f32>,
    E: SoundEngine + Send + 'static,
{
    let channels = config.channels as usize;
    let mut engine = engine;
    let mut extras = OutputExtras::default();
    let mut left = vec![0.0f32; MAX_CHUNK_FRAMES];
    let mut right = vec![0.0f32; MAX_CHUNK_FRAMES];
    device.build_output_stream::<T, _, _>(
        config,
        move |data: &mut [T], _: &cpal::OutputCallbackInfo| {
            render_interleaved_with(
                &mut engine,
                &rx,
                &prx,
                &arx,
                &mut extras,
                &mut left,
                &mut right,
                data,
                channels,
            )
        },
        |e: cpal::Error| eprintln!("audio stream error: {e}"),
        None,
    )
}

fn build_any<E>(
    device: &cpal::Device,
    config: cpal::StreamConfig,
    sample_format: cpal::SampleFormat,
    engine: E,
    rx: Receiver<MidiEvent>,
    prx: Receiver<SoundProfile>,
    arx: Receiver<Attach>,
) -> Result<cpal::Stream, String>
where
    E: SoundEngine + Send + 'static,
{
    use cpal::SampleFormat;
    match sample_format {
        SampleFormat::F32 => build_stream::<f32, E>(device, config, engine, rx, prx, arx).map_err(|e| e.to_string()),
        SampleFormat::F64 => build_stream::<f64, E>(device, config, engine, rx, prx, arx).map_err(|e| e.to_string()),
        SampleFormat::I16 => build_stream::<i16, E>(device, config, engine, rx, prx, arx).map_err(|e| e.to_string()),
        SampleFormat::I24 => build_stream::<cpal::I24, E>(device, config, engine, rx, prx, arx).map_err(|e| e.to_string()),
        SampleFormat::I32 => build_stream::<i32, E>(device, config, engine, rx, prx, arx).map_err(|e| e.to_string()),
        SampleFormat::U16 => build_stream::<u16, E>(device, config, engine, rx, prx, arx).map_err(|e| e.to_string()),
        other => Err(format!(
            "unsupported audio sample format {other}; supported: f32, f64, i16, i24, i32, u16"
        )),
    }
}

fn start_shared<E, F>(
    device: Option<&str>,
    buffer_frames: Option<u32>,
    make_engine: F,
) -> Result<AudioOutput, String>
where
    E: SoundEngine + Send + 'static,
    F: Fn(u32) -> E,
{
    let host = cpal::default_host();
    let device = match device {
        None => host
            .default_output_device()
            .ok_or_else(|| "no default audio output device".to_string())?,
        Some(w) => {
            let devices: Vec<cpal::Device> = host
                .output_devices()
                .map_err(|e| format!("cannot list audio devices: {e}"))?
                .collect();
            let names: Vec<String> = devices.iter().map(device_name).collect();
            let i = select_output_device(&names, w)?;
            devices
                .into_iter()
                .nth(i)
                .ok_or_else(|| "No audio output devices found.".to_string())?
        }
    };
    let name = device_name(&device);
    let supported = device
        .default_output_config()
        .map_err(|e| format!("cannot read the default output format of {name}: {e}"))?;
    let sample_format = supported.sample_format();
    let mut config = supported.config();

    let mut built = None;
    let mut buffer_note = None;
    if let Some(n) = buffer_frames {
        config.buffer_size = BufferSize::Fixed(n);
        let (tx, rx) = sync_channel(EVENT_QUEUE_CAPACITY);
        let (ptx, prx) = sync_channel(PROFILE_QUEUE_CAPACITY);
        let (atx, arx) = sync_channel(ATTACH_QUEUE_CAPACITY);
        match build_any(&device, config, sample_format, make_engine(config.sample_rate), rx, prx, arx) {
            Ok(s) => built = Some((s, tx, ptx, atx)),
            Err(e) => {
                buffer_note = Some(format!(
                    "buffer of {n} frames not accepted ({e}); using the device default"
                ));
                config.buffer_size = BufferSize::Default;
            }
        }
    }
    let (stream, tx, ptx, atx) = match built {
        Some(b) => b,
        None => {
            let (tx, rx) = sync_channel(EVENT_QUEUE_CAPACITY);
            let (ptx, prx) = sync_channel(PROFILE_QUEUE_CAPACITY);
            let (atx, arx) = sync_channel(ATTACH_QUEUE_CAPACITY);
            let s = build_any(&device, config, sample_format, make_engine(config.sample_rate), rx, prx, arx)
                .map_err(|e| format!("cannot open audio stream on {name}: {e}"))?;
            (s, tx, ptx, atx)
        }
    };
    stream
        .play()
        .map_err(|e| format!("cannot start audio stream on {name}: {e}"))?;
    Ok(AudioOutput {
        buffer_frames: stream.buffer_size().ok(),
        stream: StreamSlot::new(Box::new(stream)),
        events: tx,
        profiles: ptx,
        attachments: atx,
        backend: Backend::WasapiShared,
        device_name: name,
        sample_rate: config.sample_rate,
        channels: config.channels,
        sample_format: format!("{sample_format}"),
        buffer_note,
    })
}

impl AudioOutput {
    pub fn start<E, F>(
        backend: Backend,
        device: Option<&str>,
        buffer_frames: Option<u32>,
        make_engine: F,
    ) -> Result<AudioOutput, String>
    where
        E: SoundEngine + Send + 'static,
        F: Fn(u32) -> E,
    {
        match backend {
            Backend::WasapiShared => start_shared(device, buffer_frames, make_engine),
            Backend::WasapiExclusive => wasapi_exclusive::start(device, buffer_frames, make_engine),
            Backend::Asio => {
                #[cfg(feature = "asio")]
                {
                    asio::start(device, buffer_frames, make_engine)
                }
                #[cfg(not(feature = "asio"))]
                {
                    let _ = (device, buffer_frames, make_engine);
                    Err(format!(
                        "the asio audio backend is not in this build; {ASIO_BUILD_HINT}"
                    ))
                }
            }
        }
    }

    pub fn sender(&self) -> SyncSender<MidiEvent> {
        self.events.clone()
    }

    pub fn profile_sender(&self) -> SyncSender<SoundProfile> {
        self.profiles.clone()
    }

    pub fn attach(&self, a: Attach) -> bool {
        self.attachments.try_send(a).is_ok()
    }

    pub fn stopper(&self) -> AudioStopper {
        self.stream.stopper()
    }

    pub fn describe(&self) -> String {
        let buf = match self.buffer_frames {
            Some(n) => format!(
                "buffer {n} frames (~{:.1} ms per buffer)",
                latency_ms(n, self.sample_rate)
            ),
            None => "buffer: device default (size unknown)".to_string(),
        };
        format!(
            "Audio output ({}): {} | {} Hz | {} ch | {} | {}",
            self.backend.label(),
            self.device_name,
            self.sample_rate,
            self.channels,
            self.sample_format,
            buf
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Profile;
    use crate::sound::build_engine;
    use crate::sound::modal_piano::ModalProfile;
    use crate::sound::simple_piano::SimplePiano;

    fn names() -> Vec<String> {
        vec![
            "Speakers (Realtek(R) Audio)".to_string(),
            "Headphones (Realtek(R) Audio)".to_string(),
        ]
    }

    #[test]
    fn select_output_device_by_index_and_name() {
        let n = names();
        assert_eq!(select_output_device(&n, "1"), Ok(1));
        assert_eq!(select_output_device(&n, " 0 "), Ok(0));
        assert_eq!(select_output_device(&n, "headph"), Ok(1));
        assert_eq!(select_output_device(&n, "REALTEK"), Ok(0));
    }

    #[test]
    fn select_output_device_prefers_exact_name() {
        let a = vec!["Speakers (USB)".to_string(), "Speakers".to_string()];
        assert_eq!(select_output_device(&a, "speakers"), Ok(1));
        let b = vec!["Speakers".to_string(), "Speakers (USB)".to_string()];
        assert_eq!(select_output_device(&b, "Speakers"), Ok(0));
        assert_eq!(select_output_device(&a, "usb"), Ok(0));
    }

    #[test]
    fn select_output_device_errors() {
        let n = names();
        assert_eq!(
            select_output_device(&[], "0"),
            Err("No audio output devices found.".to_string())
        );
        assert_eq!(
            select_output_device(&n, "5"),
            Err("Audio device index 5 is out of range (2 output devices).".to_string())
        );
        let e = select_output_device(&n, "zz").unwrap_err();
        assert!(e.contains("No audio output device matching"));
    }

    #[test]
    fn latency_ms_math() {
        assert_eq!(latency_ms(480, 48000), 10.0);
        assert_eq!(latency_ms(441, 44100), 10.0);
        assert_eq!(latency_ms(256, 0), 0.0);
    }

    #[test]
    fn render_interleaved_copies_mono_to_all_channels() {
        let mut piano = SimplePiano::new(48000);
        let (tx, rx) = sync_channel(16);
        tx.send(MidiEvent::NoteOn { note: 69, velocity: 100 }).unwrap();
        let (_ptx, prx) = sync_channel::<SoundProfile>(4);
        let mut left = vec![0.0f32; 256];
        let mut right = vec![0.0f32; 256];
        let mut out = vec![0.0f32; 2 * 1000];
        render_interleaved(&mut piano, &rx, &prx, &mut left, &mut right, &mut out, 2);
        assert!(out.chunks(2).all(|f| f[0] == f[1]));
        assert!(out.iter().any(|s| s.abs() > 0.01));
        assert!(out.iter().all(|s| s.abs() <= 1.0));
    }

    #[test]
    fn render_interleaved_converts_to_i16() {
        let mut piano = SimplePiano::new(48000);
        let (tx, rx) = sync_channel(16);
        tx.send(MidiEvent::NoteOn { note: 69, velocity: 127 }).unwrap();
        let (_ptx, prx) = sync_channel::<SoundProfile>(4);
        let mut left = vec![0.0f32; 256];
        let mut right = vec![0.0f32; 256];
        let mut out = vec![0i16; 2 * 2000];
        render_interleaved(&mut piano, &rx, &prx, &mut left, &mut right, &mut out, 2);
        assert!(out.chunks(2).all(|f| f[0] == f[1]));
        assert!(out.iter().any(|s| s.abs() > 1000));
    }

    #[test]
    fn render_interleaved_converts_to_i24() {
        let mut piano = SimplePiano::new(48000);
        let (tx, rx) = sync_channel(16);
        tx.send(MidiEvent::NoteOn { note: 69, velocity: 127 }).unwrap();
        let (_ptx, prx) = sync_channel::<SoundProfile>(4);
        let mut left = vec![0.0f32; 256];
        let mut right = vec![0.0f32; 256];
        let mut out = vec![cpal::I24::new(0).unwrap(); 2 * 2000];
        render_interleaved(&mut piano, &rx, &prx, &mut left, &mut right, &mut out, 2);
        assert!(out.chunks(2).all(|f| f[0] == f[1]));
        assert!(out.iter().any(|s| s.inner().abs() > 100000));
    }

    #[test]
    fn render_interleaved_u16_silence_is_midpoint() {
        let mut piano = SimplePiano::new(48000);
        let (_tx, rx) = sync_channel::<MidiEvent>(16);
        let (_ptx, prx) = sync_channel::<SoundProfile>(4);
        let mut left = vec![0.0f32; 128];
        let mut right = vec![0.0f32; 128];
        let mut out = vec![0u16; 2 * 300];
        render_interleaved(&mut piano, &rx, &prx, &mut left, &mut right, &mut out, 2);
        assert!(out.iter().all(|s| *s == 32768));
    }

    fn peak_after(piano: &mut SimplePiano, profiles: &[Profile]) -> f32 {
        let (tx, rx) = sync_channel(16);
        let (ptx, prx) = sync_channel::<SoundProfile>(4);
        for p in profiles {
            ptx.send(SoundProfile::Simple(*p)).unwrap();
        }
        tx.send(MidiEvent::NoteOn { note: 69, velocity: 100 }).unwrap();
        let mut left = vec![0.0f32; 256];
        let mut right = vec![0.0f32; 256];
        let mut out = vec![0.0f32; 2 * 2000];
        render_interleaved(piano, &rx, &prx, &mut left, &mut right, &mut out, 2);
        out.iter().fold(0.0f32, |m, s| m.max(s.abs()))
    }

    #[test]
    fn render_interleaved_applies_latest_profile() {
        let mut a = SimplePiano::new(48000);
        let mut b = SimplePiano::new(48000);
        let mut p1 = Profile::default();
        p1.loudness.voice_gain = 0.9;
        let mut p2 = Profile::default();
        p2.loudness.voice_gain = 0.6;
        let pa = peak_after(&mut a, &[]);
        let pb = peak_after(&mut b, &[p1, p2]);
        let r = pb / pa;
        assert!((1.95..=2.05).contains(&r), "ratio {r}");
    }

    #[test]
    fn render_interleaved_without_profile_keeps_default() {
        let mut piano = SimplePiano::new(48000);
        peak_after(&mut piano, &[]);
        assert_eq!(piano.profile(), &Profile::default());
    }

    struct Split;

    impl SoundEngine for Split {
        fn handle(&mut self, _ev: &MidiEvent) {}

        fn render_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
            left.fill(0.5);
            right.fill(-0.25);
        }
    }

    fn split_out(channels: usize) -> Vec<f32> {
        let (_tx, rx) = sync_channel::<MidiEvent>(4);
        let (_ptx, prx) = sync_channel::<SoundProfile>(4);
        let mut left = vec![0.0f32; 256];
        let mut right = vec![0.0f32; 256];
        let mut out = vec![0.0f32; channels * 4];
        render_interleaved(&mut Split, &rx, &prx, &mut left, &mut right, &mut out, channels);
        out
    }

    struct Silent;

    impl SoundEngine for Silent {
        fn handle(&mut self, _ev: &MidiEvent) {}

        fn render_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
            left.fill(0.0);
            right.fill(0.0);
        }
    }

    #[test]
    fn render_with_metronome_clicks() {
        use crate::metronome::{MetronomeHandle, MetronomeSettings, Notice};
        let handle = MetronomeHandle::new(MetronomeSettings {
            on: true,
            bpm: 120,
            beats_per_bar: 4,
            volume: 100,
        });
        let (m, notices) = handle.attach(48000);
        handle.confirm_attached();
        let (atx, arx) = sync_channel(ATTACH_QUEUE_CAPACITY);
        atx.send(Attach::Metronome(Box::new(m))).unwrap();
        let (_tx, rx) = sync_channel::<MidiEvent>(4);
        let (_ptx, prx) = sync_channel::<SoundProfile>(4);
        let mut extras = OutputExtras::default();
        let mut left = vec![0.0f32; MAX_CHUNK_FRAMES];
        let mut right = vec![0.0f32; MAX_CHUNK_FRAMES];
        let loud = |out: &[f32], a: usize, b: usize| out[2 * a..2 * b].iter().any(|s| s.abs() > 0.01);
        let quiet = |out: &[f32], a: usize, b: usize| out[2 * a..2 * b].iter().all(|s| *s == 0.0);

        let mut out = vec![0.0f32; 2 * 30000];
        render_interleaved_with(&mut Silent, &rx, &prx, &arx, &mut extras, &mut left, &mut right, &mut out, 2);
        assert!(loud(&out, 0, 100));
        assert!(loud(&out, 24000, 24100));
        assert!(quiet(&out, 2000, 23000));
        assert!(out.chunks(2).all(|f| f[0] == f[1]));

        let mut out = vec![0.0f32; 2 * 30000];
        render_interleaved_with(&mut Silent, &rx, &prx, &arx, &mut extras, &mut left, &mut right, &mut out, 2);
        assert!(loud(&out, 18000, 18100));
        assert!(quiet(&out, 0, 10000));
        assert!(out.chunks(2).all(|f| f[0] == f[1]));

        let ticks: Vec<_> = notices
            .try_iter()
            .filter_map(|n| match n {
                Notice::Tick(t) => Some(t),
                _ => None,
            })
            .collect();
        assert_eq!(ticks.len(), 3);
        assert_eq!(ticks.iter().map(|t| t.beat).collect::<Vec<_>>(), vec![1, 2, 3]);
        let gap = ticks[1].at.duration_since(ticks[0].at).as_secs_f64() * 1000.0;
        assert!((gap - 500.0).abs() < 1.0, "gap {gap}");
    }

    #[test]
    fn render_with_empty_extras_matches_plain() {
        let (_tx, rx) = sync_channel::<MidiEvent>(4);
        let (_ptx, prx) = sync_channel::<SoundProfile>(4);
        let (_atx, arx) = sync_channel::<Attach>(ATTACH_QUEUE_CAPACITY);
        let mut extras = OutputExtras::default();
        let mut left = vec![0.0f32; 256];
        let mut right = vec![0.0f32; 256];
        let mut with = vec![0.0f32; 2 * 1000];
        render_interleaved_with(&mut Split, &rx, &prx, &arx, &mut extras, &mut left, &mut right, &mut with, 2);
        let mut plain = vec![0.0f32; 2 * 1000];
        render_interleaved(&mut Split, &rx, &prx, &mut left, &mut right, &mut plain, 2);
        assert_eq!(with, plain);
    }

    #[test]
    fn render_interleaved_maps_left_and_right() {
        let out = split_out(2);
        for f in out.chunks(2) {
            assert_eq!(f, &[0.5f32, -0.25][..]);
        }
    }

    #[test]
    fn render_interleaved_mono_device_gets_mix() {
        let out = split_out(1);
        assert!(out.iter().all(|&s| s == 0.125));
    }

    #[test]
    fn render_interleaved_extra_channels_get_mix() {
        let out = split_out(4);
        for f in out.chunks(4) {
            assert_eq!(f, &[0.5f32, -0.25, 0.125, 0.125][..]);
        }
    }

    #[test]
    fn render_interleaved_routes_modal_profile() {
        let base = ModalProfile::default();
        let mut quiet = base;
        quiet.output.master_volume = 0.5;
        let mut peaks = Vec::new();
        for profile in [None, Some(SoundProfile::Modal(quiet))] {
            let mut engine = build_engine(48000, &SoundProfile::Modal(base));
            let (tx, rx) = sync_channel(16);
            let (ptx, prx) = sync_channel::<SoundProfile>(4);
            tx.send(MidiEvent::NoteOn { note: 60, velocity: 100 }).unwrap();
            if let Some(p) = profile {
                ptx.send(p).unwrap();
            }
            let mut left = vec![0.0f32; MAX_CHUNK_FRAMES];
            let mut right = vec![0.0f32; MAX_CHUNK_FRAMES];
            let mut out = vec![0.0f32; 2 * 4800];
            render_interleaved(&mut engine, &rx, &prx, &mut left, &mut right, &mut out, 2);
            let tail = &out[2 * 2800..];
            peaks.push(tail.iter().fold(0.0f32, |m, s| m.max(s.abs())));
        }
        let ratio = peaks[1] / peaks[0];
        assert!((ratio - 0.5).abs() < 0.03, "ratio {ratio}");
    }

    #[test]
    fn default_flags_match_by_id() {
        let devices = vec![
            (Some("a".to_string()), "Speakers".to_string()),
            (Some("b".to_string()), "Speakers".to_string()),
        ];
        let default = (Some("b".to_string()), "Speakers".to_string());
        assert_eq!(default_flags(&devices, Some(&default)), vec![false, true]);
    }

    #[test]
    fn default_flags_fall_back_to_name() {
        let devices = vec![
            (None, "Speakers".to_string()),
            (None, "Headphones".to_string()),
        ];
        let default = (None, "Headphones".to_string());
        assert_eq!(default_flags(&devices, Some(&default)), vec![false, true]);
    }

    #[test]
    fn default_flags_none_default() {
        let devices = vec![
            (Some("a".to_string()), "Speakers".to_string()),
            (None, "Headphones".to_string()),
        ];
        assert_eq!(default_flags(&devices, None), vec![false, false]);
    }

    #[test]
    fn backend_parse_names_and_aliases() {
        let cases = [
            ("wasapi", Backend::WasapiShared),
            (" WASAPI-Shared ", Backend::WasapiShared),
            ("shared", Backend::WasapiShared),
            ("asio", Backend::Asio),
            (" FlexASIO ", Backend::Asio),
            ("wasapi-exclusive", Backend::WasapiExclusive),
            ("Exclusive", Backend::WasapiExclusive),
        ];
        for (text, want) in cases {
            assert_eq!(Backend::parse(text), Ok(want), "{text}");
        }
    }

    #[test]
    fn backend_parse_unknown_is_error() {
        assert_eq!(
            Backend::parse(" asoi "),
            Err("unknown audio backend \"asoi\"; choose wasapi, asio or wasapi-exclusive".to_string())
        );
    }

    #[test]
    fn backend_name_round_trips() {
        for b in Backend::ALL {
            assert_eq!(Backend::parse(b.name()), Ok(b));
        }
    }

    #[test]
    fn asio_availability_follows_feature() {
        let r = check_backend_available(Backend::Asio);
        assert_eq!(r.is_ok(), cfg!(feature = "asio"));
        if let Err(e) = r {
            assert!(e.contains("--features asio"), "{e}");
            assert!(e.contains("LIBCLANG_PATH"), "{e}");
            assert!(e.contains("BINDGEN_EXTRA_CLANG_ARGS"), "{e}");
        }
    }

    #[test]
    fn wasapi_backends_are_always_available() {
        assert!(check_backend_available(Backend::WasapiShared).is_ok());
        assert!(check_backend_available(Backend::WasapiExclusive).is_ok());
    }

    #[test]
    fn section_headings() {
        assert_eq!(
            section_heading(Backend::WasapiShared, Backend::WasapiShared),
            "Audio output devices (backends wasapi and wasapi-exclusive) [selected: wasapi]:"
        );
        assert_eq!(
            section_heading(Backend::WasapiShared, Backend::WasapiExclusive),
            "Audio output devices (backends wasapi and wasapi-exclusive) [selected: wasapi-exclusive]:"
        );
        assert_eq!(
            section_heading(Backend::WasapiShared, Backend::Asio),
            "Audio output devices (backends wasapi and wasapi-exclusive):"
        );
        assert_eq!(
            section_heading(Backend::Asio, Backend::Asio),
            "ASIO drivers (backend asio) [selected: asio]:"
        );
        assert_eq!(
            section_heading(Backend::Asio, Backend::WasapiShared),
            "ASIO drivers (backend asio):"
        );
    }

    #[test]
    fn describe_names_the_backend() {
        let (events, _rx) = sync_channel(1);
        let (profiles, _prx) = sync_channel(1);
        let (attachments, _arx) = sync_channel(1);
        let out = AudioOutput {
            stream: StreamSlot::new(Box::new(())),
            events,
            profiles,
            attachments,
            backend: Backend::Asio,
            device_name: "FlexASIO".to_string(),
            sample_rate: 48000,
            channels: 2,
            sample_format: "f32".to_string(),
            buffer_frames: Some(64),
            buffer_note: None,
        };
        assert!(out
            .describe()
            .starts_with("Audio output (ASIO): FlexASIO | 48000 Hz | 2 ch | f32 | buffer 64 frames"));
    }
}
