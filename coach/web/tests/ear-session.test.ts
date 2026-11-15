import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildEarAttempt, createEarSession } from "../src/ear-session.ts";
import type { EarAttemptInput } from "../src/ear-session.ts";
import { levelById, normalizeSettings } from "../src/ear-levels.ts";
import type { AnswerStep, EarItem, EarLevelDef } from "../src/ear-levels.ts";
import type { LiveEvent } from "../src/engine-socket.ts";

const on = (note: number, t = 0): LiveEvent => ({ type: "note_on", t, note, velocity: 80, source: "engine" });
const off = (note: number, t = 0): LiveEvent => ({ type: "note_off", t, note, source: "engine" });

function single(index: number, p: number, name: string): EarItem {
  const prompt = [{ note: p, startMs: 0, durMs: 675, velocity: 80 }];
  return {
    index,
    type: "echo",
    category: name,
    label: name,
    prompt,
    answerSound: prompt,
    given: [],
    answer: [{ kind: "note", pitch: p }],
    answerNotes: [p],
  };
}

function items(): EarItem[] {
  return [single(0, 60, "C4"), single(1, 64, "E4"), single(2, 67, "G4")];
}

test("starts playing; asked moves to answering and keeps the first time", () => {
  const s = createEarSession(items(), {});
  assert.equal(s.phase(), "playing");
  assert.equal(s.item(), 0);
  assert.equal(s.asked(100), "answering");
  s.replayed();
  assert.equal(s.phase(), "playing");
  s.asked(900);
  s.handle(on(60), 1100);
  assert.equal(s.records()[0].response_ms, 1000);
  assert.equal(s.records()[0].replays, 1);
});

test("keys in playing are logged but not judged", () => {
  const s = createEarSession(items(), {});
  assert.deepEqual(s.handle(on(60), 50), []);
  assert.equal(s.events().length, 1);
  assert.equal(s.phase(), "playing");
  assert.equal(s.records().length, 0);
});

test("first-try correct answer", () => {
  const s = createEarSession(items(), {});
  s.asked(1000);
  const fx = s.handle(on(60), 2500);
  assert.deepEqual(fx, [
    { kind: "accepted", note: 60, step: 0 },
    { kind: "correct", item: 0, firstTry: true },
  ]);
  assert.equal(s.phase(), "answered");
  const r = s.records()[0];
  assert.equal(r.result, "hit");
  assert.equal(r.first_try, true);
  assert.equal(r.response_ms, 1500);
  assert.deepEqual(r.prompt_notes, [60]);
  assert.equal(s.status().lastResult, "right");
});

test("wrong then right is not first try", () => {
  const s = createEarSession(items(), {});
  s.asked(0);
  assert.deepEqual(s.handle(on(62), 500), [{ kind: "wrong", note: 62, wrongCount: 1 }]);
  assert.equal(s.status().wrongOnItem, 1);
  const fx = s.handle(on(60), 900);
  assert.deepEqual(fx[1], { kind: "correct", item: 0, firstTry: false });
  const r = s.records()[0];
  assert.equal(r.result, "wrong");
  assert.equal(r.first_try, false);
  assert.deepEqual(r.wrong_notes, [62]);
  assert.equal(s.status().lastResult, "wrong");
});

test("three wrong keys reveal the item automatically", () => {
  const s = createEarSession(items(), {});
  s.asked(0);
  s.handle(on(61), 10);
  s.handle(on(62), 20);
  const fx = s.handle(on(63), 30);
  assert.deepEqual(fx, [
    { kind: "wrong", note: 63, wrongCount: 3 },
    { kind: "revealed", item: 0, auto: true },
  ]);
  assert.equal(s.phase(), "answered");
  const r = s.records()[0];
  assert.equal(r.revealed, true);
  assert.equal(r.response_ms, null);
  assert.equal(r.result, "wrong");
  assert.deepEqual(s.handle(on(60), 40), []);
  assert.equal(s.records().length, 1);
});

