import { test } from "node:test";
import assert from "node:assert/strict";
import { createFollower, followStatusText } from "../src/follower.ts";
import type { FollowOptions, FollowRecord, FollowView } from "../src/follower.ts";
import { createWaitMatcher } from "../src/note-matcher.ts";
import { createLiveMatcher } from "../src/live-matcher.ts";
import { practicePlan } from "../src/practice-steps.ts";
import { createTempoMap } from "../src/tempo-map.ts";
import { createHoldChecker } from "../src/hold-checker.ts";
import type { PlanSourceStep } from "../src/practice-steps.ts";
import type { LiveEvent } from "../src/engine-socket.ts";

const on = (note: number, t = 0, velocity = 100): LiveEvent => ({ type: "note_on", t, note, velocity, source: "engine" });
const off = (note: number, t = 0): LiveEvent => ({ type: "note_off", t, note, source: "engine" });

function timeline(pitches: number[][], staffs: Record<number, number> = {}): PlanSourceStep[] {
  return pitches.map((p, i) => ({
    index: i,
    written: i,
    bar: Math.floor(i / 4) + 1,
    beat: i % 4,
    time: i,
    writtenTime: i,
    measureQuarters: 4,
    notes: p.map((m) => ({ midi: m, staff: staffs[i] ?? 0 })),
  }));
}

