import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DEFAULT_COLOURS,
  DEFAULT_CURVE,
  gradientPosition,
  meanScore,
  outcomeOf,
  parseHex,
  scoreColour,
  timingScore,
} from "../src/timing-score.ts";
import { DEFAULT_SETTINGS } from "../src/follower-settings.ts";
import { createMarks, markColour } from "../src/feedback-overlay.ts";
import { createFollower } from "../src/follower.ts";
import type { FollowOptions, FollowRecord, FollowView } from "../src/follower.ts";
import { createWaitMatcher } from "../src/note-matcher.ts";
import { createLiveMatcher } from "../src/live-matcher.ts";
import { practicePlan } from "../src/practice-steps.ts";
import type { PlanSourceStep } from "../src/practice-steps.ts";
import { createTempoMap } from "../src/tempo-map.ts";
import { createHoldChecker } from "../src/hold-checker.ts";
import { summaryRows } from "../src/practice-metrics.ts";
import type { LiveEvent } from "../src/engine-socket.ts";

const C = { perfectMs: 20, zeroMs: 250, curve: 1 };

test("timingScore: 100 inside perfectMs, 0 from zeroMs, straight line between", () => {
  assert.equal(timingScore(0, C), 100);
  assert.equal(timingScore(20, C), 100);
  assert.equal(timingScore(-20, C), 100);
  assert.equal(timingScore(250, C), 0);
  assert.equal(timingScore(-900, C), 0);
  assert.equal(timingScore(135, C), 50);
  assert.equal(timingScore(-135, C), 50);
  assert.equal(timingScore(80, C), 74);
  assert.equal(timingScore(120, C), 57);
  assert.equal(timingScore(-110, C), 61);
});

test("timingScore: null, undefined and non-finite offsets have no score", () => {
  assert.equal(timingScore(null, C), null);
  assert.equal(timingScore(undefined, C), null);
  assert.equal(timingScore(Number.NaN, C), null);
});

test("timingScore always falls as the offset grows, and the curve shape bends it", () => {
  let last = 101;
  for (let d = 0; d <= 300; d += 5) {
    const s = timingScore(d, C)!;
    assert.ok(s <= last, `score at ${d} ms rose`);
    assert.ok(s >= 0 && s <= 100);
    last = s;
  }
  assert.ok(timingScore(80, { ...C, curve: 2 })! > timingScore(80, C)!);
  assert.ok(timingScore(80, { ...C, curve: 0.5 })! < timingScore(80, C)!);
});

test("outcomeOf gives back the old hit, early and late from the raw offset", () => {
  assert.equal(outcomeOf(0, 80), "hit");
  assert.equal(outcomeOf(80, 80), "hit");
  assert.equal(outcomeOf(-80, 80), "hit");
  assert.equal(outcomeOf(81, 80), "late");
  assert.equal(outcomeOf(-81, 80), "early");
});

test("gradient: red up to redScore, yellow halfway, green from greenScore", () => {
  const c = { redScore: 30, greenScore: 90 };
  assert.equal(gradientPosition(0, c), 0);
  assert.equal(gradientPosition(30, c), 0);
  assert.equal(gradientPosition(60, c), 0.5);
  assert.equal(gradientPosition(90, c), 1);
  assert.equal(gradientPosition(100, c), 1);
  const stops = { low: "#ff0000", mid: "#ffff00", high: "#00ff00" };
  assert.equal(scoreColour(10, c, stops), "#ff0000");
  assert.equal(scoreColour(45, c, stops), "#ff8000");
  assert.equal(scoreColour(60, c, stops), "#ffff00");
  assert.equal(scoreColour(75, c, stops), "#80ff00");
  assert.equal(scoreColour(95, c, stops), "#00ff00");
});

test("parseHex reads 3 and 6 digit colours and rejects others", () => {
  assert.deepEqual(parseHex("#2e8b45"), [46, 139, 69]);
  assert.deepEqual(parseHex(" #fff "), [255, 255, 255]);
  assert.equal(parseHex("rgb(1,2,3)"), null);
});

test("meanScore", () => {
  assert.equal(meanScore(0, 0), null);
  assert.equal(meanScore(undefined, undefined), null);
  assert.equal(meanScore(150, 2), 75);
});

test("defaults match follower-settings.json and DEFAULT_SETTINGS", () => {
  const json = JSON.parse(readFileSync(new URL("../src/follower-settings.json", import.meta.url), "utf8"));
  assert.deepEqual(json.timing, DEFAULT_SETTINGS.timing);
  const t = DEFAULT_SETTINGS.timing;
  assert.deepEqual(DEFAULT_CURVE, { perfectMs: t.perfectMs, zeroMs: t.zeroMs, curve: t.curve });
  assert.deepEqual(DEFAULT_COLOURS, { redScore: t.redScore, greenScore: t.greenScore });
});

test("markColour: scored steps use the gradient, missed and unscored ones their mark colour", () => {
  const vars: Record<string, string> = {
    "--color-score-low": "#ff0000",
    "--color-score-mid": "#ffff00",
    "--color-score-high": "#00ff00",
    "--color-mark-hit": "#111111",
    "--color-mark-missed": "#999999",
  };
  const read = (n: string, f: string) => vars[n] ?? f;
  assert.equal(markColour("hit", 100, read), "#00ff00");
  assert.equal(markColour("late", 60, read), "#ffff00");
  assert.equal(markColour("early", 0, read), "#ff0000");
  assert.equal(markColour("hit", null, read), "#111111");
  assert.equal(markColour("missed", null, read), "#999999");
});

