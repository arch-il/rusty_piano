import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { keyLayout, isBlack, hoverLabel, keyHands, handsLabel, fingerText, keyFingers, stripView } from "../src/piano-keys.ts";
import { noteName } from "../src/engine-socket.ts";

const read = (p: string): string => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");

test("keyLayout has 88 keys, 52 white and 36 black", () => {
  const keys = keyLayout();
  assert.equal(keys.length, 88);
  assert.equal(keys.filter((k) => !k.black).length, 52);
  assert.equal(keys.filter((k) => k.black).length, 36);
});

test("first and last keys sit at the strip edges", () => {
  const keys = keyLayout();
  assert.equal(keys[0].midi, 21);
  assert.equal(keys[0].black, false);
  assert.equal(keys[0].left, 0);
  const last = keys[keys.length - 1];
  assert.equal(last.midi, 108);
  assert.equal(last.black, false);
  assert.ok(Math.abs(last.left + last.width - 100) < 1e-9);
});

test("black keys lie between their neighbouring white keys", () => {
  const keys = keyLayout();
  keys.forEach((k, i) => {
    if (!k.black) return;
    const below = keys[i - 1];
    const above = keys[i + 1];
    assert.ok(k.left > below.left, String(k.midi));
    assert.ok(k.left + k.width < above.left + above.width, String(k.midi));
    assert.ok(k.left < above.left && k.left + k.width > above.left, String(k.midi));
  });
});

test("isBlack", () => {
  assert.equal(isBlack(61), true);
  assert.equal(isBlack(60), false);
});

test("hoverLabel", () => {
  assert.equal(hoverLabel([64, 60, 67, 60], noteName), "C4 E4 G4");
  assert.equal(hoverLabel([61], noteName), "C#4");
  assert.equal(hoverLabel([], noteName), "");
});

test("piano-view classes are styled", () => {
  const view = read("../src/piano-view.ts");
  const css = read("../src/styles.css");
  for (const c of ["piano-label", "piano-keys", "piano-key", "white", "black"]) {
    assert.ok(view.includes(c), c);
    assert.match(css, new RegExp("\\." + c + "\\b[^{]*\\{"), c);
  }
  assert.match(css, /\.score-area\s*\{[^}]*bottom:\s*var\(--piano-height\)/);
});

test("keyHands marks shared keys both", () => {
  const m = keyHands({ right: [60, 64], left: [48, 60] });
  assert.equal(m.get(60), "both");
  assert.equal(m.get(64), "right");
  assert.equal(m.get(48), "left");
  assert.equal(m.size, 3);
});

test("handsLabel", () => {
  assert.equal(handsLabel({ right: [64, 60], left: [48] }, noteName), "R: C4 E4  L: C3");
  assert.equal(handsLabel({ right: [60], left: [] }, noteName), "R: C4");
  assert.equal(handsLabel({ right: [], left: [] }, noteName), "");
});

test("lit hand classes are styled", () => {
  const view = read("../src/piano-view.ts");
  const css = read("../src/styles.css");
  assert.ok(view.includes("lit-"));
  for (const c of ["lit-right", "lit-left", "lit-both"]) {
    assert.match(css, new RegExp("\\." + c + "\\b[^{]*\\{"), c);
  }
});

test("fingerText reads Fingering.value defensively", () => {
  assert.equal(fingerText(null), null);
  assert.equal(fingerText({}), null);
  assert.equal(fingerText({ Fingering: { value: " 3 " } }), "3");
  assert.equal(fingerText({ Fingering: { value: "" } }), null);
  assert.equal(fingerText({ Fingering: { value: 3 } }), null);
});

test("keyFingers merges hands", () => {
  const base = { right: [62, 64], left: [55, 64] };
  assert.deepEqual([...keyFingers({ right: [62], left: [], rightFingers: { 62: "1" } })], [[62, "1"]]);
  assert.deepEqual([...keyFingers({ right: [], left: [55], leftFingers: { 55: "5" } })], [[55, "5"]]);
  assert.equal(keyFingers({ ...base, rightFingers: { 64: "2" }, leftFingers: { 64: "2" } }).get(64), "2");
  assert.equal(keyFingers({ ...base, rightFingers: { 64: "1" }, leftFingers: { 64: "5" } }).get(64), "1/5");
  assert.equal(keyFingers({ right: [62], left: [], rightFingers: { 62: "1", 70: "3" } }).has(70), false);
});

test("handsLabel with fingers", () => {
  const n = { right: [74], left: [55, 59], leftFingers: { 55: "5" }, rightFingers: { 74: "1" } };
  assert.equal(handsLabel(n, noteName, true), "R: D5(1)  L: G3(5) B3");
  assert.equal(handsLabel(n, noteName), "R: D5  L: G3 B3");
});

const EMPTY = { right: [], left: [] };
const NEXT = { right: [60], left: [48], rightFingers: { 60: "1" }, leftFingers: { 48: "5" } };
const HOVER = { right: [64], left: [], rightFingers: { 64: "3" } };

test("stripView fingering off with live keys ignores next", () => {
  const v = stripView([60, 62], HOVER, NEXT, false, noteName);
  assert.equal(v.classes.get(60), "lit-live");
  assert.equal(v.fingers.size, 0);
  assert.equal(v.label, `Held: ${noteName(60)} ${noteName(62)}`);
});

test("stripView fingering on with live keys shows fingers of next", () => {
  const v = stripView([67], HOVER, NEXT, true, noteName);
  assert.equal(v.classes.get(67), "lit-live");
  assert.equal(v.classes.get(60), "lit-right");
  assert.equal(v.classes.get(48), "lit-left");
  assert.equal(v.classes.size, 3);
  assert.equal(v.fingers.get(60), "1");
  assert.equal(v.fingers.get(48), "5");
  assert.ok(v.label.includes("Next:"));
  assert.ok(v.label.includes(`${noteName(60)}(1)`));
});

test("stripView fingering on: held key on a next key shows lit-live, both hands shows lit-both", () => {
  const both = { right: [60], left: [60, 48] };
  const v = stripView([60], EMPTY, both, true, noteName);
  assert.equal(v.classes.get(60), "lit-live");
  assert.equal(v.classes.get(48), "lit-left");
  const w = stripView([67], EMPTY, both, true, noteName);
  assert.equal(w.classes.get(60), "lit-both");
});

test("stripView fingering on with live keys and no next falls back to hover", () => {
  const v = stripView([67], HOVER, null, true, noteName);
  assert.equal(v.fingers.get(64), "3");
  assert.ok(!v.label.includes("Next:"));
});

test("stripView fingering on, nothing live or hovered shows next", () => {
  const v = stripView([], EMPTY, NEXT, true, noteName);
  assert.equal(v.classes.get(60), "lit-right");
  assert.equal(v.classes.get(48), "lit-left");
  assert.equal(v.fingers.get(60), "1");
  assert.equal(v.label, handsLabel(NEXT, noteName, true));
});

test("stripView hover wins over next when not live", () => {
  const v = stripView([], HOVER, NEXT, true, noteName);
  assert.equal(v.classes.get(64), "lit-right");
  assert.equal(v.classes.has(60), false);
  assert.equal(v.fingers.get(64), "3");
});
