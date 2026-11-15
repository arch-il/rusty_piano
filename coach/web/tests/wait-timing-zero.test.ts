import { test } from "node:test";
import assert from "node:assert/strict";
import { createFollower } from "../src/follower.ts";
import type { FollowOptions, FollowRecord, FollowView } from "../src/follower.ts";
import { createWaitMatcher } from "../src/note-matcher.ts";
import { createLiveMatcher } from "../src/live-matcher.ts";
import { practicePlan } from "../src/practice-steps.ts";
import { createTempoMap } from "../src/tempo-map.ts";
import { createHoldChecker } from "../src/hold-checker.ts";
import type { PlanSourceStep } from "../src/practice-steps.ts";
import type { LiveEvent } from "../src/engine-socket.ts";
import { timingScorePercent } from "../src/practice-metrics.ts";

const on = (note: number): LiveEvent => ({ type: "note_on", t: 0, note, velocity: 100, source: "engine" });
const off = (note: number): LiveEvent => ({ type: "note_off", t: 0, note, source: "engine" });

// Eight steps, one quarter apart; step 4 is a chord.
const PITCHES = [[60], [62], [64], [65], [67, 71], [69], [71], [72]];
const TL: PlanSourceStep[] = PITCHES.map((p, i) => ({
  index: i,
  bpm: 120,
  written: i,
  bar: Math.floor(i / 4) + 1,
  beat: i % 4,
  time: i,
  writtenTime: i,
  measureQuarters: 4,
  notes: p.map((m) => ({ midi: m, staff: 0 })),
}));

function setup() {
  const clock = { t: 0 };
  const records: FollowRecord[] = [];
  const view: FollowView = {
    timeline: () => TL,
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
  follower.onResult((r) => records.push(r));
  return { follower, clock, records };
}

const opts = (over: Partial<FollowOptions> = {}): FollowOptions => ({
  mode: "wait", hands: "both", range: null, loop: false, bpm: 120,
  countInBeats: 0, beatQuarters: 1, windowMs: 200, onTimeMs: 100, slide: true, ...over,
});

function playStep(f: ReturnType<typeof setup>, step: number, at: number): void {
  f.clock.t = at;
  for (const n of PITCHES[step]) f.follower.handle(on(n));
  for (const n of PITCHES[step]) f.follower.handle(off(n));
}

// gapMs = real time between consecutive steps.
function playRun(f: ReturnType<typeof setup>, gapMs: number, start = 1000): void {
  for (let i = 0; i < PITCHES.length; i++) playStep(f, i, start + i * gapMs);
}

const score = (f: ReturnType<typeof setup>): number | null => timingScorePercent(f.follower.status().counts!);

test("wait mode: all correct at the written gaps scores 100 over 7 notes (first note unscored)", () => {
  const f = setup();
  f.follower.start(opts());
  playRun(f, 500); // 120 bpm, a quarter is 500 ms
  const c = f.follower.status().counts!;
  assert.equal(c.hitSteps, 8);
  assert.equal(c.wrongNotes, 0);
  assert.equal(c.timingScoreCount, 7);
  assert.equal(score(f), 100);
});

test("wait mode: the slider tempo is applied (50 percent means 1000 ms gaps)", () => {
  const f = setup();
  f.follower.start(opts({ percent: 50, bpm: 60 }));
  playRun(f, 1000);
  assert.equal(score(f), 100);
});

test("wait mode: playing at the written pace while the slider is at 50 percent scores 0 (by design)", () => {
  const f = setup();
  f.follower.start(opts({ percent: 50, bpm: 60 }));
  playRun(f, 500); // expected 1000, got 500: 500 ms off, over zeroMs 250
  assert.equal(score(f), 0);
});

test("wait mode: all correct at half speed scores 0 (by design, gap 1000 vs written 500)", () => {
  const f = setup();
  f.follower.start(opts());
  playRun(f, 1000); // 500 ms late on every gap
  assert.equal(f.follower.status().counts!.correctNotes, 9);
  assert.equal(score(f), 0);
});

test("wait mode: slightly slow play (150 ms late per gap) scores between 0 and 100", () => {
  const f = setup();
  f.follower.start(opts());
  playRun(f, 650);
  const s = score(f)!;
  assert.ok(s > 0 && s < 100, `got ${s}`);
});

test("wait mode: the first note of a run has no timing score", () => {
  const f = setup();
  f.follower.start(opts());
  playStep(f, 0, 1000);
  const c = f.follower.status().counts!;
  assert.equal(c.hitSteps, 1);
  assert.equal(c.timingScoreCount ?? 0, 0);
  assert.equal(score(f), null);
  const rec = f.records.find((r) => r.kind === "step")!;
  assert.equal((rec as { score: number | null }).score, null);
});

test("wait mode: a chord counts as one scored step", () => {
  const f = setup();
  f.follower.start(opts());
  playRun(f, 500);
  const steps = f.records.filter((r) => r.kind === "step") as { step: number; score: number | null }[];
  assert.equal(steps[4].score, 100);
  assert.equal(steps.length, 8);
});

test("wait mode: a long pause before a note only costs that note", () => {
  const f = setup();
  f.follower.start(opts());
  for (let i = 0; i < 4; i++) playStep(f, i, 1000 + i * 500);
  playStep(f, 4, 1000 + 3 * 500 + 10000); // 10 s pause before step 4
  for (let i = 5; i < 8; i++) playStep(f, i, 1000 + 3 * 500 + 10000 + (i - 4) * 500);
  const c = f.follower.status().counts!;
  assert.equal(c.timingScoreCount, 7);
  assert.equal(c.timingScoreSum, 600); // 6 perfect notes, the paused one is 0
  assert.equal(score(f), 86);
});

test("wait mode: after a loop restart the first note is unscored and the rest score 100", () => {
  const f = setup();
  f.follower.start(opts({ loop: true }));
  playRun(f, 500, 1000);
  playRun(f, 500, 100000); // long gap between the last note and the restart
  const c = f.follower.status().counts!;
  assert.equal(c.hitSteps, 16);
  assert.equal(c.timingScoreCount, 14);
  assert.equal(score(f), 100);
});
