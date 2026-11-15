export type Hands = 'both' | 'right' | 'left';

export interface BarRange {
  from: number;
  to: number;
}

export interface PlanSourceStep {
  index: number;
  written: number;
  notes: readonly { midi: number; staff: number; quarters?: number; staccato?: boolean }[];
  bpm?: number;
  bar: number;
  beat: number;
  time: number;
  writtenTime: number;
  measureQuarters: number;
}

export interface PlanStep {
  index: number;
  source: number;
  pitches: number[];
  lengths: number[];
  // Per pitch, true when that note is written staccato; present only when some note in the step is.
  staccato?: boolean[];
  time: number;
  bar: number;
}

export interface PracticePlan {
  steps: PlanStep[];
  tempo: { q: number; bpm: number }[];
  lengthQuarters: number;
  firstBar: number | null;
  lastBar: number | null;
}

export interface PlanOptions {
  hands: Hands;
  range: BarRange | null;
  loop: boolean;
}

export function inHand(staff: number, hands: Hands): boolean {
  if (hands === 'right') return staff === 0;
  if (hands === 'left') return staff >= 1;
  return true;
}

export function practicePlan(timeline: readonly PlanSourceStep[], opts: PlanOptions): PracticePlan {
  const { hands, range, loop } = opts;
  let picked: PlanSourceStep[];
  let useWritten = false;
  if (range === null) {
    picked = [...timeline];
  } else if (range.from === range.to && !loop) {
    const first = timeline.findIndex((s) => s.bar >= range.from);
    picked = first < 0 ? [] : timeline.slice(first);
  } else {
    useWritten = true;
    const seen = new Set<number>();
    picked = [];
    for (const s of timeline) {
      if (seen.has(s.written)) continue;
      seen.add(s.written);
      picked.push(s);
    }
    picked.sort((a, b) => a.written - b.written);
    picked = picked.filter((s) => s.bar >= range.from && s.bar <= range.to);
  }
  const timeOf = (s: PlanSourceStep) => (useWritten ? s.writtenTime : s.time);
  const kept: { s: PlanSourceStep; pitches: number[] }[] = [];
  for (const s of picked) {
    const set = new Set<number>();
    for (const n of s.notes) if (inHand(n.staff, hands)) set.add(n.midi);
    if (set.size === 0) continue;
    kept.push({ s, pitches: [...set].sort((a, b) => a - b) });
  }
  if (kept.length === 0) return { steps: [], lengthQuarters: 0, firstBar: null, lastBar: null, tempo: [] };
  const first = kept[0].s;
  const last = kept[kept.length - 1].s;
  const origin = timeOf(first) - first.beat;
  const tempo: { q: number; bpm: number }[] = [];
  for (const s of picked) {
    if (s.bpm === undefined) continue;
    const q = Math.max(0, timeOf(s) - s.beat - origin);
    const prev = tempo[tempo.length - 1];
    if (prev && prev.bpm === s.bpm) continue;
    if (prev && q <= prev.q) prev.bpm = s.bpm;
    else tempo.push({ q, bpm: s.bpm });
  }
  return {
    tempo,
    steps: kept.map((k, i) => {
      const own = (p: number) => k.s.notes.filter((n) => inHand(n.staff, hands) && n.midi === p);
      const staccato = k.pitches.map((p) => own(p).some((n) => n.staccato === true));
      return {
        index: i,
        source: k.s.index,
        pitches: k.pitches,
        lengths: k.pitches.map((p) => Math.max(0, ...own(p).map((n) => n.quarters ?? 0))),
        ...(staccato.includes(true) ? { staccato } : {}),
        time: timeOf(k.s) - origin,
        bar: k.s.bar,
      };
    }),
    lengthQuarters: timeOf(last) - last.beat + last.measureQuarters - origin,
    firstBar: first.bar,
    lastBar: last.bar,
  };
}
