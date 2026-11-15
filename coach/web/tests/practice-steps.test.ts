import { test } from "node:test";
import assert from "node:assert/strict";
import { inHand, practicePlan } from "../src/practice-steps.ts";
import type { PlanSourceStep } from "../src/practice-steps.ts";

const TL: PlanSourceStep[] = [
  { index: 0, written: 0, bar: 1, beat: 0, time: 0, writtenTime: 0, measureQuarters: 4, notes: [{ midi: 60, staff: 0 }, { midi: 48, staff: 1 }] },
  { index: 1, written: 1, bar: 2, beat: 0, time: 4, writtenTime: 4, measureQuarters: 4, notes: [{ midi: 62, staff: 0 }] },
  { index: 2, written: 2, bar: 2, beat: 2, time: 6, writtenTime: 6, measureQuarters: 4, notes: [{ midi: 50, staff: 1 }] },
  { index: 3, written: 0, bar: 1, beat: 0, time: 8, writtenTime: 0, measureQuarters: 4, notes: [{ midi: 60, staff: 0 }, { midi: 48, staff: 1 }] },
  { index: 4, written: 3, bar: 3, beat: 1, time: 13, writtenTime: 9, measureQuarters: 4, notes: [{ midi: 64, staff: 0 }] },
];

const summary = (p: ReturnType<typeof practicePlan>) => ({
  sources: p.steps.map((s) => s.source),
  times: p.steps.map((s) => s.time),
  pitches: p.steps.map((s) => s.pitches),
});

test("inHand for all hands", () => {
  assert.equal(inHand(0, "both"), true);
  assert.equal(inHand(1, "both"), true);
  assert.equal(inHand(0, "right"), true);
  assert.equal(inHand(1, "right"), false);
  assert.equal(inHand(0, "left"), false);
  assert.equal(inHand(2, "left"), true);
});

test("both hands, no range", () => {
  const p = practicePlan(TL, { hands: "both", range: null, loop: false });
  assert.deepEqual(summary(p), { sources: [0, 1, 2, 3, 4], times: [0, 4, 6, 8, 13], pitches: [[48, 60], [62], [50], [48, 60], [64]] });
  assert.deepEqual(p.steps.map((s) => s.index), [0, 1, 2, 3, 4]);
  assert.equal(p.lengthQuarters, 16);
  assert.equal(p.firstBar, 1);
  assert.equal(p.lastBar, 3);
});

test("right hand", () => {
  const p = practicePlan(TL, { hands: "right", range: null, loop: false });
  assert.deepEqual(p.steps.map((s) => s.source), [0, 1, 3, 4]);
  assert.deepEqual(p.steps.map((s) => s.pitches), [[60], [62], [60], [64]]);
  assert.deepEqual(p.steps.map((s) => s.index), [0, 1, 2, 3]);
});

test("left hand", () => {
  const p = practicePlan(TL, { hands: "left", range: null, loop: false });
  assert.deepEqual(p.steps.map((s) => s.source), [0, 2, 3]);
  assert.deepEqual(p.steps.map((s) => s.pitches), [[48], [50], [48]]);
  assert.equal(p.lengthQuarters, 12);
});

test("range 2-3", () => {
  const p = practicePlan(TL, { hands: "both", range: { from: 2, to: 3 }, loop: false });
  assert.deepEqual(summary(p).sources, [1, 2, 4]);
  assert.deepEqual(summary(p).times, [0, 2, 5]);
  assert.equal(p.lengthQuarters, 8);
  assert.equal(p.firstBar, 2);
  assert.equal(p.lastBar, 3);
});

test("range 1-1 without loop equals no range", () => {
  const a = practicePlan(TL, { hands: "both", range: { from: 1, to: 1 }, loop: false });
  const b = practicePlan(TL, { hands: "both", range: null, loop: false });
  assert.deepEqual(a, b);
});

test("range 2-2 without loop", () => {
  const p = practicePlan(TL, { hands: "both", range: { from: 2, to: 2 }, loop: false });
  assert.deepEqual(summary(p).sources, [1, 2, 3, 4]);
  assert.deepEqual(summary(p).times, [0, 2, 4, 9]);
  assert.equal(p.lengthQuarters, 12);
});

test("range 1-1 with loop", () => {
  const p = practicePlan(TL, { hands: "both", range: { from: 1, to: 1 }, loop: true });
  assert.deepEqual(summary(p).sources, [0]);
  assert.deepEqual(summary(p).times, [0]);
  assert.equal(p.lengthQuarters, 4);
});

test("range 3-3 with loop", () => {
  const p = practicePlan(TL, { hands: "both", range: { from: 3, to: 3 }, loop: true });
  assert.deepEqual(summary(p).sources, [4]);
  assert.deepEqual(summary(p).times, [1]);
  assert.equal(p.lengthQuarters, 4);
});

test("range outside the score gives the empty plan", () => {
  const p = practicePlan(TL, { hands: "both", range: { from: 5, to: 6 }, loop: false });
  assert.deepEqual(p, { steps: [], lengthQuarters: 0, firstBar: null, lastBar: null, tempo: [] });
});

const TL2: PlanSourceStep[] = [
  { index: 0, written: 0, bar: 1, beat: 0, time: 0, writtenTime: 0, measureQuarters: 4, bpm: 120, notes: [{ midi: 60, staff: 0, quarters: 2 }, { midi: 48, staff: 1, quarters: 4 }] },
  { index: 1, written: 1, bar: 1, beat: 2, time: 2, writtenTime: 2, measureQuarters: 4, bpm: 120, notes: [{ midi: 62, staff: 0, quarters: 2 }] },
  { index: 2, written: 2, bar: 2, beat: 1, time: 5, writtenTime: 5, measureQuarters: 4, bpm: 60, notes: [{ midi: 64, staff: 0, quarters: 1 }] },
  { index: 3, written: 3, bar: 3, beat: 0, time: 8, writtenTime: 8, measureQuarters: 4, bpm: 60, notes: [{ midi: 65, staff: 0, quarters: 4 }] },
];

test("tempo map and lengths on TL2", () => {
  const p = practicePlan(TL2, { hands: "both", range: null, loop: false });
  assert.deepEqual(p.tempo, [{ q: 0, bpm: 120 }, { q: 4, bpm: 60 }]);
  assert.deepEqual(p.steps[0].pitches, [48, 60]);
  assert.deepEqual(p.steps[0].lengths, [4, 2]);
  assert.deepEqual(p.steps[1].lengths, [2]);
  assert.deepEqual(p.steps[2].lengths, [1]);
});

test("right hand lengths on TL2", () => {
  const p = practicePlan(TL2, { hands: "right", range: null, loop: false });
  assert.deepEqual(p.steps[0].lengths, [2]);
});

test("tempo map for a bar range", () => {
  const p = practicePlan(TL2, { hands: "both", range: { from: 2, to: 3 }, loop: false });
  assert.deepEqual(p.tempo, [{ q: 0, bpm: 60 }]);
});

test("timeline without bpm or quarters", () => {
  const p = practicePlan(TL, { hands: "both", range: null, loop: false });
  assert.deepEqual(p.tempo, []);
  assert.deepEqual(p.steps[0].lengths, [0, 0]);
});