test("revealAfter option is respected", () => {
  const s = createEarSession(items(), { revealAfter: 1 });
  s.asked(0);
  assert.equal(s.handle(on(61), 10).at(-1)?.kind, "revealed");
});

test("manual reveal, also before asked", () => {
  const s = createEarSession(items(), {});
  assert.deepEqual(s.reveal(700), [{ kind: "revealed", item: 0, auto: false }]);
  const r = s.records()[0];
  assert.equal(r.asked_page_ms, 700);
  assert.equal(r.done_page_ms, 700);
  assert.equal(r.response_ms, null);
  assert.equal(s.status().revealed, true);
  assert.deepEqual(s.reveal(800), []);
  s.replayed();
  assert.equal(s.phase(), "answered");
});

test("next moves on after an answer; last item returns false", () => {
  const s = createEarSession(items(), {});
  assert.equal(s.next(), false);
  for (let k = 0; k < 3; k++) {
    s.asked(k * 100);
    s.handle(on([60, 64, 67][k]), k * 100 + 50);
    assert.equal(s.phase(), "answered");
    assert.equal(s.next(), k < 2);
  }
  assert.equal(s.item(), 2);
  assert.equal(s.records().length, 3);
  const st = s.status();
  assert.equal(st.firstTry, 3);
  assert.equal(st.medianStepMs, 50);
});

test("per-item counters reset on next", () => {
  const s = createEarSession(items(), {});
  s.asked(0);
  s.replayed();
  s.asked(10);
  s.handle(on(61), 20);
  s.handle(on(60), 30);
  s.next();
  const st = s.status();
  assert.equal(st.item, 1);
  assert.equal(st.phase, "playing");
  assert.equal(st.replays, 0);
  assert.equal(st.wrongOnItem, 0);
  assert.equal(st.revealed, false);
});

test("stop finishes the session and later events are not logged", () => {
  const s = createEarSession(items(), {});
  s.asked(0);
  s.handle(on(61), 10);
  s.stop();
  assert.equal(s.phase(), "finished");
  assert.deepEqual(s.handle(on(60), 20), []);
  assert.equal(s.events().length, 1);
  assert.equal(s.records().length, 0);
});

test("chord items go through the matcher into effects", () => {
  const answer: AnswerStep[] = [{ kind: "chord", pcs: [0, 4, 7] }];
  const item: EarItem = { ...single(0, 60, "maj"), answer, answerNotes: [60, 64, 67] };
  const s = createEarSession([item], {});
  s.asked(0);
  assert.deepEqual(s.handle(on(64), 10), [{ kind: "accepted", note: 64, step: 0 }]);
  assert.deepEqual(s.handle(on(61), 20), [{ kind: "wrong", note: 61, wrongCount: 1 }]);
  s.handle(on(79), 30);
  const fx = s.handle(on(48), 40);
  assert.deepEqual(fx[1], { kind: "correct", item: 0, firstTry: false });
  assert.equal(s.records()[0].answer_steps, 1);
});

test("records and events are copies", () => {
  const s = createEarSession(items(), {});
  s.asked(0);
  s.handle(on(60), 10);
  s.records()[0].prompt_notes.push(1);
  s.events()[0].page_ms = 99;
  assert.deepEqual(s.records()[0].prompt_notes, [60]);
  assert.equal(s.events()[0].page_ms, 10);
});

test("a key released during a replay is no longer held by the chord matcher", () => {
  const answer: AnswerStep[] = [{ kind: "chord", pcs: [0, 4, 7] }];
  const item: EarItem = { ...single(0, 60, "maj"), answer, answerNotes: [60, 64, 67] };
  const s = createEarSession([item], {});
  s.asked(0);
  assert.deepEqual(s.handle(on(60), 10), [{ kind: "accepted", note: 60, step: 0 }]);
  s.replayed();
  assert.deepEqual(s.handle(off(60), 20), []);
  s.asked(30);
  assert.deepEqual(s.handle(on(64), 40), [{ kind: "accepted", note: 64, step: 0 }]);
  assert.deepEqual(s.handle(on(67), 50), [{ kind: "accepted", note: 67, step: 0 }]);
  const fx = s.handle(on(60), 60);
  assert.deepEqual(fx[fx.length - 1], { kind: "correct", item: 0, firstTry: true });
});

