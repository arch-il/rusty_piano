import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const view = read("../src/score-view.ts");
const css = read("../src/styles.css");
const vite = read("../vite.config.ts");

function rule(selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`(?:^|\\n)${esc}\\s*\\{([^}]*)\\}`).exec(css);
  assert.ok(m, `rule ${selector} missing`);
  return m[1];
}

test("every className set in score-view.ts has a CSS rule", () => {
  const names = [...view.matchAll(/className = "([^"]+)"/g)].map((m) => m[1]);
  assert.ok(names.length > 0);
  for (const n of names) {
    assert.ok(css.includes(`.${n}`), `missing .${n}`);
  }
});

test("score-view.ts has no inline layout leftovers", () => {
  assert.ok(!view.includes("score-osmd"));
  assert.ok(!view.includes("style.position"));
});

test("OSMD is loaded lazily", () => {
  assert.ok(!/^import\s+(?!type)[^;]*from "opensheetmusicdisplay"/m.test(view));
  assert.ok(view.includes('import type'));
  assert.ok(view.includes('import("opensheetmusicdisplay")'));
});

test("vite config sets chunkSizeWarningLimit", () => {
  assert.ok(vite.includes("chunkSizeWarningLimit"));
});

test("two-row top bar", () => {
  const root = /:root\s*\{([^}]*)\}/.exec(css);
  assert.ok(root);
  assert.ok(root[1].includes("--topbar-height: 92px"));
  assert.ok(!root[1].includes("--topbar-height-narrow"));
  assert.ok(rule(".topbar").includes("flex-wrap: wrap"));
  assert.ok(rule(".topbar::after").includes("flex-basis: 100%"));
  assert.ok(rule(".topbar::after").includes("order: 1"));
  assert.match(css, /\.mode-switch,\s*\.follow-controls,\s*\.practice,\s*\.metrics\s*\{[^}]*order: 2/);
  assert.ok(rule(".practice-toggle").includes("display: none"));
  const m = /@media \(max-width: 1600px\)\s*\{([\s\S]*)\}\s*$/.exec(css);
  assert.ok(m, "media block missing");
  assert.ok(m[1].includes(".practice-toggle"));
  assert.ok(m[1].includes(".practice-options"));
  assert.ok(m[1].includes("position: absolute"));
});

test("piece block takes only free space", () => {
  const r = rule(".topbar > .piece");
  assert.ok(/flex:\s*1 1 0(?:%|px)?\s*;|flex-basis:\s*0/.test(r));
  assert.ok(r.includes("min-width: 0"));
  assert.ok(r.includes("overflow: hidden"));
  assert.ok(rule(".piece-title").includes("text-overflow: ellipsis"));
  assert.ok(rule(".piece-title").includes("display: block"));
  assert.ok(rule(".piece-composer").includes("display: block"));
});

test("zoom redraw waits and geometry uses the drawn zoom", () => {
  for (const s of [
    "zoomRedrawMs",
    "drawnZoom",
    "needleRect(u.x, u.top, u.bottom, this.drawnZoom)",
    "barRects(boxes, this.drawnZoom)",
    "clearTimeout(this.zoomTimer)",
  ]) {
    assert.ok(view.includes(s), s);
  }
});

test("shift-click does not select text", () => {
  assert.ok(view.includes('addEventListener("mousedown"'));
  assert.ok(view.includes("e.shiftKey"));
  assert.ok(view.includes("preventDefault()"));
  assert.ok(rule(".score-stage").includes("user-select: none"));
});

test("score area never scrolls sideways", () => {
  assert.ok(rule(".score-area").includes("overflow-x: hidden"));
});

test("narrow top bar", () => {
  assert.match(css, /@media \(max-width: 580px\)\s*\{[\s\S]*--topbar-height:\s*\d+px[\s\S]*\.cursor-controls/);
  assert.ok(css.indexOf("@media (max-width: 580px)") > css.indexOf("@media (max-width: 1600px)"));
});

test("short marker", () => {
  assert.ok(view.includes("markShort("));
  assert.ok(rule(".hold-marker").includes("var(--color-mark-short)"));
});

test("text overflow rules", () => {
  assert.ok(rule(".piece-composer").includes("text-overflow: ellipsis"));
  assert.ok(rule(".cursor-controls span").includes("white-space: nowrap"));
});
