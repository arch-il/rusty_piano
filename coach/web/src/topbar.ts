import type { Score } from "./api";
import { barLabel, detailRows, displayComposer, displayTitle } from "./library-logic";
import { formatZoom } from "./score-geometry";
import { sliderStep } from "./practice-ui";
import type { Hands } from "./practice-steps";

type Mode = "wait" | "live";

export interface TopBarHandlers {
  onToggleLibrary(): void;
  onZoomIn(): void;
  onZoomOut(): void;
  onZoomReset(): void;
  onCursorStart(): void;
  onCursorPrev(): void;
  onCursorNext(): void;
  onFollowToggle(): void;
  onModeChange(mode: Mode): void;
  onHandsChange(hands: Hands): void;
  onTempoInput(percent: number): void;
  onLoopToggle(): void;
  onRampToggle(): void;
  onAutoplayToggle(): void;
  onSummaryAgain(): void;
  onSummaryClose(): void;
}

export interface TopBar {
  setScore(score: Score | null): void;
  setZoom(z: number): void;
  setCursor(bar: number | null, total: number): void;
  setLibraryOpen(open: boolean): void;
  closeInfo(): void;
  setEngine(state: "connecting" | "connected" | "disconnected", tooltip: string): void;
  pulseEngine(): void;
  setFollow(button: string, status: string, enabled: boolean): void;
  setTempoRange(min: number, max: number, step: number): void;
  setPractice(p: {
    mode: Mode;
    hands: Hands;
    percent: number;
    tempoText: string;
    loop: boolean;
    ramp: boolean;
    autoplay: boolean;
    locked: boolean;
    autoplayOff?: boolean;
    startOff?: boolean;
  }): void;
  setMetrics(m: { accuracy: string; tempo: string; wrong: string; missed: string; timing?: string }): void;
  showSummary(title: string, rows: [string, string][]): void;
  hideSummary(): void;
  summaryOpen(): boolean;
}

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error("Missing element #" + id);
  return el as T;
}

