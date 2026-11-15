export interface PracticeCounts {
  mode: 'wait' | 'live';
  bpm: number | null;
  expectedNotes: number;
  correctNotes: number;
  wrongNotes: number;
  missedNotes: number;
  hitSteps: number;
  earlySteps: number;
  lateSteps: number;
  missedSteps: number;
  offsetSumMs: number;
  offsetCount: number;
  firstHitAt: number | null;
  lastHitAt: number | null;
  firstHitQ: number | null;
  lastHitQ: number | null;
  cycles: number;
  startedAt: number;
  endedAt: number | null;
  bpmMin?: number | null;
  bpmMax?: number | null;
  shortNotes?: number;
  // Staccato notes held past holds.staccatoMaxPercent.
  longNotes?: number;
  holdChecked?: number;
  timingScoreSum?: number;
  timingScoreCount?: number;
  // wait-mode pace from the median gap per written quarter
  paceBpm?: number | null;
  ramp?: { startPercent: number; percent: number; topPercent: number; targetPercent: number } | null;
}

export interface MetricTexts {
  accuracy: string;
  tempo: string;
  wrong: string;
  missed: string;
  timing: string;
}

// Mean graded timing score (0-100) of the scored steps, or null when none was scored.
export function timingScorePercent(c: PracticeCounts): number | null {
  const n = c.timingScoreCount ?? 0;
  if (!(n > 0)) return null;
  return Math.round((c.timingScoreSum ?? 0) / n);
}

export function accuracyPercent(c: PracticeCounts): number | null {
  const total = c.correctNotes + c.missedNotes + c.wrongNotes;
  if (total === 0) return null;
  return Math.round((100 * c.correctNotes) / total);
}

export const MIN_PACE_GAP_MS = 60;

export function paceSample(prevAt: number | null, prevQ: number | null, at: number, q: number): number | null {
  if (prevAt === null || prevQ === null) return null;
  if (!(q - prevQ > 0) || at - prevAt < MIN_PACE_GAP_MS) return null;
  return (at - prevAt) / (q - prevQ);
}

export function medianPaceBpm(samples: readonly number[]): number | null {
  if (samples.length === 0) return null;
  const s = [...samples].sort((a, b) => a - b);
  const m = s.length >> 1;
  const median = s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  return Math.round(60000 / median);
}

export function playedBpm(c: PracticeCounts): number | null {
  if (c.paceBpm !== undefined) return c.paceBpm;
  if (c.firstHitAt === null || c.lastHitAt === null || c.firstHitQ === null || c.lastHitQ === null) return null;
  const dq = c.lastHitQ - c.firstHitQ;
  const dt = c.lastHitAt - c.firstHitAt;
  if (!(dq > 0) || !(dt > 0)) return null;
  return Math.round((dq * 60000) / dt);
}

export function formatDuration(ms: number): string {
  const total = Math.floor(Math.max(0, ms) / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

export function offsetText(c: PracticeCounts): string {
  if (c.offsetCount === 0) return '-';
  const mean = c.offsetSumMs / c.offsetCount;
  if (Math.abs(mean) < 10) return 'on time';
  if (mean < 0) return `${Math.round(-mean)} ms early`;
  return `${Math.round(mean)} ms late`;
}

export function metricTexts(c: PracticeCounts | null, nowBpm: number | null = null): MetricTexts {
  if (c === null) return { accuracy: '-', tempo: '-', wrong: '-', missed: '-', timing: '-' };
  const acc = accuracyPercent(c);
  let tempo = '-';
  if (c.mode === 'wait') {
    const b = playedBpm(c);
    if (b !== null) tempo = String(b);
  } else if (nowBpm !== null) {
    tempo = String(Math.round(nowBpm));
  } else if (c.bpm !== null) {
    tempo = String(Math.round(c.bpm));
  }
  return {
    accuracy: acc === null ? '-' : `${acc}%`,
    tempo,
    wrong: String(c.wrongNotes),
    missed: c.mode === 'wait' ? '-' : String(c.missedNotes),
    timing: timingText(c),
  };
}

export function timingText(c: PracticeCounts): string {
  const t = timingScorePercent(c);
  return t === null ? '-' : String(t);
}

export function summaryRows(
  c: PracticeCounts,
  ctx: { hands: string; bars: string; percent: number | null },
): [string, string][] {
  const live = c.mode === 'live';
  const acc = accuracyPercent(c);
  const rows: [string, string][] = [
    ['Mode', live ? 'Live' : 'Wait'],
    ['Hands', ctx.hands],
    ['Bars', ctx.bars],
    ['Accuracy', acc === null ? '-' : `${acc}%`],
    [
      'Notes',
      live
        ? `${c.correctNotes} of ${c.expectedNotes} in time, ${c.missedNotes} missed, ${c.wrongNotes} wrong`
        : `${c.correctNotes} correct, ${c.wrongNotes} wrong`,
    ],
  ];
  const ts = timingScorePercent(c);
  if (ts !== null) rows.push(['Timing score', `${ts} of 100 (${c.timingScoreCount} notes)`]);
  if (live) {
    rows.push([
      'Timing',
      `${c.hitSteps} on time, ${c.earlySteps} early, ${c.lateSteps} late, ${c.missedSteps} missed`,
    ]);
    rows.push(['Average offset', offsetText(c)]);
  }
  let tempo = '-';
  if (live) {
    if (c.bpm !== null) {
      tempo = `${Math.round(c.bpm)} bpm`;
      if (typeof c.bpmMin === 'number' && typeof c.bpmMax === 'number') {
        const lo = Math.round(c.bpmMin);
        const hi = Math.round(c.bpmMax);
        if (lo !== hi) tempo = `${lo}-${hi} bpm`;
      }
      if (ctx.percent !== null) tempo += ` (${ctx.percent}%)`;
    }
  } else {
    const b = playedBpm(c);
    if (b !== null) tempo = `${b} bpm (your pace)`;
  }
  const checked = c.holdChecked ?? 0;
  if (checked > 0) {
    const short = c.shortNotes ?? 0;
    const long = c.longNotes ?? 0;
    const tail = long > 0 ? `, ${long} too long` : '';
    rows.push(['Held notes', `${checked - short - long} of ${checked} held, ${short} short${tail}`]);
  }
  rows.push(['Tempo', tempo]);
  if (c.ramp) {
    const { startPercent, topPercent, targetPercent } = c.ramp;
    const span = topPercent === startPercent ? `${startPercent}%` : `${startPercent}% to ${topPercent}%`;
    rows.push(['Ramp', topPercent >= targetPercent ? `${span}, target reached` : `${span} (target ${targetPercent}%)`]);
  }
  rows.push(['Time', formatDuration((c.endedAt ?? c.startedAt) - c.startedAt)]);
  if (c.cycles > 0) rows.push(['Loops', String(c.cycles)]);
  return rows;
}
