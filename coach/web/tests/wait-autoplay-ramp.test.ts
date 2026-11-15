import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createFollower } from "../src/follower.ts";
import type { FollowOptions, FollowRecord, FollowView } from "../src/follower.ts";
import { createWaitMatcher } from "../src/note-matcher.ts";
import { createLiveMatcher } from "../src/live-matcher.ts";
import { practicePlan } from "../src/practice-steps.ts";
import { createTempoMap } from "../src/tempo-map.ts";
import { createHoldChecker } from "../src/hold-checker.ts";
import type { PlanSourceStep } from "../src/practice-steps.ts";
import type { LiveEvent } from "../src/engine-socket.ts";
import { createAutoplayer, autoplaySchedule } from "../src/autoplay.ts";
import { autoplaySlice, rampedWaitTiming, shiftedMsAt } from "../src/practice-config.ts";

const on = (note: number, t = 0, velocity = 100): LiveEvent => ({ type: "note_on", t, note, velocity, source: "engine" });
const off = (note: number, t = 0): LiveEvent => ({ type: "note_off", t, note, source: "engine" });

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

const baseOpts = (mode: "wait" | "live", over: Partial<FollowOptions> = {}): FollowOptions => ({
  mode, hands: "both", range: null, loop: true, bpm: 120,
  countInBeats: 0, beatQuarters: 1, windowMs: 200, onTimeMs: 100, slide: true, ...over,
});

const RAMP = { stepPercent: 5, targetPercent: 70, backAfterBad: 2 };

function makeFollower(now: () => number) {
  const view: FollowView = {
    timeline: () => timeline([[60], [62]]),
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
    now,
    deps: { createWaitMatcher, createLiveMatcher, practicePlan, createTempoMap, createHoldChecker },
  });
  const records: FollowRecord[] = [];
  follower.onResult((r) => records.push(r));
  return { follower, records };
}

test("rampedWaitTiming rescales msAt and cycle scales relative to the base cycle", () => {
  const map: Record<number, number> = { 1: 1, 2: 1.1, 3: 1.2 };
  const scaleOf = (c: number) => map[c] ?? null;
  const rw = rampedWaitTiming((q) => q * 500, scaleOf, 2);
  assert.ok(Math.abs(rw.msAt(1) - 500 / 1.1) < 1e-9);
  assert.ok(Math.abs(rw.cycleScale(1)! - 1.2 / 1.1) < 1e-9);
  assert.equal(rw.cycleScale(5), null);
  const unknown = rampedWaitTiming((q) => q * 500, scaleOf, 9);
  assert.equal(unknown.msAt(1), 500);
  assert.equal(unknown.cycleScale(0), null);
});

test("follower.waitCycleScale is null in live mode and without ramp", () => {
  const live = makeFollower(() => 0);
  live.follower.start(baseOpts("live", { percent: 60, ramp: RAMP }));
  assert.equal(live.follower.waitCycleScale(1), null);
  const noRamp = makeFollower(() => 0);
  noRamp.follower.start(baseOpts("wait", { percent: 60 }));
  assert.equal(noRamp.follower.waitCycleScale(1), null);
});

test("follower.waitCycleScale follows the ramp in wait mode", () => {
  const f = makeFollower(() => 0);
  f.follower.start(baseOpts("wait", { percent: 60, ramp: RAMP }));
  assert.equal(f.follower.waitCycleScale(1), 1);
  f.follower.handle(on(60));
  f.follower.handle(off(60));
  f.follower.handle(on(62));
  f.follower.handle(off(62));
  assert.equal(f.follower.waitCycleScale(2), 65 / 60);
});

test("wait auto-play follows the ramp: step 1 of cycles 2 and 3 lands on time", () => {
  let now = 0;
  let timer: { fn: () => void; due: number } | null = null;
  const { follower, records } = makeFollower(() => now);
  const player = createAutoplayer({
    publish: (ev) => follower.handle(ev),
    now: () => now,
    setTimer: (fn, ms) => {
      timer = { fn, due: now + ms };
      return timer;
    },
    clearTimer: () => {
      timer = null;
    },
  });
  const advance = (to: number) => {
    while (timer !== null && (timer as { due: number }).due <= to) {
      const t = timer as { fn: () => void; due: number };
      timer = null;
      now = Math.max(now, t.due);
      t.fn();
    }
    now = to;
  };
  follower.start(baseOpts("wait", { percent: 60, ramp: RAMP }));
  const plan = follower.plan()!;
  const tempo = follower.tempo()!;
  const sl = autoplaySlice(plan, 0);
  const rw = rampedWaitTiming(
    shiftedMsAt((q) => tempo.msAt(q), 0),
    (c) => follower.waitCycleScale(c),
    follower.status().cycle,
  );
  const notes = autoplaySchedule(
    sl.steps,
    500,
    { velocity: 80, gatePercent: 90, offsetMs: 0, jitterMs: 0, skipEvery: 0, wrongEvery: 0, seed: 1 },
    sl.lengthQuarters,
    rw.msAt,
  );
  player.play(notes, 1000, rw.msAt(sl.lengthQuarters), { shiftToNow: true, cycleScale: rw.cycleScale });
  advance(5600);
  player.stop();
  const tempos = records.flatMap((r) => (r.kind === "tempo" ? [r.percent] : []));
  assert.deepEqual(tempos, [65, 70, 70]);
  for (const cycle of [2, 3]) {
    const rec = records.find((r) => r.kind === "step" && r.cycle === cycle && r.step === 1);
    assert.ok(rec && rec.kind === "step", `step record for cycle ${cycle}`);
    assert.ok(rec.dtMs !== null && Math.abs(rec.dtMs) <= 1, `cycle ${cycle} dt ${rec.dtMs}`);
    assert.equal(rec.score, 100);
  }
});

const main = readFileSync(fileURLToPath(new URL("../src/main.ts", import.meta.url)), "utf8");
const startAt = main.indexOf("function startAutoplay(");

test("startAutoplay wires the ramped wait timing and keeps the live cycleTiming", () => {
  assert.ok(startAt >= 0);
  const end = main.indexOf("\n}\n", startAt);
  const body = main.slice(startAt, end < 0 ? undefined : end);
  assert.ok(body.includes("rampedWaitTiming("));
  assert.ok(body.includes("follower.waitCycleScale("));
  assert.ok(body.includes("cycleScale: rw.cycleScale"));
  assert.ok(body.includes("follower.cycleTiming(k + 1)"));
});
