import { test } from "node:test";
import assert from "node:assert/strict";
import { createSightController } from "../src/sight-controller.ts";
import type { SightStartOptions } from "../src/sight-controller.ts";
import { levelById } from "../src/sight-levels.ts";
import type { Card, LevelDef } from "../src/sight-levels.ts";
import type { XmlMarks } from "../src/sight-xml.ts";
import type { LiveEvent } from "../src/engine-socket.ts";

const R2: LevelDef = (() => {
  const level = levelById("r2-treble");
  if (!level) throw new Error("missing r2-treble");
  return level;
})();

interface Pending {
  card: Card;
  marks: XmlMarks;
  settled: boolean;
  resolve(): void;
  reject(e: Error): void;
}

interface PostedAttempt {
  score: { id: string };
  drill_id: string;
  tags: string[];
  plan_id: string | null;
  end: string;
}

function harness() {
  const h = {
    clock: 1000,
    postFail: null as string | null,
    renders: [] as Pending[],
    posts: [] as PostedAttempt[],
    saved: [] as Array<[boolean, string | null]>,
    errors: [] as string[],
  };
  const deps = {
    now: () => h.clock,
    wallIso: () => "2026-11-06T20:00:00.000Z",
    render: (card: Card, marks: XmlMarks) => {
      const entry = { card, marks, settled: false, resolve: () => {}, reject: (_e: Error) => {} };
      const p = new Promise<void>((res, rej) => {
        entry.resolve = () => {
          entry.settled = true;
          res();
        };
        entry.reject = (e: Error) => {
          entry.settled = true;
          rej(e);
        };
      });
      h.renders.push(entry);
      return p;
    },
    postAttempt: (a: unknown) => {
      h.posts.push(a as PostedAttempt);
      return h.postFail === null ? Promise.resolve(null) : Promise.reject(new Error(h.postFail));
    },
    onChange: () => {},
    onRenderError: (m: string) => {
      h.errors.push(m);
    },
    onSaved: (ok: boolean, message: string | null) => {
      h.saved.push([ok, message]);
    },
  };
  return { h, deps };
}

function opts(seed: number, extra: Partial<SightStartOptions> = {}): SightStartOptions {
  return { level: R2, custom: null, seed, planId: null, tags: [], ...extra };
}

