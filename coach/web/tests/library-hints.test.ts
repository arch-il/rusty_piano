import { test } from "node:test";
import assert from "node:assert/strict";
import { listHint } from "../src/library-logic.ts";
import type { ScoreList } from "../src/api.ts";

function list(extra: Partial<ScoreList>): ScoreList {
  return { scores: [], total: 0, facets: {} as ScoreList["facets"], sources: [], ...extra };
}

test("capped search shows the count", () => {
  assert.equal(listHint(list({ capped: true }), 500, true), "Showing the first 500 matches; type more to narrow the search.");
});

test("hidden scales explained when list is empty", () => {
  assert.equal(
    listHint(list({ hidden: 972 }), 0, false),
    "Generated scales (972) are hidden here; type in the search box or open the Scales page.",
  );
});

test("no hint otherwise", () => {
  assert.equal(listHint(list({ hidden: 5 }), 3, false), "");
  assert.equal(listHint(list({ hidden: 5 }), 0, true), "");
  assert.equal(listHint(list({}), 0, false), "");
});

test("capped hint is not shown on a tab with 0 rows", () => {
  assert.equal(listHint(list({ capped: true }), 0, true), "");
});
