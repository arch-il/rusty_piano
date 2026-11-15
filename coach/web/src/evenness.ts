import type { Hands } from './practice-steps';
import type { AttemptV2 } from './attempt-recorder';

export const SCALES_PREFIX = 'scales:';

export interface EvennessConstants {
  perfect_cv: number;
  zero_cv: number;
  align_perfect_ms: number;
  align_zero_ms: number;
  weak_min_dev: number;
  min_intervals: number;
  max_weak_spots: number;
}

export const EVENNESS_CONSTANTS: Readonly<EvennessConstants> = Object.freeze({
  perfect_cv: 0.03,
  zero_cv: 0.25,
  align_perfect_ms: 15,
  align_zero_ms: 120,
  weak_min_dev: 0.15,
  min_intervals: 4,
  max_weak_spots: 5,
});

export type EvennessHand = 'right' | 'left';

export interface EvennessStep {
  cycle: number;
  step: number;
  source_step: number;
  bar: number;
  time_q: number;
  expected: readonly number[];
  played: readonly { note: number; page_ms: number }[];
}

export interface EvennessInput {
  score_id: string;
  hands: Hands;
  steps: readonly EvennessStep[];
}

export interface HandEvenness {
  score: number | null;
  cv: number | null;
  intervals: number;
  mean_ms: number | null;
}

export interface WeakSpot {
  hand: EvennessHand;
  cycle: number;
  step: number;
  source_step: number;
  bar: number;
  deviation: number;
  gap_ms: number;
}

export interface HandsAlignment {
  score: number | null;
  mean_ms: number | null;
  steps: number;
}

export interface Evenness {
  version: 1;
  constants: EvennessConstants;
  right: HandEvenness | null;
  left: HandEvenness | null;
  combined: number | null;
  alignment: HandsAlignment | null;
  weak_spots: WeakSpot[];
}

export type AttemptWithEvenness = AttemptV2 & { evenness?: Evenness };

export function isScaleScore(id: string): boolean {
  return id.startsWith(SCALES_PREFIX);
}

function roundInt(x: number): number {
  return Math.floor(x + 0.5);
}

function r3(x: number): number {
  return Math.floor(x * 1000 + 0.5) / 1000 + 0;
}

function r1(x: number): number {
  return Math.floor(x * 10 + 0.5) / 10 + 0;
}

export function evennessScore(cv: number): number {
  const c = EVENNESS_CONSTANTS;
  if (cv <= c.perfect_cv) return 100;
  if (cv >= c.zero_cv) return 0;
  return roundInt(100 * (1 - (cv - c.perfect_cv) / (c.zero_cv - c.perfect_cv)));
}

export function alignmentScore(diffMs: number): number {
  const c = EVENNESS_CONSTANTS;
  if (diffMs <= c.align_perfect_ms) return 100;
  if (diffMs >= c.align_zero_ms) return 0;
  return roundInt(100 * (1 - (diffMs - c.align_perfect_ms) / (c.align_zero_ms - c.align_perfect_ms)));
}

type HandMap = { left?: number; right?: number };

