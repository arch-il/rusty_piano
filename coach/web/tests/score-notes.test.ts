import assert from "node:assert/strict";
import { test } from "node:test";
import {
  allHard,
  BAR_NOTE_ICON_W,
  barNote,
  createNotesStore,
  emptyNotes,
  hardRanges,
  hardbarsButtonText,
  loadMarksVisible,
  markLayout,
  menuLabels,
  nextRange,
  noteCounter,
  normaliseNotes,
  placePopup,
  rangeLabel,
  saveMarksVisible,
  setBarNote,
  setPieceNote,
  toggleHard,
  toPayload,
  type BarBox,
  type ScoreNotesDoc,
  type ScoreNotesPayload,
} from "../src/score-notes.ts";
import { ApiError, fetchScoreNotes, notesUrl, saveScoreNotes, type FetchLike } from "../src/api.ts";
import type { KV } from "../src/fingering-toggle.ts";

function fakeStore(init: Record<string, string> = {}): KV & { m: Map<string, string> } {
  const m = new Map(Object.entries(init));
  return { m, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
}
const throwing: KV = {
  getItem() {
    throw new Error("no");
  },
  setItem() {
    throw new Error("no");
  },
};

function docWith(parts: Partial<ScoreNotesDoc>): ScoreNotesDoc {
  return { ...emptyNotes(), ...parts };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise<void>((r) => setImmediate(r));

function harness() {
  const calls: { id: string; payload: ScoreNotesPayload; d: ReturnType<typeof deferred<unknown>> }[] = [];
  const errors: string[] = [];
  let changes = 0;
  const store = createNotesStore({
    save(id, payload) {
      const d = deferred<unknown>();
      calls.push({ id, payload, d });
      return d.promise;
    },
    onChange: () => void changes++,
    onError: (m) => errors.push(m),
  });
  return { store, calls, errors, changes: () => changes };
}

const serverDoc = {
  version: 1,
  piece_note: "srv",
  hard_bars: [4],
  bar_notes: { "4": "x" },
  updated_at: "2026-01-01T00:00:00Z",
};

test("normaliseNotes handles garbage input", () => {
  assert.deepEqual(normaliseNotes(null), emptyNotes());
  assert.deepEqual(normaliseNotes("x"), emptyNotes());
  assert.deepEqual(normaliseNotes(42), emptyNotes());
  assert.deepEqual(normaliseNotes({}), emptyNotes());
});

test("normaliseNotes drops invalid entries", () => {
  const raw = {
    hard_bars: [3, "4", 3, 0, 10000, 2.5, true],
    bar_notes: { "2": " a ", "0": "b", x: "c", "3": "  ", "10": 5 },
    piece_note: 7,
    updated_at: 5,
  };
  assert.deepEqual(normaliseNotes(raw), {
    piece_note: "",
    hard_bars: [3],
    bar_notes: { "2": "a" },
    updated_at: null,
  });
});

test("toPayload drops updated_at and copies", () => {
  const doc = docWith({ piece_note: "p", hard_bars: [1], bar_notes: { "1": "n" }, updated_at: "t" });
  const payload = toPayload(doc);
  assert.deepEqual(payload, { piece_note: "p", hard_bars: [1], bar_notes: { "1": "n" } });
  payload.hard_bars.push(2);
  assert.deepEqual(doc.hard_bars, [1]);
});

test("isHard and allHard", () => {
  const doc = docWith({ hard_bars: [2, 3] });
  assert.equal(allHard(doc, { from: 2, to: 3 }), true);
  assert.equal(allHard(doc, { from: 2, to: 4 }), false);
});

test("toggleHard marks, unmarks and mixes without mutating", () => {
  const doc = docWith({ hard_bars: [2, 5] });
  assert.deepEqual(toggleHard(doc, { from: 3, to: 4 }).hard_bars, [2, 3, 4, 5]);
  assert.deepEqual(toggleHard(doc, { from: 2, to: 2 }).hard_bars, [5]);
  assert.deepEqual(toggleHard(doc, { from: 2, to: 5 }).hard_bars, [2, 3, 4, 5]);
  assert.deepEqual(doc.hard_bars, [2, 5]);
});

test("setBarNote cleans text and keeps other notes", () => {
  const doc = docWith({ bar_notes: { "1": "keep" } });
  const next = setBarNote(doc, 2, "  hi\r\nthere  ");
  assert.equal(barNote(next, 2), "hi\nthere");
  assert.equal(barNote(next, 1), "keep");
  assert.equal(barNote(doc, 2), null);
  assert.equal(setBarNote(doc, 2, "a".repeat(600)).bar_notes["2"].length, 500);
  assert.equal(setBarNote(doc, 2, "\r\r").bar_notes["2"], undefined);
  assert.deepEqual(setBarNote(next, 2, "").bar_notes, { "1": "keep" });
  assert.equal(barNote(setBarNote(doc, 1, "  "), 1), null);
});

test("setPieceNote cuts to 2000", () => {
  assert.equal(setPieceNote(emptyNotes(), "x".repeat(2500)).piece_note.length, 2000);
  assert.equal(setPieceNote(emptyNotes(), "  p  ").piece_note, "p");
});

test("hardRanges merges runs and honours barCount", () => {
  const doc = docWith({ hard_bars: [3, 4, 5, 9] });
  assert.deepEqual(hardRanges(doc), [
    { from: 3, to: 5 },
    { from: 9, to: 9 },
  ]);
  assert.deepEqual(hardRanges(doc, 9), [
    { from: 3, to: 5 },
    { from: 9, to: 9 },
  ]);
  assert.deepEqual(hardRanges(doc, 4), [{ from: 3, to: 4 }]);
  assert.deepEqual(hardRanges(doc, 2), []);
});

test("rangeLabel", () => {
  assert.equal(rangeLabel({ from: 9, to: 9 }), "Bar 9");
  assert.equal(rangeLabel({ from: 3, to: 5 }), "Bars 3-5");
});

test("nextRange cycles through ranges", () => {
  const ranges = [
    { from: 3, to: 3 },
    { from: 5, to: 7 },
  ];
  assert.deepEqual(nextRange(ranges, null), { from: 3, to: 3 });
  assert.deepEqual(nextRange(ranges, { from: 3, to: 3 }), { from: 5, to: 7 });
  assert.deepEqual(nextRange(ranges, { from: 5, to: 7 }), { from: 3, to: 3 });
  assert.deepEqual(nextRange(ranges, { from: 4, to: 4 }), { from: 5, to: 7 });
  assert.deepEqual(nextRange(ranges, { from: 9, to: 9 }), { from: 3, to: 3 });
  assert.equal(nextRange([], null), null);
});

test("menuLabels follow the selection", () => {
  const sel = { from: 5, to: 7 };
  const hard = docWith({ hard_bars: [5, 6, 7] });
  const m1 = menuLabels(hard, 6, sel);
  assert.deepEqual(m1.target, { from: 5, to: 7 });
  assert.equal(m1.hard, "Unmark bars 5-7");

  const m2 = menuLabels(docWith({ hard_bars: [5] }), 6, sel);
  assert.equal(m2.hard, "Mark bars 5-7 as hard");

  const m3 = menuLabels(docWith({}), 2, sel);
  assert.deepEqual(m3.target, { from: 2, to: 2 });
  assert.equal(m3.hard, "Mark bar 2 as hard");
  assert.equal(m3.note, "Add note to bar 2…");
  assert.equal(menuLabels(docWith({ bar_notes: { "2": "n" } }), 2, null).note, "Edit note on bar 2…");
});

test("markLayout skips null boxes and offsets icons", () => {
  const doc = docWith({ hard_bars: [1, 2, 3], bar_notes: { "2": "n", "3": "m" } });
  const boxes: (BarBox | null)[] = [
    { left: 10, top: 20, width: 30, height: 40 },
    null,
    { left: 100, top: 200, width: 50, height: 60 },
  ];
  assert.deepEqual(markLayout(doc, boxes), {
    bands: [
      { bar: 1, left: 10, top: 20, width: 30, height: 40 },
      { bar: 3, left: 100, top: 200, width: 50, height: 60 },
    ],
    icons: [{ bar: 3, left: 130, top: 198, title: "Bar 3: m" }],
  });
});

test("markLayout puts the note icon at the right end of the bar, clear of the tempo mark", () => {
  const doc = docWith({ bar_notes: { "1": "a", "2": "b" } });
  const boxes: (BarBox | null)[] = [
    { left: 10, top: 20, width: 200, height: 40 },
    { left: 210, top: 20, width: 12, height: 40 },
  ];
  assert.deepEqual(markLayout(doc, boxes).icons, [
    { bar: 1, left: 190, top: 18, title: "Bar 1: a" },
    { bar: 2, left: 212, top: 18, title: "Bar 2: b" },
  ]);
  assert.equal(BAR_NOTE_ICON_W, 18);
});

test("placePopup clamps to the viewport", () => {
  assert.deepEqual(placePopup(990, 10, 200, 100, 1000, 800), { left: 792, top: 10 });
  assert.deepEqual(placePopup(5, 790, 200, 100, 1000, 800), { left: 8, top: 692 });
  assert.deepEqual(placePopup(50, 50, 300, 300, 200, 200), { left: 8, top: 8 });
});

test("hardbarsButtonText and noteCounter", () => {
  assert.equal(hardbarsButtonText(0), "Hard bars");
  assert.equal(hardbarsButtonText(3), "Hard bars (3)");
  assert.equal(noteCounter("abc"), "3 / 500");
});

test("marks visibility store", () => {
  const store = fakeStore();
  assert.equal(loadMarksVisible(store), true);
  assert.equal(loadMarksVisible(fakeStore({ "rp.scoreMarks": "off" })), false);
  assert.equal(loadMarksVisible(null), true);
  assert.equal(loadMarksVisible(throwing), true);
  assert.doesNotThrow(() => saveMarksVisible(throwing, false));
  saveMarksVisible(store, false);
  assert.equal(store.m.get("rp.scoreMarks"), "off");
  saveMarksVisible(store, true);
  assert.equal(store.m.get("rp.scoreMarks"), "on");
});

test("change before ready does not save", async () => {
  const h = harness();
  h.store.reset("A");
  await h.store.change(docWith({ piece_note: "x" }));
  assert.equal(h.calls.length, 0);
  assert.equal(h.store.doc().piece_note, "");
});

test("stale loaded and failed calls are ignored", () => {
  const h = harness();
  h.store.reset("A");
  h.store.loaded("B", serverDoc);
  h.store.failed("B", "nope");
  assert.equal(h.store.state(), "loading");
  assert.equal(h.store.error(), null);
  h.store.loaded("A", serverDoc);
  assert.equal(h.store.state(), "ready");
  assert.equal(h.store.doc().piece_note, "srv");
});

test("a single change saves the payload and ends with the server doc", async () => {
  const h = harness();
  h.store.reset("A");
  h.store.loaded("A", null);
  const p = h.store.change(docWith({ piece_note: "a" }));
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].id, "A");
  assert.deepEqual(h.calls[0].payload, { piece_note: "a", hard_bars: [], bar_notes: {} });
  h.calls[0].d.resolve(serverDoc);
  await p;
  assert.deepEqual(h.store.doc(), normaliseNotes(serverDoc));
  assert.equal(h.store.state(), "ready");
  assert.deepEqual(h.errors, []);
});

