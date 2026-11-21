import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { drillHash } from '../src/drill-link.ts';
import {
  RUNS_NO_GATES_TEXT,
  STARTED_TEXT,
  layout,
  levelText,
  nodeName,
  nodePanel,
  nodeRef,
  nodeTag,
  prettyId,
} from '../src/skills-logic.ts';
import type { PlanNode, PlanState, PlanTree } from '../src/skills-logic.ts';

const piece: PlanNode = { id: 'piece-evening-song', kind: 'piece', track: 'pieces', title: 'Evening Song', requires: [], drills: [] };
const skill: PlanNode = { id: 'R3', track: 'reading', title: 'Bass C-G position', requires: [], drills: [] };
const tree: PlanTree = {
  version: 1,
  kind: 'skills',
  decay_days: 30,
  tracks: [
    { id: 'reading', title: 'Reading' },
    { id: 'pieces', title: 'Pieces' },
  ],
  nodes: [skill, { ...piece, requires: ['R3'] }],
};
const st: PlanState = { nodes: { R3: { level: 0, runs: 2 } }, habits: [], plan_id: null, last_review: null, updated_at: '2026-11-19T00:00:00' };

test('prettyId turns a piece id into words', () => {
  assert.equal(prettyId('piece-evening-song'), 'Evening song');
  assert.equal(prettyId('piece-row_your-boat'), 'Row your boat');
  assert.equal(prettyId('piece-'), 'piece-');
});

test('node tag, name and ref', () => {
  assert.equal(nodeTag(piece), 'Piece');
  assert.equal(nodeName(piece), 'Evening Song');
  assert.equal(nodeName({ ...piece, title: 'piece-evening-song' }), 'Evening song');
  assert.equal(nodeName({ ...piece, title: '  ' }), 'Evening song');
  assert.equal(nodeRef(piece), 'Evening Song');
  assert.equal(nodeTag(skill), 'R3');
  assert.equal(nodeRef(skill), 'R3 Bass C-G position');
});

test('started text and panel gate lines', () => {
  assert.equal(STARTED_TEXT, 'Started, not yet at Learning');
  assert.equal(levelText(tree, 'R3', st), STARTED_TEXT);
  assert.deepEqual(nodePanel(tree, st, 'R3', drillHash)?.gateLines, [RUNS_NO_GATES_TEXT]);
  assert.equal(RUNS_NO_GATES_TEXT, 'Runs recorded; gate progress is not counted yet.');
  assert.deepEqual(nodePanel(tree, null, 'R3', drillHash)?.gateLines, ['No practice recorded yet.']);
  assert.equal(nodePanel(tree, null, 'piece-evening-song', drillHash)?.heading, 'Evening Song');
  assert.equal(nodePanel(tree, null, 'R3', drillHash)?.heading, 'R3 Bass C-G position');
});

test('a 12-node track fits a 1400px window', () => {
  const nodes: PlanNode[] = Array.from({ length: 12 }, (_, i) => ({
    id: `n${i}`,
    track: 't',
    title: `Node ${i}`,
    requires: [],
    drills: [],
  }));
  const l = layout({ version: 1, kind: 'skills', decay_days: 30, tracks: [{ id: 't', title: 'T' }], nodes });
  assert.equal(l.width, 1324);
  assert.ok(l.width + 2 * 24 + 17 <= 1400);
});

test('view and css wiring', () => {
  const view = readFileSync(new URL('../src/skills-view.ts', import.meta.url), 'utf8');
  for (const s of ['nodeTag(', 'nodeName(', 'nodeRef(', 'NAME_CHARS', 'TRACK_CHARS', "classList.toggle('panel-open'", 'model.heading']) {
    assert.ok(view.includes(s), s);
  }
  assert.ok(!view.includes('shortTitle('));
  const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  const rule = (sel: string): string => {
    const i = css.indexOf(sel);
    assert.ok(i >= 0, sel);
    return css.slice(i, css.indexOf('}', i));
  };
  assert.ok(!rule('.skills-graph {').includes('--skills-panel-width'));
  assert.ok(rule('.skills-view.panel-open .skills-graph {').includes('var(--skills-panel-width)'));
  assert.ok(rule('.skill-name {').includes('font-size: var(--font-size-xs)'));
});
