// Sight-reading stats: per-note and per-round summaries, weak-note weights, the
// last-5 comparison, the clean-run text and the trend chart geometry. Pure, no DOM.

import { KEY_HIGH, KEY_LOW, SPEED_TARGETS_MS, formatSeconds, median, roundStats } from './sight-levels.ts';
import type { LevelDef, LevelKind, RoundStats, SightRound, SightRoundStep, SightStepRecord } from './sight-levels.ts';
import { keyLayout } from './piano-keys.ts';
import { noteName } from './engine-socket.ts';

export interface NoteStat {
  midi: number;
  n: number;
  firstTry: number;
  rate: number;
  medianMs: number | null;
}

type StepLike = Pick<SightRoundStep, 'notes' | 'first_try' | 'reaction_ms'>;

function pct(v: number | null): string {
  return Math.round((v ?? 0) * 100) + '%';
}

function r1(v: number): number {
  return Math.round(v * 10) / 10;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function mean(values: readonly (number | null)[]): number | null {
  const present = values.filter((v): v is number => v !== null);
  return present.length === 0 ? null : present.reduce((a, b) => a + b, 0) / present.length;
}

function byMedian(a: number | null, b: number | null, dir: 1 | -1): number {
  if (a === null || b === null) return (a === null ? 1 : 0) - (b === null ? 1 : 0);
  return dir * (a - b);
}

function noteStats(steps: readonly StepLike[]): NoteStat[] {
  const byMidi = new Map<number, { n: number; firstTry: number; times: number[] }>();
  for (const step of steps) {
    for (const midi of new Set(step.notes)) {
      let acc = byMidi.get(midi);
      if (!acc) {
        acc = { n: 0, firstTry: 0, times: [] };
        byMidi.set(midi, acc);
      }
      acc.n++;
      if (step.first_try) acc.firstTry++;
      if (step.reaction_ms !== null) acc.times.push(step.reaction_ms);
    }
  }
  return [...byMidi.entries()]
    .map(([midi, acc]) => ({
      midi,
      n: acc.n,
      firstTry: acc.firstTry,
      rate: acc.firstTry / acc.n,
      medianMs: median(acc.times),
    }))
    .sort((a, b) => a.midi - b.midi);
}

export function roundsOfLevel(rounds: readonly SightRound[], level: string, last?: number): SightRound[] {
  const matching = rounds.filter((r) => r.level === level);
  if (last === undefined) return matching;
  return matching.slice(Math.max(0, matching.length - last));
}

export function noteMap(rounds: readonly SightRound[]): NoteStat[] {
  return noteStats(rounds.flatMap((r) => r.steps));
}

export function recordNoteStats(records: readonly SightStepRecord[]): NoteStat[] {
  return noteStats(records);
}

export function noteWeights(stats: readonly NoteStat[], kind: LevelKind): Map<number, number> {
  const good = SPEED_TARGETS_MS[kind].good;
  const weights = new Map<number, number>();
  for (const s of stats) {
    if (s.n <= 0) continue;
    const slow = clamp((s.medianMs ?? 0) / good - 0.5, 0, 1);
    weights.set(s.midi, 1 + 3 * (1 - s.rate) + 2 * slow);
  }
  return weights;
}

export function weakest(stats: readonly NoteStat[], n = 5): NoteStat[] {
  return stats
    .filter((s) => s.n > 0)
    .sort((a, b) => a.rate - b.rate || byMedian(a.medianMs, b.medianMs, -1))
    .slice(0, n);
}

export interface Comparison {
  prevRounds: number;
  prevAccuracy: number | null;
  prevMedianMs: number | null;
}

export function compareLast(prior: readonly SightRound[], level: string, n = 5): Comparison {
  const rounds = roundsOfLevel(prior, level).filter((r) => r.steps.length > 0);
  const last = rounds.slice(Math.max(0, rounds.length - n));
  return {
    prevRounds: last.length,
    prevAccuracy: mean(last.map((r) => r.accuracy)),
    prevMedianMs: mean(last.map((r) => r.median_ms)),
  };
}

function passes(s: RoundStats, minAccuracy: number, maxMs: number): boolean {
  return s.accuracy !== null && s.accuracy >= minAccuracy && s.medianMs !== null && s.medianMs <= maxMs;
}

export function cleanText(stats: RoundStats, kind: LevelKind, complete: boolean, counted: boolean): string {
  if (!counted) return 'Custom rounds are saved but do not count toward skills.';
  if (!complete) return 'Stopped early: saved, but only full rounds count toward skills.';
  const t = SPEED_TARGETS_MS[kind];
  const met: string[] = [];
  if (passes(stats, 0.95, t.good)) met.push('Good enough');
  if (passes(stats, 0.98, t.solid)) met.push('Solid');
  if (passes(stats, 0.98, t.mastered)) met.push('Mastered');
  if (met.length > 0) return 'Clean run for: ' + met.join(', ');
  return 'Not clean yet: needs 95% first try and a median of at most ' + formatSeconds(t.good) + '.';
}

export function liveStatsText(card: number, total: number, s: RoundStats, lastMs: number | null): string {
  const head = `Card ${card} of ${total}`;
  if (s.steps === 0) return head + ' | Play the note you see';
  return [
    head,
    `First try ${s.firstTry} of ${s.steps} (${pct(s.accuracy)})`,
    `Median ${formatSeconds(s.medianMs)}`,
    `Last ${formatSeconds(lastMs)}`,
  ].join(' | ');
}

export type ChipTone = 'neutral' | 'good' | 'warn' | 'bad';

export interface StatChip {
  label: string;
  value: string;
  tone: ChipTone;
}

export interface StageModel {
  progress: string;
  done: number;
  total: number;
  percent: number;
  chips: StatChip[];
  hint: string;
}

export function stageModel(
  card: number | null,
  total: number,
  s: RoundStats,
  lastMs: number | null,
  kind: LevelKind,
  idleHint: string,
): StageModel {
  if (card === null) return { progress: '', done: 0, total, percent: 0, chips: [], hint: idleHint };
  const done = clamp(card - 1, 0, total);
  const base = {
    progress: (kind === 'bars' ? 'Phrase ' : 'Card ') + card + ' of ' + total,
    done,
    total,
    percent: total > 0 ? Math.round((100 * done) / total) : 0,
  };
  if (s.steps === 0) {
    return { ...base, chips: [], hint: kind === 'bars' ? 'Play the notes you see' : 'Play the note you see' };
  }
  const acc = s.accuracy ?? 0;
  const good = SPEED_TARGETS_MS[kind].good;
  const med = s.medianMs;
  return {
    ...base,
    hint: '',
    chips: [
      {
        label: 'First try',
        value: `${s.firstTry}/${s.steps} ${pct(s.accuracy)}`,
        tone: acc >= 0.95 ? 'good' : acc >= 0.8 ? 'warn' : 'bad',
      },
      {
        label: 'Median',
        value: formatSeconds(med),
        tone: med === null ? 'neutral' : med <= good ? 'good' : med <= 1.5 * good ? 'warn' : 'bad',
      },
      { label: 'Last', value: formatSeconds(lastMs), tone: 'neutral' },
    ],
  };
}

export interface SummaryModel {
  rows: [string, string][];
  best: string;
  worst: string;
  clean: string;
}

export function summaryModel(
  records: readonly SightStepRecord[],
  level: LevelDef,
  prior: readonly SightRound[],
  complete: boolean,
  cardsDone: number,
  cardsTotal: number,
): SummaryModel {
  const s = roundStats(records);
  const cmp = compareLast(prior, level.id);
  const stats = recordNoteStats(records);
  const good = SPEED_TARGETS_MS[level.kind].good;

  const bestNames = stats
    .filter((x) => x.rate === 1)
    .sort((a, b) => byMedian(a.medianMs, b.medianMs, 1))
    .slice(0, 3)
    .map((x) => noteName(x.midi));

  const weakList = weakest(stats, stats.length)
    .filter((x) => x.rate < 1 || (x.medianMs !== null && x.medianMs > good))
    .slice(0, 3)
    .map((x) => `${noteName(x.midi)} (${pct(x.rate)}, ${formatSeconds(x.medianMs)})`);

  const lastRounds =
    cmp.prevRounds === 0
      ? 'No earlier rounds yet'
      : `first try ${pct(cmp.prevAccuracy)} vs ${pct(s.accuracy)}, median ${formatSeconds(cmp.prevMedianMs)} vs ${formatSeconds(s.medianMs)}`;

  return {
    rows: [
      ['Level', level.title],
      [level.kind === 'bars' ? 'Phrases' : 'Cards', cardsDone + ' of ' + cardsTotal],
      ['First try', `${s.firstTry} of ${s.steps} (${pct(s.accuracy)})`],
      ['Median time', formatSeconds(s.medianMs)],
      ['Last 5 rounds', lastRounds],
      ['Hinted', String(s.hinted)],
      ['Wrong notes', String(s.wrongNotes)],
    ],
    best: bestNames.length > 0 ? 'Best: ' + bestNames.join(', ') : 'Best: -',
    worst: weakList.length > 0 ? 'Needs work: ' + weakList.join(', ') : 'Needs work: none',
    clean: cleanText(s, level.kind, complete, level.id !== 'custom'),
  };
}

export interface TrendChart {
  width: number;
  height: number;
  empty: boolean;
  accPath: string;
  timePath: string;
  accDots: { x: number; y: number; title: string }[];
  timeDots: { x: number; y: number; title: string }[];
  xLabels: { x: number; text: string }[];
  accTicks: { y: number; text: string }[];
  timeTicks: { y: number; text: string }[];
}

interface Point {
  x: number;
  y: number;
}

function pathOf(points: (Point | null)[]): string {
  const parts: string[] = [];
  let start = true;
  for (const p of points) {
    if (p === null) {
      start = true;
      continue;
    }
    parts.push(`${start ? 'M' : 'L'} ${p.x} ${p.y}`);
    start = false;
  }
  return parts.join(' ');
}

export function trendChart(
  rounds: readonly SightRound[],
  size: { width: number; height: number; pad: number },
): TrendChart {
  const { width, height, pad } = size;
  const n = rounds.length;
  const xAt = (i: number) => (n === 1 ? width / 2 : pad + (i * (width - 2 * pad)) / (n - 1));
  const maxMedian = Math.max(0, ...rounds.map((r) => r.median_ms ?? 0));
  const maxMs = Math.max(2000, Math.ceil(maxMedian / 500) * 500);
  const accY = (acc: number) => pad + (1 - acc) * (height - 2 * pad);
  const timeY = (ms: number) => pad + (1 - ms / maxMs) * (height - 2 * pad);
  const date = (r: SightRound) => r.started_at.slice(5, 10);

  const accPoints = rounds.map((r, i) =>
    r.accuracy === null ? null : { x: r1(xAt(i)), y: r1(accY(r.accuracy)) },
  );
  const timePoints = rounds.map((r, i) =>
    r.median_ms === null ? null : { x: r1(xAt(i)), y: r1(timeY(r.median_ms)) },
  );

  return {
    width,
    height,
    empty: n === 0,
    accPath: pathOf(accPoints),
    timePath: pathOf(timePoints),
    accDots: rounds.flatMap((r, i) => {
      const p = accPoints[i];
      return p === null || r.accuracy === null ? [] : [{ x: p.x, y: p.y, title: `${date(r)} ${pct(r.accuracy)}` }];
    }),
    timeDots: rounds.flatMap((r, i) => {
      const p = timePoints[i];
      return p === null || r.median_ms === null ? [] : [{ x: p.x, y: p.y, title: `${date(r)} ${formatSeconds(r.median_ms)}` }];
    }),
    xLabels: rounds.flatMap((r, i) =>
      i === 0 || date(rounds[i - 1]) !== date(r) ? [{ x: r1(xAt(i)), text: date(r) }] : [],
    ),
    accTicks: [0, 50, 100].map((v) => ({ y: r1(accY(v / 100)), text: v + '%' })),
    timeTicks: [0, maxMs / 2, maxMs].map((ms) => ({ y: r1(timeY(ms)), text: formatSeconds(ms) })),
  };
}

export interface NoteMapKey {
  midi: number;
  black: boolean;
  x: number;
  width: number;
  cls: 'nm-none' | 'nm-good' | 'nm-ok' | 'nm-weak';
  title: string;
}

function classify(s: NoteStat, good: number): NoteMapKey['cls'] {
  if (s.rate >= 0.9 && s.medianMs !== null && s.medianMs <= good) return 'nm-good';
  if (s.rate < 0.7 || (s.medianMs !== null && s.medianMs > 1.5 * good)) return 'nm-weak';
  return 'nm-ok';
}

export function noteMapKeys(
  stats: readonly NoteStat[],
  kind: LevelKind,
  first = KEY_LOW,
  last = KEY_HIGH,
): NoteMapKey[] {
  const good = SPEED_TARGETS_MS[kind].good;
  const byMidi = new Map(stats.map((s) => [s.midi, s] as const));
  return keyLayout(first, last).map((spot) => {
    const name = noteName(spot.midi);
    const s = byMidi.get(spot.midi);
    const base = { midi: spot.midi, black: spot.black, x: spot.left, width: spot.width };
    if (!s || s.n === 0) return { ...base, cls: 'nm-none', title: `${name}: not seen yet` };
    return {
      ...base,
      cls: classify(s, good),
      title: `${name}: ${s.n} cards, ${pct(s.rate)} first try, median ${formatSeconds(s.medianMs)}`,
    };
  });
}
