import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const src = readFileSync(new URL("../src/sidebar.ts", import.meta.url), "utf8");
const vite = readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8");

function fnBody(name: string): string {
  const start = src.search(new RegExp(`function\\s+${name}\\s*\\(`));
  assert.ok(start >= 0, `${name} not found`);
  const rest = src.slice(start);
  const next = rest.slice(1).search(/\n {2}(?:async\s+)?function\s/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

test("sidebar imports searchesSources", () => {
  assert.match(src, /import\s*\{\s*searchesSources\s*\}\s*from\s*"\.\/source-query"/);
});

test("renderSources uses searchesSources with setupOffers", () => {
  const body = fnBody("renderSources");
  assert.ok(body.includes("setupOffers("));
  assert.ok(body.includes("searchesSources("));
});

test("refresh tracks loading around fetchScores", () => {
  assert.match(src, /let loading = false/);
  const body = fnBody("refresh");
  const fetchAt = body.indexOf("fetchScores(");
  assert.ok(body.indexOf("loading = true") >= 0 && body.indexOf("loading = true") < fetchAt);
  assert.ok(body.indexOf("loading = false") > fetchAt);
  assert.ok(body.includes("checkJob("));
});

test("pollJob setup re-render respects loading", () => {
  assert.match(fnBody("pollJob"), /kind === "setup" && lastList && !loading/);
});

test("checkJob picks up jobs from other tabs", () => {
  const body = fnBody("checkJob");
  assert.ok(body.includes("fetchCurrentJob("));
  assert.ok(body.includes("pollJob("));
  assert.ok(src.includes('addEventListener("focus"'));
  assert.ok(src.includes("visibilitychange"));
});

test("vite config fixes the ports", () => {
  assert.ok(vite.includes("strictPort: true"));
  assert.ok(vite.includes("port: 5173"));
  assert.ok(vite.includes("port: 4173"));
});
