import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_CUSTOM,
  LEVELS,
  SPEED_TARGETS_MS,
  formatSeconds,
  levelById,
  median,
  normalizeCustom,
  roundStats,
} from "../src/sight-levels.ts";
import type { SightStepRecord } from "../src/sight-levels.ts";

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/sight-levels.json", import.meta.url)), "utf8"),
);

test("LEVELS matches the fixture ladder in order", () => {
  const expected = fixture.levels.map((e: Record<string, unknown>) => ({
    id: e.level,
    node: e.node,
    drill: e.drill,
    kind: e.kind,
    hands: e.hands,
    clef: e.clef,
    cards: e.cards,
    title: e.title,
  }));
  assert.deepEqual(LEVELS.slice(0, 9), expected);
});

test("LEVELS ends with the custom level from the fixture", () => {
  const custom = LEVELS[9];
  assert.equal(custom.id, fixture.custom.level);
  assert.equal(custom.drill, fixture.custom.drill);
  assert.equal(custom.kind, fixture.custom.kind);
  assert.deepEqual(custom, {
    id: "custom",
    node: null,
    drill: "sr.custom",
    kind: "notes",
    hands: "both",
    clef: "treble",
    cards: 20,
    title: "Custom range",
  });
});

test("SPEED_TARGETS_MS equals the fixture targets", () => {
  assert.deepEqual(SPEED_TARGETS_MS, fixture.targets_ms);
});

test("levelById finds a ladder level and returns null for unknown ids", () => {
  assert.equal(levelById("r5-intervals")?.kind, "intervals");
  assert.equal(levelById("r8c-hands")?.clef, "grand");
  assert.equal(levelById("nope"), null);
});

test("normalizeCustom fills missing fields from the defaults", () => {
  assert.deepEqual(normalizeCustom({}), DEFAULT_CUSTOM);
  assert.deepEqual(normalizeCustom({}), { clef: "treble", low: 60, high: 72, accidentals: false });
});

test("normalizeCustom clamps to the key range", () => {
  const r = normalizeCustom({ clef: "bass", low: 30, high: 90, accidentals: true });
  assert.deepEqual(r, { clef: "bass", low: 36, high: 84, accidentals: true });
});

test("normalizeCustom swaps a reversed range", () => {
  const r = normalizeCustom({ low: 72, high: 60 });
  assert.equal(r.low, 60);
  assert.equal(r.high, 72);
});

test("normalizeCustom drops non-integer bounds back to the defaults", () => {
  const r = normalizeCustom({ low: 50.5, high: 70 });
  assert.equal(r.low, 60);
  assert.equal(r.high, 70);
});

test("normalizeCustom turns accidentals on when the range has no white key", () => {
  const r = normalizeCustom({ low: 61, high: 61, accidentals: false });
  assert.equal(r.accidentals, true);
  const kept = normalizeCustom({ low: 48, high: 55, accidentals: false });
  assert.equal(kept.accidentals, false);
});

test("median handles odd, even and empty inputs", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), null);
});

test("formatSeconds shows a dash for null and one decimal otherwise", () => {
  assert.equal(formatSeconds(null), "-");
  assert.equal(formatSeconds(1234), "1.2 s");
  assert.equal(formatSeconds(2000), "2.0 s");
});

function record(first_try: boolean, reaction_ms: number, hinted: boolean, wrong_count: number): SightStepRecord {
  return {
    step: 0,
    card: 0,
    notes: [60],
    result: first_try ? "hit" : "wrong",
    first_try,
    wrong_count,
    wrong_notes: [],
    hinted,
    reaction_ms,
    shown_page_ms: 0,
    done_page_ms: reaction_ms,
  };
}

test("roundStats summarises a round", () => {
  const stats = roundStats([
    record(true, 1000, false, 0),
    record(true, 2000, true, 2),
    record(false, 3000, false, 1),
  ]);
  assert.deepEqual(stats, {
    steps: 3,
    firstTry: 2,
    accuracy: 2 / 3,
    medianMs: 2000,
    meanMs: 2000,
    hinted: 1,
    wrongNotes: 3,
  });
});

test("roundStats on no steps gives nulls", () => {
  assert.deepEqual(roundStats([]), {
    steps: 0,
    firstTry: 0,
    accuracy: null,
    medianMs: null,
    meanMs: null,
    hinted: 0,
    wrongNotes: 0,
  });
});
