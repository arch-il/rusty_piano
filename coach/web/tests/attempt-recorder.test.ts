import { test } from "node:test";
import assert from "node:assert/strict";
import { createAttemptRecorder } from "../src/attempt-recorder.ts";
import type { AttemptEnd, AttemptStart } from "../src/attempt-recorder.ts";
import { createFollower } from "../src/follower.ts";
import type { FollowOptions, FollowRecord, FollowView } from "../src/follower.ts";
import { createWaitMatcher } from "../src/note-matcher.ts";
import { createLiveMatcher } from "../src/live-matcher.ts";
import { practicePlan } from "../src/practice-steps.ts";
import { createTempoMap } from "../src/tempo-map.ts";
import { createHoldChecker } from "../src/hold-checker.ts";
import { DEFAULT_SETTINGS } from "../src/follower-settings.ts";
import type { LiveEvent } from "../src/engine-socket.ts";
import type { PracticeCounts } from "../src/practice-metrics.ts";

const on = (note: number, t: number, velocity = 100): LiveEvent => ({ type: "note_on", t, note, velocity, source: "engine" });
const off = (note: number, t: number): LiveEvent => ({ type: "note_off", t, note, source: "engine" });

const tl = [
  { index: 0, written: 0, bar: 1, beat: 0, time: 0, writtenTime: 0, measureQuarters: 4, bpm: 120, pass: 1, notes: [{ midi: 60, staff: 0, quarters: 1 }] },
  { index: 1, written: 1, bar: 1, beat: 1, time: 1, writtenTime: 1, measureQuarters: 4, bpm: 120, pass: 1, notes: [{ midi: 62, staff: 0, quarters: 1 }] },
];
const plan = practicePlan(tl, { hands: "both", range: null, loop: false });

const liveOptions: FollowOptions = {
  mode: "live", hands: "both", range: null, loop: false, bpm: 120, percent: 100,
  holds: { minPercent: 50, minNoteMs: 500, pedal: true }, countInBeats: 4, beatQuarters: 1,
  windowMs: 200, onTimeMs: 80, slide: true,
};

const counts: PracticeCounts = {
  mode: "live", bpm: 120, expectedNotes: 2, correctNotes: 1, wrongNotes: 1, missedNotes: 1,
  hitSteps: 1, earlySteps: 0, lateSteps: 0, missedSteps: 1, offsetSumMs: 10, offsetCount: 1,
  firstHitAt: 3010.04, lastHitAt: 3010.04, firstHitQ: 0, lastHitQ: 0, cycles: 0, startedAt: 3000,
  endedAt: 4000, bpmMin: 120, bpmMax: 120, shortNotes: 0, holdChecked: 1,
};

function startOf(over: Partial<AttemptStart> = {}): AttemptStart {
  return {
    score: { id: "local:abc", title: "Two", composer: null },
    options: liveOptions,
    plan,
    timeline: tl,
    settings: DEFAULT_SETTINGS,
    startedWall: "2026-11-05T07:00:00.000Z",
    pageStartMs: 1000,
    t0Ms: 3000,
    pedalDown: false,
    autoplayOn: false,
    ...over,
  };
}

function endOf(over: Partial<AttemptEnd> = {}): AttemptEnd {
  return {
    end: "done",
    endedWall: "2026-11-05T07:00:03.000Z",
    endedPageMs: 4000,
    counts,
    metrics: { accuracy: "33%", tempo: "120", wrong: "1", missed: "1" },
    rows: [["Mode", "Live"]],
    ...over,
  };
}

const hit = (step: number, outcome: "hit" | "early" | "late" | "missed" = "hit"): FollowRecord => ({
  kind: "step", step, cycle: 1, outcome, dtMs: 0, matchedNotes: 1, missedNotes: 0, at: 1500,
});

function resultsOf(records: FollowRecord[]): string[] {
  const rec = createAttemptRecorder();
  rec.begin(startOf());
  for (const r of records) rec.result(r);
  const a = rec.finish(endOf());
  assert.ok(a);
  return a.steps.map((s) => s.result);
}

