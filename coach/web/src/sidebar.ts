import { ApiError, fetchCurrentJob, fetchPlan, fetchScores, removeScore, startDownload, startSetup } from "./api";
import type { Job, Score, ScoreList, SetupStep, SourceStatus } from "./api";
import {
  EMPTY_LIBRARY,
  IN_LIBRARY_MARK,
  JOB_POLL_MS,
  NOT_DOWNLOADED_HINT,
  NO_MATCHES_MESSAGE,
  REMOVE_ASK_MS,
  REMOVE_ASK_TEXT,
  REMOVE_ICON,
  STEP_BUTTON_TEXT,
  STEP_DONE_TEXT,
  canConfirmRemove,
  difficultyLabel,
  displayComposer,
  displayTitle,
  downloadLabel,
  drillOrder,
  filterOptions,
  isTyping,
  jobFinished,
  listHint,
  listState,
  progressText,
  removeAskLabel,
  removeLabel,
  removeMode,
  rowMode,
  setupHeading,
  setupOffers,
  sourceLabel,
  stepMode,
  tabCounts,
  tabLabel,
  tabScores,
} from "./library-logic";
import type { LibraryTab, Option } from "./library-logic";
import { searchesSources } from "./source-query";

export interface SidebarHandlers {
  onPick(score: Score): void;
  onOpenChange(open: boolean): void;
  onResult(list: ScoreList | null, error: string | null): void;
}

export interface Sidebar {
  open(): void;
  close(): void;
  toggle(): void;
  isOpen(): boolean;
  refresh(): Promise<void>;
  setCurrent(id: string | null): void;
}

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error("Missing element #" + id);
  return el as T;
}

function span(cls: string, text: string): HTMLSpanElement {
  const el = document.createElement("span");
  el.className = cls;
  el.textContent = text;
  return el;
}

function errText(e: unknown): string {
  return e instanceof ApiError ? e.message : String(e);
}