const baseOpts = (mode: "wait" | "live", over: Partial<FollowOptions> = {}): FollowOptions => ({
  mode, hands: "both", range: null, loop: true, bpm: 120,
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
  const records: FollowRecord[] = [];
  follower.onResult((r) => records.push(r));
  return { follower, clock, records };
}

const RAMP = { stepPercent: 5, targetPercent: 70, backAfterBad: 2 };
const text = (f: ReturnType<typeof setup>) => followStatusText(f.follower.status());
const tempos = (f: ReturnType<typeof setup>) =>
  f.records.flatMap((r) => (r.kind === "tempo" ? [r.percent] : []));

function playLoop(f: ReturnType<typeof setup>, wrongFirst = false): void {
  if (wrongFirst) f.follower.handle(on(61));
  f.follower.handle(on(60));
  f.follower.handle(off(60));
  f.follower.handle(on(62));
  f.follower.handle(off(62));
}

test("wait ramp climbs on clean loops and falls back after bad ones", () => {
  const f = setup(timeline([[60], [62]]));
  f.follower.start(baseOpts("wait", { percent: 60, ramp: RAMP }));
  assert.equal(text(f), "Loop 1 · 60% · 1/2");
  playLoop(f);
  assert.ok(text(f).startsWith("Loop 2 · 65% · 1/2"));
  const rec = f.records.find((r) => r.kind === "tempo");
  assert.ok(rec && rec.kind === "tempo" && rec.cycle === 2 && rec.percent === 65);
  playLoop(f);
  assert.equal(text(f), "Loop 3 · 70% · Target reached · 1/2");
  assert.equal(f.follower.status().rampReached, true);
  playLoop(f, true);
  playLoop(f, true);
  assert.deepEqual(tempos(f), [65, 70, 70, 65]);
});

test("wait timing reference follows the loop percent", () => {
  const f = setup(timeline([[60], [62]]));
  f.follower.start(baseOpts("wait", { percent: 60, ramp: RAMP }));
  playLoop(f);
  f.clock.t = 10000;
  f.follower.handle(on(60));
  f.follower.handle(off(60));
  f.clock.t = 10462;
  f.follower.handle(on(62));
  const step = f.records.filter((r) => r.kind === "step" && r.cycle === 2 && r.step === 1)[0];
  assert.ok(step && step.kind === "step");
  assert.equal(step.dtMs, 0);
  assert.equal(step.score, 100);
});

test("a status snapshot keeps its old ramp percent", () => {
  const f = setup(timeline([[60], [62]]));
  f.follower.start(baseOpts("wait", { percent: 60, ramp: RAMP }));
  const snap = f.follower.status();
  assert.equal(snap.counts!.ramp!.percent, 60);
  playLoop(f);
  assert.equal(snap.counts!.ramp!.percent, 60);
  assert.equal(f.follower.status().counts!.ramp!.percent, 65);
});

const LIVE_RAMP = { stepPercent: 10, targetPercent: 120, backAfterBad: 2 };
const NOTES = [60, 62, 64, 65];

function liveSetup() {
  const f = setup(timeline([[60], [62], [64], [65]]));
  f.clock.t = 0;
  f.follower.start(baseOpts("live", { percent: 100, ramp: LIVE_RAMP }));
  return f;
}

function run(f: ReturnType<typeof setup>, plays: [number, number][], upTo: number, snap: (t: number) => void = () => {}): void {
  const times = new Set<number>();
  for (let t = 0; t <= upTo; t += 10) times.add(t);
  for (const [t] of plays) times.add(t);
  for (const t of [...times].sort((a, b) => a - b)) {
    f.clock.t = t;
    f.follower.tick();
    for (const [pt, note] of plays) if (pt === t) f.follower.handle(on(note));
    snap(t);
  }
}

const loop1: [number, number][] = NOTES.map((n, k) => [k * 500, n]);
const loop2: [number, number][] = NOTES.map((n, k) => [Math.round(2000 + (k * 500) / 1.1), n]);

test("live ramp speeds up clean loops and falls back after bad ones", () => {
  const f = liveSetup();
  let st2100: ReturnType<typeof f.follower.status> | null = null;
  const loop3: string[] = [];
  run(f, [...loop1, ...loop2], 7200, (t) => {
    if (t === 2100) st2100 = f.follower.status();
    if (t >= 4200 && t <= 4300) loop3.push(text(f));
  });
  const recs = f.records.flatMap((r) => (r.kind === "tempo" ? [r] : []));
  assert.deepEqual(recs.map((r) => r.percent), [110, 120, 120, 110]);
  assert.deepEqual(recs.map((r) => r.cycle), [2, 3, 4, 5]);
  assert.ok(recs[0].at >= 1800 && recs[0].at < 2000);
  assert.equal(st2100!.cycle, 2);
  assert.equal(st2100!.percent, 110);
  assert.equal(st2100!.bpm, 132);
  assert.ok(followStatusText(st2100!).startsWith("Loop 2 · 110% · "));
  assert.ok(loop3.length > 0 && loop3.every((x) => x.startsWith("Loop 3 · 120% · Target reached · ")));
  const c = f.follower.status().counts!;
  assert.equal(c.bpmMin, 120);
  assert.equal(c.bpmMax, 144);
  assert.equal(c.ramp!.topPercent, 120);
  assert.deepEqual(f.follower.cycleTiming(2), { start: 2000, scale: 1.1 });
});

test("a mistake after the loop was judged counts against the next decision", () => {
  const f = liveSetup();
  run(f, [...loop1, ...loop2, [1900, 90]], 4000);
  assert.deepEqual(tempos(f), [110, 110]);
  assert.deepEqual(
    f.records.flatMap((r) => (r.kind === "tempo" ? [r.cycle] : [])),
    [2, 3],
  );
});

test("no loop means no ramp", () => {
  const f = setup(timeline([[60], [62]]));
  f.follower.start(baseOpts("wait", { loop: false, percent: 60, ramp: RAMP }));
  const s = f.follower.status();
  assert.equal(s.percent, null);
  assert.equal(s.rampReached, false);
  assert.ok(!text(f).includes("Loop"));
});

function shortLoopTempos(scen: { wrong?: boolean; skipLast?: boolean }[]): number[] {
  const times = [0, 0.5, 1.9];
  const pitches = [60, 62, 64];
  const tl: PlanSourceStep[] = times.map((t, i) => ({
    index: i, written: i, bar: 1, beat: t, time: t, writtenTime: t, measureQuarters: 2,
    notes: [{ midi: pitches[i], staff: 0 }],
  }));
  const f = setup(tl);
  f.follower.start(baseOpts("live", { percent: 60, ramp: { stepPercent: 5, targetPercent: 100, backAfterBad: 2 } }));
  const advance = (to: number) => {
    while (f.clock.t < to) {
      f.clock.t = Math.min(to, f.clock.t + 10);
      f.follower.tick();
    }
  };
  scen.forEach((o, k) => {
    const tm = f.follower.cycleTiming(k + 1)!;
    for (let i = 0; i < 3; i++) {
      if (i === 2 && o.skipLast) continue;
      const at = tm.start + (times[i] * 500) / tm.scale;
      advance(at);
      f.follower.handle(on(pitches[i]));
      f.follower.handle(off(pitches[i]));
      if (i === 0 && o.wrong) {
        advance(at + 100);
        f.follower.handle(on(90));
      }
    }
  });
  advance(f.follower.cycleTiming(scen.length + 1)!.start + 50);
  return tempos(f);
}

test("one bad loop with a wrong note and a late miss counts once", () => {
  assert.deepEqual(shortLoopTempos([{}, { wrong: true, skipLast: true }, {}, {}]), [65, 65, 70, 75]);
});

test("a wrong note alone in a loop counts once", () => {
  assert.deepEqual(shortLoopTempos([{}, { wrong: true }, {}, {}]), [65, 65, 70, 75]);
});

test("a late miss alone in a loop counts against the next decision", () => {
  assert.deepEqual(shortLoopTempos([{}, { skipLast: true }, {}, {}]), [65, 70, 70, 75]);
});

test("a late miss then a wrong note in the next loop count as two bad loops", () => {
  assert.deepEqual(shortLoopTempos([{}, { skipLast: true }, { wrong: true }, {}, {}]), [65, 70, 70, 65, 70]);
});

test("wrong notes in two loops in a row both count", () => {
  assert.deepEqual(shortLoopTempos([{}, { wrong: true }, { wrong: true }, {}, {}]), [65, 65, 60, 65, 70]);
});

test("late misses in two loops in a row both count", () => {
  assert.deepEqual(shortLoopTempos([{}, { skipLast: true }, { skipLast: true }, {}, {}]), [65, 70, 70, 65, 70]);
});
