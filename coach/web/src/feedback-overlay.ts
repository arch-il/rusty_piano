import type { StepOutcome } from './note-matcher';
import { DEFAULT_COLOURS, SCORE_COLOUR_VARS, scoreColour, type TimingColours } from './timing-score.ts';

export const MARK_VARS: Readonly<Record<StepOutcome, string>> = {
  hit: '--color-mark-hit',
  early: '--color-mark-timing',
  late: '--color-mark-timing',
  missed: '--color-mark-missed',
};

export const WRONG_VAR = '--color-mark-wrong';
export const SHORT_VAR = '--color-mark-short';
export const DEFAULT_INK = '#000000';

// Colour of a marked step: a scored step gets its place on the red -> yellow -> green gradient,
// a missed step the missed colour, an unscored hit (for example the first note in wait mode) the hit colour.
export function markColour(
  outcome: StepOutcome,
  score: number | null,
  readVar: (name: string, fallback: string) => string,
  colours: TimingColours = DEFAULT_COLOURS,
): string {
  if (outcome === 'missed' || score === null) return readVar(MARK_VARS[outcome], DEFAULT_INK);
  return scoreColour(score, colours, {
    low: readVar(SCORE_COLOUR_VARS.low, '#c8322a'),
    mid: readVar(SCORE_COLOUR_VARS.mid, '#d9a62b'),
    high: readVar(SCORE_COLOUR_VARS.high, '#2e8b45'),
  });
}

export interface Marks {
  setShort(step: number, short: boolean): void;
  shorts(): number[];
  setLong(step: number, long: boolean): void;
  longs(): number[];
  setOutcome(step: number, outcome: StepOutcome | null, score?: number | null): void;
  score(step: number): number | null;
  setWrong(step: number, attempts: number): void;
  outcome(step: number): StepOutcome | null;
  outcomes(): [number, StepOutcome][];
  wrongs(): [number, number][];
  setUneven(step: number, title: string | null): void;
  unevens(): [number, string][];
  clear(): void;
}

export function createMarks(): Marks {
  const outs = new Map<number, StepOutcome>();
  const scores = new Map<number, number>();
  const wr = new Map<number, number>();
  const sh = new Set<number>();
  const lo = new Set<number>();
  const un = new Map<number, string>();
  const sorted = <T>(m: Map<number, T>): [number, T][] => [...m.entries()].sort((a, b) => a[0] - b[0]);
  return {
    setOutcome(step, outcome, score = null) {
      if (outcome === null) outs.delete(step);
      else outs.set(step, outcome);
      if (outcome === null || score === null || score === undefined) scores.delete(step);
      else scores.set(step, score);
    },
    score: (step) => scores.get(step) ?? null,
    setWrong(step, attempts) {
      if (attempts <= 0) wr.delete(step);
      else wr.set(step, attempts);
    },
    setShort(step, short) {
      if (short) sh.add(step);
      else sh.delete(step);
    },
    shorts: () => [...sh].sort((a, b) => a - b),
    setLong(step, long) {
      if (long) lo.add(step);
      else lo.delete(step);
    },
    longs: () => [...lo].sort((a, b) => a - b),
    setUneven(step, title) {
      if (title === null) un.delete(step);
      else un.set(step, title);
    },
    unevens: () => sorted(un),
    outcome: (step) => outs.get(step) ?? null,
    outcomes: () => sorted(outs),
    wrongs: () => sorted(wr),
    clear() {
      outs.clear();
      scores.clear();
      wr.clear();
      sh.clear();
      lo.clear();
      un.clear();
    },
  };
}

export function latestByKey<T>(
  entries: readonly [number, T][],
  keyOf: (step: number) => unknown,
): [number, T][] {
  const best = new Map<unknown, [number, T]>();
  const out: [number, T][] = [];
  for (const e of entries) {
    const key = keyOf(e[0]);
    if (key === null || key === undefined) {
      out.push(e);
      continue;
    }
    const prev = best.get(key);
    if (!prev || e[0] > prev[0]) best.set(key, e);
  }
  out.push(...best.values());
  return out.sort((a, b) => a[0] - b[0]);
}
