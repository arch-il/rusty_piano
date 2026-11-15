import type { BarRange } from "./practice-steps";
import type { KV } from "./fingering-toggle";

export const BAR_NOTE_MAX = 500;
export const PIECE_NOTE_MAX = 2000;
export const MAX_BAR = 9999;
export const MARKS_KEY = "rp.scoreMarks";

export interface ScoreNotesDoc {
  piece_note: string;
  hard_bars: number[];
  bar_notes: Record<string, string>;
  updated_at: string | null;
}

export interface ScoreNotesPayload {
  piece_note: string;
  hard_bars: number[];
  bar_notes: Record<string, string>;
}

export interface BarBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface MarkLayout {
  bands: { bar: number; left: number; top: number; width: number; height: number }[];
  icons: { bar: number; left: number; top: number; title: string }[];
}

export function emptyNotes(): ScoreNotesDoc {
  return { piece_note: "", hard_bars: [], bar_notes: {}, updated_at: null };
}

function isBarNumber(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= MAX_BAR;
}

export function normaliseNotes(raw: unknown): ScoreNotesDoc {
  if (typeof raw !== "object" || raw === null) return emptyNotes();
  const r = raw as Record<string, unknown>;
  const hardIn: unknown[] = Array.isArray(r.hard_bars) ? r.hard_bars : [];
  const hard_bars = [...new Set(hardIn.filter(isBarNumber))].sort((a, b) => a - b);
  const notesIn: Record<string, unknown> =
    typeof r.bar_notes === "object" && r.bar_notes !== null ? (r.bar_notes as Record<string, unknown>) : {};
  const bar_notes: Record<string, string> = {};
  for (const [key, value] of Object.entries(notesIn)) {
    if (!/^[1-9][0-9]{0,3}$/.test(key) || typeof value !== "string") continue;
    const text = value.trim();
    if (text !== "") bar_notes[key] = text;
  }
  return {
    piece_note: typeof r.piece_note === "string" ? r.piece_note : "",
    hard_bars,
    bar_notes,
    updated_at: typeof r.updated_at === "string" ? r.updated_at : null,
  };
}

export function toPayload(doc: ScoreNotesDoc): ScoreNotesPayload {
  return { piece_note: doc.piece_note, hard_bars: [...doc.hard_bars], bar_notes: { ...doc.bar_notes } };
}

export function isEmptyNotes(doc: ScoreNotesDoc): boolean {
  return doc.piece_note === "" && doc.hard_bars.length === 0 && Object.keys(doc.bar_notes).length === 0;
}

export function isHard(doc: ScoreNotesDoc, bar: number): boolean {
  return doc.hard_bars.includes(bar);
}

export function allHard(doc: ScoreNotesDoc, range: BarRange): boolean {
  for (let bar = range.from; bar <= range.to; bar++) {
    if (!isHard(doc, bar)) return false;
  }
  return true;
}

function copyDoc(doc: ScoreNotesDoc): ScoreNotesDoc {
  return { ...doc, hard_bars: [...doc.hard_bars], bar_notes: { ...doc.bar_notes } };
}

export function toggleHard(doc: ScoreNotesDoc, range: BarRange): ScoreNotesDoc {
  const remove = allHard(doc, range);
  const set = new Set(doc.hard_bars);
  for (let bar = range.from; bar <= range.to; bar++) {
    if (remove) set.delete(bar);
    else set.add(bar);
  }
  return { ...copyDoc(doc), hard_bars: [...set].sort((a, b) => a - b) };
}

export function barNote(doc: ScoreNotesDoc, bar: number): string | null {
  return doc.bar_notes[String(bar)] ?? null;
}

function cleanText(text: string): string {
  return text.replace(/\r\n?/g, "\n").trim();
}

export function setBarNote(doc: ScoreNotesDoc, bar: number, text: string): ScoreNotesDoc {
  const next = copyDoc(doc);
  const cleaned = cleanText(text).slice(0, BAR_NOTE_MAX);
  if (cleaned === "") delete next.bar_notes[String(bar)];
  else next.bar_notes[String(bar)] = cleaned;
  return next;
}

export function setPieceNote(doc: ScoreNotesDoc, text: string): ScoreNotesDoc {
  return { ...copyDoc(doc), piece_note: cleanText(text).slice(0, PIECE_NOTE_MAX) };
}

export function hardRanges(doc: ScoreNotesDoc, barCount?: number): BarRange[] {
  const bars = doc.hard_bars.filter((b) => barCount === undefined || b <= barCount);
  const out: BarRange[] = [];
  for (const bar of bars) {
    const last = out[out.length - 1];
    if (last && last.to + 1 === bar) last.to = bar;
    else out.push({ from: bar, to: bar });
  }
  return out;
}

export function rangeLabel(r: BarRange): string {
  return r.from === r.to ? `Bar ${r.from}` : `Bars ${r.from}-${r.to}`;
}

export function nextRange(ranges: BarRange[], current: BarRange | null): BarRange | null {
  if (ranges.length === 0) return null;
  if (current === null) return ranges[0];
  const next = ranges.find((r) => r.from > current.from);
  return next ?? ranges[0];
}

