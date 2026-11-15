import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const main = read("../src/main.ts");
const view = read("../src/log-view.ts");
const css = read("../src/styles.css");

function fnBody(src: string, start: string): string {
  const i = src.indexOf(start);
  assert.ok(i >= 0, "missing " + start);
  const j = src.indexOf("\n}\n", i);
  return src.slice(i, j < 0 ? undefined : j);
}

test("replay route wiring", () => {
  assert.ok(main.includes('route.kind === "replay"'));
  assert.ok(main.includes("replayFromRoute(route.attemptId)"));
  assert.ok(main.includes("fetchAttempt("));
  const body = fnBody(main, "async function replayFromRoute(");
  for (const s of ["openFromHash(", "replay.playAttempt(", "showToast(", "replayHash(attemptId)"]) {
    assert.ok(body.includes(s), s);
  }
  assert.ok(body.includes("drillHash("));
  const opened = body.indexOf("openFromHash(");
  const play = body.indexOf("replay.playAttempt(");
  const guard = Math.max(body.indexOf("logView.visible()", opened), body.indexOf("skills.visible()", opened));
  assert.ok(guard > opened && guard < play, "route re-check between open and play");
  assert.equal(main.split("fetchScore(").length - 1, 1);
  assert.ok(view.includes("replayHash("));
  assert.ok(view.includes("'log-run-replay'"));
  assert.ok(css.includes(".log-run-replay"));
});
