use rusty_piano_engine::{
    midi::MidiEvent,
    sound::{
        modal_piano::{
            profile::ModalNoises,
            tables::{NoteAnchor, NoteTable},
            ModalPiano, ModalProfile,
        },
        SoundEngine,
    },
};
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::sync::atomic::{AtomicUsize, Ordering};

thread_local! {
    static ON: Cell<bool> = const { Cell::new(false) };
}

static COUNT: AtomicUsize = AtomicUsize::new(0);

struct Counting;

fn counting() -> bool {
    ON.try_with(|c| c.get()).unwrap_or(false)
}

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        if counting() {
            COUNT.fetch_add(1, Ordering::Relaxed);
        }
        System.alloc(layout)
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        if counting() {
            COUNT.fetch_add(1, Ordering::Relaxed);
        }
        System.alloc_zeroed(layout)
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        if counting() {
            COUNT.fetch_add(1, Ordering::Relaxed);
        }
        System.realloc(ptr, layout, new_size)
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        System.dealloc(ptr, layout)
    }
}

#[global_allocator]
static GLOBAL: Counting = Counting;

const SR: u32 = 48000;
const FRAME: usize = 2400;

fn base() -> ModalProfile {
    let mut p = ModalProfile::default();
    p.resonance.strength = 0.0;
    p.noises = ModalNoises::off();
    p
}

fn with_table(a: &[NoteAnchor]) -> ModalProfile {
    ModalProfile { notes: NoteTable::from_anchors(a).unwrap(), ..base() }
}

fn render(e: &mut ModalPiano, frames: usize) -> Vec<f32> {
    let mut out = Vec::with_capacity(frames);
    let mut done = 0;
    while done < frames {
        let n = (frames - done).min(64);
        let mut l = [0.0f32; 64];
        let mut r = [0.0f32; 64];
        e.render_stereo(&mut l[..n], &mut r[..n]);
        for i in 0..n {
            out.push(0.5 * (l[i] + r[i]));
        }
        done += n;
    }
    out
}

fn secs(s: f64) -> usize {
    (s * SR as f64) as usize
}

fn level(x: &[f32]) -> f64 {
    let ms = x.iter().map(|&v| (v as f64) * (v as f64)).sum::<f64>() / x.len() as f64;
    10.0 * (ms + 1e-30).log10()
}

fn frame_db(m: &[f32]) -> Vec<f64> {
    m.chunks_exact(FRAME).map(level).collect()
}

fn last_level(m: &[f32]) -> f64 {
    level(&m[m.len() - FRAME..])
}

fn held(p: &ModalProfile, note: u8, vel: u8, s: f64) -> Vec<f32> {
    let mut e = ModalPiano::with_profile(SR, p);
    e.handle(&MidiEvent::NoteOn { note, velocity: vel });
    render(&mut e, secs(s))
}

#[test]
fn neutral_two_stage_is_bit_exact() {
    let a = held(&base(), 60, 80, 1.0);
    let b = held(&with_table(&[NoteAnchor::neutral(60)]), 60, 80, 1.0);
    let c = held(&with_table(&[NoteAnchor { after_level_db: -12.0, ..NoteAnchor::neutral(60) }]), 60, 80, 1.0);
    assert_eq!(a, b);
    assert_eq!(a, c);
}

#[test]
fn two_stage_drops_follow_anchors() {
    let p0 = base();
    let p1 = with_table(&[NoteAnchor { prompt_db_per_s: 60.0, after_level_db: -12.0, ..NoteAnchor::neutral(72) }]);
    let drops = |p: &ModalProfile| {
        let db = frame_db(&held(p, 72, 64, 2.5));
        let peak = db[..20].iter().cloned().fold(f64::MIN, f64::max);
        (peak - db[19], peak - db[39])
    };
    let (a1, a2) = drops(&p0);
    let (b1, b2) = drops(&p1);
    println!("p0: d1 {a1:.2} d2 {a2:.2}; p1: d1 {b1:.2} d2 {b2:.2}");
    let extra = b1 - a1;
    assert!((9.0..=13.0).contains(&extra), "extra drop at 1 s {extra}");
    let slope = (b2 - b1) - (a2 - a1);
    assert!(slope.abs() <= 1.0, "slope difference {slope}");
}

