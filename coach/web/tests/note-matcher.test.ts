import { test } from "node:test";
import assert from "node:assert/strict";
import { createWaitMatcher } from "../src/note-matcher.ts";
import type { MatchStep, MatchResult } from "../src/note-matcher.ts";
import type { LiveEvent } from "../src/engine-socket.ts";

const on = (note: number, t = 0, velocity = 100): LiveEvent => ({ type: "note_on", t, note, velocity, source: "engine" });
const off = (note: number, t = 0): LiveEvent => ({ type: "note_off", t, note, source: "engine" });

const DEMO: LiveEvent[] = [
  on(60, 0, 40), off(60, 220), on(64, 250, 70), off(64, 470), on(67, 500, 100), off(67, 720),
  on(72, 750, 127), off(72, 970), on(48, 1250, 100), on(60, 1250, 100), on(64, 1250, 100), on(67, 1250, 100),
  off(48, 2750), off(60, 2750), off(64, 2750), off(67, 2750),
  { type: "sustain", t: 3250, on: true, source: "engine" },
  on(72, 3300, 80), off(72, 3400), on(76, 3500, 80), off(76, 3600), on(79, 3700, 80), off(79, 3800),
  on(84, 3900, 80), off(84, 4000),
  { type: "sustain", t: 5500, on: false, source: "engine" },
];

const DEMO_STEPS: MatchStep[] = [[60], [64], [67], [72], [48, 60, 64, 67], [72], [76], [79], [84]].map((p) => ({ pitches: p }));
const CASE_STEPS: MatchStep[] = [[60, 64], [64, 67], [67], [60, 69], [69], [71], [62], [62], [60, 72]].map((p) => ({ pitches: p }));

function feed(steps: MatchStep[], events: LiveEvent[]) {
  const m = createWaitMatcher(steps);
  const results: MatchResult[][] = events.map((ev) => m.handle(ev));
  return { m, results };
}

test("single notes advance with exact results", () => {
  const m = createWaitMatcher([{ pitches: [60] }, { pitches: [62] }]);
  assert.deepEqual(m.handle(on(60)), [
    { kind: "accepted", step: 0, note: 60 },
    { kind: "hit", step: 0, attempts: 0 },
    { kind: "advance", step: 1 },
  ]);
  assert.deepEqual(m.handle(off(60)), []);
  assert.deepEqual(m.handle(on(62)), [
    { kind: "accepted", step: 1, note: 62 },
    { kind: "hit", step: 1, attempts: 0 },
    { kind: "done" },
  ]);
  assert.equal(m.done(), true);
  assert.equal(m.current(), 2);
  assert.deepEqual(m.handle(on(60)), []);
  assert.deepEqual(m.handle(on(62)), []);
});

test("a chord completes in any order", () => {
  const m = createWaitMatcher([{ pitches: [60, 64] }]);
  assert.deepEqual(m.handle(on(64)).map((r) => r.kind), ["accepted"]);
  assert.deepEqual(m.handle(on(60)), [
    { kind: "accepted", step: 0, note: 60 },
    { kind: "hit", step: 0, attempts: 0 },
    { kind: "done" },
  ]);
});

test("a chord must be held together", () => {
  const m = createWaitMatcher([{ pitches: [60, 64, 67] }]);
  m.handle(on(60));
  m.handle(on(64));
  m.handle(off(60));
  const res = m.handle(on(67));
  assert.equal(res.some((r) => r.kind === "hit"), false);
  assert.equal(m.current(), 0);
  assert.deepEqual(m.handle(on(60)).map((r) => r.kind), ["accepted", "hit", "done"]);
});

