import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  gateLines,
  hasRuns,
  isLocked,
  layout,
  levelText,
  lockText,
  nodeClasses,
  nodeLevel,
  nodePanel,
  shortTitle,
  STARTED_TEXT,
} from '../src/skills-logic.ts';
import type { PlanDrill, PlanState, PlanTree } from '../src/skills-logic.ts';
import { ApiError, fetchPlan } from '../src/api.ts';
import type { FetchLike } from '../src/api.ts';
import { drillHash } from '../src/drill-link.ts';

const r2Drill: PlanDrill = {
  id: 'r2.steps',
  title: 'Steps drill',
  score: 'gen:r2-steps',
  hands: 'right',
  mode: 'wait',
  tempo: 100,
  loop: false,
  bars: null,
  goal: 'Play the steps',
  kind: 'generated',
};

const p2Drill: PlanDrill = {
  id: 'p2.bars',
  title: 'Bars drill',
  score: 'gen:p2',
  hands: 'both',
  mode: 'live',
  tempo: 80,
  loop: true,
  bars: { from: 1, to: 4 },
  goal: 'Play bars 1 to 4',
  kind: 'segment',
};

const tree: PlanTree = {
  version: 1,
  kind: 'skills',
  decay_days: 30,
  tracks: [
    { id: 'pulse', title: 'Pulse' },
    { id: 'reading', title: 'Reading' },
    { id: 'hands', title: 'Hands' },
  ],
  nodes: [
    { id: 'pulse-1', track: 'pulse', title: 'Steady pulse', requires: [], drills: [] },
    { id: 'pulse-2', track: 'pulse', title: 'Subdivide the beat', summary: 'Count subdivisions.', requires: ['pulse-1'], drills: [p2Drill] },
    { id: 'read-1', track: 'reading', title: 'Read treble clef', requires: [], drills: [] },
    { id: 'read-2', track: 'reading', title: 'Read a melody line', summary: 'Read simple melodies.', requires: ['read-1', 'pulse-2'], drills: [r2Drill] },
    { id: 'hands-1', track: 'hands', title: 'Hands together', requires: ['read-2'], drills: [] },
  ],
};

const state: PlanState = {
  nodes: {
    'pulse-1': { level: 3, rusty: true },
    'pulse-2': { level: 1 },
    'read-1': { level: 2 },
    'read-2': { level: 0, verdict: 'Needs more clean runs', habits: ['h3'] },
    'hands-1': { level: 0 },
  },
  habits: [
    { id: 'h1', title: 'Looking at the keys', status: 'active', nodes: ['read-2'] },
    { id: 'h2', title: 'Late left hand', status: 'improving', nodes: ['hands-1'] },
    { id: 'h3', title: 'Counting out loud', status: 'fixed', nodes: [] },
  ],
  plan_id: null,
  last_review: null,
  updated_at: '2026-11-05T00:00:00',
};

test('layout places the first node of row 1 and the second node of row 2', () => {
  const l = layout(tree);
  assert.deepEqual(l.nodes.find((n) => n.id === 'pulse-1'), { id: 'pulse-1', x: 126, y: 16, w: 132, h: 44 });
  assert.deepEqual(l.nodes.find((n) => n.id === 'read-2'), { id: 'read-2', x: 286, y: 92, w: 132, h: 44 });
});

test('layout has track labels at the row centres', () => {
  assert.deepEqual(layout(tree).tracks, [
    { id: 'pulse', title: 'Pulse', x: 16, y: 38 },
    { id: 'reading', title: 'Reading', x: 16, y: 114 },
    { id: 'hands', title: 'Hands', x: 16, y: 190 },
  ]);
});

test('layout width and height cover the three rows and two columns', () => {
  const l = layout(tree);
  assert.equal(l.width, 434);
  assert.equal(l.height, 228);
});

test('layout of an empty tree is just the padding', () => {
  const empty: PlanTree = { version: 1, kind: 'skills', decay_days: 30, tracks: [{ id: 't', title: 'T' }], nodes: [] };
  const l = layout(empty);
  assert.equal(l.width, 32);
  assert.equal(l.height, 32);
  assert.deepEqual(l.nodes, []);
  assert.deepEqual(l.edges, []);
});

