import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadingStatus } from '../src/library-logic.ts';

const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const sidebar = readFileSync(new URL('../src/sidebar.ts', import.meta.url), 'utf8');

function mediaBlock(width: number): string | undefined {
  const head = `@media (max-width: ${width}px) {`;
  const start = css.indexOf(head);
  if (start < 0) return undefined;
  const open = start + head.length - 1;
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') {
      depth--;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  return undefined;
}

function body(marker: string): string {
  const start = css.indexOf(marker);
  assert.ok(start >= 0, `missing ${marker}`);
  return css.slice(start, css.indexOf('}', start));
}

test('loadingStatus shows the Loading line only when no rows are shown', () => {
  assert.deepEqual(loadingStatus(0), { text: 'Loading…', busy: false });
  assert.deepEqual(loadingStatus(3), { text: null, busy: true });
});

test('sidebar keeps rows and sets aria-busy instead of replacing them with Loading', () => {
  assert.ok(sidebar.includes('loadingStatus(listEl.childElementCount)'));
  assert.ok(sidebar.includes('removeAttribute("aria-busy")'));
  assert.ok(!sidebar.includes('status.textContent = "Loading…";'));
});

test('filters use a three column grid', () => {
  const rule = body('.filters {');
  assert.ok(rule.includes('display: grid'));
  assert.ok(rule.includes('minmax(0, 1.4fr)'));
});

test('library list dims while busy', () => {
  assert.ok(css.includes(".library-list[aria-busy='true'] {"));
});

test('score area shows a blue ring only on keyboard focus', () => {
  const rule = body('.score-area:focus-visible {');
  assert.ok(rule.includes('var(--color-focus)'));
  assert.ok(rule.includes('outline-offset: -2px'));
});

test('replay menu sits inside the window at 760px and below', () => {
  const block = mediaBlock(760) ?? '';
  assert.ok(block.includes('.replay .replay-menu {'));
  const rule = block.slice(block.indexOf('.replay .replay-menu {'), block.indexOf('}', block.indexOf('.replay .replay-menu {')));
  assert.ok(rule.includes('position: fixed'));
  assert.ok(rule.includes('left: var(--space-2)'));
  assert.ok(rule.includes('right: auto'));
  assert.ok(rule.includes('max-width: calc(100vw - 2 * var(--space-2))'));
});

test('base replay menu keeps its right alignment', () => {
  assert.ok(body('.replay-menu {').includes('right: 0'));
});
