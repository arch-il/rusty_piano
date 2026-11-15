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

test("sidebar is closed without a shadow and open with one", () => {
  const closed = body(".sidebar {");
  assert.ok(closed.includes("box-shadow: none"));
  assert.ok(closed.includes("z-index: 39"));
  assert.ok(body(".sidebar.open {").includes("var(--shadow)"));
});

test("current library row is tinted with the accent", () => {
  assert.ok(body(".library-item.current {").includes("var(--color-accent"));
});

test("empty difficulty pill is hidden", () => {
  assert.ok(body(".item-difficulty:empty {").includes("display: none"));
});

test("active library tab is a white surface", () => {
  assert.ok(body(".library-tabs .active {").includes("var(--color-surface)"));
});
