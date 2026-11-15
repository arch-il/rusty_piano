import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const main = readFileSync(fileURLToPath(new URL("../src/main.ts", import.meta.url)), "utf8");

test("main.ts listens for hash changes and uses parseRoute", () => {
  assert.ok(main.includes('addEventListener("hashchange"'));
  assert.ok(main.includes("parseRoute("));
});

test("main.ts calls fetchScore exactly once", () => {
  assert.equal(main.split("fetchScore(").length - 1, 1);
});

test("openFromHash checks the token after fetching", () => {
  const start = main.indexOf("async function openFromHash(");
  assert.ok(start >= 0);
  const body = main.slice(start, main.indexOf("\n}\n", start));
  const fetchAt = body.indexOf("fetchScore(");
  assert.ok(fetchAt > 0);
  assert.ok(body.indexOf("mine !== token", fetchAt) > fetchAt);
});

test("openFromHash clears currentId in its catch branch", () => {
  const start = main.indexOf("async function openFromHash(");
  assert.ok(start >= 0);
  const body = main.slice(start, main.indexOf("\n}\n", start));
  const catchAt = body.indexOf("} catch (e) {");
  assert.ok(catchAt > 0);
  assert.ok(body.indexOf("currentId = null", catchAt) > catchAt);
});

test("startup opens the hash score through openFromHash", () => {
  assert.ok(main.includes("applyRoute(location.hash)"));
  assert.ok(main.includes("openFromHash(route.id, route.link)"));
});

test("drill links tag attempts, select the range and write the hash", () => {
  assert.ok(main.includes("drill: activeDrill"));
  assert.ok(main.includes("view.selectRange("));
  assert.ok(main.includes("drillHash(score.id, link)"));
  assert.ok(main.includes("activeDrill = null"));
  const sv = readFileSync(fileURLToPath(new URL("../src/score-view.ts", import.meta.url)), "utf8");
  assert.ok(sv.includes("selectRange("));
});

const html = readFileSync(fileURLToPath(new URL("../index.html", import.meta.url)), "utf8");
const topbarSrc = readFileSync(fileURLToPath(new URL("../src/topbar.ts", import.meta.url)), "utf8");
const css = readFileSync(fileURLToPath(new URL("../src/styles.css", import.meta.url)), "utf8");

test("main.ts wires the follower", () => {
  for (const s of ["createFollower(", "createWaitMatcher", "createLiveMatcher", "practicePlan", "follower.handle(ev)", "follower.tick()", "requestAnimationFrame(", "onFollowToggle", "timelineSummary(", "barRuns(", "stopFollowing()", "loadSettings(", "follower-settings.json", "createAutoplayer(", "autoplaySchedule(", "createSound(", "countInClicks(", "summaryRows(", "metricTexts(", "followOptions("]) {
    assert.ok(main.includes(s), s);
  }
});

test("Escape stops the follower", () => {
  assert.ok(main.includes("Escape"));
  assert.ok(main.includes("follower.stop()"));
});

test("openScore and openFromHash stop following before any await", () => {
  for (const name of ["openScore", "openFromHash"]) {
    const start = main.indexOf("async function " + name + "(");
    assert.ok(start >= 0);
    const body = main.slice(start, main.indexOf("\n}\n", start));
    const stopAt = body.indexOf("stopFollowing()");
    assert.ok(stopAt >= 0);
    assert.ok(stopAt < body.indexOf("await "));
  }
});

test("follow controls exist in html, topbar and css", () => {
  assert.ok(html.includes('id="follow-toggle"'));
  assert.ok(html.includes('id="follow-status"'));
  for (const s of ['"follow-toggle"', '"follow-status"', "setFollow"]) assert.ok(topbarSrc.includes(s), s);
  assert.ok(css.includes(".follow-controls {"));
  assert.ok(css.includes(".follow-status {"));
});

function fnBody(src: string, header: string): string {
  const start = src.indexOf(header);
  assert.ok(start >= 0, header);
  return src.slice(start, src.indexOf("\n}\n", start));
}

test("runs silence the sound engine on stop, start and done", () => {
  for (const h of ["function stopRun(", "function stopFollowing(", "function startRun("]) {
    assert.ok(fnBody(main, h).includes("sound.stopAll()"), h);
  }
  const done = fnBody(main, "follower.onStatus(");
  assert.ok(done.includes('s.state === "done"'));
  assert.ok(!done.includes("sound.stopAll()"));
});

