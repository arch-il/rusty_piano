import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReplayPlayer } from '../src/replay-player.ts';
import type { ReplayScript } from '../src/replay-logic.ts';

function setup() {
  let t = 0;
  let nextId = 1;
  const cancelled: unknown[] = [];
  const timers: (() => void)[] = [];
  const calls: unknown[][] = [];
  const clock = {
    now: () => t,
    every: (fn: () => void) => {
      timers.push(fn);
      return nextId++;
    },
    cancel: (id: unknown) => {
      cancelled.push(id);
    },
  };
  const hooks = {
    noteOn: (n: number, v: number, d: number) => calls.push(['noteOn', n, v, d]),
    noteOff: (n: number) => calls.push(['noteOff', n]),
    pedal: (on: boolean) => calls.push(['pedal', on]),
    mark: (m: { kind: string }) => calls.push(['mark', m.kind]),
    needle: (f: number, to: number | null, frac: number) => calls.push(['needle', f, to, frac]),
    progress: (p: number, d: number) => calls.push(['progress', p, d]),
    end: () => calls.push(['end']),
  };
  const player = createReplayPlayer(clock, hooks as never);
  return {
    player,
    calls,
    cancelled,
    setT: (v: number) => {
      t = v;
    },
    take: () => calls.splice(0, calls.length),
  };
}

const base = { kind: 'attempt', label: 'x', hands: 'both', warnings: [] as string[] };

const S: ReplayScript = {
  ...base,
  notes: [{ on: 100, off: 300, note: 60, velocity: 80 }],
  pedal: [{ at: 150, on: true }],
  marks: [
    { at: 100, kind: 'outcome', step: 0, outcome: 'hit', score: 90 },
    { at: 400, kind: 'clear' },
  ],
  needle: [
    { at: 100, step: 0 },
    { at: 500, step: 1 },
  ],
  durationMs: 800,
} as unknown as ReplayScript;

test('walk-through', () => {
  const s = setup();
  s.player.play(S);
  assert.deepEqual(s.take(), [['progress', 0, 800]]);
  s.setT(100);
  s.player.tick();
  assert.deepEqual(s.take(), [
    ['noteOn', 60, 80, 200],
    ['mark', 'outcome'],
    ['needle', 0, 1, 0],
    ['progress', 100, 800],
  ]);
  s.setT(300);
  s.player.tick();
  assert.deepEqual(s.take(), [
    ['pedal', true],
    ['noteOff', 60],
    ['needle', 0, 1, 0.5],
    ['progress', 300, 800],
  ]);
  s.player.pause();
  assert.deepEqual(s.take(), [['pedal', false]]);
  assert.equal(s.player.state(), 'paused');
  s.setT(1000);
  s.player.tick();
  assert.deepEqual(s.take(), []);
  assert.equal(s.player.position(), 300);
  s.player.resume();
  s.player.setSpeed(0.5);
  s.setT(1200);
  s.player.tick();
  assert.deepEqual(s.take(), [
    ['pedal', true],
    ['mark', 'clear'],
    ['needle', 0, 1, 0.75],
    ['progress', 400, 800],
  ]);
  s.setT(2000);
  s.player.tick();
  assert.deepEqual(s.take(), [
    ['needle', 1, null, 0],
    ['progress', 800, 800],
    ['pedal', false],
    ['end'],
  ]);
  assert.equal(s.player.state(), 'idle');
  assert.ok(s.cancelled.includes(2));
});

test('loop wrap needle does not sweep backwards', () => {
  const s = setup();
  const L = {
    ...S,
    notes: [],
    pedal: [],
    marks: [],
    needle: [
      { at: 100, step: 3 },
      { at: 500, step: 0 },
    ],
  } as unknown as ReplayScript;
  s.player.play(L);
  s.take();
  s.setT(300);
  s.player.tick();
  assert.deepEqual(s.take(), [
    ['needle', 3, null, 0],
    ['progress', 300, 800],
  ]);
});

test('speed 0.5 stretches note duration', () => {
  const s = setup();
  s.player.play(S, 0.5);
  s.take();
  s.setT(200);
  s.player.tick();
  assert.deepEqual(s.take()[0], ['noteOn', 60, 80, 400]);
});

test('stop releases and ends once', () => {
  const s = setup();
  s.player.play(S);
  s.setT(100);
  s.player.tick();
  s.take();
  s.player.stop();
  assert.deepEqual(s.take(), [['noteOff', 60], ['end']]);
  assert.equal(s.player.state(), 'idle');
  s.player.stop();
  assert.deepEqual(s.take(), []);
});

test('play while playing releases without end', () => {
  const s = setup();
  s.player.play(S);
  s.setT(100);
  s.player.tick();
  s.take();
  s.player.play(S);
  const c = s.take();
  assert.deepEqual(c[0], ['noteOff', 60]);
  assert.ok(!c.some((x) => x[0] === 'end'));
  assert.equal(s.player.state(), 'playing');
});

test('same-time order', () => {
  const s = setup();
  const sc = {
    ...base,
    notes: [
      { on: 0, off: 200, note: 60, velocity: 80 },
      { on: 200, off: 400, note: 62, velocity: 80 },
    ],
    pedal: [{ at: 200, on: true }],
    marks: [{ at: 200, kind: 'clear' }],
    needle: [],
    durationMs: 1000,
  } as unknown as ReplayScript;
  s.player.play(sc);
  s.take();
  s.setT(200);
  s.player.tick();
  assert.deepEqual(s.take(), [
    ['noteOff', 60],
    ['pedal', true],
    ['noteOn', 62, 80, 200],
    ['mark', 'clear'],
    ['progress', 200, 1000],
  ]);
});

test('resume presses the pedal again', () => {
  const s = setup();
  const sc = {
    ...base,
    notes: [{ on: 500, off: 600, note: 60, velocity: 80 }],
    pedal: [
      { at: 100, on: true },
      { at: 900, on: false },
    ],
    marks: [],
    needle: [],
    durationMs: 1000,
  } as unknown as ReplayScript;
  s.player.play(sc);
  s.setT(300);
  s.player.tick();
  s.take();
  s.player.pause();
  assert.deepEqual(s.take(), [['pedal', false]]);
  s.setT(400);
  s.player.resume();
  assert.deepEqual(s.take(), [['pedal', true]]);
  s.setT(700);
  s.player.tick();
  assert.equal(s.calls.filter((x) => x[0] === 'pedal').length, 0);
  s.setT(1200);
  s.player.tick();
  assert.deepEqual(s.calls.filter((x) => x[0] === 'pedal'), [['pedal', false]]);
});

test('overlapping same note offs once', () => {
  const s = setup();
  const sc = {
    ...base,
    notes: [
      { on: 0, off: 300, note: 60, velocity: 80 },
      { on: 100, off: 200, note: 60, velocity: 80 },
    ],
    pedal: [],
    marks: [],
    needle: [],
    durationMs: 1000,
  } as unknown as ReplayScript;
  s.player.play(sc);
  s.setT(250);
  s.player.tick();
  assert.equal(s.calls.filter((x) => x[0] === 'noteOff').length, 0);
  s.setT(300);
  s.player.tick();
  assert.equal(s.calls.filter((x) => x[0] === 'noteOff').length, 1);
});
