// Ear-training ladder: level definitions, the shared card/history types and the
// settings helpers. Pure data and functions, no DOM.

import { EASY_TUNES, TUNE_IDS } from './ear-tunes.ts';

export type EarType = 'echo' | 'updown' | 'interval' | 'chord' | 'tune' | 'bass';
export type SpeedKind = 'note' | 'chord' | 'phrase';
export type EarNodeId = 'E1' | 'E2' | 'E3' | 'E4' | 'E5' | 'E6';
export type Given = 'none' | 'first' | 'root' | 'tonic';

export interface EarSettings {
  low: number;
  high: number;
  key: number | null;
  set: string[];
  direction: 'up' | 'down' | 'both';
  harmonic: 'melodic' | 'harmonic' | 'mixed';
  bpm: number;
  lenMin: number;
  lenMax: number;
}

export interface EarLevelDef {
  id: string;
  type: EarType;
  node: EarNodeId;
  drill: string;
  title: string;
  kind: SpeedKind;
  items: number;
  given: Given;
  defaults: EarSettings;
}

export interface PromptNote {
  note: number;
  startMs: number;
  durMs: number;
  velocity: number;
}

export type AnswerStep =
  | { kind: 'note'; pitch: number }
  | { kind: 'pc'; pc: number }
  | { kind: 'chord'; pcs: number[] };

export interface EarItem {
  index: number;
  type: EarType;
  category: string;
  label: string;
  prompt: PromptNote[];
  answerSound: PromptNote[];
  given: number[];
  answer: AnswerStep[];
  answerNotes: number[];
}

export interface EarStepRecord {
  step: number;
  item: number;
  type: EarType;
  category: string;
  label: string;
  prompt_notes: number[];
  given: number[];
  answer_notes: number[];
  answer_steps: number;
  result: 'hit' | 'wrong';
  first_try: boolean;
  wrong_count: number;
  wrong_notes: number[];
  replays: number;
  revealed: boolean;
  response_ms: number | null;
  asked_page_ms: number;
  done_page_ms: number;
}

export interface EarRoundItem {
  category: string;
  first_try: boolean;
  response_ms: number | null;
  answer_steps: number;
  replays: number;
  revealed: boolean;
}

export interface EarRound {
  id: string | null;
  started_at: string;
  level: string | null;
  drill_id: string | null;
  end: string | null;
  accuracy: number | null;
  median_step_ms: number | null;
  replays: number;
  items: EarRoundItem[];
}

export interface EarHistory {
  rounds: EarRound[];
}

export const SCORE_PREFIX = 'ear:';
export const EAR_TAG = 'ear-training';
export const REVEAL_AFTER = 3;
export const EAR_KEY_LOW = 36;
export const EAR_KEY_HIGH = 84;
export const DEFAULT_VELOCITY = 80;

export const EAR_TARGETS_MS: Record<SpeedKind, { good: number; solid: number; mastered: number }> = {
  note: { good: 5000, solid: 3000, mastered: 2000 },
  chord: { good: 8000, solid: 5000, mastered: 3500 },
  phrase: { good: 2500, solid: 1800, mastered: 1200 },
};

export const KEY_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

export const EAR_NODES: Record<EarNodeId, string> = {
  E1: 'Pitch and direction',
  E2: 'Intervals',
  E3: 'Chord quality',
  E4: 'Melodies and tunes',
  E5: 'Progressions',
  E6: 'Jazz basics: 7ths and ii-V-I',
};

export const INTERVALS: readonly { id: string; semitones: number; name: string }[] = [
  { id: 'm2', semitones: 1, name: 'Minor 2nd' },
  { id: 'M2', semitones: 2, name: 'Major 2nd' },
  { id: 'm3', semitones: 3, name: 'Minor 3rd' },
  { id: 'M3', semitones: 4, name: 'Major 3rd' },
  { id: 'P4', semitones: 5, name: 'Perfect 4th' },
  { id: 'TT', semitones: 6, name: 'Tritone' },
  { id: 'P5', semitones: 7, name: 'Perfect 5th' },
  { id: 'm6', semitones: 8, name: 'Minor 6th' },
  { id: 'M6', semitones: 9, name: 'Major 6th' },
  { id: 'm7', semitones: 10, name: 'Minor 7th' },
  { id: 'M7', semitones: 11, name: 'Major 7th' },
  { id: 'P8', semitones: 12, name: 'Octave' },
];

