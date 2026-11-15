import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LiveEvent } from '../src/engine-socket.ts';
import {
  chooseClef,
  createSlotHistory,
  isFreeHash,
  wantsEvent,
  type Clef,
  type Slot,
  type SlotHistory,
} from '../src/free-play-slots.ts';

function notesOf(h: SlotHistory): number[][] {
  return h.slots().map((s: Slot): number[] => s.notes);
}

function clefsOf(h: SlotHistory): Clef[] {
  return h.slots().map((s: Slot): Clef => s.clef);
}

test('notes within 60 ms form one chord slot', () => {
  const h = createSlotHistory();
  h.noteOn(60, 1000);
  h.noteOn(64, 1030);
  h.noteOn(67, 1060);
  assert.deepEqual(notesOf(h), [[60, 64, 67]]);
  h.noteOn(72, 1061);
  assert.deepEqual(notesOf(h), [[60, 64, 67], [72]]);
});

test('slow roll does not chain into one slot', () => {
  const h = createSlotHistory();
  h.noteOn(60, 0);
  h.noteOn(64, 50);
  h.noteOn(67, 100);
  assert.deepEqual(notesOf(h), [[60, 64], [67]]);
});

test('duplicate note in the same slot is ignored', () => {
  const h = createSlotHistory();
  assert.equal(h.noteOn(60, 0), true);
  assert.equal(h.noteOn(60, 10), false);
  assert.equal(h.size(), 1);
});

test('same note later starts a new slot', () => {
  const h = createSlotHistory();
  h.noteOn(60, 0);
  h.noteOn(60, 500);
  assert.equal(h.size(), 2);
});

test('unsorted input is sorted ascending within a slot', () => {
  const h = createSlotHistory();
  h.noteOn(67, 0);
  h.noteOn(60, 10);
  assert.deepEqual(notesOf(h), [[60, 67]]);
});

test('keeps only the last 16 slots', () => {
  const h = createSlotHistory();
  for (let i = 0; i < 20; i++) h.noteOn(48 + i, i * 100);
  assert.equal(h.size(), 16);
  const s = h.slots();
  assert.deepEqual(s[0].notes, [52]);
  assert.deepEqual(s[15].notes, [67]);
});

test('clear empties the history and resets the clef state', () => {
  const h = createSlotHistory();
  h.noteOn(72, 0);
  h.clear();
  assert.equal(h.size(), 0);
  assert.deepEqual(h.slots(), []);
  h.noteOn(59, 0);
  assert.equal(h.slots()[0].clef, 'bass');

  const fresh = createSlotHistory();
  fresh.noteOn(60, 0);
  assert.equal(fresh.slots()[0].clef, 'treble');
});

test('clef follows the run with hysteresis', () => {
  const h = createSlotHistory();
  const times: number[] = [0, 100, 200, 300, 400];
  const notes: number[] = [72, 50, 60, 66, 57];
  for (let i = 0; i < notes.length; i++) h.noteOn(notes[i], times[i]);
  assert.deepEqual(clefsOf(h), ['treble', 'bass', 'bass', 'treble', 'treble']);

  h.noteOn(48, 1000);
  h.noteOn(52, 1000);
  h.noteOn(55, 1000);
  assert.equal(h.size(), 6);
  const last = h.slots()[5];
  assert.deepEqual(last.notes, [48, 52, 55]);
  assert.equal(last.clef, 'bass');
});

test('clef is recomputed when a note joins a slot', () => {
  const h = createSlotHistory();
  h.noteOn(72, 0);
  assert.deepEqual(clefsOf(h), ['treble']);
  h.noteOn(52, 1000);
  assert.deepEqual(clefsOf(h), ['treble', 'bass']);
  h.noteOn(76, 1020);
  assert.deepEqual(notesOf(h), [[72], [52, 76]]);
  assert.deepEqual(clefsOf(h), ['treble', 'treble']);
});

test('chooseClef table', () => {
  const cases: [Clef | null, number[], Clef][] = [
    [null, [60], 'treble'],
    [null, [59], 'bass'],
    ['treble', [55], 'treble'],
    ['treble', [54], 'bass'],
    ['bass', [65], 'bass'],
    ['bass', [66], 'treble'],
    ['treble', [48, 60], 'bass'],
    ['bass', [], 'bass'],
    [null, [], 'treble'],
  ];
  for (const [prev, notes, want] of cases) {
    assert.equal(chooseClef(notes, prev), want);
  }
});

test('wantsEvent accepts only played note_on events', () => {
  const kb: LiveEvent = { type: 'note_on', t: 0, note: 60, velocity: 80, source: 'keyboard' };
  const engine: LiveEvent = { type: 'note_on', t: 0, note: 60, velocity: 80, source: 'engine' };
  const autoplay: LiveEvent = { type: 'note_on', t: 0, note: 60, velocity: 80, source: 'autoplay' };
  const release: LiveEvent = { type: 'note_on', t: 0, note: 60, velocity: 0, source: 'keyboard' };
  const off: LiveEvent = { type: 'note_off', t: 0, note: 60, source: 'keyboard' };
  const sustain: LiveEvent = { type: 'sustain', t: 0, on: true, source: 'keyboard' };
  assert.equal(wantsEvent(kb), true);
  assert.equal(wantsEvent(engine), true);
  assert.equal(wantsEvent(autoplay), false);
  assert.equal(wantsEvent(release), false);
  assert.equal(wantsEvent(off), false);
  assert.equal(wantsEvent(sustain), false);
});

test('isFreeHash matches only the free route', () => {
  assert.equal(isFreeHash('#/free'), true);
  assert.equal(isFreeHash('#/free/'), true);
  assert.equal(isFreeHash('#/freeplay'), false);
  assert.equal(isFreeHash(''), false);
  assert.equal(isFreeHash('#'), false);
  assert.equal(isFreeHash('#/sight'), false);
});

test('mutating slots() output does not change the history', () => {
  const h = createSlotHistory();
  h.noteOn(60, 0);
  const s: Slot[] = h.slots();
  s[0].notes.push(99);
  s[0].clef = 'bass';
  s.push({ notes: [1], clef: 'treble' });
  assert.deepEqual(h.slots(), [{ notes: [60], clef: 'treble' }]);
  assert.equal(h.size(), 1);
});