export function scaleEvenness(input: EvennessInput): Evenness {
  const c = EVENNESS_CONSTANTS;
  const steps = [...input.steps].sort((a, b) => a.cycle - b.cycle || a.step - b.step);
  const dh: EvennessHand =
    input.hands === 'left'
      ? 'left'
      : input.hands === 'right'
        ? 'right'
        : input.score_id.endsWith('-lh')
          ? 'left'
          : 'right';

  const handMap = (s: EvennessStep): HandMap => {
    if (s.expected.length >= 2) return { left: Math.min(...s.expected), right: Math.max(...s.expected) };
    if (s.expected.length === 1) return { [dh]: s.expected[0] };
    return {};
  };
  const maps = steps.map(handMap);

  const onset = (i: number, h: EvennessHand): number | null => {
    const pitch = maps[i][h];
    if (pitch === undefined) return null;
    let best: number | null = null;
    for (const pl of steps[i].played) {
      if (pl.note === pitch && Number.isFinite(pl.page_ms) && (best === null || pl.page_ms < best)) {
        best = pl.page_ms;
      }
    }
    return best;
  };

  const H = (['right', 'left'] as const).filter((h) => maps.some((m) => m[h] !== undefined));

  const result: Record<EvennessHand, HandEvenness | null> = { right: null, left: null };
  const candidates: { w: WeakSpot; abs: number; hi: number }[] = [];

  for (const h of H) {
    const pairs: { a: EvennessStep; b: EvennessStep; gap: number; ioi: number }[] = [];
    for (let i = 0; i + 1 < steps.length; i++) {
      const a = steps[i];
      const b = steps[i + 1];
      if (a.cycle !== b.cycle || b.step !== a.step + 1) continue;
      const oa = onset(i, h);
      const ob = onset(i + 1, h);
      if (oa === null || ob === null) continue;
      const gap = Math.floor((b.time_q - a.time_q) * 1e6 + 0.5) / 1e6;
      pairs.push({ a, b, gap, ioi: ob - oa });
    }

    const counts = new Map<number, number>();
    for (const p of pairs) counts.set(p.gap, (counts.get(p.gap) ?? 0) + 1);
    let main = 0;
    let mainCount = 0;
    for (const [gap, count] of counts) {
      if (count > mainCount || (count === mainCount && gap < main)) {
        main = gap;
        mainCount = count;
      }
    }

    const kept = pairs.filter((p) => p.gap === main && p.ioi > 0);
    const n = kept.length;
    if (n < c.min_intervals) {
      result[h] = { score: null, cv: null, intervals: n, mean_ms: null };
      continue;
    }

    const iois = kept.map((p) => p.ioi);
    const mean = iois.reduce((s, x) => s + x, 0) / n;
    const variance = iois.reduce((s, x) => s + (x - mean) * (x - mean), 0) / n;
    const cv = Math.sqrt(variance) / mean;
    result[h] = { score: evennessScore(cv), cv: r3(cv), intervals: n, mean_ms: r1(mean) };

    for (const p of kept) {
      const dev = (p.ioi - mean) / mean;
      if (Math.abs(dev) >= c.weak_min_dev) {
        candidates.push({
          w: {
            hand: h,
            cycle: p.b.cycle,
            step: p.b.step,
            source_step: p.b.source_step,
            bar: p.b.bar,
            deviation: r3(dev),
            gap_ms: r1(p.ioi),
          },
          abs: Math.abs(dev),
          hi: h === 'right' ? 0 : 1,
        });
      }
    }
  }

  candidates.sort(
    (x, y) =>
      y.abs - x.abs ||
      x.w.cycle - y.w.cycle ||
      x.w.step - y.w.step ||
      x.hi - y.hi,
  );
  const weak_spots = candidates.slice(0, c.max_weak_spots).map((x) => x.w);

  const scores = [result.right, result.left]
    .map((h) => h?.score)
    .filter((s): s is number => s !== null && s !== undefined);
  const combined = scores.length ? roundInt(scores.reduce((s, x) => s + x, 0) / scores.length) : null;

  let alignment: HandsAlignment | null = null;
  if (H.length === 2) {
    const diffs: number[] = [];
    for (let i = 0; i < steps.length; i++) {
      const r = onset(i, 'right');
      const l = onset(i, 'left');
      if (r !== null && l !== null) diffs.push(Math.abs(r - l));
    }
    const n = diffs.length;
    alignment = {
      score: n ? roundInt(diffs.reduce((s, d) => s + alignmentScore(d), 0) / n) : null,
      mean_ms: n ? r1(diffs.reduce((s, d) => s + d, 0) / n) : null,
      steps: n,
    };
  }

  return {
    version: 1,
    constants: { ...EVENNESS_CONSTANTS },
    right: result.right,
    left: result.left,
    combined,
    alignment,
    weak_spots,
  };
}

export function evennessRows(e: Evenness): [string, string][] {
  const f = (x: number | null) => (x === null ? '-' : String(x));
  const rows: [string, string][] = [];
  if (e.right && e.left) {
    rows.push(
      ['Evenness', e.combined === null ? '-' : `${e.combined} of 100`],
      ['Evenness R / L', `${f(e.right.score)} / ${f(e.left.score)}`],
      [
        'Hands together',
        e.alignment === null || e.alignment.score === null
          ? '-'
          : `${e.alignment.score} of 100, ${e.alignment.mean_ms} ms apart`,
      ],
    );
  } else {
    rows.push(['Evenness', e.combined === null ? '- (too few notes)' : `${e.combined} of 100`]);
  }
  if (e.weak_spots.length) {
    const bars = [...new Set(e.weak_spots.map((w) => w.bar))].sort((a, b) => a - b);
    rows.push(['Uneven spots', bars.length === 1 ? `bar ${bars[0]}` : `bars ${bars.join(', ')}`]);
  }
  return rows;
}

export function unevenTitle(w: WeakSpot): string {
  return `Uneven: the gap before this note was ${Math.round(Math.abs(w.deviation) * 100)}% ${
    w.deviation > 0 ? 'longer' : 'shorter'
  } than average (${w.hand} hand)`;
}

export function attachEvenness(attempt: AttemptWithEvenness): Evenness | null {
  if (!isScaleScore(attempt.score.id)) return null;
  const ev = scaleEvenness({ score_id: attempt.score.id, hands: attempt.practice.hands, steps: attempt.steps });
  attempt.evenness = ev;
  attempt.summary.rows.push(...evennessRows(ev));
  return ev;
}
