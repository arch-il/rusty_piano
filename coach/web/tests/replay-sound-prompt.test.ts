import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createSound } from "../src/web-audio.ts";
import { soundPromptVisible } from "../src/sound-prompt.ts";

const base = { audio: "suspended", muted: false, active: true, posMs: 300 };

test("soundPromptVisible shows only when active, unmuted, suspended and past the delay", () => {
  assert.equal(soundPromptVisible(base), true);
  assert.equal(soundPromptVisible({ ...base, posMs: 299 }), false);
  assert.equal(soundPromptVisible({ ...base, audio: "running" }), false);
  assert.equal(soundPromptVisible({ ...base, audio: "none" }), false);
  assert.equal(soundPromptVisible({ ...base, muted: true }), false);
  assert.equal(soundPromptVisible({ ...base, active: false }), false);
});

const ctxs: FakeCtx[] = [];

class FakeCtx {
  state = "suspended";
  currentTime = 0;
  destination = {};
  constructor() {
    ctxs.push(this);
  }
  resume() {
    return Promise.resolve();
  }
}

const g = globalThis as unknown as { window?: unknown };
g.window = { AudioContext: FakeCtx };
after(() => {
  delete g.window;
});

test("state is none until audio is first used, then mirrors the context", () => {
  ctxs.length = 0;
  const sound = createSound();
  assert.equal(sound.state(), "none");
  assert.equal(ctxs.length, 0);
  sound.resume();
  assert.equal(sound.state(), "suspended");
  ctxs[0].state = "running";
  assert.equal(sound.state(), "running");
});

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const replayView = readFileSync(new URL("../src/replay-view.ts", import.meta.url), "utf8");

test("index.html has a hidden replay-sound button inside the replay bar", () => {
  const bar = html.indexOf('id="replay-bar"');
  const at = html.indexOf('id="replay-sound"');
  const end = html.indexOf("</div>", bar);
  assert.ok(bar >= 0 && at > bar && at < end);
  const tag = html.slice(html.lastIndexOf("<button", at), html.indexOf(">", at) + 1);
  assert.match(tag, /\shidden[\s>]/);
});

test("replay-view.ts wires the sound prompt", () => {
  for (const s of ["'replay-sound'", "soundPromptVisible(", "sound.state", "'pointerdown'", "state?.() !== 'suspended'"]) {
    assert.ok(replayView.includes(s), s);
  }
  const i = replayView.indexOf("progress(pos, dur) {");
  const body = replayView.slice(i, replayView.indexOf("},", i));
  assert.ok(body.includes("checkSound();"));
});
