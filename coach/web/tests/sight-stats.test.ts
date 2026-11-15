import { test } from "node:test";
import assert from "node:assert/strict";
import { keyLayout } from "../src/piano-keys.ts";
import { KEY_HIGH, KEY_LOW, levelById, roundStats } from "../src/sight-levels.ts";
import type { RoundStats, SightRound, SightRoundStep, SightStepRecord } from "../src/sight-levels.ts";
import {
  cleanText,
  compareLast,
  liveStatsText,
  noteMap,
  noteMapKeys,
  noteWeights,
  recordNoteStats,
  roundsOfLevel,
  summaryModel,
  trendChart,
  weakest,
} from "../src/sight-stats.ts";
import type { NoteStat } from "../src/sight-stats.ts";

function step(notes: number[], first_try: boolean, reaction_ms: number | null): SightRoundStep {
  return { notes, first_try, reaction_ms, hinted: false, wrong_count: first_try ? 0 : 1 };
}

function rec(notes: number[], first_try: boolean, reaction_ms: number, extra: Partial<SightStepRecord> = {}): SightStepRecord {
  return {
    step: 1,
    card: 1,
    notes,
    result: first_try ? "hit" : "wrong",
    first_try,
    wrong_count: first_try ? 0 : 1,
    wrong_notes: [],
    hinted: false,
    reaction_ms,
    shown_page_ms: 0,
    done_page_ms: 0,
    ...extra,
  };
}

function round(over: Partial<SightRound> & { id: string }): SightRound {
  return {
    started_at: "2026-11-06T09:00:00",
    level: "r2-treble",
    drill_id: null,
    end: "2026-11-06T09:10:00",
    accuracy: null,
    median_ms: null,
    steps: [],
    ...over,
  };
}

function stats(over: Partial<RoundStats> = {}): RoundStats {
  return { steps: 10, firstTry: 10, accuracy: 1, medianMs: 1000, meanMs: 1000, hinted: 0, wrongNotes: 0, ...over };
}

test("roundsOfLevel keeps only the level, in input order, and the last N when given", () => {
  const rounds = [
    round({ id: "a", level: "r2-treble" }),
    round({ id: "b", level: "r3-bass" }),
    round({ id: "c", level: "r2-treble" }),
    round({ id: "d", level: "r2-treble" }),
  ];
  assert.deepEqual(roundsOfLevel(rounds, "r2-treble").map((r) => r.id), ["a", "c", "d"]);
  assert.deepEqual(roundsOfLevel(rounds, "r2-treble", 2).map((r) => r.id), ["c", "d"]);
  assert.deepEqual(roundsOfLevel(rounds, "r2-treble", 10).map((r) => r.id), ["a", "c", "d"]);
  assert.deepEqual(roundsOfLevel(rounds, "r6-ledger"), []);
});

test("recordNoteStats counts a step once per pitch, sorted by midi", () => {
  const records = [
    rec([64, 60], true, 1000),
    rec([60, 60], false, 3000),
    rec([60], true, 2000),
  ];
  assert.deepEqual(recordNoteStats(records), [
    { midi: 60, n: 3, firstTry: 2, rate: 2 / 3, medianMs: 2000 },
    { midi: 64, n: 1, firstTry: 1, rate: 1, medianMs: 1000 },
  ]);
});

test("recordNoteStats gives a null median when a pitch has no times", () => {
  const stats = recordNoteStats([rec([67], true, 1200)]);
  assert.deepEqual(stats, [{ midi: 67, n: 1, firstTry: 1, rate: 1, medianMs: 1200 }]);
  assert.deepEqual(recordNoteStats([]), []);
});

test("noteMap reads the round steps and skips null reaction times", () => {
  const rounds = [
    round({
      id: "a",
      steps: [step([60], true, 1000), step([60], false, null), step([62], true, null)],
    }),
    round({ id: "b", steps: [step([60], true, 3000)] }),
  ];
  assert.deepEqual(noteMap(rounds), [
    { midi: 60, n: 3, firstTry: 2, rate: 2 / 3, medianMs: 2000 },
    { midi: 62, n: 1, firstTry: 1, rate: 1, medianMs: null },
  ]);
});

