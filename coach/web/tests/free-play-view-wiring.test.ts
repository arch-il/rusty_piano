import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const view = readFileSync(new URL("../src/free-play-view.ts", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

const SECTION_LINE = '<section id="free-play" class="free-play" aria-label="Free play" hidden></section>';

test("index.html has the hidden free-play section inside main between score-message and score", () => {
  const at = html.indexOf(SECTION_LINE);
  assert.ok(at >= 0);
  assert.ok(at > html.indexOf('id="score-message"'));
  assert.ok(at < html.indexOf('id="score" '));
  assert.ok(at < html.indexOf("</main>"));
});

test("free-play-view.ts follows the wiring rules", () => {
  assert.ok(!view.includes("innerHTML"));
  assert.doesNotMatch(view, /^import\s+(?!type)[^;]*from "opensheetmusicdisplay"/m);
  assert.ok(view.includes('import("opensheetmusicdisplay")'));
  const needed = [
    "export function createFreePlayView(",
    "createSlotHistory(",
    "wantsEvent(",
    "freePlayXml(",
    "fallbackText(",
    "loadFreeKey(",
    "saveFreeKey(",
    ".blur()",
    "RenderXMeasuresPerLineAkaSystem",
    "RenderSingleHorizontalStaffline",
    "scrollLeft = staff.scrollWidth",
    "const api: FreePlayView",
    "Could not load the notation library: ",
    "Could not draw the staff: ",
    "replaceChildren(",
    "dirty",
    "rendering",
    "host.hidden",
  ];
  for (const s of needed) {
    assert.ok(view.includes(s), `missing ${s}`);
  }
});

test("free play staff zooms to its width and never scrolls vertically", () => {
  assert.ok(view.includes("freePlayZoom(staff.clientWidth)"));
  assert.ok(!view.includes("osmd.Zoom = 1.0"));
  const rule = css.slice(css.indexOf(".free-play-staff {"), css.indexOf("}", css.indexOf(".free-play-staff {")));
  assert.ok(rule.includes("overflow-x: auto"));
  assert.ok(rule.includes("overflow-y: hidden"));
});

test("every class used by free-play-view.ts has a CSS rule", () => {
  const classes: string[] = [];
  for (const m of view.matchAll(/className = "([^"]+)"/g)) {
    classes.push(...m[1].split(/\s+/).filter(Boolean));
  }
  assert.ok(classes.length > 0);
  for (const name of classes) {
    assert.ok(css.includes("." + name), `no CSS for .${name}`);
  }
});

test("styles.css has the free play section before the responsive section", () => {
  const start = css.indexOf("/* ===== Free play ===== */");
  assert.ok(start >= 0);
  assert.ok(start < css.indexOf("/* ===== Top bar responsive"));
  assert.match(css, /\.free-play\[hidden\]\s*\{[^}]*display:\s*none/);
});
