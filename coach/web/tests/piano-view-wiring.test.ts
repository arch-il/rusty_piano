import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const view = readFileSync(new URL("../src/piano-view.ts", import.meta.url), "utf8");

test("main.ts feeds live events into the piano strip", () => {
  assert.match(main, /liveKeys\.apply\(/);
  assert.match(main, /piano\.showLive\(/);
  assert.match(main, /releaseSource\("engine"\)/);
});

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const varOf = (n: string) => css.match(new RegExp(`${n}:\\s*([^;]+);`))?.[1].trim();
const bodyOf = (sel: string) => css.match(new RegExp(`${sel.replace(/\./g, "\\.")}\\s*\\{([^}]*)\\}`))?.[1] ?? "";

test("live keys have their own colour", () => {
  const live = varOf("--color-key-live");
  assert.ok(live);
  for (const n of ["--color-key-right", "--color-key-left", "--color-accent"]) assert.notEqual(live, varOf(n));
  const body = bodyOf(".piano-key.lit-live");
  assert.match(body, /var\(--color-key-live\)/);
  assert.doesNotMatch(body, /--color-accent/);
});

test("Ped badge is centred vertically on the strip", () => {
  const body = bodyOf(".piano-ped");
  assert.match(body, /top: 50%/);
  assert.match(body, /translateY\(-50%\)/);
  assert.doesNotMatch(view, /row\.append\(this\.ped/);
});

test("piano-view.ts uses lit-live and the Ped badge", () => {
  assert.match(view, /lit-live/);
  assert.match(view, /piano-ped/);
});

test("fingering wiring in score-view, piano-view and css", () => {
  const sv = readFileSync(new URL("../src/score-view.ts", import.meta.url), "utf8");
  assert.match(sv, /fingerText\(/);
  assert.match(sv, /rightFingers/);
  assert.match(view, /setFingering/);
  assert.match(view, /piano-finger/);
  assert.match(css, /\.piano-finger\s*\{[^}]*pointer-events:\s*none/);
});

test("next notes reach the piano strip", () => {
  const score = readFileSync(new URL("../src/score-view.ts", import.meta.url), "utf8");
  assert.match(main, /onNextNotes/);
  assert.match(main, /piano\.setNext\(/);
  assert.match(score, /onNextNotes/);
  assert.match(view, /stripView\(/);
  const render = view.slice(view.indexOf("private render()"), view.indexOf("clear(): void"));
  assert.doesNotMatch(render, /return;/);
});

test("setFollowing resets the next notes", () => {
  const score = readFileSync(new URL("../src/score-view.ts", import.meta.url), "utf8");
  const start = score.indexOf("setFollowing(");
  assert.ok(start >= 0);
  const body = score.slice(start).split(/\r?\n  \}\r?\n/)[0];
  assert.match(body, /this\.resetNext\(\)/);
});
