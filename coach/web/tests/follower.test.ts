import { test } from "node:test";
import assert from "node:assert/strict";
import { createFollower, followButtonLabel, followStatusText } from "../src/follower.ts";
import type { FollowOptions, FollowRecord, FollowStatus, FollowView } from "../src/follower.ts";
import { createWaitMatcher } from "../src/note-matcher.ts";
import { createLiveMatcher } from "../src/live-matcher.ts";
import { practicePlan } from "../src/practice-steps.ts";
import { createTempoMap } from "../src/tempo-map.ts";
import { createHoldChecker } from "../src/hold-checker.ts";
import type { PlanSourceStep } from "../src/practice-steps.ts";
import type { LiveEvent } from "../src/engine-socket.ts";
import { metricTexts } from "../src/practice-metrics.ts";

const on = (note: number, t = 0, velocity = 100): LiveEvent => ({ type: "note_on", t, note, velocity, source: "engine" });
const off = (note: number, t = 0): LiveEvent => ({ type: "note_off", t, note, source: "engine" });

const DEMO: LiveEvent[] = [
  on(60, 0, 40), off(60, 220), on(64, 250, 70), off(64, 470), on(67, 500, 100), off(67, 720),
  on(72, 750, 127), off(72, 970), on(48, 1250, 100), on(60, 1250, 100), on(64, 1250, 100), on(67, 1250, 100),
  off(48, 2750), off(60, 2750), off(64, 2750), off(67, 2750),
  { type: "sustain", t: 3250, on: true, source: "engine" },
  on(72, 3300, 80), off(72, 3400), on(76, 3500, 80), off(76, 3600), on(79, 3700, 80), off(79, 3800),
  on(84, 3900, 80), off(84, 4000),
  { type: "sustain", t: 5500, on: false, source: "engine" },
];

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

const DEMO_TL = timeline([[60], [64], [67], [72], [48, 60, 64, 67], [72], [76], [79], [84]]);
const CASE_TL = timeline([[60, 64], [64, 67], [67], [60, 69], [69], [71], [62], [62], [60, 72]]);

const waitOpts = (over: Partial<FollowOptions> = {}): FollowOptions => ({
  mode: "wait", hands: "both", range: null, loop: false, bpm: 120,
  countInBeats: 0, beatQuarters: 1, windowMs: 200, onTimeMs: 100, slide: true, ...over,
});
const liveOpts = (over: Partial<FollowOptions> = {}): FollowOptions => waitOpts({ mode: "live", ...over });

function setup(tl: PlanSourceStep[]) {
  const calls: string[] = [];
  const clock = { t: 0 };
  const view: FollowView = {
    timeline: () => tl,
    setFollowing: (o, h) => calls.push(`setFollowing:${o}:${h}`),
    showNeedle: (s) => calls.push(`showNeedle:${s}`),
    slideNeedle: (a, b, f) => calls.push(`slideNeedle:${a}:${b}:${f}`),
    markStep: (s, o) => calls.push(`markStep:${s}:${o}`),
    flashWrong: (s, a) => calls.push(`flashWrong:${s}:${a}`),
    clearMarks: () => calls.push("clearMarks"),
    markShort: (s) => calls.push(`markShort:${s}`),
  };
  const follower = createFollower({
    view,
    now: () => clock.t,
    deps: { createWaitMatcher, createLiveMatcher, practicePlan, createTempoMap, createHoldChecker },
  });
  return { follower, calls, clock };
}

test("wait start clears marks, follows and shows the first needle", () => {
  const { follower, calls } = setup(DEMO_TL);
  follower.start(waitOpts());
  assert.deepEqual(calls, ["clearMarks", "setFollowing:true:both", "showNeedle:0"]);
  const s = follower.status();
  assert.equal(s.state, "following");
  assert.equal(s.step, 0);
  assert.equal(s.total, 9);
  assert.equal(followStatusText(s), "1/9");
});

test("events before start and after stop are ignored", () => {
  const { follower, calls } = setup(DEMO_TL);
  follower.handle(on(60));
  assert.deepEqual(calls, []);
  follower.start(waitOpts());
  follower.stop();
  calls.length = 0;
  follower.handle(on(60));
  assert.deepEqual(calls, []);
});

