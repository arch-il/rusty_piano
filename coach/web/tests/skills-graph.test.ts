import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { layout, trackLines } from '../src/skills-logic.ts';
import type { PlanNode, PlanTree } from '../src/skills-logic.ts';

function node(id: string, track: string, requires: string[]): PlanNode {
  return { id, track, title: id, requires, drills: [] };
}

const tree: PlanTree = {
  version: 1,
  kind: 'skills',
  decay_days: 30,
  tracks: [
    { id: 't1', title: 'One' },
    { id: 't2', title: 'Two' },
  ],
  nodes: [
    node('a', 't1', []),
    node('b', 't1', ['a']),
    node('c', 't1', ['a']),
    node('d', 't2', []),
    node('e', 't2', ['d']),
    node('f', 't2', ['d']),
    node('g', 't1', ['e']),
  ],
};

test('edges are routed at right angles through gutters and row gaps', () => {
  assert.deepEqual(layout(tree).edges, [
    { from: 'a', to: 'b', d: 'M 190 38 H 202' },
    { from: 'a', to: 'c', d: 'M 190 38 H 196 V 78 H 298 V 38 H 304' },
    { from: 'd', to: 'e', d: 'M 190 118 H 202' },
    { from: 'd', to: 'f', d: 'M 190 118 H 196 V 78 H 298 V 118 H 304' },
    { from: 'e', to: 'g', d: 'M 292 118 H 298 V 78 H 400 V 38 H 406' },
  ]);
});

test('no vertical edge segment lies strictly inside a node box', () => {
  const lay = layout(tree);
  for (const e of lay.edges) {
    const tokens = e.d.split(' ');
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i] !== 'H' || tokens[i + 2] !== 'V') continue;
      const x = Number(tokens[i + 1]);
      for (const n of lay.nodes) assert.ok(!(x > n.x && x < n.x + n.w), `${e.from}->${e.to} at x ${x} inside ${n.id}`);
    }
  }
});

test('trackLines splits long titles over two lines', () => {
  assert.deepEqual(trackLines('Scales and arpeggios'), ['Scales and', 'arpeggios']);
  assert.deepEqual(trackLines('Reading'), ['Reading']);
  assert.deepEqual(trackLines('Coordination'), ['Coordination']);
  assert.deepEqual(trackLines('A very long track title here'), ['A very long', 'track title h…']);
  assert.deepEqual(trackLines('Supercalifragilistic'), ['Supercalifrag…']);
});

test('skills-view draws the lock icon and two-line labels; css has the rules', () => {
  const view = readFileSync(new URL('../src/skills-view.ts', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  assert.ok(view.includes('LOCK_PATH'));
  assert.ok(view.includes('trackLines('));
  assert.ok(!view.includes("'locked' : 'rusty'"));
  assert.ok(css.includes('.skill-lock {'));
  const body = css.slice(css.indexOf('.skill-edge {'));
  assert.ok(body.slice(0, body.indexOf('}')).includes('stroke-linejoin: round'));
});
