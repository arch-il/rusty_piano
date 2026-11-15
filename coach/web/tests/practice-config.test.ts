import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS } from "../src/follower-settings.ts";
import {
  autoplayKnobs,
  autoplaySlice,
  barsText,
  countInClicks,
  followOptions,
  rangeText,
  shiftedMsAt,
} from "../src/practice-config.ts";

const live = { mode: "live", hands: "right", percent: 60, loop: true, autoplay: false } as const;

test("followOptions live", () => {
  assert.deepEqual(
    followOptions(DEFAULT_SETTINGS, live, { tempoBpm: 120, beats: 3, beatType: 4 }, { from: 3, to: 4 }, 72),
    {
      mode: "live",
      hands: "right",
      range: { from: 3, to: 4 },
      loop: true,
      bpm: 72,
      percent: 60,
      holds: { minPercent: 50, minNoteMs: 500, pedal: true, staccatoMaxPercent: 60 },
      countInBeats: 3,
      beatQuarters: 1,
      windowMs: 200,
      onTimeMs: 80,
      slide: true,
      timing: { perfectMs: 20, zeroMs: 250, curve: 1 },
      ramp: null,
    },
  );
});

test("followOptions ramp", () => {
  const f = (ui: object) => followOptions(DEFAULT_SETTINGS, { ...live, ...ui }, null, null, 72).ramp;
  assert.deepEqual(f({ ramp: true, rampTarget: null }), { stepPercent: 5, targetPercent: 100, backAfterBad: 2 });
  assert.equal(f({ ramp: true, rampTarget: 200 })!.targetPercent, 150);
  assert.equal(f({ ramp: true, loop: false }), null);
});

test("followOptions holds in wait mode", () => {
  const w = { ...live, mode: "wait" } as const;
  assert.equal(followOptions(DEFAULT_SETTINGS, w, null, null, 60).holds, null);
  const s = { ...DEFAULT_SETTINGS, holds: { ...DEFAULT_SETTINGS.holds, wait: true } };
  assert.deepEqual(followOptions(s, w, null, null, 60).holds, { minPercent: 50, minNoteMs: 500, pedal: true, staccatoMaxPercent: 60 });
});

test("shiftedMsAt", () => {
  assert.equal(shiftedMsAt((q) => q * 500, 4)(2), 1000);
  assert.equal(shiftedMsAt((q) => (q <= 4 ? q * 500 : 2000 + (q - 4) * 1000), 3)(2), 1500);
});

test("autoplaySlice keeps lengths", () => {
  const plan = {
    steps: [{ index: 0, source: 0, pitches: [60], time: 1, bar: 1, lengths: [2] }],
    lengthQuarters: 4,
    firstBar: 1,
    lastBar: 1,
  };
  assert.deepEqual(autoplaySlice(plan as never, 0).steps, [{ pitches: [60], time: 0, lengths: [2] }]);
});

test("followOptions wait, null info, 6/8", () => {
  assert.equal(followOptions(DEFAULT_SETTINGS, { ...live, mode: "wait" }, null, null, 60).countInBeats, 0);
  const n = followOptions(DEFAULT_SETTINGS, live, null, null, 60);
  assert.equal(n.countInBeats, 4);
  assert.equal(n.beatQuarters, 1);
  const e = followOptions(DEFAULT_SETTINGS, live, { tempoBpm: null, beats: 6, beatType: 8 }, null, 60);
  assert.equal(e.beatQuarters, 0.5);
  assert.equal(e.countInBeats, 6);
});

test("countInClicks", () => {
  assert.deepEqual(countInClicks(5000, 4, 500, 4), [
    { at: 3000, accent: true },
    { at: 3500, accent: false },
    { at: 4000, accent: false },
    { at: 4500, accent: false },
  ]);
  const c = countInClicks(5000, 6, 500, 3);
  assert.deepEqual(c.map((x) => x.accent), [true, false, false, true, false, false]);
  assert.deepEqual(countInClicks(5000, 0, 500, 4), []);
});

test("rangeText and barsText", () => {
  assert.equal(rangeText(null, false), "");
  assert.equal(rangeText({ from: 2, to: 2 }, true), "Bar 2");
  assert.equal(rangeText({ from: 2, to: 2 }, false), "From bar 2");
  assert.equal(rangeText({ from: 2, to: 5 }, false), "Bars 2-5");
  assert.equal(barsText(null, true), "All");
  assert.equal(barsText({ from: 2, to: 5 }, true), "Bars 2-5");
});

test("autoplaySlice", () => {
  const plan = {
    steps: [
      { index: 0, source: 0, pitches: [60], time: 0, bar: 1 },
      { index: 1, source: 1, pitches: [62], time: 1, bar: 1 },
      { index: 2, source: 2, pitches: [64], time: 2.5, bar: 2 },
    ],
    tempo: [],
    lengthQuarters: 4,
    firstBar: 1,
    lastBar: 2,
  };
  assert.deepEqual(autoplaySlice(plan as never, 1), {
    steps: [
      { pitches: [62], time: 0 },
      { pitches: [64], time: 1.5 },
    ],
    lengthQuarters: 3,
  });
  assert.deepEqual(autoplaySlice(plan as never, 3), { steps: [], lengthQuarters: 0 });
});

test("autoplayKnobs", () => {
  const a = DEFAULT_SETTINGS.autoplay;
  assert.deepEqual(autoplayKnobs(DEFAULT_SETTINGS), {
    velocity: a.velocity,
    gatePercent: a.gatePercent,
    staccatoGatePercent: a.staccatoGatePercent,
    offsetMs: a.offsetMs,
    jitterMs: a.jitterMs,
    skipEvery: a.skipEvery,
    wrongEvery: a.wrongEvery,
    shortEvery: a.shortEvery,
    seed: a.seed,
  });
});
