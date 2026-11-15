// Answer matching for one ear-training item: pure, no clock, no DOM. It turns key events
// into results per answer step (a note, a pitch class or a whole chord).
// A later naming-button input (for example "major" / "minor") could produce the same
// results without keys, so the session only depends on EarMatchResult.

import type { AnswerStep } from './ear-levels.ts';
import type { LiveEvent } from './engine-socket.ts';

export type EarMatchResult =
  | { kind: 'accepted'; step: number; note: number }
  | { kind: 'wrong'; step: number; note: number }
  | { kind: 'step'; step: number }
  | { kind: 'done' };

export interface EarMatcher {
  current(): number;
  done(): boolean;
  handle(ev: LiveEvent): EarMatchResult[];
}

export function createEarMatcher(steps: readonly AnswerStep[]): EarMatcher {
  let index = 0;
  let finished = steps.length === 0;
  const held = new Set<number>();

  function advance(out: EarMatchResult[]): void {
    held.clear();
    index++;
    if (index >= steps.length) {
      finished = true;
      out.push({ kind: 'done' });
    } else {
      out.push({ kind: 'step', step: index });
    }
  }

  return {
    current: () => index,
    done: () => finished,
    handle(ev) {
      const out: EarMatchResult[] = [];
      if (finished || ev.type === 'sustain') return out;
      if (ev.type === 'note_off' || (ev.type === 'note_on' && ev.velocity === 0)) {
        held.delete(ev.note);
        return out;
      }
      const step = steps[index];
      const note = ev.note;
      if (step.kind === 'note') {
        if (note === step.pitch) {
          out.push({ kind: 'accepted', step: index, note });
          advance(out);
        } else {
          out.push({ kind: 'wrong', step: index, note });
        }
      } else if (step.kind === 'pc') {
        if (note % 12 === step.pc) {
          out.push({ kind: 'accepted', step: index, note });
          advance(out);
        } else {
          out.push({ kind: 'wrong', step: index, note });
        }
      } else if (!step.pcs.includes(note % 12)) {
        out.push({ kind: 'wrong', step: index, note });
      } else {
        held.add(note);
        out.push({ kind: 'accepted', step: index, note });
        const covered = new Set([...held].map((n) => n % 12));
        if (step.pcs.every((pc) => covered.has(pc))) advance(out);
      }
      return out;
    },
  };
}
