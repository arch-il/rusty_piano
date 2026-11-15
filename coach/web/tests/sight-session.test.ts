import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildSightAttempt, createSightSession } from "../src/sight-session.ts";
import type { SightAttemptInput } from "../src/sight-session.ts";
import { DEFAULT_CUSTOM, levelById } from "../src/sight-levels.ts";
import type { Card, CardNote, CardStep, Pitch } from "../src/sight-levels.ts";
import type { LiveEvent } from "../src/engine-socket.ts";

const NATURALS: Record<number, Pitch["step"]> = { 0: "C", 2: "D", 4: "E", 5: "F", 7: "G", 9: "A", 11: "B" };

function cardNote(midi: number): CardNote {
  return {
    midi,
    staff: 1,
    pitch: { step: NATURALS[midi % 12], alter: 0, octave: Math.floor(midi / 12) - 1 },
    quarters: 4,
  };
}

function cardStep(pitches: number[]): CardStep {
  return { time: 0, pitches, notes: pitches.map(cardNote) };
}

function card(index: number, steps: number[][]): Card {
  return { index, clef: "treble", fifths: 0, showTime: false, measures: 1, steps: steps.map(cardStep) };
}

function on(note: number, t: number): LiveEvent {
  return { type: "note_on", t, note, velocity: 80, source: "engine" };
}

function off(note: number, t: number): LiveEvent {
  return { type: "note_off", t, note, source: "engine" };
}

function playFixture() {
  const s = createSightSession([card(0, [[60]]), card(1, [[64]]), card(2, [[67]])], { perCard: true, hintAfter: 2 });
  s.shown(1000);
  s.handle(on(60, 900), 1900);
  s.handle(off(60, 950), 1950);
  s.shown(2000);
  s.handle(on(64, 2100), 3100);
  s.handle(off(64, 2150), 3150);
  s.shown(3200);
  s.handle(on(67, 3700), 4700);
  s.handle(off(67, 3750), 4750);
  return s;
}

function attemptInput(levelId: string, custom: SightAttemptInput["custom"]): SightAttemptInput {
  const level = levelById(levelId);
  if (!level) throw new Error(`missing level ${levelId}`);
  const s = playFixture();
  return {
    level,
    custom,
    seed: 42,
    hintAfter: 2,
    records: s.records(),
    events: s.events(),
    end: "done",
    startedWall: "2026-11-06T20:00:00.000Z",
    endedWall: "2026-11-06T20:00:03.800Z",
    pageStartMs: 1000,
    pageEndMs: 4800,
    cardsTotal: 3,
    stepsTotal: 3,
    planId: null,
    tags: [],
  };
}

test("notes cards: reaction from the card start, events before shown are recorded but ignored", () => {
  const s = createSightSession([card(0, [[60]]), card(1, [[64]])], { perCard: true });
  assert.deepEqual(s.handle(on(60, 500), 500), []);
  s.shown(1000);
  assert.deepEqual(s.handle(on(60, 900), 1900), [{ kind: "card", card: 1 }]);
  assert.equal(s.status().card, 1);
  assert.equal(s.status().waiting, true);
  assert.deepEqual(s.records(), [
    {
      step: 0,
      card: 0,
      notes: [60],
      result: "hit",
      first_try: true,
      wrong_count: 0,
      wrong_notes: [],
      hinted: false,
      reaction_ms: 900,
      shown_page_ms: 1000,
      done_page_ms: 1900,
    },
  ]);
  assert.equal(s.events().length, 2);
  assert.deepEqual(s.events()[0], { type: "note_on", t: 500, page_ms: 500, source: "engine", note: 60, velocity: 80 });
  s.shown(2000);
  assert.deepEqual(s.handle(on(64, 2100), 3100), [{ kind: "done" }]);
  assert.equal(s.status().finished, true);
  assert.equal(s.records()[1].reaction_ms, 1100);
});

