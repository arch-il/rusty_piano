// DOM-free controller for one ear-training round: makes the items, drives the session,
// plays prompts and answer sounds through an injected player, auto-advances and saves the
// attempt. Time, wall clock, timers, sound and saving are injected.

import { makeEarRound } from './ear-gen.ts';
import { REVEAL_AFTER, promptLengthMs } from './ear-levels.ts';
import type { EarItem, EarLevelDef, EarSettings, EarStepRecord, PromptNote } from './ear-levels.ts';
import { buildEarAttempt, createEarSession } from './ear-session.ts';
import type { EarEffect, EarSession, EarStatus } from './ear-session.ts';
import type { PlayResult } from './ear-player.ts';
import type { LiveEvent } from './engine-socket.ts';

export const TAIL_MS = 250;
export const NEXT_AFTER_MS = 1500;

export type EarEnd = 'done' | 'stop' | 'interrupted';
export type EarSound = 'engine' | 'browser' | 'none' | 'mixed';

export interface EarControllerDeps {
  now(): number;
  wallIso(): string;
  player: { play(notes: PromptNote[]): Promise<PlayResult>; stop(): void };
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(id: unknown): void;
  postAttempt(a: unknown): Promise<unknown>;
  onChange(): void;
  onSaved(ok: boolean, message: string | null): void;
}

export interface EarStartOptions {
  level: EarLevelDef;
  settings: EarSettings;
  drillId: string | null;
  seed: number;
  planId: string | null;
  tags: readonly string[];
  autoNext?: boolean;
}

export interface EarFinishResult {
  attempt: ReturnType<typeof buildEarAttempt>;
  records: EarStepRecord[];
  end: EarEnd;
  itemsDone: number;
  itemsTotal: number;
}

export interface EarControllerStatus extends EarStatus {
  sound: EarSound;
  soundNote: string | null;
  revealShown: boolean;
  playing: boolean;
  currentItem: EarItem | null;
  lastEffect: EarEffect | null;
}

export interface EarController {
  start(o: EarStartOptions): void;
  handle(ev: LiveEvent): EarEffect[];
  replay(): void;
  reveal(): void;
  next(): void;
  finish(end: EarEnd): EarFinishResult | null;
  running(): boolean;
  status(): EarControllerStatus;
  items(): readonly EarItem[];
  level(): EarLevelDef | null;
}

