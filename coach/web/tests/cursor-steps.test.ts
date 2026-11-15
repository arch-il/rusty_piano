import test from "node:test";
import assert from "node:assert/strict";
import { stepBack, stepForward } from "../src/cursor-steps.ts";

function fake(start: number, n = 3) {
  const c = {
    index: start,
    Iterator: { FrontReached: false, EndReached: false },
    previous() {
      if (c.index === 0) {
        c.Iterator.FrontReached = true;
        c.index = -1;
      } else {
        c.index -= 1;
        c.Iterator.EndReached = false;
      }
    },
    next() {
      c.index += 1;
      if (c.index >= n) c.Iterator.EndReached = true;
      c.Iterator.FrontReached = false;
    },
    reset() {
      c.index = 0;
      c.Iterator.FrontReached = false;
      c.Iterator.EndReached = false;
    },
  };
  return c;
}

test("stepBack at first note stays at 0", () => {
  const c = fake(0);
  stepBack(c);
  assert.equal(c.index, 0);
  assert.equal(c.Iterator.FrontReached, false);
});

test("stepBack from 2 gives 1", () => {
  const c = fake(2);
  stepBack(c);
  assert.equal(c.index, 1);
});

test("stepForward at last note stays at n-1", () => {
  const c = fake(2);
  stepForward(c);
  assert.equal(c.index, 2);
  assert.equal(c.Iterator.EndReached, false);
});

test("stepForward from 0 gives 1", () => {
  const c = fake(0);
  stepForward(c);
  assert.equal(c.index, 1);
});

test("old rule leaves the cursor before the start (documents the bug)", () => {
  const c = fake(0);
  if (!c.Iterator.FrontReached) c.previous();
  assert.equal(c.index, -1);
});
