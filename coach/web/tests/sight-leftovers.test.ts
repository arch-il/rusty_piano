import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (n: string): string => readFileSync(fileURLToPath(new URL("../src/" + n, import.meta.url)), "utf8");
const main = read("main.ts");
const sightView = read("sight-view.ts");
const topbar = read("topbar.ts");

function fnBody(src: string, header: string): string {
  const start = src.indexOf(header);
  assert.ok(start >= 0, header);
  return src.slice(start, src.indexOf("\n  }\n", start));
}

test("ending a round clears the drawn card", () => {
  assert.ok(fnBody(sightView, "function clearCard(").includes("staffEl.replaceChildren()"));
  assert.ok(fnBody(sightView, "function endRound(").includes("clearCard()"));
});

test("top bar controls are locked while sight is shown", () => {
  const body = main.slice(main.indexOf("function renderFollow("), main.indexOf("function cancelFrames("));
  assert.ok(body.includes("scoreReady && !sightShown()"));
  assert.ok(body.includes("locked: running() || sightShown()"));
  assert.ok(body.includes("autoplayOff: sightShown()"));
  assert.ok(body.includes("!running() && !sightShown()"));
  assert.ok(topbar.includes("autoplayToggle.disabled = p.autoplayOff === true"));
});

test("play toggle does nothing on sight and the bar refreshes on enter/leave", () => {
  assert.ok(fnBody(main, "onFollowToggle: () => {").includes("if (sightShown()) return;"));
  const enter = main.slice(main.indexOf("function enterSight("), main.indexOf("function applyLink("));
  assert.ok(enter.includes("sightOpen = true;") && enter.includes("renderFollow();"));
  const route = main.slice(main.indexOf("function applyRoute("));
  assert.ok(/sight\.hide\(\);\s*sightOpen = false;\s*renderFollow\(\);/.test(route));
});
