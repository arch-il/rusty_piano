import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");

test("main.ts wires the ear view", () => {
  for (const s of ["createEarView(", "fetchEarHistory", 'route.kind === "ear"', "enterEar(route.params)", "ear.hide()", "ear.escape()", "earOpen"]) {
    assert.ok(src.includes(s), s);
  }
});

test("openScore hides the ear and sight views", () => {
  const start = src.indexOf("async function openScore(");
  const end = src.indexOf("\nfunction ", start);
  const body = src.slice(start, end);
  const idx = ["ear.hide()", "earOpen = false", "sight.hide()", "sightOpen = false"].map((s) => {
    const i = body.indexOf(s);
    assert.ok(i >= 0, s);
    return i;
  });
  const last = Math.max(...idx);
  assert.ok(body.indexOf("renderFollow()", last) > last);
});

test("createEarView comes after the engine socket and before the last applyRoute", () => {
  const socket = src.indexOf("createEngineSocket(");
  const ear = src.indexOf("createEarView({");
  const route = src.lastIndexOf("applyRoute(location.hash)");
  assert.ok(socket >= 0 && socket < ear && ear < route);
});
