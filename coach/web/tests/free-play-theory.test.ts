import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeSlot,
  FREE_KEY_STORE,
  KEYS,
  keyAlter,
  loadFreeKey,
  noteText,
  saveFreeKey,
  spellNote,
} from '../src/free-play-theory.ts';
import type { KV, Spelled, Step } from '../src/free-play-theory.ts';

const txt = (r: { notes: Spelled[] }) => r.notes.map(noteText).join(' ');

function fakeStore(): KV & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string): string | null => map.get(k) ?? null,
    setItem: (k: string, v: string): void => {
      map.set(k, v);
    },
  };
}

test('spellNote', () => {
  const cases: [number, number, string][] = [
    [60, 0, 'C4'],
    [66, 0, 'F#4'],
    [66, -1, 'Gb4'],
    [70, -1, 'Bb4'],
    [70, 0, 'Bb4'],
    [61, 0, 'C#4'],
    [63, 0, 'Eb4'],
    [68, 0, 'Ab4'],
    [68, 4, 'G#4'],
    [63, 2, 'D#4'],
    [65, 6, 'E#4'],
    [60, 6, 'C4'],
    [71, -6, 'Cb5'],
    [59, -6, 'Cb4'],
    [61, -2, 'Db4'],
    [21, 0, 'A0'],
    [108, 0, 'C8'],
  ];
  for (const [midi, fifths, expected] of cases) {
    assert.equal(noteText(spellNote(midi, fifths)), expected, `midi ${midi} fifths ${fifths}`);
  }
});

test('keyAlter', () => {
  const cases: [Step, number, -1 | 0 | 1][] = [
    ['F', 1, 1],
    ['C', 1, 0],
    ['B', -1, -1],
    ['E', -2, -1],
    ['E', 6, 1],
    ['B', 6, 0],
    ['C', -6, -1],
    ['F', -6, 0],
  ];
  for (const [step, fifths, expected] of cases) {
    assert.equal(keyAlter(step, fifths), expected, `${step} fifths ${fifths}`);
  }
});

test('KEYS', () => {
  assert.equal(KEYS.length, 13);
  assert.deepEqual(KEYS[0], { fifths: 0, label: 'C major' });
  assert.equal(KEYS.find((k) => k.fifths === 1)?.label, 'G major (1 sharp)');
  assert.equal(KEYS.find((k) => k.fifths === 2)?.label, 'D major (2 sharps)');
  assert.equal(KEYS.find((k) => k.fifths === -1)?.label, 'F major (1 flat)');
  assert.equal(KEYS.find((k) => k.fifths === -6)?.label, 'Gb major (6 flats)');
});

test('analyzeSlot in key 0', () => {
  const cases: [number[], string | null, string | undefined][] = [
    [[60, 64, 67], 'C', 'C4 E4 G4'],
    [[64, 67, 72], 'C/E', 'E4 G4 C5'],
    [[67, 72, 76], 'C/G', undefined],
    [[60, 63, 67], 'Cm', 'C4 Eb4 G4'],
    [[67, 71, 74, 77], 'G7', 'G4 B4 D5 F5'],
    [[59, 62, 65, 67], 'G7/B', undefined],
    [[71, 74, 77], 'Bdim', 'B4 D5 F5'],
    [[60, 64, 68], 'Caug', 'C4 E4 G#4'],
    [[60, 65, 67], 'Csus4', undefined],
    [[60, 62, 67], 'Csus2', undefined],
    [[62, 67, 72], 'Gsus4/D', 'D4 G4 C5'],
    [[60, 64, 67, 71], 'Cmaj7', undefined],
    [[60, 63, 67, 70], 'Cm7', undefined],
    [[60, 64, 67, 69], 'C6', undefined],
    [[57, 60, 64, 67], 'Am7', undefined],
    [[64, 67, 69, 72], 'Am7/E', undefined],
    [[60, 62, 64, 67], 'Cadd9', 'C4 D4 E4 G4'],
    [[71, 74, 77, 81], 'Bm7b5', undefined],
    [[71, 74, 77, 80], 'Bdim7', 'B4 D5 F5 Ab5'],
    [[63, 66, 69, 72], 'Ebdim7', 'Eb4 Gb4 A4 C5'],
    [[48, 60, 64, 67], 'C', undefined],
    [[64, 68, 71], 'E', 'E4 G#4 B4'],
    [[66, 70, 73], 'F#', 'F#4 A#4 C#5'],
    [[63, 67, 70], 'Eb', 'Eb4 G4 Bb4'],
    [[], null, undefined],
    [[60], null, undefined],
    [[60, 72], null, undefined],
    [[60, 64], null, undefined],
    [[60, 61, 62], null, undefined],
    [[60, 64, 67, 70, 74], null, undefined],
  ];
  for (const [midis, name, notes] of cases) {
    const r = analyzeSlot(midis, 0);
    assert.equal(r.name, name, `name for ${midis.join(',')}`);
    if (notes !== undefined) assert.equal(txt(r), notes, `notes for ${midis.join(',')}`);
    for (const n of r.notes) assert.ok([-1, 0, 1].includes(n.alter), `alter for ${midis.join(',')}`);
  }
});

test('analyzeSlot in other keys', () => {
  const cases: [number[], number, string | null, string | undefined][] = [
    [[70, 74, 77], -1, 'Bb', 'Bb4 D5 F5'],
    [[62, 65, 70], -1, 'Bb/D', undefined],
    [[66], -1, null, 'Gb4'],
    [[68, 72, 75], 4, 'G#', 'G#4 B#4 D#5'],
    [[68, 72, 75], -4, 'Ab', 'Ab4 C5 Eb5'],
    [[66, 70, 73], -6, 'Gb', 'Gb4 Bb4 Db5'],
    [[66, 70, 73], 6, 'F#', 'F#4 A#4 C#5'],
  ];
  for (const [midis, fifths, name, notes] of cases) {
    const r = analyzeSlot(midis, fifths);
    assert.equal(r.name, name, `name for ${midis.join(',')} key ${fifths}`);
    if (notes !== undefined) assert.equal(txt(r), notes, `notes for ${midis.join(',')} key ${fifths}`);
    for (const n of r.notes) assert.ok([-1, 0, 1].includes(n.alter), `alter for ${midis.join(',')} key ${fifths}`);
  }
});

test('loadFreeKey', () => {
  assert.equal(loadFreeKey(null), 0);
  assert.equal(loadFreeKey(fakeStore()), 0);
  const s = fakeStore();
  const cases: [string, number][] = [
    ['3', 3],
    ['-6', -6],
    ['7', 0],
    ['x', 0],
    ['1.5', 0],
  ];
  for (const [v, expected] of cases) {
    s.map.set(FREE_KEY_STORE, v);
    assert.equal(loadFreeKey(s), expected, `stored ${v}`);
  }
});

test('loadFreeKey with throwing getItem', () => {
  const throwing: KV = {
    getItem: (): string | null => {
      throw new Error('blocked');
    },
    setItem: (): void => {},
  };
  assert.equal(loadFreeKey(throwing), 0);
});

test('saveFreeKey', () => {
  const s = fakeStore();
  saveFreeKey(s, -2);
  assert.equal(s.map.get('rp.freeKey'), '-2');
  saveFreeKey(null, 3);
});

test('saveFreeKey with throwing setItem does not throw', () => {
  const throwing: KV = {
    getItem: (): string | null => null,
    setItem: (): void => {
      throw new Error('quota');
    },
  };
  assert.doesNotThrow(() => saveFreeKey(throwing, 2));
});