test("noteWeights skips unseen pitches and adds the miss and slowness terms", () => {
  const stats: NoteStat[] = [
    { midi: 60, n: 4, firstTry: 4, rate: 1, medianMs: 1000 },
    { midi: 61, n: 2, firstTry: 0, rate: 0, medianMs: null },
    { midi: 62, n: 2, firstTry: 1, rate: 0.5, medianMs: 4000 },
    { midi: 63, n: 0, firstTry: 0, rate: 0, medianMs: null },
  ];
  const weights = noteWeights(stats, "notes");
  assert.equal(weights.get(60), 1);
  assert.equal(weights.get(61), 4);
  assert.equal(weights.get(62), 4.5);
  assert.equal(weights.has(63), false);
  assert.equal(weights.size, 3);
});

test("noteWeights uses the level kind's good target", () => {
  const stats: NoteStat[] = [{ midi: 70, n: 3, firstTry: 3, rate: 1, medianMs: 1500 }];
  assert.equal(noteWeights(stats, "bars").get(70), 2);
  assert.equal(noteWeights(stats, "notes").get(70), 1.5);
});

test("weakest sorts by rate, then slowest median first with nulls last", () => {
  const stats: NoteStat[] = [
    { midi: 60, n: 2, firstTry: 1, rate: 0.5, medianMs: 1000 },
    { midi: 62, n: 2, firstTry: 1, rate: 0.5, medianMs: 3000 },
    { midi: 64, n: 2, firstTry: 1, rate: 0.5, medianMs: null },
    { midi: 65, n: 1, firstTry: 0, rate: 0, medianMs: 500 },
    { midi: 66, n: 0, firstTry: 0, rate: 0, medianMs: null },
  ];
  assert.deepEqual(weakest(stats).map((s) => s.midi), [65, 62, 60, 64]);
  assert.deepEqual(weakest(stats, 2).map((s) => s.midi), [65, 62]);
  assert.deepEqual(weakest([]), []);
});

test("compareLast averages the last N rounds with steps, ignoring nulls", () => {
  const prior = [
    round({ id: "old", steps: [step([60], true, 1000)], accuracy: 0.5, median_ms: 1000 }),
    round({ id: "empty", steps: [], accuracy: null, median_ms: null }),
    round({ id: "other", level: "r3-bass", steps: [step([48], true, 1000)], accuracy: 0, median_ms: 9000 }),
    round({ id: "new", steps: [step([60], true, null)], accuracy: 1, median_ms: null }),
  ];
  assert.deepEqual(compareLast(prior, "r2-treble"), { prevRounds: 2, prevAccuracy: 0.75, prevMedianMs: 1000 });
  assert.deepEqual(compareLast(prior, "r2-treble", 1), { prevRounds: 1, prevAccuracy: 1, prevMedianMs: null });
  assert.deepEqual(compareLast([], "r2-treble"), { prevRounds: 0, prevAccuracy: null, prevMedianMs: null });
});

test("cleanText reports custom and stopped rounds before the speed levels", () => {
  assert.equal(cleanText(stats(), "notes", true, false), "Custom rounds are saved but do not count toward skills.");
  assert.equal(
    cleanText(stats(), "notes", false, true),
    "Stopped early: saved, but only full rounds count toward skills.",
  );
});

test("cleanText lists the levels that are met", () => {
  assert.equal(cleanText(stats({ accuracy: 1, medianMs: 1000 }), "notes", true, true), "Clean run for: Good enough, Solid");
  assert.equal(cleanText(stats({ accuracy: 0.96, medianMs: 1900 }), "notes", true, true), "Clean run for: Good enough");
  assert.equal(
    cleanText(stats({ accuracy: 1, medianMs: 700 }), "notes", true, true),
    "Clean run for: Good enough, Solid, Mastered",
  );
  assert.equal(
    cleanText(stats({ accuracy: 0.9, medianMs: 500 }), "notes", true, true),
    "Not clean yet: needs 95% first try and a median of at most 2.0 s.",
  );
  assert.equal(
    cleanText(stats({ accuracy: 1, medianMs: null }), "intervals", true, true),
    "Not clean yet: needs 95% first try and a median of at most 3.0 s.",
  );
});

