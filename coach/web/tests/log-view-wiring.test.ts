import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const html = read("../index.html");
const main = read("../src/main.ts");
const view = read("../src/log-view.ts");
const css = read("../src/styles.css");

test("index.html has the log ids", () => {
  for (const id of ["log-link", "log-view", "log-back", "log-status", "log-summary", "log-chart", "log-pieces"]) {
    assert.ok(html.includes(`id="${id}"`), `missing #${id}`);
  }
  assert.ok(/id="log-link"[^>]*href="#\/log"/.test(html));
});

test("main.ts wires the log view", () => {
  for (const s of ["createLogView(", "fetchLog()", 'route.kind === "log"', "enterLog()", "logView.hide()", "logView.visible()"]) {
    assert.ok(main.includes(s), `missing ${s}`);
  }
  const at = main.indexOf("const logView = createLogView(");
  assert.ok(at >= 0 && at < main.lastIndexOf("applyRoute(location.hash)"));
  const start = main.indexOf("function leaveLog(): void {");
  assert.ok(start >= 0);
  const body = main.slice(start, main.indexOf("\n}\n", start));
  assert.ok(body.includes("leaveSkills()"));
});

test("log-view.ts uses safe DOM calls", () => {
  for (const s of [
    "replaceChildren(",
    "createElementNS(",
    "dayBars(",
    "barLayout(",
    "summaryItems(",
    "pieceRows(",
    "pieceMeta(",
    "dataset.attemptId",
    "ApiError",
    "'log-run-actions'",
  ]) {
    assert.ok(view.includes(s), `missing ${s}`);
  }
  assert.ok(!view.includes("innerHTML"));
});

test("every class set in log-view.ts has a CSS rule", () => {
  const names = new Set<string>();
  for (const m of view.matchAll(/className = '([^']+)'/g)) names.add(m[1]);
  for (const m of view.matchAll(/svgEl\('[a-z]+', '([^']+)'\)/g)) names.add(m[1]);
  assert.ok(names.size > 0);
  for (const n of names) assert.ok(css.includes("." + n), `no CSS for .${n}`);
});
