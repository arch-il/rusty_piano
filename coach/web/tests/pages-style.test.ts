import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

function body(marker: string): string {
  const start = css.indexOf(marker);
  assert.ok(start >= 0, `missing rule: ${marker}`);
  const end = css.indexOf("}", start);
  return css.slice(start, end);
}

test("page views sit on the canvas colour", () => {
  for (const marker of [".skills-view {", ".log-view {", ".sight-view {", ".ear-view {"]) {
    assert.ok(body(marker).includes("var(--color-canvas)"), marker);
  }
});

test("page headers are sticky", () => {
  for (const marker of [".skills-head {", ".log-head {", ".sight-head {", ".ear-head {"]) {
    assert.ok(body(marker).includes("position: sticky"), marker);
  }
});

test("skill boxes highlight on hover", () => {
  assert.ok(css.includes(".skill-node:hover .skill-box {"));
});

test("log stat tiles are rounded cards", () => {
  assert.ok(body(".log-stat {").includes("var(--radius-lg)"));
});

test("skills drill buttons lay out as flex", () => {
  assert.ok(body(".skills-drill {").includes("display: flex"));
});
