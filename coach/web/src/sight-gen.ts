// Seeded card and phrase generator for the sight-reading ladder. All randomness comes
// from the Rng passed in (mulberry32), so the same seed and options give the same cards.

import { normalizeCustom } from './sight-levels.ts';
import type { Card, CardNote, CardStep, Clef, CustomRange, LevelDef, Pitch } from './sight-levels.ts';

export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pickWeighted<T>(items: readonly T[], weight: (t: T) => number, rng: Rng): T {
  const weights = items.map((t) => {
    const w = weight(t);
    return w > 0 && Number.isFinite(w) ? w : 0;
  });
  const total = weights.reduce((sum, w) => sum + w, 0);
  if (total <= 0) return items[Math.floor(rng() * items.length)];
  let r = rng() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r < 0) return items[i];
  }
  return items[items.length - 1];
}

const WHITE = [0, 2, 4, 5, 7, 9, 11];
const NATURAL: Record<number, Pitch['step']> = { 0: 'C', 2: 'D', 4: 'E', 5: 'F', 7: 'G', 9: 'A', 11: 'B' };
const SHARP_STEP: Record<number, Pitch['step']> = { 1: 'C', 3: 'D', 6: 'F', 8: 'G', 10: 'A' };
const FLAT_STEP: Record<number, Pitch['step']> = { 1: 'D', 3: 'E', 6: 'G', 8: 'A', 10: 'B' };

export function isWhite(midi: number): boolean {
  return WHITE.includes(midi % 12);
}

export function keyAlter(step: Pitch['step'], fifths: number): -1 | 0 | 1 {
  if (fifths === 1 && step === 'F') return 1;
  if (fifths === -1 && step === 'B') return -1;
  return 0;
}

export function spell(midi: number, fifths: number, preferFlat: boolean): Pitch {
  const pc = midi % 12;
  const octave = Math.floor(midi / 12) - 1;
  if (isWhite(midi)) return { step: NATURAL[pc], alter: 0, octave };
  if (pc === 6 && fifths === 1) return { step: 'F', alter: keyAlter('F', fifths), octave };
  if (pc === 10 && fifths === -1) return { step: 'B', alter: keyAlter('B', fifths), octave };
  if (preferFlat) return { step: FLAT_STEP[pc], alter: -1, octave };
  return { step: SHARP_STEP[pc], alter: 1, octave };
}

export interface PoolNote {
  midi: number;
  clef: 'treble' | 'bass';
  staff: 1 | 2;
  base: number;
}

export interface GenOptions {
  seed: number;
  weights?: ReadonlyMap<number, number>;
  custom?: CustomRange;
  count?: number;
}

interface Move {
  move: number;
  p: number;
}

interface Event {
  time: number;
  midi: number;
  quarters: number;
  staff: 1 | 2;
}

interface Interval {
  clef: 'treble' | 'bass';
  lower: number;
  steps: number;
  ascending: boolean;
}

const BAR_PATTERNS: number[][][] = [
  [[1, 1, 1, 1], [2, 1, 1], [1, 1, 2], [2, 2]],
  [[1, 1, 2], [2, 2], [4]],
];
const R8A_MOVES: Move[] = [
  { move: 0, p: 0.1 },
  { move: 1, p: 0.6 },
  { move: 2, p: 0.3 },
];
const R8B_MOVES: Move[] = [
  { move: 1, p: 0.45 },
  { move: 2, p: 0.3 },
  { move: 3, p: 0.15 },
  { move: 4, p: 0.1 },
];
const R8C_LEFT_MOVES: Move[] = [
  { move: 0, p: 1 },
  { move: 1, p: 1 },
  { move: 2, p: 1 },
];
const LEDGER_TREBLE = [57, 59, 60, 81, 83, 84];
const LEDGER_BASS = [36, 38, 40, 60, 62, 64];
const GRAND_LANDMARKS = [48, 53, 60, 67, 72];
const G_MAJOR_PCS = [7, 9, 11, 0, 2, 4, 6];
const F_MAJOR_PCS = [5, 7, 9, 10, 0, 2, 4];

function whites(low: number, high: number): number[] {
  const out: number[] = [];
  for (let m = low; m <= high; m++) if (isWhite(m)) out.push(m);
  return out;
}

