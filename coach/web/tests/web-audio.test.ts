import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createSound } from "../src/web-audio.ts";

class FakeOsc {
  type = "";
  frequency = { value: 0 };
  stopCalls: unknown[][] = [];
  connect(g: unknown) {
    return g;
  }
  addEventListener() {}
  start() {}
  stop(...args: unknown[]) {
    this.stopCalls.push(args);
  }
}

const oscs: FakeOsc[] = [];

class FakeCtx {
  currentTime = 0;
  destination = {};
  resume() {
    return Promise.resolve();
  }
  createOscillator() {
    const osc = new FakeOsc();
    oscs.push(osc);
    return osc;
  }
  createGain() {
    return {
      gain: {
        setValueAtTime() {},
        linearRampToValueAtTime() {},
        exponentialRampToValueAtTime() {},
      },
      connect(d: unknown) {
        return d;
      },
    };
  }
}

const g = globalThis as unknown as { window?: unknown };
g.window = { AudioContext: FakeCtx };
after(() => {
  delete g.window;
});

const noArgStops = (osc: FakeOsc) => osc.stopCalls.filter((c) => c.length === 0).length;

test("stopNotes stops the note oscillator and leaves the click", () => {
  oscs.length = 0;
  const sound = createSound();
  sound.note(60, 100, 500, 0.5);
  sound.click(0, false, 0.5);
  const [noteOsc, clickOsc] = oscs;
  assert.equal(oscs.length, 2);

  sound.stopNotes();
  assert.equal(noArgStops(noteOsc), 1);
  assert.equal(noArgStops(clickOsc), 0);
});

test("a second stopNotes stops nothing more", () => {
  oscs.length = 0;
  const sound = createSound();
  sound.note(60, 100, 500, 0.5);
  const [noteOsc] = oscs;

  sound.stopNotes();
  sound.stopNotes();
  assert.equal(noArgStops(noteOsc), 1);
});

test("stopAll after a click stops the click", () => {
  oscs.length = 0;
  const sound = createSound();
  sound.note(60, 100, 500, 0.5);
  sound.click(0, false, 0.5);
  const [noteOsc, clickOsc] = oscs;

  sound.stopNotes();
  sound.stopAll();
  assert.equal(noArgStops(noteOsc), 1);
  assert.equal(noArgStops(clickOsc), 1);
});
