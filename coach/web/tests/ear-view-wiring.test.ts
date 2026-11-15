import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { earButtonStates, keyClasses, repeatParams, initialDrillId, linkPartial, defaultsParams } from "../src/ear-view.ts";
import { parseRoute, earHash } from "../src/drill-link.ts";
import type { EarParams } from "../src/drill-link.ts";
import { settingsFromControls } from "../src/ear-settings-view.ts";
import { LEVELS, levelById, normalizeSettings, sameSettings } from "../src/ear-levels.ts";
import type { EarLevelDef } from "../src/ear-levels.ts";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const html = read("../index.html");
const view = read("../src/ear-view.ts");
const settingsView = read("../src/ear-settings-view.ts");
const historyView = read("../src/ear-history-view.ts");
const css = read("../src/styles.css");

function level(id: string): EarLevelDef {
  const l = levelById(id);
  assert.ok(l, `missing level ${id}`);
  return l;
}

test("index.html has the ear ids", () => {
  for (const id of [
    "ear-link", "ear-view", "ear-back", "ear-status", "ear-levels", "ear-settings", "ear-settings-body",
    "ear-sound", "ear-prompt", "ear-answer", "ear-stats", "ear-keys", "ear-start", "ear-replay",
    "ear-reveal", "ear-next", "ear-stop", "ear-summary", "ear-history",
  ]) {
    assert.ok(html.includes(`id="${id}"`), `missing #${id}`);
  }
  assert.ok(/id="ear-link"[^>]*href="#\/ear"/.test(html));
});

test("ear-view.ts uses plain DOM, the controller and the player", () => {
  assert.ok(!view.includes("innerHTML"));
  assert.ok(!settingsView.includes("innerHTML"));
  for (const s of [
    "createEarController(", "createEarPlayer(", "createSound(", "keyLayout(", "normalizeSettings(",
    "instructionText(", "renderEarHistory(", "earHash(", "resetEngine(",
  ]) {
    assert.ok(view.includes(s), `missing ${s}`);
  }
});

