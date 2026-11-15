import { DEFAULT_CURVE, outcomeOf, timingScore, type TimingCurve } from './timing-score.ts';

export interface LiveStep {
  pitches: readonly number[];
  time: number;
}

export interface LiveOptions {
  msPerQuarter: number;
  windowMs: number;
  onTimeMs: number;
  loopQuarters: number | null;
  cycleScale?: (cycle: number) => number;
  timing?: TimingCurve;
  tempo?: { msAt(q: number): number; quartersAt(ms: number): number };
}

export type LiveOutcome = 'hit' | 'early' | 'late' | 'missed';

export type LiveResult =
  | { kind: 'accepted'; step: number; cycle: number; note: number; dtMs: number }
  | {
      kind: 'outcome';
      step: number;
      cycle: number;
      outcome: LiveOutcome;
      dtMs: number | null;
      score: number | null;
      matchedNotes: number;
      missedNotes: number;
    }
  | { kind: 'wrong'; step: number; cycle: number; note: number; attempts: number }
  | { kind: 'cycle'; cycle: number }
  | { kind: 'done' };

export interface LivePosition {
  cycle: number;
  step: number;
  next: number | null;
  frac: number;
}

export interface LiveMatcher {
  start(t0: number): void;
  press(note: number, now: number): LiveResult[];
  tick(now: number): LiveResult[];
  position(now: number): LivePosition;
  done(): boolean;
  cycleTiming(cycle: number): { start: number; scale: number } | null;
}

interface Occurrence {
  c: number;
  k: number;
  T: number;
  total: number;
  pending: Set<number>;
  dts: number[];
  closed: boolean;
}

