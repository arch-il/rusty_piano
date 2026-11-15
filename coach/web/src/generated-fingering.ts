import { fetchFingering, startFingering } from "./api.ts";
import type { FetchLike, FingeringStatus } from "./api.ts";

export type FingerMap = Map<string, string>;

export const FINGERING_POLL_MS = 3000;
export const FINGERING_MAX_POLLS = 600;

export function fingerKey(measureIndex: number, beat: number, staff: number, midi: number): string {
  return `${measureIndex}|${Math.round(beat * 1000)}|${staff}|${midi}`;
}

export function fingerMap(notes: readonly unknown[] | null | undefined): FingerMap {
  const map: FingerMap = new Map();
  for (const entry of notes ?? []) {
    if (typeof entry !== "object" || entry === null) continue;
    const { m, q, s, p, f } = entry as Record<string, unknown>;
    if (!Number.isFinite(m) || !Number.isFinite(q) || !Number.isFinite(s) || !Number.isFinite(p)) continue;
    if (typeof m !== "number" || typeof q !== "number" || typeof s !== "number" || typeof p !== "number") continue;
    if (typeof f !== "string" || f.trim() === "") continue;
    const key = fingerKey(m, q, s, p);
    if (!map.has(key)) map.set(key, f.trim());
  }
  return map;
}

export function pickFinger(written: string | null, map: FingerMap | null, key: string): string | null {
  return written ?? map?.get(key) ?? null;
}

export interface FingeringDeps {
  isCurrent: () => boolean;
  onReady: (map: FingerMap) => void;
  fetchFn?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  warn?: (message: string) => void;
  pollMs?: number;
  maxPolls?: number;
}

export async function loadGeneratedFingering(scoreId: string, deps: FingeringDeps): Promise<void> {
  const fetchFn = deps.fetchFn ?? ((u, i) => fetch(u, i));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const warn = deps.warn ?? ((m: string) => console.warn(m));
  const pollMs = deps.pollMs ?? FINGERING_POLL_MS;
  const maxPolls = deps.maxPolls ?? FINGERING_MAX_POLLS;
  try {
    let st: FingeringStatus = await startFingering(scoreId, fetchFn);
    let polls = 0;
    for (;;) {
      if (!deps.isCurrent()) return;
      if (st.status === "ready") {
        deps.onReady(fingerMap(st.notes));
        return;
      }
      if (st.status === "error") {
        warn(`fingering: could not make fingering for this score: ${st.error ?? "unknown error"}`);
        return;
      }
      if (st.status !== "pending") return;
      if (polls >= maxPolls) {
        warn("fingering: still not ready, giving up for now");
        return;
      }
      await sleep(pollMs);
      polls++;
      if (!deps.isCurrent()) return;
      st = await fetchFingering(scoreId, fetchFn);
    }
  } catch (e) {
    warn(`fingering: ${e instanceof Error ? e.message : String(e)}`);
  }
}
