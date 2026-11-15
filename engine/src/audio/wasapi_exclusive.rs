//! WASAPI exclusive-mode backend via the wasapi crate; all COM objects live on one audio thread.

use super::{
    render_interleaved_with, select_output_device, Attach, AudioOutput, Backend, OutputExtras,
    ATTACH_QUEUE_CAPACITY, EVENT_QUEUE_CAPACITY, MAX_CHUNK_FRAMES, PROFILE_QUEUE_CAPACITY,
};
use crate::config::SoundProfile;
use crate::midi::MidiEvent;
use crate::sound::SoundEngine;
use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, sync_channel, Receiver, Sender};
use std::sync::Arc;
use std::thread::JoinHandle;
use wasapi::{
    calculate_period_100ns, initialize_mta, AudioClient, AudioRenderClient, DeviceEnumerator,
    Direction, Handle, SampleType, ShareMode, StreamMode, WasapiError, WaveFormat,
};

const LOCK_NOTE: &str =
    "WASAPI exclusive: other apps cannot play sound on this device while the engine runs";
const STOPPED: &str = "the WASAPI exclusive audio thread stopped unexpectedly";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SampleKind {
    F32,
    I32,
    I24In32,
    I24Packed,
    I16,
}

impl SampleKind {
    const ALL: [SampleKind; 5] = [
        SampleKind::F32,
        SampleKind::I32,
        SampleKind::I24In32,
        SampleKind::I24Packed,
        SampleKind::I16,
    ];

    fn store_bits(self) -> usize {
        match self {
            SampleKind::F32 | SampleKind::I32 | SampleKind::I24In32 => 32,
            SampleKind::I24Packed => 24,
            SampleKind::I16 => 16,
        }
    }

    fn valid_bits(self) -> usize {
        match self {
            SampleKind::F32 | SampleKind::I32 => 32,
            SampleKind::I24In32 | SampleKind::I24Packed => 24,
            SampleKind::I16 => 16,
        }
    }

    fn bytes(self) -> usize {
        self.store_bits() / 8
    }

    fn sample_type(self) -> SampleType {
        match self {
            SampleKind::F32 => SampleType::Float,
            _ => SampleType::Int,
        }
    }

    fn label(self) -> &'static str {
        match self {
            SampleKind::F32 => "f32",
            SampleKind::I32 => "i32",
            SampleKind::I24In32 => "i24 in 32-bit",
            SampleKind::I24Packed => "i24 packed",
            SampleKind::I16 => "i16",
        }
    }
}

fn format_candidates(
    device_rate: Option<u32>,
    device_channels: Option<u16>,
) -> Vec<(u32, u16, SampleKind)> {
    let mut rates: Vec<u32> = Vec::new();
    for r in [device_rate.filter(|&r| r > 0), Some(48000), Some(44100)]
        .into_iter()
        .flatten()
    {
        if !rates.contains(&r) {
            rates.push(r);
        }
    }
    let mut channels: Vec<u16> = Vec::new();
    for c in [device_channels.filter(|&c| c >= 1), Some(2)]
        .into_iter()
        .flatten()
    {
        if !channels.contains(&c) {
            channels.push(c);
        }
    }
    let mut out = Vec::new();
    for &rate in &rates {
        for &ch in &channels {
            for kind in SampleKind::ALL {
                out.push((rate, ch, kind));
            }
        }
    }
    out
}

fn encode(kind: SampleKind, src: &[f32], dst: &mut [u8]) {
    for (out, &x) in dst.chunks_exact_mut(kind.bytes()).zip(src) {
        let x = if x.is_nan() { 0.0 } else { x.clamp(-1.0, 1.0) };
        match kind {
            SampleKind::F32 => out.copy_from_slice(&x.to_le_bytes()),
            SampleKind::I16 => out.copy_from_slice(&((x * 32767.0).round() as i16).to_le_bytes()),
            SampleKind::I32 => {
                out.copy_from_slice(&((x as f64 * 2147483647.0).round() as i32).to_le_bytes())
            }
            SampleKind::I24In32 => {
                out.copy_from_slice(&(((x * 8388607.0).round() as i32) << 8).to_le_bytes())
            }
            SampleKind::I24Packed => {
                let v = ((x * 8388607.0).round() as i32).to_le_bytes();
                out.copy_from_slice(&v[..3]);
            }
        }
    }
}