test("a live run builds the version 1 attempt", () => {
  const rec = createAttemptRecorder();
  rec.begin(startOf());
  rec.event(on(60, 500), 3010.04);
  rec.result({ kind: "note", step: 0, cycle: 1, note: 60, dtMs: 10.04, at: 3010.04 });
  rec.result({ kind: "step", step: 0, cycle: 1, outcome: "hit", dtMs: 10.04, score: 100, matchedNotes: 1, missedNotes: 0, at: 3010.04 });
  rec.event(on(61, 900), 3400);
  rec.result({ kind: "wrong", step: 1, cycle: 1, note: 61, at: 3400 });
  rec.event(off(60, 950), 3450);
  rec.result({ kind: "hold", step: 0, cycle: 1, note: 60, heldMs: 440, expectedMs: 500, short: false, at: 3450 });
  rec.result({ kind: "step", step: 1, cycle: 1, outcome: "missed", dtMs: null, matchedNotes: 0, missedNotes: 1, at: 3800 });
  const a = rec.finish(endOf());
  assert.ok(a);
  assert.deepEqual(Object.keys(a), [
    "version", "kind", "score", "mode", "end", "started_at", "ended_at", "duration_ms", "clock", "practice",
    "plan", "settings", "autoplay", "sources", "pedal_down_at_start", "steps", "events", "summary",
    "drill_id", "plan_id", "tags",
  ]);
  assert.equal(a.version, 2);
  assert.equal(a.kind, "rusty_piano.attempt");
  assert.equal(a.duration_ms, 3000);
  assert.deepEqual(a.sources, ["engine"]);
  assert.equal(a.autoplay.used, false);
  assert.equal(a.settings.window_ms, 200);
  assert.deepEqual(a.settings.timing, { perfect_ms: 20, zero_ms: 250, curve: 1, red_score: 30, green_score: 90 });
  assert.equal(a.plan.steps_total, 2);
  assert.deepEqual(a.clock, { page_start_ms: 1000, t0_ms: 2000, first_engine_t: 500, first_engine_page_ms: 2010 });
  assert.deepEqual(a.steps, [
    {
      cycle: 1, step: 0, source_step: 0, bar: 1, beat: 0, pass: 1, time_q: 0, expected: [60], length_q: 1, result: "hit", outcome: "hit",
      offset_ms: 10, timing_score: 100, played: [{ note: 60, offset_ms: 10, page_ms: 2010 }], wrong: [],
      holds: [{ note: 60, held_ms: 440, expected_ms: 500, short: false, page_ms: 2450 }],
    },
    {
      cycle: 1, step: 1, source_step: 1, bar: 1, beat: 1, pass: 1, time_q: 1, expected: [62], length_q: 1, result: "missed", outcome: "missed",
      offset_ms: null, timing_score: null, played: [], wrong: [{ note: 61, page_ms: 2400 }], holds: [],
    },
  ]);
  assert.deepEqual(a.events, [
    { type: "note_on", t: 500, page_ms: 2010, source: "engine", note: 60, velocity: 100 },
    { type: "note_on", t: 900, page_ms: 2400, source: "engine", note: 61, velocity: 100 },
    { type: "note_off", t: 950, page_ms: 2450, source: "engine", note: 60 },
  ]);
  assert.deepEqual(a.summary, { counts, metrics: { accuracy: "33%", tempo: "120", wrong: "1", missed: "1" }, rows: [["Mode", "Live"]] });
});

test("a run with no drill has null drill and plan ids and no tags", () => {
  const rec = createAttemptRecorder();
  rec.begin(startOf());
  rec.result(hit(0));
  const a = rec.finish(endOf());
  assert.ok(a);
  assert.equal(a.drill_id, null);
  assert.equal(a.plan_id, null);
  assert.deepEqual(a.tags, []);
});

test("a run begun with a drill keeps its drill id, plan id and tags", () => {
  const rec = createAttemptRecorder();
  rec.begin(startOf({ drill: { drill_id: "r2.steps", plan_id: "2026-11-05", tags: ["fun"] } }));
  rec.result(hit(0));
  const a = rec.finish(endOf());
  assert.ok(a);
  assert.equal(a.drill_id, "r2.steps");
  assert.equal(a.plan_id, "2026-11-05");
  assert.deepEqual(a.tags, ["fun"]);
});

test("changing the tags array after begin does not change the finished attempt", () => {
  const tags = ["fun"];
  const rec = createAttemptRecorder();
  rec.begin(startOf({ drill: { drill_id: "r2.steps", plan_id: null, tags } }));
  tags.push("late");
  rec.result(hit(0));
  const a = rec.finish(endOf());
  assert.ok(a);
  assert.deepEqual(a.tags, ["fun"]);
});

