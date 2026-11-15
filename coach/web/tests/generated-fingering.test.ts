import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fingerKey, fingerMap, loadGeneratedFingering, pickFinger } from "../src/generated-fingering.ts";
import type { FingerMap } from "../src/generated-fingering.ts";
import type { FetchLike } from "../src/api.ts";
import { buildTimeline } from "../src/score-timeline.ts";
import { fakeSheetFromMusicXml } from "./helpers/fake-osmd-sheet.ts";

const fixture = (name: string) => readFileSync(new URL("./fixtures/" + name, import.meta.url), "utf8");
const src = (name: string) => readFileSync(new URL("../src/" + name, import.meta.url), "utf8");

const URL_PATH = "/api/scores/pdmx%3A1/fingering";

function reply(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const pending = { status: "pending", source: null, notes: [], error: null };
const ready = {
  status: "ready",
  source: "x",
  notes: [
    { m: 0, q: 0, s: 0, p: 60, f: "1" },
    { m: 0, q: 1, s: 0, p: 62, f: "2" },
  ],
  error: null,
};

function fake(answers: unknown[]) {
  const calls: Array<[string, string | undefined]> = [];
  const fetchFn: FetchLike = async (url, init) => {
    calls.push([url, init?.method]);
    const a = answers.shift();
    if (a instanceof Error) throw a;
    return a as Awaited<ReturnType<FetchLike>>;
  };
  return { calls, fetchFn };
}

test("fingerKey rounds the beat to thousandths", () => {
  assert.equal(fingerKey(1, 0.5, 0, 74), "1|500|0|74");
  assert.equal(fingerKey(2, 1 / 3, 1, 60), fingerKey(2, 0.3333, 1, 60));
});

test("fingerMap skips bad entries and keeps the first of a duplicate key", () => {
  const map = fingerMap([
    { m: 0, q: 0, s: 0, p: 60, f: "1" },
    { m: 0, q: 0, s: 0, p: 60, f: "5" },
    { m: 0, q: 0, s: 0, p: 61 },
    { m: 0, q: 0, s: 0, p: 62, f: "  " },
    { m: "0", q: 0, s: 0, p: 63, f: "2" },
    null,
  ]);
  assert.equal(map.size, 1);
  assert.equal(map.get(fingerKey(0, 0, 0, 60)), "1");
  assert.equal(fingerMap(undefined).size, 0);
});

test("pickFinger prefers the written finger", () => {
  const map: FingerMap = new Map([["k", "1"]]);
  assert.equal(pickFinger("3", map, "k"), "3");
  assert.equal(pickFinger(null, map, "k"), "1");
  assert.equal(pickFinger(null, null, "k"), null);
  assert.equal(pickFinger(null, map, "other"), null);
});

test("python extractor fixture matches the timeline keys", () => {
  const xml = fixture("fingering_marks.musicxml");
  const notes = JSON.parse(fixture("fingering_marks.expected.json")).notes;
  const map = fingerMap(notes);
  const steps = buildTimeline(fakeSheetFromMusicXml(xml), { followRepeats: false });
  const parts: string[] = [];
  for (const step of steps) {
    for (const n of step.notes) {
      parts.push(`${step.measureIndex}/${step.beat}:${n.staff}:${n.midi}=${map.get(fingerKey(step.measureIndex, step.beat, n.staff, n.midi)) ?? "-"}`);
    }
  }
  assert.equal(
    parts.join(" "),
    "0/0:0:67=5 1/0:0:72=1 1/0:1:48=5 1/0.5:0:74=2 1/1:0:76=1 1/1:0:79=3 1/2:0:76=2 1/2:1:55=- 2/0:1:48=5 2/1:0:74=- 2/2:0:72=1",
  );
});

test("polls until ready", async () => {
  const { calls, fetchFn } = fake([reply(pending, 202), reply(pending), reply(ready)]);
  const sleeps: number[] = [];
  const maps: FingerMap[] = [];
  await loadGeneratedFingering("pdmx:1", {
    isCurrent: () => true,
    onReady: (m) => maps.push(m),
    fetchFn,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    warn: () => assert.fail("no warning expected"),
  });
  assert.equal(maps.length, 1);
  assert.equal(maps[0].size, 2);
  assert.deepEqual(sleeps, [3000, 3000]);
  assert.deepEqual(calls, [
    [URL_PATH, "POST"],
    [URL_PATH, undefined],
    [URL_PATH, undefined],
  ]);
});

test("ready on the POST needs no sleep", async () => {
  const { fetchFn } = fake([reply(ready)]);
  let ok = 0;
  await loadGeneratedFingering("pdmx:1", {
    isCurrent: () => true,
    onReady: () => ok++,
    fetchFn,
    sleep: async () => assert.fail("no sleep expected"),
  });
  assert.equal(ok, 1);
});

test("error status warns with the reason", async () => {
  const { fetchFn } = fake([reply({ status: "error", source: null, notes: [], error: "boom" })]);
  const warns: string[] = [];
  let ok = 0;
  await loadGeneratedFingering("pdmx:1", { isCurrent: () => true, onReady: () => ok++, fetchFn, warn: (m) => warns.push(m) });
  assert.equal(warns.length, 1);
  assert.match(warns[0], /boom/);
  assert.equal(ok, 0);
});

test("a throwing fetch warns and resolves", async () => {
  const { fetchFn } = fake([new Error("down")]);
  const warns: string[] = [];
  await loadGeneratedFingering("pdmx:1", { isCurrent: () => true, onReady: () => {}, fetchFn, warn: (m) => warns.push(m) });
  assert.equal(warns.length, 1);
});

test("stops when the score is no longer current", async () => {
  const { calls, fetchFn } = fake([reply(pending, 202), reply(ready)]);
  let current = true;
  let ok = 0;
  await loadGeneratedFingering("pdmx:1", {
    isCurrent: () => current,
    onReady: () => ok++,
    fetchFn,
    sleep: async () => {
      current = false;
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(ok, 0);
});

test("gives up after maxPolls", async () => {
  const { calls, fetchFn } = fake([reply(pending, 202), reply(pending), reply(pending), reply(pending)]);
  const warns: string[] = [];
  await loadGeneratedFingering("pdmx:1", {
    isCurrent: () => true,
    onReady: () => assert.fail("not ready"),
    fetchFn,
    sleep: async () => {},
    warn: (m) => warns.push(m),
    maxPolls: 2,
  });
  assert.equal(warns.length, 1);
  assert.match(warns[0], /giving up/);
  assert.equal(calls.filter((c) => c[1] === undefined).length, 2);
});

test("an HTTP 404 warns with the server message", async () => {
  const { fetchFn } = fake([reply({ error: "score file not found" }, 404)]);
  const warns: string[] = [];
  await loadGeneratedFingering("pdmx:1", { isCurrent: () => true, onReady: () => {}, fetchFn, warn: (m) => warns.push(m) });
  assert.equal(warns.length, 1);
  assert.match(warns[0], /score file not found/);
});

test("wiring in score-view and main", () => {
  const view = src("score-view.ts");
  const main = src("main.ts");
  assert.match(view, /pickFinger\(fingerText\(n\.ref\)/);
  assert.match(view, /setGeneratedFingering\(/);
  assert.match(view, /generated fingering matched no note of this score/);
  assert.match(main, /loadGeneratedFingering\(score\.id/);
  assert.match(main, /view\.setGeneratedFingering\(/);
});
