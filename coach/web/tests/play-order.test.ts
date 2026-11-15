import test from "node:test";
import assert from "node:assert/strict";
import { barRuns, playOrder, repeatMarks } from "../src/score-timeline.ts";
import type { MeasureLike, RepeatMarks, RepetitionLike } from "../src/score-timeline.ts";

function mk(o: Partial<RepeatMarks> = {}): RepeatMarks {
  return { start: false, end: false, times: 2, endingBegin: null, endingEnd: false, jump: null, segno: false, coda: false, toCoda: false, fine: false, ...o };
}

function plain(n: number, over: Record<number, Partial<RepeatMarks>>): RepeatMarks[] {
  return Array.from({ length: n }, (_, i) => mk(over[i]));
}

test("playOrder without marks is written order", () => {
  assert.deepEqual(playOrder(plain(4, {})), [0, 1, 2, 3]);
});

test("playOrder minuet shape", () => {
  assert.deepEqual(playOrder(plain(4, { 1: { end: true }, 2: { start: true }, 3: { end: true } })), [0, 1, 0, 1, 2, 3, 2, 3]);
});

test("playOrder end repeats without starts", () => {
  assert.deepEqual(playOrder(plain(4, { 1: { end: true }, 3: { end: true } })), [0, 1, 0, 1, 2, 3, 2, 3]);
});

test("playOrder first and second ending", () => {
  const marks = plain(5, {
    0: { start: true },
    2: { endingBegin: [1], endingEnd: true, end: true },
    3: { endingBegin: [2], endingEnd: true },
  });
  assert.deepEqual(playOrder(marks), [0, 1, 2, 0, 1, 3, 4]);
});

test("playOrder ending 1,2 then 3", () => {
  const marks = plain(3, {
    0: { start: true },
    1: { endingBegin: [1, 2], endingEnd: true, end: true },
    2: { endingBegin: [3], endingEnd: true },
  });
  assert.deepEqual(playOrder(marks), [0, 1, 0, 1, 0, 2]);
});

test("playOrder honours times", () => {
  assert.deepEqual(playOrder(plain(2, { 1: { end: true, times: 3 } })), [0, 1, 0, 1, 0, 1]);
});

test("playOrder repeats fixture shape", () => {
  const marks = plain(6, {
    0: { start: true },
    1: { endingBegin: [1], endingEnd: true, end: true },
    2: { endingBegin: [2], endingEnd: true },
    4: { end: true },
  });
  assert.deepEqual(playOrder(marks), [0, 1, 0, 2, 3, 4, 3, 4, 5]);
});

test("playOrder open second ending", () => {
  const marks = plain(3, {
    0: { start: true },
    1: { endingBegin: [1], endingEnd: true, end: true },
    2: { endingBegin: [2] },
  });
  assert.deepEqual(playOrder(marks), [0, 1, 0, 2]);
});

function measure(first?: RepetitionLike[], last?: RepetitionLike[]): MeasureLike {
  return {
    AbsoluteTimestamp: { RealValue: 0 },
    VerticalSourceStaffEntryContainers: [],
    FirstRepetitionInstructions: first,
    LastRepetitionInstructions: last,
  };
}

test("repeatMarks reads start, back jump and times", () => {
  assert.equal(repeatMarks(measure([{ type: 0, alignment: 0 }])).start, true);
  const three = repeatMarks(measure(undefined, [{ type: 2, alignment: 1, Times: 3 }]));
  assert.equal(three.end, true);
  assert.equal(three.times, 3);
  assert.equal(repeatMarks(measure(undefined, [{ type: 2, alignment: 1 }])).times, 2);
});

test("repeatMarks reads endings", () => {
  const begin = repeatMarks(measure([{ type: 3, alignment: 0, endingIndices: [2, 1, 2] }]));
  assert.deepEqual(begin.endingBegin, [1, 2]);
  assert.equal(begin.endingEnd, false);
  assert.equal(repeatMarks(measure(undefined, [{ type: 3, alignment: 1, endingIndices: [1] }])).endingEnd, true);
  assert.equal(repeatMarks(measure(undefined, [{ type: 3, alignment: 3, endingIndices: [1] }])).endingEnd, true);
});

