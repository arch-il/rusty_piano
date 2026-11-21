import type { OpenSheetMusicDisplay } from "opensheetmusicdisplay";
import { noteName } from "./engine-socket";
import type { LiveEvent } from "./engine-socket";
import { keyLayout } from "./piano-keys";
import { sightHash } from "./drill-link";
import type { SightParams } from "./drill-link";
import type { PlanResponse } from "./skills-logic";
import { DEFAULT_CUSTOM, KEY_HIGH, KEY_LOW, LEVELS, levelById, normalizeCustom, roundStats } from "./sight-levels";
import type { Card, Clef, CustomRange, LevelDef, SightHistory, SightRound, SightStepRecord } from "./sight-levels";
import { cardXml, DEFAULT_XML_COLORS, WRONG_ANCHOR_COLOR, wrongNoteOffset } from "./sight-xml";
import type { XmlMarks } from "./sight-xml";
import { staffLayout, stripStart, stripXml } from "./sight-strip";
import { nextShow, paramsAfterPick } from "./sight-route-state";
import { createSightController } from "./sight-controller";
import type { SightEnd } from "./sight-controller";
import { liveStatsText, noteMap, noteWeights, roundsOfLevel, stageModel, summaryModel } from "./sight-stats";
import { renderSightHistory, treeHasDrill } from "./sight-history-view";
import { isLocked, levelText, lockText } from "./skills-logic";

export interface SightViewOptions {
  engine: { onEvent(fn: (ev: LiveEvent) => void): () => void };
  postAttempt: (attempt: unknown) => Promise<unknown>;
  fetchHistory: (level: string | null) => Promise<SightHistory>;
  fetchPlan?: () => Promise<PlanResponse>;
  onBack: () => void;
  onToast?: (text: string) => void;
  now?: () => number;
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

const DEFAULT_LEVEL = "r2-treble";
const WRONG_FLASH_MS = 600;
const IDLE_HINT = "Pick a level and press Start. No piano connected? On the dev page the keys A to K play C4 to C5, Z and X shift the octave.";

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el as T;
}

export function keysScrollDelta(keysBottom: number, viewBottom: number, margin = 8): number {
  return Math.max(0, Math.ceil(keysBottom + margin - viewBottom));
}

function cssColour(style: CSSStyleDeclaration, name: string, fallback: string): string {
  const v = style.getPropertyValue(name).trim();
  return v === "" ? fallback : v;
}

