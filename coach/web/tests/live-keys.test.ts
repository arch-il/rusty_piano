import assert from "node:assert/strict";
import { test } from "node:test";
import { createLiveKeys } from "../src/live-keys.ts";
import type { LiveEvent, LiveSource } from "../src/engine-socket.ts";

const on = (note: number, source: LiveSource = "engine"): LiveEvent => ({ type: "note_on", t: 0, note, velocity: 80, source });
const off = (note: number, source: LiveSource = "engine"): LiveEvent => ({ type: "note_off", t: 0, note, source });
const ped = (v: boolean, source: LiveSource = "engine"): LiveEvent => ({ type: "sustain", t: 0, on: v, source });

test("note on and off", () => {
  const k = createLiveKeys();
  assert.equal(k.apply(on(64)), true);
  assert.equal(k.apply(on(60)), true);
  assert.deepEqual(k.held(), [60, 64]);
  assert.equal(k.apply(off(60)), true);
  assert.deepEqual(k.held(), [64]);
});

test("same note from two sources stays lit until both release", () => {
  const k = createLiveKeys();
  k.apply(on(60, "engine"));
  assert.equal(k.apply(on(60, "keyboard")), false);
  k.apply(off(60, "engine"));
  assert.deepEqual(k.held(), [60]);
  k.apply(off(60, "keyboard"));
  assert.deepEqual(k.held(), []);
});

test("duplicate note_on counts once", () => {
  const k = createLiveKeys();
  k.apply(on(60));
  assert.equal(k.apply(on(60)), false);
  k.apply(off(60));
  assert.deepEqual(k.held(), []);
});

test("unknown note_off is ignored", () => {
  const k = createLiveKeys();
  assert.equal(k.apply(off(60)), false);
  assert.deepEqual(k.held(), []);
});

test("sustain is on when any source has it on", () => {
  const k = createLiveKeys();
  assert.equal(k.apply(ped(true, "engine")), true);
  assert.equal(k.apply(ped(true, "keyboard")), false);
  k.apply(ped(false, "engine"));
  assert.equal(k.sustain(), true);
  assert.equal(k.apply(ped(false, "keyboard")), true);
  assert.equal(k.sustain(), false);
});

test("releaseSource drops that source only", () => {
  const k = createLiveKeys();
  k.apply(on(60, "engine"));
  k.apply(on(62, "keyboard"));
  k.apply(ped(true, "engine"));
  assert.equal(k.releaseSource("engine"), true);
  assert.deepEqual(k.held(), [62]);
  assert.equal(k.sustain(), false);
  assert.equal(k.releaseSource("engine"), false);
});

test("reset clears everything", () => {
  const k = createLiveKeys();
  k.apply(on(60));
  k.apply(ped(true));
  k.reset();
  assert.deepEqual(k.held(), []);
  assert.equal(k.sustain(), false);
});
