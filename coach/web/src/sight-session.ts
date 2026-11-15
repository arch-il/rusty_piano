// One sight-reading round as a pure state machine: wait-mode matching per card,
// wrong marks, hints, reaction times and the version-2 attempt object. Times come in
// as page milliseconds; nothing here reads a clock.

import { createWaitMatcher } from './note-matcher.ts';
import type { WaitMatcher } from './note-matcher.ts';
import { SCORE_PREFIX, SIGHT_TAG, SPEED_TARGETS_MS, formatSeconds, roundStats } from './sight-levels.ts';
import type { Card, CustomRange, LevelDef, SightStepRecord } from './sight-levels.ts';
import type { LiveEvent } from './engine-socket.ts';
import type { AttemptEvent } from './attempt-recorder.ts';

export type SightEffect =
  | { kind: 'wrong'; note: number; attempts: number }
  | { kind: 'hint'; notes: number[] }
  | { kind: 'step'; card: number; step: number }
  | { kind: 'card'; card: number }
  | { kind: 'done' };

export interface SightStatus {
  card: number;
  step: number;
  waiting: boolean;
  finished: boolean;
  records: number;
  firstTry: number;
  medianMs: number | null;
  lastMs: number | null;
  wrongOnRecord: number;
  hinted: boolean;
  hintNotes: number[];
}

export interface SightSession {
  shown(pageMs: number): void;
  handle(ev: LiveEvent, pageMs: number): SightEffect[];
  stop(): void;
  status(): SightStatus;
  records(): SightStepRecord[];
  events(): AttemptEvent[];
}

export interface SightAttemptInput {
  level: LevelDef;
  custom: CustomRange | null;
  seed: number;
  hintAfter: number;
  records: readonly SightStepRecord[];
  events: readonly AttemptEvent[];
  end: 'done' | 'stop' | 'interrupted';
  startedWall: string;
  endedWall: string;
  pageStartMs: number;
  pageEndMs: number;
  cardsTotal: number;
  stepsTotal: number;
  planId: string | null;
  tags: readonly string[];
}

function matcherFor(card: Card): WaitMatcher {
  return createWaitMatcher(card.steps.map((s) => ({ pitches: s.pitches })));
}

function toAttemptEvent(ev: LiveEvent, pageMs: number): AttemptEvent {
  if (ev.type === 'note_on') {
    return { type: 'note_on', t: ev.t, page_ms: pageMs, source: ev.source, note: ev.note, velocity: ev.velocity };
  }
  if (ev.type === 'note_off') {
    return { type: 'note_off', t: ev.t, page_ms: pageMs, source: ev.source, note: ev.note };
  }
  return { type: 'sustain', t: ev.t, page_ms: pageMs, source: ev.source, on: ev.on };
}

