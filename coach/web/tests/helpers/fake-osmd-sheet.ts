import type { SheetLike } from "../../src/score-timeline.ts";

const STEP_SEMITONES: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

type FakeNote = {
  halfTone: number;
  isRest: () => boolean;
  NoteTie: { StartNote: FakeNote; Duration: { RealValue: number } } | undefined;
  Length: { RealValue: number };
  IsGraceNote: boolean;
  IsCueNote: boolean;
  PrintObject: boolean;
};

type FakeVoice = { IsGrace: boolean; Notes: FakeNote[] };
type FakeStaffEntry = { VoiceEntries: FakeVoice[] };
type FakeContainer = { Timestamp: { RealValue: number }; StaffEntries: (FakeStaffEntry | undefined)[] };

export function fakeSheetFromMusicXml(xml: string): SheetLike {
  const part = xml.match(/<part\s[^>]*>([\s\S]*?)<\/part>/)?.[1] ?? "";
  const ties = new Map<string, { StartNote: FakeNote; Duration: { RealValue: number } }>();
  const measures: Record<string, unknown>[] = [];
  const tempoMatch = part.match(/<sound\b[^>]*\btempo=["']([\d.]+)["']/);
  let current: number | null = null;
  let beats = 4;
  let beatType = 4;
  let divisions = 1;
  let staves = 1;
  let absolute = 0;

  for (const m of part.matchAll(/<measure\b[^>]*>([\s\S]*?)<\/measure>/g)) {
    const body = m[1];
    const div = body.match(/<divisions>(\d+)<\/divisions>/);
    if (div) divisions = Number(div[1]);
    const ts = body.match(/<time\b[^>]*>\s*<beats>(\d+)<\/beats>\s*<beat-type>(\d+)<\/beat-type>/);
    if (ts) {
      beats = Number(ts[1]);
      beatType = Number(ts[2]);
    }
    const st = body.match(/<staves>(\d+)<\/staves>/);
    if (st) staves = Number(st[1]);
    const soundTempos = [...body.matchAll(/<sound\b[^>]*\btempo=["']([\d.]+)["']/g)];
    const perMinutes = [...body.matchAll(/<per-minute>\s*([\d.]+)\s*<\/per-minute>/g)];
    const found = soundTempos.length > 0 ? soundTempos[soundTempos.length - 1] : perMinutes[perMinutes.length - 1];
    if (found) current = Number(found[1]);

    const containers = new Map<number, FakeContainer>();
    let pos = 0;
    let maxPos = 0;
    let onset = 0;
    let lastVoice: FakeVoice | undefined;

    for (const el of body.matchAll(/<note\b[\s\S]*?<\/note>|<backup>[\s\S]*?<\/backup>|<forward>[\s\S]*?<\/forward>/g)) {
      const text = el[0];
      const duration = Number(text.match(/<duration>(\d+)<\/duration>/)?.[1] ?? 0);
      if (text.startsWith("<backup")) {
        pos -= duration;
        continue;
      }
      if (text.startsWith("<forward")) {
        pos += duration;
        maxPos = Math.max(maxPos, pos);
        continue;
      }

      const grace = /<grace\b/.test(text);
      const chord = /<chord\b/.test(text);
      const rest = /<rest\b/.test(text);
      const staff = Number(text.match(/<staff>(\d+)<\/staff>/)?.[1] ?? 1);
      const step = text.match(/<step>([A-G])<\/step>/)?.[1] ?? "C";
      const alter = Number(text.match(/<alter>(-?\d+)<\/alter>/)?.[1] ?? 0);
      const octave = Number(text.match(/<octave>(-?\d+)<\/octave>/)?.[1] ?? 0);
      const halfTone = rest ? 0 : STEP_SEMITONES[step] + alter + 12 * octave;

      let start: number;
      if (chord) {
        start = onset;
      } else {
        start = pos;
        onset = pos;
        if (!grace) {
          pos += duration;
          maxPos = Math.max(maxPos, pos);
        }
      }

      if (!containers.has(start)) {
        containers.set(start, { Timestamp: { RealValue: start / (divisions * 4) }, StaffEntries: new Array(staves) });
      }
      const container = containers.get(start)!;
      const note: FakeNote = {
        halfTone,
        isRest: () => rest,
        NoteTie: undefined,
        Length: { RealValue: grace ? 0 : duration / (divisions * 4) },
        IsGraceNote: grace,
        IsCueNote: false,
        PrintObject: true,
      };

      const key = `${staff}:${halfTone}`;
      const tieStart = /<tie type="start"/.test(text);
      const tieStop = /<tie type="stop"/.test(text);
      let tie = tieStop ? ties.get(key) : undefined;
      if (!tie && (tieStart || tieStop)) tie = { StartNote: note, Duration: { RealValue: 0 } };
      if (tie) {
        note.NoteTie = tie;
        tie.Duration.RealValue += note.Length.RealValue;
      }
      if (tieStart && tie) ties.set(key, tie);
      else if (tieStop) ties.delete(key);

      const entry = (container.StaffEntries[staff - 1] ??= { VoiceEntries: [] });
      if (chord && lastVoice) {
        lastVoice.Notes.push(note);
      } else {
        lastVoice = { IsGrace: grace, Notes: [note] };
        entry.VoiceEntries.push(lastVoice);
      }
    }

    const first: Record<string, unknown>[] = [];
    const last: Record<string, unknown>[] = [];
    for (const b of body.matchAll(/<barline\b([^>]*)>([\s\S]*?)<\/barline>/g)) {
      const left = (b[1].match(/location=["'](\w+)["']/)?.[1] ?? "right") === "left";
      const ending = b[2].match(/<ending\b([^>]*)>/);
      if (ending) {
        const kind = ending[1].match(/type=["'](\w+)["']/)?.[1];
        const nums = (ending[1].match(/number=["']([^"']*)["']/)?.[1] ?? "")
          .split(",")
          .map((x) => Number(x.trim()))
          .filter((x) => Number.isFinite(x) && x > 0);
        if (left && kind === "start") first.push({ type: 3, alignment: 0, endingIndices: nums });
        if (!left && (kind === "stop" || kind === "discontinue")) {
          for (const num of nums) last.push({ type: 3, alignment: kind === "stop" ? 1 : 3, endingIndices: [num] });
        }
      }
      const rep = b[2].match(/<repeat\b[^>]*direction=["'](\w+)["']/)?.[1];
      if (left && rep === "forward") first.push({ type: 0, alignment: 0, endingIndices: [] });
      if (!left && rep === "backward") last.push({ type: 2, alignment: 1, endingIndices: [] });
    }

    for (const d of body.matchAll(/<direction(?:\s[^>]*)?>[\s\S]*?<\/direction>/g)) {
      const text = d[0];
      const words = [...text.matchAll(/<words\b[^>]*>([\s\S]*?)<\/words>/g)].map((w) => w[1]).join("").trim().toLowerCase();
      const byWords: Record<string, number> = {
        "d.c. al fine": 9,
        "d.c. al coda": 11,
        "d.c.": 4,
        "da capo": 4,
        "d.s. al fine": 8,
        "d.s. al coda": 10,
        "d.s.": 5,
        "dal segno": 5,
        "to coda": 7,
        fine: 6,
        coda: 12,
        segno: 13,
      };
      let type: number | undefined = byWords[words];
      if (type === undefined) {
        if (/<segno\b/.test(text)) type = 13;
        else if (/<coda\b/.test(text)) type = 12;
      }
      if (type === undefined) {
        const sound = text.match(/<sound\b([^>]*)>/)?.[1] ?? "";
        const attrs: [string, number][] = [
          ["dacapo", 4],
          ["dalsegno", 5],
          ["tocoda", 7],
          ["fine", 6],
          ["segno", 13],
          ["coda", 12],
        ];
        type = attrs.find(([name]) => new RegExp("\\b" + name + "\\s*=").test(sound))?.[1];
      }
      if (type === undefined) continue;
      if (type === 13) first.push({ type, alignment: 0, endingIndices: [] });
      else last.push({ type, alignment: 1, endingIndices: [] });
    }

    const length = maxPos / (divisions * 4);
    measures.push({
      AbsoluteTimestamp: { RealValue: absolute },
      Duration: { RealValue: length },
      ActiveTimeSignature: { Numerator: beats, Denominator: beatType, RealValue: beats / beatType },
      TempoInBPM: current ?? 120,
      FirstRepetitionInstructions: first,
      LastRepetitionInstructions: last,
      VerticalSourceStaffEntryContainers: [...containers.values()].sort((a, b) => a.Timestamp.RealValue - b.Timestamp.RealValue),
    });
    absolute += length;
  }

  return { SourceMeasures: measures, HasBPMInfo: tempoMatch !== null } as unknown as SheetLike;
}
