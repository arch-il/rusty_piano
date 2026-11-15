import { test } from "node:test";
import assert from "node:assert/strict";
import { createAutoplayer } from "../src/autoplay.ts";
import { createLiveKeys } from "../src/live-keys.ts";
import type { ScheduledNote } from "../src/autoplay.ts";
import type { LiveEvent } from "../src/engine-socket.ts";

function rig(onEvent?: (ev: LiveEvent, stop: () => void) => void) {
  let clock = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const keys = createLiveKeys();
  const log: LiveEvent[] = [];
  const player = createAutoplayer({
    publish: (ev) => {
      log.push(ev);
      keys.apply(ev);
      onEvent?.(ev, () => player.stop());
    },
    now: () => clock,
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { at: clock + ms, fn });
      return id;
    },
    clearTimer: (id) => {
      timers.delete(id as number);
    },
  });
  const advance = (to: number): void => {
    for (;;) {
      let best: number | null = null;
      for (const [id, t] of timers) if (t.at <= to && (best === null || t.at < timers.get(best)!.at)) best = id;
      if (best === null) break;
      const t = timers.get(best)!;
      timers.delete(best);
      clock = Math.max(clock, t.at);
      t.fn();
    }
    clock = to;
  };
  return { player, keys, log, advance, timers };
}

const NOTES: ScheduledNote[] = [
  { on: 0, off: 400, note: 60, velocity: 80 },
  { on: 500, off: 900, note: 60, velocity: 80 },
  { on: 500, off: 900, note: 64, velocity: 80 },
];

test("stop mid-note releases the held key", () => {
  const r = rig();
  r.player.play(NOTES, 0, null);
  r.advance(200);
  assert.deepEqual(r.keys.held(), [60]);
  r.player.stop();
  assert.deepEqual(r.keys.held(), []);
  assert.equal(r.timers.size, 0);
  r.advance(5000);
  assert.deepEqual(r.keys.held(), []);
});

test("stop right after a note-on in the same tick releases it", () => {
  const r = rig((ev, stop) => {
    if (ev.type === "note_on" && ev.note === 60) stop();
  });
  r.player.play(NOTES, 0, null);
  r.advance(0);
  assert.deepEqual(r.keys.held(), []);
  r.advance(5000);
  assert.deepEqual(r.keys.held(), []);
  assert.equal(r.log.filter((e) => e.type === "note_on").length, 1);
});

test("stop during count-in (before any note) leaves nothing lit and fires nothing", () => {
  const r = rig();
  r.player.play(NOTES, 2000, null);
  r.advance(1000);
  r.player.stop();
  r.advance(10000);
  assert.equal(r.log.length, 0);
  assert.deepEqual(r.keys.held(), []);
});

test("stop in a looping run then letting time pass never lights a key", () => {
  const r = rig();
  r.player.play(NOTES, 0, 1000);
  r.advance(1250);
  r.player.stop();
  r.advance(9000);
  assert.deepEqual(r.keys.held(), []);
  const ons = r.log.filter((e) => e.type === "note_on").length;
  const offs = r.log.filter((e) => e.type === "note_off").length;
  assert.equal(ons, offs);
});

test("play restarts cleanly after a stop mid-note", () => {
  const r = rig();
  r.player.play(NOTES, 0, null);
  r.advance(200);
  r.player.stop();
  r.player.play(NOTES, 300, null);
  r.advance(5000);
  assert.deepEqual(r.keys.held(), []);
  const ons = r.log.filter((e) => e.type === "note_on").length;
  const offs = r.log.filter((e) => e.type === "note_off").length;
  assert.equal(ons, offs);
});

test("stop twice is harmless", () => {
  const r = rig();
  r.player.play(NOTES, 0, null);
  r.advance(100);
  r.player.stop();
  r.player.stop();
  assert.deepEqual(r.keys.held(), []);
});