test("a wrong note flashes and counts", () => {
  const { follower, calls } = setup(DEMO_TL);
  follower.start(waitOpts());
  calls.length = 0;
  follower.handle(on(61));
  assert.deepEqual(calls, ["flashWrong:0:1"]);
  assert.equal(follower.status().counts?.wrongNotes, 1);
});

test("the demo against the cases timeline ends at 2/9 with 7 wrong", () => {
  const { follower } = setup(CASE_TL);
  follower.start(waitOpts());
  for (const ev of DEMO) follower.handle(ev);
  const s = follower.status();
  assert.equal(s.step, 1);
  assert.equal(s.wrong, 7);
  assert.equal(followStatusText(s), "2/9, 7 wrong");
});

test("a full demo against the demo timeline finishes with 9 hits", () => {
  const { follower, calls } = setup(DEMO_TL);
  follower.start(waitOpts());
  for (const ev of DEMO) follower.handle(ev);
  assert.equal(calls.filter((c) => c.startsWith("markStep:") && c.endsWith(":hit")).length, 9);
  assert.equal(calls.at(-1), "showNeedle:null");
  const s = follower.status();
  assert.equal(s.state, "done");
  assert.equal(s.counts?.correctNotes, 12);
  assert.equal(s.counts?.expectedNotes, 12);
});

test("hands right skips a step that is only on staff 1", () => {
  const { follower, calls } = setup(timeline([[60], [48], [64]], { 1: 1 }));
  follower.start(waitOpts({ hands: "right" }));
  assert.equal(calls[1], "setFollowing:true:right");
  assert.equal(follower.status().total, 2);
  follower.handle(on(60));
  assert.deepEqual(calls.filter((c) => c.startsWith("showNeedle")), ["showNeedle:0", "showNeedle:2"]);
});

test("a wait loop restarts the pass", () => {
  const { follower, calls } = setup(timeline([[60], [62]]));
  follower.start(waitOpts({ loop: true }));
  follower.handle(on(60));
  follower.handle(off(60));
  follower.handle(on(62));
  const s = follower.status();
  assert.equal(s.state, "following");
  assert.equal(s.cycle, 2);
  assert.ok(calls.includes("clearMarks"));
  assert.equal(calls.at(-1), "showNeedle:0");
  assert.equal(s.counts?.cycles, 1);
  assert.ok(followStatusText(s).startsWith("Loop 2 · 1/2"));
});

test("live count-in", () => {
  const { follower, clock } = setup(timeline([[60], [62]]));
  follower.start(liveOpts({ countInBeats: 2 }));
  assert.equal(follower.startTime(), 1000);
  follower.tick();
  assert.equal(followStatusText(follower.status()), "Count-in 2");
  clock.t = 600;
  follower.tick();
  assert.equal(followStatusText(follower.status()), "Count-in 1");
  clock.t = 1000;
  follower.tick();
  assert.equal(follower.status().state, "following");
});

test("live run with hits, late, missed", () => {
  const { follower, calls, clock } = setup(timeline([[60], [62], [64], [65]]));
  clock.t = 1000;
  follower.start(liveOpts());
  calls.length = 0;
  follower.handle(on(60));
  assert.deepEqual(calls, ["markStep:0:hit"]);
  clock.t = 1250;
  calls.length = 0;
  follower.tick();
  assert.deepEqual(calls, ["slideNeedle:0:1:0.5"]);
  clock.t = 1650;
  calls.length = 0;
  follower.handle(on(62));
  assert.deepEqual(calls, ["markStep:1:late"]);
  clock.t = 2201;
  calls.length = 0;
  follower.tick();
  assert.ok(calls.includes("markStep:2:missed"));
  clock.t = 2500;
  calls.length = 0;
  follower.handle(on(65));
  assert.deepEqual(calls, ["markStep:3:hit", "showNeedle:null"]);
  const s = follower.status();
  assert.equal(s.state, "done");
  assert.equal(followStatusText(s), "Done, 1 missed");
  const c = s.counts!;
  assert.equal(c.correctNotes, 3);
  assert.equal(c.missedNotes, 1);
  assert.equal(c.expectedNotes, 4);
  assert.equal(c.hitSteps, 2);
  assert.equal(c.lateSteps, 1);
  assert.equal(c.missedSteps, 1);
  assert.equal(c.offsetCount, 3);
});

