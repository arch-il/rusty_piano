//! ASIO backend (e.g. FlexASIO) through cpal's asio host; compiled only with the asio cargo feature.

use super::{
    build_any, device_name, select_output_device, AudioOutput, Backend, OutputDeviceInfo,
    ATTACH_QUEUE_CAPACITY, EVENT_QUEUE_CAPACITY, PROFILE_QUEUE_CAPACITY,
};
use crate::sound::SoundEngine;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{BufferSize, SupportedBufferSize};
use std::sync::mpsc::sync_channel;

const NO_ASIO_DRIVERS: &str = "No ASIO drivers found. Install FlexASIO (https://github.com/dechamps/FlexASIO/releases), then check with --list --backend asio.";
const FLEXASIO_BUFFER_TIP: &str = "for FlexASIO, change bufferSizeSamples in %USERPROFILE%\\FlexASIO.toml and restart the engine";

fn default_asio_index(names: &[String]) -> Option<usize> {
    if let Some(i) = names
        .iter()
        .position(|n| n.to_lowercase().contains("flexasio"))
    {
        return Some(i);
    }
    if names.is_empty() {
        None
    } else {
        Some(0)
    }
}

fn pick_sample_rate(current: u32, supported: &[u32]) -> Option<u32> {
    if current > 0 {
        return Some(current);
    }
    [48000, 44100]
        .into_iter()
        .find(|r| supported.contains(r))
        .or_else(|| supported.first().copied())
}

fn output_channels(device_channels: u16) -> u16 {
    device_channels.clamp(1, 2)
}

fn buffer_plan(requested: Option<u32>, range: Option<(u32, u32)>) -> (BufferSize, Option<String>) {
    match (requested, range) {
        (None, _) => (BufferSize::Default, None),
        (Some(n), Some((min, max))) => {
            if (min..=max).contains(&n) {
                (BufferSize::Fixed(n), None)
            } else {
                (
                    BufferSize::Default,
                    Some(format!(
                        "buffer of {n} frames is outside the ASIO driver's range {min}-{max} frames; using the driver's own size ({FLEXASIO_BUFFER_TIP})"
                    )),
                )
            }
        }
        (Some(n), None) => (BufferSize::Fixed(n), None),
    }
}

fn asio_host() -> Result<cpal::Host, String> {
    cpal::host_from_id(cpal::HostId::Asio).map_err(|e| format!("cannot open the ASIO host: {e}"))
}

fn asio_devices(host: &cpal::Host) -> Result<Vec<cpal::Device>, String> {
    host.output_devices()
        .map(|devices| devices.collect())
        .map_err(|e| format!("cannot list ASIO drivers: {e}"))
}

