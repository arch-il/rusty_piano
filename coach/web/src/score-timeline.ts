export interface FractionLike {
  RealValue: number;
}

export interface NoteLike {
  halfTone: number;
  isRest(): boolean;
  Length?: FractionLike;
  NoteTie?: { StartNote: NoteLike; Duration?: FractionLike } | null;
  IsGraceNote?: boolean;
  IsCueNote?: boolean;
  PrintObject?: boolean;
  ParentVoiceEntry?: { Articulations?: readonly { articulationEnum: number }[] } | null;
}

export interface VoiceEntryLike {
  IsGrace: boolean;
  Notes: NoteLike[];
}

export interface StaffEntryLike {
  VoiceEntries: VoiceEntryLike[];
}

export interface ContainerLike {
  Timestamp: FractionLike;
  StaffEntries: (StaffEntryLike | null | undefined)[];
}

export interface RepetitionLike {
  type: number;
  alignment?: number;
  endingIndices?: readonly number[];
  Times?: number;
}

export interface MeasureLike {
  AbsoluteTimestamp: FractionLike;
  VerticalSourceStaffEntryContainers: ContainerLike[];
  Duration?: FractionLike;
  ActiveTimeSignature?: { Numerator: number; Denominator: number };
  FirstRepetitionInstructions?: readonly RepetitionLike[];
  LastRepetitionInstructions?: readonly RepetitionLike[];
  TempoInBPM?: number;
}

export interface SheetLike {
  SourceMeasures: MeasureLike[];
  HasBPMInfo?: boolean;
}

export interface TimelineNote {
  midi: number;
  staff: number;
  ref: unknown;
  quarters: number;
  staccato?: boolean;
}

export interface Step {
  index: number;
  pitches: number[];
  notes: TimelineNote[];
  staves: number[];
  bar: number;
  measureIndex: number;
  beat: number;
  time: number;
  written: number;
  pass: number;
  writtenTime: number;
  measureQuarters: number;
  bpm: number;
}

const round6 = (x: number): number => Math.round(x * 1e6) / 1e6;

export function noteQuarters(note: NoteLike): number {
  const tie = note.NoteTie;
  const f = tie && tie.StartNote === note && tie.Duration ? tie.Duration : note.Length;
  const v = f?.RealValue;
  return v !== undefined && Number.isFinite(v) && v > 0 ? round6(v * 4) : 0;
}

// OSMD ArticulationEnum: staccato = 6, staccatissimo = 7.
const STACCATO_ARTICULATIONS: readonly number[] = [6, 7];

export function isStaccato(note: NoteLike): boolean {
  const arts = note.ParentVoiceEntry?.Articulations;
  return Array.isArray(arts) && arts.some((a) => STACCATO_ARTICULATIONS.includes(a.articulationEnum));
}

export function measureBpms(sheet: SheetLike, fallbackBpm: number, follow: boolean): number[] {
  const measures = sheet.SourceMeasures;
  if (sheet.HasBPMInfo !== true) return measures.map(() => fallbackBpm);
  let prev = fallbackBpm;
  const out: number[] = [];
  for (const m of measures) {
    const t = m.TempoInBPM;
    if (t !== undefined && Number.isFinite(t) && t >= 10 && t <= 400) prev = t;
    out.push(prev);
  }
  return follow ? out : out.map(() => out[0]);
}

export function tempoSummary(steps: readonly { bar: number; bpm: number }[]): string {
  return steps
    .filter((s, i) => i === 0 || s.bpm !== steps[i - 1].bpm)
    .map((s) => `${s.bar}:${Math.round(s.bpm)}`)
    .join(" ");
}

export function midiFromHalfTone(halfTone: number): number {
  return halfTone + 12;
}

function isCounted(note: NoteLike): boolean {
  if (note.isRest()) return false;
  if (note.IsGraceNote === true || note.IsCueNote === true) return false;
  if (note.PrintObject === false) return false;
  if (note.NoteTie && note.NoteTie.StartNote !== note) return false;
  return true;
}

export interface RepeatMarks {
  start: boolean;
  end: boolean;
  times: number;
  endingBegin: number[] | null;
  endingEnd: boolean;
  jump: JumpKind | null;
  segno: boolean;
  coda: boolean;
  toCoda: boolean;
  fine: boolean;
}

export type JumpKind = "dc" | "dcFine" | "dcCoda" | "ds" | "dsFine" | "dsCoda";

const JUMP_KINDS: Record<number, JumpKind> = { 4: "dc", 9: "dcFine", 11: "dcCoda", 5: "ds", 8: "dsFine", 10: "dsCoda" };

export interface PlayOrderOptions {
  jumps?: boolean;
  repeatsAfterJump?: boolean;
}

