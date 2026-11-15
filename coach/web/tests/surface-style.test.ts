import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

function body(marker: string): string {
  const start = css.indexOf(marker);
  assert.ok(start >= 0, `missing ${marker}`);
  const end = css.indexOf("}", start);
  return css.slice(start, end);
}

test("summary again button is the primary button", () => {
  assert.ok(html.includes('id="summary-again" class="btn btn-primary"'));
});

test("toast sits above the piano strip with an error accent", () => {
  const rule = body(".toast {");
  assert.ok(rule.includes("border-left: 4px solid var(--color-error)"));
  assert.ok(rule.includes("var(--piano-height)"));
});

test("piano strip has a surface and an upward shadow", () => {
  const rule = body(".piano-view {");
  assert.ok(rule.includes("var(--shadow-up)"));
  assert.ok(rule.includes("var(--color-surface-muted)"));
});

test("summary actions have a divider", () => {
  assert.ok(body(".summary-actions {").includes("border-top"));
});

test("replay bar is pill shaped", () => {
  assert.ok(body(".replay-bar {").includes("var(--radius-pill)"));
});

test("summary title and score message heading have rules", () => {
  assert.ok(css.includes(".summary-title {"));
  assert.ok(css.includes(".score-message h2 {"));
});

test("white keys have rounded bottoms", () => {
  assert.ok(body(".piano-key.white {").includes("border-radius"));
});

test("white key rule comes before the lit rules", () => {
  assert.ok(css.indexOf(".piano-key.white {") < css.indexOf(".piano-key.lit-right {"));
});
