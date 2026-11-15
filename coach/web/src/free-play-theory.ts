export type Step = 'C' | 'D' | 'E' | 'F' | 'G' | 'A' | 'B';
export interface Spelled { midi: number; step: Step; alter: -1 | 0 | 1; octave: number }
export interface KeyChoice { fifths: number; label: string }
export interface KV { getItem(k: string): string | null; setItem(k: string, v: string): void }

export const FREE_KEY_STORE = 'rp.freeKey';

export const KEYS: readonly KeyChoice[] = [
  { fifths: 0, label: 'C major' },
  { fifths: 1, label: 'G major (1 sharp)' },
  { fifths: 2, label: 'D major (2 sharps)' },
  { fifths: 3, label: 'A major (3 sharps)' },
  { fifths: 4, label: 'E major (4 sharps)' },
  { fifths: 5, label: 'B major (5 sharps)' },
  { fifths: 6, label: 'F# major (6 sharps)' },
  { fifths: -1, label: 'F major (1 flat)' },
  { fifths: -2, label: 'Bb major (2 flats)' },
  { fifths: -3, label: 'Eb major (3 flats)' },
  { fifths: -4, label: 'Ab major (4 flats)' },
  { fifths: -5, label: 'Db major (5 flats)' },
  { fifths: -6, label: 'Gb major (6 flats)' },
];

const STEPS: Step[] = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];

const NAT: Record<Step, number> ={ C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

const WHITE: Record<number, Step> = { 0: 'C', 2: 'D', 4: 'E', 5: 'F', 7: 'G', 9: 'A', 11: 'B' };

const SHARPS: Record<number, string> = { 1: 'C#', 3: 'D#', 6: 'F#', 8: 'G#', 10: 'A#' };
const FLATS: Record<number, string> = { 1: 'Db', 3: 'Eb', 6: 'Gb', 8: 'Ab', 10: 'Bb' };
const NEUTRAL: Record<number, string> = { 1: 'C#', 3: 'Eb', 6: 'F#', 8: 'Ab', 10: 'Bb' };

const TEMPLATES: [string, Record<number, number>][] = [
  ['', { 0: 1, 4: 3, 7: 5 }],
  ['m', { 0: 1, 3: 3, 7: 5 }],
  ['7', { 0: 1, 4: 3, 7: 5, 10: 7 }],
  ['maj7', { 0: 1, 4: 3, 7: 5, 11: 7 }],
  ['m7', { 0: 1, 3: 3, 7: 5, 10: 7 }],
  ['dim', { 0: 1, 3: 3, 6: 5 }],
  ['aug', { 0: 1, 4: 3, 8: 5 }],
  ['sus4', { 0: 1, 5: 4, 7: 5 }],
  ['sus2', { 0: 1, 2: 2, 7: 5 }],
  ['m7b5', { 0: 1, 3: 3, 6: 5, 10: 7 }],
  ['dim7', { 0: 1, 3: 3, 6: 5, 9: 7 }],
  ['6', { 0: 1, 4: 3, 7: 5, 9: 6 }],
  ['add9', { 0: 1, 2: 9, 4: 3, 7: 5 }],
];

function pc(midi: number): number {
  return ((midi % 12) + 12) % 12;
}

function isAlter(n: number): n is -1 | 0 | 1 {
  return n === -1 || n === 0 || n === 1;
}

function accidental(alter: -1 | 0 | 1): string {
  return alter === 1 ? '#' : alter === -1 ? 'b' : '';
}

export function keyAlter(step: Step, fifths: number): -1 | 0 | 1 {
  if (fifths > 0 && 'FCGDAEB'.indexOf(step) < fifths) return 1;
  if (fifths < 0 && 'BEADGCF'.indexOf(step) < -fifths) return -1;
  return 0;
}

export function spellNote(midi: number, fifths: number): Spelled {
  const p = pc(midi);
  for (const S of STEPS) {
    const a = keyAlter(S, fifths);
    if ((NAT[S] + a + 12) % 12 === p) {
      return { midi, step: S, alter: a, octave: Math.floor((midi - a) / 12) - 1 };
    }
  }
  if (p in WHITE) {
    return { midi, step: WHITE[p], alter: 0, octave: Math.floor(midi / 12) - 1 };
  }
  const name = (fifths > 0 ? SHARPS : fifths < 0 ? FLATS : NEUTRAL)[p];
  const step = name[0] as Step;
  const alter: -1 | 0 | 1 = name.length === 1 ? 0 : name[1] === '#' ? 1 : -1;
  return { midi, step, alter, octave: Math.floor((midi - alter) / 12) - 1 };
}

export function noteText(s: Spelled): string {
  return s.step + accidental(s.alter) + s.octave;
}

export function analyzeSlot(
  midis: readonly number[],
  fifths: number,
): { name: string | null; notes: Spelled[] } {
  const sorted = [...new Set(midis)].sort((a, b) => a - b);
  const pcs = [...new Set(sorted.map(pc))];
  if (pcs.length < 3) {
    return { name: null, notes: sorted.map((m) => spellNote(m, fifths)) };
  }
  const bass = sorted[0];
  const bassPc = pc(bass);

  const matches: { r: number; idx: number }[] = [];
  for (const r of pcs) {
    const ivs = new Set(pcs.map((p) => (p - r + 12) % 12));
    TEMPLATES.forEach(([, t], idx) => {
      const keys = Object.keys(t).map(Number);
      if (ivs.size === keys.length && keys.every((k) => ivs.has(k))) {
        matches.push({ r, idx });
      }
    });
  }

  let best: { r: number; idx: number } | undefined;
  const bassMatches = matches.filter((m) => m.r === bassPc);
  const pool = bassMatches.length > 0 ? bassMatches : matches;
  for (const m of pool) {
    if (best === undefined || m.idx < best.idx) best = m;
  }

  if (best === undefined) {
    return { name: null, notes: sorted.map((m) => spellNote(m, fifths)) };
  }

  const { r, idx } = best;
  const [suffix, t] = TEMPLATES[idx];
  const rootMidi = sorted.find((m) => pc(m) === r) as number;
  const rootSp = spellNote(rootMidi, fifths);
  const notes: Spelled[] = sorted.map((m) => {
    const degree = t[(pc(m) - r + 12) % 12];
    const step = 'CDEFGAB'[('CDEFGAB'.indexOf(rootSp.step) + degree - 1) % 7] as Step;
    let diff = ((pc(m) - NAT[step]) % 12 + 12) % 12;
    if (diff > 6) diff -= 12;
    if (isAlter(diff)) {
      return { midi: m, step, alter: diff, octave: Math.floor((m - diff) / 12) - 1 };
    }
    return spellNote(m, fifths);
  });

  let name = rootSp.step + accidental(rootSp.alter) + suffix;
  if (bassPc !== r) {
    const b = notes[0];
    name += '/' + b.step + accidental(b.alter);
  }
  return { name, notes };
}

export function loadFreeKey(store: KV | null): number {
  try {
    const v = store?.getItem(FREE_KEY_STORE);
    if (v === null || v === undefined) return 0;
    const n = Number(v);
    return Number.isInteger(n) && n >= -6 && n <= 6 ? n : 0;
  } catch {
    return 0;
  }
}

export function saveFreeKey(store: KV | null, fifths: number): void {
  try {
    store?.setItem(FREE_KEY_STORE, String(fifths));
  } catch {
    // ignore
  }
}
