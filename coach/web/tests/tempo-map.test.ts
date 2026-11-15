import { test } from "node:test";
import assert from "node:assert/strict";
import { createTempoMap } from "../src/tempo-map.ts";

const two = [
  { q: 0, bpm: 120 },
  { q: 8, bpm: 60 },
];

test("empty map uses fallback", () => {
  const m = createTempoMap([]);
  assert.equal(m.bpmAt(0), 120);
  assert.equal(m.msAt(2), 1000);
  assert.equal(createTempoMap([], 1, 80).msAt(1), 750);
});

test("two segments", () => {
  const m = createTempoMap(two);
  assert.equal(m.msAt(8), 4000);
  assert.equal(m.msAt(10), 6000);
  assert.equal(m.quartersAt(6000), 10);
  assert.equal(m.quartersAt(2000), 4);
  assert.equal(m.bpmAt(7.9), 120);
  assert.equal(m.bpmAt(8), 60);
  assert.equal(m.bpmAt(100), 60);
  assert.equal(m.msAt(-1), -500);
  assert.equal(m.quartersAt(-500), -1);
});

test("scale", () => {
  const m = createTempoMap(two, 0.5);
  assert.equal(m.msAt(8), 8000);
  assert.equal(m.bpmAt(9), 30);
  assert.deepEqual(m.changes(), [
    { q: 0, bpm: 60 },
    { q: 8, bpm: 30 },
  ]);
});

test("first entry forced to q 0", () => {
  const m = createTempoMap([{ q: 4, bpm: 60 }]);
  assert.equal(m.msAt(2), 2000);
  assert.equal(m.changes()[0].q, 0);
});

test("sort, later wins, merge equal bpm", () => {
  const m = createTempoMap([
    { q: 8, bpm: 60 },
    { q: 0, bpm: 120 },
    { q: 8, bpm: 90 },
    { q: 12, bpm: 90 },
  ]);
  assert.deepEqual(m.changes(), [
    { q: 0, bpm: 120 },
    { q: 8, bpm: 90 },
  ]);
});

test("invalid entries ignored", () => {
  const m = createTempoMap([
    { q: 0, bpm: 0 },
    { q: NaN, bpm: 100 },
  ]);
  assert.deepEqual(m.changes(), [{ q: 0, bpm: 120 }]);
});

test("round trip", () => {
  const m = createTempoMap(two);
  for (const q of [0, 3.5, 8, 11.25]) {
    assert.ok(Math.abs(m.quartersAt(m.msAt(q)) - q) < 1e-9);
  }
});
