import type { Score, ScoreList, Facets, SourceStatus, SetupStep, Job } from "./api";
import type { PlanResponse } from "./skills-logic";

export const NO_PIECE_MESSAGE = "Pick a piece from the Library (top left).";
export const NO_MATCHES_MESSAGE = "No scores match your search.";
export const NOT_IN_LIBRARY_MESSAGE = "That score is not in your library.";
export const EMPTY_LIBRARY = {
  heading: "Your library is empty",
  text: "Add MusicXML files (.musicxml, .xml, .mxl) by running this in coach/:",
  command: "uv run coach scores import <file or folder>",
  after: "Then open the library again.",
};
export const JOB_POLL_MS = 500;
export const NOT_DOWNLOADED_HINT = "Not in your library yet. Use the download button, then click the row to open it.";
export const IN_LIBRARY_MARK = "In library";
export const STEP_DONE_TEXT = "Done";
export const STEP_BUTTON_TEXT = "Get it";

export interface Option {
  value: string;
  label: string;
}

export type ListState = "empty-library" | "no-matches" | "results";

export function formatLength(seconds: number | null): string {
  if (seconds === null) return "-";
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  const secs = total % 60;
  return minutes + ":" + String(secs).padStart(2, "0");
}

export function difficultyLabel(d: number | null): string {
  return d === null ? "-" : d + " / 5";
}

export function displayTitle(s: Score): string {
  return s.title || "Untitled";
}

export function displayComposer(s: Score): string {
  return s.composer || s.artist || "Unknown composer";
}

function orDash(value: string | null): string {
  return value || "-";
}

export function detailRows(s: Score): [string, string][] {
  let license = orDash(s.license);
  if (s.license && s.license_url) license += " (" + s.license_url + ")";
  else if (!s.license && s.license_url) license = s.license_url;
  let pianoOnly = "unknown";
  if (s.piano_only === true) pianoOnly = "yes";
  if (s.piano_only === false) pianoOnly = "no";
  return [
    ["Key", orDash(s.key)],
    ["Time", orDash(s.time)],
    ["Length", formatLength(s.seconds)],
    ["Difficulty", difficultyLabel(s.difficulty)],
    ["Piano only", pianoOnly],
    ["Source", orDash(s.source)],
    ["Attribution", orDash(s.attribution)],
    ["License", license],
  ];
}

export function listState(list: ScoreList, typing = false): ListState {
  if (!typing && list.total === 0) return "empty-library";
  if (list.scores.length === 0) return "no-matches";
  return "results";
}

export function listHint(list: ScoreList, shownCount: number, typing: boolean): string {
  if (list.capped && shownCount > 0) return `Showing the first ${shownCount} matches; type more to narrow the search.`;
  const hidden = list.hidden ?? 0;
  if (shownCount === 0 && !typing && hidden > 0) {
    return `Generated scales (${hidden}) are hidden here; type in the search box or open the Scales page.`;
  }
  return "";
}

export function isTyping(q: string): boolean {
  return q.trim().length > 0;
}

export function sourceLabel(name: string, sources: SourceStatus[]): string {
  const source = sources.find((s) => s.name === name);
  return source && source.label ? source.label : name;
}

export function setupOffers(sources: SourceStatus[], typing: boolean): SourceStatus[] {
  if (!typing) return [];
  return sources.filter((s) => s.steps.some((step) => !step.done) || s.error !== null);
}

export function setupHeading(s: SourceStatus): string {
  return s.label + " needs setup";
}