function fixtureInput(level: EarLevelDef): EarAttemptInput {
  const s = createEarSession(items(), { revealAfter: 3 });
  const E = (n: number, ms: number, type: "on" | "off") => (type === "on" ? on(n, ms + 1000) : off(n, ms + 1000));
  s.asked(2000);
  s.handle(E(60, 4400, "on"), 4400);
  s.handle(E(60, 4600, "off"), 4600);
  s.next();
  s.asked(6000);
  s.replayed();
  s.asked(7000);
  s.handle(E(64, 8600, "on"), 8600);
  s.handle(E(64, 8800, "off"), 8800);
  s.next();
  s.asked(10000);
  s.handle(E(67, 12200, "on"), 12200);
  s.handle(E(67, 12400, "off"), 12400);
  return {
    level,
    settings: normalizeSettings(level, {}),
    drillId: "ear.echo-1",
    seed: 7,
    revealAfter: 3,
    records: s.records(),
    events: s.events(),
    end: "done",
    startedWall: "2026-11-08T10:00:00.000Z",
    endedWall: "2026-11-08T10:00:30.000Z",
    pageStartMs: 1000,
    pageEndMs: 31000,
    itemsTotal: 3,
    sound: "engine",
    planId: null,
    tags: [],
  };
}

const echo1 = levelById("echo-1") as EarLevelDef;

test("the fixture scenario through the session and the builder matches the fixture file", () => {
  const attempt = buildEarAttempt(fixtureInput(echo1));
  const fixture = JSON.parse(
    readFileSync(fileURLToPath(new URL("./fixtures/ear-attempt.json", import.meta.url)), "utf8"),
  );
  assert.deepEqual(attempt, fixture);
  assert.deepEqual(
    attempt.steps.map((r) => r.response_ms),
    [2400, 2600, 2200],
  );
  assert.deepEqual(
    attempt.steps.map((r) => r.replays),
    [0, 1, 0],
  );
  assert.equal(attempt.ear.median_step_ms, 2400);
});

test("attempt follows the attempts.py rules", () => {
  const a = buildEarAttempt({ ...fixtureInput(echo1), end: "stop" });
  assert.equal(a.version, 2);
  assert.equal(a.kind, "rusty_piano.attempt");
  assert.equal(a.mode, "wait");
  assert.equal(a.end, "stop");
  assert.equal(a.score.id, "ear:echo-1");
  assert.ok(!Number.isNaN(Date.parse(a.started_at)));
  assert.ok(Array.isArray(a.steps));
  assert.deepEqual(a.sources, ["engine"]);
  assert.deepEqual([...new Set(a.events.map((e) => e.type))].sort(), ["note_off", "note_on"]);
  assert.equal(typeof a.summary, "object");
  assert.equal(a.clock.first_engine_t, 5400);
  for (const r of a.steps) {
    assert.ok(!("bar" in r) && !("expected" in r) && !("wrong" in r));
  }
});

test("drill is null when drillId is null; tags dedup and cap at 10", () => {
  const base = fixtureInput(echo1);
  const a = buildEarAttempt({ ...base, drillId: null, tags: ["ear-training", "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"] });
  assert.equal(a.drill_id, null);
  assert.equal(a.settings.ear.counted, false);
  assert.equal(a.tags.length, 10);
  assert.equal(a.tags.filter((t) => t === "ear-training").length, 1);
});

test("an empty round has no accuracy", () => {
  const a = buildEarAttempt({ ...fixtureInput(echo1), records: [], events: [] });
  assert.equal(a.summary.ear.accuracy, null);
  assert.equal(a.summary.metrics.accuracy, "-");
  assert.equal(a.clock.first_engine_t, null);
});
