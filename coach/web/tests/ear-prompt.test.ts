import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promptText } from "../src/ear-view.ts";
import { createEarSession } from "../src/ear-session.ts";
import type { EarEffect } from "../src/ear-session.ts";
import { instructionText, levelById } from "../src/ear-levels.ts";
import type { AnswerStep, EarItem } from "../src/ear-levels.ts";

const echo = levelById("echo-4")!;
const chord = levelById("chord-1")!;
const notes: AnswerStep[] = [
  { kind: "note", pitch: 60 },
  { kind: "note", pitch: 62 },
  { kind: "note", pitch: 64 },
];
const steps = { item: 0, total: 8, currentItem: { answer: notes } };

test("accepted partial step on a multi-step item shows the count", () => {
  const e: EarEffect = { kind: "accepted", note: 62, step: 1 };
  assert.equal(promptText(echo, { ...steps, lastEffect: e }), "1/8 Yes: 2 of 3");
});

test("no effect shows the instruction", () => {
  assert.equal(promptText(echo, { ...steps, lastEffect: null }), `1/8 ${instructionText(echo)}`);
});

test("revealed shows the press next text", () => {
  const e: EarEffect = { kind: "revealed", item: 0, auto: false };
  assert.equal(promptText(echo, { ...steps, lastEffect: e }), "1/8 Answer shown. Press Next.");
});

test("correct first try and not first try", () => {
  const first: EarEffect = { kind: "correct", item: 0, firstTry: true };
  const later: EarEffect = { kind: "correct", item: 0, firstTry: false };
  assert.equal(promptText(echo, { ...steps, lastEffect: first }), "1/8 Right!");
  assert.equal(promptText(echo, { ...steps, lastEffect: later }), "1/8 Right (not first try)");
});

test("wrong shows not that one", () => {
  const e: EarEffect = { kind: "wrong", note: 61, wrongCount: 1 };
  assert.equal(promptText(echo, { ...steps, lastEffect: e }), "1/8 Not that one");
});

test("accepted chord step says the note is in the chord", () => {
  const answer: AnswerStep[] = [{ kind: "chord", pcs: [0, 4, 7] }];
  const e: EarEffect = { kind: "accepted", note: 60, step: 0 };
  assert.equal(
    promptText(chord, { item: 0, total: 10, lastEffect: e, currentItem: { answer } }),
    "1/10 Yes, that note is in the chord.",
  );
});

test("accepted single note step shows the instruction", () => {
  const answer: AnswerStep[] = [{ kind: "note", pitch: 60 }];
  const e: EarEffect = { kind: "accepted", note: 60, step: 0 };
  assert.equal(
    promptText(echo, { item: 0, total: 8, lastEffect: e, currentItem: { answer } }),
    `1/8 ${instructionText(echo)}`,
  );
});

test("accepted with no current item shows the instruction", () => {
  const e: EarEffect = { kind: "accepted", note: 60, step: 0 };
  assert.equal(
    promptText(echo, { item: 0, total: 8, lastEffect: e, currentItem: null }),
    `1/8 ${instructionText(echo)}`,
  );
});

function noteItem(): EarItem {
  const prompt = [{ note: 60, startMs: 0, durMs: 675, velocity: 80 }];
  return {
    index: 0,
    type: "echo",
    category: "phrase",
    label: "phrase",
    prompt,
    answerSound: prompt,
    given: [],
    answer: notes,
    answerNotes: [60, 62, 64],
  };
}

test("a partial step on a three-note item is accepted without completing the item", () => {
  const s = createEarSession([noteItem()], {});
  s.asked(0);
  const on60 = { type: "note_on" as const, t: 0, note: 60, velocity: 80, source: "engine" as const };
  assert.deepEqual(s.handle(on60, 10), [{ kind: "accepted", note: 60, step: 0 }]);
});

function ruleBody(css: string, selector: string): string {
  const start = css.indexOf(selector);
  assert.notEqual(start, -1, `missing ${selector}`);
  return css.slice(start, css.indexOf("}", start));
}

function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

test("selected level is bold and readable while pressed", () => {
  const css = readFileSync(fileURLToPath(new URL("../src/styles.css", import.meta.url)), "utf8");
  assert.ok(css.includes(".ear-level[aria-pressed='true']:active:not(:disabled)"));
  assert.ok(ruleBody(css, "\n.ear-level[aria-pressed='true'] {").includes("font-weight: 600"));
  const hover = css.match(/--color-accent-hover:\s*(#[0-9a-fA-F]{6})/)![1];
  const soft = css.match(/--color-accent-soft:\s*(#[0-9a-fA-F]{6})/)![1];
  assert.ok(contrast(hover, soft) >= 4.5);
});