export const CHORDS: readonly { id: string; intervals: number[]; name: string }[] = [
  { id: 'maj', intervals: [0, 4, 7], name: 'major' },
  { id: 'min', intervals: [0, 3, 7], name: 'minor' },
  { id: 'dim', intervals: [0, 3, 6], name: 'diminished' },
  { id: 'aug', intervals: [0, 4, 8], name: 'augmented' },
  { id: 'maj7', intervals: [0, 4, 7, 11], name: 'major 7th' },
  { id: '7', intervals: [0, 4, 7, 10], name: 'dominant 7th' },
  { id: 'm7', intervals: [0, 3, 7, 10], name: 'minor 7th' },
  { id: 'm7b5', intervals: [0, 3, 6, 10], name: 'half-diminished 7th' },
  { id: 'dim7', intervals: [0, 3, 6, 9], name: 'diminished 7th' },
];

export const DEGREES: Record<string, { offset: number; chord: string }> = {
  I: { offset: 0, chord: 'maj' },
  ii: { offset: 2, chord: 'min' },
  iii: { offset: 4, chord: 'min' },
  IV: { offset: 5, chord: 'maj' },
  V: { offset: 7, chord: 'maj' },
  vi: { offset: 9, chord: 'min' },
  Imaj7: { offset: 0, chord: 'maj7' },
  ii7: { offset: 2, chord: 'm7' },
  V7: { offset: 7, chord: '7' },
  vi7: { offset: 9, chord: 'm7' },
};

export const PATTERNS: Record<string, string[]> = {
  'ii-V-I': ['ii7', 'V7', 'Imaj7'],
  'I-vi-ii-V': ['Imaj7', 'vi7', 'ii7', 'V7'],
};

export const SETS: Record<EarType, string[]> = {
  echo: ['scale', 'chromatic'],
  updown: ['higher', 'lower', 'step', 'skip'],
  interval: INTERVALS.map((i) => i.id),
  chord: CHORDS.map((c) => c.id),
  tune: [...TUNE_IDS],
  bass: ['I', 'ii', 'iii', 'IV', 'V', 'vi', 'ii-V-I', 'I-vi-ii-V'],
};

