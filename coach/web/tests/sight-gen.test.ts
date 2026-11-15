import { test } from "node:test";
import assert from "node:assert/strict";
import { LEVELS, levelById } from "../src/sight-levels.ts";
import type { Card, CardNote, LevelDef, Pitch } from "../src/sight-levels.ts";
import { isWhite, keyAlter, makeRound, mulberry32, pickWeighted, spell } from "../src/sight-gen.ts";

const NATURAL_MIDI: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

function pitchMidi(p: Pitch): number {
  return NATURAL_MIDI[p.step] + p.alter + 12 * (p.octave + 1);
}

function level(id: string): LevelDef {
  const found = levelById(id);
  assert.ok(found, `missing level ${id}`);
  return found;
}

function allNotes(card: Card): CardNote[] {
  return card.steps.flatMap((s) => s.notes);
}

function checkCommon(card: Card): void {
  for (const step of card.steps) {
    assert.deepEqual(step.pitches, step.notes.map((n) => n.midi).sort((a, b) => a - b));
    for (const n of step.notes) assert.equal(pitchMidi(n.pitch), n.midi);
  }
  const times = card.steps.map((s) => s.time);
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
  assert.equal(new Set(times).size, times.length);
  for (const n of allNotes(card)) {
    if (card.clef === "grand") assert.equal(n.staff, n.midi >= 60 ? 1 : 2);
    else assert.equal(n.staff, 1);
  }
}

const RANGE_R2 = [60, 62, 64, 65, 67];
const RANGE_R3 = [48, 50, 52, 53, 55];
const LEDGER_TREBLE = [57, 59, 60, 81, 83, 84];
const LEDGER_BASS = [36, 38, 40, 60, 62, 64];
const PHRASE_RIGHT = [60, 62, 64, 65, 67];
const PHRASE_LEFT = [48, 50, 52, 53, 55];
const R8A_TREBLE = [60, 62, 64, 65, 67, 69, 71, 72, 74];
const R8A_BASS = [43, 45, 47, 48, 50, 52, 53, 55];
const WHITES_TREBLE_WIDE = [60, 62, 64, 65, 67, 69, 71, 72];
const WHITES_BASS_WIDE = [48, 50, 52, 53, 55, 57, 59, 60];

function checkNotesLevel(id: string, card: Card): void {
  assert.equal(card.steps.length, 1);
  assert.equal(card.steps[0].time, 0);
  assert.equal(card.steps[0].notes.length, 1);
  assert.equal(card.steps[0].notes[0].quarters, 4);
  assert.equal(card.showTime, false);
  assert.equal(card.measures, 1);
  const midi = card.steps[0].notes[0].midi;
  if (id === "r2-treble") {
    assert.equal(card.clef, "treble");
    assert.ok(RANGE_R2.includes(midi));
  } else if (id === "r3-bass") {
    assert.equal(card.clef, "bass");
    assert.ok(RANGE_R3.includes(midi));
  } else if (id === "r4-grand") {
    assert.equal(card.clef, "grand");
    assert.ok(midi >= 48 && midi <= 72 && isWhite(midi));
  } else if (id === "r6-ledger") {
    if (card.clef === "treble") assert.ok(LEDGER_TREBLE.includes(midi));
    else assert.ok(LEDGER_BASS.includes(midi));
  } else if (id === "r7-keys") {
    assert.equal(card.clef, "grand");
    assert.ok(card.fifths === 1 || card.fifths === -1);
    const pcs = card.fifths === 1 ? [7, 9, 11, 0, 2, 4, 6] : [5, 7, 9, 10, 0, 2, 4];
    assert.ok(pcs.includes(midi % 12), `note ${midi} not diatonic to fifths ${card.fifths}`);
    assert.ok(midi >= 48 && midi <= 72);
  }
}

