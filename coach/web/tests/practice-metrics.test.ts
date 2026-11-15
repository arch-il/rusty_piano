import { test } from "node:test";
import assert from "node:assert/strict";
import {
  accuracyPercent,
  formatDuration,
  metricTexts,
  offsetText,
  playedBpm,
  summaryRows,
} from "../src/practice-metrics.ts";
import type { PracticeCounts } from "../src/practice-metrics.ts";

const WAIT: PracticeCounts = {
  mode: "wait", bpm: null, expectedNotes: 12, correctNotes: 12, wrongNotes: 3, missedNotes: 0,
  hitSteps: 9, earlySteps: 0, lateSteps: 0, missedSteps: 0, offsetSumMs: 0, offsetCount: 0,
  firstHitAt: 1000, lastHitAt: 9000, firstHitQ: 0, lastHitQ: 8, cycles: 0, startedAt: 0, endedAt: 83000,
};
const LIVE: PracticeCounts = {
  mode: "live", bpm: 72, expectedNotes: 20, correctNotes: 17, wrongNotes: 2, missedNotes: 3,
  hitSteps: 12, earlySteps: 2, lateSteps: 2, missedSteps: 3, offsetSumMs: 560, offsetCount: 16,
  firstHitAt: null, lastHitAt: null, firstHitQ: null, lastHitQ: null, cycles: 2, startedAt: 0, endedAt: 65000,
};

test("accuracy and played bpm", () => {
  assert.equal(accuracyPercent(WAIT), 80);
  assert.equal(accuracyPercent(LIVE), 77);
  assert.equal(playedBpm(WAIT), 60);
  assert.equal(playedBpm(LIVE), null);
});

test("formatDuration", () => {
  assert.equal(formatDuration(0), "0:00");
  assert.equal(formatDuration(59999), "0:59");
  assert.equal(formatDuration(600000), "10:00");
});

test("metricTexts", () => {
  assert.deepEqual(metricTexts(WAIT), { accuracy: "80%", tempo: "60", wrong: "3", missed: "-", timing: "-" });
  assert.deepEqual(metricTexts(LIVE), { accuracy: "77%", tempo: "72", wrong: "2", missed: "3", timing: "-" });
  assert.deepEqual(metricTexts(null), { accuracy: "-", tempo: "-", wrong: "-", missed: "-", timing: "-" });
  assert.equal(metricTexts({ ...LIVE, timingScoreSum: 1234, timingScoreCount: 16 }).timing, "77");
});

test("metricTexts live tempo from nowBpm", () => {
  assert.equal(metricTexts(LIVE, 96).tempo, "96");
  assert.equal(metricTexts(LIVE, null).tempo, "72");
  assert.equal(metricTexts(WAIT, 96).tempo, "60");
});

test("summaryRows tempo range and held notes", () => {
  const ctx = { hands: "Right hand", bars: "Bars 3-4", percent: 60 };
  const tempoOf = (c: PracticeCounts) => summaryRows(c, ctx).find((r) => r[0] === "Tempo");
  assert.deepEqual(tempoOf({ ...LIVE, bpmMin: 36, bpmMax: 72 }), ["Tempo", "36-72 bpm (60%)"]);
  assert.deepEqual(tempoOf({ ...LIVE, bpmMin: 72, bpmMax: 72 }), ["Tempo", "72 bpm (60%)"]);
  const heldAt = (c: PracticeCounts) => {
    const rows = summaryRows(c, ctx);
    const i = rows.findIndex((r) => r[0] === "Held notes");
    return i < 0 ? null : [rows[i], rows[i + 1][0]];
  };
  assert.deepEqual(heldAt({ ...LIVE, holdChecked: 9, shortNotes: 2 }), [["Held notes", "7 of 9 held, 2 short"], "Tempo"]);
  assert.deepEqual(heldAt({ ...WAIT, holdChecked: 3, shortNotes: 0 }), [["Held notes", "3 of 3 held, 0 short"], "Tempo"]);
  assert.equal(heldAt({ ...LIVE, holdChecked: 0, shortNotes: 1 }), null);
  assert.equal(heldAt(LIVE), null);
});

test("all-zero counts give no accuracy", () => {
  const z: PracticeCounts = { ...WAIT, correctNotes: 0, wrongNotes: 0, missedNotes: 0 };
  assert.equal(accuracyPercent(z), null);
  assert.equal(metricTexts(z).accuracy, "-");
});

test("offsetText", () => {
  assert.equal(offsetText(WAIT), "-");
  assert.equal(offsetText(LIVE), "35 ms late");
  assert.equal(offsetText({ ...LIVE, offsetSumMs: -20, offsetCount: 4 }), "on time");
  assert.equal(offsetText({ ...LIVE, offsetSumMs: -120, offsetCount: 4 }), "30 ms early");
});

test("summaryRows wait", () => {
  assert.deepEqual(summaryRows(WAIT, { hands: "Both hands", bars: "All", percent: null }), [
    ["Mode", "Wait"],
    ["Hands", "Both hands"],
    ["Bars", "All"],
    ["Accuracy", "80%"],
    ["Notes", "12 correct, 3 wrong"],
    ["Tempo", "60 bpm (your pace)"],
    ["Time", "1:23"],
  ]);
});

test("summaryRows ramp row comes after the tempo row", () => {
  const ctx = { hands: "Right hand", bars: "All", percent: 60 };
  const rampOf = (ramp: PracticeCounts["ramp"]) => {
    const rows = summaryRows({ ...LIVE, ramp }, ctx);
    const i = rows.findIndex((r) => r[0] === "Ramp");
    return i < 0 ? null : [rows[i - 1][0], rows[i][1]];
  };
  assert.deepEqual(rampOf({ startPercent: 60, percent: 70, topPercent: 75, targetPercent: 100 }), ["Tempo", "60% to 75% (target 100%)"]);
  assert.deepEqual(rampOf({ startPercent: 60, percent: 100, topPercent: 100, targetPercent: 100 }), ["Tempo", "60% to 100%, target reached"]);
  assert.deepEqual(rampOf({ startPercent: 120, percent: 120, topPercent: 120, targetPercent: 100 }), ["Tempo", "120%, target reached"]);
  assert.equal(rampOf(undefined), null);
  assert.equal(rampOf(null), null);
});

test("summaryRows live", () => {
  assert.deepEqual(summaryRows(LIVE, { hands: "Right hand", bars: "Bars 3-4", percent: 60 }), [
    ["Mode", "Live"],
    ["Hands", "Right hand"],
    ["Bars", "Bars 3-4"],
    ["Accuracy", "77%"],
    ["Notes", "17 of 20 in time, 3 missed, 2 wrong"],
    ["Timing", "12 on time, 2 early, 2 late, 3 missed"],
    ["Average offset", "35 ms late"],
    ["Tempo", "72 bpm (60%)"],
    ["Time", "1:05"],
    ["Loops", "2"],
  ]);
});
