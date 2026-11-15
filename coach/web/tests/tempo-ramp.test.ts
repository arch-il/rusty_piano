import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRamp } from '../src/tempo-ramp.ts';

test('clean loops step up and bad loops step back after backAfterBad', () => {
  const r = createRamp(60, { stepPercent: 5, targetPercent: 100, backAfterBad: 2 });
  assert.equal(r.next(true), 65);
  assert.equal(r.next(true), 70);
  assert.equal(r.percent(), 70);
  assert.equal(r.reached(), false);
});

test('clamps to the target', () => {
  const r = createRamp(90, { stepPercent: 7, targetPercent: 100, backAfterBad: 2 });
  assert.equal(r.next(true), 97);
  assert.equal(r.next(true), 100);
  assert.equal(r.next(true), 100);
  assert.equal(r.reached(), true);
});

test('two bad loops in a row step back and never go below the start', () => {
  const r = createRamp(60, { stepPercent: 5, targetPercent: 100, backAfterBad: 2 });
  assert.equal(r.next(true), 65);
  assert.equal(r.next(true), 70);
  assert.equal(r.next(false), 70);
  assert.equal(r.next(false), 65);
  assert.equal(r.next(false), 65);
  assert.equal(r.next(false), 60);
  assert.equal(r.next(false), 60);
  assert.equal(r.next(false), 60);
});

test('a clean loop resets the bad count', () => {
  const r = createRamp(60, { stepPercent: 5, targetPercent: 100, backAfterBad: 2 });
  r.next(true);
  r.next(true);
  assert.equal(r.next(false), 70);
  assert.equal(r.next(true), 75);
  assert.equal(r.next(false), 75);
  assert.equal(r.next(false), 70);
});

test('backAfterBad 0 never steps back', () => {
  const r = createRamp(60, { stepPercent: 5, targetPercent: 100, backAfterBad: 0 });
  r.next(true);
  for (let i = 0; i < 5; i++) assert.equal(r.next(false), 65);
});

test('a start above the target never moves', () => {
  const r = createRamp(120, { stepPercent: 5, targetPercent: 100, backAfterBad: 2 });
  assert.equal(r.reached(), true);
  assert.equal(r.next(true), 120);
  assert.equal(r.next(false), 120);
  assert.equal(r.next(false), 120);
});

test('stepping back at the target', () => {
  const r = createRamp(90, { stepPercent: 5, targetPercent: 100, backAfterBad: 2 });
  assert.equal(r.next(true), 95);
  assert.equal(r.next(true), 100);
  assert.equal(r.reached(), true);
  assert.equal(r.next(false), 100);
  assert.equal(r.next(false), 95);
  assert.equal(r.reached(), false);
  assert.equal(r.next(true), 100);
  assert.equal(r.reached(), true);
});

test('percents are rounded to one decimal', () => {
  const r = createRamp(60, { stepPercent: 0.1, targetPercent: 100, backAfterBad: 2 });
  r.next(true);
  r.next(true);
  assert.equal(r.next(true), 60.3);
});
