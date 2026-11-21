import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { medianGaps, scaleEvenness, shownWeakSpots, unevenTitle } from "../src/evenness.ts";
import type { EvennessInput } from "../src/evenness.ts";

const onsets = [0, 500, 1000, 1500, 2000, 5000, 5500, 6000, 6500];
const input: EvennessInput = {
  score_id: "scales:c-major-1oct-rh",
  hands: "right",
  steps: onsets.map((t, i) => ({ cycle: 1, step: i, source_step: i, bar: 1 + Math.floor(i / 4), time_q: i, expected: [60 + i], played: [{ note: 60 + i, page_ms: t }] })),
};

test("medianGaps gives each hand's median gap", () => {
  assert.deepEqual(medianGaps(input), { right: 500, left: null });
  assert.deepEqual(medianGaps({ ...input, steps: input.steps.slice(0, 3) }), { right: null, left: null });
});

test("one long gap no longer marks the normal gaps", () => {
  const ev = scaleEvenness(input);
  assert.equal(ev.weak_spots.length, 5);
  const shown = shownWeakSpots(ev, medianGaps(input));
  assert.deepEqual(shown.map((w) => w.step), [5]);
  assert.equal(shown[0].gap_ms, 3000);
  assert.equal(shownWeakSpots(ev, { right: null, left: null }).length, 5);
});

test("unevenTitle compares with the median", () => {
  const w = shownWeakSpots(scaleEvenness(input), medianGaps(input))[0];
  assert.equal(unevenTitle(w, 500), "Uneven: the gap before this note was 500% longer than your usual gap (right hand)");
  assert.equal(unevenTitle({ ...w, gap_ms: 300 }, 500), "Uneven: the gap before this note was 40% shorter than your usual gap (right hand)");
  assert.ok(unevenTitle(w).startsWith("Uneven: the gap before this note was 269% longer than average"));
});

test("main.ts marks only the shown spots with the median text", () => {
  const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  for (const s of ["medianGaps(", "shownWeakSpots(", "unevenTitle(w, gaps[w.hand])", "hand: w.hand", "weak_spots: shown"]) assert.ok(main.includes(s), s);
});
