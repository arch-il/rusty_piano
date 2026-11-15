import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createLiveKeys } from "../src/live-keys.ts";

const main = readFileSync(fileURLToPath(new URL("../src/main.ts", import.meta.url)), "utf8").replace(/\r\n/g, "\n");

function fnBody(src: string, header: string): string {
  const start = src.indexOf(header);
  assert.ok(start >= 0, header);
  return src.slice(start, src.indexOf("\n}\n", start));
}

test("stopAutoplay stops the auto-player and releases its keys", () => {
  const body = fnBody(main, "function stopAutoplay(");
  assert.ok(body.includes("autoplayer.stop()"));
  assert.ok(body.indexOf("autoplayer.stop()") < body.indexOf('liveKeys.releaseSource("autoplay")'));
  assert.ok(body.includes("renderKeys()"));
});

test("autoplayer.stop() is called only inside stopAutoplay", () => {
  assert.equal(main.split("autoplayer.stop()").length - 1, 1);
});

test("run stop paths and autoplay off use stopAutoplay", () => {
  for (const h of ["function startRun(", "function stopRun(", "function stopFollowing("]) {
    assert.ok(fnBody(main, h).includes("stopAutoplay()"), h);
  }
  const toggle = main.slice(main.indexOf("onAutoplayToggle:"), main.indexOf("onSummaryAgain:"));
  assert.ok(toggle.includes("stopAutoplay()"));
  const status = main.slice(main.indexOf("follower.onStatus("), main.indexOf("\n});", main.indexOf("follower.onStatus(")));
  assert.ok(status.includes("stopAutoplay()"));
});

test("the live-keys listener is registered before the follower listener", () => {
  assert.ok(main.indexOf("liveKeys.apply(ev)") < main.indexOf("follower.handle(ev)"));
});

test("live keys: an auto-play release clears only the auto-play key", () => {
  const keys = createLiveKeys();
  keys.apply({ type: "note_on", t: 0, note: 60, velocity: 80, source: "autoplay" } as never);
  keys.apply({ type: "note_on", t: 0, note: 64, velocity: 80, source: "engine" } as never);
  assert.equal(keys.releaseSource("autoplay"), true);
  assert.deepEqual(keys.held(), [64]);
});

test("live keys: an auto-play note_on then note_off leaves nothing held", () => {
  const keys = createLiveKeys();
  keys.apply({ type: "note_on", t: 0, note: 60, velocity: 80, source: "autoplay" } as never);
  keys.apply({ type: "note_off", t: 10, note: 60, source: "autoplay" } as never);
  assert.deepEqual(keys.held(), []);
});