export function repeatMarks(m: MeasureLike): RepeatMarks {
  const first = m.FirstRepetitionInstructions ?? [];
  const last = m.LastRepetitionInstructions ?? [];
  const back = last.find((r) => r.type === 2);
  const begin = first.find((r) => r.type === 3 && r.alignment === 0);
  const times = back?.Times;
  const all = [...first, ...last];
  const jumpInstr = all.find((r) => JUMP_KINDS[r.type] !== undefined);
  return {
    start: first.some((r) => r.type === 0),
    end: back !== undefined,
    times: times !== undefined && Number.isInteger(times) && times >= 2 ? times : 2,
    endingBegin: begin ? [...new Set(begin.endingIndices ?? [])].sort((x, y) => x - y) : null,
    endingEnd: last.some((r) => r.type === 3 && (r.alignment === 1 || r.alignment === 3)),
    jump: jumpInstr ? JUMP_KINDS[jumpInstr.type] : null,
    segno: all.some((r) => r.type === 13),
    coda: all.some((r) => r.type === 12),
    toCoda: all.some((r) => r.type === 7),
    fine: all.some((r) => r.type === 6),
  };
}

export function playOrder(marks: readonly RepeatMarks[], opts: PlayOrderOptions = {}): number[] {
  const n = marks.length;
  const endingOf: (number[] | undefined)[] = new Array(n);
  const spans: { first: number; last: number; nums: number[] }[] = [];
  for (let i = 0; i < n; i++) {
    const nums = marks[i].endingBegin;
    if (!nums) continue;
    let last = i;
    while (last < n - 1 && !marks[last].endingEnd && !marks[last + 1].endingBegin && !marks[last + 1].start) last++;
    spans.push({ first: i, last, nums });
    for (let k = i; k <= last; k++) endingOf[k] = nums;
  }
  const groupMax = new Map<number, number>();
  const groupLast = new Set<number>();
  for (let s = 0; s < spans.length; ) {
    let e = s;
    while (e + 1 < spans.length && spans[e + 1].first === spans[e].last + 1) e++;
    let max = 0;
    for (let k = s; k <= e; k++) max = Math.max(max, ...spans[k].nums);
    for (let k = s; k <= e; k++) for (let m = spans[k].first; m <= spans[k].last; m++) groupMax.set(m, max);
    groupLast.add(spans[e].last);
    s = e + 1;
  }
  const jumps = opts.jumps ?? true;
  const again = opts.repeatsAfterJump ?? false;
  const order: number[] = [];
  let repStart = 0;
  let pass = 1;
  let i = 0;
  let jumped = false;
  let after: JumpKind | null = null;
  let jumpFrom = -1;
  let codaTaken = false;
  const taken = new Set<number>();
  while (i < n) {
    if (order.length > 16 * n) return marks.map((_, k) => k);
    const m = marks[i];
    if (m.start && !jumped) {
      repStart = i;
      pass = 1;
    }
    jumped = false;
    const E = endingOf[i];
    const skipRepeats = after !== null && !again;
    const p = skipRepeats && E ? (groupMax.get(i) ?? pass) : pass;
    if (E && !E.includes(p)) {
      if (groupLast.has(i)) {
        repStart = i + 1;
        pass = 1;
      }
      i++;
      continue;
    }
    order.push(i);
    if (m.end && !skipRepeats) {
      const total = Math.max(m.times, E ? (groupMax.get(i) ?? 0) : 0);
      if (pass < total) {
        pass++;
        i = repStart;
        jumped = true;
        continue;
      }
    }
    if (m.end) {
      repStart = i + 1;
      pass = 1;
    }
    if (after !== null && m.fine && after !== "dcCoda" && after !== "dsCoda") break;
    if (after !== null && m.toCoda && !codaTaken && after !== "dcFine" && after !== "dsFine") {
      codaTaken = true;
      let k = i + 1;
      while (k < n && !marks[k].coda) k++;
      if (k >= n) k = jumpFrom + 1;
      if (k >= n) break;
      i = k;
      repStart = k;
      pass = 1;
      continue;
    }
    if (jumps && m.jump != null && !taken.has(i)) {
      let target = -1;
      if (m.jump === "dc" || m.jump === "dcFine" || m.jump === "dcCoda") target = 0;
      else
        for (let k = i; k >= 0; k--)
          if (marks[k].segno) {
            target = k;
            break;
          }
      if (target >= 0) {
        taken.add(i);
        after = m.jump;
        jumpFrom = i;
        codaTaken = false;
        i = target;
        repStart = target;
        pass = 1;
        continue;
      }
    }
    if (E && groupLast.has(i)) {
      repStart = i + 1;
      pass = 1;
    }
    i++;
  }
  return order;
}

export function measureQuarters(measures: readonly MeasureLike[], i: number): number {
  const m = measures[i];
  const d = m.Duration?.RealValue;
  if (d !== undefined && Number.isFinite(d) && d > 0) return d * 4;
  const next = measures[i + 1];
  if (next) {
    const diff = (next.AbsoluteTimestamp.RealValue - m.AbsoluteTimestamp.RealValue) * 4;
    if (diff > 0) return diff;
  }
  const ts = m.ActiveTimeSignature;
  if (ts) {
    const q = (ts.Numerator / ts.Denominator) * 4;
    if (q > 0) return q;
  }
  return 4;
}

