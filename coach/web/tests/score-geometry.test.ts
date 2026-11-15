import test from "node:test";
import assert from "node:assert/strict";
import {
  unionBoxes,
  barRects,
  hitTest,
  clampZoom,
  stepZoom,
  formatZoom,
  needleRect,
  followScrollTop,
  ZOOM_STEPS,
  MIN_ZOOM,
  MAX_ZOOM,
} from "../src/score-geometry.ts";

test("unionBoxes two staves", () => {
  assert.deepEqual(
    unionBoxes([
      { x: 0, y: 0, width: 10, height: 4 },
      { x: 1, y: 6, width: 12, height: 4 },
    ]),
    { x: 0, y: 0, width: 13, height: 10 },
  );
});

test("unionBoxes ignores null and handles empty", () => {
  assert.deepEqual(unionBoxes([null, { x: 1, y: 2, width: 3, height: 4 }, undefined]), {
    x: 1,
    y: 2,
    width: 3,
    height: 4,
  });
  assert.equal(unionBoxes([null, undefined]), null);
  assert.equal(unionBoxes([]), null);
});

test("barRects scales with padding at zoom 1.5", () => {
  const r = barRects([[{ x: 2, y: 3, width: 10, height: 4 }], []], 1.5);
  assert.deepEqual(r[0], { x: 30, y: 30, width: 150, height: 90 });
  assert.equal(r[1], null);
});

test("barRects empty", () => {
  assert.deepEqual(barRects([], 1), []);
});

test("hitTest edges, gaps, empty", () => {
  const rects = [
    { x: 0, y: 0, width: 10, height: 10 },
    { x: 10, y: 0, width: 10, height: 10 },
    null,
    { x: 30, y: 0, width: 10, height: 10 },
  ];
  assert.equal(hitTest(rects, 0, 0), 0);
  assert.equal(hitTest(rects, 10, 5), 1);
  assert.equal(hitTest(rects, 25, 5), -1);
  assert.equal(hitTest(rects, 5, 10), -1);
  assert.equal(hitTest(rects, 35, 5), 3);
  assert.equal(hitTest([], 1, 1), -1);
});

test("zoom helpers", () => {
  assert.equal(stepZoom(1, 1), 1.1);
  assert.equal(stepZoom(1.05, 1), 1.1);
  assert.equal(stepZoom(1.05, -1), 1);
  assert.equal(stepZoom(2, 1), 2);
  assert.equal(stepZoom(0.5, -1), 0.5);
  assert.equal(stepZoom(1, -1), 0.9);
  assert.equal(clampZoom(5), MAX_ZOOM);
  assert.equal(clampZoom(0.1), MIN_ZOOM);
  assert.equal(clampZoom(1.2), 1.2);
  assert.equal(ZOOM_STEPS.length, 10);
  assert.equal(formatZoom(1), "100%");
  assert.equal(formatZoom(0.75), "75%");
  assert.equal(formatZoom(1.1), "110%");
});

test("needleRect", () => {
  assert.deepEqual(needleRect(10, 2, 6, 1.5), { x: 150, y: 15, width: 0, height: 90 });
});

test("followScrollTop", () => {
  assert.equal(followScrollTop(200, 260, 100, 600, 60), null);
  assert.equal(followScrollTop(800, 860, 100, 600, 60), 768);
  assert.equal(followScrollTop(150, 210, 300, 600, 60), 118);
  assert.equal(followScrollTop(10, 70, 300, 600, 60), 0);
  assert.equal(followScrollTop(200, 900, 100, 600, 60), 168);
  assert.equal(followScrollTop(200, 900, 168, 600, 60), null);
});

import { slideX, extendRange } from "../src/score-geometry.ts";

test("slideX interpolates on one line", () => {
  const a = { x: 10, y: 0, width: 0, height: 5 };
  const b = { x: 30, y: 0, width: 0, height: 5 };
  assert.equal(slideX(a, b, 0.5), 20);
  assert.equal(slideX(a, b, -1), 10);
  assert.equal(slideX(a, b, 2), 30);
});

test("slideX stays put on another line, without b, or going backwards", () => {
  const a = { x: 10, y: 0, width: 0, height: 5 };
  assert.equal(slideX(a, { x: 30, y: 50, width: 0, height: 5 }, 0.5), 10);
  assert.equal(slideX(a, null, 0.5), 10);
  assert.equal(slideX(a, { x: 5, y: 0, width: 0, height: 5 }, 0.5), 10);
});

test("extendRange orders the ends", () => {
  assert.deepEqual(extendRange(5, 3), { from: 3, to: 5 });
  assert.deepEqual(extendRange(3, 5), { from: 3, to: 5 });
});