export function createSightSession(
  cards: readonly Card[],
  opts: { perCard: boolean; hintAfter?: number },
): SightSession {
  const hintAfter = opts.hintAfter ?? 2;
  let card = 0;
  let step = 0;
  let waiting = true;
  let finished = false;
  let stopped = false;
  let matcher: WaitMatcher = matcherFor(cards[0]);
  let recStart = 0;
  let wrongCount = 0;
  let wrongNotes: number[] = [];
  let hinted = false;
  let hintNotes: number[] = [];
  const recs: SightStepRecord[] = [];
  const log: AttemptEvent[] = [];

  function resetWrong(): void {
    wrongCount = 0;
    wrongNotes = [];
    hinted = false;
    hintNotes = [];
  }

  function resetCard(next: number): void {
    card = next;
    step = 0;
    waiting = true;
    matcher = matcherFor(cards[next]);
    resetWrong();
  }

  function recordHit(pageMs: number): void {
    const c = cards[card];
    const firstTry = wrongCount === 0 && !hinted;
    recs.push({
      step: recs.length,
      card,
      notes: opts.perCard ? c.steps.flatMap((s) => s.pitches) : [...c.steps[step].pitches],
      result: firstTry ? 'hit' : 'wrong',
      first_try: firstTry,
      wrong_count: wrongCount,
      wrong_notes: [...wrongNotes],
      hinted,
      reaction_ms: Math.round((pageMs - recStart) * 10) / 10,
      shown_page_ms: recStart,
      done_page_ms: pageMs,
    });
  }

  function onHit(pageMs: number): SightEffect[] {
    const c = cards[card];
    const last = step === c.steps.length - 1;
    const out: SightEffect[] = [];
    if (!opts.perCard || last) recordHit(pageMs);
    if (!opts.perCard) {
      if (hinted) out.push({ kind: 'hint', notes: [] });
      recStart = pageMs;
      resetWrong();
    }
    if (last) {
      if (card === cards.length - 1) {
        finished = true;
        out.push({ kind: 'done' });
      } else {
        resetCard(card + 1);
        out.push({ kind: 'card', card });
      }
      return out;
    }
    step++;
    out.push({ kind: 'step', card, step });
    if (opts.perCard && hinted) {
      hintNotes = [...c.steps[step].pitches];
      out.push({ kind: 'hint', notes: hintNotes });
    }
    return out;
  }

  return {
    shown(pageMs) {
      if (!waiting || finished) return;
      waiting = false;
      recStart = pageMs;
    },
    handle(ev, pageMs) {
      if (stopped) return [];
      log.push(toAttemptEvent(ev, pageMs));
      if (waiting || finished) return [];
      const out: SightEffect[] = [];
      for (const r of matcher.handle(ev)) {
        if (r.kind === 'wrong') {
          wrongCount++;
          wrongNotes.push(r.note);
          out.push({ kind: 'wrong', note: r.note, attempts: r.attempts });
          if (!hinted && wrongCount >= hintAfter) {
            hinted = true;
            hintNotes = [...cards[card].steps[step].pitches];
            out.push({ kind: 'hint', notes: hintNotes });
          }
        } else if (r.kind === 'hit') {
          out.push(...onHit(pageMs));
        }
      }
      return out;
    },
    stop() {
      stopped = true;
      finished = true;
    },
    status() {
      const s = roundStats(recs);
      return {
        card,
        step,
        waiting,
        finished,
        records: recs.length,
        firstTry: s.firstTry,
        medianMs: s.medianMs,
        lastMs: recs.length === 0 ? null : recs[recs.length - 1].reaction_ms,
        wrongOnRecord: wrongCount,
        hinted,
        hintNotes: [...hintNotes],
      };
    },
    records() {
      return recs.map((r) => ({ ...r, notes: [...r.notes], wrong_notes: [...r.wrong_notes] }));
    },
    events() {
      return log.map((e) => ({ ...e }));
    },
  };
}

export function buildSightAttempt(i: SightAttemptInput) {
  const s = roundStats(i.records);
  const level = i.level;
  const engine = i.events.find((e) => e.source === 'engine');
  return {
    version: 2,
    kind: 'rusty_piano.attempt',
    score: { id: SCORE_PREFIX + level.id, title: 'Sight-reading: ' + level.title, composer: null },
    mode: 'wait',
    end: i.end,
    started_at: i.startedWall,
    ended_at: i.endedWall,
    duration_ms: Math.round(i.pageEndMs - i.pageStartMs),
    clock: {
      page_start_ms: i.pageStartMs,
      t0_ms: null,
      first_engine_t: engine ? engine.t : null,
      first_engine_page_ms: engine ? engine.page_ms : null,
    },
    practice: {
      hands: level.hands,
      range: null,
      loop: false,
      loops_completed: 0,
      tempo: { percent: 100 },
    },
    plan: { steps_total: i.stepsTotal, length_quarters: 0, first_bar: null, last_bar: null },
    settings: { sight: { hint_after: i.hintAfter, seed: i.seed, custom: i.custom } },
    autoplay: { on_at_start: false, used: false },
    sources: [...new Set(i.events.map((e) => e.source))].sort(),
    pedal_down_at_start: false,
    sight: {
      level: level.id,
      kind: level.kind,
      cards_total: i.cardsTotal,
      steps_total: i.stepsTotal,
      custom: i.custom,
      targets_ms: SPEED_TARGETS_MS[level.kind],
    },
    steps: i.records.map((r) => ({ ...r, notes: [...r.notes], wrong_notes: [...r.wrong_notes] })),
    events: i.events.map((e) => ({ ...e })),
    summary: {
      counts: {
        expectedNotes: s.steps,
        correctNotes: s.firstTry,
        wrongNotes: s.steps - s.firstTry,
        missedNotes: 0,
      },
      metrics: {
        accuracy: s.accuracy === null ? '-' : Math.round(s.accuracy * 100) + '%',
        tempo: '-',
        wrong: String(s.wrongNotes),
        missed: '0',
      },
      rows: [
        ['Level', level.title],
        ['First try', s.firstTry + ' of ' + s.steps],
        ['Median time', formatSeconds(s.medianMs)],
      ],
      sight: {
        accuracy: s.accuracy,
        median_ms: s.medianMs,
        mean_ms: s.meanMs,
        first_try: s.firstTry,
        steps: s.steps,
        hinted: s.hinted,
        wrong_notes: s.wrongNotes,
      },
    },
    drill_id: level.drill,
    plan_id: i.planId,
    tags: [...new Set([SIGHT_TAG, ...i.tags])].slice(0, 10),
  };
}