fn explain_hresult(code: u32) -> Option<&'static str> {
    match code {
        0x8889000A => Some("the device is already used by another app in exclusive mode; close that app or pick another --audio-device"),
        0x8889000E => Some("Windows does not allow exclusive mode on this device: Sound settings > More sound settings > the device > Properties > Advanced > tick 'Allow applications to take exclusive control of this device'"),
        0x88890008 => Some("the device does not accept this sample format in exclusive mode"),
        0x88890020 | 0x88890016 => Some("the device does not support this buffer size; try another --buffer or none"),
        0x8889000F => Some("Windows could not open the device (unplugged or driver problem)"),
        _ => None,
    }
}

fn hresult(e: &WasapiError) -> Option<u32> {
    match e {
        WasapiError::Windows(w) => Some(w.code().0 as u32),
        _ => None,
    }
}

fn describe_error(e: &WasapiError) -> String {
    match hresult(e).and_then(explain_hresult) {
        Some(hint) => format!("{e}; {hint}"),
        None => e.to_string(),
    }
}

fn open_error(what: &str, e: &WasapiError) -> String {
    format!("cannot open {what} in exclusive mode: {}", describe_error(e))
}

#[link(name = "avrt")]
extern "system" {
    fn AvSetMmThreadCharacteristicsW(task_name: *const u16, task_index: *mut u32) -> *mut c_void;
    fn AvRevertMmThreadCharacteristics(handle: *mut c_void) -> i32;
}

fn boost_thread() -> *mut c_void {
    let task: Vec<u16> = "Pro Audio\0".encode_utf16().collect();
    let mut idx: u32 = 0;
    // SAFETY: task is a NUL-terminated UTF-16 string and idx is a valid out pointer for the call.
    unsafe { AvSetMmThreadCharacteristicsW(task.as_ptr(), &mut idx) }
}

fn revert_thread(handle: *mut c_void) {
    if !handle.is_null() {
        // SAFETY: the handle was returned by AvSetMmThreadCharacteristicsW on this thread.
        unsafe {
            AvRevertMmThreadCharacteristics(handle);
        }
    }
}

#[derive(Clone)]
struct Negotiated {
    device_name: String,
    sample_rate: u32,
    channels: u16,
    kind: SampleKind,
    buffer_frames: u32,
    note: Option<String>,
}

struct Opened {
    n: Negotiated,
    client: AudioClient,
    render: AudioRenderClient,
    event: Handle,
    blockalign: usize,
}