function clefOf(clef: Clef, midi: number): 'treble' | 'bass' {
  if (clef === 'grand') return midi >= 60 ? 'treble' : 'bass';
  return clef;
}

function staffOf(clef: Clef, midi: number): 1 | 2 {
  return clef === 'grand' && midi < 60 ? 2 : 1;
}

function poolNote(midi: number, clef: Clef, base: number): PoolNote {
  return { midi, clef: clefOf(clef, midi), staff: staffOf(clef, midi), base };
}

function cardNote(midi: number, staff: 1 | 2, quarters: number, fifths: number, preferFlat: boolean): CardNote {
  return { midi, staff, pitch: spell(midi, fifths, preferFlat), quarters };
}

function notesPool(levelId: string, fifths: number, custom: CustomRange | null): PoolNote[] {
  if (custom) {
    const midis: number[] = [];
    for (let m = custom.low; m <= custom.high; m++) {
      if (custom.accidentals || isWhite(m)) midis.push(m);
    }
    return midis.map((m) => poolNote(m, custom.clef, 1));
  }
  if (levelId === 'r2-treble') return [60, 62, 64, 65, 67].map((m) => poolNote(m, 'treble', 1));
  if (levelId === 'r3-bass') return [48, 50, 52, 53, 55].map((m) => poolNote(m, 'bass', 1));
  if (levelId === 'r4-grand') {
    return whites(48, 72).map((m) => poolNote(m, 'grand', GRAND_LANDMARKS.includes(m) ? 2 : 1));
  }
  if (levelId === 'r6-ledger') {
    return [
      ...LEDGER_TREBLE.map((m) => poolNote(m, 'treble', 1)),
      ...LEDGER_BASS.map((m) => poolNote(m, 'bass', 1)),
    ];
  }
  const pcs = fifths === 1 ? G_MAJOR_PCS : F_MAJOR_PCS;
  const altered = fifths === 1 ? 6 : 10;
  const out: PoolNote[] = [];
  for (let m = 48; m <= 72; m++) {
    if (pcs.includes(m % 12)) out.push(poolNote(m, 'grand', m % 12 === altered ? 3 : 1));
  }
  return out;
}

function notesRound(level: LevelDef, opts: GenOptions, rng: Rng, count: number): Card[] {
  const custom = level.id === 'custom' ? normalizeCustom(opts.custom ?? {}) : null;
  const cards: Card[] = [];
  let prev: number | null = null;
  for (let index = 0; index < count; index++) {
    const fifths = level.id === 'r7-keys' ? (rng() < 0.5 ? 1 : -1) : 0;
    const preferFlat = custom !== null && rng() < 0.5;
    const pool = notesPool(level.id, fifths, custom);
    const choices = pool.length > 1 ? pool.filter((n) => n.midi !== prev) : pool;
    const note = pickWeighted(choices, (n) => n.base * (opts.weights?.get(n.midi) ?? 1), rng);
    prev = note.midi;
    const baseClef = custom ? custom.clef : level.clef;
    const clef = level.id === 'r6-ledger' ? note.clef : baseClef;
    cards.push({
      index,
      clef,
      fifths,
      showTime: false,
      measures: 1,
      steps: [
        {
          time: 0,
          pitches: [note.midi],
          notes: [cardNote(note.midi, note.staff, 4, fifths, preferFlat)],
        },
      ],
    });
  }
  return cards;
}

function whiteAbove(midi: number, steps: number): number {
  let m = midi;
  for (let k = 0; k < steps; k++) {
    m++;
    while (!isWhite(m)) m++;
  }
  return m;
}

function drawInterval(opts: GenOptions, rng: Rng): Interval {
  const clef = rng() < 0.5 ? 'treble' : 'bass';
  const lowPool = clef === 'treble' ? whites(60, 72) : whites(43, 55);
  const lower = pickWeighted(lowPool, (m) => opts.weights?.get(m) ?? 1, rng);
  const steps = 1 + Math.floor(rng() * 4);
  const ascending = rng() < 0.5;
  return { clef, lower, steps, ascending };
}