#[test]
fn two_stage_is_chunk_independent() {
    let p1 = with_table(&[NoteAnchor { prompt_db_per_s: 60.0, after_level_db: -12.0, ..NoteAnchor::neutral(72) }]);
    let total = 48000;
    let events: [(usize, MidiEvent); 2] = [
        (1000, MidiEvent::NoteOn { note: 72, velocity: 90 }),
        (30000, MidiEvent::NoteOff { note: 72 }),
    ];
    let run = |chunk: usize| -> (Vec<f32>, Vec<f32>) {
        let mut e = ModalPiano::with_profile(SR, &p1);
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
    for chunk in [7, 1000] {
        let (l, r) = run(chunk);
        let diff = l0.iter().zip(&l).chain(r0.iter().zip(&r)).map(|(a, b)| (a - b).abs()).fold(0.0f32, f32::max);
        assert!(diff <= 1e-5, "chunk {chunk}: max diff {diff}");
    }
}

#[test]
fn two_stage_with_damper_still_damps() {
    let p = with_table(&[NoteAnchor { prompt_db_per_s: 40.0, after_level_db: -10.0, ..NoteAnchor::neutral(60) }]);
    let mut e = ModalPiano::with_profile(SR, &p);
    e.handle(&MidiEvent::NoteOn { note: 60, velocity: 100 });
    let a = render(&mut e, secs(0.5));
    let l1 = last_level(&a);
    e.handle(&MidiEvent::NoteOff { note: 60 });
    let b = render(&mut e, secs(0.3));
    let l2 = last_level(&b);
    assert!(l1 - l2 >= 30.0, "l1 {l1} l2 {l2}");
}

#[test]
fn two_stage_live_edit_reaches_sounding_note() {
    let p0 = base();
    let mut a = ModalPiano::with_profile(SR, &p0);
    let mut b = ModalPiano::with_profile(SR, &p0);
    for e in [&mut a, &mut b] {
        e.handle(&MidiEvent::NoteOn { note: 72, velocity: 64 });
        render(e, secs(0.5));
    }
    b.set_profile(&with_table(&[NoteAnchor { prompt_db_per_s: 20.0, after_level_db: -12.0, ..NoteAnchor::neutral(72) }]));
    let la = last_level(&render(&mut a, secs(1.0)));
    let lb = last_level(&render(&mut b, secs(1.0)));
    assert!(lb <= la - 3.0, "A {la} B {lb}");
}

#[test]
fn two_stage_fields_are_validated() {
    let check = |a: NoteAnchor| ModalProfile { notes: NoteTable::from_anchors(&[a]).unwrap(), ..ModalProfile::default() }.validate();
    let e = check(NoteAnchor { prompt_db_per_s: 500.0, ..NoteAnchor::neutral(60) }).unwrap_err();
    assert!(e.contains("notes[0].prompt_db_per_s"), "{e}");
    let e = check(NoteAnchor { after_level_db: 1.0, ..NoteAnchor::neutral(60) }).unwrap_err();
    assert!(e.contains("notes[0].after_level_db"), "{e}");
    assert!(check(NoteAnchor { damper: 25.0, ..NoteAnchor::neutral(60) }).is_ok());
}

#[test]
fn two_stage_render_never_allocates() {
    let anchors = |after: f32| {
        [
            NoteAnchor { prompt_db_per_s: 40.0, after_level_db: after, ..NoteAnchor::neutral(40) },
            NoteAnchor { prompt_db_per_s: 40.0, after_level_db: after, ..NoteAnchor::neutral(80) },
        ]
    };
    let p1 = with_table(&anchors(-10.0));
    let p2 = with_table(&anchors(-6.0));
    let mut e = ModalPiano::with_profile(SR, &p1);
    let mut l = vec![0.0f32; 64];
    let mut r = vec![0.0f32; 64];
    e.render_stereo(&mut l, &mut r);

    COUNT.store(0, Ordering::SeqCst);
    ON.with(|c| c.set(true));
    for note in 50..70u8 {
        e.handle(&MidiEvent::NoteOn { note, velocity: 90 });
        e.render_stereo(&mut l, &mut r);
    }
    for _ in 0..200 {
        e.render_stereo(&mut l, &mut r);
    }
    for note in 50..70u8 {
        e.handle(&MidiEvent::NoteOff { note });
    }
    e.set_profile(&p2);
    for _ in 0..50 {
        e.render_stereo(&mut l, &mut r);
    }
    ON.with(|c| c.set(false));
    assert_eq!(COUNT.load(Ordering::SeqCst), 0);
}
