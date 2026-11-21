// Seeded question generator for the ear-training drills. Pure, no DOM.
// When a pick cannot satisfy the range or the "no identical consecutive prompt"
// rule within 50 tries (e.g. a pool or set with a single option), the last pick is kept.

import { CHORDS, DEFAULT_VELOCITY, DEGREES, INTERVALS, PATTERNS, keyName } from './ear-levels.ts';
import type { AnswerStep, EarItem, EarLevelDef, EarSettings, PromptNote } from './ear-levels.ts';
import { tuneById } from './ear-tunes.ts';
import type { Tune } from './ear-tunes.ts';
import { noteName } from './engine-socket.ts';
import { mulberry32 } from './sight-gen.ts';
import type { Rng } from './sight-gen.ts';

type Draft = Omit<EarItem, 'index' | 'type'>;

const SCALE_PCS = [0, 2, 4, 5, 7, 9, 11];
const MIN_NOTE = 36;
const MAX_NOTE = 84;
const TRIES = 50;

function int(rng: Rng, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

function pick<T>(rng: Rng, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

export function scalePool(low: number, high: number, key: number): number[] {
  const out: number[] = [];
  for (let m = low; m <= high; m++) {
    if (SCALE_PCS.includes((((m - key) % 12) + 12) % 12)) out.push(m);
  }
  return out;
}

function allNotes(low: number, high: number): number[] {
  const out: number[] = [];
  for (let m = low; m <= high; m++) out.push(m);
  return out;
}

function pn(note: number, startBeat: number, beats: number, beatMs: number): PromptNote {
  return {
    note,
    startMs: Math.round(startBeat * beatMs),
    durMs: Math.round(beats * beatMs * 0.9),
    velocity: DEFAULT_VELOCITY,
  };
}

function seq(notes: number[], beatMs: number): PromptNote[] {
  return notes.map((n, i) => pn(n, i, 1, beatMs));
}

function names(notes: number[]): string {
  return notes.map(noteName).join(' ');
}

function noteAnswers(notes: number[]): AnswerStep[] {
  return notes.map((pitch) => ({ kind: 'note', pitch }));
}

function genEcho(rng: Rng, s: EarSettings, beatMs: number): Draft {
  const chromatic = s.set.includes('chromatic');
  const pool = chromatic ? allNotes(s.low, s.high) : scalePool(s.low, s.high, s.key ?? int(rng, 0, 11));
  const len = int(rng, s.lenMin, s.lenMax);
  let idx = int(rng, 0, pool.length - 1);
  const pitches = [pool[idx]];
  while (pitches.length < len) {
    const step = rng() < 0.7 ? 1 : 2;
    let dir = rng() < 0.5 ? 1 : -1;
    if (idx + dir * step < 0 || idx + dir * step >= pool.length) dir = -dir;
    idx = Math.min(pool.length - 1, Math.max(0, idx + dir * step));
    pitches.push(pool[idx]);
  }
  const prompt = seq(pitches, beatMs);
  return {
    category: len === 1 ? noteName(pitches[0]) : 'phrase-' + len,
    label: names(pitches),
    prompt,
    answerSound: prompt,
    given: len > 1 ? [pitches[0]] : [],
    answer: noteAnswers(pitches),
    answerNotes: pitches,
  };
}

function genUpDown(rng: Rng, s: EarSettings, beatMs: number): Draft {
  const key = s.key ?? 0;
  const first = pick(rng, scalePool(s.low, s.high, key));
  const motion = pick(rng, s.set);
  let second: number;
  let label: string;
  if (motion === 'higher' || motion === 'lower') {
    const d = int(rng, 3, 9);
    second = motion === 'higher' ? first + d : first - d;
    label = (motion === 'higher' ? 'Higher' : 'Lower') + `: ${noteName(first)} then ${noteName(second)}`;
  } else {
    const ext = scalePool(s.low - 12, s.high + 12, key);
    const idx = ext.indexOf(first);
    const dir = s.direction === 'both' ? (rng() < 0.5 ? 1 : -1) : s.direction === 'up' ? 1 : -1;
    second = ext[idx + dir * (motion === 'step' ? 1 : 2)];
    label = `${motion === 'step' ? 'Step' : 'Skip'} ${dir > 0 ? 'up' : 'down'}: ${noteName(first)} then ${noteName(second)}`;
  }
  const prompt = seq([first, second], beatMs);
  return {
    category: motion,
    label,
    prompt,
    answerSound: prompt,
    given: [first],
    answer: motion === 'higher' || motion === 'lower' ? [{ kind: 'direction', from: first, up: motion === 'higher' }] : [{ kind: 'note', pitch: second }],
    answerNotes: [second],
  };
}

function roots(s: EarSettings): number[] {
  return s.key === null ? allNotes(s.low, s.high) : scalePool(s.low, s.high, s.key);
}

function genInterval(rng: Rng, s: EarSettings, beatMs: number): Draft {
  const root = pick(rng, roots(s));
  const id = pick(rng, s.set);
  const iv = INTERVALS.find((i) => i.id === id) ?? INTERVALS[0];
  const harmonic = s.harmonic === 'mixed' ? rng() < 0.5 : s.harmonic === 'harmonic';
  if (harmonic) {
    const top = root + iv.semitones;
    const prompt = [pn(root, 0, 2, beatMs), pn(top, 0, 2, beatMs)];
    return {
      category: iv.id,
      label: `${iv.name} together: ${noteName(root)} and ${noteName(top)}`,
      prompt,
      answerSound: prompt,
      given: [root],
      answer: [{ kind: 'note', pitch: top }],
      answerNotes: [top],
    };
  }
  const up = s.direction === 'both' ? rng() < 0.5 : s.direction === 'up';
  const other = up ? root + iv.semitones : root - iv.semitones;
  const prompt = seq([root, other], beatMs);
  return {
    category: iv.id,
    label: `${iv.name} ${up ? 'up' : 'down'}: ${noteName(root)} to ${noteName(other)}`,
    prompt,
    answerSound: prompt,
    given: [root],
    answer: [{ kind: 'note', pitch: other }],
    answerNotes: [other],
  };
}

function genChord(rng: Rng, s: EarSettings, beatMs: number): Draft {
  const root = pick(rng, roots(s));
  const id = pick(rng, s.set);
  const q = CHORDS.find((c) => c.id === id) ?? CHORDS[0];
  const notes = q.intervals.map((i) => root + i);
  const block = notes.map((n) => pn(n, 0, 2, beatMs));
  const broken = notes.map((n, i) => pn(n, 2 + i * 0.5, 0.5, beatMs));
  const pcs = [...new Set(notes.map((n) => n % 12))].sort((a, b) => a - b);
  return {
    category: q.id,
    label: `${noteName(root)} ${q.name}: ${names(notes)}`,
    prompt: [...block, ...broken],
    answerSound: block,
    given: [root],
    answer: [{ kind: 'chord', pcs }],
    answerNotes: notes,
  };
}

function genTune(rng: Rng, s: EarSettings, beatMs: number): Draft {
  const tunes = s.set.map((id) => tuneById(id)).filter((t): t is Tune => t !== null);
  const t = pick(rng, tunes);
  const i = int(rng, 0, t.phrases.length - 1);
  const p = t.phrases[i];
  const shift = s.key === null ? int(rng, -5, 6) : s.key <= 6 ? s.key : s.key - 12;
  const notes = p.notes.map((n) => n + shift);
  let at = 0;
  const prompt = notes.map((n, k) => {
    const pn1 = pn(n, at, p.beats[k], beatMs);
    at += p.beats[k];
    return pn1;
  });
  return {
    category: t.id,
    label: `${t.title}, phrase ${i + 1} of ${t.phrases.length}` + (shift !== 0 ? ', in ' + keyName((shift + 12) % 12) : '') + ': ' + names(notes),
    prompt,
    answerSound: prompt,
    given: [notes[0]],
    answer: noteAnswers(notes),
    answerNotes: notes,
  };
}

function genBass(rng: Rng, s: EarSettings, beatMs: number): Draft {
  const pc = s.key ?? int(rng, 0, 11);
  const patternIds = s.set.filter((v) => v in PATTERNS);
  let degrees: string[];
  if (patternIds.length > 0) {
    degrees = PATTERNS[pick(rng, patternIds)];
  } else {
    const pool = s.set.filter((v) => v in DEGREES);
    const len = int(rng, s.lenMin, s.lenMax);
    degrees = ['I'];
    while (degrees.length < len) {
      const prev = degrees[degrees.length - 1];
      const others = pool.filter((d) => d !== prev);
      degrees.push(pick(rng, others.length > 0 ? others : [prev]));
    }
  }
  const prompt: PromptNote[] = [];
  const answer: AnswerStep[] = [];
  const bassNotes: number[] = [];
  degrees.forEach((d, i) => {
    const def = DEGREES[d];
    const rootPc = (pc + def.offset) % 12;
    const bass = 48 + rootPc;
    const base = 60 + rootPc - (rootPc >= 8 ? 12 : 0);
    const ch = CHORDS.find((c) => c.id === def.chord) ?? CHORDS[0];
    prompt.push(pn(bass, 2 * i, 2, beatMs));
    for (const iv of ch.intervals) prompt.push(pn(base + iv, 2 * i, 2, beatMs));
    bassNotes.push(bass);
    answer.push({ kind: 'pc', pc: rootPc });
  });
  return {
    category: degrees.join('-'),
    label: `${degrees.join(' ')} in ${keyName(pc)} major: bass ${names(bassNotes)}`,
    prompt,
    answerSound: seq(bassNotes, beatMs),
    given: [48 + pc],
    answer,
    answerNotes: bassNotes,
  };
}

function inRange(d: Draft): boolean {
  const all = [...d.prompt.map((p) => p.note), ...d.answerSound.map((p) => p.note), ...d.given, ...d.answerNotes];
  return all.every((n) => Number.isFinite(n) && n >= MIN_NOTE && n <= MAX_NOTE);
}

function promptKey(d: Draft): string {
  return d.prompt.map((p) => p.note).join(',');
}

export function makeEarRound(level: EarLevelDef, settings: EarSettings, seed: number): EarItem[] {
  const rng = mulberry32(seed);
  const beatMs = 60000 / settings.bpm;
  const gens = { echo: genEcho, updown: genUpDown, interval: genInterval, chord: genChord, tune: genTune, bass: genBass };
  const gen = gens[level.type];
  const items: EarItem[] = [];
  let prevKey: string | null = null;
  for (let index = 0; index < level.items; index++) {
    let chosen: Draft | null = null;
    let fallback: Draft | null = null;
    for (let t = 0; t < TRIES; t++) {
      const d = gen(rng, settings, beatMs);
      const ok = inRange(d);
      if (ok && promptKey(d) !== prevKey) {
        chosen = d;
        break;
      }
      if (ok && fallback === null) fallback = d;
      chosen = fallback ?? d;
    }
    const d = chosen as Draft;
    prevKey = promptKey(d);
    items.push({ index, type: level.type, ...d });
  }
  return items;
}
