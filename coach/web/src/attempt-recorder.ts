import type { LiveEvent, LiveSource } from './engine-socket';
import type { FollowMode, FollowOptions, FollowRecord } from './follower';
import type { Hands, PracticePlan } from './practice-steps';
import type { MetricTexts, PracticeCounts } from './practice-metrics';
import type { FollowerSettings } from './follower-settings';

export const ATTEMPT_VERSION = 2;
export const ATTEMPT_KIND = 'rusty_piano.attempt';

export interface AttemptDrill {
  drill_id: string | null;
  plan_id: string | null;
  tags: string[];
}

export interface AttemptStart {
  score: { id: string; title: string | null; composer: string | null };
  options: FollowOptions;
  plan: PracticePlan;
  timeline: readonly { bar: number; beat: number; pass?: number }[];
  settings: FollowerSettings;
  startedWall: string;
  pageStartMs: number;
  t0Ms: number | null;
  pedalDown: boolean;
  autoplayOn: boolean;
  drill?: AttemptDrill | null;
}

export interface AttemptEnd {
  end: 'done' | 'stop' | 'interrupted';
  endedWall: string;
  endedPageMs: number;
  counts: PracticeCounts;
  metrics: MetricTexts | { accuracy: string; tempo: string; wrong: string; missed: string };
  rows: [string, string][];
}

export interface AttemptStep {
  cycle: number;
  step: number;
  source_step: number;
  bar: number;
  beat: number;
  pass: number;
  time_q: number;
  expected: number[];
  length_q: number | null;
  result: 'hit' | 'early' | 'late' | 'missed' | 'wrong' | 'short' | 'pending';
  outcome: 'hit' | 'early' | 'late' | 'missed' | null;
  offset_ms: number | null;
  // Graded timing score 0-100 of the step (null: missed, or no reference to measure against).
  // offset_ms stays the raw value; outcome is derivable from it and settings.on_time_ms in live mode.
  timing_score: number | null;
  played: { note: number; offset_ms: number | null; page_ms: number }[];
  wrong: { note: number; page_ms: number }[];
  holds: { note: number; held_ms: number; expected_ms: number; short: boolean; long?: boolean; staccato?: true; page_ms: number }[];
}

export type AttemptEvent =
  | { type: 'note_on'; t: number; page_ms: number; source: LiveSource; note: number; velocity: number }
  | { type: 'note_off'; t: number; page_ms: number; source: LiveSource; note: number }
  | { type: 'sustain'; t: number; page_ms: number; source: LiveSource; on: boolean };

export interface AttemptV1 {
  version: 1;
  kind: 'rusty_piano.attempt';
  score: { id: string; title: string | null; composer: string | null };
  mode: FollowMode;
  end: 'done' | 'stop' | 'interrupted';
  started_at: string;
  ended_at: string;
  duration_ms: number;
  clock: {
    page_start_ms: number;
    t0_ms: number | null;
    first_engine_t: number | null;
    first_engine_page_ms: number | null;
  };
  practice: {
    hands: Hands;
    range: { from: number; to: number } | null;
    loop: boolean;
    loops_completed: number;
    count_in_beats: number;
    beat_quarters: number;
    tempo: {
      percent: number;
      scale: number;
      bpm: number;
      start_bpm: number | null;
      bpm_min: number | null;
      bpm_max: number | null;
      map: { q: number; bpm: number }[];
      ramp?: {
        step_percent: number;
        target_percent: number;
        back_after_bad: number;
        cycles: { cycle: number; percent: number }[];
      } | null;
    };
  };
  plan: { steps_total: number; length_quarters: number; first_bar: number | null; last_bar: number | null };
  settings: {
    window_ms: number;
    on_time_ms: number;
    timing: { perfect_ms: number; zero_ms: number; curve: number; red_score: number; green_score: number };
    holds: { min_percent: number; min_note_ms: number; pedal: boolean; staccato_max_percent?: number } | null;
    follow_repeats: boolean;
    follow_jumps: boolean;
    repeats_after_jump: boolean;
    follow_tempo_changes: boolean;
    fallback_bpm: number;
  };
  autoplay: {
    on_at_start: boolean;
    used: boolean;
    knobs: {
      velocity: number;
      gate_percent: number;
      wait_lead_ms: number;
      offset_ms: number;
      jitter_ms: number;
      skip_every: number;
      wrong_every: number;
      short_every: number;
      seed: number;
    };
  };
  sources: LiveSource[];
  pedal_down_at_start: boolean;
  steps: AttemptStep[];
  events: AttemptEvent[];
  summary: {
    counts: PracticeCounts;
    metrics: MetricTexts | { accuracy: string; tempo: string; wrong: string; missed: string };
    rows: [string, string][];
  };
}

