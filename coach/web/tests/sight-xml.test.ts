import test from "node:test";
import assert from "node:assert/strict";
import { buildTimeline } from "../src/score-timeline.ts";
import { DEFAULT_XML_COLORS, WRONG_ANCHOR_COLOR, cardXml, wrongNoteOffset } from "../src/sight-xml.ts";
import { isWhite, makeRound } from "../src/sight-gen.ts";
import { LEVELS, levelById } from "../src/sight-levels.ts";
import type { Card } from "../src/sight-levels.ts";
import { fakeSheetFromMusicXml } from "./helpers/fake-osmd-sheet.ts";

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

for (const level of LEVELS) {
  for (const seed of [1, 2, 3]) {
    test(`${level.id} seed ${seed}: cards build well-formed XML that plays the same steps`, () => {
      for (const card of makeRound(level, { seed })) {
        const xml = cardXml(card);
        assertWellFormed(xml);
        assert.equal(count(xml, "<measure "), card.measures);
        const timeline = buildTimeline(fakeSheetFromMusicXml(xml));
        assert.deepEqual(
          timeline.map((s) => s.pitches),
          card.steps.map((s) => [...s.pitches].sort((a, b) => a - b)),
        );
        if (card.clef === "grand") assert.ok(xml.includes("<staves>2</staves>"));
        assert.ok(xml.includes(`<fifths>${card.fifths}</fifths>`));
        assert.equal(xml.includes('<time print-object="no">'), !card.showTime);
      }
    });
  }
}

test("custom card with a black key carries an accidental", () => {
  const level = levelById("custom");
  assert.ok(level);
  const card = makeRound(level, { seed: 1, custom: { clef: "treble", low: 60, high: 72, accidentals: true } }).find((c) =>
    c.steps.some((s) => s.notes.some((n) => !isWhite(n.midi))),
  );
  assert.ok(card);
  assert.match(cardXml(card), /<accidental>(sharp|flat)<\/accidental>/);
});

test("done mark colours only the first step's notes", () => {
  const level = levelById("r8a-five");
  assert.ok(level);
  const card = makeRound(level, { seed: 1 })[0];
  const good = DEFAULT_XML_COLORS.done;
  const xml = cardXml(card, { done: 1 });
  const n = card.steps[0].notes.length;
  assert.equal(count(xml, `<note color="${good}">`), n);
  assert.equal(count(xml, `<notehead color="${good}">`), n);
  assert.equal(count(xml, "color="), 2 * n);
});

test("wrong mark adds no note and tags the target's first note with the anchor colour", () => {
  const level = levelById("r8a-five");
  assert.ok(level);
  const card = makeRound(level, { seed: 1 })[0];
  const wrong = card.steps[1].notes[0].midi + 1;
  assert.ok(!card.steps[1].pitches.includes(wrong));
  const plain = cardXml(card);
  const xml = cardXml(card, { wrong: { step: 1, note: wrong } });
  assertWellFormed(xml);
  assert.equal(count(xml, "<note>") + count(xml, "<note "), count(plain, "<note>") + count(plain, "<note "));
  assert.equal(count(xml, `<note color="${WRONG_ANCHOR_COLOR}">`), 1);
  assert.equal(count(xml, `<notehead color="${WRONG_ANCHOR_COLOR}">`), 1);
  assert.ok(!xml.includes(DEFAULT_XML_COLORS.wrong));
});

function oneNoteCard(clef: "treble" | "bass" | "grand", fifths: number, step: string, alter: number, octave: number, midi: number, staff: number): Card {
  return {
    index: 0,
    clef,
    fifths,
    showTime: false,
    measures: 1,
    steps: [{ time: 0, pitches: [midi], notes: [{ midi, staff, pitch: { step, alter, octave }, quarters: 4 }] }],
  } as Card;
}

test("wrongNoteOffset measures the diatonic distance and the accidental", () => {
  const e4 = oneNoteCard("treble", 0, "E", 0, 4, 64, 1);
  assert.deepEqual(wrongNoteOffset(e4, { wrong: { step: 0, note: 65 } }), { halfSpaces: 1, accidental: null });
  assert.deepEqual(wrongNoteOffset(e4, { wrong: { step: 0, note: 62 } }), { halfSpaces: -1, accidental: null });
  const c4 = oneNoteCard("treble", 0, "C", 0, 4, 60, 1);
  assert.deepEqual(wrongNoteOffset(c4, { wrong: { step: 0, note: 61 } }), { halfSpaces: 0, accidental: "sharp" });
  assert.deepEqual(wrongNoteOffset(c4, { wrong: { step: 0, note: 72 } }), { halfSpaces: 7, accidental: null });
  const c3 = oneNoteCard("bass", 0, "C", 0, 3, 48, 1);
  assert.deepEqual(wrongNoteOffset(c3, { wrong: { step: 0, note: 47 } }), { halfSpaces: -1, accidental: null });
  const g4 = oneNoteCard("treble", 1, "G", 0, 4, 67, 1);
  assert.deepEqual(wrongNoteOffset(g4, { wrong: { step: 0, note: 66 } }), { halfSpaces: -1, accidental: null });
  const f = oneNoteCard("treble", -1, "A", 0, 4, 69, 1);
  assert.deepEqual(wrongNoteOffset(f, { wrong: { step: 0, note: 70 } }), { halfSpaces: 1, accidental: null });
  assert.equal(wrongNoteOffset(e4, {}), null);
  assert.equal(wrongNoteOffset(e4, { wrong: { step: 5, note: 65 } }), null);
});

test("wrong mark on a grand-staff card uses the first note's staff", () => {
  const card = oneNoteCard("grand", 0, "C", 0, 3, 48, 2);
  const xml = cardXml(card, { wrong: { step: 0, note: 47 } });
  assert.equal(count(xml, `<note color="${WRONG_ANCHOR_COLOR}">`), 1);
  assert.ok(xml.includes(`<notehead color="${WRONG_ANCHOR_COLOR}">normal</notehead><staff>2</staff>`));
  assert.deepEqual(wrongNoteOffset(card, { wrong: { step: 0, note: 47 } }), { halfSpaces: -1, accidental: null });
});

test("F# in G major is an alter with no accidental", () => {
  const card: Card = {
    index: 0,
    clef: "treble",
    fifths: 1,
    showTime: false,
    measures: 1,
    steps: [{ time: 0, pitches: [66], notes: [{ midi: 66, staff: 1, pitch: { step: "F", alter: 1, octave: 4 }, quarters: 4 }] }],
  };
  const xml = cardXml(card);
  assert.ok(xml.includes("<alter>1</alter>"));
  assert.ok(!xml.includes("<accidental>"));
});