test("result precedence: missed, wrong, short, outcome, pending", () => {
  const shortHold: FollowRecord = { kind: "hold", step: 0, cycle: 1, note: 60, heldMs: 100, expectedMs: 500, short: true, at: 1100 };
  const wrong: FollowRecord = { kind: "wrong", step: 0, cycle: 1, note: 61, at: 1200 };
  const note: FollowRecord = { kind: "note", step: 0, cycle: 1, note: 60, dtMs: null, at: 1000 };
  assert.deepEqual(resultsOf([hit(0), shortHold]), ["short"]);
  assert.deepEqual(resultsOf([hit(0), wrong]), ["wrong"]);
  assert.deepEqual(resultsOf([note, hit(1)]), ["pending", "hit"]);
  assert.deepEqual(resultsOf([hit(0, "early")]), ["early"]);
});

test("finish gives nothing when not begun, with no steps, with nothing recorded, or twice", () => {
  const rec = createAttemptRecorder();
  assert.equal(rec.finish(endOf()), null);
  const empty = practicePlan([], { hands: "both", range: null, loop: false });
  rec.begin(startOf({ plan: empty, timeline: [] }));
  rec.event(on(60, 500), 1500);
  assert.equal(rec.finish(endOf()), null);
  rec.begin(startOf());
  assert.equal(rec.finish(endOf()), null);
  rec.begin(startOf());
  rec.result(hit(0));
  assert.ok(rec.finish(endOf()));
  assert.equal(rec.finish(endOf()), null);
});

test("an empty finish leaves the recorder inactive so later events are dropped", () => {
  const empty = practicePlan([], { hands: "both", range: null, loop: false });
  for (const start of [startOf(), startOf({ plan: empty, timeline: [] })]) {
    const rec = createAttemptRecorder();
    rec.begin(start);
    assert.equal(rec.finish(endOf()), null);
    assert.equal(rec.active(), false);
    rec.event(on(60, 500), 1500);
    rec.result(hit(0));
    assert.equal(rec.finish(endOf()), null);
  }
});

test("cancel makes the recorder inactive and drops the data", () => {
  const rec = createAttemptRecorder();
  rec.begin(startOf());
  assert.equal(rec.active(), true);
  rec.event(on(60, 500), 1500);
  rec.cancel();
  assert.equal(rec.active(), false);
  assert.equal(rec.finish(endOf()), null);
});

test("autoplay events mark the attempt as used", () => {
  const rec = createAttemptRecorder();
  rec.begin(startOf({ autoplayOn: true }));
  rec.event({ type: "note_on", t: 100, note: 60, velocity: 80, source: "autoplay" }, 1100);
  rec.event(on(62, 500), 1500);
  rec.result(hit(0));
  const a = rec.finish(endOf());
  assert.ok(a);
  assert.equal(a.autoplay.used, true);
  assert.equal(a.autoplay.on_at_start, true);
  assert.deepEqual(a.sources, ["autoplay", "engine"]);
});

test("a live run stopped during the count-in saves nothing", () => {
  const rec = createAttemptRecorder();
  rec.begin(startOf());
  rec.event(on(60, 500), 2000);
  rec.result({ kind: "wrong", step: 0, cycle: 1, note: 61, at: 2000 });
  assert.equal(rec.finish(endOf({ end: "stop", endedPageMs: 2500 })), null);
  assert.equal(rec.active(), false);
});

test("a live run stopped after t0 with every step pending saves nothing", () => {
  const rec = createAttemptRecorder();
  rec.begin(startOf());
  rec.result({ kind: "note", step: 0, cycle: 1, note: 60, dtMs: null, at: 3100 });
  assert.equal(rec.finish(endOf({ end: "stop", endedPageMs: 3500 })), null);
});

test("a wait-mode run with one wrong note is saved", () => {
  const rec = createAttemptRecorder();
  rec.begin(startOf({ options: { ...liveOptions, mode: "wait", countInBeats: 0 }, t0Ms: 1000 }));
  rec.result({ kind: "wrong", step: 0, cycle: 1, note: 61, at: 1200 });
  const a = rec.finish(endOf({ end: "stop" }));
  assert.ok(a);
  assert.equal(a.steps[0].result, "wrong");
});

