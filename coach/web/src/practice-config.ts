import type { FollowerSettings } from './follower-settings';
import type { FollowOptions } from './follower';
import type { BarRange, Hands, PracticePlan } from './practice-steps';
import type { AutoStep, AutoplayKnobs } from './autoplay';

export interface ScoreInfoLike {
  tempoBpm: number | null;
  beats: number;
  beatType: number;
}

export interface PracticeUi {
  mode: 'wait' | 'live';
  hands: Hands;
  percent: number;
  loop: boolean;
  autoplay: boolean;
  ramp?: boolean;
  rampTarget?: number | null;
}

export function followOptions(
  s: FollowerSettings,
  ui: PracticeUi,
  info: ScoreInfoLike | null,
  range: BarRange | null,
  bpm: number,
): FollowOptions {
  return {
    mode: ui.mode,
    hands: ui.hands,
    range,
    loop: ui.loop,
    bpm,
    percent: ui.percent,
    holds: (ui.mode === 'live' ? s.holds.live : s.holds.wait)
      ? { minPercent: s.holds.minPercent, minNoteMs: s.holds.minNoteMs, pedal: s.holds.pedal, staccatoMaxPercent: s.holds.staccatoMaxPercent }
      : null,
    countInBeats: ui.mode === 'live' ? s.countIn.bars * (info?.beats ?? 4) : 0,
    beatQuarters: 4 / (info?.beatType ?? 4),
    windowMs: s.live.windowMs,
    onTimeMs: s.live.onTimeMs,
    slide: s.live.needleSlide,
    timing: { perfectMs: s.timing.perfectMs, zeroMs: s.timing.zeroMs, curve: s.timing.curve },
    ramp:
      ui.loop && ui.ramp
        ? {
            stepPercent: s.ramp.stepPercent,
            targetPercent: Math.min(ui.rampTarget ?? s.ramp.targetPercent, s.tempo.maxPercent),
            backAfterBad: s.ramp.backAfterBad,
          }
        : null,
  };
}

export function countInClicks(
  t0: number,
  countInBeats: number,
  beatMs: number,
  beatsPerBar: number,
): { at: number; accent: boolean }[] {
  const out: { at: number; accent: boolean }[] = [];
  for (let k = 0; k < countInBeats; k++) {
    out.push({ at: t0 - (countInBeats - k) * beatMs, accent: k % beatsPerBar === 0 });
  }
  return out;
}

export function rangeText(range: BarRange | null, loop: boolean): string {
  if (!range) return '';
  if (range.from === range.to) return (loop ? 'Bar ' : 'From bar ') + range.from;
  return `Bars ${range.from}-${range.to}`;
}

export function barsText(range: BarRange | null, loop: boolean): string {
  return range ? rangeText(range, loop) : 'All';
}

export function autoplaySlice(plan: PracticePlan, fromStep: number): { steps: AutoStep[]; lengthQuarters: number } {
  if (fromStep < 0 || fromStep >= plan.steps.length) return { steps: [], lengthQuarters: 0 };
  const t = plan.steps[fromStep].time;
  return {
    steps: plan.steps.slice(fromStep).map((p) => ({
      pitches: p.pitches,
      time: p.time - t,
      ...(p.lengths ? { lengths: p.lengths } : {}),
      ...(p.staccato ? { staccato: p.staccato } : {}),
    })),
    lengthQuarters: plan.lengthQuarters - t,
  };
}

export function autoplayKnobs(s: FollowerSettings): AutoplayKnobs {
  const a = s.autoplay;
  return {
    velocity: a.velocity,
    gatePercent: a.gatePercent,
    staccatoGatePercent: a.staccatoGatePercent,
    offsetMs: a.offsetMs,
    jitterMs: a.jitterMs,
    skipEvery: a.skipEvery,
    wrongEvery: a.wrongEvery,
    shortEvery: a.shortEvery,
    seed: a.seed,
  };
}

export function shiftedMsAt(msAt: (q: number) => number, fromQ: number): (q: number) => number {
  return (q) => msAt(q + fromQ) - msAt(fromQ);
}