test("wrong then right: the record is not first try and keeps the wrong note", () => {
  const s = createSightSession([card(0, [[60]])], { perCard: true });
  s.shown(0);
  assert.deepEqual(s.handle(on(62, 100), 100), [{ kind: "wrong", note: 62, attempts: 1 }]);
  assert.deepEqual(s.handle(on(60, 300), 300), [{ kind: "done" }]);
  assert.deepEqual(s.records(), [
    {
      step: 0,
      card: 0,
      notes: [60],
      result: "wrong",
      first_try: false,
      wrong_count: 1,
      wrong_notes: [62],
      hinted: false,
      reaction_ms: 300,
      shown_page_ms: 0,
      done_page_ms: 300,
    },
  ]);
});

test("two wrong notes raise a hint with the target pitches", () => {
  const s = createSightSession([card(0, [[60]])], { perCard: true });
  s.shown(0);
  s.handle(on(62, 100), 100);
  assert.deepEqual(s.handle(on(65, 200), 200), [
    { kind: "wrong", note: 65, attempts: 2 },
    { kind: "hint", notes: [60] },
  ]);
  assert.deepEqual(s.status().hintNotes, [60]);
  assert.equal(s.status().hinted, true);
  s.handle(on(60, 400), 400);
  const [rec] = s.records();
  assert.equal(rec.first_try, false);
  assert.equal(rec.hinted, true);
  assert.equal(rec.wrong_count, 2);
  assert.deepEqual(rec.wrong_notes, [62, 65]);
});

test("intervals card: step effect after the first note, reaction to the second, hint carried over", () => {
  const s = createSightSession([card(0, [[60], [64]])], { perCard: true });
  s.shown(1000);
  assert.deepEqual(s.handle(on(62, 1100), 1100), [{ kind: "wrong", note: 62, attempts: 1 }]);
  assert.deepEqual(s.handle(on(65, 1200), 1200), [
    { kind: "wrong", note: 65, attempts: 2 },
    { kind: "hint", notes: [60] },
  ]);
  assert.deepEqual(s.handle(on(60, 1400), 1400), [
    { kind: "step", card: 0, step: 1 },
    { kind: "hint", notes: [64] },
  ]);
  assert.deepEqual(s.status().hintNotes, [64]);
  assert.deepEqual(s.handle(on(64, 2300), 2300), [{ kind: "done" }]);
  assert.deepEqual(s.records(), [
    {
      step: 0,
      card: 0,
      notes: [60, 64],
      result: "wrong",
      first_try: false,
      wrong_count: 2,
      wrong_notes: [62, 65],
      hinted: true,
      reaction_ms: 1300,
      shown_page_ms: 1000,
      done_page_ms: 2300,
    },
  ]);
});

test("bars card: one record per step, reaction from the previous hit, chord needs both notes", () => {
  const s = createSightSession([card(0, [[60], [64, 67]])], { perCard: false });
  s.shown(1000);
  assert.deepEqual(s.handle(on(60, 1400), 1400), [{ kind: "step", card: 0, step: 1 }]);
  assert.deepEqual(s.handle(on(64, 1900), 1900), []);
  assert.deepEqual(s.handle(on(67, 2100), 2100), [{ kind: "done" }]);
  assert.deepEqual(s.records(), [
    {
      step: 0,
      card: 0,
      notes: [60],
      result: "hit",
      first_try: true,
      wrong_count: 0,
      wrong_notes: [],
      hinted: false,
      reaction_ms: 400,
      shown_page_ms: 1000,
      done_page_ms: 1400,
    },
    {
      step: 1,
      card: 0,
      notes: [64, 67],
      result: "hit",
      first_try: true,
      wrong_count: 0,
      wrong_notes: [],
      hinted: false,
      reaction_ms: 700,
      shown_page_ms: 1400,
      done_page_ms: 2100,
    },
  ]);
});

