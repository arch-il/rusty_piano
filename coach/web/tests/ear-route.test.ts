import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseRoute, earHash, sightHash } from '../src/drill-link.ts';
import type { EarParams } from '../src/drill-link.ts';

test('#/ear and #/ear/ give an ear route with no level', () => {
  for (const hash of ['#/ear', '#/ear/']) {
    const { route, warnings } = parseRoute(hash);
    assert.deepEqual(route, { kind: 'ear', params: { level: null } });
    assert.deepEqual(warnings, []);
  }
});

test('#/ear?level=echo-1 parses the level', () => {
  const { route, warnings } = parseRoute('#/ear?level=echo-1');
  assert.deepEqual(route, { kind: 'ear', params: { level: 'echo-1' } });
  assert.deepEqual(warnings, []);
});

test('#ear:interval-3 with a full query parses every param', () => {
  const { route, warnings } = parseRoute(
    '#ear:interval-3?drill=ear.interval-3&range=48-60&key=any&set=m3,M3&bpm=90&len=2-3&seed=42',
  );
  assert.deepEqual(route, {
    kind: 'ear',
    params: {
      level: 'interval-3',
      drill: 'ear.interval-3',
      low: 48,
      high: 60,
      key: 'any',
      set: ['m3', 'M3'],
      bpm: 90,
      len: { min: 2, max: 3 },
      seed: 42,
    },
  });
  assert.deepEqual(warnings, []);
});

test('a tree link with hands, tempo, mode and loop parses with no warnings', () => {
  const { route, warnings } = parseRoute('#ear:echo-1?drill=ear.echo-1&hands=B&tempo=100&mode=wait&loop=0');
  assert.deepEqual(route, { kind: 'ear', params: { level: 'echo-1', drill: 'ear.echo-1' } });
  assert.deepEqual(warnings, []);
});

test('key accepts C#, c%23, Bb and any', () => {
  const pc = (v: string) => {
    const { route, warnings } = parseRoute('#/ear?key=' + v);
    assert.deepEqual(warnings, []);
    return route.kind === 'ear' ? route.params.key : undefined;
  };
  assert.equal(pc('C%23'), 1);
  assert.equal(pc('c%23'), 1);
  assert.equal(pc('Bb'), 10);
  assert.equal(pc('any'), 'any');
});

test('bad ear values give warnings', () => {
  const cases = [
    '#/ear?range=60-50',
    '#/ear?range=10-20',
    '#/ear?bpm=29',
    '#/ear?bpm=241',
    '#/ear?len=0',
    '#/ear?len=9',
    '#/ear?len=3-2',
    '#/ear?seed=4294967296',
    '#/ear?seed=12345678901',
    '#/ear?set=a,,b',
    '#/ear?key=H',
    '#/ear?nope=1',
  ];
  for (const hash of cases) {
    const { warnings } = parseRoute(hash);
    assert.equal(warnings.length, 1, hash);
  }
  assert.match(parseRoute('#/ear?bpm=29').warnings[0], /bad value for 'bpm'/);
  assert.match(parseRoute('#/ear?nope=1').warnings[0], /unknown link parameter 'nope'/);
});

test('earHash round-trips several param sets with no warnings', () => {
  const sets: EarParams[] = [
    { level: null },
    { level: 'echo-1', drill: 'ear.echo-1' },
    { level: 'interval-3', drill: 'ear.interval-3', plan: 'p1', tags: ['a', 'b'] },
    { level: 'interval-3', low: 48, high: 60, key: 'any', set: ['m3', 'M3'], bpm: 90, len: { min: 2, max: 3 }, seed: 42 },
    { level: 'chord-2', key: 10, len: { min: 4, max: 4 }, seed: 0 },
  ];
  for (const p of sets) {
    const { route, warnings } = parseRoute(earHash(p));
    assert.deepEqual(route, { kind: 'ear', params: p });
    assert.deepEqual(warnings, []);
  }
});

test('earHash writes parts in the fixed order', () => {
  assert.equal(earHash({ level: null }), '#/ear');
  assert.equal(
    earHash({
      level: 'interval-3',
      drill: 'ear.interval-3',
      plan: 'p1',
      tags: ['a', 'b'],
      low: 48,
      high: 60,
      key: 1,
      set: ['m3', 'M3'],
      bpm: 90,
      len: { min: 2, max: 3 },
      seed: 42,
    }),
    '#/ear?level=interval-3&drill=ear.interval-3&plan=p1&tag=a,b&range=48-60&key=Db&set=m3,M3&bpm=90&len=2-3&seed=42',
  );
});

test('sight and score routes are unchanged', () => {
  assert.deepEqual(parseRoute('#/sight?level=r5-intervals').route, {
    kind: 'sight',
    params: { level: 'r5-intervals' },
  });
  assert.equal(sightHash({ level: 'r3-bass', clef: 'bass' }), '#/sight?level=r3-bass&clef=bass');
  assert.deepEqual(parseRoute('#score=abc:def?tempo=100&hands=R').route, {
    kind: 'score',
    id: 'abc:def',
    link: { tempo: 100, hands: 'right' },
  });
});

test('log-view.ts mentions ear: and sight: near the replay link', () => {
  const src = readFileSync(new URL('../src/log-view.ts', import.meta.url), 'utf8');
  const at = src.indexOf('log-run-replay');
  assert.ok(at > 0);
  const near = src.slice(Math.max(0, at - 800), at);
  assert.ok(near.includes("'ear:'"));
  assert.ok(near.includes("'sight:'"));
});

test('dir, harm and free parse and warn', () => {
  const ok = parseRoute('#/ear?level=interval-1&dir=down&harm=mixed&free=1');
  assert.deepEqual(ok.warnings, []);
  assert.deepEqual(ok.route, { kind: 'ear', params: { level: 'interval-1', direction: 'down', harmonic: 'mixed', free: true } });
  for (const q of ['dir=sideways', 'harm=both', 'free=0', 'free=yes']) {
    const r = parseRoute('#/ear?' + q);
    assert.match(r.warnings[0], /bad value for/, q);
  }
});

test('bpm accepts 40-200 only and set ids up to 20 chars', () => {
  assert.deepEqual(parseRoute('#/ear?bpm=40').warnings, []);
  assert.deepEqual(parseRoute('#/ear?bpm=200').warnings, []);
  assert.match(parseRoute('#/ear?bpm=30').warnings[0], /bad value for 'bpm'/);
  assert.match(parseRoute('#/ear?bpm=220').warnings[0], /bad value for 'bpm'/);
  const r = parseRoute('#/ear?set=mary,hot-cross-buns');
  assert.deepEqual(r.warnings, []);
});

test('earHash round-trips dir, harm, free and tune sets', () => {
  const p: EarParams = {
    level: 'interval-2', set: ['mary', 'hot-cross-buns'], direction: 'both', harmonic: 'harmonic', free: true, bpm: 90, seed: 5,
  };
  const h = earHash(p);
  assert.equal(h, '#/ear?level=interval-2&set=mary,hot-cross-buns&dir=both&harm=harmonic&bpm=90&seed=5&free=1');
  const r = parseRoute(h);
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.route, { kind: 'ear', params: p });
});
