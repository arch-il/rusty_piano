import type { AttemptEvent, AttemptV2 } from './attempt-recorder';
import type { StepOutcome } from './note-matcher';
import type { Hands } from './practice-steps';
import { outcomeOf } from './timing-score.ts';

export interface ReplayNote {
  on: number;
  off: number;
  note: number;
  velocity: number;
}

export interface ReplayPedal {
  at: number;
  on: boolean;
}

export type ReplayMark =
  | { at: number; kind: 'outcome'; step: number; outcome: StepOutcome; score: number | null }
  | { at: number; kind: 'wrong'; step: number; count: number }
  | { at: number; kind: 'short'; step: number }
  | { at: number; kind: 'long'; step: number }
  | { at: number; kind: 'clear' };

export interface ReplayNeedle {
  at: number;
  step: number;
}

export interface ReplayScript {
  kind: 'attempt' | 'session';
  label: string;
  hands: Hands;
  durationMs: number;
  notes: ReplayNote[];
  pedal: ReplayPedal[];
  marks: ReplayMark[];
  needle: ReplayNeedle[];
  warnings: string[];
}

export interface ReplayStepLike {
  index: number;
  bar: number;
  beat: number;
  pass: number;
}

export type ReplayAttempt = Pick<
  AttemptV2,
  'score' | 'mode' | 'end' | 'started_at' | 'duration_ms' | 'steps' | 'events'
> & {
  id?: string;
  practice: Pick<AttemptV2['practice'], 'hands'>;
  plan: Pick<AttemptV2['plan'], 'length_quarters'>;
};

export interface ReplayAttemptItem {
  id: string;
  started_at: string | null;
  mode: string | null;
  end: string | null;
  duration_ms: number | null;
  hands: string;
  range: { from: number; to: number } | null;
  loop: boolean;
  accuracy: number | null;
  drill_id: string | null;
}

export const LEAD_MS = 500;
export const TAIL_MS = 800;
export const DEFAULT_MS_PER_QUARTER = 500;

export function localStamp(iso: string, tzOffsetMin?: number): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const off = tzOffsetMin ?? d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 16).replace('T', ' ');
}