test("only wait-mode autoplay shifts to now", () => {
  const body = fnBody(main, "function startAutoplay(");
  assert.ok(body.includes("shiftToNow: true"));
  const elseAt = body.indexOf("} else {");
  assert.ok(elseAt > 0);
  assert.ok(!body.slice(0, elseAt).includes("shiftToNow"));
  assert.ok(body.slice(elseAt).includes("shiftToNow: true"));
});

test("main.ts wires jumps, tempo and holds", () => {
  for (const s of ["createTempoMap", "createHoldChecker", "tempoSummary(", "barRuns(view.timeline())", "metricTexts(s.counts, s.bpm)", "follower.tempo()", "shiftedMsAt(", "zoomRedrawMs", "followJumps", '"follow tempo"', '"follow jumps"']) {
    assert.ok(main.includes(s), s);
  }
  assert.ok(!main.includes("unsupportedJumps"));
  assert.ok(main.includes('if (follower.status().state === "done") follower.stop();'));
});

test("stops reset the octave and the follower", () => {
  const sf = fnBody(main, "function stopFollowing(");
  assert.ok(sf.includes("follower.reset()"));
  assert.ok(sf.includes("resetOctave()"));
  assert.ok(fnBody(main, "function stopRun(").includes("resetOctave()"));
  assert.ok(fnBody(main, "follower.onStatus(").includes("resetOctave()"));
  assert.ok(fnBody(main, "function startAutoplay(").includes("follower.tempo()"));
});

test("autoplay off drops open holds before the auto-player stops", () => {
  const body = main.slice(main.indexOf("onAutoplayToggle:"), main.indexOf("onSummaryAgain:"));
  assert.ok(body.includes("follower.dropHolds()"));
  assert.ok(body.indexOf("follower.dropHolds()") < body.indexOf("autoplayer.stop()"));
});

test("stopRun stops the follower before the auto-player", () => {
  const body = fnBody(main, "function stopRun(");
  assert.ok(body.indexOf("follower.stop()") < body.indexOf("autoplayer.stop()"));
});

test("summary closes the practice panel and the toggle hides the summary", () => {
  const a = topbarSrc.indexOf("showSummary(titleText, rows) {");
  assert.ok(topbarSrc.slice(a, topbarSrc.indexOf("hideSummary()", a)).includes("closePractice()"));
  const b = topbarSrc.indexOf('practiceToggle.addEventListener("click"');
  assert.ok(topbarSrc.slice(b, topbarSrc.indexOf("});", b)).includes("summaryPanel.hidden = true"));
});

test("main.ts creates the piano view and passes onNoteHover", () => {
  assert.ok(main.includes("new PianoView("));
  assert.ok(main.includes('"piano-view"'));
  assert.ok(main.includes("onNoteHover"));
});

test("score-view.ts emits note hover from mouse events", () => {
  const sv = readFileSync(fileURLToPath(new URL("../src/score-view.ts", import.meta.url)), "utf8");
  assert.ok(sv.includes('"mousemove"'));
  assert.ok(sv.includes('"mouseleave"'));
  assert.ok(sv.includes("onNoteHover"));
  assert.ok(sv.includes("hover-line"));
});

test("main.ts reads the fs override only in a dev branch", () => {
  assert.equal(main.split('"fs"').length - 1, 1);
  assert.ok(/if \(import\.meta\.env\.DEV\) \{[^}]*get\("fs"\)/.test(main));
  assert.ok(main.includes("loadSettings(settingsJson)"));
});

test("main.ts wires the attempt recorder", () => {
  for (const s of [
    "createAttemptRecorder(",
    "follower.onResult(",
    "recorder.event(ev, performance.now())",
    "recorder.begin(",
    "postAttempt(",
    'saveAttempt("done")',
    "Attempt not saved: ",
  ]) {
    assert.ok(main.includes(s), s);
  }
});

test("attempt saves happen before the run is torn down", () => {
  const done = main.slice(main.indexOf('s.state === "done") {'));
  assert.ok(done.indexOf('saveAttempt("done")') < done.indexOf("autoplayer.stop()"));
  const stop = fnBody(main, "function stopRun(");
  assert.ok(stop.indexOf("follower.stop()") < stop.indexOf('saveAttempt("stop")'));
  assert.ok(stop.indexOf('saveAttempt("stop")') < stop.indexOf("autoplayer.stop()"));
  const ff = fnBody(main, "function stopFollowing(");
  assert.ok(ff.indexOf('saveAttempt("interrupted")') < ff.indexOf("follower.reset()"));
});

test("index.html has the toast element", () => {
  assert.ok(html.includes('id="toast"'));
});
