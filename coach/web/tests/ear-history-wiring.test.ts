import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ApiError, earHistoryUrl, fetchEarHistory } from "../src/api.ts";
import type { FetchLike } from "../src/api.ts";
import type { EarHistory } from "../src/ear-levels.ts";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const hist = read("../src/ear-history-view.ts");
const api = read("../src/api.ts");

const sample: EarHistory = {
  rounds: [
    {
      id: "attempt-20261106-200000-aaaaaa",
      started_at: "2026-11-06T20:00:00.000Z",
      level: "echo-1",
      drill_id: "ear.echo-1",
      end: "done",
      accuracy: 0.5,
      median_step_ms: 1000,
      replays: 0,
      items: [{ category: "Pitch", first_try: true, response_ms: 900, answer_steps: 1, replays: 0, revealed: false }],
    },
  ],
};

test("ear-history-view.ts uses plain DOM, the trend chart and the category table", () => {
  assert.ok(!hist.includes("innerHTML"));
  for (const s of ["createElementNS(", "trendChart(", "categoryStats(", "uv run coach ear add-drills"]) {
    assert.ok(hist.includes(s), `missing ${s}`);
  }
});

test("api.ts exposes the ear history fetch on the history url", () => {
  assert.ok(api.includes("fetchEarHistory"));
  assert.ok(api.includes("/api/ear/history"));
});

test("earHistoryUrl gives the bare url for null and the encoded level otherwise", () => {
  assert.equal(earHistoryUrl("echo-1"), "/api/ear/history?level=echo-1");
  assert.equal(earHistoryUrl(null), "/api/ear/history");
});

test("fetchEarHistory requests the url and returns the parsed body", async () => {
  const seen: string[] = [];
  const fake: FetchLike = async (url) => {
    seen.push(url);
    return { ok: true, status: 200, json: async () => sample };
  };
  const result = await fetchEarHistory("echo-1", fake);
  assert.deepEqual(seen, ["/api/ear/history?level=echo-1"]);
  assert.deepEqual(result, sample);
});

test("fetchEarHistory with a thrown fetch throws an ApiError", async () => {
  const rejecting: FetchLike = async () => {
    throw new TypeError("fetch failed");
  };
  await assert.rejects(fetchEarHistory(null, rejecting), ApiError);
});
