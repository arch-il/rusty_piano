import { test } from "node:test";
import assert from "node:assert/strict";
import { handsLabel, practiceBpm, shownPercent, sliderStep, tempoText } from "../src/practice-ui.ts";

test("sliderStep", () => {
  assert.equal(sliderStep(60, 20, 5), "5");
  assert.equal(sliderStep(63, 20, 5), "any");
  assert.equal(sliderStep(20, 20, 5), "5");
  assert.equal(sliderStep(150, 20, 5), "5");
  assert.equal(sliderStep(62.5, 20, 2.5), "2.5");
  assert.equal(sliderStep(60, 20, 0), "any");
});

test("shownPercent", () => {
  assert.equal(shownPercent(60, 75, true), 75);
  assert.equal(shownPercent(60, 75, false), 60);
  assert.equal(shownPercent(60, null, true), 60);
});

test("practiceBpm", () => {
  assert.equal(practiceBpm(120, 60, 80), 72);
  assert.equal(practiceBpm(null, 100, 80), 80);
  assert.equal(practiceBpm(null, 50, 80), 40);
  assert.equal(practiceBpm(52, 25, 80), 13);
  assert.equal(practiceBpm(1, 5, 80), 1);
});

test("tempoText", () => {
  assert.equal(tempoText(60, 72), "60% · 72 bpm");
});

test("handsLabel", () => {
  assert.equal(handsLabel("both"), "Both hands");
  assert.equal(handsLabel("right"), "Right hand");
  assert.equal(handsLabel("left"), "Left hand");
});
