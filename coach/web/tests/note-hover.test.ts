import { test } from "node:test";
import assert from "node:assert/strict";
import { columnCells, pickCell, type Column } from "../src/note-hover.ts";

function col(key: string, x: number, o: Partial<Column> = {}): Column {
  return { key, x, top: 0, height: 100, barLeft: 0, barRight: 100, right: [60], left: [], ...o };
}

test("cells split at midpoints and reach the bar edges", () => {
  const cells = columnCells([col("b", 60), col("a", 20), col("c", 80)]);
  const boxes = cells.map((c) => [c.col.key, c.box.x, c.box.x + c.box.width]);
  assert.deepEqual(boxes, [
    ["a", 0, 40],
    ["b", 40, 70],
    ["c", 70, 100],
  ]);
  assert.equal(cells[0].box.height, 100);
});

test("separate bars and systems do not merge", () => {
  const cells = columnCells([
    col("a", 20),
    col("b", 150, { barLeft: 100, barRight: 200 }),
    col("c", 20, { top: 200 }),
  ]);
  assert.equal(cells.length, 3);
  assert.equal(cells[0].box.width, 100);
  assert.equal(cells[1].box.x, 100);
  assert.equal(cells[1].box.width, 100);
  assert.equal(cells[2].box.y, 200);
});

test("pickCell finds inside, null outside, boundary goes right", () => {
  const cells = columnCells([col("a", 20), col("b", 60)]);
  assert.equal(pickCell(cells, 10, 50)?.col.key, "a");
  assert.equal(pickCell(cells, 90, 50)?.col.key, "b");
  assert.equal(pickCell(cells, 40, 50)?.col.key, "b");
  assert.equal(pickCell(cells, 50, 100), null);
  assert.equal(pickCell(cells, 150, 50), null);
});