fn open(device: Option<&str>, buffer_frames: Option<u32>) -> Result<Opened, String> {
    let enumerator = DeviceEnumerator::new().map_err(|e| open_error("the WASAPI device", &e))?;
    let dev = match device {
        None => enumerator
            .get_default_device(&Direction::Render)
            .map_err(|e| open_error("the WASAPI device", &e))?,
        Some(w) => {
            let coll = enumerator
                .get_device_collection(&Direction::Render)
                .map_err(|e| open_error("the WASAPI device", &e))?;
            let count = coll
                .get_nbr_devices()
                .map_err(|e| open_error("the WASAPI device", &e))?;
            let names: Vec<String> = (0..count)
                .map(|i| {
                    coll.get_device_at_index(i)
                        .and_then(|d| d.get_friendlyname())
                        .unwrap_or_else(|_| "<unknown>".to_string())
                })
                .collect();
            let i = select_output_device(&names, w)?;
            coll.get_device_at_index(i as u32)
                .map_err(|e| open_error("the WASAPI device", &e))?
        }
    };
    let name = dev
        .get_friendlyname()
        .unwrap_or_else(|_| "<unknown>".to_string());
    let mut client = dev
        .get_iaudioclient()
        .map_err(|e| open_error(&name, &e))?;

    let mix = dev.get_device_format().ok();
    let dev_rate = mix.as_ref().map(|f| f.get_samplespersec());
    let dev_channels = mix.as_ref().map(|f| f.get_nchannels());
    let mut why: Option<WasapiError> = None;
    let found = format_candidates(dev_rate, dev_channels)
        .into_iter()
        .find_map(|(rate, ch, kind)| {
            let wf = WaveFormat::new(
                kind.store_bits(),
                kind.valid_bits(),
                &kind.sample_type(),
                rate as usize,
                ch as usize,
                None,
            );
            match client.is_supported_exclusive_with_quirks(&wf) {
                Ok(f) => Some((f, rate, ch, kind)),
                Err(_) => {
                    if why.is_none() {
                        why = client.is_supported(&wf, &ShareMode::Exclusive).err();
                    }
                    None
                }
            }
        });
    let (fmt, rate, ch, kind) = found.ok_or_else(|| {
        let base = format!("{name} accepts none of the tried formats in exclusive mode (f32, i32, i24, i16 at the device rate, 48000 or 44100 Hz); try --backend wasapi or --backend asio");
        match &why {
            Some(e) => format!("{base}: {}", describe_error(e)),
            None => base,
        }
    })?;

    let (_def_period, min_period) = client
        .get_device_period()
        .map_err(|e| open_error(&name, &e))?;
    let desired = match buffer_frames {
        Some(n) => calculate_period_100ns(n as i64, rate as i64),
        None => min_period,
    };
    let mut period = client
        .calculate_aligned_period_near(desired, Some(128), &fmt)
        .map_err(|e| open_error(&name, &e))?;
    if let Err(e) = client.initialize_client(
        &fmt,
        &Direction::Render,
        &StreamMode::EventsExclusive { period_hns: period },
    ) {
        if hresult(&e) != Some(0x88890019) {
            return Err(open_error(&name, &e));
        }
        let frames = client.get_buffer_size().map_err(|e| open_error(&name, &e))?;
        period = calculate_period_100ns(frames as i64, rate as i64);
        client = dev
            .get_iaudioclient()
            .map_err(|e| open_error(&name, &e))?;
        client
            .initialize_client(
                &fmt,
                &Direction::Render,
                &StreamMode::EventsExclusive { period_hns: period },
            )
            .map_err(|e| open_error(&name, &e))?;
    }

    let event = client
        .set_get_eventhandle()
        .map_err(|e| open_error(&name, &e))?;
    let render = client
        .get_audiorenderclient()
        .map_err(|e| open_error(&name, &e))?;
    let buffer = client.get_buffer_size().map_err(|e| open_error(&name, &e))?;
    let note = match buffer_frames {
        Some(n) if n != buffer => Some(format!(
            "asked for {n} frames; the device uses {buffer} frames in exclusive mode"
        )),
        _ => None,
    };
    Ok(Opened {
        n: Negotiated {
            device_name: name,
            sample_rate: rate,
            channels: ch,
            kind,
            buffer_frames: buffer,
            note,
        },
        client,
        render,
        event,
        blockalign: fmt.get_blockalign() as usize,
    })
}

fn prime(o: &Opened) -> Result<(), String> {
    let silence = vec![0u8; o.n.buffer_frames as usize * o.blockalign];
    o.render
        .write_to_device(o.n.buffer_frames as usize, &silence, None)
        .and_then(|_| o.client.start_stream())
        .map_err(|e| {
            format!(
                "cannot start {} in exclusive mode: {}",
                o.n.device_name,
                describe_error(&e)
            )
        })
}

