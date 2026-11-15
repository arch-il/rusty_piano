import assert from "node:assert/strict";
import { test } from "node:test";
import { drillOrder, isDrill, tabCounts, tabLabel, tabScores } from "../src/library-logic.ts";

function sc(id: string, source: string): any {
  return { id, source, title: id };
}

const plan: any = {
  tree: {
    nodes: [
      { id: "R1", drills: [{ score: "gen:a" }, { score: "gen:b" }] },
      { id: "R2", drills: [{ score: "gen:b" }, { score: "gen:c" }] },
    ],
  },
};

test("isDrill", () => {
  assert.equal(isDrill(sc("x", "gen")), true);
  assert.equal(isDrill(sc("x", "scales")), true);
  assert.equal(isDrill(sc("x", "pdmx")), false);
  assert.equal(isDrill(sc("x", "local")), false);
});

test("drillOrder walks nodes, first occurrence wins", () => {
  const o = drillOrder(plan);
  assert.deepEqual([...o], [["gen:a", 0], ["gen:b", 1], ["gen:c", 2]]);
  assert.equal(drillOrder(null).size, 0);
  assert.equal(drillOrder({} as any).size, 0);
});

test("tabScores", () => {
  const all = [sc("p2", "local"), sc("gen:z", "gen"), sc("gen:c", "gen"), sc("p1", "pdmx"), sc("gen:a", "gen"), sc("gen:y", "scales")];
  const o = drillOrder(plan);
  assert.deepEqual(tabScores(all, "pieces", o).map((s) => s.id), ["p2", "p1"]);
  assert.deepEqual(tabScores(all, "drills", o).map((s) => s.id), ["gen:a", "gen:c", "gen:y", "gen:z"]);
});

test("tabCounts and tabLabel", () => {
  const all = [sc("p", "local"), sc("gen:a", "gen"), sc("gen:b", "gen")];
  assert.deepEqual(tabCounts(all), { pieces: 1, drills: 2 });
  assert.equal(tabLabel("pieces", 12), "Pieces (12)");
  assert.equal(tabLabel("drills", 30), "Drills (30)");
});
