import { test } from "node:test";
import assert from "node:assert/strict";
import { createMarks, MARK_VARS, SHORT_VAR } from "../src/feedback-overlay.ts";

test("short marks", () => {
  const m = createMarks();
  m.setShort(3, true);
  m.setShort(1, true);
  assert.deepEqual(m.shorts(), [1, 3]);
  m.setShort(3, false);
  assert.deepEqual(m.shorts(), [1]);
  m.clear();
  assert.deepEqual(m.shorts(), []);
  assert.equal(SHORT_VAR, "--color-mark-short");
});

test("set, replace and remove an outcome", () => {
  const m = createMarks();
  assert.equal(m.outcome(1), null);
  m.setOutcome(1, "hit");
  assert.equal(m.outcome(1), "hit");
  m.setOutcome(1, "late");
  assert.equal(m.outcome(1), "late");
  m.setOutcome(1, null);
  assert.equal(m.outcome(1), null);
  assert.deepEqual(m.outcomes(), []);
});

test("outcomes and wrongs are in ascending step order", () => {
  const m = createMarks();
  m.setOutcome(5, "hit");
  m.setOutcome(2, "missed");
  m.setWrong(9, 1);
  m.setWrong(3, 2);
  assert.deepEqual(m.outcomes(), [[2, "missed"], [5, "hit"]]);
  assert.deepEqual(m.wrongs(), [[3, 2], [9, 1]]);
});

test("wrong counts replace and zero removes", () => {
  const m = createMarks();
  m.setWrong(4, 1);
  m.setWrong(4, 3);
  assert.deepEqual(m.wrongs(), [[4, 3]]);
  m.setWrong(4, 0);
  assert.deepEqual(m.wrongs(), []);
});

test("clear removes everything", () => {
  const m = createMarks();
  m.setOutcome(1, "hit");
  m.setWrong(1, 2);
  m.clear();
  assert.deepEqual(m.outcomes(), []);
  assert.deepEqual(m.wrongs(), []);
});

test("MARK_VARS covers all four outcomes", () => {
  assert.deepEqual(Object.keys(MARK_VARS).sort(), ["early", "hit", "late", "missed"]);
  for (const v of Object.values(MARK_VARS)) assert.match(v, /^--color-mark-/);
});

import { latestByKey } from "../src/feedback-overlay.ts";

test("latestByKey keeps the later step per key", () => {
  const r = latestByKey<string>([[1, "a"], [4, "b"], [7, "c"]], (s) => (s === 7 ? "y" : "x"));
  assert.deepEqual(r, [[4, "b"], [7, "c"]]);
});

test("latestByKey never merges null keys", () => {
  const r = latestByKey<string>([[3, "a"], [1, "b"]], () => null);
  assert.deepEqual(r, [[1, "b"], [3, "a"]]);
});
