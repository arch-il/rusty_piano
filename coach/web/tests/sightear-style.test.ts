import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

function body(marker: string): string {
  const start = css.indexOf(marker);
  assert.ok(start >= 0, `missing rule: ${marker}`);
  const end = css.indexOf("}", start);
  return css.slice(start, end);
}

test("sight and ear start buttons are primary", () => {
  assert.ok(html.includes('id="sight-start" class="btn btn-primary"'));
  assert.ok(html.includes('id="ear-start" class="btn btn-primary"'));
});

test("pressed level buttons use the pale accent fill", () => {
  assert.ok(body(".sight-level[aria-pressed='true'] {").includes("var(--color-accent-soft)"));
  assert.ok(body(".ear-level[aria-pressed='true'] {").includes("var(--color-accent-soft)"));
});

test("empty history panels are hidden", () => {
  assert.ok(body(".sight-history:empty {").includes("display: none"));
  assert.ok(body(".ear-history:empty {").includes("display: none"));
});

test("ear settings and categories table have styles", () => {
  assert.ok(css.includes(".ear-settings > summary {"));
  assert.ok(css.includes(".ear-cats th {"));
});

test("sight summary has an accent left edge", () => {
  assert.ok(body(".sight-summary {").includes("border-left: 4px solid"));
});
