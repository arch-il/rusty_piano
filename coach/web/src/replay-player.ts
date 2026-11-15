import type { ReplayMark, ReplayScript } from './replay-logic';

export interface ReplayClock {
  now(): number;
  every(fn: () => void, ms: number): unknown;
  cancel(id: unknown): void;
}

export interface ReplayHooks {
  noteOn(note: number, velocity: number, durationMs: number): void;
  noteOff(note: number): void;
  pedal(on: boolean): void;
  mark(m: ReplayMark): void;
  needle(from: number, to: number | null, frac: number): void;
  progress(posMs: number, durationMs: number): void;
  end(): void;
}

export type ReplayState = 'idle' | 'playing' | 'paused';

export const TICK_MS = 30;

export interface ReplayPlayer {
  play(script: ReplayScript, speed?: number): void;
  pause(): void;
  resume(): void;
  stop(): void;
  setSpeed(s: number): void;
  state(): ReplayState;
  position(): number;
  tick(): void;
}

type ReplayEvent =
  | { at: number; rank: number; type: 'on'; note: number; velocity: number; durationMs: number }
  | { at: number; rank: number; type: 'off'; note: number }
  | { at: number; rank: number; type: 'pedal'; on: boolean }
  | { at: number; rank: number; type: 'mark'; mark: ReplayMark };

export function createReplayPlayer(clock: ReplayClock, hooks: ReplayHooks): ReplayPlayer {
  let script: ReplayScript | null = null;
  let events: ReplayEvent[] = [];
  let cursor = 0;
  let basePos = 0;
  let baseNow = 0;
  let speed = 1;
  let st: ReplayState = 'idle';
  let timer: unknown = null;
  let pedalDown = false;
  let pedalHeld = false;
  const sounding = new Map<number, number>();

  const release = (): void => {
    const notes = [...sounding.keys()].sort((a, b) => a - b);
    for (const n of notes) hooks.noteOff(n);
    sounding.clear();
    if (pedalDown) {
      hooks.pedal(false);
      pedalDown = false;
    }
  };

  const position = (): number => (st === 'playing' ? basePos + (clock.now() - baseNow) * speed : basePos);

  const startTimer = (): void => {
    timer = clock.every(() => tick(), TICK_MS);
  };

  const stopTimer = (): void => {
    if (timer !== null) clock.cancel(timer);
    timer = null;
  };

  function tick(): void {
    if (st !== 'playing' || script === null) return;
    const s = script;
    const p = Math.min(position(), s.durationMs);
    while (cursor < events.length && events[cursor]!.at <= p) {
      const e = events[cursor]!;
      cursor++;
      if (e.type === 'on') {
        sounding.set(e.note, (sounding.get(e.note) ?? 0) + 1);
        hooks.noteOn(e.note, e.velocity, e.durationMs / speed);
      } else if (e.type === 'off') {
        const c = sounding.get(e.note) ?? 0;
        if (c > 0) {
          if (c === 1) {
            sounding.delete(e.note);
            hooks.noteOff(e.note);
          } else {
            sounding.set(e.note, c - 1);
          }
        }
      } else if (e.type === 'pedal') {
        pedalHeld = e.on;
        if (e.on !== pedalDown) {
          pedalDown = e.on;
          hooks.pedal(e.on);
        }
      } else {
        hooks.mark(e.mark);
      }
    }
    let k = -1;
    for (let i = 0; i < s.needle.length; i++) {
      if (s.needle[i]!.at <= p) k = i;
      else break;
    }
    if (k >= 0) {
      const cur = s.needle[k]!;
      const next = s.needle[k + 1];
      if (next && next.step > cur.step) {
        const frac = Math.min(1, Math.max(0, (p - cur.at) / (next.at - cur.at)));
        hooks.needle(cur.step, next.step, frac);
      } else {
        hooks.needle(cur.step, null, 0);
      }
    }
    hooks.progress(p, s.durationMs);
    if (p >= s.durationMs) {
      stopTimer();
      release();
      basePos = s.durationMs;
      st = 'idle';
      hooks.end();
    }
  }

  return {
    play(sc, sp) {
      if (st !== 'idle') {
        stopTimer();
        release();
      }
      script = sc;
      const list: (ReplayEvent & { order: number })[] = [];
      let order = 0;
      for (const n of sc.notes) {
        list.push({ at: n.off, rank: 0, type: 'off', note: n.note, order: order++ });
        list.push({ at: n.on, rank: 2, type: 'on', note: n.note, velocity: n.velocity, durationMs: n.off - n.on, order: order++ });
      }
      for (const pe of sc.pedal) list.push({ at: pe.at, rank: 1, type: 'pedal', on: pe.on, order: order++ });
      for (const m of sc.marks) list.push({ at: m.at, rank: 3, type: 'mark', mark: m, order: order++ });
      list.sort((a, b) => a.at - b.at || a.rank - b.rank || a.order - b.order);
      events = list;
      cursor = 0;
      pedalHeld = false;
      basePos = 0;
      baseNow = clock.now();
      if (sp !== undefined && sp > 0 && Number.isFinite(sp)) speed = sp;
      st = 'playing';
      startTimer();
      tick();
    },
    pause() {
      if (st !== 'playing') return;
      basePos = position();
      st = 'paused';
      stopTimer();
      release();
    },
    resume() {
      if (st !== 'paused') return;
      baseNow = clock.now();
      st = 'playing';
      if (pedalHeld && !pedalDown) {
        pedalDown = true;
        hooks.pedal(true);
      }
      startTimer();
    },
    stop() {
      if (st === 'idle') return;
      stopTimer();
      release();
      st = 'idle';
      hooks.end();
    },
    setSpeed(s) {
      if (!(s > 0) || !Number.isFinite(s)) return;
      if (st === 'playing') {
        basePos = position();
        baseNow = clock.now();
      }
      speed = s;
    },
    state: () => st,
    position,
    tick,
  };
}
