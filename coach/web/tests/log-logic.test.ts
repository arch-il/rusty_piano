import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  accuracyText,
  barLayout,
  dayBars,
  daysText,
  minutesText,
  pieceMeta,
  pieceRows,
  skippedText,
  summaryItems,
  todayMinutes,
  weekMinutes,
} from '../src/log-logic.ts';
import type { DayBar, LogResponse, LogRun } from '../src/log-logic.ts';
import { ApiError, fetchLog } from '../src/api.ts';
import type { FetchLike } from '../src/api.ts';

const runs: LogRun[] = Array.from({ length: 7 }, (_, i) => ({
  id: `att-${i}`,
  started_at: `2026-11-05T09:0${i}:00`,
  date: '2026-11-05',
  time: `09:0${i}`,
  minutes: 2,
  accuracy: 0.8,
  mode: 'wait',
  end: 'finished',
}));

const log: LogResponse = {
  version: 1,
  kind: 'practice-log',
  today: '2026-11-05',
  window_days: 30,
  days: [
    { date: '2026-11-05', minutes: 12, sessions: 0, attempts: 1 },
    { date: '2026-11-04', minutes: 30, sessions: 0, attempts: 1 },
    { date: '2026-11-02', minutes: 20, sessions: 0, attempts: 1 },
    { date: '2026-11-01', minutes: 45, sessions: 0, attempts: 1 },
    { date: '2026-10-01', minutes: 15, sessions: 0, attempts: 1 },
  ],
  streak: { current: 3, longest: 5 },
  total_minutes: 122,
  window_minutes: 107,
  pieces: [
    {
      score_id: 'local:aaa',
      title: 'Piece A',
      attempts: 7,
      minutes: 75.2,
      first: '2026-11-01',
      last: '2026-11-05',
      best_accuracy: 0.95,
      last_accuracy: 0.9,
      runs,
    },
    {
      score_id: 'pdmx:a b',
      title: null,
      attempts: 1,
      minutes: 0.3,
      first: '2026-11-01',
      last: '2026-11-01',
      best_accuracy: null,
    },
  ],
  inputs: { sessions: 0, attempts: 8, skipped: [] },
};

test('dayBars covers 30 days ending today', () => {
  const bars = dayBars(log);
  assert.equal(bars.length, 30);
  assert.equal(bars[0].date, '2026-10-07');
  const last = bars[29];
  assert.equal(last.date, '2026-11-05');
  assert.equal(last.minutes, 12);
  assert.equal(last.title, 'Thu 2026-11-05: 12 min');
  assert.equal(bars.find((b) => b.date === '2026-11-03')?.minutes, 0);
  assert.ok(!bars.some((b) => b.date === '2026-10-01'));
  assert.equal(bars[29].showLabel, true);
  assert.equal(bars[22].showLabel, true);
  assert.equal(bars[28].showLabel, false);
});

test('weekMinutes sums Monday through today', () => {
  assert.equal(weekMinutes(log), 62);
});

test('summaryItems', () => {
  assert.deepEqual(summaryItems(log), [
    ['Today', '12 min'],
    ['Current streak', '3 days'],
    ['Best streak', '5 days'],
    ['This week', '1 h 2 min'],
    ['Last 30 days', '1 h 47 min'],
    ['All time', '2 h 2 min'],
  ]);
  assert.equal(daysText(1), '1 day');
});

test('todayMinutes', () => {
  assert.equal(todayMinutes(log), 12);
  assert.equal(todayMinutes({ ...log, today: '2026-12-01' }), 0);
});

test('minutesText', () => {
  assert.equal(minutesText(0), '0 min');
  assert.equal(minutesText(0.3), '<1 min');
  assert.equal(minutesText(0.5), '1 min');
  assert.equal(minutesText(12.4), '12 min');
  assert.equal(minutesText(60), '1 h');
  assert.equal(minutesText(75.2), '1 h 15 min');
});

test('accuracyText', () => {
  assert.equal(accuracyText(null), '-');
  assert.equal(accuracyText(undefined), '-');
  assert.equal(accuracyText(0.904), '90%');
});

test('pieceRows', () => {
  const rows = pieceRows(log);
  assert.equal(rows[0].href, '#local:aaa');
  assert.equal(rows[1].href, '#pdmx:a%20b');
  assert.equal(rows[1].title, 'pdmx:a b');
  assert.equal(rows[0].runsText, '7 runs');
  assert.equal(rows[1].runsText, '1 run');
  assert.equal(rows[0].runs.length, 5);
  assert.equal(rows[0].runs[0].attemptId, 'att-0');
  assert.equal(rows[0].runs[0].when, '2026-11-05 09:00');
  assert.deepEqual(rows[1].runs, []);
  assert.equal(rows[1].lastAccuracyText, '-');
});

test('pieceMeta', () => {
  assert.equal(pieceMeta(pieceRows(log)[0]), '1 h 15 min, 7 runs, last accuracy 90%, last played 2026-11-05');
});

test('skippedText', () => {
  assert.equal(skippedText(log), '');
  const one = { ...log, inputs: { ...log.inputs, skipped: ['a'] } };
  assert.equal(skippedText(one), '1 file could not be read (run uv run coach log to see it)');
  const two = { ...log, inputs: { ...log.inputs, skipped: ['a', 'b'] } };
  assert.equal(skippedText(two), '2 files could not be read (run uv run coach log to see them)');
});

function bar(minutes: number): DayBar {
  return { date: '', minutes, weekday: '', label: '', showLabel: false, title: '' };
}

test('barLayout', () => {
  const a = barLayout([bar(0), bar(5), bar(10)], 32, 100, 1);
  assert.deepEqual(a.rects, [
    { x: 0, y: 100, w: 10, h: 0 },
    { x: 11, y: 50, w: 10, h: 50 },
    { x: 22, y: 0, w: 10, h: 100 },
  ]);
  assert.equal(a.max, 10);
  const b = barLayout([bar(0.1), bar(10)], 21, 100, 1);
  assert.equal(b.rects[0].h, 2);
  assert.equal(b.rects[0].y, 98);
  assert.deepEqual(barLayout([], 10, 10, 1).rects, []);
});

test('fetchLog GETs /api/log?days=30 and returns the body', async () => {
  const seen: unknown[][] = [];
  const fetchFn: FetchLike = async (...args) => {
    seen.push(args);
    return { ok: true, status: 200, json: async () => log };
  };
  const result = await fetchLog(fetchFn);
  assert.deepEqual(seen, [['/api/log?days=30']]);
  assert.deepEqual(result, log);
});

test('fetchLog with a 500 throws ApiError carrying the server message', async () => {
  const broken: FetchLike = async () => ({
    ok: false,
    status: 500,
    json: async () => ({ error: 'could not read the practice log: x' }),
  });
  await assert.rejects(fetchLog(broken), (err: unknown) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.status, 500);
    assert.equal(err.message, 'could not read the practice log: x');
    return true;
  });
});
