import type { PlanResponse } from './skills-logic';
import type { LogResponse } from './log-logic';
import type { ReplayAttempt, ReplayAttemptItem, ReplaySessionItem, SessionReplay } from './replay-logic';
import type { SightHistory } from './sight-levels';
import type { EarHistory } from './ear-levels';
import type { ScoreNotesDoc, ScoreNotesPayload } from "./score-notes";

export interface Score {
  id: string;
  num: number;
  title: string | null;
  composer: string | null;
  artist: string | null;
  difficulty: number | null;
  key: string | null;
  time: string | null;
  seconds: number | null;
  piano_only: boolean | null;
  source: string;
  attribution: string | null;
  license: string | null;
  license_url: string | null;
  format: "mxl" | "musicxml";
  has_file: boolean;
  file_url: string;
}

export interface Facets {
  keys: string[];
  times: string[];
  difficulties: number[];
}

export interface SetupStep {
  id: string;
  title: string;
  detail: string;
  needed_for: "search" | "download";
  done: boolean;
  running: boolean;
}

export interface SourceStatus {
  name: string;
  label: string;
  description: string;
  steps: SetupStep[];
  ready: boolean;
  error: string | null;
}

export interface Job {
  id: number;
  kind: "setup" | "download";
  source: string;
  target: string;
  label: string;
  state: "running" | "done" | "error";
  phase: string;
  done: number | null;
  total: number | null;
  unit: "bytes" | "items";
  message: string | null;
  error: string | null;
}

export interface FingerNote {
  m: number;
  q: number;
  s: number;
  p: number;
  f: string;
}

export interface FingeringStatus {
  status: "ready" | "pending" | "none" | "error";
  source: string | null;
  notes: FingerNote[];
  error: string | null;
}

export interface RemoveResult {
  removed: string;
  kept_in_catalogue: boolean;
  message: string;
}

export interface ScoreList {
  scores: Score[];
  total: number;
  facets: Facets;
  sources: SourceStatus[];
  capped?: boolean;
  hidden?: number;
}

export interface Filters {
  q?: string;
  difficulty?: string;
  key?: string;
  time?: string;
}

export interface RequestInitLike {
  method: string;
  headers?: Record<string, string>;
  body?: string;
}

export type FetchLike = (
  url: string,
  init?: RequestInitLike,
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export const SERVER_UNREACHABLE_MESSAGE = "Can't reach the coach server. Start it in coach/ with: uv run coach serve";

export const CURRENT_JOB_URL = "/api/jobs/current";

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export function scoresUrl(filters: Filters, limit?: number): string {
  const params = new URLSearchParams();
  const pairs: [string, string | undefined][] = [
    ["q", filters.q],
    ["difficulty", filters.difficulty],
    ["key", filters.key],
    ["time", filters.time],
    ["limit", limit === undefined ? undefined : String(limit)],
  ];
  for (const [name, value] of pairs) {
    const trimmed = value?.trim();
    if (trimmed) params.append(name, trimmed);
  }
  const query = params.toString();
  return query ? "/api/scores?" + query : "/api/scores";
}

export function scoreUrl(id: string): string {
  return "/api/scores/" + encodeURIComponent(id);
}

export function downloadUrl(id: string): string {
  return scoreUrl(id) + "/download";
}

export function removeUrl(id: string): string {
  return scoreUrl(id) + "/delete";
}

export function setupUrl(source: string, step: string): string {
  return "/api/sources/" + encodeURIComponent(source) + "/setup/" + encodeURIComponent(step);
}

async function request<T>(url: string, fetchFn: FetchLike, init?: RequestInitLike): Promise<T> {
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = init === undefined ? await fetchFn(url) : await fetchFn(url, init);
  } catch {
    throw new ApiError(SERVER_UNREACHABLE_MESSAGE, 0);
  }
  if (!response.ok) {
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    const error = (body as { error?: unknown } | null)?.error;
    if (typeof error === "string") throw new ApiError(error, response.status);
    throw new ApiError(SERVER_UNREACHABLE_MESSAGE, response.status);
  }
  return (await response.json()) as T;
}

export function fetchScores(filters: Filters, fetchFn: FetchLike = (u, i) => fetch(u, i)): Promise<ScoreList> {
  return request<ScoreList>(scoresUrl(filters), fetchFn);
}

export function fetchScore(id: string, fetchFn: FetchLike = (u, i) => fetch(u, i)): Promise<Score> {
  return request<Score>(scoreUrl(id), fetchFn);
}

export async function startDownload(id: string, fetchFn: FetchLike = (u, i) => fetch(u, i)): Promise<Job> {
  const body = await request<{ job: Job }>(downloadUrl(id), fetchFn, { method: "POST" });
  return body.job;
}

export function fingeringUrl(id: string): string {
  return scoreUrl(id) + "/fingering";
}

export function fetchFingering(id: string, fetchFn: FetchLike = (u, i) => fetch(u, i)): Promise<FingeringStatus> {
  return request<FingeringStatus>(fingeringUrl(id), fetchFn);
}

