import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ACK_TIMEOUT_MS,
  STOP_COMMAND,
  createEarPlayer,
  playCommand,
} from "../src/ear-player.ts";
import type { EarPlayerDeps } from "../src/ear-player.ts";
import type { PlayAck } from "../src/engine-socket.ts";
import type { PromptNote } from "../src/ear-levels.ts";

const NOTES: PromptNote[] = [
  { note: 60, startMs: 0, durMs: 675, velocity: 80 },
  { note: 64, startMs: 750, durMs: 675, velocity: 80 },
];

interface Timer {
  id: number;
  due: number;
  fn: () => void;
  done: boolean;
}

interface Tone {
  midi: number;
  velocity: number;
  durMs: number;
  at: number;
}

function fakeDeps(opts: { connected?: boolean; source?: string | null; browser?: boolean } = {}) {
  let now = 0;
  const timers: Timer[] = [];
  const fake = {
    connected: opts.connected ?? true,
    source: opts.source === undefined ? "live" : opts.source,
    browser: opts.browser ?? true,
    sent: [] as string[],
    tones: [] as Tone[],
    browserStops: 0,
    listeners: new Set<(ack: PlayAck) => void>(),
    advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const due = timers
          .filter((t) => !t.done && t.due <= target)
          .sort((a, b) => a.due - b.due || a.id - b.id)[0];
        if (!due) break;
        due.done = true;
        now = due.due;
        due.fn();
      }
      now = target;
    },
    ack(id: string, ok: boolean, reason: string | null = null) {
      for (const fn of [...fake.listeners]) fn({ type: "play_ack", id, ok, notes: 2, reason });
    },
    deps: null as unknown as EarPlayerDeps,
  };
  fake.deps = {
    engineConnected: () => fake.connected,
    engineSource: () => fake.source,
    send: (text) => {
      if (!fake.connected) return false;
      fake.sent.push(text);
      return true;
    },
    onAck: (fn) => {
      fake.listeners.add(fn);
      return () => {
        fake.listeners.delete(fn);
      };
    },
    browserAvailable: () => fake.browser,
    browserNote: (midi, velocity, durMs) => {
      fake.tones.push({ midi, velocity, durMs, at: now });
    },
    browserStop: () => {
      fake.browserStops += 1;
    },
    setTimer: (fn, ms) => {
      const t: Timer = { id: timers.length, due: now + ms, fn, done: false };
      timers.push(t);
      return t.id;
    },
    clearTimer: (id) => {
      const t = timers[id as number];
      if (t) t.done = true;
    },
  };
  return fake;
}

test("playCommand produces the exact wire literal", () => {
  assert.equal(
    playCommand("ear-1", NOTES),
    '{"type":"play_notes","id":"ear-1","notes":"60:0:675:80,64:750:675:80"}',
  );
});

test("playCommand rounds and clamps to the engine limits and caps at 128 notes", () => {
  assert.equal(
    playCommand("x", [{ note: 10.6, startMs: -5, durMs: 0, velocity: 300 }]),
    '{"type":"play_notes","id":"x","notes":"11:0:1:127"}',
  );
  assert.equal(
    playCommand("x", [{ note: 60, startMs: 70000.4, durMs: 20000, velocity: 0 }]),
    '{"type":"play_notes","id":"x","notes":"60:60000:10000:1"}',
  );
  const many = Array.from({ length: 130 }, (_, i) => ({ note: 60, startMs: i, durMs: 10, velocity: 80 }));
  const notes = playCommand("x", many).slice(0, -2).split('"notes":"')[1].split(",");
  assert.equal(notes.length, 128);
});

test("engine ok: resolves with the engine source and unsubscribes", async () => {
  const f = fakeDeps();
  const player = createEarPlayer(f.deps);
  const result = player.play(NOTES);
  assert.deepEqual(f.sent, [playCommand("ear-1", NOTES)]);
  f.ack("ear-1", true);
  assert.deepEqual(await result, { source: "engine", note: null });
  assert.equal(f.listeners.size, 0);
  assert.deepEqual(f.tones, []);
});

test("ack ok:false falls back to the browser with the reason", async () => {
  const f = fakeDeps();
  const player = createEarPlayer(f.deps);
  const result = player.play(NOTES);
  f.ack("ear-1", false, "no output device");
  assert.deepEqual(await result, {
    source: "browser",
    note: "The engine has no sound output (no output device): playing a simple browser tone.",
  });
  assert.equal(f.listeners.size, 0);
  f.advance(1000);
  assert.deepEqual(
    f.tones.map((t) => [t.midi, t.at]),
    [
      [60, 0],
      [64, 750],
    ],
  );
});

test("ack timeout falls back, then the engine stays muted until resetEngine", async () => {
  const f = fakeDeps();
  const player = createEarPlayer(f.deps);
  const result = player.play(NOTES);
  f.advance(ACK_TIMEOUT_MS);
  assert.deepEqual(await result, {
    source: "browser",
    note: "The engine did not answer the play request (restart it with the new build): playing a simple browser tone.",
  });
  assert.equal(f.listeners.size, 0);

  const muted = player.play(NOTES);
  assert.deepEqual(f.sent, [playCommand("ear-1", NOTES)]);
  assert.equal((await muted).source, "browser");

  player.resetEngine();
  const again = player.play(NOTES);
  assert.deepEqual(f.sent, [playCommand("ear-1", NOTES), playCommand("ear-2", NOTES)]);
  f.ack("ear-2", true);
  assert.deepEqual(await again, { source: "engine", note: null });
});

test("not connected falls back without sending", async () => {
  const f = fakeDeps({ connected: false });
  const player = createEarPlayer(f.deps);
  assert.deepEqual(await player.play(NOTES), {
    source: "browser",
    note: "Engine not connected: playing a simple browser tone. Start the engine (make dev) for the piano sound.",
  });
  assert.deepEqual(f.sent, []);
});

test("connected but not a live session (demo) falls back at once without sending", async () => {
  const f = fakeDeps({ source: "demo" });
  const player = createEarPlayer(f.deps);
  assert.deepEqual(await player.play(NOTES), {
    source: "browser",
    note: "Engine is not a live session: playing a simple browser tone.",
  });
  assert.deepEqual(f.sent, []);
  assert.equal(f.listeners.size, 0);
});

test("no browser audio resolves with source none", async () => {
  const f = fakeDeps({ connected: false, browser: false });
  const player = createEarPlayer(f.deps);
  assert.deepEqual(await player.play(NOTES), {
    source: "none",
    note: "No sound: start the engine (make dev) to hear the questions.",
  });
  f.advance(2000);
  assert.deepEqual(f.tones, []);
});

test("stop sends play_stop, cancels a pending ack wait and stops the browser", async () => {
  const f = fakeDeps();
  const player = createEarPlayer(f.deps);
  const result = player.play(NOTES);
  player.stop();
  assert.deepEqual(f.sent, [playCommand("ear-1", NOTES), STOP_COMMAND]);
  assert.equal(f.browserStops, 1);
  assert.deepEqual(await result, { source: "engine", note: null });
  assert.equal(f.listeners.size, 0);
});

test("stop clears pending browser tone timers", async () => {
  const f = fakeDeps({ connected: false });
  const player = createEarPlayer(f.deps);
  await player.play(NOTES);
  player.stop();
  f.advance(2000);
  assert.deepEqual(f.tones, []);
  assert.deepEqual(f.sent, []);
  assert.equal(f.browserStops, 1);
});
