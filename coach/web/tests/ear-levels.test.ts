import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  EAR_TARGETS_MS,
  LEVELS,
  SETS,
  instructionText,
  keyName,
  levelById,
  normalizeSettings,
  promptLengthMs,
  sameSettings,
} from "../src/ear-levels.ts";
import type { EarLevelDef, EarType, PromptNote } from "../src/ear-levels.ts";
import { EASY_TUNES, TUNES, TUNE_IDS, tuneById } from "../src/ear-tunes.ts";

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/ear-levels.json", import.meta.url)), "utf8"),
);

function level(id: string): EarLevelDef {
  const found = levelById(id);
  assert.ok(found, `missing level ${id}`);
  return found;
}

test("LEVELS matches the fixture ladder field by field and in order", () => {
  const expected = fixture.levels.map((e: Record<string, unknown>) => ({
    id: e.level,
    type: e.type,
    node: e.node,
    drill: e.drill,
    kind: e.kind,
    items: e.items,
    given: e.given,
    title: e.title,
  }));
  const actual = LEVELS.map((l) => ({
    id: l.id,
    type: l.type,
    node: l.node,
    drill: l.drill,
    kind: l.kind,
    items: l.items,
    given: l.given,
    title: l.title,
  }));
  assert.equal(LEVELS.length, 22);
  assert.deepEqual(actual, expected);
});

test("EAR_TARGETS_MS matches the fixture targets", () => {
  assert.deepEqual(EAR_TARGETS_MS, fixture.targets_ms);
});

test("every level's defaults survive normalizeSettings unchanged and sit inside SETS", () => {
  for (const l of LEVELS) {
    assert.deepEqual(normalizeSettings(l, {}), l.defaults, l.id);
    for (const v of l.defaults.set) {
      assert.ok(SETS[l.type].includes(v), `${l.id}: ${v} not in SETS.${l.type}`);
    }
  }
});

test("normalizeSettings clamps low and high into 36-84", () => {
  const s = normalizeSettings(level("echo-2"), { low: 10 });
  assert.equal(s.low, 36);
  assert.equal(s.high, 72);
});

test("normalizeSettings swaps a reversed range", () => {
  const s = normalizeSettings(level("echo-2"), { low: 72, high: 60 });
  assert.equal(s.low, 60);
  assert.equal(s.high, 72);
});

test("normalizeSettings restores defaults when the range is under 4 semitones", () => {
  const l = level("echo-2");
  const s = normalizeSettings(l, { low: 60, high: 62 });
  assert.equal(s.low, l.defaults.low);
  assert.equal(s.high, l.defaults.high);
});

test("normalizeSettings drops unknown set ids", () => {
  const s = normalizeSettings(level("updown-1"), { set: ["higher", "bogus"] });
  assert.deepEqual(s.set, ["higher"]);
});

test("normalizeSettings de-duplicates set ids", () => {
  const s = normalizeSettings(level("updown-1"), { set: ["lower", "lower", "step"] });
  assert.deepEqual(s.set, ["lower", "step"]);
});

test("normalizeSettings falls back to defaults for an empty set", () => {
  const l = level("updown-1");
  assert.deepEqual(normalizeSettings(l, { set: [] }).set, l.defaults.set);
});

test("normalizeSettings keeps only the first set value for echo", () => {
  const s = normalizeSettings(level("echo-1"), { set: ["chromatic", "scale"] });
  assert.deepEqual(s.set, ["chromatic"]);
});

test("normalizeSettings clamps bpm into 40-200", () => {
  assert.equal(normalizeSettings(level("echo-1"), { bpm: 500 }).bpm, 200);
  assert.equal(normalizeSettings(level("echo-1"), { bpm: 5 }).bpm, 40);
});

test("normalizeSettings clamps lenMin and lenMax into 1-8", () => {
  const s = normalizeSettings(level("echo-5"), { lenMax: 9 });
  assert.equal(s.lenMax, 8);
  assert.equal(s.lenMin, 4);
});

