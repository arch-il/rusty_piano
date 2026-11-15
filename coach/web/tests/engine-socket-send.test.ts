import { test } from "node:test";
import assert from "node:assert/strict";
import { createEngineSocket, parseEngineMessage } from "../src/engine-socket.ts";
import type { LiveEvent, PlayAck, SocketLike } from "../src/engine-socket.ts";

interface FakeSocket extends SocketLike {
  sent: string[];
}

function setup() {
  const sockets: FakeSocket[] = [];
  const socket = createEngineSocket({
    url: "ws://127.0.0.1:8790",
    createSocket() {
      const s: FakeSocket = {
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
        sent: [],
        close() {},
        send(data: string) {
          this.sent.push(data);
        },
      };
      sockets.push(s);
      return s;
    },
    setTimer: () => null,
    clearTimer: () => {},
  });
  return { socket, sockets };
}

function receive(s: FakeSocket, data: unknown): void {
  s.onmessage?.({ data });
}

test("send is false before hello and true after, and the text reaches the socket", () => {
  const { socket, sockets } = setup();
  socket.start();
  assert.equal(socket.send("play_notes"), false);
  assert.deepEqual(sockets[0].sent, []);
  receive(sockets[0], '{"type":"hello","version":1,"source":"live"}');
  assert.equal(socket.send("play_notes"), true);
  assert.deepEqual(sockets[0].sent, ["play_notes"]);
});

test("send is false when the socket has no send method", () => {
  const sockets: SocketLike[] = [];
  const socket = createEngineSocket({
    url: "ws://127.0.0.1:8790",
    createSocket() {
      const s: SocketLike = { onopen: null, onmessage: null, onclose: null, onerror: null, close() {} };
      sockets.push(s);
      return s;
    },
    setTimer: () => null,
    clearTimer: () => {},
  });
  socket.start();
  sockets[0].onmessage?.({ data: '{"type":"hello","version":1,"source":"live"}' });
  assert.equal(socket.send("x"), false);
});

test("send is false when the socket throws", () => {
  const sockets: FakeSocket[] = [];
  const socket = createEngineSocket({
    url: "ws://127.0.0.1:8790",
    createSocket() {
      const s: FakeSocket = {
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
        sent: [],
        close() {},
        send() {
          throw new Error("closed");
        },
      };
      sockets.push(s);
      return s;
    },
    setTimer: () => null,
    clearTimer: () => {},
  });
  socket.start();
  receive(sockets[0], '{"type":"hello","version":1,"source":"live"}');
  assert.equal(socket.send("x"), false);
});

test("play_ack goes to onAck and never to onEvent", () => {
  const { socket, sockets } = setup();
  const events: LiveEvent[] = [];
  const acks: PlayAck[] = [];
  socket.onEvent((ev) => events.push(ev));
  socket.onAck((ack) => acks.push(ack));
  socket.start();
  receive(sockets[0], '{"type":"play_ack","id":"ear-1","ok":true,"notes":2}');
  assert.deepEqual(acks, [{ type: "play_ack", id: "ear-1", ok: true, notes: 2, reason: null }]);
  assert.deepEqual(events, []);
});

test("parseEngineMessage parses a play_ack exactly", () => {
  assert.deepEqual(parseEngineMessage('{"type":"play_ack","id":"ear-1","ok":true,"notes":2}'), {
    type: "play_ack",
    id: "ear-1",
    ok: true,
    notes: 2,
    reason: null,
  });
  assert.deepEqual(parseEngineMessage('{"type":"play_ack","id":"ear-1","ok":false,"notes":0,"reason":"busy"}'), {
    type: "play_ack",
    id: "ear-1",
    ok: false,
    notes: 0,
    reason: "busy",
  });
});

test("invalid acks are ignored", () => {
  const bad: unknown[] = [
    '{"type":"play_ack","ok":true,"notes":2}',
    '{"type":"play_ack","id":"","ok":true,"notes":2}',
    '{"type":"play_ack","id":"' + "a".repeat(41) + '","ok":true,"notes":2}',
    '{"type":"play_ack","id":5,"ok":true,"notes":2}',
    '{"type":"play_ack","id":"ear-1","ok":"yes","notes":2}',
    '{"type":"play_ack","id":"ear-1","ok":true,"notes":129}',
    '{"type":"play_ack","id":"ear-1","ok":true,"notes":2.5}',
    '{"type":"play_ack","id":"ear-1","ok":true}',
  ];
  for (const data of bad) {
    assert.equal(parseEngineMessage(data), null, String(data));
  }
  const { socket, sockets } = setup();
  const acks: PlayAck[] = [];
  socket.onAck((ack) => acks.push(ack));
  socket.start();
  for (const data of bad) receive(sockets[0], data);
  assert.deepEqual(acks, []);
});

test("hello and note events are unchanged", () => {
  const { socket, sockets } = setup();
  const events: LiveEvent[] = [];
  const acks: PlayAck[] = [];
  socket.onEvent((ev) => events.push(ev));
  socket.onAck((ack) => acks.push(ack));
  socket.start();
  receive(sockets[0], '{"type":"note_on","t":1250,"note":60,"velocity":100}');
  receive(sockets[0], '{"type":"hello","version":1,"source":"play"}');
  assert.deepEqual(events, [{ type: "note_on", t: 1250, note: 60, velocity: 100, source: "engine" }]);
  assert.deepEqual(acks, []);
  assert.equal(socket.status().state, "connected");
});

test("engineSource is reported from hello", () => {
  const { socket, sockets } = setup();
  socket.start();
  assert.equal(socket.status().engineSource, null);
  receive(sockets[0], '{"type":"hello","version":1,"source":"play"}');
  assert.equal(socket.status().engineSource, "play");
});