export function createSightView(opts: SightViewOptions): {
  show(params: SightParams): void;
  hide(): void;
  visible(): boolean;
  escape(): void;
  running(): boolean;
} {
  const section = byId<HTMLElement>("sight-view");
  const statusEl = byId<HTMLElement>("sight-status");
  const levelsEl = byId<HTMLElement>("sight-levels");
  const statsEl = byId<HTMLElement>("sight-stats");
  const staffEl = byId<HTMLElement>("sight-staff");
  const keysEl = byId<HTMLElement>("sight-keys");
  const startBtn = byId<HTMLButtonElement>("sight-start");
  const stopBtn = byId<HTMLButtonElement>("sight-stop");
  const summaryEl = byId<HTMLElement>("sight-summary");
  const backBtn = byId<HTMLButtonElement>("sight-back");
  const historyEl = byId<HTMLElement>("sight-history");
  const levelNameEl = byId<HTMLElement>("sight-level-name");
  const progressTextEl = byId<HTMLElement>("sight-progress-text");
  const progressEl = byId<HTMLElement>("sight-progress");
  const progressFillEl = byId<HTMLElement>("sight-progress-fill");

  let selectedId = DEFAULT_LEVEL;
  let custom: CustomRange = { ...DEFAULT_CUSTOM };
  let params: SightParams = { level: null };
  let rounds: SightRound[] = [];
  let osmdFailed = false;
  let osmd: OpenSheetMusicDisplay | null = null;
  let stripStartIdx = 0;
  let renderChain: Promise<void> = Promise.resolve();
  let historyToken = 0;
  let planTree: PlanResponse["tree"] | null = null;

  const levelButtons = new Map<string, HTMLButtonElement>();
  const keyEls = new Map<number, HTMLElement>();
  const pressed = new Set<number>();
  const wrongTimers = new Map<number, number>();
  let hintKeys: number[] = [];

  function setStatus(text: string): void {
    statusEl.textContent = text;
  }

  function currentLevel(): LevelDef {
    return levelById(selectedId) ?? LEVELS[0];
  }

  // Level picker
  const customBox = document.createElement("div");
  customBox.className = "sight-custom";
  customBox.hidden = true;

  function labelled(text: string, control: HTMLElement): HTMLLabelElement {
    const label = document.createElement("label");
    label.append(text + " ", control);
    return label;
  }

  const clefSelect = document.createElement("select");
  clefSelect.className = "sight-custom-clef";
  for (const c of ["treble", "bass", "grand"]) {
    const o = document.createElement("option");
    o.value = c;
    o.textContent = c;
    clefSelect.appendChild(o);
  }
  const lowSelect = document.createElement("select");
  lowSelect.className = "sight-custom-low";
  const highSelect = document.createElement("select");
  highSelect.className = "sight-custom-high";
  for (let m = KEY_LOW; m <= KEY_HIGH; m++) {
    for (const sel of [lowSelect, highSelect]) {
      const o = document.createElement("option");
      o.value = String(m);
      o.textContent = noteName(m);
      sel.appendChild(o);
    }
  }
  const accInput = document.createElement("input");
  accInput.type = "checkbox";
  accInput.className = "sight-custom-acc";
  customBox.append(
    labelled("Clef", clefSelect),
    labelled("Low", lowSelect),
    labelled("High", highSelect),
    labelled("Accidentals", accInput),
  );

  function readCustom(): CustomRange {
    return normalizeCustom({
      clef: clefSelect.value as Clef,
      low: Number(lowSelect.value),
      high: Number(highSelect.value),
      accidentals: accInput.checked,
    });
  }

  function writeCustom(): void {
    clefSelect.value = custom.clef;
    lowSelect.value = String(custom.low);
    highSelect.value = String(custom.high);
    accInput.checked = custom.accidentals;
  }

  for (const level of LEVELS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn sight-level";
    b.setAttribute("data-level", level.id);
    b.setAttribute("aria-pressed", "false");
    b.textContent = level.title;
    if (level.node) b.title = level.node + " " + level.title;
    b.addEventListener("click", () => pick(level.id));
    levelButtons.set(level.id, b);
    levelsEl.appendChild(b);
  }
  levelsEl.appendChild(customBox);

  function addressParams(): SightParams {
    const p: SightParams = { level: selectedId };
    if (params.plan !== undefined) p.plan = params.plan;
    if (params.tags !== undefined) p.tags = params.tags;
    if (selectedId === "custom") {
      p.clef = custom.clef;
      p.low = custom.low;
      p.high = custom.high;
      p.acc = custom.accidentals;
    }
    return p;
  }

  function pick(id: string): void {
    if (controller.running()) return;
    params = paramsAfterPick(params, id);
    selectedId = id;
    history.replaceState(null, "", sightHash(addressParams()));
    renderControls();
    clearHistory();
    reloadHistory();
    ladderNotice();
  }

  function onCustomChange(el: HTMLElement): void {
    custom = readCustom();
    writeCustom();
    el.blur();
    if (selectedId === "custom") history.replaceState(null, "", sightHash(addressParams()));
  }
  for (const el of [clefSelect, lowSelect, highSelect, accInput]) {
    el.addEventListener("change", () => onCustomChange(el));
  }

  // Key strip
  const spots = keyLayout(KEY_LOW, KEY_HIGH);
  for (const spot of [...spots.filter((s) => !s.black), ...spots.filter((s) => s.black)]) {
    const key = document.createElement("div");
    key.className = spot.black ? "sight-key black" : "sight-key white";
    key.setAttribute("data-midi", String(spot.midi));
    key.style.left = `${spot.left}%`;
    key.style.width = `${spot.width}%`;
    keysEl.appendChild(key);
    keyEls.set(spot.midi, key);
  }

  function paintKey(midi: number): void {
    const el = keyEls.get(midi);
    if (!el) return;
    el.classList.toggle("pressed", pressed.has(midi));
    el.classList.toggle("wrong", wrongTimers.has(midi));
    el.classList.toggle("hint", hintKeys.includes(midi));
  }

  function paintAllKeys(): void {
    for (const midi of keyEls.keys()) paintKey(midi);
  }

  function flashWrong(midi: number): void {
    const old = wrongTimers.get(midi);
    if (old !== undefined) window.clearTimeout(old);
    wrongTimers.set(
      midi,
      window.setTimeout(() => {
        wrongTimers.delete(midi);
        paintKey(midi);
      }, WRONG_FLASH_MS),
    );
    paintKey(midi);
  }

  function setHint(notes: number[]): void {
    const old = hintKeys;
    hintKeys = notes;
    for (const m of old) paintKey(m);
    for (const m of notes) paintKey(m);
  }

  // OSMD
  function drawCard(card: Card, marks: XmlMarks): Promise<void> {
    const run = renderChain.then(() => doRender(card, marks));
    renderChain = run.catch(() => undefined);
    return run;
  }

  async function doRender(card: Card, marks: XmlMarks): Promise<void> {
    let mod: OsmdModule;
    try {
      mod = await loadOsmd();
    } catch (e) {
      osmdFailed = true;
      setStatus("Could not load the notation library: " + messageOf(e));
      renderControls();
      throw e;
    }
    if (!osmd) {
      const host = document.createElement("div");
      host.className = "sight-osmd";
      staffEl.replaceChildren(host);
      osmd = new mod.OpenSheetMusicDisplay(host, {
        backend: "svg",
        autoResize: false,
        drawTitle: false,
        drawSubtitle: false,
        drawComposer: false,
        drawLyricist: false,
        drawCredits: false,
        drawPartNames: false,
        drawMeasureNumbers: false,
      });
      osmd.EngravingRules.PageTopMargin = 1;
      osmd.EngravingRules.PageBottomMargin = 1;
    }
    const style = getComputedStyle(document.documentElement);
    const colors = {
      done: cssColour(style, "--color-mark-hit", DEFAULT_XML_COLORS.done),
      wrong: cssColour(style, "--color-mark-wrong", DEFAULT_XML_COLORS.wrong),
    };
    const strip = currentLevel().kind !== "bars";
    const fit = staffLayout(staffEl.clientWidth, currentLevel().kind);
    staffEl.classList.toggle("strip", strip);
    let restore: string | null = null;
    if (strip) {
      const cards = controller.cards();
      if (card.index === 0) stripStartIdx = 0;
      stripStartIdx = stripStart(stripStartIdx, card.index, cards.length);
      restore = cssColour(style, "--color-accent", "#2f6fdd");
      await osmd.load(stripXml(cards, stripStartIdx, card.index, marks, { ...colors, current: restore }));
      osmd.EngravingRules.RenderXMeasuresPerLineAkaSystem = fit.perLine;
      osmd.Zoom = fit.zoom;
    } else {
      await osmd.load(cardXml(card, { ...marks, colors }));
      osmd.EngravingRules.RenderXMeasuresPerLineAkaSystem = 0;
      osmd.Zoom = fit.zoom;
    }
    osmd.render();
    const off = wrongNoteOffset(card, marks);
    if (off !== null) drawWrongHead(off, colors.wrong, restore);
    if (card.index === 0 && controller.running()) revealKeys();
  }

  function revealKeys(): void {
    const view = section;
    const delta = keysScrollDelta(keysEl.getBoundingClientRect().bottom, view.getBoundingClientRect().bottom);
    if (delta > 0) view.scrollTop += delta;
  }

  function drawWrongHead(
    off: { halfSpaces: number; accidental: "sharp" | "flat" | "natural" | null },
    wrongColour: string,
    restoreColour: string | null,
  ): void {
    const root = staffEl.querySelector(".sight-osmd");
    if (!root) return;
    const matches = [...root.querySelectorAll("path, g")].filter((el) => {
      const s = (el as SVGElement).style;
      return [el.getAttribute("fill"), el.getAttribute("stroke"), s ? s.fill : ""].some(
        (v) => (v ?? "").toLowerCase() === WRONG_ANCHOR_COLOR,
      );
    }) as SVGGraphicsElement[];
    const anchor =
      matches.find((el) => el.tagName.toLowerCase() === "path" && el.closest("g[class*='vf-notehead']")) ??
      matches.find((el) => el.tagName.toLowerCase() === "path");
    if (!anchor || !anchor.parentNode) return;
    const ink = getComputedStyle(document.documentElement).getPropertyValue("--color-ink").trim() || "#000000";
    const paint = (el: Element, colour: string) => {
      for (const e of [el, ...el.querySelectorAll("*")]) {
        if (e.hasAttribute("fill")) e.setAttribute("fill", colour);
        if (e.hasAttribute("stroke")) e.setAttribute("stroke", colour);
        const st = (e as SVGElement).style;
        if (st && st.fill) st.fill = colour;
        if (st && st.stroke) st.stroke = colour;
      }
    };
    const bbox = anchor.getBBox();
    const space = bbox.height;
    const dy = (-off.halfSpaces * space) / 2;
    const ns = "http://www.w3.org/2000/svg";
    const g = document.createElementNS(ns, "g");
    g.setAttribute("class", "sight-wrong-head");
    g.setAttribute("transform", `translate(0 ${dy})`);
    const copy = anchor.cloneNode(true) as SVGGraphicsElement;
    paint(copy, wrongColour);
    g.appendChild(copy);
    if (off.accidental) {
      const t = document.createElementNS(ns, "text");
      t.setAttribute("class", "sight-wrong-acc");
      t.setAttribute("fill", wrongColour);
      t.setAttribute("x", String(bbox.x - space * 1.3));
      t.setAttribute("y", String(bbox.y + bbox.height * 0.85));
      t.setAttribute("font-size", String(space * 1.8));
      t.textContent = off.accidental === "sharp" ? "♯" : off.accidental === "flat" ? "♭" : "♮";
      g.appendChild(t);
    }
    paint(anchor, restoreColour ?? ink);
    anchor.parentNode.insertBefore(g, anchor.nextSibling);
  }

  function onRenderError(message: string): void {
    if (osmdFailed) return;
    setStatus("Could not draw the card: " + message);
    osmd = null;
    const host = document.createElement("div");
    host.className = "sight-osmd";
    const cards = controller.cards();
    const card = cards[Math.min(controller.status().card, cards.length - 1)];
    host.textContent = card ? card.steps.flatMap((s) => s.pitches.map((m) => noteName(m))).join(" ") : "";
    staffEl.replaceChildren(host);
  }

  // History
  function clearHistory(): void {
    rounds = [];
    renderSightHistory(historyEl, [], currentLevel());
  }

  function paintLadder(plan: PlanResponse): void {
    for (const level of LEVELS) {
      const b = levelButtons.get(level.id);
      if (!b || level.node === null) continue;
      b.querySelector(".sight-level-state")?.remove();
      const span = document.createElement("span");
      span.className = "sight-level-state";
      span.textContent = levelText(plan.tree, level.node, plan.state);
      b.append(" ", span);
      const lock = lockText(plan.tree, level.node, plan.state);
      b.title = level.node + " " + level.title + (lock ? " - " + lock : "");
      b.classList.toggle("locked", isLocked(plan.tree, level.node, plan.state));
    }
  }

  function ladderNotice(): void {
    const level = currentLevel();
    if (planTree && level.node !== null && !treeHasDrill(planTree, level.drill)) {
      setStatus("Rounds are saved, but they only count toward skills after you run: uv run coach sight add-drills");
    }
  }

  function loadPlan(): void {
    if (!opts.fetchPlan) return;
    opts
      .fetchPlan()
      .then((plan) => {
        planTree = plan.tree;
        paintLadder(plan);
        ladderNotice();
      })
      .catch(() => undefined);
  }

  function reloadHistory(): void {
    const mine = ++historyToken;
    opts
      .fetchHistory(selectedId)
      .then((h) => {
        if (mine !== historyToken) return;
        rounds = h.rounds;
        renderSightHistory(historyEl, rounds, currentLevel());
      })
      .catch((e: unknown) => {
        if (mine === historyToken) setStatus("History not available: " + messageOf(e));
      });
  }

  // Controls and stats
  function renderControls(): void {
    const running = controller.running();
    startBtn.disabled = running || osmdFailed;
    stopBtn.disabled = !running;
    for (const [id, b] of levelButtons) {
      b.setAttribute("aria-pressed", String(id === selectedId));
      b.disabled = running;
    }
    levelNameEl.textContent = (running ? controller.level() ?? currentLevel() : currentLevel()).title;
    customBox.hidden = selectedId !== "custom";
    for (const el of [clefSelect, lowSelect, highSelect, accInput]) el.disabled = running;
  }

  function renderStats(): void {
    const running = controller.running();
    const level = running ? controller.level() ?? currentLevel() : currentLevel();
    const st = controller.status();
    const total = running ? controller.cards().length : level.cards;
    const stats = roundStats(controller.records());
    const m = stageModel(running ? st.card + 1 : null, total, stats, st.lastMs, level.kind, IDLE_HINT);
    progressTextEl.textContent = m.progress;
    progressEl.hidden = !running;
    progressEl.setAttribute("aria-valuemax", String(m.total));
    progressEl.setAttribute("aria-valuenow", String(m.done));
    progressFillEl.style.width = `${m.percent}%`;
    statsEl.title = running ? liveStatsText(st.card + 1, total, stats, st.lastMs) : "";
    const parts: HTMLElement[] = m.chips.map((chip) => {
      const el = document.createElement("span");
      el.className = "sight-chip";
      el.classList.add("tone-" + chip.tone);
      const label = document.createElement("span");
      label.className = "sight-chip-label";
      label.textContent = chip.label;
      const value = document.createElement("span");
      value.className = "sight-chip-value";
      value.textContent = chip.value;
      el.append(label, value);
      return el;
    });
    if (m.hint !== "") {
      const hint = document.createElement("span");
      hint.className = "sight-hint";
      hint.textContent = m.hint;
      parts.push(hint);
    }
    statsEl.replaceChildren(...parts);
  }

  function onChange(): void {
    renderControls();
    renderStats();
  }

  const controller = createSightController({
    now: opts.now ?? (() => performance.now()),
    wallIso: () => new Date().toISOString(),
    render: drawCard,
    postAttempt: opts.postAttempt,
    onChange,
    onRenderError,
    onSaved: (ok, msg) => {
      if (ok) {
        setStatus("Round saved.");
        reloadHistory();
      } else {
        opts.onToast?.("Round not saved: " + (msg ?? ""));
      }
    },
  });

  // Summary
  function hideSummary(): void {
    summaryEl.hidden = true;
    summaryEl.replaceChildren();
  }

  function showSummary(
    records: readonly SightStepRecord[],
    level: LevelDef,
    complete: boolean,
    cardsDone: number,
    cardsTotal: number,
  ): void {
    const model = summaryModel(records, level, rounds, complete, cardsDone, cardsTotal);
    const h = document.createElement("h3");
    h.textContent = "Round summary";
    const dl = document.createElement("dl");
    for (const [k, v] of model.rows) {
      const dt = document.createElement("dt");
      dt.textContent = k;
      const dd = document.createElement("dd");
      dd.textContent = v;
      dl.append(dt, dd);
    }
    const lines = [model.best, model.worst, model.clean].map((t) => {
      const p = document.createElement("p");
      p.textContent = t;
      return p;
    });
    const again = document.createElement("button");
    again.type = "button";
    again.className = "btn btn-primary";
    again.textContent = "Again";
    again.addEventListener("click", () => startRound());
    const close = document.createElement("button");
    close.type = "button";
    close.className = "btn";
    close.textContent = "Close";
    close.addEventListener("click", () => hideSummary());
    const actions = document.createElement("div");
    actions.className = "sight-summary-actions";
    actions.append(again, close);
    summaryEl.replaceChildren(h, dl, ...lines, actions);
    summaryEl.hidden = false;
  }

  function clearCard(): void {
    const run = renderChain.then(() => {
      osmd = null;
      staffEl.replaceChildren();
      staffEl.classList.remove("strip");
    });
    renderChain = run.catch(() => undefined);
  }

  function endRound(): void {
    clearCard();
    setHint([]);
    renderControls();
    renderStats();
  }

  function finish(end: SightEnd): void {
    const level = controller.level() ?? currentLevel();
    const r = controller.finish(end);
    endRound();
    if (r === null) {
      setStatus("Nothing played, round not saved.");
      return;
    }
    if (end !== "interrupted") showSummary(r.records, level, end === "done", r.cardsDone, r.cardsTotal);
  }

  function startRound(): void {
    if (controller.running() || osmdFailed) return;
    const level = currentLevel();
    setStatus("");
    hideSummary();
    setHint([]);
    const weights =
      level.kind === "bars" ? undefined : noteWeights(noteMap(roundsOfLevel(rounds, level.id, 20)), level.kind);
    controller.start({
      level,
      custom: level.id === "custom" ? readCustom() : null,
      seed: Date.now() >>> 0,
      weights,
      planId: params.plan ?? null,
      tags: params.tags ?? [],
    });
    renderControls();
  }

  startBtn.addEventListener("click", startRound);
  stopBtn.addEventListener("click", () => {
    if (controller.running()) finish("stop");
  });
  backBtn.addEventListener("click", () => opts.onBack());

  // Engine events
  opts.engine.onEvent((ev) => {
    if (section.hidden) return;
    if (ev.type === "note_on" && ev.velocity > 0) pressed.add(ev.note);
    else if (ev.type === "note_off" || (ev.type === "note_on" && ev.velocity === 0)) pressed.delete(ev.note);
    else return;
    paintKey(ev.note);
    if (!controller.running()) return;
    const effects = controller.handle(ev);
    for (const e of effects) {
      if (e.kind === "wrong") flashWrong(e.note);
      else if (e.kind === "hint") setHint(e.notes);
      else if (e.kind === "card") setHint([]);
      else if (e.kind === "done") {
        endRound();
        const cards = controller.cards();
        showSummary(controller.records(), controller.level() ?? currentLevel(), true, cards.length, cards.length);
      }
    }
    renderControls();
  });

  function clearKeys(): void {
    pressed.clear();
    for (const t of wrongTimers.values()) window.clearTimeout(t);
    wrongTimers.clear();
    hintKeys = [];
    paintAllKeys();
  }

  renderControls();
  renderStats();

  return {
    show(p) {
      const wasVisible = !section.hidden;
      params = p;
      section.hidden = false;
      const next = nextShow({ visible: wasVisible, running: controller.running(), selectedId }, p, (x) => !!levelById(x));
      const note = next.unknown !== null ? `Unknown level '${next.unknown}', showing Treble C-G notes` : null;
      if (next.interrupt) finish("interrupted");
      if (!controller.running()) selectedId = next.selectedId;
      custom = normalizeCustom({
        clef: p.clef ?? custom.clef,
        low: p.low ?? custom.low,
        high: p.high ?? custom.high,
        accidentals: p.acc ?? custom.accidentals,
      });
      writeCustom();
      setStatus(note ?? "");
      renderControls();
      renderStats();
      loadOsmd().catch((e: unknown) => {
        osmdFailed = true;
        setStatus("Could not load the notation library: " + messageOf(e));
        renderControls();
      });
      clearHistory();
      reloadHistory();
      loadPlan();
    },
    hide() {
      if (controller.running()) finish("interrupted");
      hideSummary();
      clearKeys();
      section.hidden = true;
    },
    visible() {
      return !section.hidden;
    },
    escape() {
      if (controller.running()) finish("stop");
      else if (!summaryEl.hidden) hideSummary();
      else opts.onBack();
    },
    running() {
      return controller.running();
    },
  };
}
