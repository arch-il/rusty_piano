// Sight-reading ladder: level definitions, the shared card/history types and the
// stats helpers. Pure data and functions, no DOM.

export type LevelId =
  | 'r2-treble'
  | 'r3-bass'
  | 'r4-grand'
  | 'r5-intervals'
  | 'r6-ledger'
  | 'r7-keys'
  | 'r8a-five'
  | 'r8b-wide'
  | 'r8c-hands'
  | 'custom';

export type LevelKind = 'notes' | 'intervals' | 'bars';
export type Clef = 'treble' | 'bass' | 'grand';
export type SightHands = 'right' | 'left' | 'both';

export interface LevelDef {
  id: LevelId;
  node: string | null;
  drill: string;
  kind: LevelKind;
  hands: SightHands;
  clef: Clef;
  cards: number;
  title: string;
}

export interface CustomRange {
  clef: Clef;
  low: number;
  high: number;
  accidentals: boolean;
}

export interface Pitch {
  step: 'C' | 'D' | 'E' | 'F' | 'G' | 'A' | 'B';
  alter: -1 | 0 | 1;
  octave: number;
}

export interface CardNote {
  midi: number;
  staff: 1 | 2;
  pitch: Pitch;
  quarters: number;
}

export interface CardStep {
  time: number;
  pitches: number[];
  notes: CardNote[];
}

export interface Card {
  index: number;
  clef: Clef;
  fifths: number;
  showTime: boolean;
  measures: number;
  steps: CardStep[];
}

export interface SightStepRecord {
  step: number;
  card: number;
  notes: number[];
  result: 'hit' | 'wrong';
  first_try: boolean;
  wrong_count: number;
  wrong_notes: number[];
  hinted: boolean;
  reaction_ms: number;
  shown_page_ms: number;
  done_page_ms: number;
}

export interface SightRoundStep {
  notes: number[];
  first_try: boolean;
  reaction_ms: number | null;
  hinted: boolean;
  wrong_count: number;
}

export interface SightRound {
  id: string;
  started_at: string;
  level: string;
  drill_id: string | null;
  end: string;
  accuracy: number | null;
  median_ms: number | null;
  steps: SightRoundStep[];
}

export interface SightHistory {
  rounds: SightRound[];
}

export interface RoundStats {
  steps: number;
  firstTry: number;
  accuracy: number | null;
  medianMs: number | null;
  meanMs: number | null;
  hinted: number;
  wrongNotes: number;
}

export const LEVELS: readonly LevelDef[] = [
  { id: 'r2-treble', node: 'R2', drill: 'sr.r2-treble', kind: 'notes', hands: 'right', clef: 'treble', cards: 20, title: 'Treble C-G notes' },
  { id: 'r3-bass', node: 'R3', drill: 'sr.r3-bass', kind: 'notes', hands: 'left', clef: 'bass', cards: 20, title: 'Bass C-G notes' },
  { id: 'r4-grand', node: 'R4', drill: 'sr.r4-grand', kind: 'notes', hands: 'both', clef: 'grand', cards: 20, title: 'Grand staff C3-C5' },
  { id: 'r5-intervals', node: 'R5', drill: 'sr.r5-intervals', kind: 'intervals', hands: 'both', clef: 'treble', cards: 20, title: 'Intervals 2nd-5th' },
  { id: 'r6-ledger', node: 'R6', drill: 'sr.r6-ledger', kind: 'notes', hands: 'both', clef: 'treble', cards: 20, title: 'Ledger line notes' },
  { id: 'r7-keys', node: 'R7', drill: 'sr.r7-keys', kind: 'notes', hands: 'both', clef: 'grand', cards: 20, title: 'One sharp or flat' },
  { id: 'r8a-five', node: 'R8', drill: 'sr.r8a-five', kind: 'bars', hands: 'both', clef: 'treble', cards: 4, title: 'Phrases: five-finger' },
  { id: 'r8b-wide', node: 'R8', drill: 'sr.r8b-wide', kind: 'bars', hands: 'both', clef: 'treble', cards: 4, title: 'Phrases: wider range' },
  { id: 'r8c-hands', node: 'R8', drill: 'sr.r8c-hands', kind: 'bars', hands: 'both', clef: 'grand', cards: 4, title: 'Phrases: both hands' },
  { id: 'custom', node: null, drill: 'sr.custom', kind: 'notes', hands: 'both', clef: 'treble', cards: 20, title: 'Custom range' },
];

export const SPEED_TARGETS_MS = {
  notes: { good: 2000, solid: 1200, mastered: 800 },
  intervals: { good: 3000, solid: 2000, mastered: 1400 },
  bars: { good: 1500, solid: 1000, mastered: 700 },
};

export const HINT_AFTER = 2;
export const SIGHT_TAG = 'sight-reading';
export const SCORE_PREFIX = 'sight:';
export const KEY_LOW = 36;
export const KEY_HIGH = 84;
export const DEFAULT_CUSTOM: CustomRange = { clef: 'treble', low: 60, high: 72, accidentals: false };

const WHITE_PITCH_CLASSES = [0, 2, 4, 5, 7, 9, 11];

function hasWhiteKey(low: number, high: number): boolean {
  for (let m = low; m <= high; m++) {
    if (WHITE_PITCH_CLASSES.includes(m % 12)) return true;
  }
  return false;
}

function intOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isInteger(value) ? value : fallback;
}

export function levelById(id: string): LevelDef | null {
  return LEVELS.find((l) => l.id === id) ?? null;
}

export function normalizeCustom(p: Partial<CustomRange>): CustomRange {
  const clamp = (v: number) => Math.min(KEY_HIGH, Math.max(KEY_LOW, v));
  let low = clamp(intOr(p.low, DEFAULT_CUSTOM.low));
  let high = clamp(intOr(p.high, DEFAULT_CUSTOM.high));
  if (low > high) [low, high] = [high, low];
  let accidentals = p.accidentals ?? DEFAULT_CUSTOM.accidentals;
  if (!accidentals && !hasWhiteKey(low, high)) accidentals = true;
  return { clef: p.clef ?? DEFAULT_CUSTOM.clef, low, high, accidentals };
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function formatSeconds(ms: number | null): string {
  return ms === null ? '-' : (ms / 1000).toFixed(1) + ' s';
}

export function roundStats(records: readonly SightStepRecord[]): RoundStats {
  const steps = records.length;
  const firstTry = records.filter((r) => r.first_try).length;
  const reactions = records.map((r) => r.reaction_ms);
  const meanMs = reactions.length === 0 ? null : reactions.reduce((a, b) => a + b, 0) / reactions.length;
  return {
    steps,
    firstTry,
    accuracy: steps === 0 ? null : firstTry / steps,
    medianMs: median(reactions),
    meanMs,
    hinted: records.filter((r) => r.hinted).length,
    wrongNotes: records.reduce((sum, r) => sum + r.wrong_count, 0),
  };
}
