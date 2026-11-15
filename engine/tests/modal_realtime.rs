use rusty_piano_engine::{
    config::{Profile, SoundProfile},
    midi::{MidiEvent, Pedal},
    sound::{
        build_engine,
        modal_piano::{
            tables::{NoteAnchor, NoteTable},
            ModalProfile,
        },
        AnyEngine, SoundEngine,
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

fn exercise(mut engine: AnyEngine, changed: SoundProfile) -> usize {
    let mut left = vec![0.0f32; 64];
    let mut right = vec![0.0f32; 64];
    engine.render_stereo(&mut left, &mut right);

    COUNT.store(0, Ordering::SeqCst);
    ON.with(|c| c.set(true));
    engine.handle(&MidiEvent::Sustain { on: true });
    for i in 0..40u32 {
        let note = 30 + i as u8;
        let velocity = 1 + (i * 126 / 39) as u8;
        engine.handle(&MidiEvent::NoteOn { note, velocity });
        engine.render_stereo(&mut left, &mut right);
    }
    engine.handle(&MidiEvent::Pedal { pedal: Pedal::Sostenuto, value: 127 });
    engine.handle(&MidiEvent::Pedal { pedal: Pedal::Sustain, value: 50 });
    engine.handle(&MidiEvent::Pedal { pedal: Pedal::Soft, value: 127 });
    engine.handle(&MidiEvent::NoteOn { note: 70, velocity: 90 });
    engine.render_stereo(&mut left, &mut right);
    engine.handle(&MidiEvent::Pedal { pedal: Pedal::Soft, value: 0 });
    engine.handle(&MidiEvent::Pedal { pedal: Pedal::Sostenuto, value: 0 });
    engine.handle(&MidiEvent::Pedal { pedal: Pedal::Sustain, value: 90 });
    engine.handle(&MidiEvent::NoteOn { note: 69, velocity: 100 });
    engine.render_stereo(&mut left, &mut right);
    for note in 30..70u8 {
        engine.handle(&MidiEvent::NoteOff { note });
    }
    engine.handle(&MidiEvent::Sustain { on: false });
    engine.apply_sound_profile(&changed);
    for _ in 0..225 {
        engine.render_stereo(&mut left, &mut right);
    }
    ON.with(|c| c.set(false));
    COUNT.load(Ordering::SeqCst)
}

#[test]
fn render_and_handle_never_allocate() {
    let mut modal = ModalProfile::default();
    modal.output.master_volume = 0.5;
    modal.soundboard.modes = 120;
    modal.mics.spacing_m = 0.3;
    modal.soundboard.body_t60_ms = 60.0;
    modal.tuning.stretch = 1.5;
    modal.pedals.half_pedal_curve = 1.0;
    modal.resonance.strength = 0.7;
    modal.resonance.partials = 4;
    modal.noises.key_down = 0.02;
    modal.noises.pedal_down = 0.0;
    modal.eq.peak2_db = 3.0;
    modal.eq.high_shelf_db = -2.0;
    modal.reverb.mix = 0.25;
    modal.reverb.size = 1.3;
    modal.notes = NoteTable::from_anchors(&[
        NoteAnchor { t60: 1.5, ..NoteAnchor::neutral(40) },
        NoteAnchor { level_db: -3.0, ..NoteAnchor::neutral(80) },
    ])
    .unwrap();
    let mut simple = Profile::default();
    simple.loudness.master_volume = 0.5;

    let modal_count = exercise(
        build_engine(48_000, &SoundProfile::Modal(ModalProfile::default())),
        SoundProfile::Modal(modal),
    );
    let simple_count = exercise(
        build_engine(48_000, &SoundProfile::default()),
        SoundProfile::Simple(simple),
    );
    assert_eq!(modal_count, 0, "modal engine allocated on the audio path");
    assert_eq!(simple_count, 0, "simple engine allocated on the audio path");
}
