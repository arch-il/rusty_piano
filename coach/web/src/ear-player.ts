// Plays ear-training prompts through the engine (play_notes with an ack), falling back to
// a simple browser tone when the engine cannot play them. No DOM and no web-audio import:
// the view passes the browser tone functions in.

import type { PromptNote } from './ear-levels.ts';
import type { PlayAck } from './engine-socket.ts';

export type SoundSource = 'engine' | 'browser' | 'none';

export interface PlayResult {
  source: SoundSource;
  note: string | null;
}

export const ACK_TIMEOUT_MS = 1000;
export const STOP_COMMAND = '{"type":"play_stop"}';

const MAX_NOTES = 128;
const NOT_CONNECTED =
  'Engine not connected: playing a simple browser tone. Start the engine (make dev) for the piano sound.';
const NOT_LIVE = 'Engine is not a live session: playing a simple browser tone.';
const NO_ANSWER =
  'The engine did not answer the play request (restart it with the new build): playing a simple browser tone.';
const NO_SOUND = 'No sound: start the engine (make dev) to hear the questions.';

export interface EarPlayerDeps {
  engineConnected(): boolean;
  engineSource(): string | null;
  send(text: string): boolean;
  onAck(fn: (ack: PlayAck) => void): () => void;
  browserAvailable(): boolean;
  browserNote(midi: number, velocity: number, durMs: number): void;
  browserStop(): void;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(id: unknown): void;
}

export interface EarPlayer {
  play(notes: readonly PromptNote[]): Promise<PlayResult>;
  stop(): void;
  resetEngine(): void;
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.round(value)));
}

export function playCommand(id: string, notes: readonly PromptNote[]): string {
  const parts = notes.slice(0, MAX_NOTES).map((n) =>
    [
      clamp(n.note, 0, 127),
      clamp(n.startMs, 0, 60000),
      clamp(n.durMs, 1, 10000),
      clamp(n.velocity, 1, 127),
    ].join(':'),
  );
  return JSON.stringify({ type: 'play_notes', id, notes: parts.join(',') });
}

interface Pending {
  id: string;
  notes: readonly PromptNote[];
  resolve: (r: PlayResult) => void;
  timer: unknown;
  unsub: () => void;
}

export function createEarPlayer(deps: EarPlayerDeps): EarPlayer {
  let counter = 0;
  let muted = false;
  let pending: Pending | null = null;
  let browserTimers: unknown[] = [];

  function take(): Pending | null {
    const p = pending;
    if (!p) return null;
    pending = null;
    deps.clearTimer(p.timer);
    p.unsub();
    return p;
  }

  function fallback(notes: readonly PromptNote[], note: string): PlayResult {
    if (!deps.browserAvailable()) return { source: 'none', note: NO_SOUND };
    for (const n of notes) {
      browserTimers.push(deps.setTimer(() => deps.browserNote(n.note, n.velocity, n.durMs), n.startMs));
    }
    return { source: 'browser', note };
  }

  return {
    async play(notes) {
      if (!deps.engineConnected()) return fallback(notes, NOT_CONNECTED);
      if (deps.engineSource() !== 'live') return fallback(notes, NOT_LIVE);
      if (muted) return fallback(notes, NO_ANSWER);

      const stale = take();
      if (stale) stale.resolve({ source: 'engine', note: null });

      counter += 1;
      const id = 'ear-' + String(counter);
      return new Promise<PlayResult>((resolve) => {
        const p: Pending = { id, notes, resolve, timer: null, unsub: () => {} };
        pending = p;
        p.unsub = deps.onAck((ack) => {
          if (!pending || ack.id !== pending.id) return;
          const q = take();
          if (!q) return;
          if (ack.ok) q.resolve({ source: 'engine', note: null });
          else
            q.resolve(
              fallback(q.notes, `The engine has no sound output (${ack.reason ?? 'unknown'}): playing a simple browser tone.`),
            );
        });
        p.timer = deps.setTimer(() => {
          const q = take();
          if (!q) return;
          muted = true;
          q.resolve(fallback(q.notes, NO_ANSWER));
        }, ACK_TIMEOUT_MS);
        if (!deps.send(playCommand(id, notes))) {
          const q = take();
          if (q) q.resolve(fallback(q.notes, NOT_CONNECTED));
        }
      });
    },

    stop() {
      for (const t of browserTimers) deps.clearTimer(t);
      browserTimers = [];
      deps.browserStop();
      if (deps.engineConnected()) deps.send(STOP_COMMAND);
      const p = take();
      if (p) p.resolve({ source: 'engine', note: null });
    },

    resetEngine() {
      muted = false;
    },
  };
}
