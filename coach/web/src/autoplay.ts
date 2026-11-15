import type { LiveEvent } from "./engine-socket";

export interface AutoStep {
  pitches: readonly number[];
  time: number;
  lengths?: readonly number[];
  staccato?: readonly boolean[];
}

export interface AutoplayKnobs {
  velocity: number;
  gatePercent: number;
  // Gate for staccato notes, in percent of the written length (default 40).
  staccatoGatePercent?: number;
  offsetMs: number;
  jitterMs: number;
  skipEvery: number;
  wrongEvery: number;
  seed: number;
  shortEvery?: number;
}

export interface ScheduledNote {
  on: number;
  off: number;
  note: number;
  velocity: number;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function midiToHz(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

export function autoplaySchedule(
  steps: readonly AutoStep[],
  msPerQuarter: number,
  knobs: AutoplayKnobs,
  lengthQuarters: number,
  msAt?: (q: number) => number,
): ScheduledNote[] {
  const ms = (q: number) => (msAt ? msAt(q) : q * msPerQuarter);
  const rand = mulberry32(knobs.seed);
  const notes: ScheduledNote[] = [];
  const n = steps.length;
  for (let k = 0; k < n; k++) {
    const step = steps[k];
    const r = knobs.jitterMs > 0 ? rand() : 0;
    const shift = knobs.offsetMs + (knobs.jitterMs > 0 ? Math.round((r * 2 - 1) * knobs.jitterMs) : 0);
    if (knobs.skipEvery > 0 && (k + 1) % knobs.skipEvery === 0) continue;
    const on = Math.round(ms(step.time) + shift);
    const next = k + 1 < n ? steps[k + 1].time : lengthQuarters;
    const gapSpan = ms(next) - ms(step.time);
    const short = (knobs.shortEvery ?? 0) > 0 && (k + 1) % knobs.shortEvery! === 0;
    step.pitches.forEach((note, j) => {
      const len = step.lengths?.[j] ?? 0;
      const span = len > 0 ? ms(step.time + len) - ms(step.time) : gapSpan;
      const gate = short ? 20 : step.staccato?.[j] === true ? (knobs.staccatoGatePercent ?? 40) : knobs.gatePercent;
      const noteOff = on + Math.max(30, Math.round((span * gate) / 100));
      notes.push({ on, off: noteOff, note, velocity: knobs.velocity });
    });
    if (knobs.wrongEvery > 0 && (k + 1) % knobs.wrongEvery === 0 && step.pitches.length > 0) {
      const off = on + Math.max(30, Math.round((gapSpan * knobs.gatePercent) / 100));
      notes.push({ on: on - 1, off, note: Math.min(127, Math.max(...step.pitches) + 1), velocity: knobs.velocity });
    }
  }
  for (const a of notes) {
    for (const b of notes) {
      if (b !== a && b.note === a.note && (b.on > a.on || (b.on === a.on && notes.indexOf(b) > notes.indexOf(a))) && b.on <= a.off) {
        a.off = Math.max(a.on + 1, b.on - 1);
      }
    }
  }
  return notes.sort((x, y) => x.on - y.on || x.note - y.note);
}

export interface AutoplayerDeps {
  publish(ev: LiveEvent): void;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(id: unknown): void;
  onNoteOn?(note: number, velocity: number, durationMs: number): void;
}

export interface Autoplayer {
  play(
    notes: readonly ScheduledNote[],
    t0: number,
    loopMs: number | null,
    opts?: { shiftToNow?: boolean; cycleTiming?: (cycle: number) => { start: number; scale: number } | null },
  ): void;
  stop(): void;
  playing(): boolean;
}

interface PlayEvent {
  id: number;
  at: number;
  on: boolean;
  note: number;
  velocity: number;
  duration: number;
}

export function createAutoplayer(deps: AutoplayerDeps): Autoplayer {
  let timer: unknown = null;
  let isPlaying = false;
  let held = new Map<number, number>();
  let events: PlayEvent[] = [];
  let idx = 0;
  let cycle = 0;
  let dead = new Set<number>();
  let t0 = 0;
  let loopMs: number | null = null;
  let stopped = false;
  let cycleTiming: ((cycle: number) => { start: number; scale: number } | null) | undefined;
  let timings = new Map<number, { start: number; scale: number }>();

  const timingOf = (c: number): { start: number; scale: number } => {
    if (c === 0 || loopMs === null || !cycleTiming) return { start: t0 + c * (loopMs ?? 0), scale: 1 };
    let v = timings.get(c);
    if (v === undefined) {
      const r = cycleTiming(c);
      v =
        r && Number.isFinite(r.start) && Number.isFinite(r.scale) && r.scale > 0
          ? { start: r.start, scale: r.scale }
          : { start: t0 + c * loopMs, scale: 1 };
      timings.set(c, v);
    }
    return v;
  };

  const due = (e: PlayEvent): number => {
    const t = timingOf(cycle);
    return t.start + e.at / t.scale;
  };

  const clear = (): void => {
    if (timer !== null) deps.clearTimer(timer);
    timer = null;
  };

  const skipPast = (): void => {
    dead = new Set();
    const cutoff = deps.now() - 1;
    for (const e of events) if (e.on && due(e) < cutoff) dead.add(e.id);
    while (idx < events.length && (dead.has(events[idx].id) || due(events[idx]) < cutoff)) idx++;
  };

  const schedule = (): void => {
    if (stopped) return;
    clear();
    if (idx >= events.length) {
      if (loopMs !== null && events.length > 0) {
        cycle++;
        idx = 0;
        skipPast();
        if (idx >= events.length) {
          schedule();
          return;
        }
      } else {
        isPlaying = false;
        return;
      }
    }
    timer = deps.setTimer(fire, Math.max(0, due(events[idx]) - deps.now()));
  };

  const fire = (): void => {
    if (stopped) return;
    timer = null;
    const limit = deps.now() + 1;
    while (!stopped && idx < events.length && (dead.has(events[idx].id) || due(events[idx]) <= limit)) {
      const e = events[idx++];
      if (dead.has(e.id)) continue;
      const t = Math.round(deps.now());
      if (e.on) {
        held.set(e.note, e.velocity);
        deps.publish({ type: "note_on", t, note: e.note, velocity: e.velocity, source: "autoplay" });
        deps.onNoteOn?.(e.note, e.velocity, e.duration / timingOf(cycle).scale);
      } else {
        held.delete(e.note);
        deps.publish({ type: "note_off", t, note: e.note, source: "autoplay" });
      }
    }
    schedule();
  };

  const stop = (): void => {
    clear();
    for (const note of held.keys()) {
      deps.publish({ type: "note_off", t: Math.round(deps.now()), note, source: "autoplay" });
    }
    held = new Map();
    stopped = true;
    isPlaying = false;
  };

  return {
    play(notes, start, loop, opts) {
      stop();
      stopped = false;
      t0 = start;
      loopMs = loop;
      cycleTiming = opts?.cycleTiming;
      timings = new Map();
      cycle = 0;
      idx = 0;
      events = [];
      notes.forEach((n, id) => {
        events.push({ id, at: n.on, on: true, note: n.note, velocity: n.velocity, duration: n.off - n.on });
        events.push({ id, at: n.off, on: false, note: n.note, velocity: 0, duration: 0 });
      });
      events.sort((a, b) => a.at - b.at || Number(a.on) - Number(b.on));
      let minOn = Infinity;
      for (const n of notes) minOn = Math.min(minOn, n.on);
      if (opts?.shiftToNow === true && minOn < 0 && t0 >= deps.now() && t0 + minOn < deps.now()) t0 = deps.now() - minOn;
      isPlaying = true;
      skipPast();
      schedule();
    },
    stop,
    playing: () => isPlaying,
  };
}
