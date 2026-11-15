// One ear-training round as a pure state machine: phases, answer matching per item,
// wrong keys, reveals, response times and the version-2 attempt object. Times come in
// as page milliseconds; nothing here reads a clock.

import { createEarMatcher } from './ear-matcher.ts';
import type { EarMatcher } from './ear-matcher.ts';
import { EAR_TAG, EAR_TARGETS_MS, REVEAL_AFTER, SCORE_PREFIX } from './ear-levels.ts';
import type { EarItem, EarLevelDef, EarSettings, EarStepRecord } from './ear-levels.ts';
import { formatSeconds, median } from './sight-levels.ts';
import type { LiveEvent } from './engine-socket.ts';
import type { AttemptEvent } from './attempt-recorder.ts';

export type EarPhase = 'playing' | 'answering' | 'answered' | 'finished';

export type EarEffect =
  | { kind: 'accepted'; note: number; step: number }
  | { kind: 'wrong'; note: number; wrongCount: number }
  | { kind: 'correct'; item: number; firstTry: boolean }
  | { kind: 'revealed'; item: number; auto: boolean };

export interface EarStatus {
  item: number;
  total: number;
  phase: EarPhase;
  records: number;
  firstTry: number;
  medianStepMs: number | null;
  replays: number;
  wrongOnItem: number;
  lastResult: 'right' | 'wrong' | null;
  revealed: boolean;
}

export interface EarSession {
  asked(pageMs: number): EarPhase;
  replayed(): void;
  handle(ev: LiveEvent, pageMs: number): EarEffect[];
  reveal(pageMs: number): EarEffect[];
  next(): boolean;
  stop(): void;
  phase(): EarPhase;
  item(): number;
  status(): EarStatus;
  records(): EarStepRecord[];
  events(): AttemptEvent[];
}

