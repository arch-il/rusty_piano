import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (p: string): string => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
const html = read("../index.html");
const main = read("../src/main.ts");
const scoreView = read("../src/score-view.ts");
const notesView = read("../src/score-notes-view.ts");
const css = read("../src/styles.css");

test("index.html places the Marks toggle in the top bar", () => {
  const fingering = html.indexOf('id="fingering-toggle"');
  const marks = html.indexOf('id="marks-toggle"');
  const engine = html.indexOf('id="engine-status"');
  assert.ok(fingering >= 0 && marks > fingering && marks < engine);
});

test("main.ts wires score notes", () => {
  for (const s of [
    "createScoreNotes(",
    "scoreNotes.open(score.id)",
    "scoreNotes.close()",
    "onBarContextMenu: (info) => scoreNotes.contextMenu(info),",
    "onLayout: () => scoreNotes.layout(),",
    "if (scoreNotes.closeMenus()) return;",
    "fetchScoreNotes(",
    "saveScoreNotes(",
  ]) {
    assert.ok(main.includes(s), s);
  }
});

test("openScore closes notes before loading the score", () => {
  const start = main.indexOf("async function openScore(");
  assert.ok(start >= 0);
  const close = main.indexOf("scoreNotes.close()", start);
  const load = main.indexOf("await view.load(", start);
  assert.ok(close > start && close < load);
});

test("score view exposes bar boxes, bar navigation and layout events", () => {
  assert.ok(scoreView.includes('addEventListener("contextmenu", '));
  assert.ok(scoreView.includes("barBoxes("));
  assert.ok(scoreView.includes("goToBar("));
  assert.ok(scoreView.includes("noteMarks"));
  assert.ok(scoreView.split("this.events.onLayout?.()").length - 1 >= 3);
});

test("score notes view handles stop propagation, hashchange and marks", () => {
  assert.ok(notesView.includes("stopPropagation()"));
  assert.ok(notesView.includes('"hashchange"'));
  assert.ok(notesView.includes("showMarks("));
});

test("a piece-note save only updates the view it was started in", () => {
  assert.ok(notesView.includes("const openAtClick = loadToken;"));
  assert.ok(notesView.includes("if (loadToken !== openAtClick) return;"));
  assert.ok(!notesView.includes("idAtClick"));
});

test("styles define score notes before the responsive section", () => {
  const root = css.match(/:root\s*\{[^}]*\}/)?.[0] ?? "";
  assert.ok(root.includes("--color-hard-bar"));
  const marker = css.indexOf("/* ===== Top bar responsive: keep this section last in the file ===== */");
  assert.ok(marker >= 0);
  for (const sel of [".score-note-marks {", ".hard-bar-band {", ".bar-note-icon {", ".bar-menu {", ".bar-note-popover {"]) {
    const at = css.indexOf(sel);
    assert.ok(at >= 0 && at < marker, sel);
  }
  const icon = css.slice(css.indexOf(".bar-note-icon {"), css.indexOf("}", css.indexOf(".bar-note-icon {")));
  assert.ok(icon.includes("pointer-events: auto"));
});

test("index.html places the hard bars menu after the replay toggle and before zoom", () => {
  const replay = html.indexOf('id="replay-toggle"');
  const zoom = html.indexOf('id="zoom-out"');
  for (const id of ["hardbars-toggle", "hardbars-next", "hardbars-menu", "hardbars-status", "hardbars-list"]) {
    const at = html.indexOf(`id="${id}"`);
    assert.ok(at > replay && at < zoom, id);
  }
});

test("index.html puts the piece note inside the info popover", () => {
  const info = html.indexOf('id="info-popover"');
  const replay = html.indexOf('id="replay-toggle"');
  for (const id of ["piece-note-text", "piece-note-save", "piece-note-status"]) {
    const at = html.indexOf(`id="${id}"`);
    assert.ok(at > info && at < replay, id);
  }
  assert.ok(html.includes('id="piece-note-text" class="piece-note-text" rows="4" maxlength="2000"'));
});

test("main.ts enables hard bars from renderFollow and practises a picked range", () => {
  const start = main.indexOf("function renderFollow");
  const end = main.indexOf("\nfunction ", start + 1);
  assert.ok(start >= 0 && end > start);
  assert.ok(main.slice(start, end).includes("scoreNotes.setEnabled(scoreReady && !running() && !sightShown());"));
  assert.ok(main.includes("onPractise:"));
  assert.ok(main.includes("view.goToBar(r.from)"));
  assert.ok(main.includes("ui.loop = true"));
});

test("styles define hard bars and piece note before the responsive section", () => {
  const marker = css.indexOf("/* ===== Top bar responsive: keep this section last in the file ===== */");
  assert.ok(marker >= 0);
  for (const sel of [".hardbars-menu {", ".hardbars-item {", ".piece-note-text {"]) {
    const at = css.indexOf(sel);
    assert.ok(at >= 0 && at < marker, sel);
  }
  const media = css.slice(css.indexOf("@media (max-width: 760px) {"));
  const rule = media.slice(media.indexOf(".hardbars .popover {"));
  assert.ok(rule.startsWith(".hardbars .popover {"));
  assert.ok(rule.split("}")[0].includes("position: fixed"));
});

test("index.html gives hard bars, next and marks compact short labels", () => {
  for (const id of ["hardbars-toggle", "hardbars-next", "marks-toggle"]) {
    const start = html.indexOf(`id="${id}"`);
    const end = html.indexOf("</button>", start);
    assert.ok(start >= 0 && end > start, id);
    const body = html.slice(start, end);
    assert.ok(body.includes('<span class="hb-label">'), id);
    assert.ok(body.includes('<span class="hb-short" aria-hidden="true">'), id);
  }
  assert.ok(html.includes('id="marks-toggle" class="btn marks-toggle" aria-pressed="true" aria-label="Marks"'));
});

test("score notes view sets the hard bars label, short label and aria-label", () => {
  assert.ok(notesView.includes('querySelector(".hb-label")'));
  assert.ok(notesView.includes('querySelector(".hb-short")'));
  assert.ok(notesView.includes('hbToggle.setAttribute("aria-label", hbText)'));
});

test("styles add a 761-900px compact top bar block between the 1000px and 760px blocks", () => {
  const wide = css.indexOf("@media (max-width: 1000px) {");
  const compact = css.indexOf("@media (min-width: 761px) and (max-width: 900px) {");
  const narrow = css.indexOf("@media (max-width: 760px) {");
  assert.ok(wide >= 0 && compact > wide && compact < narrow);
  const block = css.slice(compact, css.indexOf("\n}\n", compact));
  assert.ok(block.includes(".hb-short"));
  assert.ok(block.includes("display: inline"));
  assert.ok(block.includes(".marks-toggle .hb-label"));
  assert.ok(block.includes(".topbar .marks-toggle"));
  assert.ok(!css.includes("#marks-toggle"));
});