test("live with slide off only shows the needle when the step changes", () => {
  const { follower, calls, clock } = setup(timeline([[60], [62], [64], [65]]));
  clock.t = 1000;
  follower.start(liveOpts({ slide: false }));
  calls.length = 0;
  clock.t = 1100;
  follower.tick();
  clock.t = 1200;
  follower.tick();
  assert.equal(calls.filter((c) => c.startsWith("slideNeedle")).length, 0);
  assert.equal(calls.filter((c) => c === "showNeedle:0").length, 1);
  clock.t = 1600;
  follower.tick();
  assert.equal(calls.filter((c) => c === "showNeedle:1").length, 1);
  clock.t = 1700;
  follower.tick();
  assert.equal(calls.filter((c) => c === "showNeedle:1").length, 1);
});

test("a live loop clears marks on a new pass and older results do not paint", () => {
  const { follower, calls, clock } = setup(timeline([[60], [62]]));
  clock.t = 0;
  follower.start(liveOpts({ loop: true, bpm: 60 }));
  calls.length = 0;
  clock.t = 4100;
  follower.tick();
  assert.ok(calls.includes("clearMarks"));
  assert.equal(follower.status().cycle >= 2, true);
  assert.equal(follower.status().counts!.cycles, follower.status().cycle - 1);
});

test("stop keeps marks and a second stop does nothing", () => {
  const { follower, calls } = setup(DEMO_TL);
  follower.start(waitOpts());
  follower.handle(on(60));
  calls.length = 0;
  follower.stop();
  assert.deepEqual(calls, ["setFollowing:false:both"]);
  assert.equal(follower.status().state, "off");
  calls.length = 0;
  follower.stop();
  assert.deepEqual(calls, []);
});

test("plan, options and startTime", () => {
  const { follower, clock } = setup(DEMO_TL);
  assert.equal(follower.startTime(), null);
  assert.equal(follower.plan(), null);
  clock.t = 50;
  const o = waitOpts();
  follower.start(o);
  assert.equal(follower.options(), o);
  assert.equal(follower.plan()?.steps.length, 9);
  assert.equal(follower.startTime(), 50);
});

test("status texts", () => {
  const base: FollowStatus = {
    state: "off", mode: "wait", step: 0, total: 9, wrong: 0, missed: 0, cycle: 1, countIn: null, counts: null, bpm: null, percent: null, rampReached: false,
  };
  assert.equal(followStatusText(base), "");
  assert.equal(followStatusText({ ...base, state: "countin", countIn: 3 }), "Count-in 3");
  assert.equal(
    followStatusText({ ...base, state: "following", mode: "live", step: 2, cycle: 2, wrong: 1, missed: 2 }),
    "Loop 2 · 3/9, 1 wrong, 2 missed",
  );
  assert.equal(followStatusText({ ...base, state: "done", wrong: 2 }), "Done, 2 wrong");
  assert.equal(followStatusText({ ...base, state: "done", total: 0 }), "No notes to follow");
});

test("button labels", () => {
  assert.equal(followButtonLabel("off"), "Follow");
  assert.equal(followButtonLabel("countin"), "Stop");
  assert.equal(followButtonLabel("following"), "Stop");
  assert.equal(followButtonLabel("done"), "Restart");
});

test("onStatus unsubscribes and a throwing listener does not block others", () => {
  const { follower } = setup(DEMO_TL);
  const seen: string[] = [];
  const errors = console.error;
  console.error = () => {};
  try {
    follower.onStatus(() => {
      throw new Error("boom");
    });
    const unsub = follower.onStatus((s) => seen.push(s.state));
    follower.start(waitOpts());
    unsub();
    follower.stop();
  } finally {
    console.error = errors;
  }
  assert.deepEqual(seen, ["following"]);
});

interface TimedSpec {
  pitches: number[];
  time: number;
  quarters: number;
  bpm: number;
}

function timed(specs: TimedSpec[]): PlanSourceStep[] {
  return specs.map((s, i) => ({
    index: i,
    written: i,
    bar: Math.floor(s.time / 4) + 1,
    beat: s.time % 4,
    time: s.time,
    writtenTime: s.time,
    measureQuarters: 4,
    bpm: s.bpm,
    notes: s.pitches.map((m) => ({ midi: m, staff: 0, quarters: s.quarters })),
  }));
}