test("wrong notes count and do not advance", () => {
  const m = createWaitMatcher([{ pitches: [60] }, { pitches: [62] }]);
  assert.deepEqual(m.handle(on(61)), [{ kind: "wrong", step: 0, note: 61, attempts: 1 }]);
  m.handle(off(61));
  assert.deepEqual(m.handle(on(63)), [{ kind: "wrong", step: 0, note: 63, attempts: 2 }]);
  assert.equal(m.current(), 0);
  assert.equal(m.wrongAttempts(0), 2);
  assert.equal(m.wrongAttempts(1), 0);
  assert.equal(m.wrongAttempts(99), 0);
  m.handle(off(63));
  assert.deepEqual(m.handle(on(60))[1], { kind: "hit", step: 0, attempts: 2 });
  assert.equal(m.wrongAttempts(0), 2);
});

test("a wrong note while a chord is half down does not reset it", () => {
  const m = createWaitMatcher([{ pitches: [60, 64] }]);
  m.handle(on(60));
  assert.deepEqual(m.handle(on(70)), [{ kind: "wrong", step: 0, note: 70, attempts: 1 }]);
  assert.deepEqual(m.handle(on(64)).map((r) => r.kind), ["accepted", "hit", "done"]);
  assert.deepEqual(m.handle(on(64)), []);
});

test("a repeated pitch needs a release and a new press", () => {
  const m = createWaitMatcher([{ pitches: [67] }, { pitches: [67] }]);
  assert.deepEqual(m.handle(on(67)).map((r) => r.kind), ["accepted", "hit", "advance"]);
  assert.deepEqual(m.handle(off(67)), []);
  assert.deepEqual(m.handle(on(67)).map((r) => r.kind), ["accepted", "hit", "done"]);
});

test("after a repeated-pitch hit, the next chord needs the held pitch pressed again", () => {
  const m = createWaitMatcher([{ pitches: [67] }, { pitches: [67, 72] }]);
  m.handle(on(67));
  assert.deepEqual(m.handle(on(72)), [{ kind: "accepted", step: 1, note: 72 }]);
  assert.equal(m.done(), false);
  m.handle(off(67));
  assert.deepEqual(m.handle(on(67)).map((r) => r.kind), ["accepted", "hit", "done"]);
});

test("velocity 0 acts as a release", () => {
  const m = createWaitMatcher([{ pitches: [60, 64] }]);
  m.handle(on(60));
  assert.deepEqual(m.handle(on(60, 5, 0)), []);
  assert.deepEqual(m.handle(on(64)).map((r) => r.kind), ["accepted"]);
  assert.equal(m.current(), 0);
  assert.deepEqual(m.handle(on(60)).map((r) => r.kind), ["accepted", "hit", "done"]);
});

test("sustain gives no results", () => {
  const m = createWaitMatcher([{ pitches: [60] }]);
  assert.deepEqual(m.handle({ type: "sustain", t: 0, on: true, source: "engine" }), []);
  assert.equal(m.current(), 0);
});

test("keyboard source counts the same as engine", () => {
  const m = createWaitMatcher([{ pitches: [60] }]);
  assert.deepEqual(m.handle({ type: "note_on", t: 0, note: 60, velocity: 90, source: "keyboard" }).map((r) => r.kind), [
    "accepted",
    "hit",
    "done",
  ]);
});

test("an empty step list is done at once", () => {
  const m = createWaitMatcher([]);
  assert.equal(m.done(), true);
  assert.equal(m.current(), 0);
  assert.deepEqual(m.handle(on(60)), []);
});

test("the engine demo completes the demo score with 9 hits and no wrong notes", () => {
  const { m, results } = feed(DEMO_STEPS, DEMO);
  const all = results.flat();
  assert.equal(all.filter((r) => r.kind === "hit").length, 9);
  assert.equal(all.filter((r) => r.kind === "wrong").length, 0);
  assert.equal(m.done(), true);
  assert.equal(m.current(), 9);
  assert.equal(m.wrongAttempts(0), 0);
});

test("the engine demo against the cases score is stuck at step 1 with 3 and 4 wrong attempts", () => {
  const { m } = feed(CASE_STEPS, DEMO);
  assert.equal(m.current(), 1);
  assert.equal(m.wrongAttempts(0), 3);
  assert.equal(m.wrongAttempts(1), 4);
  assert.equal(m.done(), false);
});
