import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ApiError, fetchScores, onServerReach, SERVER_UNREACHABLE_MESSAGE } from "../src/api.ts";
import { createReachState } from "../src/server-status.ts";

test("createReachState tracks changes only", () => {
  const state = createReachState();
  const calls: boolean[] = [];
  state.onChange((down) => calls.push(down));
  assert.equal(state.down(), false);
  state.report(false);
  assert.equal(state.down(), true);
  assert.deepEqual(calls, [true]);
  state.report(false);
  assert.deepEqual(calls, [true]);
  state.report(true);
  assert.deepEqual(calls, [true, false]);
  assert.equal(state.down(), false);
});

test("api reports reachability", async () => {
  assert.equal(SERVER_UNREACHABLE_MESSAGE, "Coach server not reachable.");
  const seen: boolean[] = [];
  onServerReach((ok) => seen.push(ok));
  try {
    await assert.rejects(
      fetchScores({}, async () => {
        throw new Error("down");
      }),
      (e: unknown) => e instanceof ApiError && e.message === SERVER_UNREACHABLE_MESSAGE && e.status === 0,
    );
    await fetchScores({}, async () => ({
      ok: true,
      status: 200,
      json: async () => ({ scores: [], total: 0, facets: { keys: [], times: [], difficulties: [] }, sources: [] }),
    }));
    await assert.rejects(
      fetchScores({}, async () => ({ ok: false, status: 404, json: async () => ({ error: "nope" }) })),
      (e: unknown) => e instanceof ApiError && e.message === "nope",
    );
    await assert.rejects(
      fetchScores({}, async () => ({
        ok: false,
        status: 500,
        json: async () => {
          throw new Error("not json");
        },
      })),
      (e: unknown) => e instanceof ApiError && e.message === SERVER_UNREACHABLE_MESSAGE,
    );
    assert.deepEqual(seen, [false, true, true, false]);
  } finally {
    onServerReach(null);
  }
});

test("banner wiring", () => {
  const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  for (const s of ["onServerReach(", "createReachState(", '"server-banner"', '"server-retry"', "function retryLoad", "skills.show()", "logView.show()", "error === SERVER_UNREACHABLE_MESSAGE"]) {
    assert.ok(main.includes(s), s);
  }
  assert.ok(main.indexOf("onServerReach(") < main.indexOf("const startRoute"));
  assert.ok(html.includes('id="server-banner"'));
  assert.ok(html.includes('id="server-retry"'));
  assert.ok(html.includes("<code>uv run coach serve</code>"));
  assert.match(html, /<div id="server-banner"[^>]*\shidden/);
  assert.ok(css.includes(".server-banner {"));
  assert.ok(css.includes(".server-banner[hidden]"));
  assert.ok(css.indexOf(".server-banner {") < css.indexOf("/* ===== Top bar responsive"));
});