test("marks keep a score per step and drop it with the outcome", () => {
  const m = createMarks();
  m.setOutcome(2, "late", 57);
  assert.equal(m.score(2), 57);
  m.setOutcome(2, "hit");
  assert.equal(m.score(2), null);
  m.setOutcome(3, "hit", 90);
  m.setOutcome(3, null);
  assert.equal(m.score(3), null);
  m.setOutcome(4, "hit", 80);
  m.clear();
  assert.equal(m.score(4), null);
});

const on = (note: number): LiveEvent => ({ type: "note_on", t: 0, note, velocity: 100, source: "engine" });
const off = (note: number): LiveEvent => ({ type: "note_off", t: 0, note, source: "engine" });

function timeline(pitches: number[][]): PlanSourceStep[] {
  return pitches.map((p, i) => ({
    index: i, written: i, bar: Math.floor(i / 4) + 1, beat: i % 4, time: i, writtenTime: i, measureQuarters: 4,
    notes: p.map((m) => ({ midi: m, staff: 0 })),
  }));
}

function setup(tl: PlanSourceStep[]) {
  const marks: [number, string | null, number | null | undefined][] = [];
  const records: FollowRecord[] = [];
  const clock = { t: 0 };
  const view: FollowView = {
    timeline: () => tl,
    setFollowing: () => {},
    showNeedle: () => {},
    slideNeedle: () => {},
    markStep: (s, o, score) => marks.push([s, o, score]),
    flashWrong: () => {},
    clearMarks: () => {},
    markShort: () => {},
  };
  const follower = createFollower({
    view,
    now: () => clock.t,
    deps: { createWaitMatcher, createLiveMatcher, practicePlan, createTempoMap, createHoldChecker },
  });
  follower.onResult((r) => records.push(r));
  return { follower, marks, records, clock };
}

const opts = (over: Partial<FollowOptions> = {}): FollowOptions => ({
  mode: "wait", hands: "both", range: null, loop: false, bpm: 120,
  countInBeats: 0, beatQuarters: 1, windowMs: 200, onTimeMs: 80, slide: false,
  timing: { perfectMs: 20, zeroMs: 250, curve: 1 }, ...over,
});

test("wait mode scores each note against the written gap from the previous one", () => {
  // 120 bpm: 500 ms per quarter, one step per quarter.
  const { follower, marks, records, clock } = setup(timeline([[60], [62], [64], [65]]));
  follower.start(opts());
  clock.t = 1000;
  follower.handle(on(60));
  follower.handle(off(60));
  clock.t = 1500;
  follower.handle(on(62));
  follower.handle(off(62));
  clock.t = 2135;
  follower.handle(on(64));
  follower.handle(off(64));
  clock.t = 2385;
  follower.handle(on(65));
  assert.deepEqual(marks, [[0, "hit", null], [1, "hit", null], [2, "hit", null], [3, "hit", null]]);
  const steps = records.filter((r) => r.kind === "step");
  assert.deepEqual(steps.map((r) => r.kind === "step" && r.dtMs), [null, 0, 135, -250]);
  const c = follower.status().counts!;
  assert.equal(c.timingScoreCount, 3);
  assert.equal(c.timingScoreSum, 150);
  assert.ok(summaryRows(c, { hands: "Both hands", bars: "All", percent: 100 }).some(
    ([k, v]) => k === "Timing score" && v === "50 of 100 (3 notes)",
  ));
});

test("wait mode measures a chord from its first note and a wrong note makes it late", () => {
  const { follower, marks, clock } = setup(timeline([[60], [64, 67], [69]]));
  follower.start(opts());
  clock.t = 0;
  follower.handle(on(60));
  clock.t = 510;
  follower.handle(on(64));
  clock.t = 560;
  follower.handle(on(67));
  clock.t = 900;
  follower.handle(on(70));
  clock.t = 1210;
  follower.handle(on(69));
  // chord onset 510 (10 ms late) scores 100; 69 expected at 1010, played at 1210 (200 ms late)
  assert.deepEqual(marks, [[0, "hit", null], [1, "hit", null], [2, "hit", null]]);
});

test("wait mode loop starts scoring again from the first note of each loop", () => {
  const { follower, marks, clock } = setup(timeline([[60], [62]]));
  follower.start(opts({ loop: true }));
  for (const [t, n] of [[0, 60], [500, 62], [3000, 60], [3500, 62]] as const) {
    clock.t = t;
    follower.handle(on(n));
    follower.handle(off(n));
  }
  assert.deepEqual(marks.map((m) => m[2]), [null, null, null, null]);
});

test("wait mode marks a scored hit with null while the step record keeps its score", () => {
  const { follower, marks, records, clock } = setup(timeline([[60], [62]]));
  follower.start(opts());
  clock.t = 0;
  follower.handle(on(60));
  follower.handle(off(60));
  clock.t = 500;
  follower.handle(on(62));
  assert.deepEqual(marks, [[0, "hit", null], [1, "hit", null]]);
  const steps = records.filter((r) => r.kind === "step");
  assert.equal(steps[1].kind === "step" && steps[1].score, 100);
});

test("live mode passes the score of the mean offset to the marks and counts", () => {
  const { follower, marks, records, clock } = setup(timeline([[60], [62], [64]]));
  clock.t = 1000;
  follower.start(opts({ mode: "live" }));
  follower.handle(on(60));
  clock.t = 1620;
  follower.handle(on(62));
  clock.t = 2201;
  follower.tick();
  assert.deepEqual(marks, [[0, "hit", 100], [1, "late", 57], [2, "missed", null]]);
  const steps = records.filter((r) => r.kind === "step");
  assert.deepEqual(steps.map((r) => r.kind === "step" && r.score), [100, 57, null]);
  const c = follower.status().counts!;
  assert.equal(c.timingScoreSum, 157);
  assert.equal(c.timingScoreCount, 2);
  assert.equal(c.hitSteps, 1);
  assert.equal(c.lateSteps, 1);
});
