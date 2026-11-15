// Ear-training stats: per-round summaries, the last-5 comparison, the category
// breakdown, the clean-run text, the summary model and the trend chart geometry.
// Pure, no DOM.

import { EAR_TARGETS_MS } from './ear-levels.ts';
import type { EarLevelDef, EarRound, EarRoundItem, SpeedKind } from './ear-levels.ts';
import { formatSeconds, median } from './sight-levels.ts';
import type { PlanTree } from './skills-logic.ts';

type StepLike = Pick<EarRoundItem, 'response_ms' | 'answer_steps'>;
type ItemLike = Pick<EarRoundItem, 'first_try' | 'response_ms' | 'answer_steps' | 'replays' | 'revealed'>;

export interface EarRoundStats {
  items: number;
  firstTry: number;
  accuracy: number | null;
  medianStepMs: number | null;
  replays: number;
  revealed: number;
}

export interface EarComparison {
  rounds: number;
  accuracy: number | null;
  medianStepMs: number | null;
}

export interface CategoryStat {
  category: string;
  items: number;
  firstTry: number;
  share: number;
}

export interface EarSummaryModel {
  rows: [string, string][];
  compare: string;
  clean: string;
}

export interface TrendPoint {
  x: number;
  y: number;
}

export interface EarTrend {
  accuracy: TrendPoint[];
  time: TrendPoint[];
  maxMs: number;
}

function pct(v: number | null): string {
  return Math.round((v ?? 0) * 100) + '%';
}

function mean(values: readonly (number | null)[]): number | null {
  const present = values.filter((v): v is number => v !== null);
  return present.length === 0 ? null : present.reduce((a, b) => a + b, 0) / present.length;
}

export function stepMs(record: StepLike): number | null {
  return record.response_ms === null ? null : record.response_ms / Math.max(1, record.answer_steps);
}

export function earRoundStats(records: readonly ItemLike[]): EarRoundStats {
  const items = records.length;
  const firstTry = records.filter((r) => r.first_try).length;
  const steps = records.map((r) => stepMs(r)).filter((v): v is number => v !== null);
  return {
    items,
    firstTry,
    accuracy: items === 0 ? null : firstTry / items,
    medianStepMs: median(steps),
    replays: records.reduce((sum, r) => sum + r.replays, 0),
    revealed: records.filter((r) => r.revealed).length,
  };
}

export function roundsOfLevel(rounds: readonly EarRound[], level: string, last?: number): EarRound[] {
  const matching = rounds.filter((r) => r.level === level);
  if (last === undefined) return matching;
  return matching.slice(Math.max(0, matching.length - last));
}

export function compareLast(prior: readonly EarRound[], level: string, n = 5): EarComparison {
  const rounds = roundsOfLevel(prior, level).filter((r) => r.items.length > 0);
  const last = rounds.slice(Math.max(0, rounds.length - n));
  return {
    rounds: last.length,
    accuracy: mean(last.map((r) => r.accuracy)),
    medianStepMs: mean(last.map((r) => r.median_step_ms)),
  };
}

export function categoryStats(rounds: readonly EarRound[]): CategoryStat[] {
  const byCategory = new Map<string, { items: number; firstTry: number }>();
  for (const round of rounds) {
    for (const item of round.items) {
      const acc = byCategory.get(item.category) ?? { items: 0, firstTry: 0 };
      acc.items++;
      if (item.first_try) acc.firstTry++;
      byCategory.set(item.category, acc);
    }
  }
  return [...byCategory.entries()]
    .map(([category, acc]) => ({
      category,
      items: acc.items,
      firstTry: acc.firstTry,
      share: acc.firstTry / acc.items,
    }))
    .sort((a, b) => a.share - b.share || a.category.localeCompare(b.category));
}

export function cleanText(stats: EarRoundStats, kind: SpeedKind, complete: boolean, counted: boolean): string {
  if (!complete) return 'Stopped early: only finished rounds count.';
  if (!counted) return 'Changed settings: this round does not count toward a drill.';
  const t = EAR_TARGETS_MS[kind];
  const accuracy = stats.accuracy ?? 0;
  if (accuracy < 0.9) return `First try ${Math.round(accuracy * 100)}%: Good enough needs 90%.`;
  if (stats.medianStepMs !== null && stats.medianStepMs > t.good) {
    return `Median ${formatSeconds(stats.medianStepMs)} per answer: Good enough needs ${formatSeconds(t.good)} or less.`;
  }
  if (accuracy >= 0.95 && stats.medianStepMs !== null && stats.medianStepMs <= t.solid) {
    return 'Counts toward Solid and Good enough.';
  }
  return 'Counts toward Good enough.';
}

export function liveStatsText(item: number, total: number, stats: EarRoundStats): string {
  const parts = [`Question ${item} of ${total}`, `first try ${stats.firstTry} of ${stats.items}`];
  if (stats.medianStepMs !== null) parts.push(`median ${formatSeconds(stats.medianStepMs)}`);
  return parts.join(' · ');
}

export function summaryModel(
  records: readonly ItemLike[],
  prior: readonly EarRound[],
  level: EarLevelDef,
  complete: boolean,
  counted: boolean,
): EarSummaryModel {
  const s = earRoundStats(records);
  const cmp = compareLast(prior, level.id);
  const lastText = cmp.rounds === 1 ? 'last round' : `last ${cmp.rounds} rounds`;
  return {
    rows: [
      ['First try', `${s.firstTry} of ${s.items} (${pct(s.accuracy)})`],
      ['Median time per answer', formatSeconds(s.medianStepMs)],
      ['Replays', String(s.replays)],
      ['Revealed', String(s.revealed)],
    ],
    compare:
      cmp.rounds === 0
        ? 'First round on this level.'
        : `First try ${pct(cmp.accuracy)} vs ${pct(s.accuracy)}, median ${formatSeconds(cmp.medianStepMs)} vs ${formatSeconds(s.medianStepMs)} over the ${lastText}.`,
    clean: cleanText(s, level.kind, complete, counted),
  };
}

export function trendChart(rounds: readonly EarRound[], width: number, height: number, last = 20): EarTrend {
  const shown = rounds.slice(Math.max(0, rounds.length - last));
  const n = shown.length;
  const xAt = (i: number) => (n === 1 ? width / 2 : (i * width) / (n - 1));
  const maxMs = Math.max(1, ...shown.map((r) => r.median_step_ms ?? 0));
  return {
    accuracy: shown.flatMap((r, i) =>
      r.accuracy === null ? [] : [{ x: xAt(i), y: height * (1 - r.accuracy) }],
    ),
    time: shown.flatMap((r, i) =>
      r.median_step_ms === null ? [] : [{ x: xAt(i), y: height * (1 - r.median_step_ms / maxMs) }],
    ),
    maxMs,
  };
}

export function earTreeHasDrills(tree: PlanTree): boolean {
  return tree.nodes.some((n) => n.drills.some((d) => d.id.startsWith('ear.')));
}
