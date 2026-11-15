/**
 * Connects to the engine's live event WebSocket (protocol in engine/README.md,
 * "Live events (WebSocket)"), reconnects with backoff when it drops, and gives
 * subscribers typed live events and connection status.
 */

export const DEFAULT_ENGINE_PORT = 8790;
export const BACKOFF_START_MS = 1000;
export const BACKOFF_MAX_MS = 5000;

export type LiveSource = "engine" | "keyboard" | "autoplay";

export type LiveEvent =
  | { type: "note_on"; t: number; note: number; velocity: number; source: LiveSource }
  | { type: "note_off"; t: number; note: number; source: LiveSource }
  | { type: "sustain"; t: number; on: boolean; source: LiveSource };

export type NoteOnEvent = Extract<LiveEvent, { type: "note_on" }>;

export interface HelloMessage {
  type: "hello";
  version: number;
  source: string;
}

export interface PlayAck {
  type: "play_ack";
  id: string;
  ok: boolean;
  notes: number;
  reason: string | null;
}

export type EngineMessage = HelloMessage | LiveEvent | PlayAck;

export type EngineState = "connecting" | "connected" | "disconnected";

export interface EngineStatus {
  state: EngineState;
  url: string;
  engineSource: string | null;
  /** reason of the last close that had one (e.g. 'engine stopped'), kept until the engine says hello again */
  closeReason: string | null;
}

export interface SocketLike {
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  close(): void;
  send?(data: string): void;
}

export interface EngineSocketOptions {
  url: string;
  createSocket?: (url: string) => SocketLike;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
}

export interface EngineSocket {
  readonly url: string;
  status(): EngineStatus;
  start(): void;
  stop(): void;
  onEvent(fn: (ev: LiveEvent) => void): () => void;
  onStatus(fn: (s: EngineStatus) => void): () => void;
  onAck(fn: (ack: PlayAck) => void): () => void;
  publish(ev: LiveEvent): void;
  send(text: string): boolean;
}

export function engineUrlFromSearch(search: string): string {
  const v = new URLSearchParams(search).get("engine");
  const port =
    v !== null && /^\d{1,5}$/.test(v) && Number(v) >= 1 && Number(v) <= 65535
      ? Number(v)
      : DEFAULT_ENGINE_PORT;
  return "ws://127.0.0.1:" + String(port);
}

function isInteger(x: unknown, min: number, max: number): boolean {
  return typeof x === "number" && Number.isInteger(x) && x >= min && x <= max;
}

function isTime(x: unknown): boolean {
  return typeof x === "number" && Number.isFinite(x);
}