export function createLiveMatcher(steps: readonly LiveStep[], opts: LiveOptions): LiveMatcher {
  const n = steps.length;
  const mpq = opts.msPerQuarter;
  const L = opts.loopQuarters;
  const msOf = (q: number) => (opts.tempo ? opts.tempo.msAt(q) : q * mpq);
  const qOf = (ms: number) => (opts.tempo ? opts.tempo.quartersAt(ms) : ms / mpq);
  const loopMs = L === null ? 0 : msOf(L);
  let scales: number[] = [1];
  let starts: number[] = [0];
  const scaleAt = (c: number) => {
    while (scales.length <= c) {
      const v = opts.cycleScale ? opts.cycleScale(scales.length + 1) : 1;
      scales.push(Number.isFinite(v) && v > 0 ? v : 1);
    }
    return scales[c];
  };
  const startAt = (c: number) => {
    if (!opts.cycleScale) return c * loopMs;
    while (starts.length <= c) {
      const k = starts.length;
      starts.push(starts[k - 1] + loopMs / scaleAt(k - 1));
    }
    return starts[c];
  };
  const cycleIndexAt = (e: number) => {
    if (L === null || e < 0) return 0;
    if (!opts.cycleScale) return Math.max(0, Math.floor(e / loopMs));
    let c = 0;
    while (startAt(c + 1) <= e) c++;
    return c;
  };
  let started = false;
  let finished = false;
  let t0 = 0;
  let occ: Occurrence[] = [];
  let genC = 0;
  let genK = 0;
  let announced = 1;
  let closedCount = 0;
  const attempts = new Map<string, number>();

  const push = (out: LiveResult[], r: LiveResult) => {
    if (L !== null && (r.kind === 'accepted' || r.kind === 'outcome' || r.kind === 'wrong')) {
      while (announced < r.cycle) {
        announced += 1;
        out.push({ kind: 'cycle', cycle: announced });
      }
    }
    out.push(r);
  };

  const generate = (now: number) => {
    if (n === 0) return;
    for (;;) {
      if (L === null && genK >= n) return;
      if (L !== null && t0 + startAt(genC) > now + opts.windowMs) return;
      const T =
        L === null
          ? t0 + msOf(steps[genK].time)
          : t0 + startAt(genC) + msOf(steps[genK].time) / scaleAt(genC);
      if (T > now + opts.windowMs) return;
      occ.push({
        c: genC,
        k: genK,
        T,
        total: steps[genK].pitches.length,
        pending: new Set(steps[genK].pitches),
        dts: [],
        closed: false,
      });
      genK += 1;
      if (genK >= n && L !== null) {
        genK = 0;
        genC += 1;
      }
    }
  };

  const closeExpired = (now: number, out: LiveResult[]) => {
    for (const o of occ) {
      if (o.closed || !(now > o.T + opts.windowMs)) continue;
      o.closed = true;
      closedCount += 1;
      push(out, {
        kind: 'outcome',
        step: o.k,
        cycle: o.c + 1,
        outcome: 'missed',
        dtMs: null,
        score: null,
        matchedNotes: o.total - o.pending.size,
        missedNotes: o.pending.size,
      });
    }
  };

  const checkDone = (out: LiveResult[]) => {
    if (L === null && !finished && closedCount === n) {
      finished = true;
      out.push({ kind: 'done' });
    }
  };

  return {
    start(t: number) {
      started = true;
      finished = false;
      t0 = t;
      occ = [];
      scales = [1];
      starts = [0];
      genC = 0;
      genK = 0;
      announced = 1;
      closedCount = 0;
      attempts.clear();
    },
    press(note, now) {
      if (!started || finished) return [];
      const out: LiveResult[] = [];
      generate(now);
      closeExpired(now, out);
      let best: Occurrence | null = null;
      for (const o of occ) {
        if (o.closed || !o.pending.has(note)) continue;
        const d = Math.abs(now - o.T);
        if (d > opts.windowMs) continue;
        if (best === null || d < Math.abs(now - best.T)) best = o;
      }
      if (best !== null) {
        best.pending.delete(note);
        const dt = Math.round(now - best.T);
        best.dts.push(dt);
        push(out, { kind: 'accepted', step: best.k, cycle: best.c + 1, note, dtMs: dt });
        if (best.pending.size === 0) {
          best.closed = true;
          closedCount += 1;
          const mean = Math.round(best.dts.reduce((a, b) => a + b, 0) / best.dts.length);
          const outcome: LiveOutcome = outcomeOf(mean, opts.onTimeMs);
          push(out, {
            kind: 'outcome',
            step: best.k,
            cycle: best.c + 1,
            outcome,
            dtMs: mean,
            score: timingScore(mean, opts.timing ?? DEFAULT_CURVE),
            matchedNotes: best.total,
            missedNotes: 0,
          });
        }
      } else {
        const e = now - t0;
        const c = cycleIndexAt(e);
        const qc = L !== null ? qOf((e - startAt(c)) * scaleAt(c)) : qOf(e);
        let k = 0;
        for (let i = 1; i < n; i++) {
          if (Math.abs(steps[i].time - qc) < Math.abs(steps[k].time - qc)) k = i;
        }
        const key = `${c}:${k}`;
        const a = (attempts.get(key) ?? 0) + 1;
        attempts.set(key, a);
        push(out, { kind: 'wrong', step: k, cycle: c + 1, note, attempts: a });
      }
      checkDone(out);
      return out;
    },
    tick(now) {
      if (!started || finished) return [];
      const out: LiveResult[] = [];
      generate(now);
      closeExpired(now, out);
      if (L !== null) {
        for (let c = 1; now >= t0 + startAt(c); c++) {
          if (c + 1 > announced) {
            announced = c + 1;
            out.push({ kind: 'cycle', cycle: c + 1 });
          }
        }
      }
      checkDone(out);
      return out;
    },
    position(now) {
      const e = now - t0;
      if (e < 0) return { cycle: 1, step: -1, next: n > 0 ? 0 : null, frac: 0 };
      const c = cycleIndexAt(e);
      const qc = L !== null ? qOf((e - startAt(c)) * scaleAt(c)) : qOf(e);
      let step = -1;
      for (let i = 0; i < n; i++) if (steps[i].time <= qc) step = i;
      const next = step + 1 < n ? step + 1 : null;
      let frac = 0;
      if (step >= 0 && next !== null) {
        const span = steps[next].time - steps[step].time;
        frac = Math.min(1, Math.max(0, (qc - steps[step].time) / span));
      }
      return { cycle: c + 1, step, next, frac };
    },
    done() {
      return finished;
    },
    cycleTiming(cycle) {
      if (L === null || !started || cycle < 1) return null;
      return { start: t0 + startAt(cycle - 1), scale: scaleAt(cycle - 1) };
    },
  };
}
