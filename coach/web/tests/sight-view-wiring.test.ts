import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const html = read("../index.html");
const main = read("../src/main.ts");
const view = read("../src/sight-view.ts");
const css = read("../src/styles.css");

test("index.html has the sight ids", () => {
  for (const id of [
    "sight-link", "sight-view", "sight-back", "sight-status", "sight-levels", "sight-stats",
    "sight-staff", "sight-keys", "sight-start", "sight-stop", "sight-summary", "sight-history",
  ]) {
    assert.ok(html.includes(`id="${id}"`), `missing #${id}`);
  }
  assert.ok(/id="sight-link"[^>]*href="#\/sight"/.test(html));
});

test("main.ts wires the sight view", () => {
  for (const s of ["createSightView(", "fetchSightHistory", 'route.kind === "sight"', "enterSight(route.params)", "sight.hide()", "sight.escape()"]) {
    assert.ok(main.includes(s), `missing ${s}`);
  }
  const at = main.indexOf("const sight = createSightView(");
  assert.ok(at > main.indexOf("createEngineSocket("));
  assert.ok(at < main.lastIndexOf("applyRoute(location.hash);"));
});

test("sight-view.ts uses plain DOM and the controller", () => {
  assert.ok(!view.includes("innerHTML"));
  assert.ok(!/^import\s+(?!type)[^;]*from "opensheetmusicdisplay"/m.test(view));
  assert.ok(view.includes('import("opensheetmusicdisplay")'));
  for (const s of ["createSightController(", "cardXml(", "summaryModel(", "liveStatsText(", "keyLayout(", "onRenderError", ".blur("]) {
    assert.ok(view.includes(s), `missing ${s}`);
  }
  for (const s of ["wrongNoteOffset(", "WRONG_ANCHOR_COLOR", "sight-wrong-head"]) {
    assert.ok(view.includes(s), `missing ${s}`);
  }
  for (const s of ["stripXml(", "stripStart(", "RenderXMeasuresPerLineAkaSystem"]) {
    assert.ok(view.includes(s), `missing ${s}`);
  }
  assert.ok(css.includes(".sight-staff.strip"));
  assert.ok(!view.includes("makeRound("));
  assert.ok(!view.includes("createSightSession("));
});

test("every class set in sight-view.ts has a CSS rule", () => {
  const names = [
    ...[...view.matchAll(/className = ["']([^"']+)["']/g)].map((m) => m[1]),
    ...[...view.matchAll(/classList\.(?:add|toggle)\(["']([^"']+)["']/g)].map((m) => m[1]),
    ...[...view.matchAll(/\? "([a-z-]+ (?:black|white))" : "([a-z-]+ (?:black|white))"/g)].flatMap((m) => [m[1], m[2]]),
  ];
  assert.ok(names.length > 0);
  for (const n of [...names, "pressed", "wrong", "hint", "white", "black"].flatMap((x) => x.split(" "))) {
    assert.ok(css.includes(`.${n}`), `missing .${n}`);
  }
});
