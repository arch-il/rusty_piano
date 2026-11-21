import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const header = html.slice(html.indexOf('<header id="topbar"'), html.indexOf('</header>') + '</header>'.length);

test('top bar controls appear in the planned DOM order', () => {
  const order = [
    'library-toggle', 'skills-link', 'log-link', 'sight-link', 'ear-link',
    'piece-title', 'info-toggle', 'replay-toggle', 'zoom-out', 'fingering-toggle',
    'engine-status', 'cursor-start', 'mode-wait', 'follow-toggle', 'practice-toggle',
    'tempo', 'hands', 'loop-toggle', 'ramp-toggle', 'autoplay-toggle', 'metric-accuracy',
  ];
  let prev = -1;
  for (const id of order) {
    const at = header.indexOf(`id="${id}"`);
    assert.ok(at >= 0, `missing ${id}`);
    assert.ok(at > prev, `${id} is out of order`);
    prev = at;
  }
});

test('page links sit inside the topnav wrapper', () => {
  const navStart = header.indexOf('<nav class="topnav" aria-label="Pages">');
  assert.ok(navStart >= 0, 'missing topnav wrapper');
  const navEnd = header.indexOf('</nav>');
  for (const id of ['skills-link', 'log-link', 'sight-link', 'ear-link']) {
    const at = header.indexOf(`id="${id}"`);
    assert.ok(at > navStart && at < navEnd, `${id} is not inside topnav`);
  }
});

test('zoom, playhead, mode and follow groups use the segmented styling', () => {
  assert.ok(header.includes('class="zoom segmented"'));
  assert.ok(header.includes('class="cursor-controls segmented"'));
  assert.ok(header.includes('class="mode-switch segmented"'));
  assert.ok(header.includes('id="follow-toggle" class="btn btn-primary"'));
});

test('practice options: toggle is a direct child of .practice and loop/ramp/autoplay are wrapped', () => {
  const practice = header.indexOf('<div class="practice">');
  const toggle = header.indexOf('id="practice-toggle"');
  const options = header.indexOf('id="practice-options"');
  assert.ok(practice >= 0 && practice < toggle && toggle < options);

  const more = header.indexOf('<div class="practice-more">');
  assert.ok(more > header.indexOf('id="hands"') && more < header.indexOf('id="loop-toggle"'));
});

const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

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

test('second-row groups share order 2', () => {
  assert.ok(/\.cursor-controls,\s*\.mode-switch,\s*\.follow-controls,\s*\.practice,\s*\.metrics\s*\{[^}]*order: 2/.test(css));
});

test('responsive media blocks are in descending order and 1200px is gone', () => {
  const widths = [1600, 1360, 1000, 760, 580, 400];
  let prev = -1;
  for (const w of widths) {
    const at = css.indexOf(`@media (max-width: ${w}px) {`);
    assert.ok(at >= 0, `missing ${w}`);
    assert.ok(at > prev, `${w} is out of order`);
    prev = at;
  }
  assert.ok(!css.includes('@media (max-width: 1200px)'));
});

test('responsive blocks carry heights, Options popovers', () => {
  for (const w of [1360, 760, 400]) {
    assert.ok(mediaBlock(w)?.includes('--topbar-height:'), `${w} sets no height`);
  }
  assert.ok(!(mediaBlock(580) ?? '').includes('--topbar-height:'), '580 must not repeat the height');
  const b1600 = mediaBlock(1600) ?? '';
  assert.ok(b1600.includes('.practice.open .practice-more') && b1600.includes('display: grid'));
  const b1000 = mediaBlock(1000) ?? '';
  assert.ok(b1000.includes('.practice.open .practice-options') && b1000.includes('position: absolute'));
});

test('base rules for menus, padding and the Options toggle', () => {
  assert.ok(body('.replay-menu {').includes('right: 0'));
  assert.ok(body('.topbar {').includes('padding: 4px var(--space-3)'));
  assert.ok(body('.practice-toggle {').includes('order: 1'));
});

test('info popover stays inside the window at 760px and below', () => {
  const block = mediaBlock(760) ?? '';
  assert.ok(block.includes('.info .popover {'));
  const rule = block.slice(block.indexOf('.info .popover {'), block.indexOf('}', block.indexOf('.info .popover {')));
  assert.ok(rule.includes('position: fixed'));
  assert.ok(rule.includes('left: var(--space-2)'));
  assert.ok(rule.includes('right: auto'));
  assert.ok(rule.includes('max-width: calc(100vw - 2 * var(--space-2))'));
});
