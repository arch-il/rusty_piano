import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stageModel } from "../src/sight-stats.ts";

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const view = readFileSync(new URL("../src/sight-view.ts", import.meta.url), "utf8");

const Z = { steps: 0, firstTry: 0, accuracy: null, medianMs: null, meanMs: null, hinted: 0, wrongNotes: 0 };

function withStats(accuracy: number, medianMs: number) {
  return { steps: 10, firstTry: 5, accuracy, medianMs, meanMs: medianMs, hinted: 0, wrongNotes: 0 };
}

function body(marker: string): string {
  const start = css.indexOf(marker);
  assert.ok(start >= 0, `missing rule: ${marker}`);
  return css.slice(start, css.indexOf("}", start));
}

test("idle stage model", () => {
  assert.deepEqual(stageModel(null, 20, Z, null, "notes", "HINT"), {
    progress: "",
    done: 0,
    total: 20,
    percent: 0,
    chips: [],
    hint: "HINT",
  });
});

test("first card has no chips", () => {
  assert.deepEqual(stageModel(1, 20, Z, null, "notes", "H"), {
    progress: "Card 1 of 20",
    done: 0,
    total: 20,
    percent: 0,
    chips: [],
    hint: "Play the note you see",
  });
});

test("running stage model", () => {
  const s = { steps: 2, firstTry: 2, accuracy: 1, medianMs: 1100, meanMs: 1100, hinted: 0, wrongNotes: 0 };
  assert.deepEqual(stageModel(3, 20, s, 800, "notes", "H"), {
    progress: "Card 3 of 20",
    done: 2,
    total: 20,
    percent: 10,
    hint: "",
    chips: [
      { label: "First try", value: "2/2 100%", tone: "good" },
      { label: "Median", value: "1.1 s", tone: "good" },
      { label: "Last", value: "0.8 s", tone: "neutral" },
    ],
  });
});

test("bars stage model", () => {
  const m = stageModel(2, 4, Z, null, "bars", "H");
  assert.equal(m.progress, "Phrase 2 of 4");
  assert.equal(m.percent, 25);
  assert.equal(m.hint, "Play the notes you see");
});

test("chip tones", () => {
  assert.equal(stageModel(2, 20, withStats(0.85, 1000), null, "notes", "H").chips[0].tone, "warn");
  assert.equal(stageModel(2, 20, withStats(0.5, 1000), null, "notes", "H").chips[0].tone, "bad");
  assert.equal(stageModel(2, 20, withStats(1, 2500), null, "notes", "H").chips[1].tone, "warn");
  assert.equal(stageModel(2, 20, withStats(1, 3500), null, "notes", "H").chips[1].tone, "bad");
});

test("markup", () => {
  for (const id of ["sight-level-name", "sight-progress", "sight-progress-fill", "sight-progress-text"]) {
    assert.ok(html.includes(`id="${id}"`), id);
  }
  assert.ok(html.includes('class="sight-board"'));
  const name = html.indexOf('id="sight-level-name"');
  const start = html.indexOf('id="sight-start"');
  const staff = html.indexOf('id="sight-staff"');
  const keys = html.indexOf('id="sight-keys"');
  assert.ok(name < start && start < staff && staff < keys);
});

test("css and view", () => {
  for (const r of [
    ".sight-board {",
    ".sight-chip {",
    ".sight-chip.tone-good {",
    ".sight-chip.tone-warn {",
    ".sight-chip.tone-bad {",
    ".sight-staff:empty::before {",
  ]) {
    assert.ok(css.includes(r), r);
  }
  assert.ok(body(".sight-progress-fill {").includes("var(--color-accent)"));
  assert.equal(css.split("@media (max-width: 580px) {").length - 1, 1);
  assert.ok(view.includes("stageModel("));
  assert.ok(view.includes("liveStatsText("));
});
