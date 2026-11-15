import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionItemText, sessionScript } from '../src/replay-logic.ts';
import type { ReplayStepLike, SessionReplay, SessionReplayRow } from '../src/replay-logic.ts';
import { ApiError, fetchReplaySessions, fetchSessionReplay, sessionReplayUrl } from '../src/api.ts';
import type { FetchLike } from '../src/api.ts';

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

function baseRows(): SessionReplayRow[] {
  const seen = new Map<number, number>();
  const rows: SessionReplayRow[] = [];
  for (let q = 0; q < 24; q++) {
    const bar = [1, 2, 1, 2, 3, 4][Math.floor(q / 4)]!;
    if (q % 4 === 0) seen.set(bar, (seen.get(bar) ?? 0) + 1);
    let row: SessionReplayRow = {
      kind: 'match',
      measure_index: bar - 1,
      bar,
      pass: seen.get(bar)!,
      beat: q % 4,
      score_q: q,
      part: 0,
      expected: 60,
      played: 60,
      at_ms: 500 + 500 * q,
      offset_ms: 0,
      timing_score: 100,
    };
    if (q === 1) row = { ...row, offset_ms: 120, timing_score: 50 };
    if (q === 2) row = { ...row, offset_ms: -100, timing_score: 60 };
    if (q === 5) row = { ...row, kind: 'missed', played: null, at_ms: null, offset_ms: null, timing_score: null };
    if (q === 7) row = { ...row, kind: 'wrong', played: 68, at_ms: 4000 };
    rows.push(row);
    if (q === 6) {
      rows.push({
        kind: 'extra',
        measure_index: 1,
        bar: 2,
        pass: 1,
        beat: null,
        score_q: null,
        part: null,
        expected: null,
        played: 70,
        at_ms: 3600,
        offset_ms: null,
        timing_score: null,
      });
    }
  }
  return rows;
}

function base(): SessionReplay {
  return {
    version: 1,
    kind: 'session',
    session: { name: 'session-20261106-090000.mid', started_at: '2026-11-06T09:00:00Z' },
    score: { id: 'local:aaa', title: 'A' },
    hands: 'both',
    expansion: 'none',
    window_ms: { start: 0, end: 13900 },
    duration_ms: 13900,
    summary: { matched: 0, wrong: 0, missed: 0, extra: 0, accuracy: null, bpm: null, timing_score: null },
    played: [{ note: 60, on_ms: 500, off_ms: 900, velocity: 64 }],
    pedal: [],
    notes: baseRows(),
    warnings: [],
  };
}

const run = (r: SessionReplay) => sessionScript(r, repeatTl, 80, { tzOffsetMin: 0 });

test('the needle visits every step and interpolates the missed one', () => {
  const s = run(base());
  assert.equal(s.needle.length, 24);
  s.needle.forEach((n, i) => assert.equal(n.step, i));
  assert.equal(s.needle[5]!.at, 3000);
});

test('outcome marks follow the first matched row', () => {
  const s = run(base());
  const at = (step: number) => s.marks.find((m) => m.kind === 'outcome' && m.step === step);
  assert.deepEqual(at(0), { at: 500, kind: 'outcome', step: 0, outcome: 'hit', score: 100 });
  assert.deepEqual(at(1), { at: 1000, kind: 'outcome', step: 1, outcome: 'late', score: 50 });
  assert.deepEqual(at(2), { at: 1500, kind: 'outcome', step: 2, outcome: 'early', score: 60 });
  assert.deepEqual(at(5), { at: 3000, kind: 'outcome', step: 5, outcome: 'missed', score: null });
  assert.deepEqual(at(7), { at: 4000, kind: 'outcome', step: 7, outcome: 'missed', score: null });
});

test('wrong and extra rows become wrong flashes', () => {
  const s = run(base());
  assert.deepEqual(
    s.marks.filter((m) => m.kind === 'wrong'),
    [
      { at: 3600, kind: 'wrong', step: 6, count: 1 },
      { at: 4000, kind: 'wrong', step: 7, count: 1 },
    ],
  );
});

test('script header fields', () => {
  const s = run(base());
  assert.equal(s.durationMs, 13900);
  assert.equal(s.kind, 'session');
  assert.equal(s.label, 'Recording 2026-11-06 09:00');
  assert.deepEqual(s.notes, [{ on: 500, off: 900, note: 60, velocity: 64 }]);
});

test('pass fallback and unplaced rows', () => {
  const r = base();
  r.notes = [{ ...r.notes[0]!, measure_index: 2, bar: 3, pass: 2, beat: 1 }];
  const s = run(r);
  assert.equal(s.needle[0]!.step, 17);
  const bad = base();
  bad.notes = [{ ...bad.notes[0]!, measure_index: 9 }];
  assert.deepEqual(run(bad).warnings, ['1 note of the recording could not be placed on this score.']);
});

test('sessionItemText', () => {
  const item = { name: 'session-20261106-090000.mid', started_at: '2026-11-06T09:00:00Z', size_bytes: 10 };
  assert.equal(sessionItemText(item, 0), 'Recording 2026-11-06 09:00');
  assert.equal(sessionItemText({ ...item, started_at: null }, 0), item.name);
});

test('session api calls', async () => {
  const seen: string[] = [];
  const ok: FetchLike = async (url) => {
    seen.push(url);
    return { ok: true, status: 200, json: async () => ({ sessions: [{ name: 'a.mid', started_at: null, size_bytes: 1 }] }) };
  };
  const sessions = await fetchReplaySessions(ok);
  assert.deepEqual(seen, ['/api/replay/sessions']);
  assert.equal(sessions[0]!.name, 'a.mid');
  assert.equal(
    sessionReplayUrl('session-20261106-090000.mid', 'local:a b', 'right'),
    '/api/replay/session?name=session-20261106-090000.mid&score=local%3Aa+b&hands=right',
  );
  const bad: FetchLike = async () => ({
    ok: false,
    status: 422,
    json: async () => ({ error: "none of this score's notes were found in this recording" }),
  });
  await assert.rejects(fetchSessionReplay('a.mid', 'local:aaa', 'both', bad), (err: unknown) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.message, "none of this score's notes were found in this recording");
    assert.equal(err.status, 422);
    return true;
  });
});
