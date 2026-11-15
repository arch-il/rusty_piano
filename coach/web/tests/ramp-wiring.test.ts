import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
const html = read("../index.html");
const topbar = read("../src/topbar.ts");
const main = read("../src/main.ts");
const drillLink = read("../src/drill-link.ts");

test("index.html has the ramp button between loop and auto-play", () => {
  const r = html.indexOf('id="ramp-toggle"');
  assert.ok(r > html.indexOf('id="loop-toggle"'));
  assert.ok(html.indexOf('id="loop-toggle"') >= 0);
  assert.ok(r < html.indexOf('id="autoplay-toggle"'));
});

test("topbar.ts wires the ramp button", () => {
  assert.ok(topbar.includes('"ramp-toggle"'));
  assert.ok(topbar.includes("onRampToggle"));
});

test("topbar.ts sets the slider step before the value", () => {
  const stepAt = topbar.indexOf("sliderStep(");
  assert.ok(stepAt >= 0);
  assert.ok(stepAt < topbar.indexOf("tempo.value = String(p.percent)"));
  assert.ok(topbar.includes("tempoStep = step"));
});

test("main.ts wires ramp", () => {
  for (const s of [
    "onRampToggle",
    "ui.ramp = !ui.ramp",
    "settings.ramp.enabled",
    "linkUi(",
    "ui.rampTarget = next.rampTarget",
    "shownPercent(",
    "follower.cycleTiming(k + 1)",
  ]) {
    assert.ok(main.includes(s), s);
  }
});

test("drill-link.ts falls back to the defaults for ramp and target", () => {
  assert.ok(drillLink.includes("link.ramp ?? d.ramp"));
  assert.ok(drillLink.includes("link.target ?? null"));
});
