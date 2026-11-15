import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { barRuns, buildTimeline, measureBpms, measureQuarters, midiFromHalfTone, noteQuarters, sheetInfo, tempoSummary, timelineSummary } from "../src/score-timeline.ts";
import type { MeasureLike, SheetLike } from "../src/score-timeline.ts";
import { fakeSheetFromMusicXml } from "./helpers/fake-osmd-sheet.ts";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

function note(halfTone: number, extra: Record<string, unknown> = {}) {
  return { halfTone, isRest: () => false, NoteTie: undefined, IsGraceNote: false, IsCueNote: false, PrintObject: true, ...extra };
}

function restNote() {
  return { halfTone: 0, isRest: () => true, NoteTie: undefined, IsGraceNote: false, IsCueNote: false, PrintObject: true };
}

function voice(notes: unknown[], IsGrace = false) {
  return { IsGrace, Notes: notes };
}

function staff(...voices: unknown[]) {
  return { VoiceEntries: voices };
}

function container(beat: number, staffEntries: unknown[]) {
  return { Timestamp: { RealValue: beat / 4 }, StaffEntries: staffEntries };
}

function sheetOf(containers: unknown[]): SheetLike {
  return { SourceMeasures: [{ AbsoluteTimestamp: { RealValue: 0 }, VerticalSourceStaffEntryContainers: containers }] } as unknown as SheetLike;
}

test("simple C major gives one step per quarter", () => {
  const steps = buildTimeline(fakeSheetFromMusicXml(read("../../tests/fixtures/simple_c_major.musicxml")));
  assert.equal(timelineSummary(steps), "1/0=60 1/1=62 1/2=64 1/3=65 2/0=67 2/1=69 2/2=71 2/3=72");
  assert.deepEqual(steps.map((s) => s.time), [0, 1, 2, 3, 4, 5, 6, 7]);
  for (const s of steps) assert.deepEqual(s.staves, [0]);
});

test("two hands E minor splits staves and chords", () => {
  const steps = buildTimeline(fakeSheetFromMusicXml(read("../../tests/fixtures/two_hands_e_minor.musicxml")));
  assert.equal(timelineSummary(steps), "1/0=52+64 1/1=66 1/2=67 2/0=52+71+76");
  assert.deepEqual(steps[0].staves, [0, 1]);
  assert.equal(steps[3].notes.length, 3);
});

test("follower cases in written order: ties, grace, chords, two staves", () => {
  const steps = buildTimeline(fakeSheetFromMusicXml(read("./fixtures/follower_cases.musicxml")), { followRepeats: false });
  assert.equal(
    timelineSummary(steps),
    "1/0=60+64 1/2=64+67 1/3=67 2/0=60+69 2/1=69 2/2=71 3/0=62 3/2=62 4/0=60+72",
  );
  assert.deepEqual(steps.map((s) => s.time), [0, 2, 3, 4, 5, 6, 8, 10, 12]);
  assert.deepEqual(steps[0].staves, [0, 1]);
  assert.ok(steps.every((s) => !s.pitches.includes(65)));
  assert.deepEqual(steps[6].staves, [1]);
  assert.deepEqual(steps[7].staves, [1]);
  assert.equal(steps.length, 9);
});

test("follower demo matches the engine demo notes", () => {
  const steps = buildTimeline(fakeSheetFromMusicXml(read("./fixtures/follower_demo.musicxml")));
  assert.equal(
    timelineSummary(steps),
    "1/0=60 1/1=64 1/2=67 1/3=72 2/0=48+60+64+67 3/0=72 3/1=76 3/2=79 3/3=84",
  );
});

test("follower scale has 64 steps", () => {
  const steps = buildTimeline(fakeSheetFromMusicXml(read("./fixtures/follower_scale.musicxml")));
  assert.equal(steps.length, 64);
  assert.equal(timelineSummary(steps.slice(0, 1)), "1/0=60");
  const last = steps[steps.length - 1];
  assert.equal(last.bar, 16);
  assert.equal(last.beat, 3);
  assert.deepEqual(last.pitches, [72]);
});

