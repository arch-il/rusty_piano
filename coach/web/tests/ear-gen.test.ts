import { test } from "node:test";
import assert from "node:assert/strict";
import { CHORDS, INTERVALS, LEVELS, PATTERNS, levelById } from "../src/ear-levels.ts";
import type { EarItem } from "../src/ear-levels.ts";
import { makeEarRound, scalePool } from "../src/ear-gen.ts";
import { isWhite } from "../src/sight-gen.ts";
import { tuneById } from "../src/ear-tunes.ts";

function round(id: string, seed = 1, over: Record<string, unknown> = {}): EarItem[] {
  const l = levelById(id);
  assert.ok(l);
  return makeEarRound(l, { ...l.defaults, ...over }, seed);
}

function allNotes(it: EarItem): number[] {
  return [...it.prompt.map((p) => p.note), ...it.answerSound.map((p) => p.note), ...it.given, ...it.answerNotes];
}

const pnotes = (it: EarItem) => it.prompt.map((p) => p.note);

test("scalePool", () => {
  assert.deepEqual(scalePool(60, 72, 0), [60, 62, 64, 65, 67, 69, 71, 72]);
  assert.deepEqual(scalePool(60, 66, 2), [61, 62, 64, 66]);
});

test("same seed same items, different seeds differ", () => {
  for (const l of LEVELS) {
    assert.deepEqual(round(l.id, 5), round(l.id, 5));
  }
  assert.notDeepEqual(round("echo-5", 1), round("echo-5", 2));
});

test("all levels: count, range, no consecutive identical prompts", () => {
  for (const l of LEVELS) {
    for (const seed of [1, 2, 3, 4, 5]) {
      const items = round(l.id, seed);
      assert.equal(items.length, l.items, l.id);
      items.forEach((it, i) => {
        assert.equal(it.index, i);
        assert.equal(it.type, l.type);
        for (const n of allNotes(it)) assert.ok(n >= 36 && n <= 84, `${l.id} ${n}`);
        if (i > 0) assert.notDeepEqual(pnotes(it), pnotes(items[i - 1]), l.id);
      });
    }
  }
});

test("per-type rules", () => {
  for (const l of LEVELS) {
    for (const it of round(l.id, 7)) {
      if (l.type === "echo") {
        assert.deepEqual(it.answerNotes, pnotes(it));
        assert.deepEqual(it.answer, it.answerNotes.map((pitch) => ({ kind: "note", pitch })));
        assert.deepEqual(it.given, it.answerNotes.length > 1 ? [it.answerNotes[0]] : []);
      } else if (l.type === "updown") {
        assert.deepEqual(it.given, [pnotes(it)[0]]);
        assert.deepEqual(it.answerNotes, [pnotes(it)[1]]);
      } else if (l.type === "interval") {
        const iv = INTERVALS.find((i) => i.id === it.category);
        assert.ok(iv);
        const other = it.answerNotes[0];
        const root = it.given[0];
        assert.equal(Math.abs(other - root), iv.semitones);
        assert.deepEqual(it.answer, [{ kind: "note", pitch: other }]);
      } else if (l.type === "chord") {
        const q = CHORDS.find((c) => c.id === it.category);
        assert.ok(q);
        const pcs = [...new Set(q.intervals.map((i) => (it.given[0] + i) % 12))].sort((a, b) => a - b);
        assert.deepEqual(it.answer, [{ kind: "chord", pcs }]);
      } else if (l.type === "bass") {
        assert.deepEqual(it.answer, it.answerNotes.map((n) => ({ kind: "pc", pc: n % 12 })));
        if (it.category.startsWith("I-") || l.id !== "bass-4") assert.equal(it.answerNotes[0], it.given[0]);
      } else {
        assert.equal(it.given[0], it.answerNotes[0]);
        assert.deepEqual(it.answer, it.answerNotes.map((pitch) => ({ kind: "note", pitch })));
        assert.deepEqual(it.answerNotes, pnotes(it));
      }
    }
  }
});

test("settings are respected", () => {
  for (const it of round("interval-3", 3, { set: ["m3"] })) assert.equal(it.category, "m3");
  for (const it of round("echo-1", 3)) {
    assert.equal(it.answerNotes.length, 1);
    assert.ok(it.answerNotes[0] >= 60 && it.answerNotes[0] <= 67 && isWhite(it.answerNotes[0]));
  }
});

test("tune-2 in key 7 is 7 semitones above C major", () => {
  for (const it of round("tune-2", 4, { key: 7 })) {
    const tune = tuneById(it.category);
    assert.ok(tune);
    assert.ok(tune.phrases.some((p) => p.notes.length === it.answerNotes.length && p.notes.every((n, i) => (it.answerNotes[i] - n + 12) % 12 === 7)));
    assert.ok(it.answerNotes[0] - 7 >= 36);
  }
});

test("bass levels", () => {
  for (let seed = 1; seed <= 10; seed++) {
    for (const it of round("bass-1", seed, { key: 0 })) {
      assert.ok(it.answerNotes.length === 3 || it.answerNotes.length === 4);
      assert.equal(it.category.split("-")[0], "I");
      assert.equal(it.answerNotes[0], 48);
    }
    for (const it of round("bass-4", seed)) {
      assert.ok(it.answerNotes.length === 3 || it.answerNotes.length === 4);
      assert.ok(Object.values(PATTERNS).some((p) => p.join("-") === it.category));
    }
  }
});

test("timing at bpm 60", () => {
  const it = round("echo-5", 1, { bpm: 60, lenMin: 3, lenMax: 3 })[0];
  assert.deepEqual(it.prompt.map((p) => p.startMs), [0, 1000, 2000]);
  assert.equal(it.prompt[0].durMs, 900);
  assert.equal(it.prompt[0].velocity, 80);
});

test("every item's category is inside the level set", () => {
  for (const l of LEVELS) {
    if (l.type === "echo") continue;
    for (const seed of [1, 2, 3, 4, 5, 42]) {
      const set = l.defaults.set;
      for (const it of round(l.id, seed)) {
        if (l.type === "bass") {
          const inPatterns = set.some((v) => v in PATTERNS && v === it.category);
          const degs = it.category.split("-");
          assert.ok(inPatterns || degs.every((d) => set.includes(d)) || set.some((v) => v in PATTERNS), l.id + " " + it.category);
          if (set.some((v) => v in PATTERNS)) assert.ok(set.includes(it.category) || set.some((v) => PATTERNS[v]?.join("-") === it.category), l.id + " " + it.category);
        } else {
          assert.ok(set.includes(it.category), l.id + " " + it.category);
        }
      }
    }
  }
});

test("tune levels pick each tune equally often, whatever its phrase count", () => {
  let hot = 0;
  let total = 0;
  for (let seed = 1; seed <= 200; seed++) {
    for (const it of round("tune-2", seed, { set: ["hot-cross-buns", "frere-jacques"] })) {
      total++;
      if (it.category === "hot-cross-buns") hot++;
    }
  }
  assert.equal(total, 1200);
  const share = hot / total;
  assert.ok(share >= 0.4 && share <= 0.55, String(share));
});

test("interval-3 with set m3,M3 and seed 42 gives only m3/M3", () => {
  const items = round("interval-3", 42, { set: ["m3", "M3"] });
  for (const it of items) assert.ok(["m3", "M3"].includes(it.category), it.category);
});
