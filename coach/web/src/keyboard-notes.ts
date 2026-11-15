/**
 * dev-only computer keyboard fallback: turns key presses into LiveEvents with source "keyboard".
 */

import type { LiveEvent } from "./engine-socket";

export const KEYBOARD_VELOCITY = 80;
export const BASE_NOTE = 60;
export const MIN_OCTAVE_SHIFT = -3;
export const MAX_OCTAVE_SHIFT = 3;

export const NOTE_KEYS: Readonly<Record<string, number>> = {
  KeyA: 0,
  KeyW: 1,
  KeyS: 2,
  KeyE: 3,
  KeyD: 4,
  KeyF: 5,
  KeyT: 6,
  KeyG: 7,
  KeyY: 8,
  KeyH: 9,
  KeyU: 10,
  KeyJ: 11,
  KeyK: 12,
};

export interface KeyInput {
  code: string;
  repeat: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

export interface KeyResult {
  handled: boolean;
  events: LiveEvent[];
}

export interface KeyboardNotes {
  octaveShift(): number;
  keyDown(k: KeyInput, t: number): KeyResult;
  keyUp(k: KeyInput, t: number): KeyResult;
  releaseAll(t: number): LiveEvent[];
  resetOctave(): void;
}

function isNoteCode(code: string): boolean {
  return Object.prototype.hasOwnProperty.call(NOTE_KEYS, code);
}

export function createKeyboardNotes(): KeyboardNotes {
  let shift = 0;
  const held = new Map<string, number>();
  let sustain = false;

  return {
    octaveShift: () => shift,

    resetOctave() {
      shift = 0;
    },

    keyDown(k, t) {
      if (k.ctrlKey || k.altKey || k.metaKey) return { handled: false, events: [] };
      if (!isNoteCode(k.code) && k.code !== "KeyZ" && k.code !== "KeyX" && k.code !== "Space") {
        return { handled: false, events: [] };
      }
      if (k.repeat) return { handled: true, events: [] };
      if (k.code === "KeyZ") {
        shift = Math.max(MIN_OCTAVE_SHIFT, shift - 1);
        return { handled: true, events: [] };
      }
      if (k.code === "KeyX") {
        shift = Math.min(MAX_OCTAVE_SHIFT, shift + 1);
        return { handled: true, events: [] };
      }
      if (k.code === "Space") {
        if (sustain) return { handled: true, events: [] };
        sustain = true;
        return { handled: true, events: [{ type: "sustain", t, on: true, source: "keyboard" }] };
      }
      if (held.has(k.code)) return { handled: true, events: [] };
      const note = BASE_NOTE + 12 * shift + NOTE_KEYS[k.code];
      for (const n of held.values()) {
        if (n === note) return { handled: true, events: [] };
      }
      held.set(k.code, note);
      return {
        handled: true,
        events: [{ type: "note_on", t, note, velocity: KEYBOARD_VELOCITY, source: "keyboard" }],
      };
    },

    keyUp(k, t) {
      if (!isNoteCode(k.code) && k.code !== "KeyZ" && k.code !== "KeyX" && k.code !== "Space") {
        return { handled: false, events: [] };
      }
      if (k.code === "KeyZ" || k.code === "KeyX") return { handled: true, events: [] };
      if (k.code === "Space") {
        if (!sustain) return { handled: true, events: [] };
        sustain = false;
        return { handled: true, events: [{ type: "sustain", t, on: false, source: "keyboard" }] };
      }
      const note = held.get(k.code);
      if (note === undefined) return { handled: true, events: [] };
      held.delete(k.code);
      return { handled: true, events: [{ type: "note_off", t, note, source: "keyboard" }] };
    },

    releaseAll(t) {
      const events: LiveEvent[] = [];
      for (const note of held.values()) {
        events.push({ type: "note_off", t, note, source: "keyboard" });
      }
      if (sustain) events.push({ type: "sustain", t, on: false, source: "keyboard" });
      held.clear();
      sustain = false;
      return events;
    },
  };
}

export function keyboardHint(octaveShift: number): string {
  return (
    "Keyboard: A-K = C" +
    (4 + octaveShift) +
    "-C" +
    (5 + octaveShift) +
    ", Z/X octave down/up, Space sustain"
  );
}
