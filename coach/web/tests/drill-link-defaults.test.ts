import { test } from "node:test";
import assert from "node:assert/strict";
import { drillHash, keepsPage, linkUi, parseRoute, sameLink } from "../src/drill-link.ts";
import type { DrillParams, LinkDefaults } from "../src/drill-link.ts";

const D: LinkDefaults = { mode: "wait", loop: false, ramp: false, minPercent: 20, maxPercent: 150, stepPercent: 5 };
const CUR = { hands: "both" as const, percent: 80 };

test("empty link gives defaults and keeps hands and percent", () => {
  const u = linkUi({}, CUR, D);
  assert.equal(u.mode, "wait");
  assert.equal(u.loop, false);
  assert.equal(u.ramp, false);
  assert.equal(u.hands, "both");
  assert.equal(u.percent, 80);
});

test("a full link wins", () => {
  const u = linkUi({ hands: "right", tempo: 73, mode: "live", loop: true, ramp: true, target: 90 }, CUR, D);
  assert.deepEqual(u, { mode: "live", hands: "right", percent: 75, loop: true, ramp: true, rampTarget: 90 });
});

test("tempo 500 clamps to maxPercent", () => {
  assert.equal(linkUi({ tempo: 500 }, CUR, D).percent, 150);
});

test("rampTarget is null without target", () => {
  assert.equal(linkUi({}, CUR, D).rampTarget, null);
});

test("sameLink null handling", () => {
  assert.equal(sameLink(null, null), true);
  assert.equal(sameLink(null, {}), false);
});

test("sameLink matches a parsed round trip", () => {
  const link: DrillParams = { drill: "a.b", hands: "left", bars: { from: 1, to: 4 }, tempo: 60, mode: "live", loop: true };
  const r = parseRoute(drillHash("local:abc", link)).route;
  assert.equal(r.kind, "score");
  if (r.kind === "score") assert.equal(sameLink(link, r.link), true);
});

test("links that differ only in tempo are not the same", () => {
  assert.equal(sameLink({ drill: "a.b", tempo: 60 }, { drill: "a.b", tempo: 70 }), false);
});

test("keepsPage is true only from Skills, not picked, equal link", () => {
  const l: DrillParams = { drill: "a.b", tempo: 60 };
  assert.equal(keepsPage(true, false, l, { ...l }), true);
  assert.equal(keepsPage(true, true, l, { ...l }), false);
  assert.equal(keepsPage(false, false, l, { ...l }), false);
  assert.equal(keepsPage(true, false, l, { drill: "a.b", tempo: 70 }), false);
  assert.equal(keepsPage(true, false, null, null), false);
});