test("normalizeSettings ignores length for levels with lenMax 1", () => {
  const l = level("echo-1");
  const s = normalizeSettings(l, { lenMin: 3, lenMax: 4 });
  assert.equal(s.lenMin, l.defaults.lenMin);
  assert.equal(s.lenMax, l.defaults.lenMax);
});

test("normalizeSettings accepts valid direction and harmonic and ignores invalid ones", () => {
  const l = level("interval-4");
  assert.equal(normalizeSettings(l, { direction: "down", harmonic: "harmonic" }).direction, "down");
  assert.equal(normalizeSettings(l, { direction: "sideways" as never }).direction, "both");
  assert.equal(normalizeSettings(l, { harmonic: "mixed" }).harmonic, "mixed");
});

test("normalizeSettings sets key to null or an integer 0-11", () => {
  assert.equal(normalizeSettings(level("echo-1"), { key: null }).key, null);
  assert.equal(normalizeSettings(level("echo-1"), { key: 7 }).key, 7);
  assert.equal(normalizeSettings(level("echo-1"), { key: 12 }).key, 0);
});

test("sameSettings compares settings field by field", () => {
  const l = level("updown-1");
  assert.equal(sameSettings(l.defaults, normalizeSettings(l, {})), true);
  assert.equal(sameSettings(l.defaults, normalizeSettings(l, { bpm: 90 })), false);
  assert.equal(sameSettings(l.defaults, normalizeSettings(l, { set: ["lower", "higher"] })), false);
});

test("keyName maps pitch classes to names", () => {
  assert.equal(keyName(0), "C");
  assert.equal(keyName(1), "Db");
  assert.equal(keyName(11), "B");
  assert.equal(keyName(12), "C");
});

test("promptLengthMs is the latest end time, 0 when empty", () => {
  assert.equal(promptLengthMs([]), 0);
  const notes: PromptNote[] = [
    { note: 60, startMs: 0, durMs: 500, velocity: 80 },
    { note: 64, startMs: 500, durMs: 700, velocity: 80 },
    { note: 67, startMs: 100, durMs: 300, velocity: 80 },
  ];
  assert.equal(promptLengthMs(notes), 1200);
});

test("tunes: 11 unique ids with valid phrases in range", () => {
  assert.equal(TUNES.length, 11);
  assert.equal(new Set(TUNES.map((t) => t.id)).size, 11);
  assert.deepEqual(TUNE_IDS, TUNES.map((t) => t.id));
  for (const t of TUNES) {
    assert.ok(tuneById(t.id), t.id);
    assert.ok(t.phrases.length > 0, t.id);
    for (const p of t.phrases) {
      assert.ok(p.notes.length > 0, t.id);
      assert.equal(p.notes.length, p.beats.length, t.id);
      for (const n of p.notes) assert.ok(n >= 55 && n <= 72, `${t.id} note ${n}`);
      for (const b of p.beats) assert.ok(b > 0, `${t.id} beat ${b}`);
    }
  }
  assert.equal(tuneById("no-such-tune"), null);
});

test("EASY_TUNES are all known tune ids", () => {
  for (const id of EASY_TUNES) assert.ok(TUNE_IDS.includes(id), id);
});

test("instructionText gives the text for each type", () => {
  const byType: Record<EarType, string> = {
    echo: "Listen, then play the phrase back. It starts on the lit key.",
    updown: "Listen to two notes. The first is lit: play the second.",
    interval: "Listen to the interval. The first note is lit: play the other note.",
    chord: "Listen to the chord. Its root is lit: play the whole chord (any octave, any order).",
    tune: "Listen to the tune, then play it back from the lit key.",
    bass: "Listen to the chords. The key note is lit: play the bass note of each chord in order (any octave).",
  };
  assert.equal(instructionText(level("echo-1")), "Listen, then find the note.");
  assert.equal(instructionText(level("echo-4")), byType.echo);
  assert.equal(instructionText(level("updown-1")), byType.updown);
  assert.equal(instructionText(level("interval-1")), byType.interval);
  assert.equal(instructionText(level("chord-1")), byType.chord);
  assert.equal(instructionText(level("tune-1")), byType.tune);
  assert.equal(instructionText(level("bass-1")), byType.bass);
});