function checkBars(id: string, cards: Card[]): void {
  assert.equal(cards.length, 4);
  for (const card of cards) {
    assert.equal(card.measures, 2);
    assert.equal(card.showTime, true);
    assert.equal(card.fifths, 0);
    checkCommon(card);
    const staffs = new Set(allNotes(card).map((n) => n.staff));
    for (const staff of staffs) {
      for (let bar = 0; bar < 2; bar++) {
        const sum = allNotes(card)
          .filter((n) => n.staff === staff)
          .filter((n) => {
            const step = card.steps.find((s) => s.notes.includes(n));
            return step !== undefined && step.time >= bar * 4 && step.time < bar * 4 + 4;
          })
          .reduce((acc, n) => acc + n.quarters, 0);
        assert.equal(sum, 4, `staff ${staff} bar ${bar + 1} of card ${card.index}`);
      }
    }
    const midis = allNotes(card).map((n) => n.midi);
    if (id === "r8a-five") {
      if (card.index % 2 === 0) {
        assert.equal(card.clef, "treble");
        assert.ok(midis.every((m) => R8A_TREBLE.includes(m)));
      } else {
        assert.equal(card.clef, "bass");
        assert.ok(midis.every((m) => R8A_BASS.includes(m)));
      }
    } else if (id === "r8b-wide") {
      if (card.index % 2 === 0) {
        assert.equal(card.clef, "treble");
        assert.ok(midis.every((m) => WHITES_TREBLE_WIDE.includes(m)));
      } else {
        assert.equal(card.clef, "bass");
        assert.ok(midis.every((m) => WHITES_BASS_WIDE.includes(m)));
      }
    } else {
      assert.equal(card.clef, "grand");
      const right = allNotes(card).filter((n) => n.staff === 1);
      const left = allNotes(card).filter((n) => n.staff === 2);
      assert.ok(right.every((n) => PHRASE_RIGHT.includes(n.midi)));
      assert.ok(left.every((n) => PHRASE_LEFT.includes(n.midi)));
      assert.deepEqual(left.map((n) => card.steps.find((s) => s.notes.includes(n))?.time), [0, 2, 4, 6]);
      assert.ok(left.every((n) => n.quarters === 2));
      assert.ok((card.steps[0]?.notes.length ?? 0) >= 2, "chord step at time 0");
    }
  }
}

function checkIntervals(cards: Card[]): void {
  let prevPair = "";
  for (const card of cards) {
    checkCommon(card);
    assert.equal(card.steps.length, 2);
    assert.deepEqual(card.steps.map((s) => s.time), [0, 2]);
    const [a, b] = card.steps.map((s) => s.notes[0]);
    assert.equal(a.quarters, 2);
    assert.equal(b.quarters, 2);
    for (const n of [a, b]) assert.ok(isWhite(n.midi), `interval note ${n.midi} not white`);
    const range = card.clef === "treble" ? [60, 79] : [43, 62];
    for (const n of [a, b]) assert.ok(n.midi >= range[0] && n.midi <= range[1]);
    const gap = Math.abs(a.midi - b.midi);
    assert.ok(gap >= 1 && gap <= 7, `interval gap ${gap}`);
    const pair = `${a.midi}-${b.midi}`;
    assert.notEqual(pair, prevPair);
    prevPair = pair;
  }
}

for (const lv of LEVELS.slice(0, 9)) {
  test(`${lv.id}: card counts, determinism, pitch sets and clef/staff rules for seeds 1..5`, () => {
    for (let seed = 1; seed <= 5; seed++) {
      const cards = makeRound(lv, { seed });
      assert.deepEqual(makeRound(lv, { seed }), cards);
      if (lv.kind === "bars") {
        checkBars(lv.id, cards);
        continue;
      }
      assert.equal(cards.length, lv.cards);
      cards.forEach((card, i) => assert.equal(card.index, i));
      if (lv.kind === "intervals") {
        checkIntervals(cards);
        continue;
      }
      for (const card of cards) {
        checkCommon(card);
        checkNotesLevel(lv.id, card);
      }
      for (let i = 1; i < cards.length; i++) {
        assert.notEqual(
          allNotes(cards[i]).map((n) => n.midi).join(),
          allNotes(cards[i - 1]).map((n) => n.midi).join(),
        );
        assert.notEqual(cards[i].steps[0].notes[0].midi, cards[i - 1].steps[0].notes[0].midi);
      }
    }
  });
}

