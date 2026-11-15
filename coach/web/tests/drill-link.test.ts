import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { clampTempo, drillHash, linkDrill, parseRoute, replayHash } from "../src/drill-link.ts";
import type { DrillParams } from "../src/drill-link.ts";

type Entry = { name: string; score: string; params: DrillParams; hash: string };

const fixture: Entry[] = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/drill-links.json", import.meta.url)), "utf8"),
);

function linkOf(hash: string): DrillParams | null {
  const { route } = parseRoute(hash);
  if (route.kind !== "score") throw new Error("not a score route: " + hash);
  return route.link;
}

test("every fixture entry builds its hash", () => {
  for (const e of fixture) assert.equal(drillHash(e.score, e.params), e.hash, e.name);
});

test("every fixture hash parses back to its score and params", () => {
  for (const e of fixture) {
    const { route, warnings } = parseRoute(e.hash);
    assert.deepEqual(warnings, [], e.name);
    assert.deepEqual(route, { kind: "score", id: e.score, link: e.name === "no params" ? null : e.params }, e.name);
  }
});

test("skills and empty hashes", () => {
  assert.deepEqual(parseRoute("#/skills").route, { kind: "skills" });
  assert.deepEqual(parseRoute("#/skills/").route, { kind: "skills" });
  assert.deepEqual(parseRoute("").route, { kind: "none" });
  assert.deepEqual(parseRoute("#").route, { kind: "none" });
  assert.deepEqual(parseRoute("#nope").route, { kind: "none" });
});

test("form A score hash without params", () => {
  assert.deepEqual(parseRoute("#score=local%3Aabc").route, { kind: "score", id: "local:abc", link: null });
});

test("form A score hash with params", () => {
  assert.deepEqual(linkOf("#score=local%3Aabc&hands=L"), { hands: "left" });
});

test("bad values are skipped with a warning", () => {
  const cases: [string, string][] = [
    ["hands=X", "hands"],
    ["bars=5-3", "bars"],
    ["tempo=0", "tempo"],
    ["tempo=abc", "tempo"],
    ["tag=Fun!", "tag"],
    ["ramp=x", "ramp"],
    ["target=0", "target"],
    ["target=301", "target"],
  ];
  for (const [q, name] of cases) {
    const { route, warnings } = parseRoute("#score=local%3Aabc&" + q);
    assert.equal(route.kind, "score", q);
    assert.equal(warnings.length, 1, q);
    assert.ok(warnings[0].includes("'" + name + "'"), q);
    assert.deepEqual(linkOf("#score=local%3Aabc&" + q), {}, q);
  }
});

test("ramp and target parse", () => {
  assert.deepEqual(linkOf("#local:abc?ramp=0"), { ramp: false });
  assert.deepEqual(linkOf("#local:abc?ramp=true&target=100"), { ramp: true, target: 100 });
});

test("unknown parameter gives a warning", () => {
  const { warnings } = parseRoute("#local:abc?speed=3");
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes("'speed'"));
});

test("broken percent-escape gives none", () => {
  assert.deepEqual(parseRoute("#local:%E0%A4%A").route, { kind: "none" });
});

test("clampTempo rounds to the step and clamps", () => {
  assert.equal(clampTempo(73, 20, 150, 5), 75);
  assert.equal(clampTempo(500, 20, 150, 5), 150);
});

test("linkDrill copies tags", () => {
  const tags = ["fun"];
  const d = linkDrill({ drill: "k1.c5-rh", tags });
  assert.deepEqual(d, { drill_id: "k1.c5-rh", plan_id: null, tags: ["fun"] });
  assert.notEqual(d.tags, tags);
});

test("log hash", () => {
  assert.deepEqual(parseRoute("#/log").route, { kind: "log" });
  assert.deepEqual(parseRoute("#/log/").route, { kind: "log" });
  assert.deepEqual(parseRoute("#/logs").route, { kind: "none" });
});

test("replay hash", () => {
  const id = "attempt-20261106-090000-abc123";
  assert.deepEqual(parseRoute("#/replay/" + id).route, { kind: "replay", attemptId: id });
  assert.deepEqual(parseRoute("#/replay/" + id + "-2").route, { kind: "replay", attemptId: id + "-2" });
  const bad = parseRoute("#/replay/../x");
  assert.deepEqual(bad.route, { kind: "none" });
  assert.equal(bad.warnings.length, 1);
  assert.deepEqual(parseRoute("#/replay/").route, { kind: "none" });
  assert.equal(replayHash(id), "#/replay/" + id);
  assert.deepEqual(parseRoute(replayHash(id)).route, { kind: "replay", attemptId: id });
});
