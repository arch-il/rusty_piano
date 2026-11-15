import type { MusicSystem, Note, OpenSheetMusicDisplay, VexFlowGraphicalNote } from "opensheetmusicdisplay";
import { createMarks, DEFAULT_INK, latestByKey, markColour } from "./feedback-overlay";
import type { TimingColours } from "./timing-score";
import type { StepOutcome } from "./note-matcher";
import {
  barRects,
  clampZoom,
  extendRange,
  followScrollTop,
  FOLLOW_MARGIN_PX,
  needleRect,
  hitTest,
  slideX,
  stepZoom,
  type Box,
} from "./score-geometry";
import { columnCells, pickCell, type Column, type HoverCell } from "./note-hover";
import { fingerText, type HandNotes } from "./piano-keys";
import { fingerKey, pickFinger, type FingerMap } from "./generated-fingering";
import { buildTimeline, sheetInfo, type SheetInfo, type Step } from "./score-timeline";
import { inHand, type Hands } from "./practice-steps";
import { stepBack, stepForward, type StepCursor } from "./cursor-steps";

export type ScoreFormat = "mxl" | "musicxml";

export interface ScoreViewEvents {
  onCursorMoved?: (bar: number | null, total: number) => void;
  onBarSelected?: (range: { from: number; to: number } | null) => void;
  onNoteHover?: (notes: HandNotes | null) => void;
  onNextNotes?: (notes: HandNotes | null) => void;
}

export interface ScoreViewOptions {
  followRepeats?: boolean;
  followJumps?: boolean;
  repeatsAfterJump?: boolean;
  followTempo?: boolean;
  fallbackBpm?: number;
  zoomRedrawMs?: number;
  scrollMarginPx?: number;
  timingColours?: TimingColours;
}

type OsmdModule = typeof import("opensheetmusicdisplay");

let osmdModule: Promise<OsmdModule> | null = null;

function loadOsmd(): Promise<OsmdModule> {
  if (!osmdModule) {
    osmdModule = import("opensheetmusicdisplay");
    osmdModule.catch(() => {
      osmdModule = null;
    });
  }
  return osmdModule;
}

/**
 * Renders a score with OpenSheetMusicDisplay, with zoom, bar selection and a cursor.
 * The container must be visible with a non-zero width when load() runs.
 */
export class ScoreView {
  private container: HTMLElement;
  private events: ScoreViewEvents;
  private stage: HTMLDivElement;
  private host: HTMLDivElement;
  private highlights: HTMLDivElement;
  private needle: HTMLDivElement;
  private markLayer: HTMLDivElement;
  private marks = createMarks();
  private steps: Step[] | null = null;
  private needleStep: number | null = null;
  private lastNextStep: number | null = null;
  private following = false;
  private hands: Hands = "both";
  private options: ScoreViewOptions;
  private boxCache = new Map<number, Box | null>();
  private osmd: OpenSheetMusicDisplay | null = null;
  private _loaded = false;
  private _zoom = 1;
  private drawnZoom = 1;
  private zoomTimer: number | undefined;
  private token = 0;
  private rects: (Box | null)[] = [];
  private hoverCells: HoverCell[] | null = null;
  private generated: FingerMap | null = null;
  private warnedNoMatch = false;
  private hoverKey: string | null = null;
  private hoverLine: HTMLDivElement;
  private selected: { from: number; to: number } | null = null;
  private anchor: number | null = null;
  private lastWidth = 0;
  private resizeTimer: number | undefined;