test('layout edges run from each prerequisite to the node that requires it', () => {
  assert.deepEqual(layout(tree).edges, [
    { from: 'pulse-1', to: 'pulse-2', d: 'M 258 38 C 278 38, 266 38, 286 38' },
    { from: 'read-1', to: 'read-2', d: 'M 258 114 C 278 114, 266 114, 286 114' },
    { from: 'pulse-2', to: 'read-2', d: 'M 418 38 C 438 38, 266 114, 286 114' },
    { from: 'read-2', to: 'hands-1', d: 'M 418 114 C 438 114, 106 190, 126 190' },
  ]);
});

test('isLocked is true when a prerequisite is below Good enough', () => {
  assert.equal(isLocked(tree, 'read-2', state), true);
  assert.equal(isLocked(tree, 'pulse-2', state), false);
  assert.equal(isLocked(tree, 'pulse-1', state), false);
  assert.equal(isLocked(tree, 'read-2', null), true);
});

test('lockText lists the unmet prerequisites', () => {
  assert.equal(lockText(tree, 'read-2', state), 'Needs pulse-2 Subdivide the beat at Good enough');
  assert.equal(lockText(tree, 'hands-1', state), 'Needs read-2 Read a melody line at Good enough');
  assert.equal(lockText(tree, 'read-2', null), 'Needs read-1 Read treble clef, pulse-2 Subdivide the beat at Good enough');
  assert.equal(lockText(tree, 'pulse-1', state), null);
});

test('levelText shows Locked, the level name and the rusty flag', () => {
  assert.equal(levelText(tree, 'read-2', state), 'Locked');
  assert.equal(levelText(tree, 'pulse-1', state), 'Solid (rusty)');
  assert.equal(levelText(tree, 'pulse-2', state), 'Learning');
  assert.equal(levelText(tree, 'read-1', state), 'Good enough');
  assert.equal(levelText(tree, 'pulse-1', null), 'Not started');
  assert.equal(levelText(tree, 'read-2', null), 'Locked');
});

test('levelText says Started for a level 0 node with runs', () => {
  const withRuns: PlanState = { ...state, nodes: { 'pulse-1': { level: 0, runs: 2 } } };
  assert.equal(levelText(tree, 'pulse-1', withRuns), STARTED_TEXT);
  const noRuns: PlanState = { ...state, nodes: { 'pulse-1': { level: 0, runs: 0 } } };
  assert.equal(levelText(tree, 'pulse-1', noRuns), 'Not started');
  const lastSeen: PlanState = { ...state, nodes: { 'pulse-1': { level: 0, last_seen: '2026-11-05' } } };
  assert.equal(levelText(tree, 'pulse-1', lastSeen), STARTED_TEXT);
  const neither: PlanState = { ...state, nodes: { 'pulse-1': { level: 0 } } };
  assert.equal(levelText(tree, 'pulse-1', neither), 'Not started');
  const learning: PlanState = { ...state, nodes: { 'pulse-1': { level: 1, runs: 5 } } };
  assert.equal(levelText(tree, 'pulse-1', learning), 'Learning');
  const locked: PlanState = { ...state, nodes: { 'read-2': { level: 0, runs: 3 } } };
  assert.equal(levelText(tree, 'read-2', locked), 'Locked');
});

test('hasRuns reads runs first, then last_seen', () => {
  assert.equal(hasRuns(null, 'x'), false);
  assert.equal(hasRuns(state, 'missing'), false);
  assert.equal(hasRuns({ ...state, nodes: { x: { level: 0, runs: 0, last_seen: '2026-11-05' } } }, 'x'), false);
  assert.equal(hasRuns({ ...state, nodes: { x: { level: 0, last_seen: null } } }, 'x'), false);
});

test('nodeLevel clamps to 0 to 4 and gives 0 when missing', () => {
  const s: PlanState = { ...state, nodes: { a: { level: 9 }, b: { level: -1 } } };
  assert.equal(nodeLevel(s, 'a'), 4);
  assert.equal(nodeLevel(s, 'b'), 0);
  assert.equal(nodeLevel(s, 'missing'), 0);
  assert.equal(nodeLevel(null, 'a'), 0);
});

test('gateLines for a met good gate', () => {
  assert.deepEqual(
    gateLines({ good: { met: true, clean_runs: 3, need_runs: 3, days: 2, need_days: 2 } }),
    ['Good enough: 3 of 3 clean runs, 2 of 2 days (met)'],
  );
});