function megabytes(n: number): string {
  return (n / 1e6).toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

function whole(n: number): string {
  return n.toLocaleString("en-US");
}

export function progressText(job: Job): string {
  if (job.done === null) return job.phase + "…";
  const done = job.done;
  if (job.unit === "bytes") {
    if (job.total === null) return `${job.phase}: ${megabytes(done)} MB`;
    const pct = job.total === 0 ? 100 : Math.floor((done * 100) / job.total);
    return `${job.phase}: ${megabytes(done)} / ${megabytes(job.total)} MB (${pct}%)`;
  }
  if (job.total === null) return `${job.phase}: ${whole(done)}`;
  return `${job.phase}: ${whole(done)} / ${whole(job.total)}`;
}

export function rowMode(score: Score, job: Job | null): "open" | "download" | "downloading" {
  if (score.has_file) return "open";
  if (job && job.state === "running" && job.kind === "download" && job.target === score.id) return "downloading";
  return "download";
}

export function stepMode(source: string, step: SetupStep, job: Job | null): "done" | "running" | "offer" {
  if (step.done) return "done";
  if (step.running) return "running";
  if (job && job.state === "running" && job.kind === "setup" && job.source === source && job.target === step.id) {
    return "running";
  }
  return "offer";
}

export function jobFinished(prev: Job | null, next: Job | null): boolean {
  if (prev === null || prev.state !== "running") return false;
  return next === null || next.id !== prev.id || next.state !== "running";
}

export function downloadLabel(score: Score): string {
  return "Download " + displayTitle(score);
}

export function filterOptions(f: Facets): { difficulty: Option[]; key: Option[]; time: Option[] } {
  return {
    difficulty: [
      { value: "", label: "Any difficulty" },
      ...f.difficulties.map((d) => ({ value: String(d), label: difficultyLabel(d) })),
    ],
    key: [{ value: "", label: "Any key" }, ...f.keys.map((k) => ({ value: k, label: k }))],
    time: [{ value: "", label: "Any time" }, ...f.times.map((t) => ({ value: t, label: t }))],
  };
}

export function scoreHash(id: string): string {
  return "#score=" + encodeURIComponent(id);
}

export function parseHash(hash: string): string | null {
  const prefix = "#score=";
  if (!hash.startsWith(prefix)) return null;
  const raw = hash.slice(prefix.length);
  if (!raw) return null;
  try {
    const id = decodeURIComponent(raw);
    return id || null;
  } catch {
    return null;
  }
}

export function hashTarget(hash: string, currentId: string | null): string | null {
  const id = parseHash(hash);
  if (id === null || id === currentId) return null;
  return id;
}

export function barLabel(bar: number | null, total: number): string {
  return "Bar " + (bar === null ? "- / -" : bar + " / " + total);
}

export const DRILL_SOURCES: readonly string[] = ["gen", "scales"];

export type LibraryTab = "pieces" | "drills";

export function isDrill(s: Score): boolean {
  return DRILL_SOURCES.includes(s.source);
}

export function drillOrder(plan: PlanResponse | null): Map<string, number> {
  const order = new Map<string, number>();
  const nodes = plan && plan.tree && Array.isArray(plan.tree.nodes) ? plan.tree.nodes : [];
  for (const node of nodes) {
    for (const d of Array.isArray(node.drills) ? node.drills : []) {
      if (!order.has(d.score)) order.set(d.score, order.size);
    }
  }
  return order;
}

export function tabScores(scores: Score[], tab: LibraryTab, order: Map<string, number>): Score[] {
  if (tab === "pieces") return scores.filter((s) => !isDrill(s));
  const drills = scores.filter(isDrill);
  const rank = (s: Score): number => order.get(s.id) ?? Infinity;
  return drills.sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra < rb ? -1 : 1;
    if (ra === Infinity) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    return 0;
  });
}

export function tabCounts(scores: Score[]): { pieces: number; drills: number } {
  const drills = scores.filter(isDrill).length;
  return { pieces: scores.length - drills, drills };
}

export function tabLabel(tab: LibraryTab, n: number): string {
  return (tab === "pieces" ? "Pieces" : "Drills") + " (" + n + ")";
}

export const REMOVE_ASK_MS = 3000;
export const REMOVE_ARM_MS = 400;
export const REMOVE_ICON = "✕";
export const REMOVE_ASK_TEXT = "Delete?";

export function removeLabel(s: Score): string {
  return "Delete " + displayTitle(s) + " from your library";
}

export function removeAskLabel(s: Score): string {
  return "Click again to delete " + displayTitle(s);
}

export function canConfirmRemove(askedAt: number, now: number): boolean {
  return now - askedAt >= REMOVE_ARM_MS;
}

export type RemoveMode = "hidden" | "ready" | "asking" | "removing" | "disabled";

export function removeMode(score: Score, askingId: string | null, removingId: string | null, job: Job | null): RemoveMode {
  if (!score.has_file) return "hidden";
  if (removingId === score.id) return "removing";
  if (removingId !== null || (job !== null && job.state === "running")) return "disabled";
  if (askingId === score.id) return "asking";
  return "ready";
}
