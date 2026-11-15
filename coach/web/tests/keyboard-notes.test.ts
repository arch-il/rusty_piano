import test from "node:test";
import assert from "node:assert/strict";
import { createKeyboardNotes, keyboardHint } from "../src/keyboard-notes.ts";
import type { LiveEvent } from "../src/engine-socket.ts";

function noteOf(e: LiveEvent | undefined): number {
  assert.ok(e !== undefined && (e.type === "note_on" || e.type === "note_off"));
  return e.note;
}

const key = (code: string, extra = {}) => ({
  code,
  repeat: false,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  ...extra,
});

test("KeyA down plays C4 with fixed velocity", () => {
  const kn = createKeyboardNotes();
  const r = kn.keyDown(key("KeyA"), 10);
  assert.equal(r.handled, true);
  assert.deepEqual(r.events, [{ type: "note_on", t: 10, note: 60, velocity: 80, source: "keyboard" }]);
});

test("white and upper keys map to the right notes", () => {
  const kn = createKeyboardNotes();
  assert.equal(noteOf(kn.keyDown(key("KeyW"), 0).events[0]), 61);
  assert.equal(noteOf(kn.keyDown(key("KeyJ"), 0).events[0]), 71);
  assert.equal(noteOf(kn.keyDown(key("KeyK"), 0).events[0]), 72);
});

test("repeat keydown is handled with no events", () => {
  const kn = createKeyboardNotes();
  kn.keyDown(key("KeyA"), 0);
  assert.deepEqual(kn.keyDown(key("KeyA", { repeat: true }), 1), { handled: true, events: [] });
});

test("KeyA up gives note_off 60", () => {
  const kn = createKeyboardNotes();
  kn.keyDown(key("KeyA"), 0);
  assert.deepEqual(kn.keyUp(key("KeyA"), 5), {
    handled: true,
    events: [{ type: "note_off", t: 5, note: 60, source: "keyboard" }],
  });
});

test("X then A gives 72, Z Z then A gives 36", () => {
  const up = createKeyboardNotes();
  up.keyDown(key("KeyX"), 0);
  assert.equal(noteOf(up.keyDown(key("KeyA"), 0).events[0]), 72);

  const down = createKeyboardNotes();
  down.keyDown(key("KeyZ"), 0);
  down.keyDown(key("KeyZ"), 0);
  assert.equal(noteOf(down.keyDown(key("KeyA"), 0).events[0]), 36);
});

test("octave shift is clamped to -3..3", () => {
  const up = createKeyboardNotes();
  for (let i = 0; i < 5; i++) up.keyDown(key("KeyX"), 0);
  assert.equal(up.octaveShift(), 3);
  assert.equal(noteOf(up.keyDown(key("KeyA"), 0).events[0]), 96);

  const down = createKeyboardNotes();
  for (let i = 0; i < 10; i++) down.keyDown(key("KeyZ"), 0);
  assert.equal(down.octaveShift(), -3);
  assert.equal(noteOf(down.keyDown(key("KeyA"), 0).events[0]), 24);
});

test("holding A then pressing X and releasing A gives note_off 60", () => {
  const kn = createKeyboardNotes();
  kn.keyDown(key("KeyA"), 0);
  kn.keyDown(key("KeyX"), 0);
  assert.deepEqual(kn.keyUp(key("KeyA"), 1).events, [
    { type: "note_off", t: 1, note: 60, source: "keyboard" },
  ]);
});

test("octave change onto a held note does not double-play it", () => {
  const kn = createKeyboardNotes();
  kn.keyDown(key("KeyK"), 0);
  kn.keyDown(key("KeyX"), 0);
  assert.deepEqual(kn.keyDown(key("KeyA"), 1), { handled: true, events: [] });
  assert.deepEqual(kn.keyUp(key("KeyA"), 2), { handled: true, events: [] });
  assert.deepEqual(kn.keyUp(key("KeyK"), 3).events, [
    { type: "note_off", t: 3, note: 72, source: "keyboard" },
  ]);
});