test("every class set in the ear view files has a CSS rule", () => {
  const names = [
    ...[view, settingsView].flatMap((src) => [
      ...[...src.matchAll(/className = ["']([^"']+)["']/g)].map((m) => m[1]),
      ...[...src.matchAll(/classList\.(?:add|toggle)\(["']([^"']+)["']/g)].map((m) => m[1]),
      ...[...src.matchAll(/\? "([a-z-]+ (?:black|white))" : "([a-z-]+ (?:black|white))"/g)].flatMap((m) => [m[1], m[2]]),
      ...[...src.matchAll(/\? '([a-z-]+ (?:black|white))' : '([a-z-]+ (?:black|white))'/g)].flatMap((m) => [m[1], m[2]]),
    ]),
    ...[...historyView.matchAll(/'(ear-[a-z-]+)'/g)].map((m) => m[1]),
  ];
  assert.ok(names.length > 0);
  for (const n of [...names, "given", "answer", "wrong", "pressed", "white", "black", "locked"].flatMap((x) => x.split(" "))) {
    assert.ok(css.includes(`.${n}`), `missing .${n}`);
  }
  assert.ok(css.includes(".ear-view[hidden]"));
  assert.ok(css.includes(".ear-summary[hidden]"));
  assert.ok(css.includes(".ear-answer[hidden]"));
});

test("earButtonStates follows the phase", () => {
  const idle = earButtonStates({ phase: "finished", revealShown: false, replays: 0 });
  assert.deepEqual(idle, { start: true, replay: false, replayLabel: "Replay", reveal: false, next: false, stop: false });
  const playing = earButtonStates({ phase: "playing", revealShown: false, replays: 0 });
  assert.equal(playing.start, false);
  assert.equal(playing.replay, false);
  assert.equal(playing.reveal, true);
  assert.equal(playing.stop, true);
  const answering = earButtonStates({ phase: "answering", revealShown: false, replays: 2 });
  assert.equal(answering.replay, true);
  assert.equal(answering.replayLabel, "Replay (2)");
  assert.equal(answering.next, false);
  const answered = earButtonStates({ phase: "answered", revealShown: true, replays: 1 });
  assert.equal(answered.replay, true);
  assert.equal(answered.reveal, false);
  assert.equal(answered.next, true);
  assert.equal(answered.stop, true);
});

test("keyClasses lists the lit states of a key", () => {
  const state = {
    given: [60],
    pressed: new Set([60, 62]),
    wrong: new Set([62]),
    answer: [64, 60],
  };
  assert.deepEqual(keyClasses(60, state), ["given", "answer", "pressed"]);
  assert.deepEqual(keyClasses(62, state), ["wrong", "pressed"]);
  assert.deepEqual(keyClasses(64, state), ["answer"]);
  assert.deepEqual(keyClasses(65, state), []);
});

test("settingsFromControls normalizes the control values", () => {
  const echo = level("echo-1");
  const s = settingsFromControls(echo, { low: 62, high: 72, key: "any", echoSet: "chromatic", bpm: 500 });
  assert.equal(s.low, 62);
  assert.equal(s.high, 72);
  assert.equal(s.key, null);
  assert.deepEqual(s.set, ["chromatic"]);
  assert.equal(s.bpm, 200);

  const keyed = settingsFromControls(echo, { low: 60, high: 67, key: "7", echoSet: "scale", bpm: Number.NaN });
  assert.equal(keyed.key, 7);
  assert.equal(keyed.bpm, echo.defaults.bpm);

  const interval = level("interval-1");
  const picked = settingsFromControls(interval, { low: 60, high: 72, key: "0", sets: ["P5", "bogus", "M3"], bpm: 80 });
  assert.deepEqual(picked.set, ["P5", "M3"]);
  const none = settingsFromControls(interval, { low: 60, high: 72, key: "0", sets: [], bpm: 80 });
  assert.deepEqual(none.set, interval.defaults.set);

  const phrase = level("echo-4");
  const len = settingsFromControls(phrase, { low: 60, high: 67, key: "0", echoSet: "scale", bpm: 90, lenMin: 5, lenMax: 3 });
  assert.equal(len.lenMin, 5);
  assert.equal(len.lenMax, 5);
  assert.deepEqual(settingsFromControls(phrase, { key: "0", bpm: 90 }).lenMax, phrase.defaults.lenMax);

  assert.deepEqual(settingsFromControls(echo, { key: "0", bpm: 80 }), normalizeSettings(echo, { key: 0, bpm: 80 }));
});

test("repeat of a custom round carries free and no drill", () => {
  const l = level("interval-1");
  const run = { level: l, settings: normalizeSettings(l, { bpm: 60 }), drillId: null, seed: 7 };
  const p = repeatParams(run, { level: l.id });
  assert.equal(p.free, true);
  assert.equal(p.drill, undefined);
  assert.equal(initialDrillId(parseRoute(earHash(p)).route.kind === "ear" ? (parseRoute(earHash(p)).route as { params: EarParams }).params : p, l), null);
  const counted = repeatParams({ ...run, drillId: l.drill }, { level: l.id });
  assert.equal(counted.free, undefined);
  assert.equal(counted.drill, l.drill);
});

test("for every level a repeat link reproduces the round settings", () => {
  for (const l of LEVELS) {
    for (const extra of [{}, { direction: "down", harmonic: "harmonic" } as const]) {
      const settings = normalizeSettings(l, { ...extra, bpm: 70 });
      const p = repeatParams({ level: l, settings, drillId: l.drill, seed: 3 }, { level: l.id });
      const r = parseRoute(earHash(p));
      assert.deepEqual(r.warnings, [], l.id);
      assert.equal(r.route.kind, "ear");
      const back = normalizeSettings(l, linkPartial((r.route as { params: EarParams }).params));
      assert.ok(sameSettings(back, settings), l.id);
    }
  }
});

test("Level defaults on a free link restores the level defaults and the counted drill", () => {
  for (const id of ["echo-1", "interval-1", "echo-4"]) {
    const l = level(id);
    const free: EarParams = {
      level: id, free: true, plan: "p", tags: ["t"], low: 62, high: 70, key: 7, set: ["P5"],
      direction: "down", harmonic: "harmonic", bpm: 55, len: { min: 2, max: 3 }, seed: 9, drill: "x",
    } as EarParams;
    const d = defaultsParams(free);
    assert.equal(d.level, id);
    assert.equal(d.plan, "p");
    assert.deepEqual(d.tags, ["t"]);
    assert.deepEqual(Object.keys(d).sort(), ["level", "plan", "tags"]);
    assert.ok(sameSettings(normalizeSettings(l, linkPartial(d)), l.defaults), id);
    assert.equal(initialDrillId(d, l), l.drill);
  }
});

test("Level defaults on a non-free link keeps the link settings and drill", () => {
  const l = level("echo-1");
  const p: EarParams = { level: l.id, drill: "my-drill", low: 62, high: 70, bpm: 55 };
  const d = defaultsParams(p);
  assert.deepEqual(d, p);
  assert.equal(initialDrillId(d, l), "my-drill");
  assert.equal(normalizeSettings(l, linkPartial(d)).bpm, 55);
});

test("onDefaults uses defaultsParams", () => {
  assert.ok(/onDefaults:[\s\S]*?defaultsParams\(params\)/.test(view));
});