function intervalsRound(opts: GenOptions, rng: Rng, count: number): Card[] {
  const cards: Card[] = [];
  let prev: Interval | null = null;
  for (let index = 0; index < count; index++) {
    let iv = drawInterval(opts, rng);
    while (prev && iv.lower === prev.lower && iv.steps === prev.steps && iv.ascending === prev.ascending) {
      iv = drawInterval(opts, rng);
    }
    prev = iv;
    const upper = whiteAbove(iv.lower, iv.steps);
    const first = iv.ascending ? iv.lower : upper;
    const second = iv.ascending ? upper : iv.lower;
    cards.push({
      index,
      clef: iv.clef,
      fifths: 0,
      showTime: false,
      measures: 1,
      steps: [
        { time: 0, pitches: [first], notes: [cardNote(first, 1, 2, 0, false)] },
        { time: 2, pitches: [second], notes: [cardNote(second, 1, 2, 0, false)] },
      ],
    });
  }
  return cards;
}

function walker(positions: readonly number[], moves: readonly Move[], rng: Rng): () => number {
  let index = Math.floor(rng() * positions.length);
  let started = false;
  return () => {
    if (started) {
      const move = pickWeighted(moves, (m) => m.p, rng).move;
      const step = rng() < 0.5 ? -move : move;
      let next = index + step;
      if (next < 0 || next >= positions.length) next = index - step;
      index = Math.min(positions.length - 1, Math.max(0, next));
    }
    started = true;
    return positions[index];
  };
}

function barLine(next: () => number, staff: 1 | 2, rng: Rng): Event[] {
  const events: Event[] = [];
  for (let bar = 0; bar < 2; bar++) {
    let time = bar * 4;
    for (const quarters of pickWeighted(BAR_PATTERNS[bar], () => 1, rng)) {
      events.push({ time, midi: next(), quarters, staff });
      time += quarters;
    }
  }
  return events;
}

function barsCard(index: number, clef: Clef, events: Event[]): Card {
  const times = [...new Set(events.map((e) => e.time))].sort((a, b) => a - b);
  const steps: CardStep[] = times.map((time) => {
    const notes = events
      .filter((e) => e.time === time)
      .sort((a, b) => a.midi - b.midi)
      .map((e) => cardNote(e.midi, e.staff, e.quarters, 0, false));
    return { time, pitches: notes.map((n) => n.midi), notes };
  });
  return { index, clef, fifths: 0, showTime: true, measures: 2, steps };
}

function barsRound(levelId: string, rng: Rng, count: number): Card[] {
  const cards: Card[] = [];
  for (let index = 0; index < count; index++) {
    const even = index % 2 === 0;
    if (levelId === 'r8a-five') {
      const high = rng() < 0.5;
      const positions = even
        ? (high ? [67, 69, 71, 72, 74] : [60, 62, 64, 65, 67])
        : (high ? [43, 45, 47, 48, 50] : [48, 50, 52, 53, 55]);
      const events = barLine(walker(positions, R8A_MOVES, rng), 1, rng);
      cards.push(barsCard(index, even ? 'treble' : 'bass', events));
    } else if (levelId === 'r8b-wide') {
      const positions = even ? whites(60, 72) : whites(48, 60);
      const events = barLine(walker(positions, R8B_MOVES, rng), 1, rng);
      cards.push(barsCard(index, even ? 'treble' : 'bass', events));
    } else {
      const right = barLine(walker([60, 62, 64, 65, 67], R8A_MOVES, rng), 1, rng);
      const left = walker([48, 50, 52, 53, 55], R8C_LEFT_MOVES, rng);
      const leftEvents = [0, 2, 4, 6].map((time): Event => ({ time, midi: left(), quarters: 2, staff: 2 }));
      cards.push(barsCard(index, 'grand', [...right, ...leftEvents]));
    }
  }
  return cards;
}

export function makeRound(level: LevelDef, opts: GenOptions): Card[] {
  const rng = mulberry32(opts.seed);
  const count = opts.count ?? level.cards;
  if (level.kind === 'bars') return barsRound(level.id, rng, count);
  if (level.kind === 'intervals') return intervalsRound(opts, rng, count);
  return notesRound(level, opts, rng, count);
}
