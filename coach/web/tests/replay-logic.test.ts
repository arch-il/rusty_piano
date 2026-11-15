import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  attemptItemText,
  attemptScript,
  clockText,
  fillTimes,
  findStep,
  isEmptyScript,
  localStamp,
} from '../src/replay-logic.ts';
import type { ReplayAttempt, ReplayAttemptItem, ReplayStepLike } from '../src/replay-logic.ts';
import { ApiError, attemptUrl, fetchAttempt, fetchReplayAttempts, replayAttemptsUrl } from '../src/api.ts';
import type { FetchLike } from '../src/api.ts';

const tl8: ReplayStepLike[] = Array.from({ length: 8 }, (_, i) => ({
  index: i,
  bar: 1 + Math.floor(i / 4),
  beat: i % 4,
  pass: 1,
}));

const repeatTl: ReplayStepLike[] = (() => {
  const bars = [1, 2, 1, 2, 3, 4];
  const seen = new Map<number, number>();
  const out: ReplayStepLike[] = [];
  for (const bar of bars) {
    const pass = (seen.get(bar) ?? 0) + 1;
    seen.set(bar, pass);
    for (let b = 0; b < 4; b++) out.push({ index: out.length, bar, beat: b, pass });
  }
  return out;
})();

type Step = {
  cycle: number;
  step: number;
  source_step: number;
  bar: number;
  beat: number;
  pass: number;
  time_q: number;
  expected: never[];
  result: string;
  outcome: 'hit' | 'early' | 'late' | 'missed' | null;
  offset_ms: number | null;
  timing_score: number | null;
  played: { note: number; offset_ms: number; page_ms: number }[];
  wrong: { note: number; page_ms: number }[];
  holds: { note: number; held_ms: number; expected_ms: number; short: boolean; page_ms: number }[];
};

function mkStep(o: Partial<Step> & { step: number; beat: number; time_q: number }): Step {
  return {
    cycle: 1,
    source_step: o.step,
    bar: 1,
    pass: 1,
    expected: [],
    result: 'x',
    outcome: null,
    offset_ms: null,
    timing_score: null,
    played: [],
    wrong: [],
    holds: [],
    ...o,
  };
}

const s0 = mkStep({ step: 0, beat: 0, time_q: 0, outcome: 'hit', timing_score: 95, played: [{ note: 60, offset_ms: 5, page_ms: 1000 }] });
const s1 = mkStep({
  step: 1,
  beat: 1,
  time_q: 1,
  outcome: 'late',
  timing_score: 40,
  played: [{ note: 62, offset_ms: 150, page_ms: 1600 }],
  wrong: [{ note: 63, page_ms: 1550 }],
});
const s2 = mkStep({ step: 2, beat: 2, time_q: 2, outcome: 'missed', timing_score: null });
const s3 = mkStep({
  step: 3,
  beat: 3,
  time_q: 3,
  outcome: 'early',
  timing_score: 70,
  played: [{ note: 65, offset_ms: -90, page_ms: 2400 }],
  holds: [{ note: 65, held_ms: 100, expected_ms: 400, short: true, page_ms: 2500 }],
});

const events = [
  { type: 'note_on', t: 0, page_ms: 1000, source: 'engine', note: 60, velocity: 80 },
  { type: 'note_off', t: 0, page_ms: 1400, source: 'engine', note: 60 },
  { type: 'note_on', t: 0, page_ms: 1550, source: 'engine', note: 63, velocity: 70 },
  { type: 'note_off', t: 0, page_ms: 1580, source: 'engine', note: 63 },
  { type: 'note_on', t: 0, page_ms: 1600, source: 'engine', note: 62, velocity: 75 },
  { type: 'sustain', t: 0, page_ms: 1700, source: 'engine', on: true },
  { type: 'note_off', t: 0, page_ms: 1900, source: 'engine', note: 62 },
  { type: 'note_on', t: 0, page_ms: 2400, source: 'engine', note: 65, velocity: 90 },
  { type: 'note_off', t: 0, page_ms: 2500, source: 'engine', note: 65 },
  { type: 'sustain', t: 0, page_ms: 2600, source: 'engine', on: false },
  { type: 'note_on', t: 0, page_ms: 2700, source: 'engine', note: 67, velocity: 60 },
];