function on(note: number, t: number): LiveEvent {
  return { type: "note_on", t, note, velocity: 80, source: "engine" };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

async function settle(h: { renders: Pending[] }): Promise<void> {
  for (;;) {
    const next = h.renders.find((r) => !r.settled);
    if (!next) return;
    next.resolve();
    await flush();
  }
}

function playCard(h: { clock: number }, c: ReturnType<typeof createSightController>, card: Card): number {
  for (const step of card.steps) {
    for (const note of step.pitches) {
      h.clock += 100;
      c.handle(on(note, h.clock));
    }
  }
  return h.clock;
}

function countNote(cards: readonly Card[], midi: number): number {
  let n = 0;
  for (const card of cards) for (const step of card.steps) for (const p of step.pitches) if (p === midi) n++;
  return n;
}

test("reaction is timed from when the card render settles, not from start", async () => {
  const { h, deps } = harness();
  const c = createSightController(deps);
  c.start(opts(3));
  h.clock = 1500;
  await settle(h);
  const card0 = c.cards()[0];
  const end = playCard(h, c, card0);
  const rec = c.records()[0];
  assert.equal(rec.shown_page_ms, 1500);
  assert.equal(rec.done_page_ms, end);
  assert.equal(rec.reaction_ms, end - 1500);
});

test("notes played while the first render is pending are ignored but recorded in the attempt events", async () => {
  const { h, deps } = harness();
  const c = createSightController(deps);
  c.start(opts(3));
  const note = c.cards()[0].steps[0].pitches[0];
  h.clock = 1100;
  assert.deepEqual(c.handle(on(note, 1100)), []);
  assert.deepEqual(c.records(), []);
  h.clock = 1300;
  await settle(h);
  playCard(h, c, c.cards()[0]);
  const result = c.finish("interrupted");
  assert.ok(result);
  assert.deepEqual(result.attempt.events[0], {
    type: "note_on",
    t: 1100,
    page_ms: 1100,
    source: "engine",
    note,
    velocity: 80,
  });
});

test("coalescing: quick wrong notes during an in-flight render give one more render with the latest mark", async () => {
  const { h, deps } = harness();
  const c = createSightController(deps);
  c.start(opts(3));
  await settle(h);
  const target = c.cards()[0].steps[0].pitches[0];
  const [w1, w2, w3] = [target + 1, target + 2, target + 3];
  h.clock = 1100;
  c.handle(on(w1, 1100));
  h.clock = 1200;
  c.handle(on(w2, 1200));
  h.clock = 1300;
  c.handle(on(w3, 1300));
  assert.equal(h.renders.length, 2);
  h.renders[1].resolve();
  await flush();
  assert.equal(h.renders.length, 3);
  assert.equal(h.renders[2].marks.wrong?.note, w3);
  await settle(h);
  assert.equal(h.renders.length, 3);
});

test("a rejected render calls onRenderError and still starts timing", async () => {
  const { h, deps } = harness();
  const c = createSightController(deps);
  c.start(opts(3));
  h.clock = 1400;
  h.renders[0].reject(new Error("osmd failed"));
  await flush();
  assert.deepEqual(h.errors, ["osmd failed"]);
  h.clock = 1700;
  const end = playCard(h, c, c.cards()[0]);
  const rec = c.records()[0];
  assert.equal(rec.shown_page_ms, 1400);
  assert.equal(rec.done_page_ms, end);
  assert.equal(rec.reaction_ms, end - 1400);
});

test("full r2-treble round posts exactly one attempt with the level ids, tags and plan", async () => {
  const { h, deps } = harness();
  const c = createSightController(deps);
  c.start(opts(7, { planId: "plan-1", tags: ["morning"] }));
  let guard = 0;
  while (c.running()) {
    if (++guard > 100) throw new Error("round did not finish");
    await settle(h);
    playCard(h, c, c.cards()[c.status().card]);
  }
  assert.equal(h.posts.length, 1);
  const [post] = h.posts;
  assert.equal(post.score.id, "sight:r2-treble");
  assert.equal(post.drill_id, "sr.r2-treble");
  assert.equal(post.plan_id, "plan-1");
  assert.equal(post.end, "done");
  assert.ok(post.tags.includes("morning"));
  assert.ok(post.tags.includes("sight-reading"));
  await flush();
  assert.deepEqual(h.saved, [[true, null]]);
  assert.deepEqual(c.handle(on(60, h.clock + 100)), []);
  assert.equal(h.posts.length, 1);
});

test("stop with no records returns null and posts nothing", async () => {
  const { h, deps } = harness();
  const c = createSightController(deps);
  c.start(opts(3));
  await settle(h);
  assert.equal(c.finish("stop"), null);
  assert.equal(c.finish("stop"), null);
  assert.equal(h.posts.length, 0);
});

test("interrupted after one card posts with end interrupted", async () => {
  const { h, deps } = harness();
  const c = createSightController(deps);
  c.start(opts(3));
  await settle(h);
  playCard(h, c, c.cards()[0]);
  const result = c.finish("interrupted");
  assert.ok(result);
  assert.equal(result.end, "interrupted");
  assert.equal(result.cardsDone, 1);
  assert.equal(h.posts.length, 1);
  assert.equal(h.posts[0].end, "interrupted");
});

test("a postAttempt rejection calls onSaved(false, message)", async () => {
  const { h, deps } = harness();
  const c = createSightController(deps);
  c.start(opts(3));
  await settle(h);
  playCard(h, c, c.cards()[0]);
  h.postFail = "offline";
  c.finish("interrupted");
  await flush();
  assert.deepEqual(h.saved, [[false, "offline"]]);
});

test("the same seed with and without weights gives different r2-treble cards", () => {
  const plain = harness();
  const weighted = harness();
  const a = createSightController(plain.deps);
  const b = createSightController(weighted.deps);
  a.start(opts(11));
  b.start(opts(11, { weights: new Map([[60, 1000]]) }));
  assert.notEqual(JSON.stringify(a.cards()), JSON.stringify(b.cards()));
  assert.ok(countNote(b.cards(), 60) > countNote(a.cards(), 60));
});