export function createTopBar(handlers: TopBarHandlers): TopBar {
  const libraryToggle = byId<HTMLButtonElement>("library-toggle");
  const title = byId<HTMLElement>("piece-title");
  const composer = byId<HTMLElement>("piece-composer");
  const infoToggle = byId<HTMLButtonElement>("info-toggle");
  const popover = byId<HTMLElement>("info-popover");
  const infoList = byId<HTMLElement>("info-list");
  const zoomReset = byId<HTMLElement>("zoom-reset");
  const cursorStatus = byId<HTMLElement>("cursor-status");
  const followToggle = byId<HTMLButtonElement>("follow-toggle");
  const followStatus = byId<HTMLElement>("follow-status");
  const modeWait = byId<HTMLButtonElement>("mode-wait");
  const modeLive = byId<HTMLButtonElement>("mode-live");
  const practiceToggle = byId<HTMLButtonElement>("practice-toggle");
  const practice = practiceToggle.parentElement as HTMLElement;
  const handsSelect = byId<HTMLSelectElement>("hands");
  const tempo = byId<HTMLInputElement>("tempo");
  const tempoValue = byId<HTMLElement>("tempo-value");
  const loopToggle = byId<HTMLButtonElement>("loop-toggle");
  const rampToggle = byId<HTMLButtonElement>("ramp-toggle");
  const autoplayToggle = byId<HTMLButtonElement>("autoplay-toggle");
  const summaryPanel = byId<HTMLElement>("summary-panel");
  const summaryTitle = byId<HTMLElement>("summary-title");
  const summaryList = byId<HTMLElement>("summary-list");
  const engineDot = byId<HTMLElement>("engine-status");
  let tempoStep = Number(tempo.step) || 1;
  engineDot.addEventListener("animationend", () => engineDot.classList.remove("pulse"));

  function closeInfo(): void {
    popover.hidden = true;
    infoToggle.setAttribute("aria-expanded", "false");
    closePractice();
  }

  function closePractice(): void {
    practice.classList.remove("open");
    practiceToggle.setAttribute("aria-expanded", "false");
  }

  libraryToggle.addEventListener("click", () => handlers.onToggleLibrary());
  byId("zoom-in").addEventListener("click", () => handlers.onZoomIn());
  byId("zoom-out").addEventListener("click", () => handlers.onZoomOut());
  zoomReset.addEventListener("click", () => handlers.onZoomReset());
  const cursorStart = byId<HTMLButtonElement>("cursor-start");
  cursorStart.addEventListener("click", () => handlers.onCursorStart());
  byId("cursor-prev").addEventListener("click", () => handlers.onCursorPrev());
  byId("cursor-next").addEventListener("click", () => handlers.onCursorNext());
  followToggle.addEventListener("click", () => {
    handlers.onFollowToggle();
    followToggle.blur();
  });

  for (const [button, mode] of [[modeWait, "wait"], [modeLive, "live"]] as const) {
    button.addEventListener("click", () => {
      handlers.onModeChange(mode);
      button.blur();
    });
  }
  handsSelect.addEventListener("change", () => handlers.onHandsChange(handsSelect.value as Hands));
  tempo.addEventListener("input", () => handlers.onTempoInput(Number(tempo.value)));
  loopToggle.addEventListener("click", () => handlers.onLoopToggle());
  rampToggle.addEventListener("click", () => handlers.onRampToggle());
  autoplayToggle.addEventListener("click", () => handlers.onAutoplayToggle());
  byId("summary-again").addEventListener("click", () => handlers.onSummaryAgain());
  byId("summary-close").addEventListener("click", () => handlers.onSummaryClose());
  practiceToggle.addEventListener("click", () => {
    const open = practice.classList.toggle("open");
    practiceToggle.setAttribute("aria-expanded", String(open));
    if (open) summaryPanel.hidden = true;
  });
  document.addEventListener("pointerdown", (e) => {
    const target = e.target as Node | null;
    if (!target || !practice.classList.contains("open") || practice.contains(target)) return;
    closePractice();
  });

  infoToggle.addEventListener("click", () => {
    const show = popover.hidden;
    popover.hidden = !show;
    infoToggle.setAttribute("aria-expanded", String(show));
  });

  document.addEventListener("pointerdown", (e) => {
    const target = e.target as Node | null;
    if (popover.hidden || !target) return;
    if (popover.contains(target) || infoToggle.contains(target)) return;
    closeInfo();
  });

  return {
    setScore(score) {
      infoList.textContent = "";
      if (!score) {
        title.textContent = "No piece open";
        composer.textContent = "";
        infoToggle.disabled = true;
        document.title = "rusty_piano coach";
        closeInfo();
        return;
      }
      title.textContent = displayTitle(score);
      composer.textContent = displayComposer(score);
      for (const [label, value] of detailRows(score)) {
        const dt = document.createElement("dt");
        dt.textContent = label;
        const dd = document.createElement("dd");
        dd.textContent = value;
        infoList.append(dt, dd);
      }
      infoToggle.disabled = false;
      document.title = displayTitle(score) + " - rusty_piano coach";
    },
    setZoom(z) {
      zoomReset.textContent = formatZoom(z);
    },
    setCursor(bar, total) {
      cursorStatus.textContent = barLabel(bar, total);
    },
    setLibraryOpen(open) {
      libraryToggle.setAttribute("aria-expanded", String(open));
    },
    closeInfo,
    setEngine(state, tooltip) {
      engineDot.classList.toggle("connected", state === "connected");
      engineDot.classList.toggle("connecting", state === "connecting");
      engineDot.title = tooltip;
      engineDot.setAttribute("aria-label", tooltip);
    },
    pulseEngine() {
      engineDot.classList.remove("pulse");
      void engineDot.offsetWidth;
      engineDot.classList.add("pulse");
    },
    setFollow(button, status, enabled) {
      followToggle.textContent = button;
      followToggle.disabled = !enabled;
      followStatus.textContent = status;
    },
    setTempoRange(min, max, step) {
      tempo.min = String(min);
      tempo.max = String(max);
      tempo.step = String(step);
      tempoStep = step;
    },
    setPractice(p) {
      modeWait.setAttribute("aria-pressed", String(p.mode === "wait"));
      modeLive.setAttribute("aria-pressed", String(p.mode === "live"));
      loopToggle.setAttribute("aria-pressed", String(p.loop));
      rampToggle.setAttribute("aria-pressed", String(p.ramp));
      rampToggle.disabled = p.locked || !p.loop;
      rampToggle.title = p.loop ? "Speed up after each clean loop" : "Ramp needs Loop";
      autoplayToggle.setAttribute("aria-pressed", String(p.autoplay));
      handsSelect.value = p.hands;
      tempo.step = sliderStep(p.percent, Number(tempo.min), tempoStep);
      tempo.value = String(p.percent);
      tempoValue.textContent = p.tempoText;
      modeWait.disabled = p.locked;
      modeLive.disabled = p.locked;
      handsSelect.disabled = p.locked;
      tempo.disabled = p.locked;
      loopToggle.disabled = p.locked;
      autoplayToggle.disabled = p.autoplayOff === true;
      cursorStart.disabled = p.startOff === true;
    },
    setMetrics(m) {
      byId("metric-accuracy").textContent = m.accuracy;
      byId("metric-tempo").textContent = m.tempo;
      byId("metric-wrong").textContent = m.wrong;
      byId("metric-missed").textContent = m.missed;
      byId("metric-timing").textContent = m.timing ?? "-";
    },
    showSummary(titleText, rows) {
      summaryTitle.textContent = titleText;
      summaryList.textContent = "";
      for (const [label, value] of rows) {
        const dt = document.createElement("dt");
        dt.textContent = label;
        const dd = document.createElement("dd");
        dd.textContent = value;
        summaryList.append(dt, dd);
      }
      closePractice();
      summaryPanel.hidden = false;
    },
    hideSummary() {
      summaryPanel.hidden = true;
    },
    summaryOpen() {
      return !summaryPanel.hidden;
    },
  };
}
