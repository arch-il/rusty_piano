import type { LiveEvent, LiveSource } from './engine-socket';
import type { MatchStep, StepOutcome, WaitMatcher } from './note-matcher';
import type { LiveMatcher, LiveOptions, LiveResult, LiveStep } from './live-matcher';
import type { BarRange, Hands, PlanOptions, PlanSourceStep, PracticePlan } from './practice-steps';
import { medianPaceBpm, paceSample, type PracticeCounts } from './practice-metrics.ts';
import type { TempoChange, TempoMap } from './tempo-map';
import type { HoldChecker, HoldOptions } from './hold-checker';
import { DEFAULT_CURVE, timingScore, type TimingCurve } from './timing-score.ts';
import { createRamp, type Ramp, type RampOptions } from './tempo-ramp.ts';

export type FollowMode = 'wait' | 'live';

export interface FollowOptions {
  mode: FollowMode;
  hands: Hands;
  range: BarRange | null;
  loop: boolean;
  bpm: number;
  percent?: number;
  holds?: HoldOptions | null;
  countInBeats: number;
  beatQuarters: number;
  windowMs: number;
  onTimeMs: number;
  slide: boolean;
  timing?: TimingCurve;
  ramp?: RampOptions | null;
}

export interface FollowView {
  timeline(): readonly PlanSourceStep[];
  setFollowing(on: boolean, hands: Hands): void;
  showNeedle(step: number | null): void;
  slideNeedle(from: number, to: number | null, frac: number): void;
  markStep(step: number, outcome: StepOutcome | null, score?: number | null): void;
  flashWrong(step: number, attempts: number): void;
  clearMarks(): void;
  markShort(step: number): void;
  markLong?(step: number): void;
}

export type FollowState = 'off' | 'countin' | 'following' | 'done';

export interface FollowStatus {
  state: FollowState;
  mode: FollowMode;
  step: number;
  total: number;
  wrong: number;
  missed: number;
  cycle: number;
  countIn: number | null;
  counts: PracticeCounts | null;
  bpm: number | null;
  percent: number | null;
  rampReached: boolean;
}

export interface FollowerDeps {
  createWaitMatcher(steps: readonly MatchStep[]): WaitMatcher;
  createLiveMatcher(steps: readonly LiveStep[], opts: LiveOptions): LiveMatcher;
  practicePlan(timeline: readonly PlanSourceStep[], opts: PlanOptions): PracticePlan;
  createTempoMap(changes: readonly TempoChange[], scale?: number, fallbackBpm?: number): TempoMap;
  createHoldChecker(opts: HoldOptions): HoldChecker;
}

export type FollowRecord =
  | { kind: 'note'; step: number; cycle: number; note: number; dtMs: number | null; at: number }
  | { kind: 'wrong'; step: number; cycle: number; note: number; at: number }
  | {
      kind: 'step';
      step: number;
      cycle: number;
      outcome: StepOutcome;
      dtMs: number | null;
      score?: number | null;
      matchedNotes: number;
      missedNotes: number;
      at: number;
    }
  | {
      kind: 'hold';
      step: number;
      cycle: number;
      note: number;
      heldMs: number;
      expectedMs: number;
      short: boolean;
      long?: boolean;
      staccato?: true;
      at: number;
    }
  | { kind: 'cycle'; cycle: number; at: number }
  | { kind: 'tempo'; cycle: number; percent: number; at: number };

export interface Follower {
  start(opts: FollowOptions): void;
  stop(): void;
  handle(ev: LiveEvent): void;
  tick(): void;
  status(): FollowStatus;
  onStatus(fn: (s: FollowStatus) => void): () => void;
  onResult(fn: (r: FollowRecord) => void): () => void;
  plan(): PracticePlan | null;
  startTime(): number | null;
  options(): FollowOptions | null;
  reset(): void;
  tempo(): TempoMap | null;
  dropHolds(): void;
  pedal(source?: LiveSource): boolean;
  cycleTiming(cycle: number): { start: number; scale: number } | null;
}

