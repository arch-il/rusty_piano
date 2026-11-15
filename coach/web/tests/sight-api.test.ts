import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ApiError,
  SERVER_UNREACHABLE_MESSAGE,
  fetchSightHistory,
  sightHistoryUrl,
} from "../src/api.ts";
import type { FetchLike } from "../src/api.ts";
import type { SightHistory } from "../src/sight-levels.ts";

const sample: SightHistory = {
  rounds: [
    {
      id: "attempt-20261106-200000-aaaaaa",
      started_at: "2026-11-06T20:00:00.000Z",
      level: "r2-treble",
      drill_id: null,
      end: "done",
      accuracy: 0.5,
      median_ms: 1000,
      steps: [{ notes: [60], first_try: true, reaction_ms: 900, hinted: false, wrong_count: 0 }],
    },
  ],
};

test("sightHistoryUrl gives the bare url when the level is null or empty", () => {
  assert.equal(sightHistoryUrl(null), "/api/sight/history");
  assert.equal(sightHistoryUrl(""), "/api/sight/history");
});

test("sightHistoryUrl adds the encoded level as a query", () => {
  assert.equal(sightHistoryUrl("r2-treble"), "/api/sight/history?level=r2-treble");
  assert.equal(sightHistoryUrl("a b&c"), "/api/sight/history?level=a%20b%26c");
});

test("fetchSightHistory requests the url and returns the parsed body", async () => {
  const seen: string[] = [];
  const fake: FetchLike = async (url) => {
    seen.push(url);
    return { ok: true, status: 200, json: async () => sample };
  };
  const result = await fetchSightHistory("r3-bass", fake);
  assert.deepEqual(seen, ["/api/sight/history?level=r3-bass"]);
  assert.deepEqual(result, sample);
});

test("fetchSightHistory with a 400 JSON error throws that message and status", async () => {
  const badRequest: FetchLike = async () => ({
    ok: false,
    status: 400,
    json: async () => ({ error: "level must be a short lowercase id like r2-treble" }),
  });
  await assert.rejects(fetchSightHistory("Bad!", badRequest), (err: unknown) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.message, "level must be a short lowercase id like r2-treble");
    assert.equal(err.status, 400);
    return true;
  });
});

test("fetchSightHistory with a thrown fetch throws the unreachable message", async () => {
  const rejecting: FetchLike = async () => {
    throw new TypeError("fetch failed");
  };
  await assert.rejects(fetchSightHistory(null, rejecting), (err: unknown) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.message, SERVER_UNREACHABLE_MESSAGE);
    return true;
  });
});