test("repeatMarks ignores forward jumps and missing arrays", () => {
  assert.deepEqual(repeatMarks(measure([{ type: 1 }], [{ type: 1 }])), mk());
  assert.deepEqual(repeatMarks(measure()), mk());
});

test("playOrder D.C. al Fine", () => {
  const marks = plain(4, { 0: { start: true }, 1: { end: true, fine: true }, 3: { jump: "dcFine" } });
  assert.deepEqual(playOrder(marks), [0, 1, 0, 1, 2, 3, 0, 1]);
  assert.deepEqual(playOrder(marks, { repeatsAfterJump: true }), [0, 1, 0, 1, 2, 3, 0, 1, 0, 1]);
  assert.deepEqual(playOrder(marks, { jumps: false }), [0, 1, 0, 1, 2, 3]);
});

test("playOrder plain D.C. ignores an earlier Fine", () => {
  assert.deepEqual(playOrder(plain(4, { 1: { fine: true }, 3: { jump: "dc" } })), [0, 1, 2, 3, 0, 1]);
});

test("playOrder D.C. without Fine plays to the end", () => {
  assert.deepEqual(playOrder(plain(3, { 2: { jump: "dc" } })), [0, 1, 2, 0, 1, 2]);
});

test("playOrder D.S. al Coda", () => {
  const over = { 1: { segno: true }, 2: { toCoda: true }, 3: { jump: "dsCoda" as const } };
  assert.deepEqual(playOrder(plain(6, { ...over, 4: { coda: true } })), [0, 1, 2, 3, 1, 2, 4, 5]);
  assert.deepEqual(playOrder(plain(6, { ...over, 5: { coda: true } })), [0, 1, 2, 3, 1, 2, 5]);
  assert.deepEqual(playOrder(plain(5, over)), [0, 1, 2, 3, 1, 2, 4]);
});

test("playOrder D.S. without a segno is ignored", () => {
  assert.deepEqual(playOrder(plain(3, { 2: { jump: "ds" } })), [0, 1, 2]);
});

test("playOrder takes the last ending after a D.C.", () => {
  const marks = plain(4, {
    0: { start: true },
    1: { endingBegin: [1], endingEnd: true, end: true },
    2: { endingBegin: [2], endingEnd: true },
    3: { jump: "dc" },
  });
  assert.deepEqual(playOrder(marks), [0, 1, 0, 2, 3, 0, 2, 3]);
});

test("repeatMarks reads jumps and flags", () => {
  assert.equal(repeatMarks(measure(undefined, [{ type: 9 }])).jump, "dcFine");
  assert.equal(repeatMarks(measure([{ type: 4 }])).jump, "dc");
  assert.equal(repeatMarks(measure(undefined, [{ type: 11 }])).jump, "dcCoda");
  assert.equal(repeatMarks(measure(undefined, [{ type: 5 }])).jump, "ds");
  assert.equal(repeatMarks(measure(undefined, [{ type: 8 }])).jump, "dsFine");
  assert.equal(repeatMarks(measure(undefined, [{ type: 10 }])).jump, "dsCoda");
  assert.equal(repeatMarks(measure([{ type: 13 }])).segno, true);
  assert.equal(repeatMarks(measure(undefined, [{ type: 12 }])).coda, true);
  assert.equal(repeatMarks(measure(undefined, [{ type: 7 }])).toCoda, true);
  assert.equal(repeatMarks(measure(undefined, [{ type: 6 }])).fine, true);
  assert.deepEqual(repeatMarks(measure([{ type: 1 }], [{ type: 1 }])), mk());
});

test("barRuns merges and joins runs", () => {
  const b = (list: [number, number][]) => list.map(([bar, pass]) => ({ bar, pass }));
  assert.equal(
    barRuns(b([[1, 1], [1, 1], [2, 1], [1, 2], [3, 1], [4, 1], [5, 1], [4, 2], [5, 2], [6, 1]])),
    "1-2 1 3-5 4-5 6",
  );
  assert.equal(
    barRuns(b([[1, 1], [2, 1], [3, 1], [1, 2], [2, 2], [3, 2], [4, 1], [5, 1], [6, 1], [4, 2], [5, 2], [6, 2]])),
    "1-3 1-3 4-6 4-6",
  );
  assert.equal(barRuns([]), "");
});