  constructor(container: HTMLElement, events: ScoreViewEvents = {}, options: ScoreViewOptions = {}) {
    this.container = container;
    this.events = events;
    this.options = options;

    this.stage = document.createElement("div");
    this.stage.className = "score-stage";

    this.host = document.createElement("div");

    const overlay = document.createElement("div");
    overlay.className = "score-overlay";

    this.highlights = document.createElement("div");
    this.highlights.className = "bar-highlights";

    this.needle = document.createElement("div");
    this.needle.className = "follow-needle";
    this.needle.style.display = "none";

    this.hoverLine = document.createElement("div");
    this.hoverLine.className = "hover-line";
    this.hoverLine.style.display = "none";

    overlay.appendChild(this.highlights);
    this.markLayer = document.createElement("div");
    this.markLayer.className = "follow-marks";

    overlay.appendChild(this.hoverLine);
    overlay.appendChild(this.needle);
    overlay.appendChild(this.markLayer);
    this.needle.addEventListener("animationend", () => this.needle.classList.remove("wrong"));
    this.stage.appendChild(this.host);
    this.stage.appendChild(overlay);
    container.appendChild(this.stage);

    this.stage.addEventListener("click", (e) => this.onClick(e));
    this.stage.addEventListener("mousemove", (e) => this.onMove(e));
    this.stage.addEventListener("mouseleave", () => this.setHover(null));
    this.stage.addEventListener("mousedown", (e) => {
      if (e.shiftKey) e.preventDefault();
    });

    this.lastWidth = container.clientWidth;
    const ro = new ResizeObserver(() => {
      const w = this.container.clientWidth;
      if (!this._loaded || Math.abs(w - this.lastWidth) <= 1) return;
      this.lastWidth = w;
      window.clearTimeout(this.resizeTimer);
      this.resizeTimer = window.setTimeout(() => this.rerender(), 150);
    });
    ro.observe(container);
  }

  get loaded(): boolean {
    return this._loaded;
  }

  get zoom(): number {
    return this._zoom;
  }

  private get o(): OpenSheetMusicDisplay {
    if (!this.osmd) throw new Error("No score loaded");
    return this.osmd;
  }

  async load(fileUrl: string, format: ScoreFormat): Promise<void> {
    window.clearTimeout(this.zoomTimer);
    this.marks.clear();
    this.markLayer.replaceChildren();
    this.boxCache.clear();
    this.hoverCells = null;
    this.generated = null;
    this.warnedNoMatch = false;
    this.setHover(null);
    this.resetNext();
    this.resetFollow();
    const my = ++this.token;
    const modPromise = loadOsmd();
    modPromise.catch(() => {});
    const res = await fetch(fileUrl);
    if (my !== this.token) return;
    if (!res.ok) throw new Error(`Could not download the score (HTTP ${res.status})`);
    let content: string | Document;
    if (format === "mxl") {
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (my !== this.token) return;
      let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000) {
        bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      }
      content = bin;
    } else {
      const text = await res.text();
      if (my !== this.token) return;
      const doc = new DOMParser().parseFromString(text, "application/xml");
      if (doc.getElementsByTagName("parsererror").length > 0) {
        throw new Error("This file is not valid MusicXML");
      }
      content = doc;
    }

    const mod = await modPromise;
    if (my !== this.token) return;
    if (!this.osmd) {
      this.osmd = new mod.OpenSheetMusicDisplay(this.host, {
        backend: "svg",
        autoResize: false,
        drawTitle: false,
        drawSubtitle: false,
        drawComposer: false,
        drawLyricist: false,
        drawCredits: false,
        followCursor: true,
      });
    }

    const color =
      getComputedStyle(document.documentElement).getPropertyValue("--cursor-color").trim() ||
      "#3355cc";
    this.osmd.cursorsOptions = [
      { type: mod.CursorType.Standard, color, alpha: 0.5, follow: true },
    ];