test("tie continuation is skipped but the start note is kept", () => {
  const start: Record<string, unknown> = note(48);
  start.NoteTie = { StartNote: start };
  const cont = note(48, { NoteTie: { StartNote: start } });
  const steps = buildTimeline(sheetOf([container(0, [staff(voice([start]))]), container(2, [staff(voice([cont]))])]));
  assert.equal(steps.length, 1);
  assert.equal(steps[0].notes[0].ref, start);
});

test("rest-only container gives no step", () => {
  const steps = buildTimeline(sheetOf([container(0, [staff(voice([restNote()]))]), container(1, [staff(voice([note(48)]))])]));
  assert.equal(timelineSummary(steps), "1/1=60");
});

test("grace voice entries are skipped", () => {
  const steps = buildTimeline(sheetOf([container(0, [staff(voice([note(53)], true), voice([note(57)]))])]));
  assert.deepEqual(steps[0].pitches, [69]);
});

test("grace, cue and non-printed notes are skipped", () => {
  const steps = buildTimeline(
    sheetOf([
      container(0, [
        staff(voice([note(48, { IsGraceNote: true }), note(50, { IsCueNote: true }), note(52, { PrintObject: false }), note(55)])),
      ]),
    ]),
  );
  assert.deepEqual(steps[0].pitches, [67]);
  assert.equal(steps[0].notes.length, 1);
});

test("same pitch on two staves gives one pitch and two notes", () => {
  const steps = buildTimeline(sheetOf([container(0, [staff(voice([note(48)])), staff(voice([note(48)]))])]));
  assert.deepEqual(steps[0].pitches, [60]);
  assert.equal(steps[0].notes.length, 2);
  assert.deepEqual(steps[0].staves, [0, 1]);
});

test("containers given out of order come out sorted without mutating input", () => {
  const late = container(2, [staff(voice([note(52)]))]);
  const early = container(0, [staff(voice([note(48)]))]);
  const input = [late, early];
  const steps = buildTimeline(sheetOf(input));
  assert.equal(timelineSummary(steps), "1/0=60 1/2=64");
  assert.equal(input[0], late);
});

test("empty sheet gives no steps", () => {
  assert.deepEqual(buildTimeline({ SourceMeasures: [] }), []);
});

test("midiFromHalfTone adds 12 and indexes are 0..n-1", () => {
  assert.equal(midiFromHalfTone(48), 60);
  const steps = buildTimeline(fakeSheetFromMusicXml(read("./fixtures/follower_cases.musicxml")));
  assert.deepEqual(steps.map((s) => s.index), steps.map((_, i) => i));
});

