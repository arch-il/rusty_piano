import { drillHash } from './drill-link.ts';

export interface LogDay {
  date: string;
  minutes: number;
  sessions: number;
  attempts: number;
}

export interface LogRun {
  id: string | null;
  started_at: string;
  date: string;
  time: string;
  minutes: number;
  accuracy: number | null;
  mode: string | null;
  end: string | null;
}

export interface LogPiece {
  score_id: string;
  title: string | null;
  attempts: number;
  minutes: number;
  first: string | null;
  last: string | null;
  best_accuracy: number | null;
  last_accuracy?: number | null;
  runs?: LogRun[];
}

export interface LogResponse {
  version: number;
  kind: string;
  today: string;
  window_days: number;
  days: LogDay[];
  streak: { current: number; longest: number };
  total_minutes: number;
  window_minutes: number;
  pieces: LogPiece[];
  inputs: { sessions: number; attempts: number; skipped: string[] };
}

export const LOG_DAYS = 30;
export const RUNS_SHOWN = 5;
export const NO_PRACTICE_MESSAGE = 'No practice yet. Open a piece and press Follow; every run is saved and shows up here.';
export const NO_PIECES_MESSAGE = 'No pieces yet. Pieces come from Follow runs; session recordings only add minutes.';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function addDays(iso: string, n: number): string {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function minutesText(m: number): string {
  if (m <= 0) return '0 min';
  if (m < 0.5) return '<1 min';
  const total = Math.round(m);
  if (total >= 60) {
    const h = Math.floor(total / 60);
    const r = total % 60;
    return r === 0 ? `${h} h` : `${h} h ${r} min`;
  }
  return `${total} min`;
}

export function daysText(n: number): string {
  return n === 1 ? '1 day' : `${n} days`;
}

export function accuracyText(a: number | null | undefined): string {
  if (a === null || a === undefined) return '-';
  return `${Math.round(a * 100)}%`;
}

export interface DayBar {
  date: string;
  minutes: number;
  weekday: string;
  label: string;
  showLabel: boolean;
  title: string;
}

export function dayBars(log: LogResponse, count = LOG_DAYS): DayBar[] {
  const byDate = new Map<string, number>();
  for (const d of log.days) byDate.set(d.date, d.minutes);
  const bars: DayBar[] = [];
  for (let i = 0; i < count; i++) {
    const date = addDays(log.today, -(count - 1 - i));
    const minutes = byDate.get(date) ?? 0;
    const weekday = WEEKDAYS[new Date(date + 'T00:00:00Z').getUTCDay()];
    bars.push({
      date,
      minutes,
      weekday,
      label: date.slice(5),
      showLabel: (count - 1 - i) % 7 === 0,
      title: `${weekday} ${date}: ${minutesText(minutes)}`,
    });
  }
  return bars;
}

export function weekMinutes(log: LogResponse): number {
  const dow = new Date(log.today + 'T00:00:00Z').getUTCDay();
  const monday = addDays(log.today, -((dow + 6) % 7));
  let sum = 0;
  for (const d of log.days) {
    if (d.date >= monday && d.date <= log.today) sum += d.minutes;
  }
  return Math.round(sum * 10) / 10;
}

export function todayMinutes(log: LogResponse): number {
  return log.days.find((d) => d.date === log.today)?.minutes ?? 0;
}

export function summaryItems(log: LogResponse): [string, string][] {
  const month = dayBars(log).reduce((s, b) => s + b.minutes, 0);
  return [
    ['Today', minutesText(todayMinutes(log))],
    ['Current streak', daysText(log.streak.current)],
    ['Best streak', daysText(log.streak.longest)],
    ['This week', minutesText(weekMinutes(log))],
    ['Last 30 days', minutesText(month)],
    ['All time', minutesText(log.total_minutes)],
  ];
}

export interface RunRow {
  attemptId: string | null;
  when: string;
  accuracyText: string;
  minutesText: string;
  mode: string;
}

export interface PieceRow {
  scoreId: string;
  title: string;
  href: string;
  minutesText: string;
  runsText: string;
  lastAccuracyText: string;
  lastDate: string;
  runs: RunRow[];
}

export function pieceRows(log: LogResponse): PieceRow[] {
  return log.pieces.map((p) => ({
    scoreId: p.score_id,
    title: p.title ?? p.score_id,
    href: drillHash(p.score_id, {}),
    minutesText: minutesText(p.minutes),
    runsText: p.attempts === 1 ? '1 run' : `${p.attempts} runs`,
    lastAccuracyText: accuracyText(p.last_accuracy),
    lastDate: p.last ?? '',
    runs: (p.runs ?? []).slice(0, RUNS_SHOWN).map((r) => ({
      attemptId: r.id,
      when: `${r.date} ${r.time}`,
      accuracyText: accuracyText(r.accuracy),
      minutesText: minutesText(r.minutes),
      mode: r.mode ?? '',
    })),
  }));
}

export function pieceMeta(row: PieceRow): string {
  const base = `${row.minutesText}, ${row.runsText}, last accuracy ${row.lastAccuracyText}`;
  return row.lastDate !== '' ? `${base}, last played ${row.lastDate}` : base;
}

export function skippedText(log: LogResponse): string {
  const n = log.inputs.skipped.length;
  if (n === 0) return '';
  if (n === 1) return '1 file could not be read (run uv run coach log to see it)';
  return `${n} files could not be read (run uv run coach log to see them)`;
}

export interface BarRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const round2 = (v: number): number => Math.round(v * 100) / 100;

export function barLayout(
  bars: DayBar[],
  width: number,
  height: number,
  gap: number,
): { rects: BarRect[]; max: number } {
  const n = bars.length;
  if (n === 0) return { rects: [], max: 1 };
  const max = Math.max(1, ...bars.map((b) => b.minutes));
  const w = (width - gap * (n - 1)) / n;
  const rects = bars.map((b, i) => {
    const h = b.minutes <= 0 ? 0 : Math.max(2, (b.minutes / max) * height);
    return { x: round2(i * (w + gap)), y: round2(height - h), w: round2(w), h: round2(h) };
  });
  return { rects, max };
}
