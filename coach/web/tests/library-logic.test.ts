import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EMPTY_LIBRARY,
  barLabel,
  detailRows,
  difficultyLabel,
  downloadLabel,
  filterOptions,
  formatLength,
  hashTarget,
  isTyping,
  jobFinished,
  listState,
  parseHash,
  REMOVE_ARM_MS,
  REMOVE_ASK_MS,
  REMOVE_ASK_TEXT,
  canConfirmRemove,
  progressText,
  removeAskLabel,
  removeLabel,
  removeMode,
  rowMode,
  scoreHash,
  setupHeading,
  setupOffers,
  sourceLabel,
  stepMode,
} from "../src/library-logic.ts";
import type { Job, Score, ScoreList, SetupStep, SourceStatus } from "../src/api.ts";

const sampleScore: Score = {
  id: "local:abc",
  num: 1,
  title: "Fur Elise",
  composer: "Beethoven",
  artist: null,
  difficulty: 2,
  key: "A minor",
  time: "3/8",
  seconds: 95,
  piano_only: true,
  source: "local",
  attribution: "Public domain",
  license: "CC0",
  license_url: "https://example.com/cc0",
  format: "musicxml",
  has_file: true,
  file_url: "/api/scores/local%3Aabc/file",
};

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 1,
    kind: "download",
    source: "pdmx",
    target: "pdmx:1",
    label: "Download",
    state: "running",
    phase: "Downloading",
    done: null,
    total: null,
    unit: "bytes",
    message: null,
    error: null,
    ...overrides,
  };
}

function makeStep(overrides: Partial<SetupStep> = {}): SetupStep {
  return {
    id: "catalogue",
    title: "Catalogue",
    detail: "Fetch the catalogue.",
    needed_for: "search",
    done: true,
    running: false,
    ...overrides,
  };
}

function makeSource(overrides: Partial<SourceStatus> = {}): SourceStatus {
  return {
    name: "pdmx",
    label: "PDMX",
    description: "Public domain scores",
    steps: [makeStep()],
    ready: true,
    error: null,
    ...overrides,
  };
}

test("formatLength rounds to m:ss", () => {
  assert.equal(formatLength(95), "1:35");
  assert.equal(formatLength(0), "0:00");
  assert.equal(formatLength(59.6), "1:00");
  assert.equal(formatLength(3600), "60:00");
  assert.equal(formatLength(null), "-");
});

test("difficultyLabel", () => {
  assert.equal(difficultyLabel(2), "2 / 5");
  assert.equal(difficultyLabel(null), "-");
});

test("detailRows on a sample score", () => {
  assert.deepEqual(detailRows(sampleScore), [
    ["Key", "A minor"],
    ["Time", "3/8"],
    ["Length", "1:35"],
    ["Difficulty", "2 / 5"],
    ["Piano only", "yes"],
    ["Source", "local"],
    ["Attribution", "Public domain"],
    ["License", "CC0 (https://example.com/cc0)"],
  ]);
});

test("detailRows uses dashes and unknown for missing values", () => {
  const bare: Score = {
    ...sampleScore,
    key: null,
    time: "",
    seconds: null,
    difficulty: null,
    piano_only: null,
    attribution: null,
    license: null,
    license_url: null,
  };
  assert.deepEqual(detailRows(bare), [
    ["Key", "-"],
    ["Time", "-"],
    ["Length", "-"],
    ["Difficulty", "-"],
    ["Piano only", "unknown"],
    ["Source", "local"],
    ["Attribution", "-"],
    ["License", "-"],
  ]);
});

test("detailRows shows piano only as no when false", () => {
  assert.equal(detailRows({ ...sampleScore, piano_only: false })[4][1], "no");
});

test("detailRows license value for each combination", () => {
  const licenseOf = (s: Score): string => detailRows(s)[7][1];
  assert.equal(licenseOf({ ...sampleScore, license: "CC0", license_url: "https://example.com/cc0" }), "CC0 (https://example.com/cc0)");
  assert.equal(licenseOf({ ...sampleScore, license: "CC0", license_url: null }), "CC0");
  assert.equal(licenseOf({ ...sampleScore, license: null, license_url: "https://example.com/cc0" }), "https://example.com/cc0");
  assert.equal(licenseOf({ ...sampleScore, license: null, license_url: null }), "-");
});

test("hashTarget returns the id when it differs from the current one", () => {
  assert.equal(hashTarget("#score=local%3Aabc", null), "local:abc");
  assert.equal(hashTarget("#score=local%3Aabc", "local:other"), "local:abc");
});

test("hashTarget ignores the same id, empty or invalid hashes", () => {
  assert.equal(hashTarget("#score=local%3Aabc", "local:abc"), null);
  assert.equal(hashTarget("", "local:abc"), null);
  assert.equal(hashTarget("#score=", null), null);
  assert.equal(hashTarget("#other=1", null), null);
});

