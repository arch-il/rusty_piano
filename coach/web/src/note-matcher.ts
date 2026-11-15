import type { LiveEvent } from './engine-socket';

export type StepOutcome = 'hit' | 'early' | 'late' | 'missed';

export interface MatchStep {
  readonly pitches: readonly number[];
}

export type MatchResult =
  | { kind: 'accepted'; step: number; note: number }
  | { kind: 'wrong'; step: number; note: number; attempts: number }
  | { kind: 'hit'; step: number; attempts: number }
  | { kind: 'advance'; step: number }
  | { kind: 'done' };

export interface WaitMatcher {
  current(): number;
  done(): boolean;
  wrongAttempts(step: number): number;
  handle(ev: LiveEvent): MatchResult[];
}

export function createWaitMatcher(steps: readonly MatchStep[]): WaitMatcher {
  let cur = 0;
  const wrong: number[] = steps.map(() => 0);
  let fresh = new Set<number>();

  return {
    current() {
      return cur;
    },
    done() {
      return cur >= steps.length;
    },
    wrongAttempts(step: number) {
      return wrong[step] ?? 0;
    },
    handle(ev: LiveEvent): MatchResult[] {
      if (ev.type === 'sustain') return [];
      if (ev.type === 'note_off' || (ev.type === 'note_on' && ev.velocity === 0)) {
        fresh.delete(ev.note);
        return [];
      }
      if (cur >= steps.length) return [];

      const pitches = steps[cur].pitches;
      if (!pitches.includes(ev.note)) {
        wrong[cur]++;
        return [{ kind: 'wrong', step: cur, note: ev.note, attempts: wrong[cur] }];
      }

      fresh.add(ev.note);
      const out: MatchResult[] = [{ kind: 'accepted', step: cur, note: ev.note }];
      if (pitches.every((p) => fresh.has(p))) {
        out.push({ kind: 'hit', step: cur, attempts: wrong[cur] });
        cur++;
        fresh = new Set<number>();
        out.push(cur === steps.length ? { kind: 'done' } : { kind: 'advance', step: cur });
      }
      return out;
    },
  };
}
