import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const html = read("../index.html");
const main = read("../src/main.ts");
const view = read("../src/replay-view.ts");
const css = read("../src/styles.css");

function fnBody(src: string, header: string): string {
  const start = src.indexOf(header);
  assert.ok(start >= 0, `missing ${header}`);
  const end = src.indexOf("\n}\n", start);
  return src.slice(start, end < 0 ? undefined : end);
}

test("index.html has the replay ids", () => {
  for (const id of [
    "replay-toggle",
    "replay-menu",
    "replay-menu-status",
    "replay-attempts",
    "summary-replay",
    "replay-bar",
    "replay-label",
    "replay-time",
    "replay-pause",
    "replay-stop",
    "replay-speed",
    "replay-mute",
  ]) {
    assert.ok(html.includes(`id="${id}"`), `missing #${id}`);
  }
  const at = html.indexOf('id="summary-replay"');
  assert.ok(at > html.indexOf('class="summary-actions"'));
  assert.ok(at < html.indexOf('id="summary-again"'));
});

test("replay-view.ts uses the replay pieces and never publishes", () => {
  for (const s of [
    "createReplayPlayer(",
    "attemptScript(",
    "fetchReplayAttempts(",
    "fetchAttempt(",
    "slideNeedle(",
    "markStep(",
    "flashWrong(",
    "markShort(",
    "clearMarks(",
    "setFollowing(",
    "sound.note(",
    "createLiveKeys(",
    "function startScript(",
  ]) {
    assert.ok(view.includes(s), `missing ${s}`);
  }
  assert.ok(!view.includes("innerHTML"));
  assert.ok(!view.includes("publish("));
});

test("every replay class has a rule in styles.css", () => {
  const names = new Set<string>();
  for (const m of view.matchAll(/className = '([^']+)'/g)) names.add(m[1]);
  assert.ok(names.size > 0);
  for (const m of html.matchAll(/class="(replay[^" ]*)/g)) names.add(m[1]);
  for (const n of names) assert.ok(css.includes("." + n), `missing .${n}`);
});

test("main.ts wires the replay view", () => {
  const at = main.indexOf("const replay = createReplayView(");
  assert.ok(at > main.indexOf("const autoplayer = createAutoplayer("));
  assert.ok(at < main.indexOf("function running()"));
  assert.equal(main.split("piano.showLive(").length - 1, 1);
  const keys = fnBody(main, "function renderKeys(");
  assert.ok(keys.includes("replay.held()") && keys.includes("replay.sustain()"));
  assert.ok(fnBody(main, "function startRun(").includes("replay.stop()"));
  assert.ok(fnBody(main, "function startRun(").includes("replay.setLastAttempt(null)"));
  assert.ok(view.includes(".catch(") && view.includes("Could not replay this run"));
  const stopping = fnBody(main, "function stopFollowing(");
  assert.ok(stopping.includes("replay.stop()") && stopping.includes("replay.setLastAttempt(null)"));
  for (const s of ["replay.setLastAttempt(attempt)", "replay.setEnabled(", "replay.active()", "replay.closeMenu()"]) {
    assert.ok(main.includes(s), `missing ${s}`);
  }
  for (const line of main.split("\n")) {
    assert.ok(!(line.includes("replay") && line.includes("engine.publish")), line);
  }
});

test("an empty run shows a readable message", () => {
  assert.ok(view.includes("This run has no recorded notes to replay."));
});

test("the replay menu lists session recordings", () => {
  assert.ok(html.includes('id="replay-sessions"'));
  for (const s of ["fetchReplaySessions(", "fetchSessionReplay(", "sessionScript(", "function pickSession("]) {
    assert.ok(view.includes(s), `missing ${s}`);
  }
});