function freshCounts(mode: FollowMode, bpm: number | null, startedAt: number): PracticeCounts {
  return {
    mode,
    bpm,
    expectedNotes: 0,
    correctNotes: 0,
    wrongNotes: 0,
    missedNotes: 0,
    hitSteps: 0,
    earlySteps: 0,
    lateSteps: 0,
    missedSteps: 0,
    offsetSumMs: 0,
    offsetCount: 0,
    firstHitAt: null,
    lastHitAt: null,
    firstHitQ: null,
    lastHitQ: null,
    cycles: 0,
    startedAt,
    endedAt: null,
    bpmMin: null,
    bpmMax: null,
    shortNotes: 0,
    longNotes: 0,
    holdChecked: 0,
    timingScoreSum: 0,
    timingScoreCount: 0,
  };
}

export function createFollower(o: {
  view: FollowView;
  now: () => number;
  deps: FollowerDeps;
}): Follower {
  const { view, now, deps } = o;
  let state: FollowState = 'off';
  let opts: FollowOptions | null = null;
  let plan: PracticePlan | null = null;
  let waitMatcher: WaitMatcher | null = null;
  let liveMatcher: LiveMatcher | null = null;
  let counts: PracticeCounts | null = null;
  let cycle = 1;
  let countIn: number | null = null;
  let liveStep = 0;
  let lastPosStep = -1;
  let t0: number | null = null;
  let tempo: TempoMap | null = null;
  let holds: HoldChecker | null = null;
  const pedals: Record<LiveSource, boolean> = { engine: false, keyboard: false, autoplay: false };
  let lastSource: LiveSource | null = null;
  function effectivePedal(): boolean {
    return lastSource === null ? pedals.engine || pedals.keyboard : pedals[lastSource];
  }
  let paces: number[] = [];
  let waitOnset: number | null = null;
  let prevOnset: { at: number; time: number } | null = null;
  let ramp: Ramp | null = null;
  let startPercent = 100;
  let lastPercent = 100;
  let percents = new Map<number, number>();
  let badCycles = new Set<number>();
  let judged = 0;
  let pendingBad = 0;
  let rampDirty = false;
  let shownRaw: number[] = [];
  const listeners = new Set<(s: FollowStatus) => void>();
  const resultListeners = new Set<(r: FollowRecord) => void>();

  const src = (i: number): number => plan!.steps[i].source;

  function addScore(c: PracticeCounts, score: number | null): void {
    if (score === null) return;
    c.timingScoreSum = (c.timingScoreSum ?? 0) + score;
    c.timingScoreCount = (c.timingScoreCount ?? 0) + 1;
  }

  // Wait mode: the onset is measured against the previous step's onset plus the written
  // gap at the Tempo slider pace (the first step of a run or loop has no reference).
  function waitOffset(i: number, onset: number): number | null {
    const time = plan!.steps[i].time;
    const prev = prevOnset;
    prevOnset = { at: onset, time };
    if (prev === null || !tempo || !(time > prev.time)) return null;
    return Math.round(onset - (prev.at + (tempo.msAt(time) - tempo.msAt(prev.time)) / scaleOf(cycle)));
  }

  function scaleOf(c: number): number {
    return ramp ? (percents.get(c) ?? lastPercent) / startPercent : 1;
  }

  function resetRamp(sp: number): void {
    ramp = null;
    startPercent = sp;
    lastPercent = sp;
    percents = new Map([[1, sp]]);
    badCycles = new Set();
    judged = 0;
    pendingBad = 0;
    rampDirty = false;
    shownRaw = [];
  }

  function markBad(c: number): void {
    if (!ramp) return;
    if (c <= judged) {
      if (!badCycles.has(c)) {
        badCycles.add(c);
        pendingBad++;
      }
    } else badCycles.add(c);
  }

  function decide(n: number): number {
    if (badCycles.has(n - 1)) pendingBad++;
    const clean = pendingBad === 0;
    if (pendingBad > 0) pendingBad--;
    judged = Math.max(judged, n - 1);
    const p = ramp!.next(clean);
    lastPercent = p;
    percents.set(n, p);
    const c = counts!;
    c.ramp = { ...c.ramp!, percent: p, topPercent: Math.max(c.ramp!.topPercent, p) };
    if (shownRaw.length > 0) {
      c.bpmMin = Math.min(c.bpmMin ?? Infinity, Math.round((Math.min(...shownRaw) * p) / startPercent));
      c.bpmMax = Math.max(c.bpmMax ?? -Infinity, Math.round((Math.max(...shownRaw) * p) / startPercent));
    }
    emitResult({ kind: 'tempo', cycle: n, percent: p, at: now() });
    rampDirty = true;
    return p;
  }

  function expectedMs(i: number, note: number, c = 1): number {
    const st = plan!.steps[i];
    const j = st.pitches.indexOf(note);
    let len = j >= 0 ? (st.lengths?.[j] ?? 0) : 0;
    if (!(len > 0) || !tempo) return 0;
    for (let k = i + 1; k < plan!.steps.length; k++) {
      if (plan!.steps[k].pitches.includes(note)) {
        len = Math.min(len, plan!.steps[k].time - st.time);
        break;
      }
    }
    if (!(len > 0)) return 0;
    return (tempo.msAt(st.time + len) - tempo.msAt(st.time)) / scaleOf(c);
  }

  function isStaccato(i: number, note: number): boolean {
    const st = plan!.steps[i];
    const j = st.pitches.indexOf(note);
    return j >= 0 && st.staccato?.[j] === true;
  }

  function status(): FollowStatus {
    const total = plan ? plan.steps.length : 0;
    const mode: FollowMode = opts ? opts.mode : 'wait';
    let step = 0;
    if (mode === 'wait') step = waitMatcher ? Math.min(waitMatcher.current(), total) : 0;
    else step = liveStep;
    const percent = ramp ? Math.round((percents.get(cycle) ?? lastPercent) * 10) / 10 : null;
    return {
      state,
      mode,
      step,
      total,
      wrong: counts ? counts.wrongNotes : 0,
      missed: counts ? counts.missedNotes : 0,
      cycle,
      countIn,
      counts: counts ? { ...counts } : null,
      bpm:
        mode === 'live' && plan !== null && plan.steps.length > 0 && tempo !== null && (state !== 'off' || counts !== null)
          ? Math.round(
                tempo.bpmAt(plan.steps[state === 'done' ? plan.steps.length - 1 : Math.min(liveStep, plan.steps.length - 1)].time) *
                  scaleOf(cycle),
              )
          : null,
      percent,
      rampReached: ramp !== null && percent !== null && percent >= opts!.ramp!.targetPercent,
    };
  }

  function emit(): void {
    for (const fn of [...listeners]) {
      try {
        fn(status());
      } catch (err) {
        console.error(err);
      }
    }
  }

  function emitResult(r: FollowRecord): void {
    for (const fn of [...resultListeners]) {
      try {
        fn(r);
      } catch (err) {
        console.error(err);
      }
    }
  }

  function applyLive(results: LiveResult[]): boolean {
    const c = counts!;
    let changed = false;
    for (const r of results) {
      switch (r.kind) {
        case 'accepted':
          holds?.press(r.note, now(), r.step, r.cycle, expectedMs(r.step, r.note, r.cycle), isStaccato(r.step, r.note));
          emitResult({ kind: 'note', step: r.step, cycle: r.cycle, note: r.note, dtMs: r.dtMs, at: now() });
          break;
        case 'outcome':
          if (r.outcome === 'missed') markBad(r.cycle);
          if (r.cycle >= cycle) view.markStep(src(r.step), r.outcome, r.score);
          addScore(c, r.score);
          c.correctNotes += r.matchedNotes;
          c.missedNotes += r.missedNotes;
          c.expectedNotes += r.matchedNotes + r.missedNotes;
          if (r.outcome === 'hit') c.hitSteps++;
          else if (r.outcome === 'early') c.earlySteps++;
          else if (r.outcome === 'late') c.lateSteps++;
          else c.missedSteps++;
          if (r.dtMs !== null) {
            c.offsetSumMs += r.dtMs;
            c.offsetCount++;
          }
          emitResult({
            kind: 'step',
            step: r.step,
            cycle: r.cycle,
            outcome: r.outcome,
            dtMs: r.dtMs,
            score: r.score,
            matchedNotes: r.matchedNotes,
            missedNotes: r.missedNotes,
            at: now(),
          });
          changed = true;
          break;
        case 'wrong':
          markBad(r.cycle);
          c.wrongNotes++;
          if (r.cycle >= cycle) view.flashWrong(src(r.step), r.attempts);
          emitResult({ kind: 'wrong', step: r.step, cycle: r.cycle, note: r.note, at: now() });
          changed = true;
          break;
        case 'cycle':
          cycle = r.cycle;
          c.cycles = r.cycle - 1;
          view.clearMarks();
          emitResult({ kind: 'cycle', cycle: r.cycle, at: now() });
          changed = true;
          break;
        case 'done':
          state = 'done';
          c.endedAt = now();
          view.showNeedle(null);
          changed = true;
          break;
      }
    }
    return changed;
  }

  function newWaitMatcher(): void {
    waitMatcher = deps.createWaitMatcher(plan!.steps);
  }

  function handleWait(ev: LiveEvent): boolean {
    const c = counts!;
    let changed = false;
    for (const r of waitMatcher!.handle(ev)) {
      switch (r.kind) {
        case 'accepted':
          if (waitOnset === null) waitOnset = now();
          holds?.press(r.note, now(), r.step, cycle, expectedMs(r.step, r.note, cycle), isStaccato(r.step, r.note));
          emitResult({ kind: 'note', step: r.step, cycle, note: r.note, dtMs: null, at: now() });
          break;
        case 'wrong':
          markBad(cycle);
          c.wrongNotes++;
          view.flashWrong(src(r.step), r.attempts);
          emitResult({ kind: 'wrong', step: r.step, cycle, note: r.note, at: now() });
          changed = true;
          break;
        case 'hit': {
          const step = plan!.steps[r.step];
          const n = step.pitches.length;
          c.correctNotes += n;
          c.expectedNotes += n;
          c.hitSteps++;
          const t = now();
          const q = (cycle - 1) * plan!.lengthQuarters + step.time;
          const sample = paceSample(c.lastHitAt, c.lastHitQ, t, q);
          if (sample !== null) paces.push(sample);
          c.paceBpm = medianPaceBpm(paces);
          if (c.firstHitAt === null) {
            c.firstHitAt = t;
            c.firstHitQ = q;
          }
          c.lastHitAt = t;
          c.lastHitQ = q;
          const dt = waitOffset(r.step, waitOnset ?? t);
          waitOnset = null;
          const score = timingScore(dt, opts!.timing ?? DEFAULT_CURVE);
          addScore(c, score);
          view.markStep(step.source, 'hit', null);
          emitResult({
            kind: 'step',
            step: r.step,
            cycle,
            outcome: 'hit',
            dtMs: dt,
            score,
            matchedNotes: n,
            missedNotes: 0,
            at: t,
          });
          changed = true;
          break;
        }
        case 'advance':
          view.showNeedle(src(r.step));
          changed = true;
          break;
        case 'done':
          if (opts!.loop) {
            if (ramp) decide(cycle + 1);
            cycle++;
            emitResult({ kind: 'cycle', cycle, at: now() });
            c.cycles++;
            newWaitMatcher();
            prevOnset = null;
            waitOnset = null;
            view.clearMarks();
            view.showNeedle(src(0));
          } else {
            state = 'done';
            c.endedAt = now();
            view.showNeedle(null);
          }
          changed = true;
          break;
      }
    }
    return changed;
  }

  return {
    start(o2) {
      opts = o2;
      plan = deps.practicePlan(view.timeline(), { hands: o2.hands, range: o2.range, loop: o2.loop });
      const live = o2.mode === 'live';
      tempo =
        plan.tempo && plan.tempo.length > 0
          ? deps.createTempoMap(plan.tempo, (o2.percent ?? 100) / 100)
          : deps.createTempoMap([{ q: 0, bpm: o2.bpm }]);
      const startBpm = tempo.bpmAt(0);
      counts = freshCounts(o2.mode, live ? Math.round(startBpm) : null, now());
      const shownRawNow = tempo
        .changes()
        .filter((c) => c.q === 0 || c.q < plan!.lengthQuarters)
        .map((c) => c.bpm);
      const shown = shownRawNow.map((b) => Math.round(b));
      if (shown.length > 0) {
        counts.bpmMin = Math.min(...shown);
        counts.bpmMax = Math.max(...shown);
      }
      resetRamp(o2.percent ?? 100);
      shownRaw = shownRawNow;
      if (o2.loop && o2.ramp) {
        ramp = createRamp(startPercent, o2.ramp);
        counts.ramp = {
          startPercent,
          percent: startPercent,
          topPercent: startPercent,
          targetPercent: o2.ramp.targetPercent,
        };
      }
      holds = o2.holds ? deps.createHoldChecker(o2.holds) : null;
      lastSource = null;
      paces = [];
      holds?.sustain(effectivePedal());
      cycle = 1;
      countIn = null;
      liveStep = 0;
      lastPosStep = -1;
      t0 = null;
      waitOnset = null;
      prevOnset = null;
      waitMatcher = null;
      liveMatcher = null;
      view.clearMarks();
      view.setFollowing(true, o2.hands);
      if (plan.steps.length === 0) {
        state = 'done';
        view.showNeedle(null);
        counts.endedAt = now();
      } else if (!live) {
        newWaitMatcher();
        state = 'following';
        view.showNeedle(src(0));
        t0 = now();
      } else {
        const mpq = 60000 / startBpm;
        liveMatcher = deps.createLiveMatcher(plan.steps, {
          msPerQuarter: mpq,
          tempo,
          windowMs: o2.windowMs,
          onTimeMs: o2.onTimeMs,
          timing: o2.timing,
          loopQuarters: o2.loop ? plan.lengthQuarters : null,
          ...(ramp ? { cycleScale: (n: number) => decide(n) / startPercent } : {}),
        });
        t0 = now() + o2.countInBeats * o2.beatQuarters * mpq;
        liveMatcher.start(t0);
        if (o2.countInBeats > 0) {
          state = 'countin';
          countIn = o2.countInBeats;
        } else {
          state = 'following';
        }
        view.showNeedle(src(0));
      }
      emit();
    },
    stop() {
      if (state === 'off') return;
      const active = state === 'countin' || state === 'following';
      state = 'off';
      countIn = null;
      if (active) counts!.endedAt = now();
      view.setFollowing(false, opts!.hands);
      emit();
    },
    handle(ev) {
      if (ev.type === 'sustain') pedals[ev.source] = ev.on;
      if (ev.type === 'note_on' && ev.velocity > 0) lastSource = ev.source;
      if (state !== 'countin' && state !== 'following') return;
      let changed = false;
      if (holds) {
        if (ev.type === 'sustain') {
          holds.sustain(effectivePedal());
        } else if (ev.type === 'note_off' || (ev.type === 'note_on' && !(ev.velocity > 0))) {
          holds.sustain(pedals[ev.source]);
          const r = holds.release(ev.note, now());
          if (r) {
            emitResult({
              kind: 'hold',
              step: r.step,
              cycle: r.cycle,
              note: r.note,
              heldMs: r.heldMs,
              expectedMs: r.expectedMs,
              short: r.short,
              long: r.long,
              ...(r.staccato ? { staccato: true as const } : {}),
              at: now(),
            });
            counts!.holdChecked = (counts!.holdChecked ?? 0) + 1;
            if (r.short) {
              counts!.shortNotes = (counts!.shortNotes ?? 0) + 1;
              if (r.cycle >= cycle) view.markShort(src(r.step));
            }
            if (r.long) {
              counts!.longNotes = (counts!.longNotes ?? 0) + 1;
              if (r.cycle >= cycle) view.markLong?.(src(r.step));
            }
            changed = true;
          }
        } else if (ev.type === 'note_on') {
          holds.sustain(effectivePedal());
        }
      }
      if (opts!.mode === 'wait') {
        if (handleWait(ev)) changed = true;
      } else if (ev.type === 'note_on' && ev.velocity > 0) {
        if (applyLive(liveMatcher!.press(ev.note, now()))) changed = true;
      }
      if (changed || rampDirty) {
        rampDirty = false;
        emit();
      }
    },
    tick() {
      if (!opts || opts.mode !== 'live' || !liveMatcher) return;
      if (state !== 'countin' && state !== 'following') return;
      const n = now();
      const prevState = state;
      const prevCountIn = countIn;
      const prevStep = liveStep;
      const prevCycle = cycle;
      if (state === 'countin') {
        const beatMs = (opts.beatQuarters * 60000) / tempo!.bpmAt(0);
        if (n >= t0!) {
          state = 'following';
          countIn = null;
        } else {
          countIn = Math.max(1, Math.ceil((t0! - n) / beatMs));
        }
      }
      const changed = applyLive(liveMatcher.tick(n));
      if (state === 'countin' || state === 'following') {
        const pos = liveMatcher.position(n);
        if (pos.step >= 0) {
          if (opts.slide) {
            view.slideNeedle(src(pos.step), pos.next === null ? null : src(pos.next), pos.frac);
          } else if (pos.step !== lastPosStep) {
            view.showNeedle(src(pos.step));
          }
          lastPosStep = pos.step;
        }
        liveStep = Math.max(pos.step, 0);
      }
      if (
        changed ||
        rampDirty ||
        state !== prevState ||
        countIn !== prevCountIn ||
        liveStep !== prevStep ||
        cycle !== prevCycle
      ) {
        rampDirty = false;
        emit();
      }
    },
    status,
    onStatus(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    onResult(fn) {
      resultListeners.add(fn);
      return () => {
        resultListeners.delete(fn);
      };
    },
    plan: () => plan,
    startTime: () => t0,
    options: () => opts,
    reset() {
      if (state !== 'off' && opts) view.setFollowing(false, opts.hands);
      state = 'off';
      opts = null;
      plan = null;
      waitMatcher = null;
      liveMatcher = null;
      counts = null;
      tempo = null;
      holds = null;
      paces = [];
      t0 = null;
      cycle = 1;
      countIn = null;
      liveStep = 0;
      lastPosStep = -1;
      resetRamp(100);
      emit();
    },
    tempo: () => tempo,
    cycleTiming(n) {
      if (!opts || opts.mode !== 'live' || !liveMatcher) return null;
      const r = liveMatcher.cycleTiming(n);
      if (rampDirty) {
        rampDirty = false;
        emit();
      }
      return r;
    },
    dropHolds() {
      holds?.clear();
    },
    pedal: (source) => (source ? pedals[source] : effectivePedal()),
  };
}

export function followButtonLabel(state: FollowState): string {
  if (state === 'following' || state === 'countin') return 'Stop';
  if (state === 'done') return 'Restart';
  return 'Follow';
}

export function followStatusText(s: FollowStatus): string {
  if (s.state === 'off') return '';
  if (s.state === 'countin') return `Count-in ${s.countIn ?? ''}`;
  const tail = (s.wrong > 0 ? `, ${s.wrong} wrong` : '') + (s.mode === 'live' && s.missed > 0 ? `, ${s.missed} missed` : '');
  if (s.state === 'following') {
    const head =
      typeof s.percent === 'number'
        ? `Loop ${s.cycle} · ${s.percent}%` + (s.rampReached ? ' · Target reached' : '') + ' · '
        : s.cycle > 1
          ? `Loop ${s.cycle} · `
          : '';
    return head + `${s.step + 1}/${s.total}` + tail;
  }
  if (s.total === 0) return 'No notes to follow';
  return 'Done' + tail;
}