const EMPTY_STATUS: EarStatus = {
  item: 0,
  total: 0,
  phase: 'finished',
  records: 0,
  firstTry: 0,
  medianStepMs: null,
  replays: 0,
  wrongOnItem: 0,
  lastResult: null,
  revealed: false,
};

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function createEarController(deps: EarControllerDeps): EarController {
  let levelDef: EarLevelDef | null = null;
  let settings: EarSettings | null = null;
  let drillId: string | null = null;
  let seed = 0;
  let planId: string | null = null;
  let tags: readonly string[] = [];
  let autoNext = true;
  let roundItems: EarItem[] = [];
  let session: EarSession | null = null;
  let finished = false;
  let pageStart = 0;
  let startedWall = '';
  let token = 0;
  let playing = false;
  let revealShown = false;
  let sources = new Set<string>();
  let soundNote: string | null = null;
  let lastEffect: EarEffect | null = null;
  let tailTimer: unknown = null;
  let nextTimer: unknown = null;

  function sound(): EarSound {
    if (sources.size === 0) return 'none';
    if (sources.size === 1) return [...sources][0] as EarSound;
    return 'mixed';
  }

  function clearTail(): void {
    if (tailTimer !== null) deps.clearTimer(tailTimer);
    tailTimer = null;
  }

  function clearNext(): void {
    if (nextTimer !== null) deps.clearTimer(nextTimer);
    nextTimer = null;
  }

  function play(notes: PromptNote[], after?: () => void): void {
    const mine = ++token;
    clearTail();
    playing = true;
    void deps.player.play(notes).then((res) => {
      if (mine !== token || finished) return;
      sources.add(res.source);
      soundNote = res.note;
      tailTimer = deps.setTimer(() => {
        if (mine !== token || finished) return;
        tailTimer = null;
        playing = false;
        session!.asked(deps.now());
        if (after) after();
        deps.onChange();
      }, promptLengthMs(notes) + TAIL_MS);
      deps.onChange();
    });
  }

  function isLast(): boolean {
    return session!.item() >= roundItems.length - 1;
  }

  function scheduleNext(): void {
    if (!autoNext) return;
    clearNext();
    nextTimer = deps.setTimer(() => {
      nextTimer = null;
      next();
    }, NEXT_AFTER_MS);
  }

  function playAnswer(after?: () => void): void {
    play(roundItems[session!.item()].answerSound, after);
  }

  function next(): void {
    if (!session || finished || session.phase() !== 'answered') return;
    clearNext();
    if (isLast()) {
      finish('done');
      return;
    }
    session.next();
    revealShown = false;
    lastEffect = null;
    play(roundItems[session.item()].prompt);
    deps.onChange();
  }

  function finish(end: EarEnd): EarFinishResult | null {
    if (!session || finished) return null;
    finished = true;
    token++;
    playing = false;
    deps.player.stop();
    clearTail();
    clearNext();
    session.stop();
    const records = session.records();
    if (records.length === 0) {
      deps.onChange();
      return null;
    }
    const attempt = buildEarAttempt({
      level: levelDef!,
      settings: settings!,
      drillId,
      seed,
      revealAfter: REVEAL_AFTER,
      records,
      events: session.events(),
      end,
      startedWall,
      endedWall: deps.wallIso(),
      pageStartMs: pageStart,
      pageEndMs: deps.now(),
      itemsTotal: roundItems.length,
      sound: sound(),
      planId,
      tags,
    });
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
    return { attempt, records, end, itemsDone: records.length, itemsTotal: roundItems.length };
  }

  return {
    start(o) {
      token++;
      clearTail();
      clearNext();
      levelDef = o.level;
      settings = o.settings;
      drillId = o.drillId;
      seed = o.seed;
      planId = o.planId;
      tags = o.tags;
      autoNext = o.autoNext ?? true;
      roundItems = makeEarRound(o.level, o.settings, o.seed);
      session = createEarSession(roundItems, { revealAfter: REVEAL_AFTER });
      finished = false;
      playing = false;
      revealShown = false;
      sources = new Set();
      soundNote = null;
      lastEffect = null;
      pageStart = deps.now();
      startedWall = deps.wallIso();
      play(roundItems[0].prompt);
      deps.onChange();
    },

    handle(ev) {
      if (!session || finished) return [];
      const effects = session.handle(ev, deps.now());
      for (const e of effects) {
        lastEffect = e;
        if (e.kind === 'correct') {
          const afterSound = () => {
            if (isLast()) {
              nextTimer = deps.setTimer(() => {
                nextTimer = null;
                finish('done');
              }, NEXT_AFTER_MS);
            } else {
              scheduleNext();
            }
          };
          const go = autoNext ? afterSound : undefined;
          if (!e.firstTry) playAnswer(go);
          else if (go) go();
        } else if (e.kind === 'revealed') {
          revealShown = true;
          playAnswer();
        }
      }
      deps.onChange();
      return effects;
    },

    replay() {
      if (!session || finished || playing) return;
      const phase = session.phase();
      if (phase === 'answering') {
        session.replayed();
      } else if (phase === 'answered') {
        clearNext();
      } else {
        return;
      }
      play(roundItems[session.item()].prompt);
      deps.onChange();
    },

    reveal() {
      if (!session || finished) return;
      const phase = session.phase();
      if (phase === 'playing' || phase === 'answering') {
        lastEffect = session.reveal(deps.now())[0] ?? lastEffect;
      } else if (phase === 'answered') {
        clearNext();
      } else {
        return;
      }
      revealShown = true;
      playAnswer();
      deps.onChange();
    },

    next,

    finish,

    running() {
      return session !== null && !finished;
    },

    status() {
      const base = session ? session.status() : EMPTY_STATUS;
      return {
        ...base,
        sound: sound(),
        soundNote,
        revealShown,
        playing,
        currentItem: session && !finished ? roundItems[session.item()] : null,
        lastEffect,
      };
    },

    items() {
      return roundItems;
    },

    level() {
      return levelDef;
    },
  };
}
