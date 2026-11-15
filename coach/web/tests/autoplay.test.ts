import { test } from "node:test";
import assert from "node:assert/strict";
import { autoplaySchedule, createAutoplayer, midiToHz, mulberry32 } from "../src/autoplay.ts";
import { createLiveMatcher } from "../src/live-matcher.ts";
import { createWaitMatcher } from "../src/note-matcher.ts";
import type { AutoplayKnobs } from "../src/autoplay.ts";
import type { LiveEvent } from "../src/engine-socket.ts";

const K: AutoplayKnobs = { velocity: 80, gatePercent: 90, offsetMs: 0, jitterMs: 0, skipEvery: 0, wrongEvery: 0, seed: 1 };
const S = [
  { pitches: [60], time: 0 },
  { pitches: [62, 65], time: 1 },
  { pitches: [64], time: 2 },
];

test("base schedule", () => {
  assert.deepEqual(autoplaySchedule(S, 500, K, 3), [
    { on: 0, off: 450, note: 60, velocity: 80 },
    { on: 500, off: 950, note: 62, velocity: 80 },
    { on: 500, off: 950, note: 65, velocity: 80 },
    { on: 1000, off: 1450, note: 64, velocity: 80 },
  ]);
});

test("offset, skip, wrong", () => {
  const base = autoplaySchedule(S, 500, K, 3);
  const off = autoplaySchedule(S, 500, { ...K, offsetMs: 150 }, 3);
  assert.deepEqual(off, base.map((n) => ({ ...n, on: n.on + 150, off: n.off + 150 })));
  const skip = autoplaySchedule(S, 500, { ...K, skipEvery: 2 }, 3);
  assert.deepEqual(skip.map((n) => n.note), [60, 64]);
  const wrong = autoplaySchedule(S, 500, { ...K, wrongEvery: 3 }, 3);
  assert.ok(wrong.some((n) => n.note === 65 && n.on === 999 && n.off === 1450));
});

test("jitter is deterministic and independent of skips", () => {
  const k = { ...K, jitterMs: 100 };
  const a = autoplaySchedule(S, 500, k, 3);
  assert.deepEqual(a, autoplaySchedule(S, 500, k, 3));
  assert.equal(a[1].on, a[2].on);
  for (const n of a) {
    const t = n.note === 60 ? 0 : n.note === 64 ? 1000 : 500;
    assert.ok(Math.abs(n.on - t) <= 100);
  }
  const b = autoplaySchedule(S, 500, { ...k, skipEvery: 2 }, 3);
  assert.equal(b.find((n) => n.note === 60)?.on, a.find((n) => n.note === 60)?.on);
  assert.equal(b.find((n) => n.note === 64)?.on, a.find((n) => n.note === 64)?.on);
});

test("same pitch overlap is trimmed", () => {
  const n = autoplaySchedule([{ pitches: [60], time: 0 }, { pitches: [60], time: 0.5 }], 500, { ...K, gatePercent: 100 }, 1);
  assert.ok(n[0].off < n[1].on);
});

test("mulberry32 and midiToHz", () => {
  const a = mulberry32(1);
  const b = mulberry32(1);
  for (let i = 0; i < 3; i++) {
    const v = a();
    assert.equal(v, b());
    assert.ok(v >= 0 && v < 1);
  }
  assert.equal(midiToHz(69), 440);
  assert.ok(Math.abs(midiToHz(60) - 261.63) < 0.01);
});

