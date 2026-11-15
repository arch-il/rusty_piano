import { test } from "node:test";
import assert from "node:assert/strict";
import {
  backoffDelay,
  createEngineSocket,
  engineUrlFromSearch,
  noteName,
  parseEngineMessage,
  statusTooltip,
} from "../src/engine-socket.ts";
import type { EngineStatus, LiveEvent, NoteOnEvent } from "../src/engine-socket.ts";

test("engineUrlFromSearch reads the engine port", () => {
  assert.equal(engineUrlFromSearch("?engine=9001"), "ws://127.0.0.1:9001");
  assert.equal(engineUrlFromSearch("?foo=1&engine=8800"), "ws://127.0.0.1:8800");
  assert.equal(engineUrlFromSearch("?engine=08791"), "ws://127.0.0.1:8791");
});

test("engineUrlFromSearch falls back to the default port", () => {
  for (const search of ["", "?engine=", "?engine=0", "?engine=65536", "?engine=abc", "?engine=12a"]) {
    assert.equal(engineUrlFromSearch(search), "ws://127.0.0.1:8790", search);
  }
});

test("parseEngineMessage parses the README examples", () => {
  assert.deepEqual(
    parseEngineMessage('{"type":"hello","version":1,"engine":"rusty_piano","source":"live","time_unit":"ms"}'),
    { type: "hello", version: 1, source: "live" },
  );
  assert.deepEqual(parseEngineMessage('{"type":"note_on","t":1250,"note":60,"velocity":100}'), {
    type: "note_on",
    t: 1250,
    note: 60,
    velocity: 100,
    source: "engine",
  });
  assert.deepEqual(parseEngineMessage('{"type":"note_off","t":1470,"note":60}'), {
    type: "note_off",
    t: 1470,
    note: 60,
    source: "engine",
  });
  assert.deepEqual(parseEngineMessage('{"type":"sustain","t":3250,"on":true}'), {
    type: "sustain",
    t: 3250,
    on: true,
    source: "engine",
  });
});

test("parseEngineMessage returns null for bad input", () => {
  const bad: unknown[] = [
    "not json",
    5,
    new ArrayBuffer(8),
    "null",
    "[]",
    '{"type":"bogus","t":1}',
    '{"type":"note_on","t":1250,"note":128,"velocity":100}',
    '{"type":"note_on","t":1250,"note":60.5,"velocity":100}',
    '{"type":"note_on","t":1250,"note":60,"velocity":200}',
    '{"type":"note_on","note":60,"velocity":100}',
    '{"type":"note_on","t":"1250","note":60,"velocity":100}',
    '{"type":"sustain","t":3250,"on":1}',
  ];
  for (const data of bad) {
    assert.equal(parseEngineMessage(data), null, String(data));
  }
});

test("backoffDelay doubles then caps at 5 seconds", () => {
  assert.equal(backoffDelay(0), 1000);
  assert.equal(backoffDelay(1), 2000);
  assert.equal(backoffDelay(2), 4000);
  assert.equal(backoffDelay(3), 5000);
  assert.equal(backoffDelay(10), 5000);
});

test("noteName gives scientific pitch names", () => {
  assert.equal(noteName(60), "C4");
  assert.equal(noteName(61), "C#4");
  assert.equal(noteName(69), "A4");
  assert.equal(noteName(21), "A0");
  assert.equal(noteName(0), "C-1");
  assert.equal(noteName(127), "G9");
});

test("statusTooltip lines", () => {
  const engineNote: NoteOnEvent = { type: "note_on", t: 1, note: 60, velocity: 64, source: "engine" };
  const keyboardNote: NoteOnEvent = { type: "note_on", t: 1, note: 60, velocity: 80, source: "keyboard" };
  const url = "ws://127.0.0.1:8790";
  const connected: EngineStatus = { state: "connected", url, engineSource: "demo", closeReason: null };

  assert.equal(
    statusTooltip(connected, engineNote, null),
    "Engine: connected (demo)\nws://127.0.0.1:8790\nLast note: C4 vel 64",
  );
  assert.equal(
    statusTooltip({ state: "disconnected", url, engineSource: null, closeReason: "engine stopped" }, null, null).split("\n")[0],
    "Engine: disconnected (engine stopped), retrying",
  );
  assert.equal(
    statusTooltip({ state: "disconnected", url, engineSource: null, closeReason: null }, null, null).split("\n")[0],
    "Engine: disconnected, retrying",
  );
  assert.equal(
    statusTooltip({ state: "connecting", url, engineSource: null, closeReason: null }, null, null).split("\n")[0],
    "Engine: connecting",
  );
  assert.equal(
    statusTooltip(connected, keyboardNote, null).split("\n")[2],
    "Last note: C4 vel 80 (keyboard)",
  );
  assert.equal(statusTooltip(connected, null, "Press keys to play").split("\n")[3], "Press keys to play");
  assert.equal(statusTooltip(connected, null, null).split("\n")[2], "Last note: none");
});

