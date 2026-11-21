import { test } from "node:test";
import assert from "node:assert/strict";
import { createEarMatcher } from "../src/ear-matcher.ts";
import type { AnswerStep } from "../src/ear-levels.ts";
import type { LiveEvent } from "../src/engine-socket.ts";

const on = (note: number, velocity = 80): LiveEvent => ({ type: "note_on", t: 0, note, velocity, source: "engine" });
const off = (note: number): LiveEvent => ({ type: "note_off", t: 0, note, source: "engine" });

test("note step: right key is accepted then done, wrong key is wrong", () => {
  const m = createEarMatcher([{ kind: "note", pitch: 64 }]);
  assert.deepEqual(m.handle(on(60)), [{ kind: "wrong", step: 0, note: 60 }]);
  assert.equal(m.done(), false);
  assert.deepEqual(m.handle(on(64)), [{ kind: "accepted", step: 0, note: 64 }, { kind: "done" }]);
  assert.equal(m.done(), true);
  assert.deepEqual(m.handle(on(60)), []);
});

test("note steps advance in order", () => {
  const m = createEarMatcher([
    { kind: "note", pitch: 60 },
    { kind: "note", pitch: 62 },
  ]);
  assert.deepEqual(m.handle(on(60)), [{ kind: "accepted", step: 0, note: 60 }, { kind: "step", step: 1 }]);
  assert.equal(m.current(), 1);
  assert.deepEqual(m.handle(on(72)), [{ kind: "wrong", step: 1, note: 72 }]);
  assert.deepEqual(m.handle(on(62)), [{ kind: "accepted", step: 1, note: 62 }, { kind: "done" }]);
});

test("pc step accepts any octave", () => {
  const m = createEarMatcher([{ kind: "pc", pc: 7 }]);
  assert.equal(m.handle(on(61))[0].kind, "wrong");
  assert.deepEqual(m.handle(on(79)), [{ kind: "accepted", step: 0, note: 79 }, { kind: "done" }]);
});

test("sustain is ignored and velocity 0 acts as a release", () => {
  const m = createEarMatcher([{ kind: "note", pitch: 60 }]);
  assert.deepEqual(m.handle({ type: "sustain", t: 0, on: true, source: "engine" }), []);
  assert.deepEqual(m.handle(off(60)), []);
  assert.deepEqual(m.handle(on(60, 0)), []);
  assert.equal(m.done(), false);
});

const chord: AnswerStep[] = [{ kind: "chord", pcs: [0, 4, 7] }];

test("chord step: any octave and order, completes when all pcs are held", () => {
  const m = createEarMatcher(chord);
  assert.deepEqual(m.handle(on(67)), [{ kind: "accepted", step: 0, note: 67 }]);
  assert.deepEqual(m.handle(on(52)), [{ kind: "accepted", step: 0, note: 52 }]);
  assert.deepEqual(m.handle(on(72)), [{ kind: "accepted", step: 0, note: 72 }, { kind: "done" }]);
});

test("chord step: an inversion counts", () => {
  const m = createEarMatcher(chord);
  m.handle(on(64));
  m.handle(on(67));
  assert.equal(m.handle(on(72)).at(-1)?.kind, "done");
});

test("chord step: a wrong key is not held, a released key must be pressed again", () => {
  const m = createEarMatcher(chord);
  m.handle(on(60));
  assert.deepEqual(m.handle(on(61)), [{ kind: "wrong", step: 0, note: 61 }]);
  m.handle(on(64));
  m.handle(off(64));
  assert.equal(m.done(), false);
  assert.deepEqual(m.handle(on(67)), [{ kind: "accepted", step: 0, note: 67 }]);
  assert.equal(m.done(), false);
  assert.equal(m.handle(on(64)).at(-1)?.kind, "done");
});

test("chord then note: advancing clears held keys", () => {
  const m = createEarMatcher([chord[0], { kind: "pc", pc: 2 }]);
  m.handle(on(60));
  m.handle(on(64));
  assert.deepEqual(m.handle(on(67)).at(-1), { kind: "step", step: 1 });
  assert.deepEqual(m.handle(on(62)), [{ kind: "accepted", step: 1, note: 62 }, { kind: "done" }]);
});

test("direction step up: any higher key advances, equal or lower is wrong", () => {
  const m = createEarMatcher([{ kind: "direction", from: 60, up: true }]);
  assert.deepEqual(m.handle(on(60)), [{ kind: "wrong", step: 0, note: 60 }]);
  assert.deepEqual(m.handle(on(58)), [{ kind: "wrong", step: 0, note: 58 }]);
  assert.equal(m.done(), false);
  assert.deepEqual(m.handle(on(61)), [{ kind: "accepted", step: 0, note: 61 }, { kind: "done" }]);
});

test("direction step up: a far higher key is accepted", () => {
  const m = createEarMatcher([{ kind: "direction", from: 60, up: true }]);
  assert.deepEqual(m.handle(on(79)), [{ kind: "accepted", step: 0, note: 79 }, { kind: "done" }]);
});

test("direction step down: any lower key advances, equal or higher is wrong", () => {
  const m = createEarMatcher([{ kind: "direction", from: 60, up: false }]);
  assert.deepEqual(m.handle(on(60)), [{ kind: "wrong", step: 0, note: 60 }]);
  assert.deepEqual(m.handle(on(62)), [{ kind: "wrong", step: 0, note: 62 }]);
  assert.equal(m.done(), false);
  assert.deepEqual(m.handle(on(48)), [{ kind: "accepted", step: 0, note: 48 }, { kind: "done" }]);
});
