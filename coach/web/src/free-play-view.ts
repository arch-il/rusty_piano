import type { OpenSheetMusicDisplay } from "opensheetmusicdisplay";
import type { LiveEvent } from "./engine-socket";
import { createSlotHistory, wantsEvent } from "./free-play-slots";
import { KEYS, loadFreeKey, saveFreeKey } from "./free-play-theory";
import type { KV } from "./free-play-theory";
import { fallbackText, freePlayXml, freePlayZoom } from "./free-play-xml";

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

export const FREE_PLAY_HINT = "Play something. Each note or chord shows up here, with its chord name above it.";
export const FREE_PLAY_KEYS_HINT = "No piano? The keys A to K play C4 to C5, Z and X shift the octave.";

export interface FreePlayOptions {
  host: HTMLElement;
  store: KV | null;
  keyboardHint?: boolean;
  now?: () => number;
}

export interface FreePlayView {
  setActive(on: boolean): void;
  active(): boolean;
  handle(ev: LiveEvent): void;
  clear(): void;
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function createFreePlayView(opts: FreePlayOptions): FreePlayView {
  const host = opts.host;
  const history = createSlotHistory();
  let fifths = loadFreeKey(opts.store);
  let isActive = false;
  host.hidden = true;
  let osmd: OpenSheetMusicDisplay | null = null;
  let osmdFailed = false;
  let errorText: string | null = null;
  let rendering = false;
  let dirty = false;
  const now = opts.now ?? (() => performance.now());
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;

  const title = document.createElement("h2");
  title.className = "free-play-title";
  title.textContent = "Free play";

  const select = document.createElement("select");
  select.className = "free-play-key";
  for (const k of KEYS) {
    const option = document.createElement("option");
    option.value = String(k.fifths);
    option.textContent = k.label;
    select.append(option);
  }
  select.value = String(fifths);

  const keyLabel = document.createElement("label");
  keyLabel.className = "free-play-key-label";
  keyLabel.textContent = "Key ";
  keyLabel.append(select);

  const clearBtn = document.createElement("button");
  clearBtn.className = "btn free-play-clear";
  clearBtn.type = "button";
  clearBtn.textContent = "Clear";

  const head = document.createElement("div");
  head.className = "free-play-head";
  head.append(title, keyLabel, clearBtn);

  const status = document.createElement("div");
  status.className = "free-play-status";
  status.setAttribute("aria-live", "polite");

  const staff = document.createElement("div");
  staff.className = "free-play-staff";

  host.replaceChildren(head, status, staff);

  function renderStatus(): void {
    const empty = history.size() === 0;
    const hint = FREE_PLAY_HINT + (opts.keyboardHint ? " " + FREE_PLAY_KEYS_HINT : "");
    status.textContent = [errorText, empty ? hint : null].filter(Boolean).join(" ");
    clearBtn.disabled = empty;
  }

  renderStatus();

  function showFallback(slots: ReturnType<typeof history.slots>): void {
    const div = document.createElement("div");
    div.className = "free-play-fallback";
    div.textContent = fallbackText(slots, fifths);
    staff.replaceChildren(div);
  }

  async function draw(): Promise<void> {
    const slots = history.slots();
    if (osmdFailed) {
      showFallback(slots);
      renderStatus();
      return;
    }
    let mod: OsmdModule;
    try {
      mod = await loadOsmd();
    } catch (e) {
      osmdFailed = true;
      errorText = "Could not load the notation library: " + messageOf(e);
      showFallback(slots);
      renderStatus();
      return;
    }
    if (!osmd) {
      const div = document.createElement("div");
      div.className = "free-play-osmd";
      staff.replaceChildren(div);
      osmd = new mod.OpenSheetMusicDisplay(div, {
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
    }
    try {
      await osmd.load(freePlayXml(slots, fifths));
      osmd.Zoom = freePlayZoom(staff.clientWidth);
      osmd.EngravingRules.RenderXMeasuresPerLineAkaSystem = 0;
      osmd.EngravingRules.RenderSingleHorizontalStaffline = true;
      osmd.render();
      staff.scrollLeft = staff.scrollWidth;
      errorText = null;
    } catch (e) {
      osmd = null;
      errorText = "Could not draw the staff: " + messageOf(e);
      showFallback(slots);
    }
    renderStatus();
  }

  async function pump(): Promise<void> {
    rendering = true;
    try {
      while (dirty && isActive) {
        dirty = false;
        await draw();
      }
    } finally {
      rendering = false;
    }
  }

  function requestRender(): void {
    dirty = true;
    if (!rendering) void pump();
  }

  select.addEventListener("change", () => {
    fifths = Number(select.value);
    saveFreeKey(opts.store, fifths);
    select.blur();
    requestRender();
  });

  clearBtn.addEventListener("click", () => {
    api.clear();
    clearBtn.blur();
  });

  window.addEventListener("resize", () => {
    if (resizeTimer !== null) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeTimer = null;
      if (isActive) requestRender();
    }, 200);
  });

  function setActive(on: boolean): void {
    if (on === isActive) return;
    isActive = on;
    host.hidden = !on;
    if (on) requestRender();
  }

  function active(): boolean {
    return isActive;
  }

  function handle(ev: LiveEvent): void {
    if (!isActive || !wantsEvent(ev)) return;
    if (ev.type === "note_on" && history.noteOn(ev.note, now())) {
      renderStatus();
      requestRender();
    }
  }

  function clear(): void {
    history.clear();
    renderStatus();
    requestRender();
  }

  const api: FreePlayView = { setActive, active, handle, clear };
  return api;
}