test("listState for all three states", () => {
  const empty: ScoreList = { scores: [], total: 0, facets: { keys: [], times: [], difficulties: [] }, sources: [] };
  const noMatches: ScoreList = { ...empty, total: 4 };
  const results: ScoreList = { ...empty, scores: [sampleScore], total: 1 };
  assert.equal(listState(empty), "empty-library");
  assert.equal(listState(noMatches), "no-matches");
  assert.equal(listState(results), "results");
});

test("listState while typing is never empty-library", () => {
  const empty: ScoreList = { scores: [], total: 0, facets: { keys: [], times: [], difficulties: [] }, sources: [] };
  const results: ScoreList = { ...empty, scores: [sampleScore], total: 1 };
  assert.equal(listState(empty, true), "no-matches");
  assert.equal(listState(results, true), "results");
});

test("isTyping", () => {
  assert.equal(isTyping(""), false);
  assert.equal(isTyping("   "), false);
  assert.equal(isTyping(" bach "), true);
});

test("sourceLabel uses the label, or the name when missing or empty", () => {
  const sources = [makeSource(), makeSource({ name: "local", label: "" })];
  assert.equal(sourceLabel("pdmx", sources), "PDMX");
  assert.equal(sourceLabel("other", sources), "other");
  assert.equal(sourceLabel("local", sources), "local");
});

test("setupOffers is empty when not typing", () => {
  const sources = [makeSource({ steps: [makeStep({ done: false })] })];
  assert.deepEqual(setupOffers(sources, false), []);
});

test("setupOffers skips sources whose steps are all done and without error", () => {
  const sources = [makeSource()];
  assert.deepEqual(setupOffers(sources, true), []);
});

test("setupOffers offers a source with one step not done, keeping order", () => {
  const first = makeSource({ name: "a", label: "A", steps: [makeStep(), makeStep({ done: false })] });
  const second = makeSource({ name: "b", label: "B", steps: [makeStep()] });
  const third = makeSource({ name: "c", label: "C", steps: [makeStep({ done: false })] });
  assert.deepEqual(setupOffers([first, second, third], true), [first, third]);
});

test("setupOffers offers a source with an error even when steps are done", () => {
  const broken = makeSource({ error: "catalogue unreadable" });
  assert.deepEqual(setupOffers([broken], true), [broken]);
});

test("setupHeading", () => {
  assert.equal(setupHeading(makeSource()), "PDMX needs setup");
});

test("progressText with bytes, total known", () => {
  assert.equal(
    progressText(makeJob({ phase: "Downloading the catalogue", done: 45200000, total: 225000000, unit: "bytes" })),
    "Downloading the catalogue: 45.2 / 225.0 MB (20%)",
  );
});

test("progressText with bytes, total unknown", () => {
  assert.equal(
    progressText(makeJob({ phase: "Downloading the score archive", done: 1900000000, total: null, unit: "bytes" })),
    "Downloading the score archive: 1,900.0 MB",
  );
});

test("progressText with items, total unknown", () => {
  assert.equal(
    progressText(makeJob({ phase: "Loading catalogue rows", done: 120000, total: null, unit: "items" })),
    "Loading catalogue rows: 120,000",
  );
});

test("progressText with items, total known", () => {
  assert.equal(
    progressText(makeJob({ phase: "Loading catalogue rows", done: 120000, total: 300000, unit: "items" })),
    "Loading catalogue rows: 120,000 / 300,000",
  );
});

test("progressText with done null shows the phase and an ellipsis", () => {
  assert.equal(progressText(makeJob({ phase: "Starting", done: null, total: 100, unit: "bytes" })), "Starting…");
});

test("progressText with bytes and total 0 shows 100 percent", () => {
  assert.equal(
    progressText(makeJob({ phase: "Downloading", done: 0, total: 0, unit: "bytes" })),
    "Downloading: 0.0 / 0.0 MB (100%)",
  );
});

test("rowMode for each case", () => {
  assert.equal(rowMode(sampleScore, null), "open");
  const missing = { ...sampleScore, has_file: false, id: "pdmx:1" };
  assert.equal(rowMode(missing, null), "download");
  assert.equal(rowMode(missing, makeJob({ kind: "download", target: "pdmx:1" })), "downloading");
  assert.equal(rowMode(missing, makeJob({ kind: "setup", target: "pdmx:1" })), "download");
  assert.equal(rowMode(missing, makeJob({ kind: "download", target: "pdmx:2" })), "download");
  assert.equal(rowMode(missing, makeJob({ kind: "download", target: "pdmx:1", state: "done" })), "download");
});