export function menuTarget(bar: number, selection: BarRange | null): BarRange {
  if (selection !== null && selection.from <= bar && bar <= selection.to) {
    return { from: selection.from, to: selection.to };
  }
  return { from: bar, to: bar };
}

export function menuLabels(
  doc: ScoreNotesDoc,
  bar: number,
  selection: BarRange | null,
): { target: BarRange; hard: string; note: string } {
  const target = menuTarget(bar, selection);
  const what = target.from === target.to ? `bar ${target.from}` : `bars ${target.from}-${target.to}`;
  return {
    target,
    hard: allHard(doc, target) ? `Unmark ${what}` : `Mark ${what} as hard`,
    note: barNote(doc, bar) ? `Edit note on bar ${bar}…` : `Add note to bar ${bar}…`,
  };
}

export function noteTitle(bar: number, text: string): string {
  return `Bar ${bar}: ${text}`;
}

export function hardbarsButtonText(count: number): string {
  return count === 0 ? "Hard bars" : `Hard bars (${count})`;
}

export function noteCounter(text: string): string {
  return `${text.length} / ${BAR_NOTE_MAX}`;
}

export function markLayout(doc: ScoreNotesDoc, boxes: readonly (BarBox | null)[]): MarkLayout {
  const bands: MarkLayout["bands"] = [];
  for (const bar of doc.hard_bars) {
    const box = boxes[bar - 1];
    if (box) bands.push({ bar, left: box.left, top: box.top, width: box.width, height: box.height });
  }
  const icons: MarkLayout["icons"] = [];
  const noteBars = Object.keys(doc.bar_notes).map(Number).sort((a, b) => a - b);
  for (const bar of noteBars) {
    const box = boxes[bar - 1];
    if (!box) continue;
    icons.push({ bar, left: box.left + 2, top: box.top - 2, title: noteTitle(bar, doc.bar_notes[String(bar)]) });
  }
  return { bands, icons };
}

export function placePopup(
  x: number,
  y: number,
  w: number,
  h: number,
  vw: number,
  vh: number,
  margin = 8,
): { left: number; top: number } {
  return {
    left: Math.max(margin, Math.min(x, vw - w - margin)),
    top: Math.max(margin, Math.min(y, vh - h - margin)),
  };
}

export function loadMarksVisible(store: KV | null): boolean {
  try {
    return store === null ? true : store.getItem(MARKS_KEY) !== "off";
  } catch {
    return true;
  }
}

export function saveMarksVisible(store: KV | null, on: boolean): void {
  try {
    store?.setItem(MARKS_KEY, on ? "on" : "off");
  } catch {
    // ignore
  }
}

export type NotesState = "none" | "loading" | "ready" | "error";

export interface NotesStore {
  scoreId(): string | null;
  state(): NotesState;
  error(): string | null;
  doc(): ScoreNotesDoc;
  reset(scoreId: string | null): void;
  loaded(scoreId: string, raw: unknown): void;
  failed(scoreId: string, message: string): void;
  change(next: ScoreNotesDoc): Promise<void>;
}

export function createNotesStore(opts: {
  save(scoreId: string, payload: ScoreNotesPayload): Promise<unknown>;
  onChange(): void;
  onError(message: string): void;
}): NotesStore {
  let id: string | null = null;
  let st: NotesState = "none";
  let err: string | null = null;
  let shown = emptyNotes();
  let saved = emptyNotes();
  let pending: ScoreNotesDoc | null = null;
  let gen = 0;
  let loopGen: number | null = null;
  let loopPromise: Promise<void> | null = null;

  async function run(g: number, scoreId: string): Promise<void> {
    while (pending !== null) {
      const body: ScoreNotesDoc = pending;
      pending = null;
      let result: unknown;
      try {
        result = await opts.save(scoreId, toPayload(body));
      } catch (e) {
        if (g !== gen) return;
        pending = null;
        shown = saved;
        opts.onChange();
        opts.onError(e instanceof Error ? e.message : String(e));
        break;
      }
      if (g !== gen) return;
      saved = normaliseNotes(result);
      if (pending === null) {
        shown = saved;
        opts.onChange();
      }
    }
    if (loopGen === g) {
      loopGen = null;
      loopPromise = null;
    }
  }

  return {
    scoreId: () => id,
    state: () => st,
    error: () => err,
    doc: () => shown,
    reset(scoreId: string | null): void {
      gen++;
      id = scoreId;
      shown = emptyNotes();
      saved = emptyNotes();
      st = scoreId ? "loading" : "none";
      err = null;
      pending = null;
      loopGen = null;
      loopPromise = null;
      opts.onChange();
    },
    loaded(scoreId: string, raw: unknown): void {
      if (scoreId !== id || st !== "loading") return;
      saved = normaliseNotes(raw);
      shown = saved;
      st = "ready";
      opts.onChange();
    },
    failed(scoreId: string, message: string): void {
      if (scoreId !== id || st !== "loading") return;
      st = "error";
      err = message;
      opts.onChange();
    },
    change(next: ScoreNotesDoc): Promise<void> {
      if (st !== "ready" || id === null) return Promise.resolve();
      shown = next;
      opts.onChange();
      pending = next;
      if (loopGen === gen && loopPromise !== null) return loopPromise;
      loopGen = gen;
      loopPromise = run(gen, id);
      return loopPromise;
    },
  };
}
