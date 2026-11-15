import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { unevenMarkPoint } from '../src/score-geometry.ts';

const box = { x: 100, y: 50, width: 0, height: 200 };
const prev = { x: 80, y: 50, width: 0, height: 200 };

test('midpoint above for right hand', () => {
  assert.deepEqual(unevenMarkPoint(box, prev, 'right'), { x: 90, y: 50, side: 'above' });
});

test('midpoint below for left hand', () => {
  assert.deepEqual(unevenMarkPoint(box, prev, 'left'), { x: 90, y: 250, side: 'below' });
});

test('falls back to the note x', () => {
  assert.equal(unevenMarkPoint(box, null, 'right').x, 100);
  assert.equal(unevenMarkPoint(box, { ...prev, y: 300 }, 'right').x, 100);
  assert.equal(unevenMarkPoint(box, { ...prev, x: 120 }, 'right').x, 100);
});

test('tolerates sub-pixel y differences', () => {
  assert.equal(unevenMarkPoint(box, { ...prev, y: 50.4 }, 'right').x, 90);
});

test('css and wiring', () => {
  const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  const start = css.indexOf('.uneven-marker {');
  const body = css.slice(start, css.indexOf('}', start));
  assert.ok(body.includes('pointer-events: auto'));
  assert.ok(body.includes('font-size: var(--font-size-mark)'));
  assert.ok(css.includes('--font-size-mark: 18px'));
  assert.ok(body.includes('cursor: help'));
  assert.ok(!body.includes('pointer-events: none'));
  assert.ok(css.includes('.uneven-marker.above {'));
  assert.ok(css.includes('.uneven-marker.below {'));
  const view = readFileSync(new URL('../src/score-view.ts', import.meta.url), 'utf8');
  assert.ok(view.includes('unevenMarkPoint('));
  assert.ok(view.includes('"uneven-marker"'));
  assert.ok(view.includes('unevenHands'));
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.ok(main.includes('hand: w.hand'));
});