fn render_loop(
    o: &Opened,
    engine: &mut dyn SoundEngine,
    events: &Receiver<MidiEvent>,
    profiles: &Receiver<SoundProfile>,
    attach: &Receiver<Attach>,
    stop: &AtomicBool,
) {
    let mut extras = OutputExtras::default();
    let kind = o.n.kind;
    let ch = o.n.channels as usize;
    let buffer = o.n.buffer_frames as usize;
    let mut fbuf = vec![0f32; buffer * ch];
    let mut bytes = vec![0u8; buffer * o.blockalign];
    let mut left = vec![0f32; MAX_CHUNK_FRAMES];
    let mut right = vec![0f32; MAX_CHUNK_FRAMES];
    while !stop.load(Ordering::Acquire) {
        if o.event.wait_for_event(1000).is_err() {
            eprintln!("audio stream error: WASAPI exclusive: the device stopped asking for audio; sound stopped");
            break;
        }
        let n = match o.client.get_available_space_in_frames() {
            Ok(n) => (n as usize).min(buffer),
            Err(e) => {
                eprintln!("audio stream error: {e}");
                break;
            }
        };
        let s = n * ch;
        render_interleaved_with(
            engine,
            events,
            profiles,
            attach,
            &mut extras,
            &mut left,
            &mut right,
            &mut fbuf[..s],
            ch,
        );
        let len = n * o.blockalign;
        encode(kind, &fbuf[..s], &mut bytes[..len]);
        if let Err(e) = o.render.write_to_device(n, &bytes[..len], None) {
            eprintln!("audio stream error: {e}");
            break;
        }
    }
}

type Go<E> = (E, Receiver<MidiEvent>, Receiver<SoundProfile>, Receiver<Attach>);

fn audio_thread<E>(
    device: Option<String>,
    buffer_frames: Option<u32>,
    info: Sender<Result<Negotiated, String>>,
    started: Sender<Result<(), String>>,
    go: Receiver<Go<E>>,
    stop: Arc<AtomicBool>,
) where
    E: SoundEngine + Send + 'static,
{
    let _ = initialize_mta();
    let mmcss = boost_thread();
    match open(device.as_deref(), buffer_frames) {
        Err(e) => {
            let _ = info.send(Err(e));
        }
        Ok(o) => {
            let _ = info.send(Ok(o.n.clone()));
            if let Ok((mut engine, rx, prx, arx)) = go.recv() {
                match prime(&o) {
                    Ok(()) => {
                        let _ = started.send(Ok(()));
                        render_loop(&o, &mut engine, &rx, &prx, &arx, &stop);
                        let _ = o.client.stop_stream();
                    }
                    Err(e) => {
                        let _ = started.send(Err(e));
                    }
                }
            }
        }
    }
    revert_thread(mmcss);
}