export function clockText(ms: number): string {
  const s = Math.floor(Math.max(0, ms) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function attemptItemText(item: ReplayAttemptItem, tzOffsetMin?: number): string {
  const parts = [
    item.started_at ? localStamp(item.started_at, tzOffsetMin) : item.id,
    item.mode === 'live' ? 'Live' : item.mode === 'wait' ? 'Wait' : '-',
    item.accuracy === null ? '-' : `${Math.round(item.accuracy * 100)}%`,
    item.duration_ms === null ? '-' : clockText(item.duration_ms),
  ];
  if (item.range) {
    parts.push(item.range.from === item.range.to ? `bar ${item.range.from}` : `bars ${item.range.from}-${item.range.to}`);
  }
  if (item.end !== 'done') parts.push('stopped');
  return parts.join(' · ');
}

export function findStep(
  timeline: readonly ReplayStepLike[],
  bar: number,
  beat: number,
  pass: number,
): number | null {
  const cands = timeline.filter((s) => s.bar === bar);
  if (cands.length === 0) return null;
  const passes = [...new Set(cands.map((s) => s.pass))];
  let p: number;
  if (passes.includes(pass)) {
    p = pass;
  } else {
    const below = passes.filter((x) => x < pass);
    p = below.length > 0 ? Math.max(...below) : Math.min(...passes);
  }
  let best: ReplayStepLike | null = null;
  for (const s of cands) {
    if (s.pass !== p) continue;
    if (best === null || Math.abs(s.beat - beat) < Math.abs(best.beat - beat)) best = s;
  }
  return best ? best.index : null;
}

export function fillTimes(points: readonly { q: number; at: number | null }[]): number[] {
  const known: number[] = [];
  points.forEach((p, i) => {
    if (p.at !== null && Number.isFinite(p.at)) known.push(i);
  });
  if (known.length === 0) return points.map(() => 0);
  const at = (i: number): number => points[i]!.at as number;
  const out: number[] = [];
  const extrapolate = (i: number, a: number, b: number | undefined): number => {
    let rate = DEFAULT_MS_PER_QUARTER;
    if (b !== undefined) {
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      const dq = points[hi]!.q - points[lo]!.q;
      if (dq > 0) {
        const slope = (at(hi) - at(lo)) / dq;
        if (slope > 0) rate = slope;
      }
    }
    return at(a) + (points[i]!.q - points[a]!.q) * rate;
  };
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    if (p.at !== null && Number.isFinite(p.at)) {
      out.push(p.at);
      continue;
    }
    let prev = -1;
    let next = -1;
    for (const k of known) {
      if (k < i) prev = k;
      else if (k > i && next === -1) next = k;
    }
    if (prev !== -1 && next !== -1) {
      const dq = points[next]!.q - points[prev]!.q;
      out.push(dq === 0 ? at(prev) : at(prev) + ((p.q - points[prev]!.q) / dq) * (at(next) - at(prev)));
    } else if (prev === -1) {
      out.push(extrapolate(i, known[0]!, known[1]));
    } else {
      out.push(extrapolate(i, known[known.length - 1]!, known[known.length - 2]));
    }
  }
  for (let i = 0; i < out.length; i++) {
    if (i > 0) out[i] = Math.max(out[i]!, out[i - 1]!);
    out[i] = Math.round(out[i]! * 10) / 10;
  }
  return out;
}

export function pairNotes(events: readonly AttemptEvent[]): { notes: ReplayNote[]; pedal: ReplayPedal[] } {
  const sorted = events.map((e, i) => ({ e, i })).sort((a, b) => a.e.page_ms - b.e.page_ms || a.i - b.i).map((x) => x.e);
  const open = new Map<string, ReplayNote[]>();
  const notes: ReplayNote[] = [];
  const down = new Set<string>();
  const pedal: ReplayPedal[] = [];
  let lastMs = 0;
  for (const e of events) lastMs = Math.max(lastMs, e.page_ms);
  const close = (e: { source: string; note: number; page_ms: number }): void => {
    const q = open.get(`${e.source}:${e.note}`);
    const n = q?.shift();
    if (n) n.off = e.page_ms;
  };
  for (const e of sorted) {
    if (e.type === 'note_on') {
      if (e.velocity > 0) {
        const n: ReplayNote = { on: e.page_ms, off: -1, note: e.note, velocity: e.velocity };
        const key = `${e.source}:${e.note}`;
        const q = open.get(key) ?? [];
        q.push(n);
        open.set(key, q);
        notes.push(n);
      } else {
        close(e);
      }
    } else if (e.type === 'note_off') {
      close(e);
    } else {
      const before = down.size > 0;
      if (e.on) down.add(e.source);
      else down.delete(e.source);
      const after = down.size > 0;
      if (after !== before) pedal.push({ at: e.page_ms, on: after });
    }
  }
  for (const n of notes) {
    if (n.off < 0) n.off = Math.max(n.on + 200, lastMs);
  }
  notes.sort((a, b) => a.on - b.on || a.note - b.note);
  return { notes, pedal };
}

export function isEmptyScript(s: ReplayScript): boolean {
  return s.notes.length === 0 && s.marks.length === 0;
}

export function attemptScript(
  a: ReplayAttempt,
  timeline: readonly ReplayStepLike[],
  opts: { tzOffsetMin?: number } = {},
): ReplayScript {
  const { notes, pedal } = pairNotes(a.events ?? []);
  const lengthQ = a.plan?.length_quarters ?? 0;
  const sortedSteps = [...(a.steps ?? [])]
    .map((st) => ({
      ...st,
      cycle: st.cycle ?? 1,
      step: st.step ?? 0,
      source_step: st.source_step ?? st.step ?? 0,
      time_q: st.time_q ?? 0,
      played: st.played ?? [],
      wrong: st.wrong ?? [],
      holds: st.holds ?? [],
      outcome: st.outcome ?? null,
      timing_score: st.timing_score ?? null,
    }))
    .sort((x, y) => x.cycle - y.cycle || x.step - y.step);
  let skipped = 0;
  const kept: { st: (typeof sortedSteps)[number]; index: number }[] = [];
  for (const st of sortedSteps) {
    const direct = timeline[st.source_step];
    const index =
      direct && direct.bar === st.bar && Math.abs(direct.beat - st.beat) < 1e-3 && direct.pass === st.pass
        ? direct.index
        : findStep(timeline, st.bar, st.beat, st.pass);
    if (index === null) skipped++;
    else kept.push({ st, index });
  }
  const times = fillTimes(
    kept.map(({ st }) => ({
      q: Math.max(0, st.cycle - 1) * lengthQ + st.time_q,
      at: st.played.length > 0 ? Math.min(...st.played.map((p) => p.page_ms)) : null,
    })),
  );
  const marks: ReplayMark[] = [];
  const needle: ReplayNeedle[] = [];
  kept.forEach(({ st, index }, i) => {
    const t = times[i]!;
    if (i > 0 && st.cycle > kept[i - 1]!.st.cycle) {
      marks.push({ at: Math.min(t, ...st.wrong.map((w) => w.page_ms)), kind: 'clear' });
    }
    [...st.wrong]
      .sort((x, y) => x.page_ms - y.page_ms)
      .forEach((w, k) => marks.push({ at: w.page_ms, kind: 'wrong', step: index, count: k + 1 }));
    if (st.outcome !== null) {
      marks.push({ at: t, kind: 'outcome', step: index, outcome: st.outcome, score: st.timing_score });
    }
    for (const h of st.holds) {
      if (h.short === true) marks.push({ at: h.page_ms, kind: 'short', step: index });
      if (h.long === true) marks.push({ at: h.page_ms, kind: 'long', step: index });
    }
    needle.push({ at: t, step: index });
  });
  const order = marks.map((m, i) => ({ m, i })).sort((x, y) => x.m.at - y.m.at || x.i - y.i).map((x) => x.m);

  const label = 'Run ' + localStamp(a.started_at, opts.tzOffsetMin);
  const warnings: string[] = [];
  if (skipped === 1) warnings.push('1 step of this run is not on this score and was skipped.');
  else if (skipped > 1) warnings.push(`${skipped} steps of this run are not on this score and were skipped.`);

  const all: number[] = [
    ...notes.map((n) => n.on),
    ...pedal.map((p) => p.at),
    ...order.map((m) => m.at),
    ...needle.map((n) => n.at),
  ];
  const base: ReplayScript = {
    kind: 'attempt',
    label,
    hands: a.practice?.hands ?? 'both',
    durationMs: 0,
    notes: [],
    pedal: [],
    marks: [],
    needle: [],
    warnings,
  };
  if (all.length === 0) return base;
  const shift = Math.min(...all) - LEAD_MS;
  const r = (v: number): number => Math.round((v - shift) * 10) / 10;
  base.notes = notes.map((n) => ({ ...n, on: r(n.on), off: r(n.off) }));
  base.pedal = pedal.map((p) => ({ ...p, at: r(p.at) }));
  base.marks = order.map((m) => ({ ...m, at: r(m.at) }));
  base.needle = needle.map((n) => ({ ...n, at: r(n.at) }));
  const ends = [
    ...base.notes.map((n) => n.off),
    ...base.pedal.map((p) => p.at),
    ...base.marks.map((m) => m.at),
    ...base.needle.map((n) => n.at),
  ];
  base.durationMs = Math.max(...ends) + TAIL_MS;
  return base;
}

export interface SessionReplayRow {
  kind: 'match' | 'wrong' | 'missed' | 'extra';
  measure_index: number;
  bar: number | null;
  pass: number | null;
  beat: number | null;
  score_q: number | null;
  part: number | null;
  expected: number | null;
  played: number | null;
  at_ms: number | null;
  offset_ms: number | null;
  timing_score: number | null;
}

export interface SessionReplay {
  version: number;
  kind: string;
  session: { name: string; started_at: string | null };
  score: { id: string; title: string | null };
  hands: Hands;
  expansion: string;
  window_ms: { start: number; end: number };
  duration_ms: number;
  summary: {
    matched: number;
    wrong: number;
    missed: number;
    extra: number;
    accuracy: number | null;
    bpm: number | null;
    timing_score: number | null;
  };
  played: { note: number; on_ms: number; off_ms: number; velocity: number }[];
  pedal: { at_ms: number; on: boolean }[];
  notes: SessionReplayRow[];
  warnings: string[];
}

export interface ReplaySessionItem {
  name: string;
  started_at: string | null;
  size_bytes: number;
}

export function sessionItemText(item: ReplaySessionItem, tzOffsetMin?: number): string {
  return item.started_at ? 'Recording ' + localStamp(item.started_at, tzOffsetMin) : item.name;
}

export function sessionScript(
  r: SessionReplay,
  timeline: readonly ReplayStepLike[],
  onTimeMs: number,
  opts: { tzOffsetMin?: number } = {},
): ReplayScript {
  const rows = r.notes;
  const steps: (number | null)[] = rows.map((row) =>
    row.kind === 'extra' ? null : findStep(timeline, row.measure_index + 1, row.beat ?? 0, row.pass ?? 1),
  );
  let unplaced = 0;
  rows.forEach((row, i) => {
    if (row.kind !== 'extra' && steps[i] === null) unplaced++;
  });
  rows.forEach((row, i) => {
    if (row.kind !== 'extra') return;
    let found: number | null = null;
    for (let k = i - 1; k >= 0 && found === null; k--) {
      if (rows[k]!.kind !== 'extra') found = steps[k]!;
    }
    for (let k = i + 1; k < rows.length && found === null; k++) {
      if (rows[k]!.kind !== 'extra') found = steps[k]!;
    }
    steps[i] = found;
  });

  const groups = new Map<number, SessionReplayRow[]>();
  rows.forEach((row, i) => {
    const s = steps[i];
    if (s === null || s === undefined) return;
    const g = groups.get(s) ?? [];
    g.push(row);
    groups.set(s, g);
  });
  const ordered: { step: number; q: number; rows: SessionReplayRow[] }[] = [];
  for (const [step, g] of groups) {
    const real = g.filter((x) => x.kind !== 'extra');
    if (real.length === 0) continue;
    const qs = real.map((x) => x.score_q).filter((x): x is number => x !== null);
    ordered.push({ step, q: qs.length > 0 ? Math.min(...qs) : step, rows: g });
  }
  ordered.sort((a, b) => a.q - b.q || a.step - b.step);
  const times = fillTimes(
    ordered.map((g) => {
      const ats = g.rows
        .filter((x) => (x.kind === 'match' || x.kind === 'wrong') && x.at_ms !== null)
        .map((x) => x.at_ms as number);
      return { q: g.q, at: ats.length > 0 ? Math.min(...ats) : null };
    }),
  );

  const marks: ReplayMark[] = [];
  const needle: ReplayNeedle[] = [];
  ordered.forEach((g, i) => {
    const t = times[i]!;
    needle.push({ at: t, step: g.step });
    const matched = g.rows.filter((x) => x.kind === 'match');
    if (matched.length === 0 || g.rows.some((x) => x.kind === 'missed')) {
      marks.push({ at: t, kind: 'outcome', step: g.step, outcome: 'missed', score: null });
      return;
    }
    let first = matched[0]!;
    for (const m of matched) {
      if ((m.at_ms ?? Infinity) < (first.at_ms ?? Infinity)) first = m;
    }
    const outcome = first.offset_ms === null ? 'hit' : outcomeOf(first.offset_ms, onTimeMs);
    const scores = matched.map((m) => m.timing_score).filter((x): x is number => x !== null);
    const score = scores.length > 0 ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
    marks.push({ at: t, kind: 'outcome', step: g.step, outcome, score });
  });
  const counts = new Map<number, number>();
  rows.forEach((row, i) => {
    const s = steps[i];
    if ((row.kind !== 'wrong' && row.kind !== 'extra') || s === null || s === undefined || row.at_ms === null) return;
    const count = (counts.get(s) ?? 0) + 1;
    counts.set(s, count);
    marks.push({ at: row.at_ms, kind: 'wrong', step: s, count });
  });
  const order = marks.map((m, i) => ({ m, i })).sort((x, y) => x.m.at - y.m.at || x.i - y.i).map((x) => x.m);

  const warnings = [...r.warnings];
  if (unplaced === 1) warnings.push('1 note of the recording could not be placed on this score.');
  else if (unplaced > 1) warnings.push(`${unplaced} notes of the recording could not be placed on this score.`);

  return {
    kind: 'session',
    label: r.session.started_at ? 'Recording ' + localStamp(r.session.started_at, opts.tzOffsetMin) : r.session.name,
    hands: r.hands,
    durationMs: r.duration_ms,
    notes: r.played
      .map((p) => ({ on: p.on_ms, off: p.off_ms, note: p.note, velocity: p.velocity }))
      .sort((a, b) => a.on - b.on || a.note - b.note),
    pedal: r.pedal.map((p) => ({ at: p.at_ms, on: p.on })),
    marks: order,
    needle,
    warnings,
  };
}