export interface EarAttemptInput {
  level: EarLevelDef;
  settings: EarSettings;
  drillId: string | null;
  seed: number;
  revealAfter: number;
  records: readonly EarStepRecord[];
  events: readonly AttemptEvent[];
  end: 'done' | 'stop' | 'interrupted';
  startedWall: string;
  endedWall: string;
  pageStartMs: number;
  pageEndMs: number;
  itemsTotal: number;
  sound: 'engine' | 'browser' | 'none' | 'mixed';
  planId: string | null;
  tags: readonly string[];
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

function copyRecord(r: EarStepRecord): EarStepRecord {
  return {
    ...r,
    prompt_notes: [...r.prompt_notes],
    given: [...r.given],
    answer_notes: [...r.answer_notes],
    wrong_notes: [...r.wrong_notes],
  };
}

function medianStepMs(records: readonly EarStepRecord[]): number | null {
  const values: number[] = [];
  for (const r of records) {
    if (r.response_ms !== null) values.push(r.response_ms / r.answer_steps);
  }
  return median(values);
}

export function createEarSession(items: readonly EarItem[], opts: { revealAfter?: number }): EarSession {
  const revealAfter = opts.revealAfter ?? REVEAL_AFTER;
  let index = 0;
  let phase: EarPhase = 'playing';
  let stopped = false;
  let askedAt: number | null = null;
  let replays = 0;
  let wrongCount = 0;
  let wrongNotes: number[] = [];
  let revealed = false;
  let matcher: EarMatcher = createEarMatcher(items[0].answer);
  const recs: EarStepRecord[] = [];
  const log: AttemptEvent[] = [];

  function close(pageMs: number, wasRevealed: boolean): boolean {
    const it = items[index];
    const firstTry = wrongCount === 0 && !wasRevealed;
    recs.push({
      step: index,
      item: index,
      type: it.type,
      category: it.category,
      label: it.label,
      prompt_notes: it.prompt.map((n) => n.note),
      given: [...it.given],
      answer_notes: [...it.answerNotes],
      answer_steps: it.answer.length,
      result: firstTry ? 'hit' : 'wrong',
      first_try: firstTry,
      wrong_count: wrongCount,
      wrong_notes: [...wrongNotes],
      replays,
      revealed: wasRevealed,
      response_ms: wasRevealed || askedAt === null ? null : Math.round((pageMs - askedAt) * 10) / 10,
      asked_page_ms: askedAt ?? pageMs,
      done_page_ms: pageMs,
    });
    phase = 'answered';
    revealed = wasRevealed;
    return firstTry;
  }

  return {
    asked(pageMs) {
      if (phase === 'playing') {
        phase = 'answering';
        if (askedAt === null) askedAt = pageMs;
      }
      return phase;
    },
    replayed() {
      if (phase === 'answered' || phase === 'finished') return;
      replays++;
      phase = 'playing';
    },
    handle(ev, pageMs) {
      if (stopped) return [];
      log.push(toAttemptEvent(ev, pageMs));
      if (phase !== 'answering') return [];
      const out: EarEffect[] = [];
      for (const r of matcher.handle(ev)) {
        if (r.kind === 'accepted') {
          out.push({ kind: 'accepted', note: r.note, step: r.step });
        } else if (r.kind === 'wrong') {
          wrongCount++;
          wrongNotes.push(r.note);
          out.push({ kind: 'wrong', note: r.note, wrongCount });
          if (wrongCount >= revealAfter) {
            close(pageMs, true);
            out.push({ kind: 'revealed', item: index, auto: true });
            return out;
          }
        } else if (r.kind === 'done') {
          const firstTry = close(pageMs, false);
          out.push({ kind: 'correct', item: index, firstTry });
        }
      }
      return out;
    },
    reveal(pageMs) {
      if (phase !== 'playing' && phase !== 'answering') return [];
      close(pageMs, true);
      return [{ kind: 'revealed', item: index, auto: false }];
    },
    next() {
      if (phase !== 'answered' || index >= items.length - 1) return false;
      index++;
      phase = 'playing';
      askedAt = null;
      replays = 0;
      wrongCount = 0;
      wrongNotes = [];
      revealed = false;
      matcher = createEarMatcher(items[index].answer);
      return true;
    },
    stop() {
      stopped = true;
      phase = 'finished';
    },
    phase: () => phase,
    item: () => index,
    status() {
      const last = recs.length === 0 ? null : recs[recs.length - 1];
      return {
        item: index,
        total: items.length,
        phase,
        records: recs.length,
        firstTry: recs.filter((r) => r.first_try).length,
        medianStepMs: medianStepMs(recs),
        replays,
        wrongOnItem: wrongCount,
        lastResult: last === null ? null : last.first_try ? 'right' : 'wrong',
        revealed,
      };
    },
    records() {
      return recs.map(copyRecord);
    },
    events() {
      return log.map((e) => ({ ...e }));
    },
  };
}

export function buildEarAttempt(i: EarAttemptInput) {
  const level = i.level;
  const itemsDone = i.records.length;
  const firstTry = i.records.filter((r) => r.first_try).length;
  const replays = i.records.reduce((a, r) => a + r.replays, 0);
  const revealed = i.records.filter((r) => r.revealed).length;
  const medianStep = medianStepMs(i.records);
  const engine = i.events.find((e) => e.source === 'engine');
  const s = i.settings;
  return {
    version: 2,
    kind: 'rusty_piano.attempt',
    score: { id: SCORE_PREFIX + level.id, title: 'Ear training: ' + level.title, composer: null },
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
      hands: 'both',
      range: null,
      loop: false,
      loops_completed: 0,
      tempo: { percent: 100 },
    },
    plan: { steps_total: i.itemsTotal, length_quarters: 0, first_bar: null, last_bar: null },
    settings: {
      ear: {
        seed: i.seed,
        reveal_after: i.revealAfter,
        sound: i.sound,
        counted: i.drillId !== null,
        settings: {
          low: s.low,
          high: s.high,
          key: s.key,
          set: [...s.set],
          direction: s.direction,
          harmonic: s.harmonic,
          bpm: s.bpm,
          len_min: s.lenMin,
          len_max: s.lenMax,
        },
      },
    },
    autoplay: { on_at_start: false, used: false },
    sources: [...new Set(i.events.map((e) => e.source))].sort(),
    pedal_down_at_start: false,
    ear: {
      level: level.id,
      type: level.type,
      node: level.node,
      kind: level.kind,
      items_total: i.itemsTotal,
      items_done: itemsDone,
      first_try: firstTry,
      replays,
      revealed,
      median_step_ms: medianStep,
      targets_ms: EAR_TARGETS_MS[level.kind],
      sound: i.sound,
    },
    steps: i.records.map(copyRecord),
    events: i.events.map((e) => ({ ...e })),
    summary: {
      counts: {
        expectedNotes: itemsDone,
        correctNotes: firstTry,
        wrongNotes: itemsDone - firstTry,
        missedNotes: 0,
      },
      metrics: {
        accuracy: itemsDone ? Math.round((100 * firstTry) / itemsDone) + '%' : '-',
        tempo: '-',
        wrong: String(itemsDone - firstTry),
        missed: '0',
      },
      rows: [
        ['Level', level.title],
        ['First try', `${firstTry} of ${itemsDone}`],
        ['Replays', String(replays)],
        ['Median time', formatSeconds(medianStep)],
      ],
      ear: {
        accuracy: itemsDone ? firstTry / itemsDone : null,
        median_step_ms: medianStep,
        first_try: firstTry,
        items: itemsDone,
        replays,
        revealed,
      },
    },
    drill_id: i.drillId,
    plan_id: i.planId,
    tags: [...new Set([EAR_TAG, ...i.tags])].slice(0, 10),
  };
}