test("changes made during a save coalesce into one follow-up save", async () => {
  const h = harness();
  h.store.reset("A");
  h.store.loaded("A", null);
  const p = h.store.change(docWith({ piece_note: "A" }));
  h.store.change(docWith({ piece_note: "B" }));
  h.store.change(docWith({ piece_note: "C" }));
  h.calls[0].d.resolve({ piece_note: "A" });
  await tick();
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[0].payload.piece_note, "A");
  assert.equal(h.calls[1].payload.piece_note, "C");
  h.calls[1].d.resolve({ piece_note: "C" });
  await p;
  assert.equal(h.calls.length, 2);
  assert.equal(h.store.doc().piece_note, "C");
});

test("a rejected save reverts to the last saved doc", async () => {
  const h = harness();
  h.store.reset("A");
  h.store.loaded("A", { piece_note: "saved" });
  const p = h.store.change(docWith({ piece_note: "bad" }));
  h.calls[0].d.reject(new Error("boom"));
  await p;
  assert.equal(h.store.doc().piece_note, "saved");
  assert.deepEqual(h.errors, ["boom"]);
});

test("reset during an in-flight save ignores a late resolve", async () => {
  const h = harness();
  h.store.reset("A");
  h.store.loaded("A", null);
  const p = h.store.change(docWith({ piece_note: "a" }));
  h.store.reset("A");
  const before = h.changes();
  h.calls[0].d.resolve(serverDoc);
  await p;
  assert.equal(h.store.state(), "loading");
  assert.deepEqual(h.store.doc(), emptyNotes());
  assert.equal(h.changes(), before);
  assert.deepEqual(h.errors, []);
});

