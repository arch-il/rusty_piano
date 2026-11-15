import { test } from "node:test";
import assert from "node:assert/strict";
import { NEXT_AFTER_MS, TAIL_MS, createEarController } from "../src/ear-controller.ts";
import type { EarController } from "../src/ear-controller.ts";
import { LEVELS, promptLengthMs } from "../src/ear-levels.ts";
import type { EarLevelDef, PromptNote } from "../src/ear-levels.ts";
import type { PlayResult } from "../src/ear-player.ts";
import type { LiveEvent } from "../src/engine-socket.ts";

const on = (note: number): LiveEvent => ({ type: "note_on", t: 0, note, velocity: 80, source: "engine" });
const off = (note: number): LiveEvent => ({ type: "note_off", t: 0, note, source: "engine" });

const level3: EarLevelDef = { ...LEVELS[0], items: 3 };

interface Play {
  notes: PromptNote[];
  resolve(r: PlayResult): void;
}

function setup(opts: { autoNext?: boolean; post?: () => Promise<unknown> } = {}) {
  let clock = 1000;
  const plays: Play[] = [];
  const timers: { id: number; at: number; fn: () => void }[] = [];
  let nextId = 1;
  const saved: [boolean, string | null][] = [];
  const posted: any[] = [];
  let stops = 0;
  const ctrl: EarController = createEarController({
    now: () => clock,
    wallIso: () => "2026-01-01T00:00:00.000Z",
    player: {
      play(notes) {
        return new Promise<PlayResult>((resolve) => plays.push({ notes, resolve }));
      },
      stop() {
        stops++;
      },
    },
    setTimer(fn, ms) {
      const id = nextId++;
      timers.push({ id, at: clock + ms, fn });
      return id;
    },
    clearTimer(id) {
      const i = timers.findIndex((t) => t.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
    postAttempt: async (a) => {
      posted.push(a);
      if (opts.post) return opts.post();
    },
    onChange() {},
    onSaved(ok, message) {
      saved.push([ok, message]);
    },
  });
  const flush = () => new Promise<void>((r) => setImmediate(r));
  const advance = (ms: number) => {
    const end = clock + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const t = timers[0];
      if (!t || t.at > end) break;
      timers.shift();
      clock = Math.max(clock, t.at);
      t.fn();
    }
    clock = end;
  };
  let played = 0;
  // resolve the next unresolved play and let its length plus the tail pass
  const finishPlay = async (source: PlayResult["source"] = "engine", note: string | null = null) => {
    const p = plays[played++];
    p.resolve({ source, note });
    await flush();
    advance(promptLengthMs(p.notes) + TAIL_MS);
  };
  const start = (autoNext?: boolean) =>
    ctrl.start({
      level: level3,
      settings: level3.defaults,
      drillId: "ear.echo-1",
      seed: 7,
      planId: null,
      tags: [],
      autoNext: autoNext ?? opts.autoNext,
    });
  const answer = (i: number) => {
    const n = ctrl.items()[i].answerNotes[0];
    const a = ctrl.handle(on(n));
    ctrl.handle(off(n));
    return a;
  };
  const wrong = (i: number) => {
    const n = ctrl.items()[i].answerNotes[0] + 1;
    const a = ctrl.handle(on(n));
    ctrl.handle(off(n));
    return a;
  };
  return {
    ctrl,
    plays,
    saved,
    posted,
    flush,
    advance,
    finishPlay,
    start,
    answer,
    wrong,
    stops: () => stops,
    timers: () => timers.length,
  };
}

test("start plays item 0, then answering after length plus tail", async () => {
  const t = setup();
  t.start();
  assert.equal(t.plays.length, 1);
  assert.equal(t.ctrl.status().phase, "playing");
  assert.equal(t.ctrl.status().playing, true);
  t.plays[0].resolve({ source: "engine", note: "hi" });
  await t.flush();
  t.advance(promptLengthMs(t.plays[0].notes) + TAIL_MS - 1);
  assert.equal(t.ctrl.status().phase, "playing");
  t.advance(1);
  assert.equal(t.ctrl.status().phase, "answering");
  assert.equal(t.ctrl.status().playing, false);
  assert.equal(t.ctrl.status().soundNote, "hi");
});

test("keys during playing are not judged", async () => {
  const t = setup();
  t.start();
  assert.deepEqual(t.answer(0), []);
  await t.finishPlay();
  assert.equal(t.ctrl.status().records, 0);
  assert.equal(t.ctrl.status().phase, "answering");
});

test("first-try right plays the next prompt after NEXT_AFTER_MS", async () => {
  const t = setup();
  t.start();
  await t.finishPlay();
  const eff = t.answer(0);
  assert.equal(eff.some((e) => e.kind === "correct" && e.firstTry), true);
  assert.equal(t.plays.length, 1);
  t.advance(NEXT_AFTER_MS - 1);
  assert.equal(t.plays.length, 1);
  t.advance(1);
  assert.equal(t.plays.length, 2);
  assert.deepEqual(t.plays[1].notes, t.ctrl.items()[1].prompt);
  assert.equal(t.ctrl.status().item, 1);
});

test("wrong then right plays the answer sound, then goes next", async () => {
  const t = setup();
  t.start();
  await t.finishPlay();
  assert.equal(t.wrong(0).some((e) => e.kind === "wrong"), true);
  t.answer(0);
  assert.equal(t.plays.length, 2);
  assert.deepEqual(t.plays[1].notes, t.ctrl.items()[0].answerSound);
  t.advance(NEXT_AFTER_MS * 2);
  assert.equal(t.plays.length, 2);
  await t.finishPlay();
  t.advance(NEXT_AFTER_MS);
  assert.equal(t.plays.length, 3);
  assert.deepEqual(t.plays[2].notes, t.ctrl.items()[1].prompt);
});

test("replay counts in answering and not in answered", async () => {
  const t = setup({ autoNext: false });
  t.start();
  t.ctrl.replay();
  assert.equal(t.plays.length, 1);
  await t.finishPlay();
  t.ctrl.replay();
  assert.equal(t.plays.length, 2);
  assert.equal(t.ctrl.status().replays, 1);
  await t.finishPlay();
  t.answer(0);
  assert.equal(t.ctrl.status().phase, "answered");
  t.ctrl.replay();
  assert.equal(t.plays.length, 3);
  assert.deepEqual(t.plays[2].notes, t.ctrl.items()[0].prompt);
  await t.finishPlay();
  assert.equal(t.ctrl.status().phase, "answered");
  const res = t.ctrl.finish("stop");
  assert.equal(res!.records[0].replays, 1);
});

test("manual reveal records revealed, plays answer sound, no auto-next, next continues", async () => {
  const t = setup();
  t.start();
  await t.finishPlay();
  t.ctrl.reveal();
  assert.equal(t.ctrl.status().revealShown, true);
  assert.equal(t.ctrl.status().phase, "answered");
  assert.equal(t.ctrl.status().revealed, true);
  assert.deepEqual(t.plays[1].notes, t.ctrl.items()[0].answerSound);
  await t.finishPlay();
  t.advance(NEXT_AFTER_MS * 3);
  assert.equal(t.plays.length, 2);
  t.ctrl.next();
  assert.equal(t.plays.length, 3);
  assert.equal(t.ctrl.status().revealShown, false);
  assert.equal(t.ctrl.status().item, 1);
  await t.finishPlay();
  t.ctrl.finish("stop");
  assert.equal(t.posted[0].steps[0].revealed, true);
});

test("3 wrong notes auto reveal", async () => {
  const t = setup();
  t.start();
  await t.finishPlay();
  t.wrong(0);
  t.wrong(0);
  const eff = t.wrong(0);
  assert.equal(eff.some((e) => e.kind === "revealed" && e.auto), true);
  assert.equal(t.ctrl.status().revealShown, true);
  assert.deepEqual(t.plays[1].notes, t.ctrl.items()[0].answerSound);
  await t.finishPlay();
  t.advance(NEXT_AFTER_MS * 3);
  assert.equal(t.plays.length, 2);
});

test("autoNext false waits for next()", async () => {
  const t = setup({ autoNext: false });
  t.start();
  await t.finishPlay();
  t.answer(0);
  t.advance(NEXT_AFTER_MS * 3);
  assert.equal(t.plays.length, 1);
  t.ctrl.next();
  assert.equal(t.plays.length, 2);
});

test("last item right posts a done attempt with 3 items", async () => {
  const t = setup();
  t.start();
  for (let i = 0; i < 3; i++) {
    await t.finishPlay();
    t.answer(i);
    t.advance(NEXT_AFTER_MS);
  }
  await t.flush();
  assert.equal(t.ctrl.running(), false);
  assert.equal(t.posted.length, 1);
  assert.equal(t.posted[0].end, "done");
  assert.equal(t.posted[0].ear.items_total, 3);
  assert.equal(t.posted[0].ear.items_done, 3);
  assert.deepEqual(t.saved, [[true, null]]);
  assert.equal(t.posted[0].ear.sound, "engine");
});

test("finish stop with no records posts nothing", async () => {
  const t = setup();
  t.start();
  assert.equal(t.ctrl.finish("stop"), null);
  await t.flush();
  assert.equal(t.posted.length, 0);
  assert.equal(t.saved.length, 0);
  assert.equal(t.stops(), 1);
  assert.equal(t.ctrl.running(), false);
});

test("post rejection reports onSaved false", async () => {
  const t = setup({ post: () => Promise.reject(new Error("boom")) });
  t.start();
  await t.finishPlay();
  t.answer(0);
  const res = t.ctrl.finish("stop");
  assert.equal(res!.itemsDone, 1);
  assert.equal(res!.itemsTotal, 3);
  await t.flush();
  assert.deepEqual(t.saved, [[false, "boom"]]);
});

test("sound browser, and mixed when sources differ", async () => {
  const a = setup({ autoNext: false });
  a.start();
  await a.finishPlay("browser");
  a.answer(0);
  assert.equal(a.ctrl.finish("stop")!.attempt.ear.sound, "browser");

  const b = setup({ autoNext: false });
  b.start();
  await b.finishPlay("engine");
  b.answer(0);
  b.ctrl.next();
  await b.finishPlay("browser");
  assert.equal(b.ctrl.status().sound, "mixed");
  assert.equal(b.ctrl.finish("stop")!.attempt.ear.sound, "mixed");
});

test("stale play result after finish changes nothing", async () => {
  const t = setup();
  t.start();
  await t.finishPlay();
  t.answer(0);
  t.ctrl.finish("stop");
  t.plays[0].resolve({ source: "browser", note: "late" });
  t.plays[0].resolve({ source: "browser", note: "late" });
  await t.flush();
  assert.equal(t.ctrl.status().soundNote, null);
  assert.equal(t.timers(), 0);
});

test("stale play result after a newer play is ignored", async () => {
  const t = setup({ autoNext: false });
  t.start();
  await t.finishPlay();
  t.ctrl.replay();
  t.ctrl.reveal();
  assert.equal(t.plays.length, 3);
  t.plays[1].resolve({ source: "browser", note: "old" });
  await t.flush();
  assert.equal(t.ctrl.status().soundNote, null);
  assert.equal(t.ctrl.status().sound, "engine");
});