const twoTempo = (): PlanSourceStep[] =>
  timed(Array.from({ length: 8 }, (_, i) => ({ pitches: [60 + i], time: i, quarters: 1, bpm: i < 4 ? 120 : 60 })));

const HOLDS = { minPercent: 50, minNoteMs: 500, pedal: true };

function pressAt(f: ReturnType<typeof setup>, t: number, note: number): void {
  f.clock.t = t;
  f.follower.handle(on(note));
}
function releaseAt(f: ReturnType<typeof setup>, t: number, note: number): void {
  f.clock.t = t;
  f.follower.handle(off(note));
}

test("live follows a tempo change", () => {
  const f = setup(twoTempo());
  f.follower.start(liveOpts({ bpm: 120, percent: 100 }));
  f.clock.t = 100;
  f.follower.tick();
  assert.equal(f.follower.status().bpm, 120);
  [0, 500, 1000, 1500, 2000, 3000].forEach((t, i) => pressAt(f, t, 60 + i));
  assert.equal(f.calls.filter((c) => c.startsWith("markStep:") && c.endsWith(":hit")).length, 6);
  assert.equal(f.follower.status().counts?.hitSteps, 6);
  f.clock.t = 3100;
  f.follower.tick();
  assert.equal(f.follower.status().bpm, 60);
});

test("percent scales the plan tempo", () => {
  const f = setup(twoTempo());
  f.follower.start(liveOpts({ bpm: 60, percent: 50 }));
  [0, 1000, 2000, 3000, 4000, 6000].forEach((t, i) => pressAt(f, t, 60 + i));
  const c = f.follower.status().counts!;
  assert.equal(c.hitSteps, 6);
  assert.equal(c.bpm, 60);
  assert.equal(c.bpmMin, 30);
  assert.equal(c.bpmMax, 60);
});

test("count-in uses the plan tempo", () => {
  const slow = timed([0, 1].map((i) => ({ pitches: [60 + i], time: i, quarters: 1, bpm: 60 })));
  const a = setup(slow);
  a.follower.start(liveOpts({ bpm: 999, percent: 100, countInBeats: 4, beatQuarters: 1 }));
  assert.equal(a.follower.startTime(), 4000);
  const b = setup(DEMO_TL);
  b.follower.start(liveOpts({ bpm: 120, countInBeats: 4, beatQuarters: 1 }));
  assert.equal(b.follower.startTime(), 2000);
});

test("live hold check marks short notes", () => {
  const steps = timed(
    [60, 62, 64, 65].map((p, i) => ({ pitches: [p], time: i * 2, quarters: 2, bpm: 120 })),
  );
  const f = setup(steps);
  f.follower.start(liveOpts({ bpm: 120, percent: 100, holds: HOLDS }));
  pressAt(f, 0, 60);
  releaseAt(f, 300, 60);
  assert.ok(f.calls.includes("markShort:0"));
  assert.equal(f.follower.status().counts?.shortNotes, 1);
  assert.equal(f.follower.status().counts?.holdChecked, 1);
  pressAt(f, 1000, 62);
  releaseAt(f, 1600, 62);
  assert.ok(!f.calls.includes("markShort:1"));
  assert.equal(f.follower.status().counts?.holdChecked, 2);
  f.clock.t = 1900;
  f.follower.handle({ type: "sustain", t: 0, on: true, source: "engine" });
  pressAt(f, 2000, 64);
  releaseAt(f, 2100, 64);
  f.follower.handle({ type: "sustain", t: 0, on: false, source: "engine" });
  assert.ok(!f.calls.includes("markShort:2"));
  assert.equal(f.follower.status().counts?.holdChecked, 3);
  assert.equal(f.follower.status().counts?.shortNotes, 1);
});

test("wait hold check marks short notes", () => {
  const f = setup(timed([60, 62, 64].map((p, i) => ({ pitches: [p], time: i, quarters: 1, bpm: 60 }))));
  f.follower.start(waitOpts({ bpm: 60, percent: 100, holds: HOLDS }));
  pressAt(f, 0, 60);
  releaseAt(f, 200, 60);
  assert.ok(f.calls.includes("markShort:0"));
  pressAt(f, 1000, 62);
  releaseAt(f, 1700, 62);
  assert.ok(!f.calls.includes("markShort:1"));
  assert.equal(f.follower.status().counts?.holdChecked, 2);
  assert.equal(f.follower.status().counts?.shortNotes, 1);
});