test("reset during an in-flight save ignores a late reject", async () => {
  const h = harness();
  h.store.reset("A");
  h.store.loaded("A", null);
  const p = h.store.change(docWith({ piece_note: "a" }));
  h.store.reset("A");
  const before = h.changes();
  h.calls[0].d.reject(new Error("boom"));
  await p;
  assert.equal(h.store.state(), "loading");
  assert.deepEqual(h.store.doc(), emptyNotes());
  assert.equal(h.changes(), before);
  assert.deepEqual(h.errors, []);
});

test("score switch saves B immediately and ignores A's late resolve", async () => {
  const h = harness();
  h.store.reset("A");
  h.store.loaded("A", null);
  const pA = h.store.change(docWith({ piece_note: "a" }));
  h.store.reset("B");
  h.store.loaded("B", { piece_note: "b0" });
  const docB = docWith({ piece_note: "b1" });
  const pB = h.store.change(docB);
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].id, "B");
  h.calls[0].d.resolve(serverDoc);
  await pA;
  assert.equal(h.store.state(), "ready");
  assert.deepEqual(h.store.doc(), docB);
  assert.deepEqual(h.errors, []);
  h.calls[1].d.resolve({ piece_note: "b1" });
  await pB;
  assert.equal(h.store.doc().piece_note, "b1");
});

