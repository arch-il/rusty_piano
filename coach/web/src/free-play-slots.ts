import type { LiveEvent } from './engine-socket.ts';

export type Clef = 'treble' | 'bass';
export interface Slot { notes: number[]; clef: Clef }
export const GROUP_MS = 60;
export const MAX_SLOTS = 16;
export const FIRST_TREBLE_FROM = 60;
export const TO_BASS_BELOW = 55;
export const TO_TREBLE_ABOVE = 65;
export const FREE_HASH = '#/free';

export function chooseClef(notes: readonly number[], prev: Clef | null): Clef {
  if (notes.length === 0) return prev ?? 'treble';
  const avg = notes.reduce((a, n) => a + n, 0) / notes.length;
  if (prev === null) return avg >= FIRST_TREBLE_FROM ? 'treble' : 'bass';
  if (prev === 'treble') return avg < TO_BASS_BELOW ? 'bass' : 'treble';
  return avg > TO_TREBLE_ABOVE ? 'treble' : 'bass';
}

export interface SlotHistory {
  noteOn(note: number, atMs: number): boolean;
  slots(): Slot[];
  size(): number;
  clear(): void;
}

interface InternalSlot {
  notes: number[];
  clef: Clef;
  startMs: number;
  prevClef: Clef | null;
}

export function createSlotHistory(opts: { groupMs?: number; maxSlots?: number } = {}): SlotHistory {
  const groupMs = opts.groupMs ?? GROUP_MS;
  const maxSlots = opts.maxSlots ?? MAX_SLOTS;
  let list: InternalSlot[] = [];
  return {
    noteOn(note: number, at: number): boolean {
      const last = list[list.length - 1];
      if (last && at >= last.startMs && at - last.startMs <= groupMs) {
        if (last.notes.includes(note)) return false;
        last.notes.push(note);
        last.notes.sort((a, b) => a - b);
        last.clef = chooseClef(last.notes, last.prevClef);
        return true;
      }
      const prevClef = last ? last.clef : null;
      list.push({ notes: [note], clef: chooseClef([note], prevClef), startMs: at, prevClef });
      while (list.length > maxSlots) list.shift();
      return true;
    },
    slots(): Slot[] {
      return list.map((s: InternalSlot): Slot => ({ notes: [...s.notes], clef: s.clef }));
    },
    size(): number {
      return list.length;
    },
    clear(): void {
      list = [];
    },
  };
}

export function wantsEvent(ev: LiveEvent): boolean {
  return ev.type === 'note_on' && ev.source !== 'autoplay' && ev.velocity > 0;
}

export function isFreeHash(hash: string): boolean {
  return hash === FREE_HASH || hash === '#/free/';
}
