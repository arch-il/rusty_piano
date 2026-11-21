import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const view = readFileSync(new URL("../src/sight-view.ts", import.meta.url), "utf8");

test("sight view sizes the staff from its width", () => {
  for (const s of ["staffLayout(staffEl.clientWidth", "fit.perLine", "fit.zoom"]) assert.ok(view.includes(s), s);
  assert.ok(!view.includes('=== "intervals" ? 1.0 : 1.2'));
  assert.ok(!view.includes("osmd.Zoom = 1.5"));
});

test("ending a round drops the strip class so the idle box keeps its first-load height", () => {
  const start = view.indexOf("function clearCard(): void {");
  assert.ok(start >= 0);
  const body = view.slice(start, view.indexOf("\n  }\n", start));
  assert.ok(body.includes('staffEl.classList.remove("strip")'), body);
});