test("follower cases with repeats unroll the repeat", () => {
  const steps = buildTimeline(fakeSheetFromMusicXml(read("./fixtures/follower_cases.musicxml")));
  const first = "1/0=60+64 1/2=64+67 1/3=67 2/0=60+69 2/1=69 2/2=71 3/0=62 3/2=62";
  assert.equal(timelineSummary(steps), `${first} ${first} 4/0=60+72`);
  assert.equal(steps.length, 17);
  assert.deepEqual(steps.map((s) => s.time), [0, 2, 3, 4, 5, 6, 8, 10, 12, 14, 15, 16, 17, 18, 20, 22, 24]);
  assert.deepEqual(steps.map((s) => s.written), [0, 1, 2, 3, 4, 5, 6, 7, 0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(steps.map((s) => s.pass), [1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 1]);
  assert.equal(steps[8].notes[0].ref, steps[0].notes[0].ref);
});

test("repeats fixture unrolls with endings and back jumps", () => {
  const sheet = fakeSheetFromMusicXml(read("./fixtures/follower_repeats.musicxml"));
  const steps = buildTimeline(sheet);
  assert.equal(
    timelineSummary(steps),
    "1/0=60 1/1=62 1/2=64 1/3=65 2/0=67 2/1=65 2/2=64 2/3=62 1/0=60 1/1=62 1/2=64 1/3=65 3/0=64 3/1=62 3/2=60 4/0=67 4/1=69 4/2=71 4/3=72 5/0=72 5/1=71 5/2=69 5/3=67 4/0=67 4/1=69 4/2=71 4/3=72 5/0=72 5/1=71 5/2=69 5/3=67 6/0=60",
  );
  assert.equal(steps.length, 32);
  assert.deepEqual(steps.map((s) => s.time), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32]);
  assert.equal(barRuns(steps), "1-2 1 3-5 4-5 6");
  const written = buildTimeline(sheet, { followRepeats: false });
  assert.equal(
    timelineSummary(written),
    "1/0=60 1/1=62 1/2=64 1/3=65 2/0=67 2/1=65 2/2=64 2/3=62 3/0=64 3/1=62 3/2=60 4/0=67 4/1=69 4/2=71 4/3=72 5/0=72 5/1=71 5/2=69 5/3=67 6/0=60",
  );
  assert.equal(written.length, 20);
  assert.equal(barRuns(written), "1-6");
});

test("octave shift keeps sounding pitches", () => {
  const steps = buildTimeline(fakeSheetFromMusicXml(read("./fixtures/follower_octave.musicxml")));
  assert.equal(timelineSummary(steps), "1/0=72 1/1=74 1/2=84 1/3=88 2/0=91 2/1=96 2/2=72 3/0=48 3/1=52 3/2=60");
});

test("sheetInfo reads tempo, meter and unsupported jumps", () => {
  assert.deepEqual(sheetInfo(fakeSheetFromMusicXml(read("./fixtures/follower_repeats.musicxml"))), {
    tempoBpm: 100,
    beats: 4,
    beatType: 4,
    jumps: [],
  });
  assert.equal(sheetInfo(fakeSheetFromMusicXml(read("./fixtures/follower_cases.musicxml"))).tempoBpm, null);
  const minor = sheetInfo(fakeSheetFromMusicXml(read("../../tests/fixtures/two_hands_e_minor.musicxml")));
  assert.equal(minor.tempoBpm, 60);
  assert.equal(minor.beats, 3);
  const bare = (o: Partial<MeasureLike>): MeasureLike => ({
    AbsoluteTimestamp: { RealValue: 0 },
    VerticalSourceStaffEntryContainers: [],
    ...o,
  });
  const sheet: SheetLike = {
    SourceMeasures: [bare({ LastRepetitionInstructions: [{ type: 4 }] }), bare({ FirstRepetitionInstructions: [{ type: 13 }] })],
  };
  assert.deepEqual(sheetInfo(sheet).jumps, ["D.C.", "Segno"]);
});

const SUMMARY_8 = "1/0=60 1/1=62 1/2=64 1/3=65 2/0=67 2/1=65 2/2=64 2/3=62";

test("follower_dc_fine plays D.C. al Fine", () => {
  const sheet = fakeSheetFromMusicXml(read("./fixtures/follower_dc_fine.musicxml"));
  const steps = buildTimeline(sheet);
  assert.equal(steps.length, 32);
  assert.equal(barRuns(steps), "1-2 1-2 3-4 1-2");
  assert.deepEqual(steps.map((s) => s.time), Array.from({ length: 32 }, (_, i) => i));
  assert.deepEqual(steps.filter((s) => s.bar === 1).map((s) => s.pass), [1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3]);
  const summary = timelineSummary(steps);
  assert.ok(summary.startsWith(SUMMARY_8));
  assert.ok(summary.endsWith(SUMMARY_8));
  const again = buildTimeline(sheet, { repeatsAfterJump: true });
  assert.equal(again.length, 40);
  assert.equal(barRuns(again), "1-2 1-2 3-4 1-2 1-2");
  const noJumps = buildTimeline(sheet, { followJumps: false });
  assert.equal(noJumps.length, 24);
  assert.equal(barRuns(noJumps), "1-2 1-2 3-4");
  const written = buildTimeline(sheet, { followRepeats: false });
  assert.equal(written.length, 16);
  assert.equal(barRuns(written), "1-4");
  assert.deepEqual(sheetInfo(sheet).jumps, ["Fine", "D.C. al Fine"]);
});

test("follower_ds_coda plays D.S. al Coda", () => {
  const sheet = fakeSheetFromMusicXml(read("./fixtures/follower_ds_coda.musicxml"));
  const steps = buildTimeline(sheet);
  assert.equal(steps.length, 32);
  assert.equal(barRuns(steps), "1-4 2-3 5-6");
  const noJumps = buildTimeline(sheet, { followJumps: false });
  assert.equal(noJumps.length, 24);
  assert.equal(barRuns(noJumps), "1-6");
  assert.deepEqual(sheetInfo(sheet).jumps, ["Segno", "To Coda", "D.S. al Coda", "Coda"]);
});

test("measureQuarters falls back from Duration to timestamps to meter to 4", () => {
  const at = (t: number, o: Partial<MeasureLike> = {}): MeasureLike => ({
    AbsoluteTimestamp: { RealValue: t },
    VerticalSourceStaffEntryContainers: [],
    ...o,
  });
  assert.equal(measureQuarters([at(0, { Duration: { RealValue: 0.75 } }), at(1)], 0), 3);
  assert.equal(measureQuarters([at(0), at(0.5)], 0), 2);
  assert.equal(measureQuarters([at(0, { ActiveTimeSignature: { Numerator: 6, Denominator: 8 } })], 0), 3);
  assert.equal(measureQuarters([at(0)], 0), 4);
});

test("follower_tempo carries a bpm per step", () => {
  const sheet = fakeSheetFromMusicXml(read("./fixtures/follower_tempo.musicxml"));
  const steps = buildTimeline(sheet);
  assert.equal(steps.length, 16);
  assert.deepEqual(steps.map((s) => s.bpm), [...Array(8).fill(120), ...Array(8).fill(60)]);
  assert.equal(tempoSummary(steps), "1:120 3:60");
  const flat = buildTimeline(sheet, { followTempo: false });
  assert.ok(flat.every((s) => s.bpm === 120));
  assert.equal(tempoSummary(flat), "1:120");
  assert.equal(sheetInfo(sheet).tempoBpm, 120);
});

test("follower_holds gives note lengths in quarters", () => {
  const steps = buildTimeline(fakeSheetFromMusicXml(read("./fixtures/follower_holds.musicxml")));
  assert.equal(timelineSummary(steps), "1/0=60 1/2=64 2/0=67 3/0=60 3/1=62 3/2=64 4/2=67");
  assert.deepEqual(steps.map((s) => s.notes[0].quarters), [2, 2, 4, 1, 1, 4, 2]);
  assert.ok(steps.every((s) => s.bpm === 60));
});

test("follower_cases without a tempo uses the fallback bpm", () => {
  const sheet = fakeSheetFromMusicXml(read("./fixtures/follower_cases.musicxml"));
  assert.ok(buildTimeline(sheet).every((s) => s.bpm === 80));
  assert.ok(buildTimeline(sheet, { fallbackBpm: 70 }).every((s) => s.bpm === 70));
});

test("measureBpms carries the last valid tempo forward", () => {
  const sheet = (has: boolean) =>
    ({
      HasBPMInfo: has,
      SourceMeasures: [100, undefined, 0, 72, 500].map((t) => ({ TempoInBPM: t })),
    }) as unknown as SheetLike;
  assert.deepEqual(measureBpms(sheet(true), 80, true), [100, 100, 100, 72, 72]);
  assert.deepEqual(measureBpms(sheet(true), 80, false), [100, 100, 100, 100, 100]);
  assert.deepEqual(measureBpms(sheet(false), 80, true), [80, 80, 80, 80, 80]);
});

test("noteQuarters reads Length, tie duration or zero", () => {
  assert.equal(noteQuarters(note(60, { Length: { RealValue: 0.25 } }) as never), 1);
  const tied = note(60, { Length: { RealValue: 0.25 } }) as Record<string, unknown>;
  tied.NoteTie = { StartNote: tied, Duration: { RealValue: 0.75 } };
  assert.equal(noteQuarters(tied as never), 3);
  assert.equal(noteQuarters(note(60) as never), 0);
});