export function createSidebar(handlers: SidebarHandlers): Sidebar {
  const panel = byId<HTMLElement>("library");
  const toggleButton = byId<HTMLElement>("library-toggle");
  const search = byId<HTMLInputElement>("library-search");
  const selDifficulty = byId<HTMLSelectElement>("filter-difficulty");
  const selKey = byId<HTMLSelectElement>("filter-key");
  const selTime = byId<HTMLSelectElement>("filter-time");
  const sourcesEl = byId<HTMLElement>("library-sources");
  const status = byId<HTMLElement>("library-status");
  const listEl = byId<HTMLElement>("library-list");
  const tabButtons = [byId<HTMLButtonElement>("tab-pieces"), byId<HTMLButtonElement>("tab-drills")];

  function loadTab(): LibraryTab {
    try {
      return localStorage.getItem("rp.libraryTab") === "drills" ? "drills" : "pieces";
    } catch {
      return "pieces";
    }
  }

  let tab: LibraryTab = loadTab();
  let order = new Map<string, number>();
  let planFetched = false;
  let isOpen = false;
  let counter = 0;
  let currentId: string | null = null;
  let debounce: number | undefined;
  let lastList: ScoreList | null = null;
  let job: Job | null = null;
  let polling = false;
  let loading = false;
  const rowErrors = new Map<string, string>();
  const setupErrors = new Map<string, string>();
  let askingId: string | null = null;
  let askTimer: number | undefined;
  let removingId: string | null = null;
  let askedAt = 0;

  function jobRunning(): boolean {
    return job !== null && job.state === "running";
  }

  function fillSelect(select: HTMLSelectElement, options: Option[]): void {
    const chosen = select.value;
    select.textContent = "";
    for (const o of options) {
      const opt = document.createElement("option");
      opt.value = o.value;
      opt.textContent = o.label;
      select.append(opt);
    }
    select.value = options.some((o) => o.value === chosen) ? chosen : "";
  }

  function markCurrent(): void {
    for (const btn of listEl.querySelectorAll<HTMLElement>(".library-item:not(.remote)")) {
      btn.classList.toggle("current", btn.dataset.id === currentId);
    }
  }

  function paintRemove(rb: HTMLButtonElement, score: Score, asking: boolean): void {
    rb.classList.toggle("asking", asking);
    rb.textContent = asking ? REMOVE_ASK_TEXT : REMOVE_ICON;
    rb.setAttribute("aria-label", asking ? removeAskLabel(score) : removeLabel(score));
    rb.title = asking ? removeAskLabel(score) : removeLabel(score);
  }

  function stopAsking(): void {
    window.clearTimeout(askTimer);
    askTimer = undefined;
    if (askingId === null) return;
    askingId = null;
    for (const b of listEl.querySelectorAll<HTMLButtonElement>(".item-remove.asking")) {
      const score = lastList ? lastList.scores.find((x) => x.id === b.dataset.id) : undefined;
      if (score) {
        paintRemove(b, score, false);
      } else {
        b.classList.remove("asking");
        b.textContent = REMOVE_ICON;
      }
    }
  }

  function onRemoveClick(score: Score, rb: HTMLButtonElement): void {
    if (rb.disabled) return;
    if (askingId === score.id) {
      if (!canConfirmRemove(askedAt, performance.now())) return;
      stopAsking();
      void removeRow(score.id);
      return;
    }
    stopAsking();
    askingId = score.id;
    askedAt = performance.now();
    paintRemove(rb, score, true);
    askTimer = window.setTimeout(() => stopAsking(), REMOVE_ASK_MS);
  }

  async function removeRow(id: string): Promise<void> {
    rowErrors.delete(id);
    removingId = id;
    if (lastList) renderList(lastList, true);
    try {
      await removeScore(id);
    } catch (e) {
      removingId = null;
      rowErrors.set(id, errText(e));
      if (lastList) renderList(lastList, true);
      return;
    }
    removingId = null;
    await refresh(true);
  }

  async function download(id: string): Promise<void> {
    stopAsking();
    rowErrors.delete(id);
    try {
      job = await startDownload(id);
    } catch (e) {
      rowErrors.set(id, errText(e));
      if (lastList) renderList(lastList, true);
      return;
    }
    if (lastList) renderList(lastList, true);
    void pollJob();
  }

  async function setup(source: string, step: string): Promise<void> {
    stopAsking();
    setupErrors.delete(source);
    try {
      job = await startSetup(source, step);
    } catch (e) {
      setupErrors.set(source, errText(e));
      renderSources();
      return;
    }
    if (lastList) renderList(lastList, true);
    void pollJob();
  }

  function renderRow(score: Score, list: ScoreList, typing: boolean): HTMLLIElement {
    const li = document.createElement("li");
    const parts = [
      span("item-title", displayTitle(score)),
      span("item-composer", displayComposer(score)),
      span("item-difficulty", difficultyLabel(score.difficulty)),
    ];
    if (score.has_file) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "library-item";
      btn.dataset.id = score.id;
      btn.append(...parts);
      if (typing) {
        btn.append(span("item-source", sourceLabel(score.source, list.sources)), span("item-have", IN_LIBRARY_MARK));
      }
      btn.addEventListener("click", () => handlers.onPick(score));
      li.append(btn);
      const rmode = removeMode(score, askingId, removingId, job);
      if (rmode === "removing") {
        const busy = span("item-remove busy", "");
        busy.setAttribute("aria-label", "Removing");
        busy.append(span("spinner", ""));
        li.append(busy);
      } else if (rmode !== "hidden") {
        const rb = document.createElement("button");
        rb.type = "button";
        rb.className = "item-remove";
        rb.dataset.id = score.id;
        rb.disabled = rmode === "disabled";
        paintRemove(rb, score, rmode === "asking");
        rb.addEventListener("click", (ev) => {
          ev.stopPropagation();
          onRemoveClick(score, rb);
        });
        li.append(rb);
      }
      const rerr = rowErrors.get(score.id);
      if (rerr) li.append(span("item-error", rerr));
      return li;
    }
    const row = document.createElement("div");
    row.className = "library-item remote";
    row.dataset.id = score.id;
    row.title = NOT_DOWNLOADED_HINT;
    row.append(...parts, span("item-source", sourceLabel(score.source, list.sources)));
    const mode = rowMode(score, job);
    if (mode === "download") {
      const dl = document.createElement("button");
      dl.type = "button";
      dl.className = "item-download";
      dl.textContent = "↓";
      dl.setAttribute("aria-label", downloadLabel(score));
      dl.disabled = jobRunning() || removingId !== null;
      dl.addEventListener("click", (ev) => {
        ev.stopPropagation();
        void download(score.id);
      });
      row.append(dl);
    } else if (mode === "downloading") {
      const busy = span("item-download busy", "");
      busy.setAttribute("aria-label", "Downloading");
      busy.append(span("spinner", ""));
      row.append(busy);
    }
    const err = rowErrors.get(score.id);
    if (err) row.append(span("item-error", err));
    li.append(row);
    return li;
  }

  function renderStep(s: SourceStatus, step: SetupStep): HTMLLIElement {
    const li = document.createElement("li");
    li.className = "setup-step";
    li.append(span("step-title", step.title), span("step-detail", step.detail));
    const mode = stepMode(s.name, step, job);
    if (mode === "done") {
      li.append(span("step-done", STEP_DONE_TEXT));
    } else if (mode === "running") {
      const matches =
        job !== null && job.state === "running" && job.kind === "setup" && job.source === s.name && job.target === step.id;
      li.append(span("spinner", ""), span("step-progress", matches && job ? progressText(job) : "Working…"));
    } else {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn step-get";
      btn.textContent = STEP_BUTTON_TEXT;
      btn.setAttribute("aria-label", `${STEP_BUTTON_TEXT}: ${s.label} ${step.title}`);
      btn.disabled = jobRunning() || removingId !== null;
      btn.addEventListener("click", () => void setup(s.name, step.id));
      li.append(btn);
    }
    return li;
  }

  function renderSources(): void {
    sourcesEl.textContent = "";
    if (!lastList) return;
    for (const s of setupOffers(lastList.sources, searchesSources(search.value))) {
      const section = document.createElement("section");
      section.className = "source-setup";
      const h = document.createElement("h3");
      h.textContent = setupHeading(s);
      section.append(h);
      if (s.error) section.append(span("item-error", s.error));
      const ul = document.createElement("ul");
      ul.className = "setup-steps";
      for (const step of s.steps) ul.append(renderStep(s, step));
      section.append(ul);
      const se = setupErrors.get(s.name);
      if (se) section.append(span("item-error", se));
      sourcesEl.append(section);
    }
  }

  async function pollJob(): Promise<void> {
    if (polling) return;
    polling = true;
    try {
      while (jobRunning()) {
        await new Promise((resolve) => window.setTimeout(resolve, JOB_POLL_MS));
        const prev = job;
        try {
          job = await fetchCurrentJob();
        } catch (e) {
          job = null;
          if (lastList) renderList(lastList, true);
          status.textContent = errText(e);
          break;
        }
        if (jobFinished(prev, job)) {
          if (job && job.state === "error" && job.error) {
            if (job.kind === "download") rowErrors.set(job.target, job.error);
            else setupErrors.set(job.source, job.error);
          }
          await refresh(true);
          break;
        }
        if (job && job.kind === "setup" && lastList && !loading) renderList(lastList, true);
        else renderSources();
      }
    } finally {
      polling = false;
    }
  }

  function paintTabs(list: ScoreList | null): void {
    const counts = list ? tabCounts(list.scores) : null;
    for (const b of tabButtons) {
      const t = b.dataset.tab as LibraryTab;
      b.classList.toggle("active", t === tab);
      b.setAttribute("aria-selected", String(t === tab));
      b.textContent = counts ? tabLabel(t, counts[t]) : t === "pieces" ? "Pieces" : "Drills";
    }
  }

  function renderList(list: ScoreList, keepScroll = false): void {
    lastList = list;
    paintTabs(list);
    const typing = isTyping(search.value);
    const top = listEl.scrollTop;
    listEl.textContent = "";
    status.textContent = "";
    renderSources();
    const state = listState(list, typing);
    if (state === "empty-library") {
      const hiddenHint = listHint(list, 0, typing);
      if (hiddenHint) {
        status.textContent = hiddenHint;
        return;
      }
      const h = document.createElement("h2");
      h.textContent = EMPTY_LIBRARY.heading;
      const p = document.createElement("p");
      p.textContent = EMPTY_LIBRARY.text;
      const code = document.createElement("code");
      code.textContent = EMPTY_LIBRARY.command;
      const after = document.createElement("p");
      after.textContent = EMPTY_LIBRARY.after;
      status.append(h, p, code, after);
      return;
    }
    if (state === "no-matches") {
      status.textContent = NO_MATCHES_MESSAGE;
      return;
    }
    const shown = tabScores(list.scores, tab, order);
    if (shown.length === 0) {
      const filtered = typing || selDifficulty.value !== "" || selKey.value !== "" || selTime.value !== "";
      status.textContent = listHint(list, 0, typing) || (filtered ? NO_MATCHES_MESSAGE : tab === "drills" ? "No drills here yet." : "No pieces here yet.");
      return;
    }
    status.textContent = listHint(list, shown.length, typing);
    for (const score of shown) listEl.append(renderRow(score, list, searchesSources(search.value)));
    markCurrent();
    if (keepScroll) listEl.scrollTop = top;
  }

  async function checkJob(): Promise<void> {
    if (polling) return;
    try {
      const current = await fetchCurrentJob();
      if (!polling && current && current.state === "running") {
        job = current;
        if (lastList) renderList(lastList, true);
        void pollJob();
      }
    } catch {
      // a missing job status must not break the list
    }
  }

  async function refresh(keepScroll = false): Promise<void> {
    const mine = ++counter;
    loading = true;
    status.textContent = "Loading…";
    try {
      const list = await fetchScores({
        q: search.value,
        difficulty: selDifficulty.value,
        key: selKey.value,
        time: selTime.value,
      });
      if (mine !== counter) return;
      loading = false;
      const opts = filterOptions(list.facets);
      fillSelect(selDifficulty, opts.difficulty);
      fillSelect(selKey, opts.key);
      fillSelect(selTime, opts.time);
      renderList(list, keepScroll);
      handlers.onResult(list, null);
      await checkJob();
    } catch (e) {
      if (mine !== counter) return;
      loading = false;
      const message = errText(e);
      listEl.textContent = "";
      status.textContent = message;
      handlers.onResult(null, message);
    }
  }

  function open(): void {
    isOpen = true;
    panel.classList.add("open");
    panel.inert = false;
    search.focus();
    void refresh();
    if (!planFetched) {
      planFetched = true;
      fetchPlan()
        .then((plan) => {
          order = drillOrder(plan);
          if (lastList) renderList(lastList, true);
        })
        .catch(() => {
          // a missing plan only leaves drills in id order
        });
    }
    handlers.onOpenChange(true);
  }

  function close(): void {
    stopAsking();
    if (!isOpen) return;
    isOpen = false;
    panel.classList.remove("open");
    panel.inert = true;
    handlers.onOpenChange(false);
  }

  document.addEventListener("pointerdown", (e) => {
    if (!isOpen) return;
    const target = e.target as Node | null;
    if (!target || panel.contains(target) || toggleButton.contains(target)) return;
    close();
  });

  document.addEventListener(
    "pointerdown",
    (e) => {
      if (askingId === null) return;
      const t = e.target;
      if (t instanceof Element && t.closest(".item-remove.asking")) return;
      stopAsking();
    },
    true,
  );

  window.addEventListener("focus", () => void checkJob());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void checkJob();
  });

  search.addEventListener("input", () => {
    window.clearTimeout(debounce);
    debounce = window.setTimeout(() => void refresh(), 200);
  });
  paintTabs(null);
  for (const b of tabButtons) {
    b.addEventListener("click", () => {
      tab = b.dataset.tab as LibraryTab;
      try {
        localStorage.setItem("rp.libraryTab", tab);
      } catch {
        // missing storage must not break the tabs
      }
      if (lastList) renderList(lastList, false);
      else paintTabs(null);
    });
  }
  for (const sel of [selDifficulty, selKey, selTime]) {
    sel.addEventListener("change", () => void refresh());
  }

  return {
    open,
    close,
    toggle() {
      if (isOpen) close();
      else open();
    },
    isOpen: () => isOpen,
    refresh: () => refresh(),
    setCurrent(id) {
      currentId = id;
      markCurrent();
    },
  };
}
