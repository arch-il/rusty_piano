import { test } from "node:test";
import assert from "node:assert/strict";
import { createLiveMatcher } from "../src/live-matcher.ts";

const STEPS = [
  { pitches: [60], time: 0 },
  { pitches: [62], time: 1 },
  { pitches: [64], time: 2 },
];
const BASE = { msPerQuarter: 500, windowMs: 200, onTimeMs: 80, loopQuarters: 4 };

function make(scale?: (n: number) => number) {
  const calls: number[] = [];
  const m = createLiveMatcher(STEPS, {
    ...BASE,
    cycleScale: (n) => {
      calls.push(n);
      return scale ? scale(n) : n === 2 ? 2 : 1;
    },
  });
  m.start(1000);
  return { m, calls };
}

test("cycleScale is asked once, windowMs before the cycle starts", () => {
  const { m, calls } = make();
  m.tick(2799);
  assert.deepEqual(calls, []);
  m.tick(2800);
  assert.deepEqual(calls, [2]);
  m.tick(3500);
  assert.deepEqual(calls, [2]);
  m.tick(3799);
  assert.deepEqual(calls, [2]);
  m.tick(3800);
  assert.deepEqual(calls, [2, 3]);
});

test("presses are judged against the scaled cycle", () => {
  const { m } = make();
  m.tick(2800);
  const a = m.press(62, 3250);
  assert.ok(a.some((r) => r.kind === "outcome" && r.step === 1 && r.cycle === 2 && r.outcome === "hit" && r.dtMs === 0));
  const b = m.press(64, 3510);
  assert.ok(b.some((r) => r.kind === "outcome" && r.step === 2 && r.cycle === 2 && r.dtMs === 10));
});

test("position follows the scaled cycles", () => {
  const { m } = make();
  m.tick(2800);
  assert.deepEqual(m.position(3125), { cycle: 2, step: 0, next: 1, frac: 0.5 });
  assert.deepEqual(m.position(4250), { cycle: 3, step: 0, next: 1, frac: 0.5 });
});

test("cycle announcement uses scaled start", () => {
  const { m } = make();
  m.tick(2800);
  assert.ok(!m.tick(3999).some((r) => r.kind === "cycle" && r.cycle === 3));
  assert.ok(m.tick(4000).some((r) => r.kind === "cycle" && r.cycle === 3));
});

test("wrong note uses scaled cycle", () => {
  const { m } = make();
  m.tick(2800);
  const r = m.press(90, 3260);
  assert.ok(r.some((x) => x.kind === "wrong" && x.step === 1 && x.cycle === 2));
});

test("cycleTiming", () => {
  const { m } = make();
  assert.deepEqual(m.cycleTiming(1), { start: 1000, scale: 1 });
  assert.deepEqual(m.cycleTiming(2), { start: 3000, scale: 2 });
  assert.deepEqual(m.cycleTiming(3), { start: 4000, scale: 1 });
  const flat = createLiveMatcher(STEPS, { ...BASE, loopQuarters: null });
  flat.start(1000);
  assert.equal(flat.cycleTiming(1), null);
});

test("invalid scales count as 1", () => {
  for (const bad of [0, -1, NaN, Infinity]) {
    const { m } = make(() => bad);
    m.tick(2800);
    assert.deepEqual(m.cycleTiming(2), { start: 3000, scale: 1 });
    const r = m.press(62, 3500);
    assert.ok(r.some((x) => x.kind === "outcome" && x.step === 1 && x.outcome === "hit" && x.dtMs === 0));
  }
});
