import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRoute, sightHash, drillHash } from '../src/drill-link.ts';

test('#/sight and #/sight/ give a sight route with no level', () => {
  for (const hash of ['#/sight', '#/sight/']) {
    const { route, warnings } = parseRoute(hash);
    assert.deepEqual(route, { kind: 'sight', params: { level: null } });
    assert.deepEqual(warnings, []);
  }
});

test('#/sight query parses level, plan and tag', () => {
  const { route, warnings } = parseRoute('#/sight?level=r5-intervals&plan=2026-11-06&tag=evening');
  assert.deepEqual(route, {
    kind: 'sight',
    params: { level: 'r5-intervals', plan: '2026-11-06', tags: ['evening'] },
  });
  assert.deepEqual(warnings, []);
});

test('sightHash round-trips several param sets with no warnings', () => {
  const sets = [
    { level: null },
    { level: 'r2-treble', drill: 'sr.r2-treble' },
    { level: 'r5-intervals', plan: '2026-11-06', tags: ['evening', 'warm-up'] },
    { level: 'r3-bass', clef: 'bass' as const, low: 40, high: 60, acc: true },
    { level: 'r1-grand', clef: 'grand' as const, low: 21, high: 108, acc: false },
  ];
  for (const p of sets) {
    const { route, warnings } = parseRoute(sightHash(p));
    assert.deepEqual(route, { kind: 'sight', params: p });
    assert.deepEqual(warnings, []);
  }
});

test('sightHash writes parts in the fixed order', () => {
  assert.equal(sightHash({ level: null }), '#/sight');
  assert.equal(
    sightHash({ level: 'r3-bass', drill: 'sr.r3-bass', plan: 'p1', tags: ['a', 'b'], clef: 'bass', low: 40, high: 60, acc: false }),
    '#/sight?level=r3-bass&drill=sr.r3-bass&plan=p1&tag=a,b&clef=bass&low=40&high=60&acc=0',
  );
});

test('drill link for a sight level opens the sight route', () => {
  const hash = drillHash('sight:r2-treble', {
    drill: 'sr.r2-treble',
    hands: 'right',
    tempo: 100,
    mode: 'wait',
    loop: false,
  });
  const { route, warnings } = parseRoute(hash);
  assert.equal(route.kind, 'sight');
  assert.equal(route.kind === 'sight' && route.params.level, 'r2-treble');
  assert.equal(route.kind === 'sight' && route.params.drill, 'sr.r2-treble');
  assert.deepEqual(warnings, []);
});

test('#score=sight:<level> opens the sight route', () => {
  const { route, warnings } = parseRoute('#score=sight:r3-bass');
  assert.deepEqual(route, { kind: 'sight', params: { level: 'r3-bass' } });
  assert.deepEqual(warnings, []);
});

test('bad level in #/sight warns once and leaves level null', () => {
  const { route, warnings } = parseRoute('#/sight?level=BAD!');
  assert.deepEqual(route, { kind: 'sight', params: { level: null } });
  assert.equal(warnings.length, 1);
});

test('unknown sight parameter warns', () => {
  const { route, warnings } = parseRoute('#/sight?level=r2-treble&zoom=3');
  assert.equal(route.kind, 'sight');
  assert.deepEqual(warnings, ["unknown link parameter 'zoom'"]);
});

test('#/other is still none', () => {
  const { route, warnings } = parseRoute('#/other');
  assert.deepEqual(route, { kind: 'none' });
  assert.deepEqual(warnings, []);
});

test('normal score hash is still a score route', () => {
  const { route, warnings } = parseRoute('#local:abc?hands=L');
  assert.equal(route.kind, 'score');
  assert.equal(route.kind === 'score' && route.id, 'local:abc');
  assert.deepEqual(warnings, []);
});