export const LEVELS: readonly EarLevelDef[] = [
  {
    id: 'echo-1',
    type: 'echo',
    node: 'E1',
    drill: 'ear.echo-1',
    title: 'Echo one note, C to G',
    kind: 'note',
    items: 10,
    given: 'none',
    defaults: { low: 60, high: 67, key: 0, set: ['scale'], direction: 'up', harmonic: 'melodic', bpm: 80, lenMin: 1, lenMax: 1 },
  },
  {
    id: 'echo-2',
    type: 'echo',
    node: 'E1',
    drill: 'ear.echo-2',
    title: 'Echo one note, C to C',
    kind: 'note',
    items: 10,
    given: 'none',
    defaults: { low: 60, high: 72, key: 0, set: ['scale'], direction: 'up', harmonic: 'melodic', bpm: 80, lenMin: 1, lenMax: 1 },
  },
  {
    id: 'echo-3',
    type: 'echo',
    node: 'E1',
    drill: 'ear.echo-3',
    title: 'Echo one note, black keys too',
    kind: 'note',
    items: 10,
    given: 'none',
    defaults: { low: 55, high: 76, key: 0, set: ['chromatic'], direction: 'up', harmonic: 'melodic', bpm: 80, lenMin: 1, lenMax: 1 },
  },
  {
    id: 'updown-1',
    type: 'updown',
    node: 'E1',
    drill: 'ear.updown-1',
    title: 'Higher or lower',
    kind: 'note',
    items: 10,
    given: 'first',
    defaults: { low: 60, high: 72, key: 0, set: ['higher', 'lower'], direction: 'both', harmonic: 'melodic', bpm: 80, lenMin: 2, lenMax: 2 },
  },
  {
    id: 'updown-2',
    type: 'updown',
    node: 'E1',
    drill: 'ear.updown-2',
    title: 'Step or skip',
    kind: 'note',
    items: 10,
    given: 'first',
    defaults: { low: 60, high: 72, key: 0, set: ['step', 'skip'], direction: 'both', harmonic: 'melodic', bpm: 80, lenMin: 2, lenMax: 2 },
  },
  {
    id: 'interval-1',
    type: 'interval',
    node: 'E2',
    drill: 'ear.interval-1',
    title: 'Intervals: 2nd, 3rd, 5th, octave',
    kind: 'note',
    items: 10,
    given: 'first',
    defaults: { low: 60, high: 67, key: 0, set: ['M2', 'M3', 'P5', 'P8'], direction: 'up', harmonic: 'melodic', bpm: 80, lenMin: 2, lenMax: 2 },
  },
  {
    id: 'interval-2',
    type: 'interval',
    node: 'E2',
    drill: 'ear.interval-2',
    title: 'Intervals: add minor 3rd, 4th, 6th',
    kind: 'note',
    items: 10,
    given: 'first',
    defaults: { low: 55, high: 67, key: 0, set: ['M2', 'm3', 'M3', 'P4', 'P5', 'M6', 'P8'], direction: 'up', harmonic: 'melodic', bpm: 80, lenMin: 2, lenMax: 2 },
  },
  {
    id: 'interval-3',
    type: 'interval',
    node: 'E2',
    drill: 'ear.interval-3',
    title: 'Intervals: all, upward',
    kind: 'note',
    items: 10,
    given: 'first',
    defaults: { low: 48, high: 67, key: null, set: [...SETS.interval], direction: 'up', harmonic: 'melodic', bpm: 80, lenMin: 2, lenMax: 2 },
  },
  {
    id: 'interval-4',
    type: 'interval',
    node: 'E2',
    drill: 'ear.interval-4',
    title: 'Intervals: all, up, down and together',
    kind: 'note',
    items: 10,
    given: 'first',
    defaults: { low: 48, high: 72, key: null, set: [...SETS.interval], direction: 'both', harmonic: 'mixed', bpm: 80, lenMin: 2, lenMax: 2 },
  },
  {
    id: 'chord-1',
    type: 'chord',
    node: 'E3',
    drill: 'ear.chord-1',
    title: 'Chords: major or minor, roots C to G',
    kind: 'chord',
    items: 10,
    given: 'root',
    defaults: { low: 60, high: 67, key: 0, set: ['maj', 'min'], direction: 'up', harmonic: 'melodic', bpm: 80, lenMin: 1, lenMax: 1 },
  },
  {
    id: 'chord-2',
    type: 'chord',
    node: 'E3',
    drill: 'ear.chord-2',
    title: 'Chords: major or minor, any root',
    kind: 'chord',
    items: 10,
    given: 'root',
    defaults: { low: 55, high: 67, key: null, set: ['maj', 'min'], direction: 'up', harmonic: 'melodic', bpm: 80, lenMin: 1, lenMax: 1 },
  },
  {
    id: 'chord-3',
    type: 'chord',
    node: 'E3',
    drill: 'ear.chord-3',
    title: 'Chords: major, minor, diminished, augmented',
    kind: 'chord',
    items: 10,
    given: 'root',
    defaults: { low: 55, high: 67, key: null, set: ['maj', 'min', 'dim', 'aug'], direction: 'up', harmonic: 'melodic', bpm: 80, lenMin: 1, lenMax: 1 },
  },
  {
    id: 'echo-4',
    type: 'echo',
    node: 'E4',
    drill: 'ear.echo-4',
    title: 'Echo 2-3 note phrases',
    kind: 'phrase',
    items: 8,
    given: 'first',
    defaults: { low: 60, high: 67, key: 0, set: ['scale'], direction: 'up', harmonic: 'melodic', bpm: 90, lenMin: 2, lenMax: 3 },
  },
  {
    id: 'echo-5',
    type: 'echo',
    node: 'E4',
    drill: 'ear.echo-5',
    title: 'Echo 4-5 note phrases',
    kind: 'phrase',
    items: 8,
    given: 'first',
    defaults: { low: 60, high: 72, key: 0, set: ['scale'], direction: 'up', harmonic: 'melodic', bpm: 90, lenMin: 4, lenMax: 5 },
  },
  {
    id: 'tune-1',
    type: 'tune',
    node: 'E4',
    drill: 'ear.tune-1',
    title: 'Tunes by ear: easy tunes in C',
    kind: 'phrase',
    items: 6,
    given: 'first',
    defaults: { low: 36, high: 84, key: 0, set: [...EASY_TUNES], direction: 'up', harmonic: 'melodic', bpm: 100, lenMin: 1, lenMax: 1 },
  },
  {
    id: 'tune-2',
    type: 'tune',
    node: 'E4',
    drill: 'ear.tune-2',
    title: 'Tunes by ear: all tunes in C',
    kind: 'phrase',
    items: 6,
    given: 'first',
    defaults: { low: 36, high: 84, key: 0, set: [...TUNE_IDS], direction: 'up', harmonic: 'melodic', bpm: 100, lenMin: 1, lenMax: 1 },
  },
  {
    id: 'tune-3',
    type: 'tune',
    node: 'E4',
    drill: 'ear.tune-3',
    title: 'Tunes by ear: any key',
    kind: 'phrase',
    items: 6,
    given: 'first',
    defaults: { low: 36, high: 84, key: null, set: [...TUNE_IDS], direction: 'up', harmonic: 'melodic', bpm: 100, lenMin: 1, lenMax: 1 },
  },
  {
    id: 'bass-1',
    type: 'bass',
    node: 'E5',
    drill: 'ear.bass-1',
    title: 'Bass of I, IV, V in C',
    kind: 'phrase',
    items: 6,
    given: 'tonic',
    defaults: { low: 36, high: 84, key: 0, set: ['I', 'IV', 'V'], direction: 'up', harmonic: 'melodic', bpm: 80, lenMin: 3, lenMax: 4 },
  },
  {
    id: 'bass-2',
    type: 'bass',
    node: 'E5',
    drill: 'ear.bass-2',
    title: 'Bass of I, IV, V in any key',
    kind: 'phrase',
    items: 6,
    given: 'tonic',
    defaults: { low: 36, high: 84, key: null, set: ['I', 'IV', 'V'], direction: 'up', harmonic: 'melodic', bpm: 80, lenMin: 4, lenMax: 4 },
  },
  {
    id: 'bass-3',
    type: 'bass',
    node: 'E5',
    drill: 'ear.bass-3',
    title: 'Bass of I, ii, IV, V, vi',
    kind: 'phrase',
    items: 6,
    given: 'tonic',
    defaults: { low: 36, high: 84, key: null, set: ['I', 'ii', 'IV', 'V', 'vi'], direction: 'up', harmonic: 'melodic', bpm: 80, lenMin: 4, lenMax: 4 },
  },
  {
    id: 'chord-4',
    type: 'chord',
    node: 'E6',
    drill: 'ear.chord-4',
    title: 'Seventh chords: maj7, 7, m7, m7b5, dim7',
    kind: 'chord',
    items: 10,
    given: 'root',
    defaults: { low: 53, high: 65, key: null, set: ['maj7', '7', 'm7', 'm7b5', 'dim7'], direction: 'up', harmonic: 'melodic', bpm: 80, lenMin: 1, lenMax: 1 },
  },
  {
    id: 'bass-4',
    type: 'bass',
    node: 'E6',
    drill: 'ear.bass-4',
    title: 'Bass of ii-V-I with 7th chords',
    kind: 'phrase',
    items: 6,
    given: 'tonic',
    defaults: { low: 36, high: 84, key: null, set: ['ii-V-I', 'I-vi-ii-V'], direction: 'up', harmonic: 'melodic', bpm: 80, lenMin: 3, lenMax: 4 },
  },
];

