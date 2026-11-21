import {
  createNotesStore,
  markLayout,
  menuLabels,
  toggleHard,
  setBarNote,
  barNote,
  noteCounter,
  placePopup,
  loadMarksVisible,
  saveMarksVisible,
  BAR_NOTE_MAX,
  hardRanges,
  nextRange,
  rangeLabel,
  hardbarsButtonText,
  setPieceNote,
  emptyNotes,
  noteTitle,
} from "./score-notes";
import type { ScoreNotesPayload } from "./score-notes";
import type { KV } from "./fingering-toggle";
import type { ScoreView } from "./score-view";
import type { BarRange } from "./practice-steps";

export interface ScoreNotesDeps {
  view: Pick<ScoreView, "barBoxes" | "noteMarks" | "selection">;
  fetchNotes(id: string): Promise<unknown>;
  saveNotes(id: string, payload: ScoreNotesPayload): Promise<unknown>;
  showError(text: string): void;
  store: KV | null;
  onPractise(range: BarRange): void;
}

export interface ScoreNotesController {
  open(scoreId: string): void;
  close(): void;
  layout(): void;
  contextMenu(info: { bar: number; clientX: number; clientY: number }): void;
  closeMenus(): boolean;
  setEnabled(on: boolean): void;
}

function button(text: string, className: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = className;
  b.textContent = text;
  return b;
}