test('gateLines for a not met good gate', () => {
  assert.deepEqual(
    gateLines({ good: { met: false, clean_runs: 1, need_runs: 3, days: 1, need_days: 2 } }),
    ['Good enough: 1 of 3 clean runs, 1 of 2 days'],
  );
});

test('gateLines for a met solid gate with habit free', () => {
  assert.deepEqual(
    gateLines({
      solid: { met: true, clean_in_window: 4, need_clean: 4, window: 5, days: 3, need_days: 3, habit_free: true },
    }),
    ['Solid: 4 of 4 clean in the last 5 runs, 3 of 3 days (met)'],
  );
});

test('gateLines for a not met solid gate held by a habit', () => {
  assert.deepEqual(
    gateLines({
      solid: { met: false, clean_in_window: 2, need_clean: 4, window: 5, days: 1, need_days: 3, habit_free: false },
    }),
    ['Solid: 2 of 4 clean in the last 5 runs, 1 of 3 days, an active habit holds it back'],
  );
});

test('gateLines for a met mastered gate', () => {
  assert.deepEqual(
    gateLines({ mastered: { met: true, cold_runs: 2, need_cold: 2, materials: 3, need_materials: 3 } }),
    ['Mastered: 2 of 2 cold runs, 3 of 3 materials (met)'],
  );
});

test('gateLines for a not met mastered gate', () => {
  assert.deepEqual(
    gateLines({ mastered: { met: false, cold_runs: 0, need_cold: 2, materials: 1, need_materials: 3 } }),
    ['Mastered: 0 of 2 cold runs, 1 of 3 materials'],
  );
});

test('gateLines with no progress says nothing is recorded', () => {
  assert.deepEqual(gateLines(), ['No practice recorded yet.']);
  assert.deepEqual(gateLines({}), ['No practice recorded yet.']);
});

test('gateLines for a met per-drill good gate', () => {
  assert.deepEqual(
    gateLines({ good: { met: true, drills_met: 8, drills_total: 8, missing: [], need_runs: 3, need_days: 2 } }),
    ['Good enough: 8 of 8 drills (met)'],
  );
});

test('gateLines for a not met per-drill good gate lists the first three missing drills', () => {
  const title = (id: string) => id.toUpperCase();
  assert.deepEqual(
    gateLines(
      { good: { met: false, drills_met: 3, drills_total: 8, missing: ['a', 'b', 'c', 'd', 'e'], need_runs: 3, need_days: 2 } },
      title,
    ),
    ['Good enough: 3 of 8 drills; still needed: A, B, C and 2 more'],
  );
});

test('gateLines for a per-drill solid gate held by a habit', () => {
  assert.deepEqual(
    gateLines({
      solid: { met: false, drills_met: 0, drills_total: 8, missing: ['a'], need_clean: 4, window: 5, need_days: 3, habit_free: false },
    }),
    ['Solid: 0 of 8 drills, an active habit holds it back; still needed: a'],
  );
});

test('gateLines for a per-drill mastered gate shows cold runs each', () => {
  assert.deepEqual(
    gateLines({ mastered: { met: false, drills_met: 0, drills_total: 8, missing: ['a', 'b'], need_cold: 2, away_days: 7 } }),
    ['Mastered: 0 of 8 drills, 2 cold runs each; still needed: a, b'],
  );
});

test('gateLines mixes an old-shape good line with a per-drill solid line', () => {
  assert.deepEqual(
    gateLines({
      good: { met: true, clean_runs: 3, need_runs: 3, days: 2, need_days: 2 },
      solid: { met: false, drills_met: 1, drills_total: 2, missing: ['b'], need_clean: 4, window: 5, need_days: 3, habit_free: true },
    }),
    ['Good enough: 3 of 3 clean runs, 2 of 2 days (met)', 'Solid: 1 of 2 drills; still needed: b'],
  );
});

test('nodeClasses adds level, locked, rusty and selected as they apply', () => {
  assert.equal(nodeClasses(tree, 'pulse-1', state, false), 'skill-node level-3 rusty');
  assert.equal(nodeClasses(tree, 'read-2', state, true), 'skill-node level-0 locked selected');
  assert.equal(nodeClasses(tree, 'read-1', state, false), 'skill-node level-2');
});