struct ExclusiveStream {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Drop for ExclusiveStream {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

pub(super) fn start<E, F>(
    device: Option<&str>,
    buffer_frames: Option<u32>,
    make_engine: F,
) -> Result<AudioOutput, String>
where
    E: SoundEngine + Send + 'static,
    F: Fn(u32) -> E,
{
    let (info_tx, info_rx) = channel::<Result<Negotiated, String>>();
    let (started_tx, started_rx) = channel::<Result<(), String>>();
    let (go_tx, go_rx) = channel::<Go<E>>();
    let stop = Arc::new(AtomicBool::new(false));
    let thread_stop = stop.clone();
    let device = device.map(str::to_string);
    let thread = std::thread::Builder::new()
        .name("wasapi-exclusive".to_string())
        .spawn(move || {
            audio_thread::<E>(device, buffer_frames, info_tx, started_tx, go_rx, thread_stop)
        })
        .map_err(|e| format!("cannot start the WASAPI exclusive audio thread: {e}"))?;

    let n = match info_rx.recv() {
        Ok(Ok(n)) => n,
        Ok(Err(e)) => {
            let _ = thread.join();
            return Err(e);
        }
        Err(_) => {
            let _ = thread.join();
            return Err(STOPPED.to_string());
        }
    };
    let engine = make_engine(n.sample_rate);
    let (tx, rx) = sync_channel(EVENT_QUEUE_CAPACITY);
    let (ptx, prx) = sync_channel(PROFILE_QUEUE_CAPACITY);
    let (atx, arx) = sync_channel(ATTACH_QUEUE_CAPACITY);
    let ready = match go_tx.send((engine, rx, prx, arx)) {
        Ok(()) => started_rx.recv().unwrap_or(Err(STOPPED.to_string())),
        Err(_) => Err(STOPPED.to_string()),
    };
    if let Err(e) = ready {
        let _ = thread.join();
        return Err(e);
    }
    Ok(AudioOutput {
        _stream: Box::new(ExclusiveStream {
            stop,
            thread: Some(thread),
        }),
        events: tx,
        profiles: ptx,
        attachments: atx,
        backend: Backend::WasapiExclusive,
        device_name: n.device_name,
        sample_rate: n.sample_rate,
        channels: n.channels,
        sample_format: n.kind.label().to_string(),
        buffer_frames: Some(n.buffer_frames),
        buffer_note: Some(match n.note {
            Some(note) => format!("{note}; {LOCK_NOTE}"),
            None => LOCK_NOTE.to_string(),
        }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_candidates_with_device_format() {
        let c = format_candidates(Some(48000), Some(2));
        assert_eq!(c.len(), 10);
        assert_eq!(c[0], (48000, 2, SampleKind::F32));
        assert_eq!(c[9], (44100, 2, SampleKind::I16));
    }

    #[test]
    fn format_candidates_without_device_format() {
        let c = format_candidates(None, None);
        assert_eq!(c.len(), 10);
        assert_eq!(c[0].0, 48000);
    }

    #[test]
    fn format_candidates_multichannel_device() {
        let c = format_candidates(Some(96000), Some(6));
        assert_eq!(c.len(), 30);
        assert_eq!(c[0], (96000, 6, SampleKind::F32));
        assert!(c.contains(&(44100, 2, SampleKind::I16)));
    }

    #[test]
    fn encode_converts_each_kind() {
        let mut f = [0u8; 4];
        encode(SampleKind::F32, &[0.5], &mut f);
        assert_eq!(f, 0.5f32.to_le_bytes());

        let mut s = [0u8; 2];
        encode(SampleKind::I16, &[1.0], &mut s);
        assert_eq!(s, [0xFF, 0x7F]);
        encode(SampleKind::I16, &[-1.0], &mut s);
        assert_eq!(s, (-32767i16).to_le_bytes());
        encode(SampleKind::I16, &[2.0], &mut s);
        assert_eq!(s, [0xFF, 0x7F]);
        encode(SampleKind::I16, &[f32::NAN], &mut s);
        assert_eq!(s, [0, 0]);

        let mut p = [0u8; 3];
        encode(SampleKind::I24Packed, &[1.0], &mut p);
        assert_eq!(p, [0xFF, 0xFF, 0x7F]);

        let mut q = [0u8; 4];
        encode(SampleKind::I24In32, &[1.0], &mut q);
        assert_eq!(q, [0x00, 0xFF, 0xFF, 0x7F]);
        encode(SampleKind::I32, &[0.0], &mut q);
        assert_eq!(q, [0; 4]);

        let mut st = [0u8; 12];
        encode(SampleKind::I16, &[1.0, -1.0, 0.5, 0.5, 0.0, 0.0], &mut st);
        assert_eq!(&st[..4], &[0xFF, 0x7F, 0x01, 0x80]);
    }

    #[test]
    fn explain_hresult_hints() {
        assert!(explain_hresult(0x8889000A).unwrap().contains("another app"));
        assert!(explain_hresult(0x8889000E)
            .unwrap()
            .contains("Allow applications"));
        assert_eq!(explain_hresult(0x12345678), None);
    }
}