test("Space down turns sustain on, repeat gives nothing, up turns it off", () => {
  const kn = createKeyboardNotes();
  assert.deepEqual(kn.keyDown(key("Space"), 4), {
    handled: true,
    events: [{ type: "sustain", t: 4, on: true, source: "keyboard" }],
  });
  assert.deepEqual(kn.keyDown(key("Space", { repeat: true }), 5), { handled: true, events: [] });
  assert.deepEqual(kn.keyUp(key("Space"), 6), {
    handled: true,
    events: [{ type: "sustain", t: 6, on: false, source: "keyboard" }],
  });
  assert.deepEqual(kn.keyUp(key("Space"), 7), { handled: true, events: [] });
});

test("ctrl, alt or meta with KeyA down is not handled", () => {
  const kn = createKeyboardNotes();
  for (const extra of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }]) {
    assert.deepEqual(kn.keyDown(key("KeyA", extra), 0), { handled: false, events: [] });
  }
});

test("releasing a held key while ctrl is down still gives note_off", () => {
  const kn = createKeyboardNotes();
  kn.keyDown(key("KeyA"), 0);
  assert.deepEqual(kn.keyUp(key("KeyA", { ctrlKey: true }), 1).events, [
    { type: "note_off", t: 1, note: 60, source: "keyboard" },
  ]);
});

test("unmapped keys are not handled on down or up", () => {
  const kn = createKeyboardNotes();
  for (const code of ["ArrowLeft", "Escape", "KeyQ"]) {
    assert.deepEqual(kn.keyDown(key(code), 0), { handled: false, events: [] });
    assert.deepEqual(kn.keyUp(key(code), 0), { handled: false, events: [] });
  }
});

test("KeyZ up is handled with no events", () => {
  const kn = createKeyboardNotes();
  assert.deepEqual(kn.keyUp(key("KeyZ"), 0), { handled: true, events: [] });
});

test("releaseAll releases held notes in press order, then sustain", () => {
  const kn = createKeyboardNotes();
  kn.keyDown(key("KeyA"), 0);
  kn.keyDown(key("KeyD"), 0);
  kn.keyDown(key("Space"), 0);
  assert.deepEqual(kn.releaseAll(9), [
    { type: "note_off", t: 9, note: 60, source: "keyboard" },
    { type: "note_off", t: 9, note: 64, source: "keyboard" },
    { type: "sustain", t: 9, on: false, source: "keyboard" },
  ]);
  assert.deepEqual(kn.keyUp(key("KeyA"), 10), { handled: true, events: [] });
  assert.equal(kn.octaveShift(), 0);
  assert.deepEqual(kn.releaseAll(11), []);
});

test("releaseAll keeps the octave shift", () => {
  const kn = createKeyboardNotes();
  kn.keyDown(key("KeyX"), 0);
  kn.releaseAll(1);
  assert.equal(kn.octaveShift(), 1);
});

test("releaseAll with nothing held gives an empty list", () => {
  assert.deepEqual(createKeyboardNotes().releaseAll(0), []);
});

test("keyboardHint gives the range text", () => {
  assert.equal(keyboardHint(0), "Keyboard: A-K = C4-C5, Z/X octave down/up, Space sustain");
  assert.equal(keyboardHint(-1), "Keyboard: A-K = C3-C4, Z/X octave down/up, Space sustain");
});

test("resetOctave sets the shift back to 0 and keeps held notes", () => {
  const kn = createKeyboardNotes();
  kn.keyDown(key("KeyX"), 0);
  kn.keyDown(key("KeyX"), 1);
  assert.equal(kn.octaveShift(), 2);
  assert.equal(noteOf(kn.keyDown(key("KeyA"), 2).events[0]), 84);
  kn.resetOctave();
  assert.equal(kn.octaveShift(), 0);
  assert.deepEqual(kn.keyUp(key("KeyA"), 3).events, [{ type: "note_off", t: 3, note: 84, source: "keyboard" }]);
  assert.equal(noteOf(kn.keyDown(key("KeyA"), 4).events[0]), 60);
});