test("score switch ignores A's late reject", async () => {
  const h = harness();
  h.store.reset("A");
  h.store.loaded("A", null);
  const pA = h.store.change(docWith({ piece_note: "a" }));
  h.store.reset("B");
  h.store.loaded("B", { piece_note: "b0" });
  const docB = docWith({ piece_note: "b1" });
  const pB = h.store.change(docB);
  h.calls[0].d.reject(new Error("boom"));
  await pA;
  assert.equal(h.store.state(), "ready");
  assert.deepEqual(h.store.doc(), docB);
  assert.deepEqual(h.errors, []);
  h.calls[1].d.resolve({ piece_note: "b1" });
  await pB;
});

test("notesUrl encodes the id", () => {
  assert.equal(notesUrl("local:a b"), "/api/scores/local%3Aa%20b/notes");
});

test("fetchScoreNotes calls fetch with only the URL and returns the JSON", async () => {
  const seen: unknown[][] = [];
  const fetchFn: FetchLike = async (...args) => {
    seen.push(args);
    return { ok: true, status: 200, json: async () => serverDoc };
  };
  const doc = await fetchScoreNotes("A", fetchFn);
  assert.deepEqual(seen, [["/api/scores/A/notes"]]);
  assert.deepEqual(doc, serverDoc);
});

test("saveScoreNotes sends a POST with JSON body", async () => {
  const seen: { url: string; init?: unknown }[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    seen.push({ url, init });
    return { ok: true, status: 200, json: async () => serverDoc };
  };
  const payload: ScoreNotesPayload = { piece_note: "p", hard_bars: [4], bar_notes: { "4": "x" } };
  const doc = await saveScoreNotes("A", payload, fetchFn);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "/api/scores/A/notes");
  assert.deepEqual(seen[0].init, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  assert.deepEqual(doc, serverDoc);
});

test("saveScoreNotes rejects with the server error", async () => {
  const fetchFn: FetchLike = async () => ({
    ok: false,
    status: 400,
    json: async () => ({ error: "x" }),
  });
  await assert.rejects(saveScoreNotes("A", { piece_note: "", hard_bars: [], bar_notes: {} }, fetchFn), (e) => {
    assert.ok(e instanceof ApiError);
    assert.equal(e.message, "x");
    assert.equal(e.status, 400);
    return true;
  });
});
