import { test } from "node:test";
import assert from "node:assert/strict";
import {
  categoryStats,
  cleanText,
  compareLast,
  earRoundStats,
  earTreeHasDrills,
  liveStatsText,
  roundsOfLevel,
  stepMs,
  summaryModel,
  trendChart,
} from "../src/ear-stats.ts";
import type { EarRoundStats } from "../src/ear-stats.ts";
import { LEVELS } from "../src/ear-levels.ts";
import type { EarRound, EarRoundItem } from "../src/ear-levels.ts";
import type { PlanTree } from "../src/skills-logic.ts";

const item = (over: Partial<EarRoundItem> = {}): EarRoundItem => ({
  category: "Interval",
  first_try: true,
  response_ms: 1000,
  answer_steps: 1,
  replays: 0,
  revealed: false,
  ...over,
});

const round = (over: Partial<EarRound> = {}): EarRound => ({
  id: "r",
  started_at: "2026-11-06T20:00:00.000Z",
  level: "echo-1",
  drill_id: null,
  end: "done",
  accuracy: 1,
  median_step_ms: 1000,
  replays: 0,
  items: [item()],
  ...over,
});

const stats = (accuracy: number | null, medianStepMs: number | null): EarRoundStats => ({
  items: 10,
  firstTry: 0,
  accuracy,
  medianStepMs,
  replays: 0,
  revealed: 0,
});

test("stepMs divides by the answer steps, at least one", () => {
  assert.equal(stepMs({ response_ms: 3000, answer_steps: 3 }), 1000);
  assert.equal(stepMs({ response_ms: 3000, answer_steps: 0 }), 3000);
  assert.equal(stepMs({ response_ms: null, answer_steps: 2 }), null);
});

test("earRoundStats counts items, first tries, replays and reveals", () => {
  const records = [
    item({ first_try: true, response_ms: 1000, replays: 1 }),
    item({ first_try: true, response_ms: 2000, replays: 0 }),
    item({ first_try: false, response_ms: null, replays: 2, revealed: true }),
    item({ first_try: true, response_ms: 4000, replays: 0 }),
  ];
  const s = earRoundStats(records);
  assert.equal(s.items, 4);
  assert.equal(s.firstTry, 3);
  assert.equal(s.accuracy, 0.75);
  assert.equal(s.medianStepMs, 2000);
  assert.equal(s.replays, 3);
  assert.equal(s.revealed, 1);
});

test("earRoundStats with no items has null accuracy and median", () => {
  const s = earRoundStats([]);
  assert.equal(s.items, 0);
  assert.equal(s.accuracy, null);
  assert.equal(s.medianStepMs, null);
});

test("roundsOfLevel filters by level and keeps the last N", () => {
  const rounds = [
    round({ id: "a", level: "echo-1" }),
    round({ id: "b", level: "echo-2" }),
    round({ id: "c", level: "echo-1" }),
    round({ id: "d", level: "echo-1" }),
  ];
  assert.deepEqual(roundsOfLevel(rounds, "echo-1").map((r) => r.id), ["a", "c", "d"]);
  assert.deepEqual(roundsOfLevel(rounds, "echo-1", 2).map((r) => r.id), ["c", "d"]);
  assert.deepEqual(roundsOfLevel(rounds, "echo-9"), []);
});

test("compareLast uses the last five rounds of the level with items", () => {
  const prior = [
    round({ accuracy: 0.2, median_step_ms: 9000 }),
    round({ accuracy: 1, median_step_ms: 1000 }),
    round({ accuracy: 0.5, median_step_ms: 2000 }),
    round({ accuracy: 1, median_step_ms: 1000 }),
    round({ accuracy: 0.5, median_step_ms: 2000 }),
    round({ accuracy: 1, median_step_ms: 3000 }),
    round({ level: "echo-2", accuracy: 0, median_step_ms: 99000 }),
    round({ items: [], accuracy: null, median_step_ms: null }),
  ];
  const c = compareLast(prior, "echo-1");
  assert.equal(c.rounds, 5);
  assert.equal(c.accuracy, 0.8);
  assert.equal(c.medianStepMs, 1800);
});

test("compareLast with no earlier rounds has null means", () => {
  assert.deepEqual(compareLast([], "echo-1"), { rounds: 0, accuracy: null, medianStepMs: null });
});

test("categoryStats sorts by share ascending, then category", () => {
  const rounds = [
    round({
      items: [
        item({ category: "Interval", first_try: true }),
        item({ category: "Interval", first_try: false }),
        item({ category: "Chord", first_try: true }),
        item({ category: "Chord", first_try: true }),
        item({ category: "Scale", first_try: false }),
      ],
    }),
    round({
      items: [item({ category: "Alpha", first_try: true }), item({ category: "Alpha", first_try: false })],
    }),
  ];
  assert.deepEqual(categoryStats(rounds), [
    { category: "Scale", items: 1, firstTry: 0, share: 0 },
    { category: "Alpha", items: 2, firstTry: 1, share: 0.5 },
    { category: "Interval", items: 2, firstTry: 1, share: 0.5 },
    { category: "Chord", items: 2, firstTry: 2, share: 1 },
  ]);
});

