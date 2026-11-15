import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (p: string): string => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
const css = read("../src/styles.css");
const html = read("../index.html");

const VARS = [
  "--color-paper", "--color-ink", "--color-muted", "--color-border", "--color-accent", "--color-error",
  "--color-topbar-bg", "--color-sidebar-bg", "--color-button-bg", "--color-button-hover",
  "--color-bar-highlight", "--cursor-color", "--shadow", "--font-ui", "--font-mono",
  "--font-size-ui", "--font-size-small", "--font-size-title", "--topbar-height",
  "--sidebar-width", "--space-1", "--space-2", "--space-3", "--radius", "--sidebar-transition",
  "--color-engine-on", "--color-engine-off", "--color-engine-connecting", "--engine-dot-size", "--engine-pulse", "--color-needle", "--needle-width",
  "--color-mark-hit", "--color-mark-timing", "--color-mark-missed", "--color-mark-wrong", "--color-mark-short", "--mark-size", "--needle-flash",
];

const rootMatches = css.match(/:root\s*\{[^}]*\}/g) ?? [];
const rootBlock = rootMatches[0] ?? "";
const rest = css.replace(/:root\s*\{[^}]*\}/g, "");

test("exactly one :root block defining all variables", () => {
  assert.equal(rootMatches.length, 1);
  for (const v of VARS) assert.ok(rootBlock.includes(v + ":"), v);
});

test("--cursor-color is a 6-digit hex", () => {
  assert.match(rootBlock, /--cursor-color:\s*#[0-9a-fA-F]{6}\s*;/);
});

test("mark colours are 6-digit hex", () => {
  for (const v of ["hit", "timing", "missed", "wrong", "short"]) {
    assert.match(rootBlock, new RegExp("--color-mark-" + v + ":\\s*#[0-9a-fA-F]{6}\\s*;"), v);
  }
});

test("no literal colours, fonts or sizes outside :root", () => {
  assert.doesNotMatch(rest, /#[0-9a-fA-F]{3,8}\b/);
  assert.doesNotMatch(rest, /\b(rgb|rgba|hsl|hsla)\(/);
  for (const m of rest.matchAll(/font-(family|size)\s*:\s*([^;]*);/g)) {
    assert.ok(m[2].trim().startsWith("var("), m[0]);
  }
});

test("no id selectors outside :root", () => {
  assert.doesNotMatch(rest, /(^|[\s,>+~}])#[a-zA-Z_-]/m);
});

test("index.html has no styles and has all ids", () => {
  assert.ok(!html.includes("<style"));
  assert.ok(!html.includes(" style="));
  const ids = [
    "topbar", "library-toggle", "piece-title", "piece-composer", "info-toggle", "info-popover",
    "info-list", "zoom-out", "zoom-reset", "zoom-in", "cursor-start", "cursor-prev", "cursor-next",
    "cursor-status", "metric-accuracy", "metric-tempo", "metric-wrong", "metric-missed", "library",
    "library-search", "filter-difficulty", "filter-key", "filter-time", "library-status",
    "library-list", "library-sources", "score-area", "score-message", "score",
    "engine-status",
    "mode-wait", "mode-live", "practice-toggle", "practice-options", "tempo", "tempo-value", "hands",
    "loop-toggle", "autoplay-toggle", "summary-panel", "summary-title", "summary-list", "summary-again",
    "summary-close", "piano-view",
  ];
  for (const id of ids) assert.ok(html.includes('id="' + id + '"'), id);
});

test("main.ts wiring", () => {
  const main = read("../src/main.ts");
  for (const s of ['import "./styles.css"', "new ScoreView(", "createTopBar(", "createSidebar(",
    "createEngineSocket(", "engineUrlFromSearch(location.search)", "engine.start()",
    "import.meta.env.DEV", "createKeyboardNotes(", '/// <reference types="vite/client" />']) {
    assert.ok(main.includes(s), s);
  }
});

test("engine dot styles and wiring", () => {
  assert.match(css, /\.engine-dot\s*\{/);
  assert.match(css, /\.engine-dot\.connected\s*\{[^}]*var\(--color-engine-on\)/);
  assert.match(css, /\.engine-dot\.connecting\s*\{[^}]*var\(--color-engine-connecting\)/);
  assert.match(css, /@keyframes engine-pulse/);
  const topbar = read("../src/topbar.ts");
  assert.ok(topbar.includes('"engine-status"'));
  assert.ok(topbar.includes("pulseEngine"));
});

test("sidebar wiring", () => {
  const sidebar = read("../src/sidebar.ts");
  for (const s of ["startDownload(", "startSetup(", "fetchCurrentJob(", "library-sources", "progressText(", "setupOffers(", "removeScore(", "removeMode(", "REMOVE_ASK_MS"]) {
    assert.ok(sidebar.includes(s), s);
  }
});

test("remove button css", () => {
  assert.ok(css.includes(".item-remove.asking"));
  assert.match(css, /\.library-list\s*>\s*li\s*\{[^}]*position:\s*relative/);
});

test("no innerHTML", () => {
  for (const f of ["main", "topbar", "sidebar"]) {
    assert.ok(!read("../src/" + f + ".ts").includes("innerHTML"), f);
  }
});

test("the library sidebar stacks above the full-screen skills, log and sight views", () => {
  const z = (selector: string): number => {
    const m = css.match(new RegExp(selector.replace(/\./g, "\\.") + "\\s*\\{[^}]*?z-index:\\s*(\\d+)"));
    assert.ok(m, selector + " has a z-index");
    return Number(m[1]);
  };
  const sidebar = z(".sidebar");
  for (const view of [".skills-view", ".log-view", ".sight-view"]) {
    assert.ok(sidebar > z(view), `.sidebar (${sidebar}) must be above ${view} (${z(view)})`);
  }
});
