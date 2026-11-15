import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const src = readFileSync(new URL("../src/sidebar.ts", import.meta.url), "utf8");

function fnBody(name: string): string {
  const start = src.search(new RegExp(`function\\s+${name}\\s*\\(`));
  assert.ok(start >= 0, `${name} not found`);
  const rest = src.slice(start);
  const next = rest.slice(1).search(/\n {2}(?:async\s+)?function\s/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

test("setup click re-renders rows so download buttons are disabled", () => {
  const body = fnBody("setup");
  const after = body.slice(body.indexOf("startSetup("));
  assert.match(after, /renderList\(\s*lastList\s*,\s*true\s*\)/);
});

test("pollJob clears the job and re-renders when fetchCurrentJob throws", () => {
  const body = fnBody("pollJob");
  const m = body.match(/catch\s*\([^)]*\)\s*\{([\s\S]*?)\n {8}\}/);
  assert.ok(m, "catch block not found");
  assert.match(m[1], /job\s*=\s*null/);
  assert.match(m[1], /renderList\(/);
});

test("removeRow renders before the POST and refreshes after", () => {
  const body = fnBody("removeRow");
  const before = body.slice(0, body.indexOf("removeScore("));
  assert.match(before, /removingId\s*=\s*id/);
  assert.match(before, /renderList\(\s*lastList\s*,\s*true\s*\)/);
  const m = body.match(/catch\s*\([^)]*\)\s*\{([\s\S]*?)\n {4}\}/);
  assert.ok(m, "catch block not found");
  assert.match(m[1], /removingId\s*=\s*null/);
  assert.match(m[1], /renderList\(/);
  assert.match(body.slice(body.indexOf(m[0]) + m[0].length), /refresh\(\s*true\s*\)/);
});

test("markCurrent skips catalogue rows", () => {
  assert.ok(fnBody("markCurrent").includes(":not(.remote)"));
});

test("download, setup and close call stopAsking first", () => {
  for (const name of ["download", "setup"]) {
    const body = fnBody(name);
    assert.match(body.slice(body.indexOf("{")), /^\{\s*stopAsking\(\);/, name);
  }
  const body = fnBody("close");
  assert.match(body.slice(body.indexOf("{")), /^\{\s*stopAsking\(\);/, "close");
});

test("remove button wiring", () => {
  assert.match(src, /closest\(\s*"\.item-remove\.asking"\s*\)/);
  assert.match(src, /li\.append\(\s*rb\s*\)/);
  assert.match(src, /dl\.disabled\s*=\s*jobRunning\(\)\s*\|\|\s*removingId\s*!==\s*null/);
  assert.match(src, /btn\.disabled\s*=\s*jobRunning\(\)\s*\|\|\s*removingId\s*!==\s*null/);
});

test("asking changes never re-render the list", () => {
  assert.ok(!fnBody("onRemoveClick").includes("renderList("));
  assert.ok(!fnBody("stopAsking").includes("renderList("));
});

test("renderList filters by tab and a tab click re-renders", () => {
  assert.match(fnBody("renderList"), /tabScores\(/);
  assert.match(src, /b\.addEventListener\(\s*"click"[\s\S]*?renderList\(\s*lastList\s*,\s*false\s*\)/);
});

test("onRemoveClick guards against double clicks", () => {
  assert.ok(fnBody("onRemoveClick").includes("canConfirmRemove("));
});
