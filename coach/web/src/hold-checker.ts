export interface HoldOptions {
  minPercent: number;
  minNoteMs: number;
  pedal: boolean;
  // A staccato note is too long when its key is held past this percent of the written length (default 60).
  staccatoMaxPercent?: number;
}

export const DEFAULT_STACCATO_MAX_PERCENT = 60;

export interface HoldResult {
  step: number;
  cycle: number;
  note: number;
  heldMs: number;
  expectedMs: number;
  short: boolean;
  // Staccato note held too long. Always false for plain notes.
  long: boolean;
  staccato?: true;
}

export interface HoldChecker {
  press(note: number, at: number, step: number, cycle: number, expectedMs: number, staccato?: boolean): void;
  release(note: number, at: number): HoldResult | null;
  sustain(on: boolean): void;
  clear(): void;
}

interface OpenEntry {
  at: number;
  step: number;
  cycle: number;
  expectedMs: number;
  staccato: boolean;
}

export function createHoldChecker(opts: HoldOptions): HoldChecker {
  const open = new Map<number, OpenEntry>();
  let pedalDown = false;
  const maxPercent = opts.staccatoMaxPercent ?? DEFAULT_STACCATO_MAX_PERCENT;

  return {
    press(note, at, step, cycle, expectedMs, staccato = false) {
      if (!(expectedMs > 0) || expectedMs < opts.minNoteMs) {
        open.delete(note);
        return;
      }
      open.set(note, { at, step, cycle, expectedMs, staccato });
    },
    release(note, at) {
      const entry = open.get(note);
      if (!entry) return null;
      open.delete(note);
      const heldMs = Math.round(at - entry.at);
      // Staccato is judged on the key alone: the pedal does not excuse holding it, and letting go early is right.
      const short =
        !entry.staccato && !(opts.pedal && pedalDown) && heldMs < (entry.expectedMs * opts.minPercent) / 100;
      const long = entry.staccato && heldMs > (entry.expectedMs * maxPercent) / 100;
      return {
        step: entry.step,
        cycle: entry.cycle,
        note,
        heldMs,
        expectedMs: entry.expectedMs,
        short,
        long,
        ...(entry.staccato ? { staccato: true as const } : {}),
      };
    },
    sustain(on) {
      pedalDown = on;
    },
    clear() {
      open.clear();
    },
  };
}
