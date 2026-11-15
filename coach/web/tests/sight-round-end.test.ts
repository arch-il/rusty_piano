import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const sightView = readFileSync(fileURLToPath(new URL("../src/sight-view.ts", import.meta.url)), "utf8");

test("a round played out to the end clears the staff", () => {
  const start = sightView.indexOf('e.kind === "done"');
  assert.ok(start >= 0);
  const branch = sightView.slice(start, sightView.indexOf("renderControls();", start));
  assert.ok(branch.includes("endRound()"));
  assert.ok(branch.indexOf("endRound()") < branch.indexOf("showSummary("));
});