function mkAttempt(steps: Step[], evs: unknown[] = events): ReplayAttempt {
  return {
    score: { id: 'local:aaa', title: 'Piece A', composer: null },
    mode: 'live',
    end: 'done',
    started_at: '2026-11-06T09:00:00Z',
    duration_ms: 3000,
    practice: { hands: 'right' },
    plan: { length_quarters: 8 },
    steps,
    events: evs,
  } as unknown as ReplayAttempt;
}

test('attemptScript builds notes, pedal, marks and needle', () => {
  const s = attemptScript(mkAttempt([s0, s1, s2, s3]), tl8, { tzOffsetMin: 0 });
  assert.deepEqual(s.notes, [
    { on: 500, off: 900, note: 60, velocity: 80 },
    { on: 1050, off: 1080, note: 63, velocity: 70 },
    { on: 1100, off: 1400, note: 62, velocity: 75 },
    { on: 1900, off: 2000, note: 65, velocity: 90 },
    { on: 2200, off: 2400, note: 67, velocity: 60 },
  ]);
  assert.deepEqual(s.pedal, [
    { at: 1200, on: true },
    { at: 2100, on: false },
  ]);
  assert.deepEqual(s.marks, [
    { at: 500, kind: 'outcome', step: 0, outcome: 'hit', score: 95 },
    { at: 1050, kind: 'wrong', step: 1, count: 1 },
    { at: 1100, kind: 'outcome', step: 1, outcome: 'late', score: 40 },
    { at: 1500, kind: 'outcome', step: 2, outcome: 'missed', score: null },
    { at: 1900, kind: 'outcome', step: 3, outcome: 'early', score: 70 },
    { at: 2000, kind: 'short', step: 3 },
  ]);
  assert.deepEqual(s.needle, [
    { at: 500, step: 0 },
    { at: 1100, step: 1 },
    { at: 1500, step: 2 },
    { at: 1900, step: 3 },
  ]);
  assert.equal(s.durationMs, 3200);
  assert.equal(s.hands, 'right');
  assert.equal(s.kind, 'attempt');
  assert.equal(s.label, 'Run 2026-11-06 09:00');
  assert.deepEqual(s.warnings, []);
});

test('attemptScript marks a clear before the first step of a later cycle', () => {
  const c2a = { ...s2, cycle: 2, step: 0, source_step: 0, beat: 0, time_q: 0 };
  const c2b = { ...s3, cycle: 2, step: 1, source_step: 1, beat: 1, time_q: 1 };
  const s = attemptScript(mkAttempt([s0, s1, c2a, c2b]), tl8, { tzOffsetMin: 0 });
  const clears = s.marks.filter((m) => m.kind === 'clear');
  assert.equal(clears.length, 1);
  const clearAt = clears[0]!.at;
  const firstC2 = s.marks.find((m) => m.kind === 'outcome' && m.outcome === 'missed')!;
  assert.ok(clearAt <= firstC2.at);
  assert.ok(s.marks.indexOf(clears[0]!) < s.marks.indexOf(firstC2));
  assert.deepEqual(
    s.needle.map((n) => n.step),
    [0, 1, 0, 1],
  );
});

test('attemptScript falls back to bar/beat placement and skips unknown bars', () => {
  const moved = { ...s2, source_step: 5 };
  const lost = mkStep({ step: 4, beat: 0, time_q: 4, bar: 9, outcome: 'hit' });
  const s = attemptScript(mkAttempt([s0, s1, moved, lost]), tl8, { tzOffsetMin: 0 });
  assert.deepEqual(
    s.needle.map((n) => n.step),
    [0, 1, 2],
  );
  assert.deepEqual(s.warnings, ['1 step of this run is not on this score and was skipped.']);
});

test('an attempt with no steps and no events is empty', () => {
  const s = attemptScript(mkAttempt([], []), tl8, { tzOffsetMin: 0 });
  assert.equal(isEmptyScript(s), true);
  assert.equal(s.durationMs, 0);
});

const v1Base = {
  version: 1,
  kind: 'rusty_piano.attempt',
  score: { id: 'local:aaa', title: 'Piece A' },
  mode: 'live',
  end: 'done',
  started_at: '2026-11-06T09:00:00Z',
  duration_ms: 3000,
  summary: { counts: {} },
};

test('attemptScript reads a minimal version-1 attempt without throwing', () => {
  const a = { ...v1Base, steps: [], events: [] } as unknown as ReplayAttempt;
  const s = attemptScript(a, tl8, { tzOffsetMin: 0 });
  assert.equal(s.notes.length, 0);
  assert.equal(s.hands, 'both');
  assert.equal(isEmptyScript(s), true);
});

