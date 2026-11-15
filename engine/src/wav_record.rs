//! Session audio to WAV: the audio thread copies each rendered chunk into a preallocated block (never blocks or allocates); a writer thread saves 16-bit stereo at the device rate with hound.

use std::fs::File;
use std::io::BufWriter;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{
    sync_channel, Receiver, RecvTimeoutError, SyncSender, TrySendError,
};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

pub const BLOCK_FRAMES: usize = crate::audio::MAX_CHUNK_FRAMES;
pub const POOL_BLOCKS: usize = 256;
pub const FLUSH_INTERVAL: Duration = Duration::from_secs(10);

pub struct Block {
    frames: usize,
    data: Box<[f32]>,
}

impl Block {
    pub fn frames(&self) -> usize {
        self.frames
    }

    pub fn samples(&self) -> &[f32] {
        &self.data[..2 * self.frames]
    }
}

pub struct WavTap {
    free: Receiver<Block>,
    full: SyncSender<Block>,
    spare: Option<Block>,
    dropped: Arc<AtomicU64>,
}

impl WavTap {
    pub fn push(&mut self, left: &[f32], right: &[f32]) {
        let n = left.len().min(right.len());
        let mut start = 0;
        while start < n {
            let end = (start + BLOCK_FRAMES).min(n);
            let piece = end - start;
            let block = self.spare.take().or_else(|| self.free.try_recv().ok());
            let Some(mut block) = block else {
                self.dropped.fetch_add(piece as u64, Ordering::Relaxed);
                start = end;
                continue;
            };
            for i in 0..piece {
                block.data[2 * i] = left[start + i];
                block.data[2 * i + 1] = right[start + i];
            }
            block.frames = piece;
            match self.full.try_send(block) {
                Ok(()) => {}
                Err(TrySendError::Full(b)) | Err(TrySendError::Disconnected(b)) => {
                    self.dropped.fetch_add(piece as u64, Ordering::Relaxed);
                    self.spare = Some(b);
                }
            }
            start = end;
        }
    }
}

pub struct WriterEnds {
    pub full: Receiver<Block>,
    pub free: SyncSender<Block>,
    pub dropped: Arc<AtomicU64>,
}

pub fn channels(pool_blocks: usize) -> (WavTap, WriterEnds) {
    let (full_tx, full_rx) = sync_channel(pool_blocks);
    let (free_tx, free_rx) = sync_channel(pool_blocks);
    for _ in 0..pool_blocks {
        let _ = free_tx.try_send(Block {
            frames: 0,
            data: vec![0.0; 2 * BLOCK_FRAMES].into_boxed_slice(),
        });
    }
    let dropped = Arc::new(AtomicU64::new(0));
    (
        WavTap {
            free: free_rx,
            full: full_tx,
            spare: None,
            dropped: dropped.clone(),
        },
        WriterEnds {
            full: full_rx,
            free: free_tx,
            dropped,
        },
    )
}

#[derive(Debug, Clone, PartialEq)]
pub struct WavSummary {
    pub path: PathBuf,
    pub frames: u64,
    pub sample_rate: u32,
    pub dropped_frames: u64,
}

pub type WavResult = Result<WavSummary, String>;

type Slot = Arc<(Mutex<Option<WavResult>>, Condvar)>;

type Writer = hound::WavWriter<BufWriter<File>>;

pub struct WavRecorder {
    path: PathBuf,
    stop: Arc<AtomicBool>,
    slot: Slot,
    discard: Arc<AtomicBool>,
    claimed: Arc<AtomicBool>,
    handle: JoinHandle<WavResult>,
}

#[derive(Clone)]
pub struct WavStopper {
    stop: Arc<AtomicBool>,
    slot: Slot,
    discard: Arc<AtomicBool>,
    claimed: Arc<AtomicBool>,
    path: PathBuf,
}

impl WavStopper {
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn is_discarded(&self) -> bool {
        self.discard.load(Ordering::SeqCst)
    }