export function parseEngineMessage(data: unknown): EngineMessage | null {
  if (typeof data !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const o = parsed as Record<string, unknown>;
  switch (o.type) {
    case "hello":
      if (typeof o.version === "number" && typeof o.source === "string") {
        return { type: "hello", version: o.version, source: o.source };
      }
      return null;
    case "note_on":
      if (isTime(o.t) && isInteger(o.note, 0, 127) && isInteger(o.velocity, 0, 127)) {
        return {
          type: "note_on",
          t: o.t as number,
          note: o.note as number,
          velocity: o.velocity as number,
          source: "engine",
        };
      }
      return null;
    case "note_off":
      if (isTime(o.t) && isInteger(o.note, 0, 127)) {
        return { type: "note_off", t: o.t as number, note: o.note as number, source: "engine" };
      }
      return null;
    case "sustain":
      if (isTime(o.t) && typeof o.on === "boolean") {
        return { type: "sustain", t: o.t as number, on: o.on, source: "engine" };
      }
      return null;
    case "play_ack":
      if (
        typeof o.id === "string" &&
        o.id.length >= 1 &&
        o.id.length <= 40 &&
        typeof o.ok === "boolean" &&
        isInteger(o.notes, 0, 128)
      ) {
        return {
          type: "play_ack",
          id: o.id,
          ok: o.ok,
          notes: o.notes as number,
          reason: typeof o.reason === "string" ? o.reason : null,
        };
      }
      return null;
    default:
      return null;
  }
}

export function backoffDelay(attempt: number): number {
  return Math.min(BACKOFF_START_MS * 2 ** attempt, BACKOFF_MAX_MS);
}

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

export function noteName(note: number): string {
  return NOTE_NAMES[note % 12] + String(Math.floor(note / 12) - 1);
}

export function statusTooltip(
  status: EngineStatus,
  lastNote: NoteOnEvent | null,
  keyboardHint: string | null,
): string {
  let first: string;
  if (status.state === "connected") {
    first = "Engine: connected" + (status.engineSource !== null ? " (" + status.engineSource + ")" : "");
  } else if (status.state === "connecting") {
    first = "Engine: connecting" + (status.closeReason !== null ? " (" + status.closeReason + ")" : "");
  } else {
    first =
      "Engine: disconnected" +
      (status.closeReason !== null ? " (" + status.closeReason + ")" : "") +
      ", retrying";
  }
  const lines = [first, status.url];
  if (lastNote === null) {
    lines.push("Last note: none");
  } else {
    lines.push(
      "Last note: " +
        noteName(lastNote.note) +
        " vel " +
        String(lastNote.velocity) +
        (lastNote.source === "keyboard" ? " (keyboard)" : lastNote.source === "autoplay" ? " (auto-play)" : ""),
    );
  }
  if (keyboardHint !== null) lines.push(keyboardHint);
  return lines.join("\n");
}

function deliver<T>(listeners: Set<(v: T) => void>, v: T): void {
  for (const fn of listeners) {
    try {
      fn(v);
    } catch (err) {
      console.error(err);
    }
  }
}

export function createEngineSocket(opts: EngineSocketOptions): EngineSocket {
  const url = opts.url;
  const createSocket =
    opts.createSocket ?? ((u: string) => new WebSocket(u) as unknown as SocketLike);
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((id: unknown) => clearTimeout(id as number));

  let current: SocketLike | null = null;
  let timer: unknown = null;
  let attempt = 0;
  let started = false;
  let stopped = false;
  let lastReason: string | null = null;
  let state: EngineStatus = { state: "disconnected", url, engineSource: null, closeReason: null };
  const eventListeners = new Set<(ev: LiveEvent) => void>();
  const statusListeners = new Set<(s: EngineStatus) => void>();
  const ackListeners = new Set<(ack: PlayAck) => void>();

  function setStatus(next: EngineStatus): void {
    state = next;
    deliver(statusListeners, { ...state });
  }

  function handleClosed(reason: string | null): void {
    if (stopped) return;
    current = null;
    if (reason) lastReason = reason;
    setStatus({ state: "disconnected", url, engineSource: null, closeReason: lastReason });
    const delay = backoffDelay(attempt);
    attempt += 1;
    timer = setTimer(() => {
      timer = null;
      connect();
    }, delay);
  }

  function connect(): void {
    if (stopped) return;
    setStatus({ state: "connecting", url, engineSource: null, closeReason: lastReason });
    let sock: SocketLike;
    try {
      sock = createSocket(url);
    } catch {
      handleClosed(null);
      return;
    }
    current = sock;
    sock.onopen = () => {};
    sock.onmessage = (ev) => {
      const m = parseEngineMessage(ev.data);
      if (m === null) return;
      if (m.type === "hello") {
        attempt = 0;
        lastReason = null;
        setStatus({ state: "connected", url, engineSource: m.source, closeReason: null });
      } else if (m.type === "play_ack") {
        deliver(ackListeners, m);
      } else {
        deliver(eventListeners, m);
      }
    };
    sock.onerror = () => {};
    sock.onclose = (ev) => {
      if (stopped || current !== sock) return;
      handleClosed(ev.reason ? ev.reason : null);
    };
  }

  function start(): void {
    if (started || stopped) return;
    started = true;
    connect();
  }

  function stop(): void {
    stopped = true;
    lastReason = null;
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    if (current !== null) {
      const sock = current;
      sock.onopen = null;
      sock.onmessage = null;
      sock.onclose = null;
      sock.onerror = null;
      try {
        sock.close();
      } catch {}
      current = null;
    }
    setStatus({ state: "disconnected", url, engineSource: null, closeReason: null });
  }

  return {
    url,
    status: () => ({ ...state }),
    start,
    stop,
    onEvent(fn) {
      eventListeners.add(fn);
      return () => {
        eventListeners.delete(fn);
      };
    },
    onStatus(fn) {
      statusListeners.add(fn);
      return () => {
        statusListeners.delete(fn);
      };
    },
    onAck(fn) {
      ackListeners.add(fn);
      return () => {
        ackListeners.delete(fn);
      };
    },
    publish(ev) {
      deliver(eventListeners, ev);
    },
    send(text) {
      const sock = current;
      if (sock === null || sock.send === undefined || state.state !== "connected") return false;
      try {
        sock.send(text);
        return true;
      } catch {
        return false;
      }
    },
  };
}
