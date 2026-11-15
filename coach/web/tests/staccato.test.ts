import test from "node:test";
import assert from "node:assert/strict";
import { buildTimeline } from "../src/score-timeline.ts";
import type { SheetLike } from "../src/score-timeline.ts";
import { practicePlan } from "../src/practice-steps.ts";
import { createHoldChecker } from "../src/hold-checker.ts";
import { autoplaySchedule } from "../src/autoplay.ts";
import { summaryRows } from "../src/practice-metrics.ts";
import type { PracticeCounts } from "../src/practice-metrics.ts";

// Regression: staccato quarters (K3 drills) were judged as held notes and all marked "short".

function note(halfTone: number, articulations: number[]) {
  return {
    halfTone,
    isRest: () => false,
    Length: { RealValue: 0.25 },
    NoteTie: undefined,
    IsGraceNote: false,
    IsCueNote: false,
    PrintObject: true,
    ParentVoiceEntry: { Articulations: articulations.map((a) => ({ articulationEnum: a })) },
  };
}

function sheet(): SheetLike {
  const c = (beat: number, n: unknown) => ({
    Timestamp: { RealValue: beat / 4 },
    StaffEntries: [{ VoiceEntries: [{ IsGrace: false, Notes: [n] }] }],
  });
  return {
    SourceMeasures: [
      {
        AbsoluteTimestamp: { RealValue: 0 },
        VerticalSourceStaffEntryContainers: [
          c(0, note(48, [6])), // staccato -> C4 (halfTone 48 = midi 60)
          c(1, note(50, [7])), // staccatissimo
          c(2, note(52, [0])), // accent only
          c(3, note(53, [])),
        ],
      },
    ],
  } as unknown as SheetLike;
}

test("timeline and plan carry staccato per note", () => {
  const steps = buildTimeline(sheet());
  assert.deepEqual(steps.map((s) => s.notes[0].staccato === true), [true, true, false, false]);
  const plan = practicePlan(steps, { hands: "both", range: null, loop: false });
  assert.deepEqual(plan.steps.map((s) => s.staccato?.[0] === true), [true, true, false, false]);
  assert.deepEqual(plan.steps.map((s) => s.lengths[0]), [1, 1, 1, 1]);
});

test("a quick staccato release is not short", () => {
  const h = createHoldChecker({ minPercent: 50, minNoteMs: 500, pedal: true, staccatoMaxPercent: 60 });
  h.press(60, 0, 0, 1, 833, true);
  const r = h.release(60, 150);
  assert.equal(r?.short, false);
  assert.equal(r?.long, false);
});

test("a held staccato note is too long, even with the pedal down", () => {
  const h = createHoldChecker({ minPercent: 50, minNoteMs: 500, pedal: true, staccatoMaxPercent: 60 });
  h.sustain(true);
  h.press(60, 0, 0, 1, 833, true);
  const r = h.release(60, 800);
  assert.equal(r?.short, false);
  assert.equal(r?.long, true);
});

test("a plain note is never too long", () => {
  const h = createHoldChecker({ minPercent: 50, minNoteMs: 500, pedal: true, staccatoMaxPercent: 60 });
  h.press(60, 0, 0, 1, 833);
  assert.equal(h.release(60, 2000)?.long, false);
});

test("autoplay plays staccato notes short", () => {
  const knobs = { velocity: 80, gatePercent: 90, offsetMs: 0, jitterMs: 0, skipEvery: 0, wrongEvery: 0, seed: 1, staccatoGatePercent: 40 };
  const steps = [
    { pitches: [60], time: 0, lengths: [1], staccato: [true] },
    { pitches: [62], time: 1, lengths: [1] },
  ];
  const out = autoplaySchedule(steps, 1000, knobs, 2);
  assert.deepEqual(out.map((n) => n.off - n.on), [400, 900]);
});

test("summary counts staccato notes held too long", () => {
  const c = {
    mode: "live", bpm: 72, expectedNotes: 9, correctNotes: 9, wrongNotes: 0, missedNotes: 0, hitSteps: 9,
    earlySteps: 0, lateSteps: 0, missedSteps: 0, offsetSumMs: 0, offsetCount: 0, firstHitAt: null, lastHitAt: null,
    firstHitQ: null, lastHitQ: null, cycles: 0, startedAt: 0, endedAt: 1000, holdChecked: 9, shortNotes: 1, longNotes: 2,
  } as PracticeCounts;
  const row = summaryRows(c, { hands: "Right hand", bars: "All", percent: 100 }).find(([k]) => k === "Held notes");
  assert.deepEqual(row, ["Held notes", "6 of 9 held, 1 short, 2 too long"]);
});