export function createScoreNotes(deps: ScoreNotesDeps): ScoreNotesController {
  const { view } = deps;
  let visible = loadMarksVisible(deps.store);
  let loadToken = 0;
  let editBar = 0;
  let enabled = false;
  let pieceDirty = false;
  let pieceStatus = "";

  const toggle = document.getElementById("marks-toggle") as HTMLButtonElement;
  toggle.setAttribute("aria-pressed", String(visible));
  toggle.addEventListener("click", () => {
    visible = !visible;
    saveMarksVisible(deps.store, visible);
    toggle.setAttribute("aria-pressed", String(visible));
    renderMarks();
  });

  const hbToggle = document.getElementById("hardbars-toggle") as HTMLButtonElement;
  const hbNext = document.getElementById("hardbars-next") as HTMLButtonElement;
  const hbMenu = document.getElementById("hardbars-menu") as HTMLElement;
  const hbWrap = hbMenu.parentElement as HTMLElement;
  const hbStatus = document.getElementById("hardbars-status") as HTMLElement;
  const hbList = document.getElementById("hardbars-list") as HTMLElement;
  const pieceText = document.getElementById("piece-note-text") as HTMLTextAreaElement;
  const pieceSave = document.getElementById("piece-note-save") as HTMLButtonElement;
  const pieceStatusEl = document.getElementById("piece-note-status") as HTMLElement;

  const notes = createNotesStore({
    save: (id, p) => deps.saveNotes(id, p),
    onChange: renderAll,
    onError: (m) => deps.showError("Score notes not saved: " + m),
  });

  function renderMarks(): void {
    const layer = view.noteMarks;
    layer.replaceChildren();
    layer.hidden = !visible;
    if (!visible || notes.state() !== "ready") return;
    const { bands, icons } = markLayout(notes.doc(), view.barBoxes());
    for (const band of bands) {
      const el = document.createElement("div");
      el.className = "hard-bar-band";
      el.style.left = `${band.left}px`;
      el.style.top = `${band.top}px`;
      el.style.width = `${band.width}px`;
      el.style.height = `${band.height}px`;
      layer.appendChild(el);
    }
    for (const icon of icons) {
      const el = button("✎", "bar-note-icon");
      el.title = icon.title;
      el.setAttribute("aria-label", `Note on bar ${icon.bar}`);
      el.style.left = `${icon.left}px`;
      el.style.top = `${icon.top}px`;
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        const r = el.getBoundingClientRect();
        openEditor(icon.bar, r.left, r.bottom);
      });
      layer.appendChild(el);
    }
  }

  function currentRanges(): BarRange[] {
    return notes.state() === "ready" ? hardRanges(notes.doc(), view.barBoxes().length || undefined) : [];
  }

  function closeHardbarsMenu(): void {
    hbMenu.hidden = true;
    hbToggle.setAttribute("aria-expanded", "false");
  }

  function fillHardbars(ranges: BarRange[]): void {
    const st = notes.state();
    hbStatus.textContent =
      st === "loading"
        ? "Loading…"
        : st === "error"
          ? "Notes could not be loaded: " + (notes.error() ?? "")
          : ranges.length === 0
            ? "No hard bars yet. Right-click a bar on the score to mark it."
            : "";
    const items = ranges.map((r) => {
      const li = document.createElement("li");
      const b = button(rangeLabel(r), "hardbars-item");
      const lines: string[] = [];
      for (let bar = r.from; bar <= r.to; bar++) {
        const text = barNote(notes.doc(), bar);
        if (text) lines.push(noteTitle(bar, text));
      }
      if (lines.length > 0) b.title = lines.join("\n");
      b.addEventListener("click", () => {
        closeHardbarsMenu();
        deps.onPractise(r);
      });
      li.appendChild(b);
      return li;
    });
    hbList.replaceChildren(...items);
  }

  function renderHardbars(): void {
    const ranges = currentRanges();
    const hbText = hardbarsButtonText(ranges.length);
    (hbToggle.querySelector(".hb-label") as HTMLElement).textContent = hbText;
    (hbToggle.querySelector(".hb-short") as HTMLElement).textContent = ranges.length ? `⚑ ${ranges.length}` : "⚑";
    hbToggle.setAttribute("aria-label", hbText);
    hbToggle.disabled = !enabled;
    hbNext.disabled = !enabled || ranges.length === 0;
    if (!enabled) closeHardbarsMenu();
    if (!hbMenu.hidden) fillHardbars(ranges);
  }

  function renderPieceNote(): void {
    const st = notes.state();
    const ready = st === "ready";
    pieceText.disabled = !ready;
    pieceSave.disabled = !ready;
    if (st === "none") {
      pieceText.value = "";
      pieceStatusEl.textContent = "";
    } else if (st === "loading") {
      if (!pieceDirty) pieceText.value = "";
      pieceStatusEl.textContent = "Loading notes…";
    } else if (st === "error") {
      pieceStatusEl.textContent = "Notes could not be loaded: " + (notes.error() ?? "");
    } else {
      if (!pieceDirty) pieceText.value = notes.doc().piece_note;
      pieceStatusEl.textContent = pieceStatus;
    }
  }

  function renderAll(): void {
    renderMarks();
    renderHardbars();
    renderPieceNote();
  }

  const barMenu = document.createElement("div");
  barMenu.className = "bar-menu";
  barMenu.setAttribute("role", "menu");
  barMenu.hidden = true;
  document.body.appendChild(barMenu);

  const editor = document.createElement("div");
  editor.className = "bar-note-popover";
  editor.setAttribute("role", "dialog");
  editor.hidden = true;
  const editorTitle = document.createElement("h3");
  editorTitle.className = "bar-note-title";
  const textarea = document.createElement("textarea");
  textarea.className = "bar-note-text";
  textarea.rows = 4;
  textarea.maxLength = BAR_NOTE_MAX;
  const footer = document.createElement("div");
  footer.className = "bar-note-footer";
  const count = document.createElement("span");
  count.className = "bar-note-count";
  const deleteBtn = button("Delete", "btn");
  const cancelBtn = button("Cancel", "btn");
  const saveBtn = button("Save", "btn btn-primary");
  footer.append(count, deleteBtn, cancelBtn, saveBtn);
  editor.append(editorTitle, textarea, footer);
  document.body.appendChild(editor);

  function hideBarMenu(): void {
    barMenu.hidden = true;
  }

  function showMarks(): void {
    visible = true;
    saveMarksVisible(deps.store, true);
    toggle.setAttribute("aria-pressed", "true");
    view.noteMarks.hidden = false;
  }

  function closeMenus(): boolean {
    const wasOpen = !barMenu.hidden || !editor.hidden || !hbMenu.hidden;
    barMenu.hidden = true;
    editor.hidden = true;
    closeHardbarsMenu();
    return wasOpen;
  }

  function openEditor(bar: number, x: number, y: number): void {
    if (notes.state() !== "ready") return;
    closeMenus();
    editBar = bar;
    const existing = barNote(notes.doc(), bar);
    const text = existing ?? "";
    editorTitle.textContent = `Note on bar ${bar}`;
    editor.setAttribute("aria-label", `Note on bar ${bar}`);
    textarea.value = text;
    count.textContent = noteCounter(text);
    deleteBtn.hidden = existing === null;
    editor.hidden = false;
    const pos = placePopup(x, y, editor.offsetWidth, editor.offsetHeight, window.innerWidth, window.innerHeight);
    editor.style.left = `${pos.left}px`;
    editor.style.top = `${pos.top}px`;
    textarea.focus();
  }

  function saveEditor(): void {
    const next = setBarNote(notes.doc(), editBar, textarea.value);
    editor.hidden = true;
    showMarks();
    void notes.change(next);
  }

  textarea.addEventListener("input", () => {
    count.textContent = noteCounter(textarea.value);
  });
  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.ctrlKey) {
      e.preventDefault();
      saveEditor();
    }
  });
  saveBtn.addEventListener("click", () => saveEditor());
  deleteBtn.addEventListener("click", () => {
    editor.hidden = true;
    void notes.change(setBarNote(notes.doc(), editBar, ""));
  });
  cancelBtn.addEventListener("click", () => {
    editor.hidden = true;
  });

  hbToggle.addEventListener("click", () => {
    if (hbMenu.hidden) {
      hbMenu.hidden = false;
      hbToggle.setAttribute("aria-expanded", "true");
      fillHardbars(currentRanges());
    } else {
      closeHardbarsMenu();
    }
  });
  hbNext.addEventListener("click", () => {
    const r = nextRange(currentRanges(), view.selection());
    if (r) deps.onPractise(r);
  });
  document.addEventListener("click", (e) => {
    if (!hbMenu.hidden && !hbWrap.contains(e.target as Node)) closeHardbarsMenu();
  });

  pieceText.addEventListener("input", () => {
    pieceDirty = true;
    pieceStatus = "Not saved yet";
    pieceStatusEl.textContent = pieceStatus;
  });
  pieceSave.addEventListener("click", () => {
    if (notes.state() !== "ready") return;
    const text = pieceText.value;
    const wanted = setPieceNote(emptyNotes(), text).piece_note;
    const openAtClick = loadToken;
    pieceDirty = false;
    pieceStatus = "Saving…";
    void notes.change(setPieceNote(notes.doc(), text)).then(() => {
      if (loadToken !== openAtClick) return;
      if (notes.doc().piece_note === wanted) {
        pieceStatus = "Saved";
      } else {
        pieceText.value = text;
        pieceDirty = true;
        pieceStatus = "Not saved";
      }
      renderPieceNote();
    });
  });

  function contextMenu(info: { bar: number; clientX: number; clientY: number }): void {
    closeMenus();
    if (notes.state() !== "ready") {
      deps.showError(
        notes.state() === "error"
          ? "Score notes could not be loaded: " + (notes.error() ?? "")
          : "Score notes are still loading.",
      );
      return;
    }
    const labels = menuLabels(notes.doc(), info.bar, view.selection());
    const hard = button(labels.hard, "bar-menu-item");
    hard.setAttribute("role", "menuitem");
    hard.addEventListener("click", () => {
      hideBarMenu();
      showMarks();
      void notes.change(toggleHard(notes.doc(), labels.target));
    });
    const note = button(labels.note, "bar-menu-item");
    note.setAttribute("role", "menuitem");
    note.addEventListener("click", () => {
      hideBarMenu();
      showMarks();
      openEditor(info.bar, info.clientX, info.clientY);
    });
    barMenu.replaceChildren(hard, note);
    barMenu.hidden = false;
    const pos = placePopup(info.clientX, info.clientY, barMenu.offsetWidth, barMenu.offsetHeight, window.innerWidth, window.innerHeight);
    barMenu.style.left = `${pos.left}px`;
    barMenu.style.top = `${pos.top}px`;
    hard.focus();
  }

  document.addEventListener("pointerdown", (e) => {
    if (!barMenu.hidden && !barMenu.contains(e.target as Node)) hideBarMenu();
  });
  window.addEventListener("resize", () => hideBarMenu());
  window.addEventListener("hashchange", () => {
    closeMenus();
  });

  function open(scoreId: string): void {
    closeMenus();
    pieceDirty = false;
    pieceStatus = "";
    notes.reset(scoreId);
    const my = ++loadToken;
    deps.fetchNotes(scoreId).then(
      (raw) => {
        if (my === loadToken) notes.loaded(scoreId, raw);
      },
      (err: unknown) => {
        if (my !== loadToken) return;
        const m = err instanceof Error ? err.message : String(err);
        console.warn("score notes: " + m);
        notes.failed(scoreId, m);
      },
    );
  }

  function close(): void {
    closeMenus();
    pieceDirty = false;
    pieceStatus = "";
    loadToken++;
    notes.reset(null);
  }

  function setEnabled(on: boolean): void {
    enabled = on;
    renderHardbars();
  }

  return {
    open,
    close,
    layout: () => renderAll(),
    contextMenu,
    closeMenus,
    setEnabled,
  };
}
