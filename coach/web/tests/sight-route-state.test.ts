import { test } from "node:test";
import assert from "node:assert/strict";
import { nextShow, paramsAfterPick } from "../src/sight-route-state.ts";

const known = (id: string) => id === "r2-treble" || id === "r3-bass" || id === "custom";

test("null level on a visible view keeps the level and does not interrupt", () => {
  const r = nextShow({ visible: true, running: true, selectedId: "r3-bass" }, { level: null }, known);
  assert.deepEqual(r, { selectedId: "r3-bass", interrupt: false, unknown: null });
});

test("null level on a hidden view selects r2-treble", () => {
  const r = nextShow({ visible: false, running: false, selectedId: "r3-bass" }, { level: null }, known);
  assert.deepEqual(r, { selectedId: "r2-treble", interrupt: false, unknown: null });
});

test("unknown level selects r2-treble and reports it", () => {
  const r = nextShow({ visible: true, running: false, selectedId: "r3-bass" }, { level: "nope" }, known);
  assert.deepEqual(r, { selectedId: "r2-treble", interrupt: false, unknown: "nope" });
});

test("known level is selected", () => {
  const r = nextShow({ visible: false, running: false, selectedId: "r2-treble" }, { level: "r3-bass" }, known);
  assert.deepEqual(r, { selectedId: "r3-bass", interrupt: false, unknown: null });
});

test("interrupts only when running and the level differs", () => {
  const diff = nextShow({ visible: true, running: true, selectedId: "r2-treble" }, { level: "r3-bass" }, known);
  assert.equal(diff.interrupt, true);
  const same = nextShow({ visible: true, running: true, selectedId: "r3-bass" }, { level: "r3-bass" }, known);
  assert.equal(same.interrupt, false);
  const idle = nextShow({ visible: true, running: false, selectedId: "r2-treble" }, { level: "r3-bass" }, known);
  assert.equal(idle.interrupt, false);
});

test("paramsAfterPick drops plan, tags and custom fields for another level", () => {
  const p = { level: "r2-treble", plan: "p1", tags: ["a"], drill: "x.y", clef: "bass" as const, low: 40, high: 60, acc: true };
  assert.deepEqual(paramsAfterPick(p, "r3-bass"), { level: "r3-bass" });
});

test("paramsAfterPick keeps everything for the same level", () => {
  const p = { level: "r3-bass", plan: "p1", tags: ["a"] };
  assert.deepEqual(paramsAfterPick(p, "r3-bass"), { level: "r3-bass", plan: "p1", tags: ["a"] });
});