export function buildTimeline(
  sheet: SheetLike,
  opts: { followRepeats?: boolean; followJumps?: boolean; repeatsAfterJump?: boolean; fallbackBpm?: number; followTempo?: boolean } = {},
): Step[] {
  const measures = sheet.SourceMeasures;
  const bpms = measureBpms(sheet, opts.fallbackBpm ?? 80, opts.followTempo ?? true);
  const perMeasure: Step[][] = [];
  let count = 0;
  measures.forEach((measure, measureIndex) => {
    const written: Step[] = [];
    perMeasure.push(written);
    const quarters = measureQuarters(measures, measureIndex);
    const containers = measure.VerticalSourceStaffEntryContainers.slice().sort(
      (a, b) => a.Timestamp.RealValue - b.Timestamp.RealValue,
    );
    for (const container of containers) {
      const notes: TimelineNote[] = [];
      for (let staff = 0; staff < container.StaffEntries.length; staff++) {
        const entry = container.StaffEntries[staff];
        if (!entry) continue;
        for (const voice of entry.VoiceEntries) {
          if (voice.IsGrace) continue;
          for (const note of voice.Notes) {
            if (!isCounted(note)) continue;
            notes.push({
              midi: midiFromHalfTone(note.halfTone),
              staff,
              ref: note,
              quarters: noteQuarters(note),
              ...(isStaccato(note) ? { staccato: true } : {}),
            });
          }
        }
      }
      if (notes.length === 0) continue;
      const pitches = [...new Set(notes.map((n) => n.midi))].sort((a, b) => a - b);
      const staves = [...new Set(notes.map((n) => n.staff))].sort((a, b) => a - b);
      const writtenTime = round6((measure.AbsoluteTimestamp.RealValue + container.Timestamp.RealValue) * 4);
      written.push({
        index: count,
        pitches,
        notes,
        staves,
        bar: measureIndex + 1,
        measureIndex,
        beat: round6(container.Timestamp.RealValue * 4),
        time: writtenTime,
        written: count,
        pass: 1,
        writtenTime,
        measureQuarters: quarters,
        bpm: bpms[measureIndex],
      });
      count++;
    }
  });
  if (opts.followRepeats === false) return perMeasure.flat();
  const order = playOrder(measures.map(repeatMarks), {
    jumps: opts.followJumps ?? true,
    repeatsAfterJump: opts.repeatsAfterJump ?? false,
  });
  const steps: Step[] = [];
  const seen = new Map<number, number>();
  let playStart = 0;
  for (const mi of order) {
    const pass = (seen.get(mi) ?? 0) + 1;
    seen.set(mi, pass);
    for (const w of perMeasure[mi]) {
      steps.push({ ...w, index: steps.length, pass, time: round6(playStart + w.beat) });
    }
    playStart += measureQuarters(measures, mi);
  }
  return steps;
}

export interface SheetInfo {
  tempoBpm: number | null;
  beats: number;
  beatType: number;
  jumps: string[];
}

const JUMP_NAMES: Record<number, string> = {
  4: "D.C.",
  5: "D.S.",
  6: "Fine",
  7: "To Coda",
  8: "D.S. al Fine",
  9: "D.C. al Fine",
  10: "D.S. al Coda",
  11: "D.C. al Coda",
  12: "Coda",
  13: "Segno",
};

export function sheetInfo(sheet: SheetLike): SheetInfo {
  const first = sheet.SourceMeasures[0];
  const bpm = first?.TempoInBPM;
  const tempoBpm =
    sheet.HasBPMInfo === true && bpm !== undefined && Number.isFinite(bpm) && bpm >= 10 && bpm <= 400 ? bpm : null;
  const jumps: string[] = [];
  for (const m of sheet.SourceMeasures) {
    for (const r of [...(m.FirstRepetitionInstructions ?? []), ...(m.LastRepetitionInstructions ?? [])]) {
      const name = JUMP_NAMES[r.type];
      if (name && !jumps.includes(name)) jumps.push(name);
    }
  }
  return {
    tempoBpm,
    beats: first?.ActiveTimeSignature?.Numerator ?? 4,
    beatType: first?.ActiveTimeSignature?.Denominator ?? 4,
    jumps,
  };
}

export function barRuns(steps: readonly { bar: number; pass: number }[]): string {
  const merged = steps.filter((b, i) => i === 0 || b.bar !== steps[i - 1].bar || b.pass !== steps[i - 1].pass);
  const runs: string[] = [];
  for (let i = 0; i < merged.length; ) {
    let j = i;
    while (j + 1 < merged.length && merged[j + 1].bar === merged[j].bar + 1 && merged[j + 1].pass === merged[j].pass) j++;
    runs.push(j > i ? `${merged[i].bar}-${merged[j].bar}` : `${merged[i].bar}`);
    i = j + 1;
  }
  return runs.join(" ");
}

export function timelineSummary(steps: readonly Step[]): string {
  return steps.map((s) => `${s.bar}/${s.beat}=${s.pitches.join("+")}`).join(" ");
}
