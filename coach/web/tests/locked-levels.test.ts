import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const view = readFileSync(new URL("../src/sight-view.ts", import.meta.url), "utf8");

const baseRule = /\.sight-level\.locked,\s*\.ear-group\.locked \.ear-level \{([^}]*)\}/;
const pressedRule = /\.sight-level\.locked\[aria-pressed='true'\],\s*\.ear-group\.locked \.ear-level\[aria-pressed='true'\] \{([^}]*)\}/;
const stateRule = /\.sight-level\.locked \.sight-level-state,\s*\.ear-group\.locked \.ear-level-state \{([^}]*)\}/;
const iconRule = /\.sight-level\.locked \.sight-level-state::before,\s*\.ear-group\.locked \.ear-level-state::before \{([^}]*)\}/;

test("locked levels get a dashed paper look", () => {
  const m = css.match(baseRule);
  assert.ok(m, "base locked rule present");
  assert.match(m[1], /border-style: dashed/);
  assert.match(m[1], /var\(--color-paper\)/);
  assert.match(m[1], /var\(--color-muted\)/);
});

test("selected locked levels keep the selected look", () => {
  const m = css.match(pressedRule);
  assert.ok(m, "pressed locked rule present");
  assert.match(m[1], /var\(--color-accent-soft\)/);
  const base = css.match(baseRule);
  assert.ok(base && m.index !== undefined && base.index !== undefined && m.index > base.index, "pressed rule comes after the base rule");
});

test("locked state word is hidden with font-size 0", () => {
  const m = css.match(stateRule);
  assert.ok(m, "state rule present");
  assert.match(m[1], /font-size: var\(--font-size-hidden\)/);
  assert.match(css, /--font-size-hidden: 0;/);
});

test("lock glyph is drawn with a mask", () => {
  const m = css.match(iconRule);
  assert.ok(m, "icon rule present");
  assert.match(m[1], /mask:/);
  assert.match(m[1], /currentColor/);
});

test("old one-line locked rule is gone", () => {
  assert.equal(css.includes(".sight-level.locked {"), false);
});

test("sight-view sets the lock text in the level title", () => {
  assert.match(view, /lockText\(/);
});