test("mulberry32 is deterministic and stays in [0, 1)", () => {
  const a = mulberry32(42);
  const b = mulberry32(42);
  for (let i = 0; i < 10000; i++) {
    const x = a();
    assert.equal(x, b());
    assert.ok(x >= 0 && x < 1);
  }
});

test("pickWeighted gives a weight-3 item about three times the share of weight-1", () => {
  const rng = mulberry32(7);
  let picked = 0;
  for (let i = 0; i < 10000; i++) {
    if (pickWeighted(["a", "b"], (t) => (t === "a" ? 3 : 1), rng) === "a") picked++;
  }
  const share = picked / 10000;
  assert.ok(share >= 0.7 && share <= 0.8, `share ${share}`);
});

test("pickWeighted with all-zero weights picks uniformly", () => {
  const rng = mulberry32(3);
  const seen = new Set<number>();
  for (let i = 0; i < 100; i++) seen.add(pickWeighted([1, 2], () => 0, rng));
  assert.deepEqual([...seen].sort(), [1, 2]);
});

test("pickWeighted counts negative and NaN weights as zero", () => {
  const rng = mulberry32(5);
  for (let i = 0; i < 200; i++) {
    assert.equal(pickWeighted(["a", "b"], (t) => (t === "a" ? Number.NaN : 1), rng), "b");
  }
});

test("spell and keyAlter", () => {
  assert.deepEqual(spell(66, 1, false), { step: "F", alter: 1, octave: 4 });
  assert.deepEqual(spell(70, -1, false), { step: "B", alter: -1, octave: 4 });
  assert.deepEqual(spell(61, 0, false), { step: "C", alter: 1, octave: 4 });
  assert.deepEqual(spell(61, 0, true), { step: "D", alter: -1, octave: 4 });
  assert.deepEqual(spell(60, 0, false), { step: "C", alter: 0, octave: 4 });
  assert.equal(keyAlter("F", 1), 1);
  assert.equal(keyAlter("B", -1), -1);
  assert.equal(keyAlter("F", 0), 0);
});

test("r2-treble with weight 50 on 64 picks 64 at least 8 times in 20 cards", () => {
  for (let seed = 1; seed <= 5; seed++) {
    const cards = makeRound(level("r2-treble"), { seed, weights: new Map([[64, 50]]) });
    const count = cards.filter((c) => c.steps[0].notes[0].midi === 64).length;
    assert.ok(count >= 8, `seed ${seed}: ${count}`);
  }
});

test("custom white-only range uses white keys inside the range", () => {
  for (let seed = 1; seed <= 5; seed++) {
    const cards = makeRound(level("custom"), {
      seed,
      custom: { clef: "treble", low: 60, high: 72, accidentals: false },
    });
    assert.equal(cards.length, 20);
    for (const card of cards) {
      assert.equal(card.clef, "treble");
      checkCommon(card);
      checkNotesLevel("custom", card);
      const midi = card.steps[0].notes[0].midi;
      assert.ok(midi >= 60 && midi <= 72 && isWhite(midi), `midi ${midi}`);
    }
  }
});

test("custom range with accidentals uses black keys and bass clef", () => {
  let blackSeen = false;
  for (let seed = 1; seed <= 5; seed++) {
    const cards = makeRound(level("custom"), {
      seed,
      custom: { clef: "bass", low: 60, high: 66, accidentals: true },
    });
    for (const card of cards) {
      assert.equal(card.clef, "bass");
      checkCommon(card);
      const midi = card.steps[0].notes[0].midi;
      assert.ok(midi >= 60 && midi <= 66);
      if (!isWhite(midi)) blackSeen = true;
    }
  }
  assert.ok(blackSeen, "expected at least one black key across seeds 1..5");
});

test("custom single black-key range turns accidentals on", () => {
  const cards = makeRound(level("custom"), {
    seed: 1,
    custom: { clef: "treble", low: 61, high: 61, accidentals: false },
  });
  for (const card of cards) assert.equal(card.steps[0].notes[0].midi, 61);
});

test("count option overrides the level card count", () => {
  assert.equal(makeRound(level("r4-grand"), { seed: 1, count: 3 }).length, 3);
});