export function startFingering(id: string, fetchFn: FetchLike = (u, i) => fetch(u, i)): Promise<FingeringStatus> {
  return request<FingeringStatus>(fingeringUrl(id), fetchFn, { method: "POST" });
}

export function notesUrl(id: string): string {
  return scoreUrl(id) + "/notes";
}

export function fetchScoreNotes(id: string, fetchFn: FetchLike = (u, i) => fetch(u, i)): Promise<ScoreNotesDoc> {
  return request<ScoreNotesDoc>(notesUrl(id), fetchFn);
}

export function saveScoreNotes(
  id: string,
  payload: ScoreNotesPayload,
  fetchFn: FetchLike = (u, i) => fetch(u, i),
): Promise<ScoreNotesDoc> {
  return request<ScoreNotesDoc>(notesUrl(id), fetchFn, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export function removeScore(id: string, fetchFn: FetchLike = (u, i) => fetch(u, i)): Promise<RemoveResult> {
  return request<RemoveResult>(removeUrl(id), fetchFn, { method: "POST" });
}

export async function startSetup(
  source: string,
  step: string,
  fetchFn: FetchLike = (u, i) => fetch(u, i),
): Promise<Job> {
  const body = await request<{ job: Job }>(setupUrl(source, step), fetchFn, { method: "POST" });
  return body.job;
}

export async function fetchCurrentJob(fetchFn: FetchLike = (u, i) => fetch(u, i)): Promise<Job | null> {
  const body = await request<{ job: Job | null }>(CURRENT_JOB_URL, fetchFn);
  return body.job;
}

export const ATTEMPTS_URL = "/api/attempts";

export interface SavedAttempt {
  id: string;
  file: string;
}

export function postAttempt(attempt: unknown, fetchFn: FetchLike = (u, i) => fetch(u, i)): Promise<SavedAttempt> {
  return request<SavedAttempt>(ATTEMPTS_URL, fetchFn, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(attempt),
  });
}

export const PLAN_URL = '/api/plan';

export function fetchPlan(fetchFn: FetchLike = (u, i) => fetch(u, i)): Promise<PlanResponse> {
  return request<PlanResponse>(PLAN_URL, fetchFn);
}

export const LOG_URL = '/api/log?days=30';

export function fetchLog(fetchFn: FetchLike = (u, i) => fetch(u, i)): Promise<LogResponse> {
  return request<LogResponse>(LOG_URL, fetchFn);
}

export function replayAttemptsUrl(scoreId: string): string {
  return '/api/replay/attempts?score=' + encodeURIComponent(scoreId);
}

export function attemptUrl(id: string): string {
  return '/api/replay/attempts/' + encodeURIComponent(id);
}

export async function fetchReplayAttempts(
  scoreId: string,
  fetchFn: FetchLike = (u, i) => fetch(u, i),
): Promise<ReplayAttemptItem[]> {
  const body = await request<{ attempts: ReplayAttemptItem[] }>(replayAttemptsUrl(scoreId), fetchFn);
  return body.attempts;
}

export function fetchAttempt(id: string, fetchFn: FetchLike = (u, i) => fetch(u, i)): Promise<ReplayAttempt> {
  return request<ReplayAttempt>(attemptUrl(id), fetchFn);
}

export const REPLAY_SESSIONS_URL = '/api/replay/sessions';

export async function fetchReplaySessions(fetchFn: FetchLike = (u, i) => fetch(u, i)): Promise<ReplaySessionItem[]> {
  const body = await request<{ sessions: ReplaySessionItem[] }>(REPLAY_SESSIONS_URL, fetchFn);
  return body.sessions;
}

export function sessionReplayUrl(name: string, scoreId: string, hands: string): string {
  return '/api/replay/session?' + new URLSearchParams({ name, score: scoreId, hands }).toString();
}

export function fetchSessionReplay(
  name: string,
  scoreId: string,
  hands: string,
  fetchFn: FetchLike = (u, i) => fetch(u, i),
): Promise<SessionReplay> {
  return request<SessionReplay>(sessionReplayUrl(name, scoreId, hands), fetchFn);
}

export const SIGHT_HISTORY_URL = '/api/sight/history';

export function sightHistoryUrl(level: string | null): string {
  return level ? SIGHT_HISTORY_URL + '?level=' + encodeURIComponent(level) : SIGHT_HISTORY_URL;
}

export function fetchSightHistory(level: string | null, fetchFn: FetchLike = (u, i) => fetch(u, i)): Promise<SightHistory> {
  return request<SightHistory>(sightHistoryUrl(level), fetchFn);
}

export const EAR_HISTORY_URL = '/api/ear/history';

export function earHistoryUrl(level: string | null): string {
  return level ? EAR_HISTORY_URL + '?level=' + encodeURIComponent(level) : EAR_HISTORY_URL;
}

export function fetchEarHistory(level: string | null, fetchFn: FetchLike = (u, i) => fetch(u, i)): Promise<EarHistory> {
  return request<EarHistory>(earHistoryUrl(level), fetchFn);
}