test("stepMode for each case", () => {
  const source = "pdmx";
  assert.equal(stepMode(source, makeStep({ done: true }), null), "done");
  assert.equal(stepMode(source, makeStep({ done: false, running: true }), null), "running");
  assert.equal(stepMode(source, makeStep({ id: "catalogue", done: false }), null), "offer");
  assert.equal(
    stepMode(source, makeStep({ id: "catalogue", done: false }), makeJob({ kind: "setup", source, target: "catalogue" })),
    "running",
  );
  assert.equal(
    stepMode(source, makeStep({ id: "catalogue", done: false }), makeJob({ kind: "setup", source, target: "other" })),
    "offer",
  );
  assert.equal(
    stepMode(source, makeStep({ id: "catalogue", done: false }), makeJob({ kind: "download", source, target: "catalogue" })),
    "offer",
  );
});

test("removeMode for each case", () => {
  const running = makeJob();
  assert.equal(removeMode({ ...sampleScore, has_file: false }, null, null, null), "hidden");
  assert.equal(removeMode({ ...sampleScore, has_file: false }, "local:abc", "local:abc", running), "hidden");
  assert.equal(removeMode(sampleScore, null, "local:abc", null), "removing");
  assert.equal(removeMode(sampleScore, null, "local:other", null), "disabled");
  assert.equal(removeMode(sampleScore, null, null, running), "disabled");
  assert.equal(removeMode(sampleScore, "local:abc", null, running), "disabled");
  assert.equal(removeMode(sampleScore, "local:abc", null, makeJob({ state: "done" })), "asking");
  assert.equal(removeMode(sampleScore, "local:abc", null, makeJob({ state: "error" })), "asking");
  assert.equal(removeMode(sampleScore, "local:other", null, null), "ready");
  assert.equal(removeMode(sampleScore, null, null, null), "ready");
});

test("removeLabel and removeAskLabel use the display title", () => {
  assert.equal(removeLabel(sampleScore), "Delete Fur Elise from your library");
  assert.equal(removeLabel({ ...sampleScore, title: null }), "Delete Untitled from your library");
  assert.equal(removeAskLabel(sampleScore), "Click again to delete Fur Elise");
  assert.equal(removeAskLabel({ ...sampleScore, title: null }), "Click again to delete Untitled");
});

test("remove timing constants", () => {
  assert.equal(REMOVE_ASK_MS, 3000);
  assert.equal(REMOVE_ARM_MS, 400);
  assert.equal(REMOVE_ASK_TEXT, "Delete?");
});

test("canConfirmRemove needs 400 ms since the ask", () => {
  assert.equal(canConfirmRemove(0, 399), false);
  assert.equal(canConfirmRemove(0, 400), true);
});

test("jobFinished truth table", () => {
  const running = makeJob({ id: 5, state: "running" });
  assert.equal(jobFinished(null, running), false);
  assert.equal(jobFinished(null, null), false);
  assert.equal(jobFinished(running, makeJob({ id: 5, state: "running" })), false);
  assert.equal(jobFinished(running, makeJob({ id: 5, state: "done" })), true);
  assert.equal(jobFinished(running, makeJob({ id: 5, state: "error" })), true);
  assert.equal(jobFinished(running, makeJob({ id: 6, state: "running" })), true);
  assert.equal(jobFinished(running, null), true);
});

test("downloadLabel uses the display title", () => {
  assert.equal(downloadLabel(sampleScore), "Download Fur Elise");
  assert.equal(downloadLabel({ ...sampleScore, title: null }), "Download Untitled");
});

test("filterOptions builds the option lists", () => {
  assert.deepEqual(
    filterOptions({ keys: ["A minor", "E minor"], times: ["3/4"], difficulties: [1, 3] }),
    {
      difficulty: [
        { value: "", label: "Any difficulty" },
        { value: "1", label: "1 / 5" },
        { value: "3", label: "3 / 5" },
      ],
      key: [
        { value: "", label: "Any key" },
        { value: "A minor", label: "A minor" },
        { value: "E minor", label: "E minor" },
      ],
      time: [
        { value: "", label: "Any time" },
        { value: "3/4", label: "3/4" },
      ],
    },
  );
});

test("scoreHash encodes the id", () => {
  assert.equal(scoreHash("local:abc"), "#score=local%3Aabc");
});

test("parseHash edge cases", () => {
  assert.equal(parseHash("#score=local%3Aabc"), "local:abc");
  assert.equal(parseHash(""), null);
  assert.equal(parseHash("#other=1"), null);
  assert.equal(parseHash("#score="), null);
  assert.equal(parseHash("#score=%E0%A4%A"), null);
});

test("barLabel", () => {
  assert.equal(barLabel(3, 12), "Bar 3 / 12");
  assert.equal(barLabel(null, 12), "Bar - / -");
});

test("EMPTY_LIBRARY command names the import command", () => {
  assert.ok(EMPTY_LIBRARY.command.includes("uv run coach scores import"));
});