export type AttemptV2 = Omit<AttemptV1, 'version'> & {
  version: 2;
  drill_id: string | null;
  plan_id: string | null;
  tags: string[];
};

export interface AttemptRecorder {
  begin(s: AttemptStart): void;
  event(ev: LiveEvent, pageNowMs: number): void;
  result(r: FollowRecord): void;
  active(): boolean;
  cancel(): void;
  finish(e: AttemptEnd): AttemptV2 | null;
}

interface Run {
  start: AttemptStart;
  events: AttemptEvent[];
  steps: Map<string, AttemptStep>;
  tempos: Map<number, number>;
  firstEngineT: number | null;
  firstEnginePageMs: number | null;
}

const r1 = (x: number): number => Math.round(x * 10) / 10;

function lengthQ(lengths: readonly number[] | undefined): number | null {
  if (!lengths || lengths.length === 0) return null;
  const m = Math.max(...lengths);
  return m > 0 ? Math.round(m * 10000) / 10000 : null;
}

function newStep(start: AttemptStart, cycle: number, step: number): AttemptStep {
  const ps = start.plan.steps[step];
  const src = start.timeline[ps.source];
  return {
    cycle,
    step,
    source_step: ps.source,
    bar: ps.bar,
    beat: src.beat,
    pass: src.pass ?? 1,
    time_q: ps.time,
    expected: [...ps.pitches],
    length_q: lengthQ(ps.lengths),
    result: 'pending',
    outcome: null,
    offset_ms: null,
    timing_score: null,
    played: [],
    wrong: [],
    holds: [],
  };
}

function resultOf(s: AttemptStep): AttemptStep['result'] {
  if (s.outcome === 'missed') return 'missed';
  if (s.wrong.length > 0) return 'wrong';
  if (s.holds.some((h) => h.short)) return 'short';
  if (s.outcome !== null) return s.outcome;
  return 'pending';
}

