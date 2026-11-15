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
import type { LiveEvent, LiveSource } from "../src/engine-socket.ts";

const HOLDS = { minPercent: 50, minNoteMs: 500, pedal: true };

const noteOn = (note: number, source: LiveSource): LiveEvent => ({ type: "note_on", t: 0, note, velocity: 100, source });
const noteOff = (note: number, source: LiveSource): LiveEvent => ({ type: "note_off", t: 0, note, source });
const sustain = (isOn: boolean, source: LiveSource): LiveEvent => ({ type: "sustain", t: 0, on: isOn, source });

function steps(): PlanSourceStep[] {
  return [60, 62].map((p, i) => ({
    index: i,
    written: i,
    bar: 1,
    beat: i * 2,
    time: i * 2,
    writtenTime: i * 2,
    measureQuarters: 4,
    bpm: 120,
    notes: [{ midi: p, staff: 0, quarters: 2 }],
  }));
}

const liveOpts = (): FollowOptions => ({
  mode: "live", hands: "both", range: null, loop: false, bpm: 120, percent: 100,
  countInBeats: 0, beatQuarters: 1, windowMs: 200, onTimeMs: 100, slide: true, holds: HOLDS,
});

function setup() {
  const calls: string[] = [];
  const clock = { t: 0 };
  const tl = steps();
  const view: FollowView = {
    timeline: () => tl,
    setFollowing: () => {},
    showNeedle: () => {},
    slideNeedle: () => {},
    markStep: () => {},
    flashWrong: () => {},
    clearMarks: () => {},
    markShort: (s) => calls.push(`markShort:${s}`),
  };
  const follower = createFollower({
    view,
    now: () => clock.t,
    deps: { createWaitMatcher, createLiveMatcher, practicePlan, createTempoMap, createHoldChecker },
  });
  return { follower, calls, clock };
}

type F = ReturnType<typeof setup>;
function at(f: F, t: number, ev: LiveEvent): void {
  f.clock.t = t;
  f.follower.handle(ev);
}

test("engine pedal does not excuse an autoplay note", () => {
  const f = setup();
  f.follower.handle(sustain(true, "engine"));
  f.follower.start(liveOpts());
  at(f, 0, noteOn(60, "autoplay"));
  at(f, 100, noteOff(60, "autoplay"));
  assert.ok(f.calls.includes("markShort:0"));
  assert.equal(f.follower.status().counts?.shortNotes, 1);
});

test("engine pedal holds an engine note", () => {
  const f = setup();
  f.follower.handle(sustain(true, "engine"));
  f.follower.start(liveOpts());
  at(f, 0, noteOn(60, "engine"));
  at(f, 100, noteOff(60, "engine"));
  assert.ok(!f.calls.includes("markShort:0"));
  assert.equal(f.follower.status().counts?.holdChecked, 1);
});

test("keyboard pedal holds a keyboard note", () => {
  const f = setup();
  f.follower.handle(sustain(true, "keyboard"));
  f.follower.start(liveOpts());
  at(f, 0, noteOn(60, "keyboard"));
  at(f, 100, noteOff(60, "keyboard"));
  assert.ok(!f.calls.includes("markShort:0"));
  assert.equal(f.follower.status().counts?.holdChecked, 1);
});

test("an engine pedal mid-run does not excuse an autoplay note", () => {
  const f = setup();
  f.follower.start(liveOpts());
  at(f, 0, noteOn(60, "autoplay"));
  at(f, 50, sustain(true, "engine"));
  at(f, 100, noteOff(60, "autoplay"));
  assert.ok(f.calls.includes("markShort:0"));
  assert.equal(f.follower.status().counts?.shortNotes, 1);
});

test("an engine note stays held when an autoplay note starts", () => {
  const f = setup();
  f.follower.handle(sustain(true, "engine"));
  f.follower.start(liveOpts());
  at(f, 0, noteOn(60, "engine"));
  at(f, 100, noteOn(61, "autoplay"));
  at(f, 200, noteOff(60, "engine"));
  assert.ok(!f.calls.includes("markShort:0"));
  assert.equal(f.follower.status().counts?.shortNotes ?? 0, 0);
});

test("an autoplay note is short when an engine note starts", () => {
  const f = setup();
  f.follower.handle(sustain(true, "engine"));
  f.follower.start(liveOpts());
  at(f, 0, noteOn(60, "autoplay"));
  at(f, 100, noteOn(61, "engine"));
  at(f, 200, noteOff(60, "autoplay"));
  assert.ok(f.calls.includes("markShort:0"));
  assert.equal(f.follower.status().counts?.shortNotes, 1);
});

test("pedal() by source", () => {
  const f = setup();
  f.follower.handle(sustain(true, "engine"));
  assert.equal(f.follower.pedal(), true);
  assert.equal(f.follower.pedal("autoplay"), false);
  assert.equal(f.follower.pedal("engine"), true);
});