test("cleanText reports stopped and unchanged-settings rounds first", () => {
  assert.equal(cleanText(stats(1, 1000), "note", false, true), "Stopped early: only finished rounds count.");
  assert.equal(cleanText(stats(1, 1000), "note", false, false), "Stopped early: only finished rounds count.");
  assert.equal(
    cleanText(stats(1, 1000), "note", true, false),
    "Changed settings: this round does not count toward a drill.",
  );
});

test("cleanText checks the 90% first-try edge", () => {
  assert.equal(cleanText(stats(0.85, 1000), "note", true, true), "First try 85%: Good enough needs 90%.");
  assert.equal(cleanText(stats(0.895, 1000), "note", true, true), "First try 89%: Good enough needs 90%.");
  assert.equal(cleanText(stats(0.9, 5000), "note", true, true), "Counts toward Good enough.");
});

test("cleanText checks the good target edge for the median", () => {
  assert.equal(
    cleanText(stats(0.9, 5001), "note", true, true),
    "Median 5.0 s per answer: Good enough needs 5.0 s or less.",
  );
  assert.equal(cleanText(stats(0.9, 8000), "chord", true, true), "Counts toward Good enough.");
});

test("cleanText checks the 95% and solid target edges", () => {
  assert.equal(cleanText(stats(0.95, 3000), "note", true, true), "Counts toward Solid and Good enough.");
  assert.equal(cleanText(stats(0.95, 3001), "note", true, true), "Counts toward Good enough.");
  assert.equal(cleanText(stats(0.94, 1000), "note", true, true), "Counts toward Good enough.");
});

test("liveStatsText shows the question, first tries and median when known", () => {
  const s: EarRoundStats = { items: 2, firstTry: 2, accuracy: 1, medianStepMs: 1800, replays: 0, revealed: 0 };
  assert.equal(liveStatsText(3, 10, s), "Question 3 of 10 · first try 2 of 2 · median 1.8 s");
  assert.equal(liveStatsText(1, 10, { ...s, medianStepMs: null }), "Question 1 of 10 · first try 2 of 2");
});

test("summaryModel gives rows, the comparison and the clean text", () => {
  const level = LEVELS[0];
  const records = [item({ first_try: true, response_ms: 2000, replays: 1 }), item({ first_try: false, response_ms: 4000, revealed: true })];

  const first = summaryModel(records, [], level, true, true);
  assert.deepEqual(first.rows, [
    ["First try", "1 of 2 (50%)"],
    ["Median time per answer", "3.0 s"],
    ["Replays", "1"],
    ["Revealed", "1"],
  ]);
  assert.equal(first.compare, "First round on this level.");
  assert.equal(first.clean, cleanText(earRoundStats(records), level.kind, true, true));

  const later = summaryModel(records, [round({ accuracy: 1, median_step_ms: 1000 })], level, true, true);
  assert.equal(
    later.compare,
    "First try 100% vs 50%, median 1.0 s vs 3.0 s over the last round.",
  );
});

test("trendChart spaces points evenly and scales y to the chart height", () => {
  const rounds = [
    round({ accuracy: 0.5, median_step_ms: 1000 }),
    round({ accuracy: null, median_step_ms: 2000 }),
    round({ accuracy: 1, median_step_ms: null }),
  ];
  const t = trendChart(rounds, 100, 50);
  assert.equal(t.maxMs, 2000);
  assert.deepEqual(t.accuracy, [
    { x: 0, y: 25 },
    { x: 100, y: 0 },
  ]);
  assert.deepEqual(t.time, [
    { x: 0, y: 25 },
    { x: 50, y: 0 },
  ]);
});

test("trendChart shows only the last 20 rounds by default", () => {
  const many = Array.from({ length: 25 }, (_, i) => round({ accuracy: i % 2 === 0 ? 1 : 0.5, median_step_ms: 1000 }));
  const t = trendChart(many, 100, 50);
  assert.equal(t.accuracy.length, 20);
  assert.equal(t.time.length, 20);
  assert.equal(t.accuracy[19].x, 100);
  assert.equal(trendChart(many, 100, 50, 5).accuracy.length, 5);
});

test("trendChart with no rounds is empty and has a usable max", () => {
  assert.deepEqual(trendChart([], 100, 50), { accuracy: [], time: [], maxMs: 1 });
});

test("earTreeHasDrills finds an ear drill id in any node", () => {
  const tree = (id: string) =>
    ({
      version: 1,
      kind: "skills",
      decay_days: 30,
      tracks: [],
      nodes: [
        { id: "a", track: "t", title: "A", requires: [], drills: [] },
        { id: "b", track: "t", title: "B", requires: [], drills: [{ id }] },
      ],
    }) as unknown as PlanTree;
  assert.equal(earTreeHasDrills(tree("ear.echo-1")), true);
  assert.equal(earTreeHasDrills(tree("sr.r2-treble")), false);
});
