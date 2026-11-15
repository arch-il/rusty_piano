import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  NO_DRILLS_TEXT,
  NO_TREE_TEXT,
  drillsNotice,
  historyModel,
  percentText,
  planErrorState,
} from "../src/ear-stats.ts";
import type { PlanTreeState } from "../src/ear-stats.ts";
import { ApiError } from "../src/api.ts";
import type { EarRound, EarRoundItem } from "../src/ear-levels.ts";
import type { PlanTree } from "../src/skills-logic.ts";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const view = read("../src/ear-view.ts");

const item = (over: Partial<EarRoundItem> = {}): EarRoundItem => ({
  category: "Interval",
  first_try: true,
  response_ms: 1000,
  answer_steps: 1,
  replays: 0,
  revealed: false,
  ...over,
});

const round = (over: Partial<EarRound> = {}): EarRound => ({
  id: "r",
  started_at: "2026-11-06T20:00:00.000Z",
  level: "echo-1",
  drill_id: null,
  end: "done",
  accuracy: 1,
  median_step_ms: 1000,
  replays: 0,
  items: [item()],
  ...over,
});

test("percentText floors to whole percents with a small epsilon", () => {
  assert.equal(percentText(null), "0%");
  assert.equal(percentText(0.29), "29%");
  assert.equal(percentText(0.895), "89%");
  assert.equal(percentText(9 / 10), "90%");
  assert.equal(percentText(2 / 3), "66%");
  assert.equal(percentText(1), "100%");
});

test("historyModel with no rounds has the empty text and no stopped text", () => {
  const m = historyModel([], "echo-1");
  assert.deepEqual(m.shown, []);
  assert.equal(m.emptyText, "No rounds yet on this level.");
  assert.equal(m.stoppedText, null);
});

test("historyModel with only a stopped round says so", () => {
  const m = historyModel([round({ end: "stop" })], "echo-1");
  assert.deepEqual(m.shown, []);
  assert.equal(m.emptyText, "No finished rounds yet on this level (1 stopped early).");
  assert.equal(m.stoppedText, null);
});

test("historyModel with only an interrupted round says so", () => {
  const m = historyModel([round({ end: "interrupted" })], "echo-1");
  assert.deepEqual(m.shown, []);
  assert.equal(m.emptyText, "No finished rounds yet on this level (1 stopped early).");
});

test("historyModel with a done and a stopped round shows the done one and notes the stopped one", () => {
  const done = round({ id: "a" });
  const m = historyModel([done, round({ id: "b", end: "stop" })], "echo-1");
  assert.deepEqual(m.shown, [done]);
  assert.equal(m.emptyText, null);
  assert.equal(m.stoppedText, "1 stopped round not shown.");
});

test("historyModel with two stopped rounds uses the plural", () => {
  const m = historyModel(
    [round({ id: "a" }), round({ id: "b", end: "stop" }), round({ id: "c", end: "interrupted" })],
    "echo-1",
  );
  assert.equal(m.shown.length, 1);
  assert.equal(m.stoppedText, "2 stopped rounds not shown.");
});

test("historyModel ignores rounds of other levels", () => {
  const m = historyModel([round({ level: "echo-2", end: "stop" }), round({ level: "echo-1" })], "echo-1");
  assert.equal(m.shown.length, 1);
  assert.equal(m.emptyText, null);
  assert.equal(m.stoppedText, null);
});

test("planErrorState is missing only for a 404 ApiError", () => {
  assert.deepEqual(planErrorState(new ApiError("No skill tree yet", 404)), { kind: "missing" });
  assert.deepEqual(planErrorState(new ApiError("unreachable", 0)), { kind: "unknown" });
  assert.deepEqual(planErrorState(new ApiError("server", 500)), { kind: "unknown" });
  assert.deepEqual(planErrorState(new TypeError("fetch failed")), { kind: "unknown" });
});

test("drillsNotice covers unknown, missing, a tree with ear drills and a tree without", () => {
  const tree = (id: string) =>
    ({
      version: 1,
      kind: "skills",
      decay_days: 30,
      tracks: [],
      nodes: [{ id: "b", track: "t", title: "B", requires: [], drills: [{ id }] }],
    }) as unknown as PlanTree;
  const unknown: PlanTreeState = { kind: "unknown" };
  assert.equal(drillsNotice(unknown), null);
  assert.equal(drillsNotice({ kind: "missing" }), NO_TREE_TEXT);
  assert.equal(drillsNotice({ kind: "tree", tree: tree("ear.x") }), null);
  assert.equal(drillsNotice({ kind: "tree", tree: tree("sr.r2-treble") }), NO_DRILLS_TEXT);
});

test("ear-view.ts uses the plan state helpers and no longer treats a missing plan as having drills", () => {
  assert.ok(view.includes("planErrorState("));
  assert.ok(view.includes("drillsNotice("));
  assert.ok(!view.includes("planTree === null"));
});
