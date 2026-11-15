import { test } from "node:test";
import assert from "node:assert/strict";
import { createFollower } from "../src/follower.ts";
import type { FollowOptions, FollowView } from "../src/follower.ts";
import { createWaitMatcher } from "../src/note-matcher.ts";
import { createLiveMatcher } from "../src/live-matcher.ts";
import { practicePlan } from "../src/practice-steps.ts";
import { createTempoMap } from "../src/tempo-map.ts";
import { createHoldChecker } from "../src/hold-checker.ts";
import type { PlanSourceStep } from "../src/practice-steps.ts";
import type { LiveEvent } from "../src/engine-socket.ts";
import { medianPaceBpm, metricTexts, paceSample, summaryRows } from "../src/practice-metrics.ts";

const on = (note: number): LiveEvent => ({ type: "note_on", t: 0, note, velocity: 100, source: "engine" });

function timeline(pitches: number[][]): PlanSourceStep[] {
  return pitches.map((p, i) => ({
    index: i,
    written: i,
    bar: Math.floor(i / 4) + 1,
    beat: i % 4,
    time: i,
    writtenTime: i,
    measureQuarters: 4,
    notes: p.map((m) => ({ midi: m, staff: 0 })),
  }));
}

const waitOpts = (over: Partial<FollowOptions> = {}): FollowOptions => ({
  mode: "wait", hands: "both", range: null, loop: false, bpm: 120,
  countInBeats: 0, beatQuarters: 1, windowMs: 200, onTimeMs: 100, slide: true, ...over,
});

function setup(tl: PlanSourceStep[]) {
  const clock = { t: 0 };
  const view: FollowView = {
    timeline: () => tl,
    setFollowing: () => {},
    showNeedle: () => {},
    slideNeedle: () => {},
    markStep: () => {},
    flashWrong: () => {},
    clearMarks: () => {},
    markShort: () => {},
  };
  const follower = createFollower({
    view,
    now: () => clock.t,
    deps: { createWaitMatcher, createLiveMatcher, practicePlan, createTempoMap, createHoldChecker },
  });
  return { follower, clock };
}

function play(times: number[]) {
  const f = setup(timeline([[60], [62], [64], [65]]));
  f.follower.start(waitOpts());
  const notes = [60, 62, 64, 65];
  times.forEach((t, i) => {
    f.clock.t = t;
    f.follower.handle(on(notes[i]));
  });
  return f.follower.status().counts!;
}

test("paceSample null cases and a plain value", () => {
  assert.equal(paceSample(null, 0, 500, 1), null);
  assert.equal(paceSample(0, null, 500, 1), null);
  assert.equal(paceSample(0, 1, 500, 1), null);
  assert.equal(paceSample(0, 2, 500, 1), null);
  assert.equal(paceSample(0, 0, 59, 1), null);
  assert.equal(paceSample(0, 0, 500, 1), 500);
});

test("medianPaceBpm", () => {
  assert.equal(medianPaceBpm([]), null);
  assert.equal(medianPaceBpm([500]), 120);
  assert.equal(medianPaceBpm([500, 500, 10000]), 120);
  assert.equal(medianPaceBpm([400, 600]), 120);
});

test("a chord-roll style gap gives no tempo", () => {
  assert.equal(metricTexts(play([1000, 1013])).tempo, "-");
});

test("steady presses give the pace", () => {
  assert.equal(metricTexts(play([1000, 1013, 1513, 2013])).tempo, "120");
});

test("one long pause does not change the median", () => {
  const c = play([1000, 1500, 2000, 12000]);
  assert.equal(metricTexts(c).tempo, "120");
  const rows = summaryRows(c, { hands: "both", bars: "all", percent: null });
  assert.deepEqual(rows.find((r) => r[0] === "Tempo"), ["Tempo", "120 bpm (your pace)"]);
});
