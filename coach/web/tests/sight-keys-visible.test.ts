import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/sight-view.ts", import.meta.url), "utf8");

test("keysScrollDelta formula is present", () => {
  assert.ok(src.includes("export function keysScrollDelta(keysBottom: number, viewBottom: number, margin = 8): number"));
  assert.ok(src.includes("Math.max(0, Math.ceil(keysBottom + margin - viewBottom))"));
});

test("revealKeys scrolls the view itself when a round starts", () => {
  assert.ok(src.includes("function revealKeys"));
  assert.ok(src.includes("keysScrollDelta("));
  assert.ok(src.includes("scrollTop +="));
  assert.match(src, /card\.index === 0 && controller\.running\(\)\) revealKeys\(\)/);
});