test("liveStatsText shows the running numbers and the empty prompt", () => {
  const records = [rec([60], true, 1000), rec([62], true, 1200)];
  assert.equal(
    liveStatsText(3, 20, roundStats(records), 900),
    "Card 3 of 20 | First try 2 of 2 (100%) | Median 1.1 s | Last 0.9 s",
  );
  assert.equal(liveStatsText(1, 20, roundStats([]), null), "Card 1 of 20 | Play the note you see");
});

test("summaryModel builds the rows, best and needs-work lines from the records", () => {
  const level = levelById("r2-treble");
  assert.ok(level);
  const records = [
    rec([60], true, 1000),
    rec([60, 64], true, 1400, { card: 2 }),
    rec([64], false, 3000, { hinted: true, wrong_count: 2, wrong_notes: [65] }),
    rec([67], true, 500),
  ];
  const prior = [round({ id: "p", steps: [step([60], true, 1000)], accuracy: 0.85, median_ms: 1400 })];
  const model = summaryModel(records, level, prior, true, 2, 20);
  assert.deepEqual(model.rows, [
    ["Level", "Treble C-G notes"],
    ["Cards", "2 of 20"],
    ["First try", "3 of 4 (75%)"],
    ["Median time", "1.2 s"],
    ["Last 5 rounds", "first try 85% vs 75%, median 1.4 s vs 1.2 s"],
    ["Hinted", "1"],
    ["Wrong notes", "2"],
  ]);
  assert.equal(model.best, "Best: G4, C4");
  assert.equal(model.worst, "Needs work: E4 (50%, 2.2 s)");
  assert.equal(model.clean, "Not clean yet: needs 95% first try and a median of at most 2.0 s.");
});

test("summaryModel handles no earlier rounds, bars phrases and custom levels", () => {
  const bars = levelById("r8a-five");
  const custom = levelById("custom");
  assert.ok(bars && custom);
  const empty = summaryModel([], bars, [], true, 0, 4);
  assert.equal(empty.rows[0][1], "Phrases: five-finger");
  assert.equal(empty.rows[1][0], "Phrases");
  assert.equal(empty.rows[1][1], "0 of 4");
  assert.equal(empty.rows[2][1], "0 of 0 (0%)");
  assert.equal(empty.rows[3][1], "-");
  assert.equal(empty.rows[4][1], "No earlier rounds yet");
  assert.equal(empty.best, "Best: -");
  assert.equal(empty.worst, "Needs work: none");
  const cust = summaryModel([rec([60], true, 1000)], custom, [], true, 1, 20);
  assert.equal(cust.clean, "Custom rounds are saved but do not count toward skills.");
  const stopped = summaryModel([rec([60], true, 1000)], bars, [], false, 1, 4);
  assert.equal(stopped.clean, "Stopped early: saved, but only full rounds count toward skills.");
});

test("trendChart places points, breaks lines on gaps and labels each new date", () => {
  const rounds = [
    round({ id: "a", started_at: "2026-11-05T10:00:00", accuracy: 0.5, median_ms: 1000 }),
    round({ id: "b", started_at: "2026-11-05T11:00:00", accuracy: null, median_ms: null }),
    round({ id: "c", started_at: "2026-11-06T09:00:00", accuracy: 1, median_ms: 2600 }),
    round({ id: "d", started_at: "2026-11-06T10:00:00", accuracy: 0.75, median_ms: 1500 }),
  ];
  const chart = trendChart(rounds, { width: 100, height: 100, pad: 10 });
  assert.equal(chart.empty, false);
  assert.equal(chart.accPath, "M 10 50 M 63.3 10 L 90 30");
  assert.equal(chart.timePath, "M 10 63.3 M 63.3 20.7 L 90 50");
  assert.deepEqual(chart.accDots, [
    { x: 10, y: 50, title: "11-05 50%" },
    { x: 63.3, y: 10, title: "11-06 100%" },
    { x: 90, y: 30, title: "11-06 75%" },
  ]);
  assert.deepEqual(chart.timeDots, [
    { x: 10, y: 63.3, title: "11-05 1.0 s" },
    { x: 63.3, y: 20.7, title: "11-06 2.6 s" },
    { x: 90, y: 50, title: "11-06 1.5 s" },
  ]);
  assert.deepEqual(chart.xLabels, [
    { x: 10, text: "11-05" },
    { x: 63.3, text: "11-06" },
  ]);
  assert.deepEqual(chart.accTicks, [
    { y: 90, text: "0%" },
    { y: 50, text: "50%" },
    { y: 10, text: "100%" },
  ]);
  assert.deepEqual(chart.timeTicks, [
    { y: 90, text: "0.0 s" },
    { y: 50, text: "1.5 s" },
    { y: 10, text: "3.0 s" },
  ]);
});

