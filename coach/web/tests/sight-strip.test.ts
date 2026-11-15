import test from "node:test";
import assert from "node:assert/strict";
import { STRIP_KEEP, STRIP_SHIFT_AT, STRIP_SIZE, stripStart, stripXml } from "../src/sight-strip.ts";
import { WRONG_ANCHOR_COLOR } from "../src/sight-xml.ts";
import { makeRound } from "../src/sight-gen.ts";
import { levelById } from "../src/sight-levels.ts";
import type { Card } from "../src/sight-levels.ts";

const COLORS = { done: "#11aa11", wrong: "#cc2222", current: "#2244dd" };

function assertWellFormed(xml: string): void {
  const stack: string[] = [];
  let last = 0;
  for (const m of xml.matchAll(/<[^>]*>/g)) {
    last = (m.index ?? 0) + m[0].length;
    const tag = m[0];
    if (tag.startsWith("<?")) continue;
    if (tag.startsWith("</")) assert.equal(stack.pop(), tag.slice(2, -1), `unexpected ${tag}`);
    else if (!tag.endsWith("/>")) stack.push(tag.slice(1, -1).split(/\s/)[0]);
  }
  assert.equal(xml.slice(last), "", "trailing text");
  assert.deepEqual(stack, []);
}

function count(text: string, part: string): number {
  return text.split(part).length - 1;
}

function measuresOf(xml: string): string[] {
  return xml.split("<measure ").slice(1).map((m) => m.split("</measure>")[0]);
}

test("constants", () => {
  assert.equal(STRIP_SIZE, 8);
  assert.equal(STRIP_SHIFT_AT, 5);
  assert.equal(STRIP_KEEP, 1);
});

test("stripStart shifts in jumps and clamps", () => {
  for (let c = 0; c < 5; c++) assert.equal(stripStart(0, c, 20), 0);
  assert.equal(stripStart(0, 5, 20), 4);
  assert.equal(stripStart(4, 6, 20), 4);
  assert.equal(stripStart(4, 8, 20), 4);
  assert.equal(stripStart(4, 9, 20), 8);
  assert.equal(stripStart(4, 2, 20), 1);
  assert.equal(stripStart(4, 0, 20), 0);
  assert.equal(stripStart(12, 17, 20), 12);
  assert.equal(stripStart(12, 17, 20), Math.max(0, 20 - 8));
  assert.equal(stripStart(8, 13, 20), 12);
  assert.equal(stripStart(0, 5, 6), 0);
  assert.equal(stripStart(0, 5, 8), 0);
  assert.equal(stripStart(0, 5, 3), 0);
  for (let total = 1; total < 25; total++) {
    let start = 0;
    for (let c = 0; c < total; c++) {
      start = stripStart(start, c, total);
      assert.ok(start <= c && c < start + 8 && start >= 0, `total ${total} current ${c} start ${start}`);
      assert.ok(start <= Math.max(0, total - 8));
    }
  }
});

const levels: { id: string; custom?: { clef: "treble" | "bass" | "grand"; low: number; high: number; accidentals: boolean } }[] = [
  { id: "r2-treble" },
  { id: "r3-bass" },
  { id: "r4-grand" },
  { id: "r5-intervals" },
  { id: "r6-ledger" },
  { id: "r7-keys" },
  { id: "custom", custom: { clef: "treble", low: 60, high: 72, accidentals: true } },
  { id: "custom", custom: { clef: "grand", low: 48, high: 72, accidentals: false } },
];

function cardsFor(l: (typeof levels)[number]): Card[] {
  const level = levelById(l.id);
  assert.ok(level);
  return makeRound(level, { seed: 7, custom: l.custom });
}

