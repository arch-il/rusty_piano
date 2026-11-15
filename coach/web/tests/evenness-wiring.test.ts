import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createMarks } from "../src/feedback-overlay.ts";

const read = (p: string): string => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
const main = read("../src/main.ts");
const scoreView = read("../src/score-view.ts");
const css = read("../src/styles.css");

test("marks keep uneven spots", () => {
  const m = createMarks();
  m.setUneven(3, "x");
  m.setUneven(1, "y");
  assert.deepStrictEqual(m.unevens(), [
    [1, "y"],
    [3, "x"],
  ]);
  m.setUneven(3, null);
  assert.deepStrictEqual(m.unevens(), [[1, "y"]]);
  m.clear();
  assert.deepStrictEqual(m.unevens(), []);
});

test("main.ts wires evenness", () => {
  assert.ok(main.includes('from "./evenness"'));
  assert.ok(main.includes("attachEvenness("));
  assert.ok(main.includes("evennessRows(lastEvenness)"));
  assert.ok(main.includes("view.markUneven("));
  assert.ok(main.includes("lastEvenness = null"));
});

test("showSummaryNow adds the evenness rows", () => {
  const start = main.indexOf("function showSummaryNow(");
  assert.ok(start >= 0);
  const end = main.indexOf("\n}\n", start);
  assert.ok(main.slice(start, end).includes("evennessRows(lastEvenness)"));
});

test("score view draws uneven marks", () => {
  assert.ok(scoreView.includes("markUneven("));
  assert.ok(scoreView.includes('"uneven-marker"'));
});

test("styles define the uneven colour and marker", () => {
  const root = css.match(/:root\s*\{[^}]*\}/)?.[0] ?? "";
  assert.match(root, /--color-mark-uneven:\s*#[0-9a-fA-F]{6}\s*;/);
  assert.ok(css.includes(".uneven-marker {"));
});
