import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

const rootStart = css.indexOf(":root {");
const root = css.slice(rootStart, css.indexOf("}", rootStart) + 1);

function token(name: string): string | undefined {
  const start = root.indexOf(name + ":");
  if (start < 0) return undefined;
  const from = start + name.length + 1;
  return root.slice(from, root.indexOf(";", from)).trim();
}

function lum(hex: string): number {
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(1 + i, 3 + i), 16) / 255);
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: string, b: string): number {
  const la = lum(a);
  const lb = lum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function ruleAfter(marker: string): string {
  const start = css.indexOf(marker);
  assert.ok(start >= 0, "marker not found: " + marker);
  return css.slice(start, css.indexOf("}", start) + 1);
}

const HEX = /^#[0-9a-fA-F]{6}$/;

test("new design tokens exist", () => {
  const names = [
    "--color-canvas", "--color-surface", "--color-surface-muted", "--color-track", "--color-border-strong",
    "--color-accent-hover", "--color-accent-soft", "--color-accent-border", "--color-on-accent", "--color-focus",
    "--color-error-soft", "--color-button-active", "--shadow-sm", "--shadow-md", "--shadow-up", "--focus-ring",
    "--font-size-xs", "--font-size-h2", "--font-size-h3", "--font-size-stat", "--line-height", "--control-height",
    "--space-4", "--space-5", "--radius-sm", "--radius-lg", "--radius-pill", "--transition-fast",
  ];
  for (const name of names) assert.notEqual(token(name), undefined, name);
});

test("colour tokens are 6-digit hex", () => {
  const names = [
    "--color-paper", "--color-canvas", "--color-surface", "--color-surface-muted", "--color-track", "--color-ink",
    "--color-muted", "--color-accent", "--color-accent-hover", "--color-accent-soft", "--color-on-accent",
    "--color-error", "--cursor-color", "--color-mark-hit", "--color-mark-timing", "--color-mark-missed",
    "--color-mark-wrong", "--color-mark-short", "--color-mark-uneven", "--color-score-low", "--color-score-mid",
    "--color-score-high", "--color-key-right", "--color-key-left", "--color-key-live",
  ];
  for (const name of names) assert.match(token(name) ?? "", HEX, name);
});

test("mark colours are all different", () => {
  const values = ["--color-mark-hit", "--color-mark-timing", "--color-mark-missed", "--color-mark-wrong", "--color-mark-short"]
    .map((name) => token(name));
  assert.equal(new Set(values).size, 5);
});

test("text and mark colours meet contrast limits on their backgrounds", () => {
  const paper = token("--color-paper") ?? "";
  const canvas = token("--color-canvas") ?? "";
  const track = token("--color-track") ?? "";
  const surface = token("--color-surface") ?? "";
  const accent = token("--color-accent") ?? "";
  const accentSoft = token("--color-accent-soft") ?? "";
  const ink = token("--color-ink") ?? "";
  const muted = token("--color-muted") ?? "";
  assert.ok(contrast(ink, paper) >= 7, "ink on paper");
  assert.ok(contrast(muted, paper) >= 4.5, "muted on paper");
  assert.ok(contrast(muted, canvas) >= 4.5, "muted on canvas");
  assert.ok(contrast(muted, track) >= 4.5, "muted on track");
  assert.ok(contrast(token("--color-on-accent") ?? "", accent) >= 4.5, "on-accent on accent");
  assert.ok(contrast(token("--color-accent-hover") ?? "", accentSoft) >= 4.5, "accent-hover on accent-soft");
  assert.ok(contrast(token("--color-error") ?? "", surface) >= 4.5, "error on surface");
  for (const name of ["--color-mark-hit", "--color-mark-timing", "--color-mark-wrong", "--color-mark-short"]) {
    assert.ok(contrast(token(name) ?? "", paper) >= 3, name + " on paper");
  }
});

test("base control rules are present", () => {
  assert.ok(ruleAfter("[hidden] {").includes("display: none"));
  assert.ok(ruleAfter(".btn:focus-visible {").includes("outline: 2px solid var(--color-focus)"));
  assert.ok(ruleAfter(".btn[aria-pressed='true'] {").includes("var(--color-accent)"));
  for (const selector of [".btn:disabled {", ".btn-primary {", ".btn-ghost {", ".btn-icon {", "a:not(.btn) {"]) {
    assert.ok(css.includes(selector), selector);
  }
  assert.ok(ruleAfter("input[type='number']):focus-visible {").includes("var(--focus-ring)"));
});

test("warm paper palette", () => {
  assert.equal(token("--color-paper"), "#faf6ee");
  assert.equal(token("--color-topbar-bg"), "#efe8da");
  assert.equal(token("--color-sidebar-bg"), "#f4eee2");
  assert.equal(token("--color-ink"), "#2a2622");
  assert.equal(token("--color-accent"), "#2f6fb0");
  assert.equal(token("--cursor-color"), "#2f6fb0");
  assert.ok((token("--shadow") ?? "").includes("rgba(60, 45, 25"));
});
