import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  EVENNESS_CONSTANTS,
  attachEvenness,
  evennessRows,
  evennessScore,
  alignmentScore,
  isScaleScore,
  scaleEvenness,
  unevenTitle,
} from "../src/evenness.ts";
import type { AttemptWithEvenness, Evenness, EvennessConstants, EvennessInput } from "../src/evenness.ts";

type Case = { name: string; input: EvennessInput; expected: Evenness };

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/evenness-cases.json", import.meta.url)), "utf8"),
) as { constants: EvennessConstants; cases: Case[] };

function caseNamed(name: string): Case {
  const c = fixture.cases.find((x) => x.name === name);
  if (!c) throw new Error("no fixture case " + name);
  return c;
}

test("fixture cases", () => {
  for (const c of fixture.cases) assert.deepStrictEqual(scaleEvenness(c.input), c.expected, c.name);
});

test("constants match the fixture", () => {
  assert.deepStrictEqual({ ...EVENNESS_CONSTANTS }, fixture.constants);
});

test("isScaleScore", () => {
  assert.equal(isScaleScore("scales:c-major-1oct-rh"), true);
  assert.equal(isScaleScore("gen:k1-c5-rh"), false);
  assert.equal(isScaleScore("local:abc"), false);
});

test("score curves", () => {
  assert.equal(evennessScore(0), 100);
  assert.equal(evennessScore(0.03), 100);
  assert.equal(evennessScore(0.14), 50);
  assert.equal(evennessScore(0.25), 0);
  assert.equal(evennessScore(0.5), 0);
  assert.equal(alignmentScore(0), 100);
  assert.equal(alignmentScore(15), 100);
  assert.equal(alignmentScore(67.5), 50);
  assert.equal(alignmentScore(120), 0);
  assert.equal(alignmentScore(300), 0);
});

test("summary rows", () => {
  assert.deepStrictEqual(evennessRows(scaleEvenness(caseNamed("one late note").input)), [
    ["Evenness", "9 of 100"],
    ["Uneven spots", "bars 1, 2"],
  ]);
  assert.deepStrictEqual(evennessRows(scaleEvenness(caseNamed("hands together").input)), [
    ["Evenness", "90 of 100"],
    ["Evenness R / L", "100 / 80"],
    ["Hands together", "96 of 100, 14 ms apart"],
  ]);
  assert.deepStrictEqual(evennessRows(scaleEvenness(caseNamed("too few notes").input)), [
    ["Evenness", "- (too few notes)"],
  ]);
  assert.deepStrictEqual(
    evennessRows(scaleEvenness(caseNamed("hands together score, right hand only").input)),
    [["Evenness", "76 of 100"]],
  );
});

test("uneven titles", () => {
  const e = scaleEvenness(caseNamed("one late note").input);
  assert.equal(
    unevenTitle(e.weak_spots[0]),
    "Uneven: the gap before this note was 40% longer than average (right hand)",
  );
  assert.equal(
    unevenTitle(e.weak_spots[1]),
    "Uneven: the gap before this note was 40% shorter than average (right hand)",
  );
});

test("attachEvenness", () => {
  const attempt = {
    score: { id: "scales:c-major-1oct-rh" },
    practice: { hands: "right" },
    steps: caseNamed("even right hand").input.steps,
    summary: { rows: [] },
  } as unknown as AttemptWithEvenness;
  const ev = attachEvenness(attempt);
  assert.equal(attempt.evenness?.combined, 100);
  assert.equal(ev, attempt.evenness);
  assert.deepStrictEqual(attempt.summary.rows, [["Evenness", "100 of 100"]]);

  const other = {
    score: { id: "gen:k1-c5-rh" },
    practice: { hands: "right" },
    steps: caseNamed("even right hand").input.steps,
    summary: { rows: [] },
  } as unknown as AttemptWithEvenness;
  assert.equal(attachEvenness(other), null);
  assert.equal("evenness" in other, false);
  assert.deepStrictEqual(other.summary.rows, []);
});

test("no steps", () => {
  const e = scaleEvenness({ score_id: "scales:c-major-1oct-rh", hands: "both", steps: [] });
  assert.equal(e.right, null);
  assert.equal(e.left, null);
  assert.equal(e.combined, null);
  assert.equal(e.alignment, null);
  assert.deepStrictEqual(e.weak_spots, []);
  assert.deepStrictEqual(evennessRows(e), [["Evenness", "- (too few notes)"]]);
});
