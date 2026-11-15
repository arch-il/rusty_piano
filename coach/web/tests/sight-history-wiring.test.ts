import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { treeHasDrill } from "../src/sight-history-view.ts";
import type { PlanTree } from "../src/skills-logic.ts";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const hist = read("../src/sight-history-view.ts");
const view = read("../src/sight-view.ts");
const css = read("../src/styles.css");

test("sight-history-view.ts uses plain DOM and the stats helpers", () => {
  assert.ok(!hist.includes("innerHTML"));
  for (const s of ["createElementNS(", "trendChart(", "noteMapKeys(", "noteMap(", "weakest("]) {
    assert.ok(hist.includes(s), `missing ${s}`);
  }
});

test("sight-view.ts wires history, weights, ladder and the notice", () => {
  for (const s of ["renderSightHistory(", "noteWeights(", "roundsOfLevel(", "treeHasDrill(", "uv run coach sight add-drills"]) {
    assert.ok(view.includes(s), `missing ${s}`);
  }
  assert.ok(view.includes("fetchPlan"));
  assert.ok(view.includes("levelText(") && view.includes("isLocked("));
});

test("every class set in the history view and new view classes has a CSS rule", () => {
  const names = [
    ...[...hist.matchAll(/setAttribute\("class", "([^"]+)"\)/g)].map((m) => m[1]),
    ...[...hist.matchAll(/className = "([^"]+)"/g)].map((m) => m[1]),
    ...[...hist.matchAll(/svg\("[a-z]+", "([^"]+)"/g)].map((m) => m[1]),
    ...[...view.matchAll(/className = "(sight-level-state)"/g)].map((m) => m[1]),
    ...[...view.matchAll(/classList\.toggle\("(locked)"/g)].map((m) => m[1]),
    "nm-none", "nm-good", "nm-ok", "nm-weak",
  ];
  assert.ok(names.length > 10);
  for (const n of names.flatMap((x) => x.split(" ")).filter((x) => x !== "")) {
    assert.ok(css.includes(`.${n}`), `missing .${n}`);
  }
});

test("treeHasDrill finds a drill id in any node", () => {
  const tree = {
    version: 1,
    kind: "skills",
    decay_days: 30,
    tracks: [],
    nodes: [
      { id: "a", track: "t", title: "A", requires: [], drills: [] },
      { id: "b", track: "t", title: "B", requires: [], drills: [{ id: "d1" }] },
    ],
  } as unknown as PlanTree;
  assert.equal(treeHasDrill(tree, "d1"), true);
  assert.equal(treeHasDrill(tree, "nope"), false);
});