function durationsPerStaff(measure: string, staves: number): number[] {
  const sums = new Array(staves).fill(0);
  let staff = 1;
  let cursor = 0;
  for (const part of measure.split(/(?=<note[ >])|(?=<backup>)/)) {
    if (part.startsWith("<backup>")) {
      staff = 2;
      cursor = 0;
      continue;
    }
    if (!part.startsWith("<note")) continue;
    if (part.includes("<chord/>")) continue;
    const d = Number(/<duration>(\d+)<\/duration>/.exec(part)?.[1]);
    sums[staves === 2 ? staff - 1 : 0] += d;
    cursor += d;
  }
  return sums;
}

for (const l of levels) {
  test(`${l.id}${l.custom ? " " + l.custom.clef : ""}: strip window XML`, () => {
    const cards = cardsFor(l);
    const grand = cards.some((c) => c.clef === "grand");
    for (const [start, current] of [[0, 0], [0, 3], [4, 6], [Math.max(0, cards.length - 8), cards.length - 1]]) {
      const end = Math.min(cards.length, start + 8);
      const xml = stripXml(cards, start, current, {}, COLORS);
      assertWellFormed(xml);
      const ms = measuresOf(xml);
      assert.equal(ms.length, end - start);
      ms.forEach((m) => {
        const sums = durationsPerStaff(m, grand ? 2 : 1);
        for (const s of sums) assert.equal(s, 4);
        if (grand) assert.ok(m.includes("<backup>"));
      });
      assert.equal(xml.includes("<staves>2</staves>"), grand);
      assert.equal(xml.includes("light-heavy"), end === cards.length);
      assert.ok(!xml.includes('<time>'));
      assert.equal(count(xml, '<time print-object="no">'), 1);
      // colours
      ms.forEach((m, i) => {
        const idx = start + i;
        if (idx < current) {
          assert.ok(m.includes(`color="${COLORS.done}"`));
          assert.ok(!m.includes(COLORS.current));
        } else if (idx === current) {
          assert.ok(m.includes(`color="${COLORS.current}"`));
          assert.ok(!m.includes(COLORS.done));
        } else {
          assert.ok(!m.includes("color="));
        }
      });
      // key / clef only on change
      let prev = cards[start];
      ms.forEach((m, i) => {
        if (i === 0) return;
        const c = cards[start + i];
        assert.equal(m.includes("<key>"), c.fifths !== prev.fifths);
        assert.equal(m.includes("<clef"), c.clef !== prev.clef && !grand);
        assert.ok(!m.includes("<divisions>"));
        prev = c;
      });
    }
  });
}

test("r7 changes key, r5 and r6 change clef somewhere in a window", () => {
  const r7 = stripXml(cardsFor({ id: "r7-keys" }), 0, 0, {}, COLORS);
  assert.ok(count(r7, "<key>") > 1);
  for (const id of ["r5-intervals", "r6-ledger"]) {
    const xml = stripXml(cardsFor({ id }), 0, 0, {}, COLORS);
    assert.ok(count(xml, "<clef>") >= 1);
  }
});

test("current step colour and wrong anchor", () => {
  const cards = cardsFor({ id: "r5-intervals" });
  const current = 2;
  const plain = stripXml(cards, 0, current, { done: 1 }, COLORS);
  const m = measuresOf(plain)[current];
  assert.equal(count(m, `<note color="${COLORS.done}">`), cards[current].steps[0].notes.length);
  assert.equal(count(m, `<note color="${COLORS.current}">`), cards[current].steps[1].notes.length);
  const wrongNote = cards[current].steps[1].notes[0].midi + 1;
  const wrong = stripXml(cards, 0, current, { done: 1, wrong: { step: 1, note: wrongNote } }, COLORS);
  assertWellFormed(wrong);
  assert.equal(count(wrong, "<note>") + count(wrong, "<note "), count(plain, "<note>") + count(plain, "<note "));
  assert.equal(count(wrong, `<note color="${WRONG_ANCHOR_COLOR}">`), 1);
  assert.ok(!wrong.includes(COLORS.wrong));
});