test("without holds a quick release is never checked", () => {
  const f = setup(timed([60, 62].map((p, i) => ({ pitches: [p], time: i, quarters: 1, bpm: 60 }))));
  f.follower.start(waitOpts({ bpm: 60 }));
  pressAt(f, 0, 60);
  releaseAt(f, 50, 60);
  assert.ok(!f.calls.some((c) => c.startsWith("markShort")));
  assert.equal(f.follower.status().counts?.holdChecked, 0);
});

test("notes shorter than minNoteMs are not checked", () => {
  const f = setup(timed([60, 62].map((p, i) => ({ pitches: [p], time: i, quarters: 0.5, bpm: 120 }))));
  f.follower.start(waitOpts({ bpm: 120, holds: HOLDS }));
  pressAt(f, 0, 60);
  releaseAt(f, 10, 60);
  assert.equal(f.follower.status().counts?.holdChecked, 0);
});

test("expected hold is capped at the next strike of the same pitch", () => {
  const steps = timed([
    { pitches: [60], time: 0, quarters: 4, bpm: 120 },
    { pitches: [62], time: 1, quarters: 1, bpm: 120 },
    { pitches: [60], time: 2, quarters: 1, bpm: 120 },
  ]);
  const a = setup(steps);
  a.follower.start(waitOpts({ bpm: 120, holds: HOLDS }));
  pressAt(a, 0, 60);
  releaseAt(a, 600, 60);
  assert.ok(!a.calls.includes("markShort:0"));
  const b = setup(steps);
  b.follower.start(waitOpts({ bpm: 120, holds: HOLDS }));
  pressAt(b, 0, 60);
  releaseAt(b, 400, 60);
  assert.ok(b.calls.includes("markShort:0"));
});

test("reset clears everything", () => {
  const f = setup(timed([60, 62].map((p, i) => ({ pitches: [p], time: i, quarters: 1, bpm: 60 }))));
  f.follower.start(waitOpts({ bpm: 60 }));
  pressAt(f, 0, 60);
  f.follower.reset();
  assert.deepEqual(f.follower.status(), {
    state: "off", mode: "wait", step: 0, total: 0, wrong: 0, missed: 0, cycle: 1, countIn: null, counts: null, bpm: null, percent: null, rampReached: false,
  });
  assert.equal(f.follower.plan(), null);
  assert.equal(f.follower.tempo(), null);
  f.calls.length = 0;
  f.follower.handle(on(60));
  assert.deepEqual(f.calls, []);
});

test("stop after done keeps endedAt", () => {
  const f = setup(timeline([[60]]));
  f.follower.start(waitOpts());
  pressAt(f, 100, 60);
  assert.equal(f.follower.status().state, "done");
  f.clock.t = 500;
  f.follower.stop();
  assert.equal(f.follower.status().counts?.endedAt, 100);
});

test("wait mode reports no bpm", () => {
  const f = setup(DEMO_TL);
  f.follower.start(waitOpts());
  assert.equal(f.follower.status().bpm, null);
});

test("dropHolds before auto-play releases makes no short note", () => {
  const f = setup(timed([60, 62].map((p, i) => ({ pitches: [p], time: i * 2, quarters: 2, bpm: 120 }))));
  f.follower.start(liveOpts({ bpm: 120, percent: 100, holds: HOLDS }));
  pressAt(f, 0, 60);
  f.follower.dropHolds();
  releaseAt(f, 100, 60);
  assert.ok(!f.calls.includes("markShort:0"));
  assert.equal(f.follower.status().counts?.shortNotes, 0);
  assert.equal(f.follower.status().counts?.holdChecked, 0);
});

test("pedal down before start counts as held", () => {
  const f = setup(timed([60, 62].map((p, i) => ({ pitches: [p], time: i * 2, quarters: 2, bpm: 120 }))));
  f.follower.handle({ type: "sustain", t: 0, on: true, source: "engine" });
  f.follower.start(liveOpts({ bpm: 120, percent: 100, holds: HOLDS }));
  pressAt(f, 0, 60);
  releaseAt(f, 100, 60);
  assert.ok(!f.calls.includes("markShort:0"));
  assert.equal(f.follower.status().counts?.shortNotes, 0);
  assert.equal(f.follower.status().counts?.holdChecked, 1);
  assert.equal(f.follower.pedal(), true);
});