test('attemptScript reads a version-1 attempt with sparse steps without throwing', () => {
  const a = {
    ...v1Base,
    steps: [
      { step: 0, bar: 1, beat: 0, outcome: 'hit' },
      { step: 1, bar: 1, beat: 1, outcome: 'missed' },
    ],
  } as unknown as ReplayAttempt;
  assert.doesNotThrow(() => attemptScript(a, tl8, { tzOffsetMin: 0 }));
});

test('findStep', () => {
  assert.equal(findStep(repeatTl, 1, 0, 2), 8);
  assert.equal(findStep(repeatTl, 1, 1e-7, 2), 8);
  assert.equal(findStep(repeatTl, 3, 2, 2), 18);
  assert.equal(findStep(repeatTl, 2, 1.4, 1), 5);
  assert.equal(findStep(repeatTl, 1, 0, 5), 8);
  assert.equal(findStep(repeatTl, 9, 0, 1), null);
});

test('fillTimes', () => {
  assert.deepEqual(fillTimes([{ q: 0, at: 100 }, { q: 1, at: null }, { q: 2, at: 300 }]), [100, 200, 300]);
  assert.deepEqual(fillTimes([{ q: 0, at: null }, { q: 1, at: 1000 }, { q: 2, at: 1500 }]), [500, 1000, 1500]);
  assert.deepEqual(fillTimes([{ q: 0, at: 1000 }, { q: 2, at: null }]), [1000, 2000]);
  assert.deepEqual(fillTimes([{ q: 0, at: null }, { q: 1, at: null }]), [0, 0]);
  assert.deepEqual(fillTimes([{ q: 0, at: 1000 }, { q: 1, at: 900 }]), [1000, 1000]);
});

test('localStamp and clockText', () => {
  assert.equal(localStamp('2026-11-06T09:00:00Z', 0), '2026-11-06 09:00');
  assert.equal(localStamp('2026-11-06T09:00:00Z', -60), '2026-11-06 10:00');
  assert.equal(localStamp('nonsense', 0), 'nonsense');
  assert.equal(clockText(0), '0:00');
  assert.equal(clockText(59999), '0:59');
  assert.equal(clockText(80000), '1:20');
  assert.equal(clockText(3600000), '60:00');
  assert.equal(clockText(-5), '0:00');
});

test('attemptItemText', () => {
  const item: ReplayAttemptItem = {
    id: 'attempt-20261106-090000-abc123',
    started_at: '2026-11-06T09:00:00Z',
    mode: 'live',
    end: 'done',
    duration_ms: 80000,
    hands: 'both',
    range: null,
    loop: false,
    accuracy: 0.854,
    drill_id: null,
  };
  assert.equal(attemptItemText(item, 0), '2026-11-06 09:00 · Live · 85% · 1:20');
  assert.equal(
    attemptItemText({ ...item, mode: 'wait', accuracy: null, range: { from: 3, to: 5 }, end: 'stop' }, 0),
    '2026-11-06 09:00 · Wait · - · 1:20 · bars 3-5 · stopped',
  );
});

test('replay api helpers', async () => {
  assert.equal(replayAttemptsUrl('local:a b'), '/api/replay/attempts?score=local%3Aa%20b');
  const seen: unknown[][] = [];
  const fetchFn: FetchLike = async (...args) => {
    seen.push(args);
    return { ok: true, status: 200, json: async () => ({ attempts: [{ id: 'x' }] }) };
  };
  const list = await fetchReplayAttempts('local:aaa', fetchFn);
  assert.deepEqual(seen, [['/api/replay/attempts?score=local%3Aaaa']]);
  assert.deepEqual(list, [{ id: 'x' }]);

  const seen2: unknown[][] = [];
  const one: FetchLike = async (...args) => {
    seen2.push(args);
    return { ok: true, status: 200, json: async () => ({ id: 'attempt-20261106-090000-abc123' }) };
  };
  await fetchAttempt('attempt-20261106-090000-abc123', one);
  assert.deepEqual(seen2, [['/api/replay/attempts/attempt-20261106-090000-abc123']]);
  assert.equal(attemptUrl('a/b'), '/api/replay/attempts/a%2Fb');

  const missing: FetchLike = async () => ({
    ok: false,
    status: 404,
    json: async () => ({ error: 'no such attempt' }),
  });
  await assert.rejects(fetchAttempt('nope', missing), (err: unknown) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.status, 404);
    assert.equal(err.message, 'no such attempt');
    return true;
  });
});
