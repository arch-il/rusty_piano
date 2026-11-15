import { test } from "node:test";
import assert from "node:assert/strict";
import { createAutoplayer } from "../src/autoplay.ts";
import type { ScheduledNote } from "../src/autoplay.ts";
import type { LiveEvent } from "../src/engine-socket.ts";

function rig() {
  let now = 0;
  let timer: { fn: () => void; due: number } | null = null;
  const events: LiveEvent[] = [];
  const noteOns: number[][] = [];
  const player = createAutoplayer({
    publish: (e) => {
      events.push(e);
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
  return { player, events, noteOns, advance, now: () => now };
}

const sig = (e: LiveEvent) => `${e.type}:${"note" in e ? e.note : ""}@${e.t}`;

const NOTES: ScheduledNote[] = [
  { on: 0, off: 400, note: 60, velocity: 80 },
  { on: 500, off: 900, note: 62, velocity: 80 },
];

test("per-cycle timing from cycleTiming", () => {
  const r = rig();
  const calls: number[][] = [];
  r.player.play(NOTES, 1000, 1000, {
    cycleTiming: (k) => {
      calls.push([k, r.now()]);
      return k === 1 ? { start: 2000, scale: 2 } : k === 2 ? { start: 2500, scale: 1 } : null;
    },
  });
  r.advance(3100);
  assert.deepEqual(r.events.map(sig), [
    "note_on:60@1000", "note_off:60@1400", "note_on:62@1500", "note_off:62@1900",
    "note_on:60@2000", "note_off:60@2200", "note_on:62@2250", "note_off:62@2450",
    "note_on:60@2500", "note_off:60@2900", "note_on:62@3000",
  ]);
  assert.deepEqual(calls, [[1, 1900], [2, 2450]]);
  assert.deepEqual(r.noteOns[2], [60, 80, 200]);
  r.advance(4100);
  assert.ok(r.events.map(sig).includes("note_on:60@4000"));
  r.player.stop();
});

test("without cycleTiming the loop timing is unchanged", () => {
  const r = rig();
  r.player.play(NOTES, 1000, 1000);
  r.advance(2100);
  assert.ok(r.events.map(sig).includes("note_on:60@2000"));
  r.player.stop();
});