test("pedal up again before start still checks", () => {
  const f = setup(timed([60, 62].map((p, i) => ({ pitches: [p], time: i * 2, quarters: 2, bpm: 120 }))));
  f.follower.handle({ type: "sustain", t: 0, on: true, source: "engine" });
  f.follower.handle({ type: "sustain", t: 0, on: false, source: "engine" });
  f.follower.start(liveOpts({ bpm: 120, percent: 100, holds: HOLDS }));
  pressAt(f, 0, 60);
  releaseAt(f, 100, 60);
  assert.ok(f.calls.includes("markShort:0"));
});

test("live Done keeps the last tempo", () => {
  const f = setup(twoTempo());
  f.follower.start(liveOpts({ bpm: 120, percent: 100 }));
  [0, 500, 1000, 1500, 2000, 3000, 4000, 5000].forEach((t, i) => pressAt(f, t, 60 + i));
  f.clock.t = 6000;
  f.follower.tick();
  const s = f.follower.status();
  assert.equal(s.state, "done");
  assert.equal(s.bpm, 60);
  assert.equal(metricTexts(s.counts, s.bpm).tempo, "60");
});

test("live Stop keeps the tempo where it stopped until reset", () => {
  const f = setup(twoTempo());
  f.follower.start(liveOpts({ bpm: 120, percent: 100 }));
  f.clock.t = 2100;
  f.follower.tick();
  f.follower.stop();
  assert.equal(f.follower.status().state, "off");
  assert.equal(f.follower.status().bpm, 60);
  f.follower.reset();
  assert.equal(f.follower.status().bpm, null);
});

test("onResult reports every note and a hit step for each step of a wait run", () => {
  const { follower } = setup(DEMO_TL);
  const records: FollowRecord[] = [];
  follower.onResult((r) => records.push(r));
  follower.start(waitOpts());
  for (const ev of DEMO) follower.handle(ev);
  assert.equal(records.filter((r) => r.kind === "note").length, 12);
  const steps = records.filter((r) => r.kind === "step");
  assert.equal(steps.length, 9);
  assert.ok(steps.every((r) => r.kind === "step" && r.outcome === "hit"));
});

test("onResult reports a wrong note with its step and cycle", () => {
  const { follower } = setup(DEMO_TL);
  const records: FollowRecord[] = [];
  follower.onResult((r) => records.push(r));
  follower.start(waitOpts());
  follower.handle(on(61));
  assert.deepEqual(records, [{ kind: "wrong", step: 0, cycle: 1, note: 61, at: 0 }]);
});

test("onResult reports a short hold", () => {
  const f = setup(timed([60, 62, 64, 65].map((p, i) => ({ pitches: [p], time: i * 2, quarters: 2, bpm: 120 }))));
  const records: FollowRecord[] = [];
  f.follower.onResult((r) => records.push(r));
  f.follower.start(liveOpts({ bpm: 120, percent: 100, holds: HOLDS }));
  pressAt(f, 0, 60);
  releaseAt(f, 300, 60);
  assert.deepEqual(records.filter((r) => r.kind === "hold"), [
    { kind: "hold", step: 0, cycle: 1, note: 60, heldMs: 300, expectedMs: 1000, short: true, long: false, at: 300 },
  ]);
});

test("a throwing result listener does not stop the follower or the other listeners", () => {
  const { follower } = setup(DEMO_TL);
  const seen: FollowRecord[] = [];
  const errors = console.error;
  console.error = () => {};
  try {
    follower.onResult(() => {
      throw new Error("boom");
    });
    follower.onResult((r) => seen.push(r));
    follower.start(waitOpts());
    follower.handle(on(60));
  } finally {
    console.error = errors;
  }
  assert.deepEqual(seen.map((r) => r.kind), ["note", "step"]);
  assert.equal(follower.status().step, 1);
});

test("onResult unsubscribes and reset keeps the listeners", () => {
  const { follower } = setup(DEMO_TL);
  const seen: string[] = [];
  const unsub = follower.onResult((r) => seen.push(r.kind));
  follower.start(waitOpts());
  follower.handle(on(61));
  follower.reset();
  follower.start(waitOpts());
  follower.handle(on(61));
  unsub();
  follower.handle(on(61));
  assert.deepEqual(seen, ["wrong", "wrong"]);
});
