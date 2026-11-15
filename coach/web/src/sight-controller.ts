// DOM-free controller for one sight-reading round: builds the cards, drives the session,
// queues card renders (at most one in flight, latest wins), starts timing after a new
// card is on screen and saves the attempt. Time, wall clock, seed and rendering are injected.

import { makeRound } from './sight-gen.ts';
import { HINT_AFTER } from './sight-levels.ts';
import type { Card, CustomRange, LevelDef, SightStepRecord } from './sight-levels.ts';
import type { XmlMarks } from './sight-xml.ts';
import { buildSightAttempt, createSightSession } from './sight-session.ts';
import type { SightEffect, SightSession, SightStatus } from './sight-session.ts';
import type { LiveEvent } from './engine-socket.ts';

export type SightEnd = 'done' | 'stop' | 'interrupted';

export interface SightControllerDeps {
  now(): number;
  wallIso(): string;
  render(card: Card, marks: XmlMarks): Promise<void>;
  postAttempt(a: unknown): Promise<unknown>;
  onChange(): void;
  onRenderError(message: string): void;
  onSaved(ok: boolean, message: string | null): void;
}

export interface SightStartOptions {
  level: LevelDef;
  custom: CustomRange | null;
  seed: number;
  weights?: ReadonlyMap<number, number>;
  planId: string | null;
  tags: readonly string[];
}

export interface SightFinishResult {
  records: SightStepRecord[];
  attempt: ReturnType<typeof buildSightAttempt>;
  end: SightEnd;
  cardsDone: number;
  cardsTotal: number;
}

export interface SightController {
  start(o: SightStartOptions): void;
  handle(ev: LiveEvent): SightEffect[];
  finish(end: SightEnd): SightFinishResult | null;
  running(): boolean;
  cards(): readonly Card[];
  status(): SightStatus;
  level(): LevelDef | null;
  records(): readonly SightStepRecord[];
}

interface RenderRequest {
  round: number;
  card: Card;
  marks: XmlMarks;
  fresh: boolean;
}

const EMPTY_STATUS: SightStatus = {
  card: 0,
  step: 0,
  waiting: true,
  finished: false,
  records: 0,
  firstTry: 0,
  medianMs: null,
  lastMs: null,
  wrongOnRecord: 0,
  hinted: false,
  hintNotes: [],
};

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function createSightController(deps: SightControllerDeps): SightController {
  let round = 0;
  let levelDef: LevelDef | null = null;
  let custom: CustomRange | null = null;
  let seed = 0;
  let planId: string | null = null;
  let tags: readonly string[] = [];
  let roundCards: Card[] = [];
  let session: SightSession | null = null;
  let finished = false;
  let pageStart = 0;
  let startedWall = '';
  let marks: XmlMarks = {};
  let shownCard = 0;
  let inFlight = false;
  let pending: RenderRequest | null = null;

  function enqueue(card: Card, next: XmlMarks, fresh: boolean): void {
    const keepFresh = !fresh && pending !== null && pending.card === card && pending.fresh;
    pending = { round, card, marks: next, fresh: fresh || keepFresh };
    pump();
  }

  function pump(): void {
    if (inFlight || pending === null) return;
    const req = pending;
    pending = null;
    inFlight = true;
    void run(req);
  }

  async function run(req: RenderRequest): Promise<void> {
    try {
      await deps.render(req.card, req.marks);
    } catch (e) {
      deps.onRenderError(messageOf(e));
    }
    if (req.round !== round) return;
    inFlight = false;
    if (req.fresh && session) session.shown(deps.now());
    pump();
    deps.onChange();
  }

  function finishRound(): void {
    finished = true;
    pending = null;
  }

  function finish(end: SightEnd): SightFinishResult | null {
    if (!session || finished) return null;
    finishRound();
    session.stop();
    const records = session.records();
    if (records.length === 0) {
      deps.onChange();
      return null;
    }
    const cards = roundCards;
    const perCard = levelDef!.kind !== 'bars';
    const stepsTotal = perCard ? cards.length : cards.reduce((n, c) => n + c.steps.length, 0);
    const attempt = buildSightAttempt({
      level: levelDef!,
      custom,
      seed,
      hintAfter: HINT_AFTER,
      records,
      events: session.events(),
      end,
      startedWall,
      endedWall: deps.wallIso(),
      pageStartMs: pageStart,
      pageEndMs: deps.now(),
      cardsTotal: cards.length,
      stepsTotal,
      planId,
      tags,
    });
    const cardsDone = end === 'done' ? cards.length : session.status().card;
    void (async () => {
      let ok = true;
      let message: string | null = null;
      try {
        await deps.postAttempt(attempt);
      } catch (e) {
        ok = false;
        message = messageOf(e);
      }
      deps.onSaved(ok, message);
    })();
    deps.onChange();
    return { records, attempt, end, cardsDone, cardsTotal: cards.length };
  }

  return {
    start(o) {
      round++;
      levelDef = o.level;
      custom = o.custom;
      seed = o.seed;
      planId = o.planId;
      tags = o.tags;
      roundCards = makeRound(o.level, { seed: o.seed, custom: o.custom ?? undefined, weights: o.weights });
      session = createSightSession(roundCards, { perCard: o.level.kind !== 'bars', hintAfter: HINT_AFTER });
      finished = false;
      pageStart = deps.now();
      startedWall = deps.wallIso();
      marks = {};
      shownCard = 0;
      inFlight = false;
      pending = null;
      enqueue(roundCards[0], marks, true);
      deps.onChange();
    },

    handle(ev) {
      if (!session || finished) return [];
      const effects = session.handle(ev, deps.now());
      for (const e of effects) {
        if (e.kind === 'wrong') {
          marks = { ...marks, wrong: { step: session.status().step, note: e.note } };
          enqueue(roundCards[shownCard], marks, false);
        } else if (e.kind === 'step') {
          marks = { done: e.step };
          enqueue(roundCards[e.card], marks, false);
        } else if (e.kind === 'card') {
          marks = {};
          shownCard = e.card;
          enqueue(roundCards[e.card], marks, true);
        } else if (e.kind === 'done') {
          finish('done');
        }
      }
      deps.onChange();
      return effects;
    },

    finish,

    running() {
      return session !== null && !finished;
    },

    cards() {
      return roundCards;
    },

    status() {
      return session ? session.status() : EMPTY_STATUS;
    },

    level() {
      return levelDef;
    },

    records() {
      return session ? session.records() : [];
    },
  };
}