export function levelById(id: string): EarLevelDef | null {
  return LEVELS.find((l) => l.id === id) ?? null;
}

export function keyName(pc: number): string {
  return KEY_NAMES[((pc % 12) + 12) % 12];
}

export function promptLengthMs(notes: PromptNote[]): number {
  return notes.reduce((max, n) => Math.max(max, n.startMs + n.durMs), 0);
}

function intIn(value: unknown, lo: number, hi: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(hi, Math.max(lo, Math.round(value)));
}

export function normalizeSettings(level: EarLevelDef, partial: Partial<EarSettings>): EarSettings {
  const d = level.defaults;
  const s: EarSettings = { ...d, set: [...d.set] };

  let low = intIn(partial.low, EAR_KEY_LOW, EAR_KEY_HIGH, d.low);
  let high = intIn(partial.high, EAR_KEY_LOW, EAR_KEY_HIGH, d.high);
  if (low > high) [low, high] = [high, low];
  if (high - low < 4) {
    low = d.low;
    high = d.high;
  }
  s.low = low;
  s.high = high;

  const k = partial.key;
  if (k === null) s.key = null;
  else if (k !== undefined && Number.isInteger(k) && k >= 0 && k <= 11) s.key = k;

  if (partial.set !== undefined) {
    const allowed = SETS[level.type];
    const picked = [...new Set(partial.set.filter((v) => allowed.includes(v)))];
    if (picked.length > 0) s.set = level.type === 'echo' ? picked.slice(0, 1) : picked;
  }

  if (partial.direction === 'up' || partial.direction === 'down' || partial.direction === 'both') {
    s.direction = partial.direction;
  }
  if (partial.harmonic === 'melodic' || partial.harmonic === 'harmonic' || partial.harmonic === 'mixed') {
    s.harmonic = partial.harmonic;
  }

  s.bpm = intIn(partial.bpm, 40, 200, d.bpm);

  if (d.lenMax !== 1) {
    s.lenMin = intIn(partial.lenMin, 1, 8, d.lenMin);
    s.lenMax = intIn(partial.lenMax, 1, 8, d.lenMax);
    if (s.lenMin > s.lenMax) s.lenMax = s.lenMin;
  }

  return s;
}

export function sameSettings(a: EarSettings, b: EarSettings): boolean {
  return (
    a.low === b.low &&
    a.high === b.high &&
    a.key === b.key &&
    a.direction === b.direction &&
    a.harmonic === b.harmonic &&
    a.bpm === b.bpm &&
    a.lenMin === b.lenMin &&
    a.lenMax === b.lenMax &&
    a.set.length === b.set.length &&
    a.set.every((v, i) => v === b.set[i])
  );
}

export function instructionText(level: EarLevelDef): string {
  switch (level.type) {
    case 'echo':
      return level.defaults.lenMax === 1
        ? 'Listen, then find the note.'
        : 'Listen, then play the phrase back. It starts on the lit key.';
    case 'updown':
      return 'Listen to two notes. The first is lit: play the second.';
    case 'interval':
      return 'Listen to the interval. The first note is lit: play the other note.';
    case 'chord':
      return 'Listen to the chord. Its root is lit: play the whole chord (any octave, any order).';
    case 'tune':
      return 'Listen to the tune, then play it back from the lit key.';
    case 'bass':
      return 'Listen to the chords. The key note is lit: play the bass note of each chord in order (any octave).';
  }
}
