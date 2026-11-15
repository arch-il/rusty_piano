import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const main = readFileSync(fileURLToPath(new URL("../src/main.ts", import.meta.url)), "utf8");
const skillsView = readFileSync(fileURLToPath(new URL("../src/skills-view.ts", import.meta.url)), "utf8");

function fnBody(src: string, header: string): string {
  const start = src.indexOf(header);
  assert.ok(start >= 0, header);
  return src.slice(start, src.indexOf("\n}\n", start));
}

test("applyLink uses linkUi with the settings defaults", () => {
  const body = fnBody(main, "function applyLink(");
  assert.ok(body.includes("linkUi("));
  assert.ok(body.includes("settings.mode"));
  assert.ok(body.includes("settings.loop"));
  assert.ok(body.includes("settings.ramp.enabled"));
});

test("applyRoute keeps the page when coming back from Skills", () => {
  const body = fnBody(main, "function applyRoute(");
  assert.ok(body.includes("keepsPage(fromSkills, picked, route.link, activeLink)"));
  assert.ok(body.includes("skills.visible()"));
  assert.ok(body.includes("drillPicked = false"));
});

test("drill clicks are reported to main", () => {
  assert.ok(main.includes("onDrill:"));
  assert.ok(skillsView.includes("opts.onDrill"));
});

test("openFromHash sets currentId before fetching", () => {
  const body = fnBody(main, "async function openFromHash(");
  const at = body.indexOf("currentId = id");
  assert.ok(at >= 0);
  assert.ok(at < body.indexOf("fetchScore("));
});

test("turning auto-play off stops the notes", () => {
  const a = main.indexOf("onAutoplayToggle:");
  const b = main.indexOf("onSummaryAgain:");
  assert.ok(a >= 0 && b > a);
  assert.ok(main.slice(a, b).includes("sound.stopNotes()"));
});

test("the recorder reads the auto-play pedal when auto-playing", () => {
  assert.ok(main.includes('follower.pedal("autoplay")'));
});