    /// Makes the writer thread delete the file when it finishes, even if nobody waits for it.
    pub fn discard(&self) {
        self.discard.store(true, Ordering::SeqCst);
    }

    /// True for the first caller only: that caller reports the "Saved audio" line.
    pub fn claim_report(&self) -> bool {
        !self.claimed.swap(true, Ordering::SeqCst)
    }

    pub fn finish_now(&self, timeout: Duration) -> Option<WavResult> {
        self.stop.store(true, Ordering::SeqCst);
        let (lock, cv) = &*self.slot;
        let guard = lock.lock().unwrap();
        let (guard, _) = cv
            .wait_timeout_while(guard, timeout, |r| r.is_none())
            .unwrap();
        guard.clone()
    }
}

fn write_block(writer: &mut Writer, block: &Block, err: &mut Option<String>) {
    if err.is_some() {
        return;
    }
    for &x in block.samples() {
        if let Err(e) = writer.write_sample((x.clamp(-1.0, 1.0) * 32767.0).round() as i16) {
            *err = Some(e.to_string());
            return;
        }
    }
}

fn writer_loop(
    mut writer: Writer,
    ends: WriterEnds,
    stop: Arc<AtomicBool>,
    path: PathBuf,
    sample_rate: u32,
) -> WavResult {
    let mut frames: u64 = 0;
    let mut err: Option<String> = None;
    let mut last_flush = Instant::now();
    loop {
        match ends.full.recv_timeout(Duration::from_millis(50)) {
            Ok(block) => {
                write_block(&mut writer, &block, &mut err);
                frames += block.frames() as u64;
                let _ = ends.free.try_send(block);
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
        if stop.load(Ordering::SeqCst) {
            while let Ok(block) = ends.full.try_recv() {
                write_block(&mut writer, &block, &mut err);
                frames += block.frames() as u64;
                let _ = ends.free.try_send(block);
            }
            break;
        }
        if err.is_none() && last_flush.elapsed() >= FLUSH_INTERVAL {
            last_flush = Instant::now();
            if let Err(e) = writer.flush() {
                err = Some(e.to_string());
            }
        }
    }
    if let Err(e) = writer.finalize() {
        err.get_or_insert(e.to_string());
    }
    match err {
        Some(e) => Err(format!("cannot write {}: {}", path.display(), e)),
        None => Ok(WavSummary {
            path,
            frames,
            sample_rate,
            dropped_frames: ends.dropped.load(Ordering::Relaxed),
        }),
    }
}

impl WavRecorder {
    pub fn start(path: PathBuf, sample_rate: u32) -> Result<(WavRecorder, WavTap), String> {
        let spec = hound::WavSpec {
            channels: 2,
            sample_rate,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let writer = hound::WavWriter::create(&path, spec)
            .map_err(|e| format!("cannot create {}: {}", path.display(), e))?;
        let (tap, ends) = channels(POOL_BLOCKS);
        let stop = Arc::new(AtomicBool::new(false));
        let slot: Slot = Arc::new((Mutex::new(None), Condvar::new()));
        let discard = Arc::new(AtomicBool::new(false));
        let claimed = Arc::new(AtomicBool::new(false));
        let (t_stop, t_slot, t_path) = (stop.clone(), slot.clone(), path.clone());
        let t_discard = discard.clone();
        let handle = std::thread::Builder::new()
            .name("wav-writer".into())
            .spawn(move || {
                let result = writer_loop(writer, ends, t_stop, t_path.clone(), sample_rate);
                if t_discard.load(Ordering::SeqCst) {
                    let _ = std::fs::remove_file(&t_path);
                }
                let (lock, cv) = &*t_slot;
                *lock.lock().unwrap() = Some(result.clone());
                cv.notify_all();
                result
            })
            .map_err(|e| format!("cannot create {}: {}", path.display(), e))?;
        Ok((
            WavRecorder {
                path,
                stop,
                slot,
                discard,
                claimed,
                handle,
            },
            tap,
        ))
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn stopper(&self) -> WavStopper {
        WavStopper {
            stop: self.stop.clone(),
            slot: self.slot.clone(),
            discard: self.discard.clone(),
            claimed: self.claimed.clone(),
            path: self.path.clone(),
        }
    }

    /// True for the first caller only (shared with the stoppers).
    pub fn claim_report(&self) -> bool {
        !self.claimed.swap(true, Ordering::SeqCst)
    }

    pub fn finish(self) -> WavResult {
        self.stop.store(true, Ordering::SeqCst);
        self.handle
            .join()
            .unwrap_or_else(|_| Err("WAV writer thread panicked".to_string()))
    }
}

pub fn wav_path_for(mid: &Path) -> PathBuf {
    mid.with_extension("wav")
}

pub fn save_message(r: &WavResult) -> String {
    match r {
        Ok(s) => {
            let secs = s.frames as f64 / s.sample_rate.max(1) as f64;
            let mut m = format!(
                "Saved audio: {} ({:.1} s, {} Hz)",
                s.path.display(),
                secs,
                s.sample_rate
            );
            if s.dropped_frames > 0 {
                let ms = s.dropped_frames as f64 * 1000.0 / s.sample_rate.max(1) as f64;
                m.push_str(&format!(
                    "; {} frames ({:.0} ms) were dropped because the disk was too slow",
                    s.dropped_frames, ms
                ));
            }
            m
        }
        Err(e) => format!("warning: audio recording failed: {}", e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_wav(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("rp-wav-{}-{}.wav", std::process::id(), name))
    }

    fn ramp() -> (Vec<f32>, Vec<f32>) {
        let l: Vec<f32> = (0..480).map(|i| 0.5 * i as f32 / 480.0).collect();
        let r: Vec<f32> = l.iter().map(|x| -x).collect();
        (l, r)
    }

    #[test]
    fn writes_16_bit_stereo() {
        let path = temp_wav("stereo");
        let (rec, mut tap) = WavRecorder::start(path.clone(), 48000).unwrap();
        let (l, r) = ramp();
        for _ in 0..3 {
            tap.push(&l, &r);
        }
        let s = rec.finish().unwrap();
        assert_eq!(s.frames, 1440);
        assert_eq!(s.dropped_frames, 0);
        let mut rd = hound::WavReader::open(&path).unwrap();
        let spec = rd.spec();
        assert_eq!(spec.channels, 2);
        assert_eq!(spec.bits_per_sample, 16);
        assert_eq!(spec.sample_format, hound::SampleFormat::Int);
        assert_eq!(spec.sample_rate, 48000);
        let v: Vec<i16> = rd.samples::<i16>().map(|s| s.unwrap()).collect();
        drop(rd);
        let _ = std::fs::remove_file(&path);
        assert_eq!(v.len(), 2880);
        for i in [0usize, 1, 100, 479] {
            assert_eq!(v[2 * i], (l[i] * 32767.0).round() as i16);
            assert_eq!(v[2 * i + 1], (r[i] * 32767.0).round() as i16);
        }
    }

    #[test]
    fn overflow_counts_dropped_frames() {
        let (mut tap, ends) = channels(2);
        let l = vec![0.1f32; 100];
        let r = vec![0.2f32; 100];
        for _ in 0..5 {
            tap.push(&l, &r);
        }
        assert_eq!(ends.dropped.load(Ordering::Relaxed), 300);
        let mut n = 0;
        while let Ok(b) = ends.full.try_recv() {
            assert_eq!(b.frames(), 100);
            n += 1;
        }
        assert_eq!(n, 2);
    }

    #[test]
    fn clips_out_of_range_samples() {
        let path = temp_wav("clip");
        let (rec, mut tap) = WavRecorder::start(path.clone(), 48000).unwrap();
        tap.push(&[1.5], &[-2.0]);
        rec.finish().unwrap();
        let mut rd = hound::WavReader::open(&path).unwrap();
        let v: Vec<i16> = rd.samples::<i16>().map(|s| s.unwrap()).collect();
        drop(rd);
        let _ = std::fs::remove_file(&path);
        assert_eq!(v, vec![32767, -32767]);
    }

    #[test]
    fn stopper_finishes_once() {
        let path = temp_wav("stopper");
        let (rec, mut tap) = WavRecorder::start(path.clone(), 48000).unwrap();
        let (l, r) = ramp();
        tap.push(&l, &r);
        let first = rec
            .stopper()
            .finish_now(Duration::from_secs(2))
            .expect("finished in time");
        assert_eq!(first.as_ref().unwrap().frames, 480);
        let second = rec.finish();
        let _ = std::fs::remove_file(&path);
        assert_eq!(first, second);
    }

    #[test]
    fn only_first_path_claims_the_saved_line() {
        let path = temp_wav("claim");
        let (rec, _tap) = WavRecorder::start(path.clone(), 48000).unwrap();
        let stopper = rec.stopper();
        let r = stopper.finish_now(Duration::from_secs(2)).expect("finished");
        let mut lines = Vec::new();
        if stopper.claim_report() {
            lines.push(save_message(&r));
        }
        let claimed_by_recorder = rec.claim_report();
        let second = rec.finish();
        let _ = std::fs::remove_file(&path);
        if claimed_by_recorder {
            lines.push(save_message(&second));
        }
        assert_eq!(lines.len(), 1);
        assert!(lines[0].starts_with("Saved audio: "));
    }

    #[test]
    fn discard_removes_file_after_timeout() {
        let path = temp_wav("discard");
        let (rec, _tap) = WavRecorder::start(path.clone(), 48000).unwrap();
        let stopper = rec.stopper();
        stopper.discard();
        let r = stopper.finish_now(Duration::ZERO);
        assert!(r.is_none(), "writer should still be waiting");
        rec.finish().unwrap();
        assert!(!path.exists());
    }

    #[test]
    fn stopper_finishes_while_blocks_keep_arriving() {
        let path = temp_wav("busy");
        let (rec, mut tap) = WavRecorder::start(path.clone(), 48000).unwrap();
        let running = Arc::new(AtomicBool::new(true));
        let r2 = running.clone();
        let helper = std::thread::spawn(move || {
            let (l, r) = ramp();
            while r2.load(Ordering::SeqCst) {
                tap.push(&l, &r);
                std::thread::sleep(Duration::from_millis(5));
            }
        });
        std::thread::sleep(Duration::from_millis(50));
        let t = Instant::now();
        let res = rec.stopper().finish_now(Duration::from_secs(2));
        let took = t.elapsed();
        running.store(false, Ordering::SeqCst);
        helper.join().unwrap();
        let _ = rec.finish();
        let _ = std::fs::remove_file(&path);
        let s = res.expect("finished in time").unwrap();
        assert!(took < Duration::from_secs(1), "took {:?}", took);
        assert!(s.frames > 0);
    }

    #[test]
    fn start_error_names_the_path() {
        let path = std::env::temp_dir()
            .join(format!("rp-no-such-dir-{}", std::process::id()))
            .join("x.wav");
        let e = WavRecorder::start(path.clone(), 48000).err().unwrap();
        assert!(e.contains(&path.display().to_string()), "{}", e);
        assert!(e.starts_with("cannot create"));
    }

    #[test]
    fn wav_path_and_messages() {
        assert_eq!(
            wav_path_for(Path::new("x/session-1.mid")),
            PathBuf::from("x/session-1.wav")
        );
        let mut s = WavSummary {
            path: PathBuf::from("a.wav"),
            frames: 96000,
            sample_rate: 48000,
            dropped_frames: 0,
        };
        assert_eq!(
            save_message(&Ok(s.clone())),
            format!("Saved audio: {} (2.0 s, 48000 Hz)", Path::new("a.wav").display())
        );
        s.dropped_frames = 4800;
        assert!(save_message(&Ok(s)).ends_with(
            "; 4800 frames (100 ms) were dropped because the disk was too slow"
        ));
        assert_eq!(
            save_message(&Err("boom".into())),
            "warning: audio recording failed: boom"
        );
    }
}
