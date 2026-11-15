import { test } from "node:test";
import assert from "node:assert/strict";
import { createHoldChecker } from "../src/hold-checker.ts";

const opts = { minPercent: 50, minNoteMs: 500, pedal: true };

test("short release", () => {
  const h = createHoldChecker(opts);
  h.press(60, 0, 2, 1, 1000);
  assert.deepEqual(h.release(60, 300), {
    step: 2,
    cycle: 1,
    note: 60,
    heldMs: 300,
    expectedMs: 1000,
    short: true,
    long: false,
  });
});

test("long enough release", () => {
  const h = createHoldChecker(opts);
  h.press(60, 0, 2, 1, 1000);
  assert.equal(h.release(60, 500)?.short, false);
});

test("no press or second release gives null", () => {
  const h = createHoldChecker(opts);
  assert.equal(h.release(60, 10), null);
  h.press(60, 0, 0, 0, 1000);
  h.release(60, 10);
  assert.equal(h.release(60, 20), null);
});

test("too short or zero expected is ignored", () => {
  const h = createHoldChecker(opts);
  h.press(60, 0, 0, 0, 400);
  assert.equal(h.release(60, 10), null);
  h.press(60, 0, 0, 0, 0);
  assert.equal(h.release(60, 10), null);
});

test("pedal suppresses short", () => {
  const h = createHoldChecker(opts);
  h.sustain(true);
  h.press(60, 0, 0, 0, 1000);
  assert.equal(h.release(60, 100)?.short, false);
  const n = createHoldChecker({ ...opts, pedal: false });
  n.sustain(true);
  n.press(60, 0, 0, 0, 1000);
  assert.equal(n.release(60, 100)?.short, true);
});

test("press replaces and clear empties", () => {
  const h = createHoldChecker(opts);
  h.press(60, 0, 1, 0, 1000);
  h.press(60, 50, 2, 0, 1000);
  assert.equal(h.release(60, 100)?.step, 2);
  h.press(60, 0, 3, 0, 1000);
  h.clear();
  assert.equal(h.release(60, 100), null);
});