test("trendChart puts a single round in the middle and keeps the 2 s minimum scale", () => {
  const chart = trendChart(
    [round({ id: "a", started_at: "2026-11-06T09:00:00", accuracy: 0.8, median_ms: 1000 })],
    { width: 100, height: 50, pad: 5 },
  );
  assert.equal(chart.accPath, "M 50 13");
  assert.equal(chart.timePath, "M 50 25");
  assert.deepEqual(chart.accDots, [{ x: 50, y: 13, title: "11-06 80%" }]);
  assert.deepEqual(chart.xLabels, [{ x: 50, text: "11-06" }]);
  assert.deepEqual(chart.timeTicks.map((t) => t.text), ["0.0 s", "1.0 s", "2.0 s"]);
});

test("trendChart is empty without rounds", () => {
  const chart = trendChart([], { width: 100, height: 50, pad: 5 });
  assert.equal(chart.empty, true);
  assert.equal(chart.accPath, "");
  assert.equal(chart.timePath, "");
  assert.deepEqual(chart.accDots, []);
  assert.deepEqual(chart.timeDots, []);
  assert.deepEqual(chart.xLabels, []);
});

test("noteMapKeys classifies keys and writes the titles", () => {
  const stats: NoteStat[] = [
    { midi: 62, n: 10, firstTry: 10, rate: 1, medianMs: 1500 },
    { midi: 63, n: 5, firstTry: 2, rate: 0.4, medianMs: 1000 },
    { midi: 64, n: 12, firstTry: 9, rate: 0.75, medianMs: 1600 },
  ];
  const keys = noteMapKeys(stats, "notes", 60, 64);
  assert.deepEqual(keys.map((k) => k.midi), [60, 61, 62, 63, 64]);
  assert.deepEqual(keys.map((k) => k.black), [false, true, false, true, false]);
  assert.deepEqual(keys.map((k) => k.cls), ["nm-none", "nm-none", "nm-good", "nm-weak", "nm-ok"]);
  assert.equal(keys[0].title, "C4: not seen yet");
  assert.equal(keys[2].title, "D4: 10 cards, 100% first try, median 1.5 s");
  assert.equal(keys[3].title, "D#4: 5 cards, 40% first try, median 1.0 s");
  assert.equal(keys[4].title, "E4: 12 cards, 75% first try, median 1.6 s");
  const layout = keyLayout(60, 64);
  assert.deepEqual(keys.map((k) => k.x), layout.map((s) => s.left));
  assert.deepEqual(keys.map((k) => k.width), layout.map((s) => s.width));
});

test("noteMapKeys marks slow and mid-speed keys by the good target", () => {
  const slow = noteMapKeys([{ midi: 60, n: 3, firstTry: 3, rate: 1, medianMs: 3100 }], "notes", 60, 60);
  assert.equal(slow[0].cls, "nm-weak");
  const mid = noteMapKeys([{ midi: 60, n: 3, firstTry: 3, rate: 0.95, medianMs: 2500 }], "notes", 60, 60);
  assert.equal(mid[0].cls, "nm-ok");
});

test("noteMapKeys defaults to the full key range", () => {
  const keys = noteMapKeys([], "bars");
  assert.equal(keys[0].midi, KEY_LOW);
  assert.equal(keys[keys.length - 1].midi, KEY_HIGH);
  assert.ok(keys.every((k) => k.cls === "nm-none"));
});
