import assert from "node:assert/strict";
import { test } from "node:test";
import { MIN_SOURCE_QUERY, searchesSources } from "../src/source-query.ts";

test("MIN_SOURCE_QUERY is 2", () => {
  assert.equal(MIN_SOURCE_QUERY, 2);
});

test("short or punctuation-only queries do not search sources", () => {
  for (const q of ["", "a", "  x  ", "!!", "é", "a!"]) assert.equal(searchesSources(q), false, q);
});

test("two word characters search sources", () => {
  for (const q of ["ab", "a b", "12", "éa", "hymn"]) assert.equal(searchesSources(q), true, q);
});