export function createAttemptRecorder(): AttemptRecorder {
  let run: Run | null = null;

  return {
    begin(s) {
      const drill = s.drill ? { ...s.drill, tags: [...s.drill.tags] } : s.drill;
      const tempos = new Map<number, number>();
      if (s.options.loop && s.options.ramp) tempos.set(1, s.options.percent ?? 100);
      run = { start: { ...s, drill }, events: [], steps: new Map(), tempos, firstEngineT: null, firstEnginePageMs: null };
    },
    event(ev, pageNowMs) {
      if (!run) return;
      const page_ms = r1(pageNowMs - run.start.pageStartMs);
      let out: AttemptEvent;
      if (ev.type === 'note_on') {
        out = { type: 'note_on', t: ev.t, page_ms, source: ev.source, note: ev.note, velocity: ev.velocity };
      } else if (ev.type === 'note_off') {
        out = { type: 'note_off', t: ev.t, page_ms, source: ev.source, note: ev.note };
      } else {
        out = { type: 'sustain', t: ev.t, page_ms, source: ev.source, on: ev.on };
      }
      run.events.push(out);
      if (ev.source === 'engine' && run.firstEngineT === null) {
        run.firstEngineT = ev.t;
        run.firstEnginePageMs = page_ms;
      }
    },
    result(r) {
      if (!run || r.kind === 'cycle') return;
      if (r.kind === 'tempo') {
        if (run.start.options.loop && run.start.options.ramp) run.tempos.set(r.cycle, r.percent);
        return;
      }
      const key = `${r.cycle}:${r.step}`;
      let st = run.steps.get(key);
      if (!st) {
        st = newStep(run.start, r.cycle, r.step);
        run.steps.set(key, st);
      }
      const page_ms = r1(r.at - run.start.pageStartMs);
      if (r.kind === 'note') {
        st.played.push({ note: r.note, offset_ms: r.dtMs === null ? null : r1(r.dtMs), page_ms });
      } else if (r.kind === 'wrong') {
        st.wrong.push({ note: r.note, page_ms });
      } else if (r.kind === 'hold') {
        st.holds.push({
          note: r.note,
          held_ms: r.heldMs,
          expected_ms: r1(r.expectedMs),
          short: r.short,
          ...(r.staccato ? { staccato: true as const, long: r.long } : {}),
          page_ms,
        });
      } else {
        st.outcome = r.outcome;
        st.offset_ms = r.dtMs === null ? null : r1(r.dtMs);
        st.timing_score = r.score ?? null;
      }
    },
    active: () => run !== null,
    cancel() {
      run = null;
    },
    finish(e) {
      const a = run;
      run = null;
      if (!a || a.start.plan.steps.length === 0) return null;
      const s = a.start;
      const o = s.options;
      if (o.mode === 'live' && s.t0Ms !== null && e.endedPageMs < s.t0Ms) return null;
      const k = s.settings.autoplay;
      const pct = o.percent ?? 100;
      const steps = [...a.steps.values()]
        .sort((x, y) => x.cycle - y.cycle || x.step - y.step)
        .map((st) => ({ ...st, result: resultOf(st) }));
      if (steps.every((st) => st.result === 'pending')) return null;
      return {
        version: ATTEMPT_VERSION,
        kind: ATTEMPT_KIND,
        score: { id: s.score.id, title: s.score.title, composer: s.score.composer },
        mode: o.mode,
        end: e.end,
        started_at: s.startedWall,
        ended_at: e.endedWall,
        duration_ms: Math.round(e.endedPageMs - s.pageStartMs),
        clock: {
          page_start_ms: r1(s.pageStartMs),
          t0_ms: s.t0Ms === null ? null : r1(s.t0Ms - s.pageStartMs),
          first_engine_t: a.firstEngineT,
          first_engine_page_ms: a.firstEnginePageMs,
        },
        practice: {
          hands: o.hands,
          range: o.range ? { from: o.range.from, to: o.range.to } : null,
          loop: o.loop,
          loops_completed: e.counts.cycles,
          count_in_beats: o.countInBeats,
          beat_quarters: o.beatQuarters,
          tempo: {
            percent: pct,
            scale: pct / 100,
            bpm: o.bpm,
            start_bpm: e.counts.bpm,
            bpm_min: e.counts.bpmMin ?? null,
            bpm_max: e.counts.bpmMax ?? null,
            map: s.plan.tempo.map((t) => ({ q: t.q, bpm: t.bpm })),
            ramp:
              o.loop && o.ramp
                ? {
                    step_percent: o.ramp.stepPercent,
                    target_percent: o.ramp.targetPercent,
                    back_after_bad: o.ramp.backAfterBad,
                    cycles: [...a.tempos].sort((x, y) => x[0] - y[0]).map(([cycle, percent]) => ({ cycle, percent })),
                  }
                : null,
          },
        },
        plan: {
          steps_total: s.plan.steps.length,
          length_quarters: s.plan.lengthQuarters,
          first_bar: s.plan.firstBar,
          last_bar: s.plan.lastBar,
        },
        settings: {
          window_ms: o.windowMs,
          on_time_ms: o.onTimeMs,
          timing: {
            perfect_ms: o.timing?.perfectMs ?? s.settings.timing.perfectMs,
            zero_ms: o.timing?.zeroMs ?? s.settings.timing.zeroMs,
            curve: o.timing?.curve ?? s.settings.timing.curve,
            red_score: s.settings.timing.redScore,
            green_score: s.settings.timing.greenScore,
          },
          holds: o.holds
            ? {
                min_percent: o.holds.minPercent,
                min_note_ms: o.holds.minNoteMs,
                pedal: o.holds.pedal,
                ...(o.holds.staccatoMaxPercent !== undefined ? { staccato_max_percent: o.holds.staccatoMaxPercent } : {}),
              }
            : null,
          follow_repeats: s.settings.followRepeats,
          follow_jumps: s.settings.followJumps,
          repeats_after_jump: s.settings.repeatsAfterJump,
          follow_tempo_changes: s.settings.tempo.followChanges,
          fallback_bpm: s.settings.tempo.fallbackBpm,
        },
        autoplay: {
          on_at_start: s.autoplayOn,
          used: a.events.some((ev) => ev.source === 'autoplay'),
          knobs: {
            velocity: k.velocity,
            gate_percent: k.gatePercent,
            wait_lead_ms: k.waitLeadMs,
            offset_ms: k.offsetMs,
            jitter_ms: k.jitterMs,
            skip_every: k.skipEvery,
            wrong_every: k.wrongEvery,
            short_every: k.shortEvery,
            seed: k.seed,
          },
        },
        sources: [...new Set(a.events.map((ev) => ev.source))].sort(),
        pedal_down_at_start: s.pedalDown,
        steps,
        events: a.events,
        summary: {
          counts: { ...e.counts },
          metrics: { ...e.metrics },
          rows: e.rows.map((row): [string, string] => [row[0], row[1]]),
        },
        drill_id: s.drill?.drill_id ?? null,
        plan_id: s.drill?.plan_id ?? null,
        tags: [...(s.drill?.tags ?? [])],
      };
    },
  };
}
