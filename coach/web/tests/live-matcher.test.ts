import { test } from "node:test";
import assert from "node:assert/strict";
import { createLiveMatcher } from "../src/live-matcher.ts";

const STEPS = [
  { pitches: [60], time: 0 },
  { pitches: [62], time: 1 },
  { pitches: [64, 67], time: 2 },
];
const OPTS = { msPerQuarter: 500, windowMs: 200, onTimeMs: 80, loopQuarters: null };

function make(loopQuarters: number | null = null) {
  const m = createLiveMatcher(STEPS, { ...OPTS, loopQuarters });
  m.start(1000);
  return m;
}

function pressAfterStep0(note: number, now: number) {
  const m = make();
  m.press(60, 1000);
  return m.press(note, now);
}

test("hit", () => {
  const m = make();
  assert.deepEqual(m.press(60, 1010), [
    { kind: "accepted", step: 0, cycle: 1, note: 60, dtMs: 10 },
    { kind: "outcome", step: 0, cycle: 1, outcome: "hit", dtMs: 10, score: 100, matchedNotes: 1, missedNotes: 0 },
  ]);
});

test("late", () => {
  const m = make();
  m.press(60, 1000);
  const r = m.press(62, 1620);
  assert.deepEqual(r[1], { kind: "outcome", step: 1, cycle: 1, outcome: "late", dtMs: 120, score: 57, matchedNotes: 1, missedNotes: 0 });
});

test("early chord then done", () => {
  const m = make();
  m.press(60, 1000);
  m.press(62, 1500);
  assert.equal(m.press(64, 1880).length, 1);
  const r = m.press(67, 1900);
  assert.deepEqual(r[1], { kind: "outcome", step: 2, cycle: 1, outcome: "early", dtMs: -110, score: 61, matchedNotes: 2, missedNotes: 0 });
  assert.deepEqual(r[2], { kind: "done" });
  assert.equal(m.done(), true);
});

test("missed on tick", () => {
  const m = make();
  assert.deepEqual(m.tick(1199), []);
  assert.deepEqual(m.tick(1201), [
    { kind: "outcome", step: 0, cycle: 1, outcome: "missed", dtMs: null, score: null, matchedNotes: 0, missedNotes: 1 },
  ]);
});

test("partial chord missed", () => {
  const m = make();
  m.press(64, 2000);
  const r = m.tick(2201);
  assert.ok(
    r.some(
      (x) => x.kind === "outcome" && x.step === 2 && x.outcome === "missed" && x.matchedNotes === 1 && x.missedNotes === 1,
    ),
  );
});

test("wrong notes", () => {
  assert.deepEqual(make().press(61, 1000), [{ kind: "wrong", step: 0, cycle: 1, note: 61, attempts: 1 }]);
  assert.deepEqual(pressAfterStep0(61, 1400), [{ kind: "wrong", step: 1, cycle: 1, note: 61, attempts: 1 }]);
  assert.deepEqual(pressAfterStep0(62, 1260), [{ kind: "wrong", step: 1, cycle: 1, note: 62, attempts: 1 }]);
});

test("repeated note after a hit is wrong", () => {
  const m = make();
  m.press(60, 1000);
  assert.deepEqual(m.press(60, 1050), [{ kind: "wrong", step: 0, cycle: 1, note: 60, attempts: 1 }]);
});

test("position", () => {
  const m = make();
  assert.deepEqual(m.position(750), { cycle: 1, step: -1, next: 0, frac: 0 });
  assert.deepEqual(m.position(1250), { cycle: 1, step: 0, next: 1, frac: 0.5 });
  assert.deepEqual(m.position(2100), { cycle: 1, step: 2, next: null, frac: 0 });
});

test("loop", () => {
  const m = make(3);
  assert.ok(m.tick(2500).some((x) => x.kind === "cycle" && x.cycle === 2));
  const r = m.press(60, 2510);
  assert.ok(r.some((x) => x.kind === "outcome" && x.outcome === "hit" && x.step === 0 && x.cycle === 2));
  assert.equal(m.done(), false);
  assert.deepEqual(m.position(2750), { cycle: 2, step: 0, next: 1, frac: 0.5 });
});

test("loop: early press announces the cycle once", () => {
  const m = make(3);
  m.tick(2300);
  const r = m.press(60, 2400);
  assert.deepEqual(r[0], { kind: "cycle", cycle: 2 });
  assert.equal(r[1].kind, "accepted");
  assert.deepEqual(m.tick(2500).filter((x) => x.kind === "cycle"), []);
});

test("before start", () => {
  const m = createLiveMatcher(STEPS, OPTS);
  assert.deepEqual(m.press(60, 1000), []);
  assert.deepEqual(m.tick(1000), []);
});

const TM = { msAt: (q: number) => (q <= 4 ? q * 500 : 2000 + (q - 4) * 1000), quartersAt: (ms: number) => (ms <= 2000 ? ms / 500 : 4 + (ms - 2000) / 1000) };
const E8 = Array.from({ length: 8 }, (_, k) => ({ pitches: [60 + k], time: k }));
const TOPTS = { msPerQuarter: 500, tempo: TM, windowMs: 200, onTimeMs: 80, loopQuarters: null };

test("tempo map: hits across a tempo change", () => {
  const m = createLiveMatcher(E8, TOPTS);
  m.start(1000);
  const at = [1000, 1500, 2000, 2500, 3000, 4000, 5000, 6000];
  const res = at.flatMap((t, i) => m.press(60 + i, t));
  assert.equal(res.filter((r) => r.kind === "outcome" && r.outcome === "hit").length, 8);
  assert.equal(res.filter((r) => r.kind === "done").length, 1);
});

test("tempo map: early press for step 5", () => {
  const m = createLiveMatcher(E8, TOPTS);
  m.start(1000);
  const res = m.press(65, 1000 + 3000 - 150);
  const o = res.find((r) => r.kind === "outcome" && r.step === 5);
  assert.ok(o && o.kind === "outcome" && o.outcome === "early" && o.dtMs === -150);
});

test("tempo map: position", () => {
  const m = createLiveMatcher(E8, TOPTS);
  m.start(1000);
  assert.deepEqual(m.position(1000 + 3500), { cycle: 1, step: 5, next: 6, frac: 0.5 });
});

test("tempo map: loop cycle boundary", () => {
  const m = createLiveMatcher(E8, { ...TOPTS, loopQuarters: 8 });
  m.start(1000);
  assert.ok(!m.tick(1000 + 5999).some((r) => r.kind === "cycle"));
  assert.ok(m.tick(1000 + 6000).some((r) => r.kind === "cycle" && r.cycle === 2));
});

test("tempo map: wrong note nearest step", () => {
  const m = createLiveMatcher(E8, TOPTS);
  m.start(1000);
  const res = m.press(90, 1000 + 3000);
  assert.ok(res.some((r) => r.kind === "wrong" && r.step === 5));
});