function rig(hook?: (e: LiveEvent, r: { stop(): void }) => void) {
  let now = 0;
  let timer: { fn: () => void; due: number } | null = null;
  const events: LiveEvent[] = [];
  const noteOns: number[][] = [];
  const player = createAutoplayer({
    publish: (e) => {
      events.push(e);
      hook?.(e, { stop: () => player.stop() });
    },
    now: () => now,
    setTimer: (fn, ms) => {
      timer = { fn, due: now + ms };
      return timer;
    },
    clearTimer: () => {
      timer = null;
    },
    onNoteOn: (n, v, d) => noteOns.push([n, v, d]),
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
  return { player, events, noteOns, advance, setNow: (n: number) => (now = n), timers: () => (timer === null ? 0 : 1) };
}

const sched = autoplaySchedule(S, 500, K, 3);
const sig = (e: LiveEvent) => `${e.type}:${"note" in e ? e.note : ""}@${e.t}`;

test("player plays the schedule", () => {
  const r = rig();
  r.player.play(sched, 1000, null);
  assert.ok(r.player.playing());
  r.advance(3000);
  assert.deepEqual(r.events.map(sig), [
    "note_on:60@1000", "note_off:60@1450", "note_on:62@1500", "note_on:65@1500",
    "note_off:62@1950", "note_off:65@1950", "note_on:64@2000", "note_off:64@2450",
  ]);
  assert.ok(r.events.every((e) => e.source === "autoplay"));
  assert.deepEqual(r.noteOns[0], [60, 80, 450]);
  assert.equal(r.player.playing(), false);
});

test("stop releases held notes", () => {
  const r = rig();
  r.player.play(sched, 1000, null);
  r.advance(1200);
  r.player.stop();
  assert.deepEqual(r.events.map(sig), ["note_on:60@1000", "note_off:60@1200"]);
  r.advance(3000);
  assert.equal(r.events.length, 2);
  assert.equal(r.player.playing(), false);
});

test("late start skips past events", () => {
  const r = rig();
  r.setNow(1600);
  r.player.play(sched, 1000, null);
  r.advance(3000);
  assert.equal(sig(r.events[0]), "note_on:64@2000");
});

test("loop starts the next cycle", () => {
  const r = rig();
  r.player.play(sched, 1000, 1500);
  r.advance(2600);
  assert.ok(r.events.map(sig).includes("note_on:60@2500"));
  r.player.stop();
});

const EIGHT = Array.from({ length: 8 }, (_, k) => ({ pitches: [60 + k], time: k }));

test("wrong note on the last step arrives before its correct notes", () => {
  const n = autoplaySchedule(EIGHT, 500, { ...K, wrongEvery: 8 }, 8);
  const wrong = n.find((x) => x.note === 68)!;
  const right = n.find((x) => x.note === 67)!;
  assert.ok(wrong.on < right.on);
});

test("live end to end: skipEvery 3, wrongEvery 4 gives wrong 2, missed 2", () => {
  const m = createLiveMatcher(EIGHT, { msPerQuarter: 500, windowMs: 200, onTimeMs: 80, loopQuarters: null });
  m.start(1000);
  const results: ReturnType<typeof m.press> = [];
  const r = rig((e) => {
    if (e.type === "note_on") results.push(...m.press(e.note, e.t));
  });
  r.player.play(autoplaySchedule(EIGHT, 500, { ...K, skipEvery: 3, wrongEvery: 4 }, 8), 1000, null);
  r.advance(6000);
  results.push(...m.tick(8000));
  assert.equal(results.filter((x) => x.kind === "wrong").length, 2);
  assert.equal(results.filter((x) => x.kind === "outcome" && x.outcome === "missed").length, 2);
});

test("wait mode: wrong note counts against its own step", () => {
  const m = createWaitMatcher(EIGHT);
  const wrongSteps: number[] = [];
  const r = rig((e) => {
    for (const x of m.handle(e)) if (x.kind === "wrong") wrongSteps.push(x.step);
  });
  r.player.play(autoplaySchedule(EIGHT, 500, { ...K, wrongEvery: 4 }, 8), 1000, null);
  r.advance(6000);
  assert.deepEqual(wrongSteps, [3, 7]);
});

test("stop() inside a callback publishes nothing more and arms no timer", () => {
  const r = rig((e, p) => {
    if (e.type === "note_on") p.stop();
  });
  r.player.play(sched, 1000, null);
  r.advance(1000);
  const count = r.events.length;
  assert.equal(r.timers(), 0);
  r.advance(3000);
  assert.equal(r.events.length, count);
  assert.equal(r.player.playing(), false);
});

test("negative offset beyond the lead still plays the first note", () => {
  const r = rig();
  const s = autoplaySchedule(S, 500, { ...K, offsetMs: -700 }, 3);
  r.setNow(5000);
  r.player.play(s, 5600, null, { shiftToNow: true });
  r.advance(9000);
  assert.equal(r.events.filter((e) => e.type === "note_on")[0]?.note, 60);
});

test("live timing stays exact without shiftToNow", () => {
  const four = [0, 1, 2, 3].map((k) => ({ pitches: [60 + k], time: k }));
  const m = createLiveMatcher(four, { msPerQuarter: 500, windowMs: 400, onTimeMs: 80, loopQuarters: null });
  m.start(5100);
  const results: ReturnType<typeof m.press> = [];
  const r = rig((e) => {
    if (e.type === "note_on") results.push(...m.press(e.note, e.t));
  });
  r.setNow(5000);
  r.player.play(autoplaySchedule(four, 500, { ...K, offsetMs: -150 }, 4), 5100, null);
  r.advance(9000);
  const ons = r.events.filter((e) => e.type === "note_on").map((e) => e.t);
  assert.deepEqual(ons, [5600 - 150, 6100 - 150, 6600 - 150]);
  assert.equal(results.filter((x) => x.kind === "outcome" && x.outcome === "early").length, 3);
});

const TM = { msAt: (q: number) => (q <= 4 ? q * 500 : 2000 + (q - 4) * 1000), quartersAt: (ms: number) => (ms <= 2000 ? ms / 500 : 4 + (ms - 2000) / 1000) };
const E8 = Array.from({ length: 8 }, (_, k) => ({ pitches: [60 + k], time: k }));

test("per-note lengths", () => {
  const steps = [
    { pitches: [60, 64], time: 0, lengths: [4, 1] },
    { pitches: [62], time: 1, lengths: [1] },
  ];
  assert.deepEqual(autoplaySchedule(steps, 500, K, 4), [
    { on: 0, off: 1800, note: 60, velocity: 80 },
    { on: 0, off: 450, note: 64, velocity: 80 },
    { on: 500, off: 950, note: 62, velocity: 80 },
  ]);
});

test("tempo map msAt", () => {
  const s = autoplaySchedule(E8, 500, K, 8, TM.msAt);
  assert.deepEqual(s.map((x) => x.on), [0, 500, 1000, 1500, 2000, 3000, 4000, 5000]);
  assert.equal(s[3].off, 1950);
  assert.equal(s[4].off, 2900);
});

test("shortEvery", () => {
  const steps = [0, 1, 2, 3].map((k) => ({ pitches: [60 + k], time: 2 * k, lengths: [2] }));
  const s = autoplaySchedule(steps, 500, { ...K, shortEvery: 2 }, 8);
  assert.deepEqual(s.map((x) => x.off - x.on), [900, 200, 900, 200]);
});