    await this.osmd.load(content);
    if (my !== this.token) return;
    this.osmd.Zoom = this._zoom;
    this.drawnZoom = this._zoom;
    this.osmd.render();
    this.osmd.cursor.show();
    this._loaded = true;
    this.lastWidth = this.container.clientWidth;
    this.computeRects();
    this.selected = null;
    this.anchor = null;
    this.placeHighlight();
    this.events.onBarSelected?.(null);
    this.events.onCursorMoved?.(1, this.barCount());
  }

  clear(): void {
    window.clearTimeout(this.zoomTimer);
    this.token++;
    if (this._loaded && this.osmd) this.osmd.clear();
    this.highlights.replaceChildren();
    this.boxCache.clear();
    this.hoverCells = null;
    this.generated = null;
    this.warnedNoMatch = false;
    this.setHover(null);
    this.resetNext();
    this.resetFollow();
    this._loaded = false;
    this.rects = [];
    this.selected = null;
    this.anchor = null;
    this.events.onCursorMoved?.(null, 0);
    this.events.onBarSelected?.(null);
  }

  setZoom(z: number): void {
    this._zoom = clampZoom(z);
    if (!this._loaded) return;
    const delay = this.options.zoomRedrawMs ?? 400;
    window.clearTimeout(this.zoomTimer);
    if (delay <= 0) {
      this.rerender();
    } else {
      this.zoomTimer = window.setTimeout(() => {
        this.zoomTimer = undefined;
        if (this._loaded) this.rerender();
      }, delay);
    }
  }

  zoomIn(): void {
    this.setZoom(stepZoom(this._zoom, 1));
  }

  zoomOut(): void {
    this.setZoom(stepZoom(this._zoom, -1));
  }

  resetZoom(): void {
    this.setZoom(1);
  }

  selection(): { from: number; to: number } | null {
    return this.selected ? { ...this.selected } : null;
  }

  private setSelection(range: { from: number; to: number } | null): void {
    this.selected = range;
    this.placeHighlight();
    this.events.onBarSelected?.(this.selection());
  }

  selectBar(bar: number | null): void {
    this.setSelection(bar !== null && this.rects[bar - 1] ? { from: bar, to: bar } : null);
  }

  selectRange(range: { from: number; to: number } | null): void {
    if (range === null) {
      this.setSelection(null);
      return;
    }
    const from = Math.max(1, range.from);
    const to = Math.min(this.rects.length, range.to);
    this.setSelection(from <= to && this.rects[from - 1] ? { from, to } : null);
  }

  cursorStart(): void {
    if (!this._loaded) return;
    this.o.cursor.reset();
    this.emitCursor();
  }

  cursorPrev(): void {
    if (!this._loaded) return;
    stepBack(this.o.cursor as unknown as StepCursor);
    this.emitCursor();
  }

  cursorNext(): void {
    if (!this._loaded) return;
    stepForward(this.o.cursor as unknown as StepCursor);
    this.emitCursor();
  }

  private resetFollow(): void {
    this.boxCache.clear();
    this.steps = null;
    this.needleStep = null;
    this.following = false;
    this.needle.style.display = "none";
  }

  timeline(): Step[] {
    if (!this._loaded) return [];
    return (this.steps ??= buildTimeline(this.o.Sheet, {
      followRepeats: this.options.followRepeats ?? true,
      followJumps: this.options.followJumps ?? true,
      repeatsAfterJump: this.options.repeatsAfterJump ?? false,
      followTempo: this.options.followTempo ?? true,
      fallbackBpm: this.options.fallbackBpm ?? 80,
    }));
  }

  scoreInfo(): SheetInfo | null {
    return this._loaded ? sheetInfo(this.o.Sheet) : null;
  }

  setFollowing(on: boolean, hands: Hands = "both"): void {
    if (on) this.hands = hands;
    this.following = on;
    this.needleStep = null;
    this.resetNext();
    this.needle.style.display = "none";
    if (!this._loaded) return;
    if (on) {
      this.o.cursor.hide();
    } else {
      const follow = this.o.FollowCursor;
      this.o.FollowCursor = false;
      this.o.cursor.show();
      this.o.FollowCursor = follow;
    }
  }

  showNeedle(step: number | null): void {
    this.needleStep = step;
    this.emitNext(step);
    this.placeNeedle(true);
  }

  slideNeedle(from: number, to: number | null, frac: number): void {
    this.emitNext(to ?? from);
    const a = this._loaded ? this.cachedBox(from) : null;
    if (!a) {
      this.needle.style.display = "none";
      return;
    }
    const b = to !== null ? this.cachedBox(to) : null;
    this.needle.style.left = `${slideX(a, b, frac)}px`;
    this.needle.style.top = `${a.y}px`;
    this.needle.style.height = `${a.height}px`;
    this.needle.style.display = "block";
    if (this.needleStep !== from) {
      this.needleStep = from;
      this.scrollToLine(a);
    }
  }

  private cachedBox(index: number): Box | null {
    if (!this.boxCache.has(index)) this.boxCache.set(index, this.stepBox(index));
    return this.boxCache.get(index) ?? null;
  }

  private drawnNote(ref: unknown): VexFlowGraphicalNote | null {
    const gse = this.o.GraphicSheet.GetGraphicalFromSourceStaffEntry((ref as Note).ParentStaffEntry);
    return (gse?.findGraphicalNoteFromNote(ref as Note) as VexFlowGraphicalNote | undefined) ?? null;
  }

  private cssColor(name: string, fallback: string): string {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
  }

  private markColourOf(index: number): string {
    const outcome = this.marks.outcome(index);
    if (!outcome) return DEFAULT_INK;
    return markColour(outcome, this.marks.score(index), (n, f) => this.cssColor(n, f), this.options.timingColours);
  }

  private paintStep(index: number, allHands = false): void {
    const outcome = this.marks.outcome(index);
    const colour = outcome
      ? this.markColourOf(index)
      : this.o.EngravingRules.DefaultColorNotehead || DEFAULT_INK;
    const step = this.timeline()[index];
    if (!step) return;
    for (const n of step.notes) {
      if (!allHands && !inHand(n.staff, this.hands)) continue;
      try {
        this.drawnNote(n.ref)?.setColor(colour, {
          applyToNoteheads: true,
          applyToStem: true,
          applyToFlag: true,
          applyToModifiers: true,
          applyToBeams: false,
          applyToLedgerLines: false,
          applyToTies: false,
          applyToSlurs: false,
          applyToLyrics: false,
        });
      } catch {
        // OSMD throws when the note's VexFlow element is not drawn
      }
    }
  }

  markStep(step: number, outcome: StepOutcome | null, score: number | null = null): void {
    this.marks.setOutcome(step, outcome, score);
    if (this._loaded) this.paintStep(step);
    this.placeMarkers();
  }

  clearMarks(): void {
    const steps = this.marks.outcomes().map(([s]) => s);
    this.marks.clear();
    if (this._loaded) for (const s of steps) this.paintStep(s, true);
    this.markLayer.replaceChildren();
  }

  flashWrong(step: number, attempts: number): void {
    this.marks.setWrong(step, attempts);
    this.placeMarkers();
    this.needle.classList.remove("wrong");
    void this.needle.offsetWidth;
    this.needle.classList.add("wrong");
  }

  private placeMarkers(): void {
    this.markLayer.replaceChildren();
    if (!this._loaded) return;
    const keyOf = (step: number): unknown => this.timeline()[step]?.notes[0]?.ref;
    for (const [step, n] of latestByKey(this.marks.wrongs(), keyOf)) {
      const box = this.cachedBox(step);
      if (!box) continue;
      const el = document.createElement("div");
      el.className = "wrong-marker";
      el.textContent = String(n);
      el.style.left = `${box.x}px`;
      el.style.top = `${box.y}px`;
      this.markLayer.appendChild(el);
    }
    const timed = this.marks.outcomes().filter(([, o]) => o === "early" || o === "late");
    for (const [step, outcome] of latestByKey(timed, keyOf)) {
      const box = this.cachedBox(step);
      if (!box) continue;
      const el = document.createElement("div");
      el.className = "timing-marker";
      el.classList.add(outcome);
      el.textContent = outcome === "early" ? "\u2039" : "\u203A";
      const score = this.marks.score(step);
      el.title = score === null ? outcome : `${outcome}, timing ${score}`;
      el.style.color = this.markColourOf(step);
      el.style.left = `${box.x}px`;
      el.style.top = `${box.y + box.height}px`;
      this.markLayer.appendChild(el);
    }
    const holdMarks: [number, string, string][] = [
      ...this.marks.shorts().map((s): [number, string, string] => [s, "short", "Released too early"]),
      ...this.marks.longs().map((s): [number, string, string] => [s, "long", "Staccato note held too long"]),
    ];
    for (const [step, [text, title]] of latestByKey(
      holdMarks.map(([s, text, title]): [number, [string, string]] => [s, [text, title]]),
      keyOf,
    )) {
      const box = this.cachedBox(step);
      if (!box) continue;
      const el = document.createElement("div");
      el.className = "hold-marker";
      el.textContent = text;
      el.title = title;
      el.style.left = `${box.x}px`;
      el.style.top = `${box.y + box.height}px`;
      this.markLayer.appendChild(el);
    }
    for (const [step, title] of latestByKey(this.marks.unevens(), keyOf)) {
      const box = this.cachedBox(step);
      if (!box) continue;
      const el = document.createElement("div");
      el.className = "uneven-marker";
      el.textContent = "~";
      el.title = title;
      el.style.left = `${box.x}px`;
      el.style.top = `${box.y + box.height}px`;
      this.markLayer.appendChild(el);
    }
  }

  markShort(step: number): void {
    this.marks.setShort(step, true);
    this.placeMarkers();
  }

  markLong(step: number): void {
    this.marks.setLong(step, true);
    this.placeMarkers();
  }

  markUneven(spots: readonly { step: number; title: string }[]): void {
    for (const s of spots) this.marks.setUneven(s.step, s.title);
    this.placeMarkers();
  }

  private stepUnits(index: number): { x: number; top: number; bottom: number } | null {
    const step = this.timeline()[index];
    if (!step) return null;
    const sheet = this.o.GraphicSheet;
    const found = [];
    for (const n of step.notes) {
      const gse = sheet.GetGraphicalFromSourceStaffEntry((n.ref as Note).ParentStaffEntry);
      if (gse) found.push(gse);
    }
    const reliable = found.filter((g) => sheet.isReliableCursorXAnchor(g));
    const pool = reliable.length > 0 ? reliable : found;
    let best = null;
    for (const g of pool) {
      if (!best || g.PositionAndShape.AbsolutePosition.x < best.PositionAndShape.AbsolutePosition.x) {
        best = g;
      }
    }
    if (!best) return null;
    const system: MusicSystem = best.parentMeasure.ParentMusicSystem;
    const lines = system.StaffLines;
    if (!lines || lines.length === 0) return null;
    const sy = system.PositionAndShape.AbsolutePosition.y;
    const first = lines[0];
    const last = lines[lines.length - 1];
    return {
      x: best.PositionAndShape.AbsolutePosition.x,
      top: sy + first.PositionAndShape.RelativePosition.y,
      bottom: sy + last.PositionAndShape.RelativePosition.y + last.StaffHeight,
    };
  }

  private stepBox(index: number): Box | null {
    const u = this.stepUnits(index);
    const svg = this.svgRect();
    if (!u || !svg) return null;
    const r = needleRect(u.x, u.top, u.bottom, this.drawnZoom);
    const stage = this.stage.getBoundingClientRect();
    return { ...r, x: r.x + svg.left - stage.left, y: r.y + svg.top - stage.top };
  }

  private placeNeedle(scroll: boolean): void {
    const box =
      this._loaded && this.needleStep !== null ? this.stepBox(this.needleStep) : null;
    if (!box) {
      this.needle.style.display = "none";
      return;
    }
    this.needle.style.left = `${box.x}px`;
    this.needle.style.top = `${box.y}px`;
    this.needle.style.height = `${box.height}px`;
    this.needle.style.display = "block";
    if (scroll) this.scrollToLine(box);
  }

  private scrollToLine(box: Box): void {
    const area = this.container.closest<HTMLElement>(".score-area");
    if (!area) return;
    const stageTop =
      this.stage.getBoundingClientRect().top - area.getBoundingClientRect().top + area.scrollTop;
    const lineTop = stageTop + box.y;
    const t = followScrollTop(
      lineTop,
      lineTop + box.height,
      area.scrollTop,
      area.clientHeight,
      box.height,
      this.options.scrollMarginPx ?? FOLLOW_MARGIN_PX,
    );
    if (t !== null) area.scrollTop = t;
  }

  private barCount(): number {
    return this.o.Sheet.SourceMeasures.length;
  }

  private currentIndex(): number {
    return this.o.cursor.Iterator.CurrentMeasureIndex;
  }

  private emitCursor(): void {
    this.events.onCursorMoved?.(this.currentIndex() + 1, this.barCount());
  }

  private walkTo(index: number): void {
    const follow = this.o.FollowCursor;
    this.o.FollowCursor = false;
    const c = this.o.cursor;
    c.reset();
    while (!c.Iterator.EndReached && c.Iterator.CurrentMeasureIndex < index) c.next();
    this.o.FollowCursor = follow;
    c.cursorElement.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  setGeneratedFingering(map: FingerMap | null): void {
    this.generated = map;
    this.hoverCells = null;
    this.setHover(null);
    const current = this.lastNextStep;
    this.lastNextStep = null;
    this.emitNext(current);
  }

  private rerender(): void {
    const index = this.currentIndex();
    this.boxCache.clear();
    this.hoverCells = null;
    this.setHover(null);
    this.o.Zoom = this._zoom;
    this.drawnZoom = this._zoom;
    this.o.render();
    if (this.following) this.o.cursor.hide();
    else this.o.cursor.show();
    this.walkTo(index);
    this.computeRects();
    this.placeHighlight();
    this.placeNeedle(true);
    for (const [step] of this.marks.outcomes()) this.paintStep(step);
    this.placeMarkers();
  }

  private computeRects(): void {
    const boxes = this.o.GraphicSheet.MeasureList.map((staves) =>
      staves.map((m): Box | null => {
        if (!m) return null;
        const p = m.PositionAndShape;
        return {
          x: p.AbsolutePosition.x + p.BorderLeft,
          y: p.AbsolutePosition.y + p.BorderTop,
          width: p.Size.width,
          height: p.Size.height,
        };
      }),
    );
    this.rects = barRects(boxes, this.drawnZoom);
  }

  private svgRect(): DOMRect | null {
    const svg = this.host.querySelector("svg");
    return svg ? svg.getBoundingClientRect() : null;
  }

  private placeHighlight(): void {
    this.highlights.replaceChildren();
    const svg = this.svgRect();
    if (!this.selected || !svg) return;
    const stage = this.stage.getBoundingClientRect();
    for (let bar = this.selected.from; bar <= this.selected.to; bar++) {
      const rect = this.rects[bar - 1];
      if (!rect) continue;
      const el = document.createElement("div");
      el.className = "bar-highlight";
      el.style.left = `${rect.x + svg.left - stage.left}px`;
      el.style.top = `${rect.y + svg.top - stage.top}px`;
      el.style.width = `${rect.width}px`;
      el.style.height = `${rect.height}px`;
      this.highlights.appendChild(el);
    }
  }

  private setHover(cell: HoverCell | null): void {
    const key = cell ? cell.col.key : null;
    if (key === this.hoverKey) return;
    this.hoverKey = key;
    const svg = this.svgRect();
    if (cell && svg) {
      const stage = this.stage.getBoundingClientRect();
      this.hoverLine.style.left = `${cell.col.x + svg.left - stage.left}px`;
      this.hoverLine.style.top = `${cell.col.top + svg.top - stage.top}px`;
      this.hoverLine.style.height = `${cell.col.height}px`;
      this.hoverLine.style.display = "block";
    } else {
      this.hoverLine.style.display = "none";
    }
    this.events.onNoteHover?.(
      cell
        ? {
            right: cell.col.right,
            left: cell.col.left,
            rightFingers: cell.col.rightFingers,
            leftFingers: cell.col.leftFingers,
          }
        : null,
    );
  }

  private resetNext(): void {
    if (this.lastNextStep === null) return;
    this.lastNextStep = null;
    this.events.onNextNotes?.(null);
  }

  private collectStepNotes(step: Step): { notes: Required<HandNotes>; hits: number } {
    const right: number[] = [];
    const left: number[] = [];
    const rightFingers: Record<number, string> = {};
    const leftFingers: Record<number, string> = {};
    let hits = 0;
    for (const n of step.notes) {
      const side = n.staff === 0 ? right : left;
      if (!side.includes(n.midi)) side.push(n.midi);
      const f = pickFinger(fingerText(n.ref), this.generated, fingerKey(step.measureIndex, step.beat, n.staff, n.midi));
      if (this.generated?.has(fingerKey(step.measureIndex, step.beat, n.staff, n.midi))) hits++;
      const fingers = n.staff === 0 ? rightFingers : leftFingers;
      if (f && fingers[n.midi] === undefined) fingers[n.midi] = f;
    }
    return { notes: { right, left, rightFingers, leftFingers }, hits };
  }

  private emitNext(index: number | null): void {
    if (index === this.lastNextStep) return;
    this.lastNextStep = index;
    const step = index !== null && this._loaded ? this.timeline()[index] : undefined;
    this.events.onNextNotes?.(step ? this.collectStepNotes(step).notes : null);
  }

  private buildHoverCells(): HoverCell[] {
    const cols: Column[] = [];
    const seen = new Set<string>();
    let hits = 0;
    for (const step of this.timeline()) {
      const key = `${step.measureIndex}|${step.writtenTime}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const u = this.stepUnits(step.index);
      const bar = this.rects[step.measureIndex];
      if (!u || !bar) continue;
      const r = needleRect(u.x, u.top, u.bottom, this.drawnZoom);
      const collected = this.collectStepNotes(step);
      hits += collected.hits;
      const { right, left, rightFingers, leftFingers } = collected.notes;
      cols.push({
        key,
        x: r.x,
        top: r.y,
        height: r.height,
        barLeft: bar.x,
        barRight: bar.x + bar.width,
        right,
        left,
        rightFingers,
        leftFingers,
      });
    }
    if (this.generated && this.generated.size > 0 && hits === 0 && !this.warnedNoMatch) {
      this.warnedNoMatch = true;
      console.warn("fingering: generated fingering matched no note of this score");
    }
    return columnCells(cols);
  }

  private onMove(e: MouseEvent): void {
    if (!this._loaded) return;
    const svg = this.svgRect();
    if (!svg) return;
    const cells = (this.hoverCells ??= this.buildHoverCells());
    this.setHover(pickCell(cells, e.clientX - svg.left, e.clientY - svg.top));
  }

  private onClick(e: MouseEvent): void {
    if (!this._loaded) return;
    const svg = this.svgRect();
    if (!svg) return;
    const idx = hitTest(this.rects, e.clientX - svg.left, e.clientY - svg.top);
    if (idx === -1) {
      this.anchor = null;
      this.setSelection(null);
      return;
    }
    const bar = idx + 1;
    if (e.shiftKey && this.anchor !== null) {
      this.setSelection(extendRange(this.anchor, bar));
      return;
    }
    if (this.selected && this.selected.from === bar && this.selected.to === bar) {
      this.anchor = null;
      this.setSelection(null);
      return;
    }
    this.anchor = bar;
    this.setSelection({ from: bar, to: bar });
    this.walkTo(idx);
    this.emitCursor();
  }
}