test('shortTitle truncates with an ellipsis only when longer than max', () => {
  assert.equal(shortTitle('Subdivide the beat'), 'Subdivide the beat');
  assert.equal(shortTitle('abcdefghijklmnopqrstuvwxyz'), 'abcdefghijklmnopq…');
  assert.equal(shortTitle('abcdef', 4), 'abc…');
});

test('nodePanel builds the drill href with drillHash', () => {
  const panel = nodePanel(tree, state, 'read-2', drillHash);
  assert.ok(panel);
  assert.deepEqual(panel.drills, [
    {
      label: 'Steps drill',
      goal: 'Play the steps',
      href: '#gen:r2-steps?drill=r2.steps&hands=R&tempo=100&mode=wait&loop=0',
    },
  ]);
});

test('nodePanel includes the bars range in the drill href', () => {
  const panel = nodePanel(tree, state, 'pulse-2', drillHash);
  assert.ok(panel);
  assert.deepEqual(panel.drills.map((d) => d.href), ['#gen:p2?drill=p2.bars&hands=B&bars=1-4&tempo=80&mode=live&loop=1']);
});

test('nodePanel passes ramp and target into the drill href', () => {
  const rampDrill: PlanDrill = { ...p2Drill, id: 'r2.ramp', title: 'Ramp drill', score: 'gen:r2-steps', bars: null, ramp: true, target: 90 };
  const rampTree: PlanTree = { ...tree, nodes: [{ ...tree.nodes[3], drills: [rampDrill] }] };
  const panel = nodePanel(rampTree, state, 'read-2', drillHash);
  assert.ok(panel);
  assert.deepEqual(panel.drills.map((d) => d.href), ['#gen:r2-steps?drill=r2.ramp&hands=B&tempo=80&mode=live&loop=1&ramp=1&target=90']);
});

test('nodePanel maps missing drill ids to drill titles in the gate lines', () => {
  const withGates: PlanState = {
    ...state,
    nodes: { ...state.nodes, 'read-2': { level: 0, gates: { good: { met: false, drills_met: 0, drills_total: 1, missing: ['r2.steps'] } } } },
  };
  const panel = nodePanel(tree, withGates, 'read-2', drillHash);
  assert.ok(panel);
  assert.deepEqual(panel.gateLines, ['Good enough: 0 of 1 drills; still needed: Steps drill']);
});

test('nodePanel fills the summary, level, lock, verdict and gate lines', () => {
  const panel = nodePanel(tree, state, 'read-2', drillHash);
  assert.deepEqual(panel, {
    id: 'read-2',
    title: 'Read a melody line',
    summary: 'Read simple melodies.',
    levelText: 'Locked',
    lockText: 'Needs pulse-2 Subdivide the beat at Good enough',
    rusty: false,
    gateLines: ['No practice recorded yet.'],
    verdict: 'Needs more clean runs',
    habits: ['Looking at the keys (active)', 'Counting out loud (fixed)'],
    drills: [
      {
        label: 'Steps drill',
        goal: 'Play the steps',
        href: '#gen:r2-steps?drill=r2.steps&hands=R&tempo=100&mode=wait&loop=0',
      },
    ],
  });
});

test('nodePanel habits are those on the node or listed on its state', () => {
  const panel = nodePanel(tree, state, 'hands-1', drillHash);
  assert.ok(panel);
  assert.deepEqual(panel.habits, ['Late left hand (improving)']);
  assert.equal(panel.summary, '');
  assert.equal(panel.verdict, '');
});

test('nodePanel for an unknown id is null', () => {
  assert.equal(nodePanel(tree, state, 'nope', drillHash), null);
});

test('fetchPlan GETs /api/plan and returns the body', async () => {
  const body = { tree, state: null, problems: [] as string[] };
  const seen: unknown[][] = [];
  const fetchFn: FetchLike = async (...args) => {
    seen.push(args);
    return { ok: true, status: 200, json: async () => body };
  };
  const result = await fetchPlan(fetchFn);
  assert.deepEqual(seen, [['/api/plan']]);
  assert.deepEqual(result, body);
});

test('fetchPlan with a 404 throws ApiError carrying the server message', async () => {
  const missing: FetchLike = async () => ({
    ok: false,
    status: 404,
    json: async () => ({ error: 'no plan yet' }),
  });
  await assert.rejects(fetchPlan(missing), (err: unknown) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.status, 404);
    assert.equal(err.message, 'no plan yet');
    return true;
  });
});