pub(super) fn list_devices() -> Result<Vec<OutputDeviceInfo>, String> {
    let devices = asio_devices(&asio_host()?)?;
    let names: Vec<String> = devices.iter().map(device_name).collect();
    let default = default_asio_index(&names);
    Ok(names
        .into_iter()
        .enumerate()
        .map(|(i, name)| OutputDeviceInfo {
            name,
            is_default: Some(i) == default,
        })
        .collect())
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
    let devices = asio_devices(&asio_host()?)?;
    if devices.is_empty() {
        return Err(NO_ASIO_DRIVERS.to_string());
    }
    let names: Vec<String> = devices.iter().map(device_name).collect();
    let index = match device {
        None => default_asio_index(&names),
        Some(w) => Some(select_output_device(&names, w).map_err(|e| {
            format!(
                "{e} ASIO drivers: {}. --audio-device / audio_device apply to the selected backend.",
                names.join(", ")
            )
        })?),
    };
    let d = index
        .and_then(|i| devices.into_iter().nth(i))
        .ok_or_else(|| NO_ASIO_DRIVERS.to_string())?;

    let name = device_name(&d);
    let supported = d
        .default_output_config()
        .map_err(|e| format!("cannot read the output format of ASIO driver {name}: {e}"))?;
    let sample_format = supported.sample_format();
    let mut rates: Vec<u32> = d
        .supported_output_configs()
        .into_iter()
        .flatten()
        .map(|c| c.min_sample_rate())
        .collect();
    rates.sort_unstable();
    rates.dedup();
    let sample_rate = pick_sample_rate(supported.sample_rate(), &rates)
        .ok_or_else(|| format!("ASIO driver {name} reports no usable sample rate"))?;
    let channels = output_channels(supported.channels());
    let range = match supported.buffer_size() {
        SupportedBufferSize::Range { min, max } => Some((*min, *max)),
        _ => None,
    };
    let (buffer_size, mut note) = buffer_plan(buffer_frames, range);
    let mut config = cpal::StreamConfig {
        channels,
        sample_rate,
        buffer_size,
    };

    let mut built = None;
    if let BufferSize::Fixed(n) = config.buffer_size {
        let (tx, rx) = sync_channel(EVENT_QUEUE_CAPACITY);
        let (ptx, prx) = sync_channel(PROFILE_QUEUE_CAPACITY);
        let (atx, arx) = sync_channel(ATTACH_QUEUE_CAPACITY);
        match build_any(&d, config, sample_format, make_engine(sample_rate), rx, prx, arx) {
            Ok(s) => built = Some((s, tx, ptx, atx)),
            Err(e) => {
                note = Some(format!(
                    "buffer of {n} frames not accepted by {name} ({e}); using the driver's own size ({FLEXASIO_BUFFER_TIP})"
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
            let s = build_any(&d, config, sample_format, make_engine(sample_rate), rx, prx, arx)
                .map_err(|e| format!("cannot open ASIO stream on {name}: {e}"))?;
            (s, tx, ptx, atx)
        }
    };
    stream
        .play()
        .map_err(|e| format!("cannot start ASIO stream on {name}: {e}"))?;
    Ok(AudioOutput {
        buffer_frames: stream.buffer_size().ok(),
        _stream: Box::new(stream),
        events: tx,
        profiles: ptx,
        attachments: atx,
        backend: Backend::Asio,
        device_name: name,
        sample_rate,
        channels,
        sample_format: format!("{sample_format}"),
        buffer_note: note,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn default_asio_index_prefers_flexasio() {
        assert_eq!(default_asio_index(&names(&["Realtek ASIO", "FlexASIO"])), Some(1));
        assert_eq!(default_asio_index(&names(&["ASIO4ALL v2"])), Some(0));
        assert_eq!(default_asio_index(&[]), None);
    }

    #[test]
    fn pick_sample_rate_cases() {
        assert_eq!(pick_sample_rate(44100, &[48000]), Some(44100));
        assert_eq!(pick_sample_rate(0, &[44100, 48000]), Some(48000));
        assert_eq!(pick_sample_rate(0, &[44100]), Some(44100));
        assert_eq!(pick_sample_rate(0, &[96000]), Some(96000));
        assert_eq!(pick_sample_rate(0, &[]), None);
    }

    #[test]
    fn output_channels_clamped() {
        assert_eq!(output_channels(0), 1);
        assert_eq!(output_channels(1), 1);
        assert_eq!(output_channels(2), 2);
        assert_eq!(output_channels(8), 2);
    }

    #[test]
    fn buffer_plan_branches() {
        assert_eq!(buffer_plan(None, Some((64, 1024))), (BufferSize::Default, None));
        assert_eq!(
            buffer_plan(Some(128), Some((64, 1024))),
            (BufferSize::Fixed(128), None)
        );
        let (size, note) = buffer_plan(Some(128), Some((64, 64)));
        assert_eq!(size, BufferSize::Default);
        let note = note.unwrap();
        assert!(note.contains("64-64"), "{note}");
        assert!(note.contains("bufferSizeSamples"), "{note}");
        assert_eq!(buffer_plan(Some(128), None), (BufferSize::Fixed(128), None));
    }
}