test("bars card: the hint is cleared by the hit and the next step starts clean", () => {
  const s = createSightSession([card(0, [[60], [64]])], { perCard: false });
  s.shown(0);
  s.handle(on(62, 100), 100);
  s.handle(on(65, 200), 200);
  assert.deepEqual(s.status().hintNotes, [60]);
  assert.deepEqual(s.handle(on(60, 300), 300), [
    { kind: "hint", notes: [] },
    { kind: "step", card: 0, step: 1 },
  ]);
  assert.deepEqual(s.status().hintNotes, []);
  assert.equal(s.status().hinted, false);
  assert.deepEqual(s.handle(on(64, 500), 500), [{ kind: "done" }]);
  const [first, second] = s.records();
  assert.equal(first.hinted, true);
  assert.equal(first.first_try, false);
  assert.equal(first.reaction_ms, 300);
  assert.equal(second.hinted, false);
  assert.equal(second.first_try, true);
  assert.equal(second.reaction_ms, 200);
  assert.equal(second.shown_page_ms, 300);
});

test("stop() drops the unfinished record and ignores later events", () => {
  const s = createSightSession([card(0, [[60]]), card(1, [[64]])], { perCard: true });
  s.shown(0);
  assert.deepEqual(s.handle(on(60, 100), 100), [{ kind: "card", card: 1 }]);
  s.shown(200);
  assert.deepEqual(s.handle(on(62, 300), 300), [{ kind: "wrong", note: 62, attempts: 1 }]);
  s.stop();
  assert.deepEqual(s.handle(on(64, 400), 400), []);
  assert.equal(s.status().finished, true);
  assert.equal(s.records().length, 1);
  assert.equal(s.events().length, 2);
});

test("the fixture scenario through the session and the builder matches the fixture file", () => {
  const attempt = buildSightAttempt(attemptInput("r2-treble", null));
  const fixture = JSON.parse(
    readFileSync(fileURLToPath(new URL("./fixtures/sight-attempt.json", import.meta.url)), "utf8"),
  );
  assert.deepEqual(attempt, fixture);
});

test("the attempt follows the rules attempts.py enforces", () => {
  const a = buildSightAttempt(attemptInput("r2-treble", null));
  assert.equal(a.version, 2);
  assert.equal(a.kind, "rusty_piano.attempt");
  assert.equal(typeof a.score.id, "string");
  assert.equal(a.mode, "wait");
  assert.ok(["done", "stop", "interrupted"].includes(a.end));
  assert.match(a.started_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  assert.ok(!Number.isNaN(Date.parse(a.started_at)));
  assert.ok(Array.isArray(a.steps));
  for (const ev of a.events) {
    assert.ok(["note_on", "note_off", "sustain"].includes(ev.type));
    assert.ok(["engine", "keyboard", "autoplay"].includes(ev.source));
  }
  assert.equal(typeof a.summary, "object");
  assert.equal(a.drill_id, "sr.r2-treble");
  assert.equal(a.plan_id, null);
  assert.equal(buildSightAttempt({ ...attemptInput("r2-treble", null), planId: "plan-1" }).plan_id, "plan-1");
  assert.deepEqual(a.tags, ["sight-reading"]);
  const many = buildSightAttempt({
    ...attemptInput("r2-treble", null),
    tags: ["warmup", "warmup", "a", "b", "c", "d", "e", "f", "g", "h", "i", "j"],
  });
  assert.deepEqual(many.tags, ["sight-reading", "warmup", "a", "b", "c", "d", "e", "f", "g", "h"]);
  assert.ok(many.tags.every((t) => /^[a-z0-9-]{1,20}$/.test(t)));
});

test("a custom level gives score id sight:custom and drill sr.custom", () => {
  const c = buildSightAttempt(attemptInput("custom", DEFAULT_CUSTOM));
  assert.equal(c.score.id, "sight:custom");
  assert.equal(c.drill_id, "sr.custom");
  assert.deepEqual(c.sight.custom, DEFAULT_CUSTOM);
});