interface FakeSocket {
  url: string;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  closed: boolean;
  close(): void;
}

interface FakeTimer {
  fn: () => void;
  ms: number;
  cleared: boolean;
}

function setup(createThrows = false) {
  const sockets: FakeSocket[] = [];
  const timers: FakeTimer[] = [];
  const socket = createEngineSocket({
    url: "ws://127.0.0.1:8790",
    createSocket(url) {
      if (createThrows) throw new Error("no socket");
      const s: FakeSocket = {
        url,
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
        closed: false,
        close() {
          this.closed = true;
        },
      };
      sockets.push(s);
      return s;
    },
    setTimer(fn, ms) {
      const t: FakeTimer = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimer(id) {
      (id as FakeTimer).cleared = true;
    },
  });
  return { socket, sockets, timers };
}

function last<T>(items: T[]): T {
  return items[items.length - 1];
}

function send(s: FakeSocket, data: unknown): void {
  s.onmessage?.({ data });
}

function closeSocket(s: FakeSocket, reason: string): void {
  s.onclose?.({ code: 1000, reason });
}

test("start() opens one socket and reports connecting", () => {
  const { socket, sockets } = setup();
  socket.start();
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].url, "ws://127.0.0.1:8790");
  assert.equal(socket.status().state, "connecting");
  socket.start();
  assert.equal(sockets.length, 1);
});

test("hello message gives connected with the engine source", () => {
  const { socket, sockets } = setup();
  socket.start();
  send(sockets[0], '{"type":"hello","version":1,"source":"demo"}');
  assert.deepEqual(socket.status(), {
    state: "connected",
    url: "ws://127.0.0.1:8790",
    engineSource: "demo",
    closeReason: null,
  });
});

test("note_on message reaches onEvent with source engine", () => {
  const { socket, sockets } = setup();
  const got: LiveEvent[] = [];
  socket.onEvent((ev) => got.push(ev));
  socket.start();
  send(sockets[0], '{"type":"note_on","t":1250,"note":60,"velocity":100}');
  assert.deepEqual(got, [{ type: "note_on", t: 1250, note: 60, velocity: 100, source: "engine" }]);
});

test("garbage and non-string messages are ignored", () => {
  const { socket, sockets } = setup();
  const got: LiveEvent[] = [];
  socket.onEvent((ev) => got.push(ev));
  socket.start();
  assert.doesNotThrow(() => {
    send(sockets[0], "garbage{");
    send(sockets[0], 5);
  });
  assert.deepEqual(got, []);
  assert.equal(socket.status().state, "connecting");
});

test("close with engine stopped schedules a reconnect after 1 second", () => {
  const { socket, sockets, timers } = setup();
  socket.start();
  closeSocket(sockets[0], "engine stopped");
  assert.deepEqual(socket.status(), {
    state: "disconnected",
    url: "ws://127.0.0.1:8790",
    engineSource: null,
    closeReason: "engine stopped",
  });
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 1000);
  timers[0].fn();
  assert.equal(sockets.length, 2);
});

test("repeated closes without hello back off to 5 seconds", () => {
  const { socket, sockets, timers } = setup();
  socket.start();
  for (let i = 0; i < 5; i++) {
    closeSocket(last(sockets), "");
    last(timers).fn();
  }
  assert.deepEqual(timers.map((t) => t.ms), [1000, 2000, 4000, 5000, 5000]);
});

test("a hello after reconnect resets the backoff", () => {
  const { socket, sockets, timers } = setup();
  socket.start();
  closeSocket(sockets[0], "");
  timers[0].fn();
  send(sockets[1], '{"type":"hello","version":1,"source":"live"}');
  closeSocket(sockets[1], "");
  assert.equal(timers.length, 2);
  assert.equal(timers[1].ms, 1000);
});

test("the close reason is kept across later closes without a reason", () => {
  const { socket, sockets, timers } = setup();
  socket.start();
  closeSocket(sockets[0], "engine stopped");
  timers[0].fn();
  assert.equal(socket.status().state, "connecting");
  assert.equal(socket.status().closeReason, "engine stopped");
  sockets[1].onclose?.({ code: 1006, reason: "" });
  const st = socket.status();
  assert.equal(st.state, "disconnected");
  assert.equal(st.closeReason, "engine stopped");
  assert.ok(statusTooltip(st, null, null).startsWith("Engine: disconnected (engine stopped), retrying"));
});

test("a hello clears the kept close reason", () => {
  const { socket, sockets, timers } = setup();
  socket.start();
  closeSocket(sockets[0], "engine stopped");
  timers[0].fn();
  sockets[1].onclose?.({ code: 1006, reason: "" });
  timers[1].fn();
  send(sockets[2], '{"type":"hello","version":1,"source":"live"}');
  assert.equal(socket.status().closeReason, null);
  closeSocket(sockets[2], "");
  assert.equal(socket.status().closeReason, null);
});