test("length_q is the longest written note of the step, rounded, or null", () => {
  const ltl = [
    { index: 0, written: 0, bar: 1, beat: 0, time: 0, writtenTime: 0, measureQuarters: 4, bpm: 120, pass: 1, notes: [{ midi: 60, staff: 0, quarters: 2 }, { midi: 64, staff: 0, quarters: 0.5 }] },
    { index: 1, written: 1, bar: 1, beat: 1, time: 1, writtenTime: 1, measureQuarters: 4, bpm: 120, pass: 1, notes: [{ midi: 62, staff: 0, quarters: 1 / 3 }] },
    { index: 2, written: 2, bar: 1, beat: 2, time: 2, writtenTime: 2, measureQuarters: 4, bpm: 120, pass: 1, notes: [{ midi: 65, staff: 0 }] },
  ];
  const lplan = practicePlan(ltl, { hands: "both", range: null, loop: false });
  const rec = createAttemptRecorder();
  rec.begin(startOf({ plan: lplan, timeline: ltl }));
  rec.result(hit(0));
  rec.result(hit(1));
  rec.result(hit(2));
  const a = rec.finish(endOf());
  assert.ok(a);
  assert.deepEqual(a.steps.map((s) => s.length_q), [2, 0.3333, null]);
});

test("a real follower feeds the recorder and every hit step is recorded as hit", () => {
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
  const rec = createAttemptRecorder();
  follower.onResult((r) => rec.result(r));
  const o: FollowOptions = { ...liveOptions, countInBeats: 0, holds: null };
  follower.start(o);
  rec.begin(startOf({ options: o, pageStartMs: 0, t0Ms: follower.startTime() }));
  const at = (t: number, ev: LiveEvent | null) => {
    clock.t = t;
    if (ev) {
      rec.event(ev, t);
      follower.handle(ev);
    } else {
      follower.tick();
    }
  };
  at(0, on(60, 0));
  at(500, on(62, 500));
  at(550, off(60, 550));
  at(600, off(62, 600));
  for (let t = 1000; follower.status().state !== "done" && t <= 3000; t += 100) at(t, null);
  const c = follower.status().counts!;
  const a = rec.finish(endOf({ counts: c }));
  assert.ok(a);
  assert.equal(a.steps.length, 2);
  assert.equal(a.steps.filter((s) => s.outcome === "hit").length, c.hitSteps);
  assert.ok(a.steps.every((s) => s.result === "hit"));
});

test("a run without a ramp has practice.tempo.ramp null", () => {
  const rec = createAttemptRecorder();
  rec.begin(startOf());
  rec.result(hit(0));
  const a = rec.finish(endOf());
  assert.ok(a);
  assert.equal(a.practice.tempo.ramp, null);
});

test("tempo records fill the ramp cycles and never become steps", () => {
  const rec = createAttemptRecorder();
  const ramp = { stepPercent: 5, targetPercent: 100, backAfterBad: 2 };
  rec.begin(startOf({ options: { ...liveOptions, loop: true, percent: 60, ramp } }));
  const records: FollowRecord[] = [
    { kind: "tempo", cycle: 2, percent: 65, at: 1500 },
    { kind: "tempo", cycle: 3, percent: 70, at: 1600 },
    hit(0),
  ];
  for (const r of records) rec.result(r);
  const a = rec.finish(endOf());
  assert.ok(a);
  assert.deepEqual(a.practice.tempo.ramp, {
    step_percent: 5,
    target_percent: 100,
    back_after_bad: 2,
    cycles: [
      { cycle: 1, percent: 60 },
      { cycle: 2, percent: 65 },
      { cycle: 3, percent: 70 },
    ],
  });
  assert.equal(a.steps.length, 1);
});

test("a real wait-mode follower with a ramp records each loop's percent", () => {
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
  const rec = createAttemptRecorder();
  follower.onResult((r) => rec.result(r));
  const o: FollowOptions = {
    ...liveOptions, mode: "wait", loop: true, percent: 60,
    ramp: { stepPercent: 5, targetPercent: 100, backAfterBad: 2 }, countInBeats: 0, holds: null,
  };
  follower.start(o);
  rec.begin(startOf({ options: o, pageStartMs: 0, t0Ms: follower.startTime() }));
  for (let loop = 0; loop < 2; loop++) {
    follower.handle(on(60, 0));
    follower.handle(off(60, 0));
    follower.handle(on(62, 0));
    follower.handle(off(62, 0));
  }
  const a = rec.finish(endOf());
  assert.ok(a);
  assert.deepEqual(a.practice.tempo.ramp?.cycles.map((c) => c.percent), [60, 65, 70]);
});
