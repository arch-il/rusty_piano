import test from "node:test";
import assert from "node:assert/strict";
import { buildTimeline } from "../src/score-timeline.ts";
import { fallbackText, freePlayXml, freePlayZoom } from "../src/free-play-xml.ts";
import type { Slot } from "../src/free-play-slots.ts";
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

const count = (s: string, sub: string): number => s.split(sub).length - 1;

const measures = (xml: string): string[] =>
  [...xml.matchAll(/<measure\b[^>]*>([\s\S]*?)<\/measure>/g)].map((m: RegExpMatchArray): string => m[1]);

test("empty slots give one rest measure with the key signature", () => {
  const xml = freePlayXml([], 0);
  assertWellFormed(xml);
  assert.equal(count(xml, "<measure "), 1);
  assert.ok(xml.includes("<fifths>0</fifths>"));
  assert.ok(xml.includes('<time print-object="no">'));
  assert.ok(xml.includes('<note print-object="no"><rest measure="yes"/>'));
  assert.ok(xml.includes("<sign>G</sign>"));
});

const S: Slot[] = [
  { notes: [60, 64, 67], clef: "treble" },
  { notes: [62], clef: "treble" },
  { notes: [43, 47, 50, 53], clef: "bass" },
  { notes: [64, 67, 72], clef: "treble" },
];

test("four slots with clef changes, chord names and chords", () => {
  const xml = freePlayXml(S, 0);
  assertWellFormed(xml);
  const ms = measures(xml);
  assert.equal(ms.length, 4);
  assert.equal(count(xml, "<note>"), 11);
  assert.equal(count(xml, "<chord/>"), 7);
  assert.equal(count(xml, "<bar-style>none</bar-style>"), 4);
  assert.ok(ms[0].includes("<divisions>1</divisions>"));
  assert.ok(ms[0].includes("<sign>G</sign>"));
  assert.ok(!ms[1].includes("<attributes>"));
  assert.ok(ms[2].includes("<attributes><clef><sign>F</sign><line>4</line></clef></attributes>"));
  assert.ok(ms[3].includes("<attributes><clef><sign>G</sign><line>2</line></clef></attributes>"));
  assert.ok(ms[0].includes("<words>C</words>"));
  assert.ok(!ms[1].includes("<words>"));
  assert.ok(ms[2].includes("<words>G7</words>"));
  assert.ok(ms[3].includes("<words>C/E</words>"));
  assert.ok(ms[0].indexOf("<direction") < ms[0].indexOf("<note>"));
  assert.deepEqual(
    buildTimeline(fakeSheetFromMusicXml(xml)).map((s) => s.pitches),
    [[60, 64, 67], [62], [43, 47, 50, 53], [64, 67, 72]],
  );
});

test("accidentals are written only when they differ from the key", () => {
  const sharpF = freePlayXml([{ notes: [66], clef: "treble" }], 0);
  assert.ok(sharpF.includes("<step>F</step><alter>1</alter>"));
  assert.ok(sharpF.includes("<accidental>sharp</accidental>"));

  const gSharpKey = freePlayXml([{ notes: [66], clef: "treble" }], 1);
  assert.ok(gSharpKey.includes("<alter>1</alter>"));
  assert.ok(!gSharpKey.includes("<accidental>"));

  const flatG = freePlayXml([{ notes: [66], clef: "treble" }], -1);
  assert.ok(flatG.includes("<step>G</step><alter>-1</alter>"));
  assert.ok(flatG.includes("<accidental>flat</accidental>"));

  const naturalF = freePlayXml([{ notes: [65], clef: "treble" }], 1);
  assert.ok(naturalF.includes("<accidental>natural</accidental>"));

  const flatBKey = freePlayXml([{ notes: [70], clef: "treble" }], -1);
  assert.ok(flatBKey.includes("<step>B</step><alter>-1</alter>"));
  assert.ok(!flatBKey.includes("<accidental>"));
});

test("key signature is written with the given fifths", () => {
  assert.ok(freePlayXml([], -3).includes("<key><fifths>-3</fifths></key>"));
});

test("B# in E major is spelled B#4 and the chord is named G#", () => {
  const slots: Slot[] = [{ notes: [68, 72, 75], clef: "treble" }];
  const xml = freePlayXml(slots, 4);
  assertWellFormed(xml);
  assert.ok(xml.includes("<step>B</step><alter>1</alter><octave>4</octave>"));
  assert.ok(xml.includes("<words>G#</words>"));
  assert.deepEqual(buildTimeline(fakeSheetFromMusicXml(xml)).map((s) => s.pitches), [[68, 72, 75]]);
});

test("fallbackText", () => {
  assert.equal(fallbackText([], 0), "");
  assert.equal(
    fallbackText(
      [
        { notes: [60, 64, 67], clef: "treble" },
        { notes: [62], clef: "treble" },
      ],
      0,
    ),
    "C (C4 E4 G4) | D4",
  );
  assert.equal(fallbackText([{ notes: [66], clef: "treble" }], -1), "Gb4");
});

test("freePlayZoom shrinks the staff only below 600 px, down to 0.7", () => {
  assert.equal(freePlayZoom(0), 1);
  assert.equal(freePlayZoom(900), 1);
  assert.equal(freePlayZoom(600), 1);
  assert.equal(freePlayZoom(450), 0.75);
  assert.equal(freePlayZoom(300), 0.7);
});

test("every slot set passes the well-formedness check", () => {
  const sets: Slot[][] = [
    S,
    [{ notes: [68, 72, 75], clef: "treble" }],
    [{ notes: [66], clef: "treble" }],
    [{ notes: [65], clef: "treble" }],
    [{ notes: [70], clef: "treble" }],
  ];
  for (const slots of sets) {
    for (const fifths of [-3, -1, 0, 1, 4]) {
      assertWellFormed(freePlayXml(slots, fifths));
    }
  }
});