test("stop() after a reasoned close clears the reason", () => {
  const { socket, sockets } = setup();
  socket.start();
  closeSocket(sockets[0], "engine stopped");
  socket.stop();
  assert.equal(socket.status().closeReason, null);
});

test("statusTooltip for connecting shows the kept reason", () => {
  const url = "ws://127.0.0.1:8790";
  assert.ok(
    statusTooltip({ state: "connecting", url, engineSource: null, closeReason: "engine stopped" }, null, null).startsWith(
      "Engine: connecting (engine stopped)",
    ),
  );
  assert.equal(
    statusTooltip({ state: "connecting", url, engineSource: null, closeReason: null }, null, null).split("\n")[0],
    "Engine: connecting",
  );
});

test("stop() clears the pending reconnect timer", () => {
  const { socket, sockets, timers } = setup();
  socket.start();
  closeSocket(sockets[0], "engine stopped");
  socket.stop();
  assert.equal(timers[0].cleared, true);
  assert.equal(sockets.length, 1);
});

test("stop() closes the current socket and creates no more", () => {
  const { socket, sockets, timers } = setup();
  socket.start();
  send(sockets[0], '{"type":"hello","version":1,"source":"live"}');
  socket.stop();
  assert.equal(sockets[0].closed, true);
  assert.equal(sockets[0].onmessage, null);
  assert.deepEqual(socket.status(), {
    state: "disconnected",
    url: "ws://127.0.0.1:8790",
    engineSource: null,
    closeReason: null,
  });
  assert.equal(timers.length, 0);
  assert.equal(sockets.length, 1);
});

test("publish() delivers a keyboard event unchanged", () => {
  const { socket } = setup();
  const got: LiveEvent[] = [];
  socket.onEvent((ev) => got.push(ev));
  const ev: LiveEvent = { type: "note_on", t: 5, note: 60, velocity: 80, source: "keyboard" };
  socket.publish(ev);
  assert.equal(got.length, 1);
  assert.equal(got[0], ev);
});

test("unsubscribe functions remove listeners", () => {
  const { socket, sockets } = setup();
  const events: LiveEvent[] = [];
  const statuses: EngineStatus[] = [];
  const offEvent = socket.onEvent((ev) => events.push(ev));
  const offStatus = socket.onStatus((s) => statuses.push(s));
  offEvent();
  offStatus();
  socket.start();
  send(sockets[0], '{"type":"note_on","t":1,"note":60,"velocity":100}');
  socket.publish({ type: "note_off", t: 2, note: 60, source: "keyboard" });
  assert.equal(events.length, 0);
  assert.equal(statuses.length, 0);
});

test("a throwing listener does not stop the others", () => {
  const { socket, sockets } = setup();
  const originalError = console.error;
  console.error = () => {};
  try {
    const got: LiveEvent[] = [];
    const statuses: string[] = [];
    socket.onEvent(() => {
      throw new Error("boom");
    });
    socket.onEvent((ev) => got.push(ev));
    socket.onStatus(() => {
      throw new Error("boom");
    });
    socket.onStatus((s) => statuses.push(s.state));
    socket.start();
    send(sockets[0], '{"type":"note_on","t":1,"note":60,"velocity":100}');
    assert.equal(got.length, 1);
    assert.deepEqual(statuses, ["connecting"]);
  } finally {
    console.error = originalError;
  }
});

test("a createSocket that throws gives disconnected and a 1 second timer", () => {
  const { socket, timers } = setup(true);
  socket.start();
  assert.equal(socket.status().state, "disconnected");
  assert.equal(socket.status().closeReason, null);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 1000);
});

test("onStatus receives connecting, connected, disconnected", () => {
  const { socket, sockets } = setup();
  const states: string[] = [];
  socket.onStatus((s) => states.push(s.state));
  socket.start();
  send(sockets[0], '{"type":"hello","version":1,"source":"live"}');
  closeSocket(sockets[0], "");
  assert.deepEqual(states, ["connecting", "connected", "disconnected"]);
});

test("stop() then start() on a fresh client creates no socket", () => {
  const { socket, sockets } = setup();
  socket.stop();
  socket.start();
  assert.equal(sockets.length, 0);
  assert.equal(socket.status().state, "disconnected");
});

test("a timer that fires after stop() creates no socket and start() schedules nothing", () => {
  const { socket, sockets, timers } = setup();
  socket.start();
  closeSocket(sockets[0], "");
  socket.stop();
  timers[0].fn();
  socket.start();
  assert.equal(sockets.length, 1);
  assert.equal(timers.length, 1);
});

test("statusTooltip marks autoplay notes", () => {
  const note: NoteOnEvent = { type: "note_on", t: 1, note: 60, velocity: 80, source: "autoplay" };
  const status: EngineStatus = { state: "connected", url: "ws://127.0.0.1:8790", engineSource: "demo", closeReason: null };
  assert.equal(statusTooltip(status, note, null).split("\n")[2], "Last note: C4 vel 80 (auto-play)");
});
