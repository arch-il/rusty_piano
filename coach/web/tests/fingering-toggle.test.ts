import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { initFingeringToggle, loadFingering, saveFingering, type KV } from "../src/fingering-toggle.ts";

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
function fakeButton() {
  let click: () => void = () => {};
  const attrs: Record<string, string> = {};
  return {
    attrs,
    click: () => click(),
    setAttribute: (n: string, v: string) => void (attrs[n] = v),
    addEventListener: (_t: "click", f: () => void) => void (click = f),
  };
}

test("load defaults", () => {
  assert.equal(loadFingering(fakeStore()), true);
  assert.equal(loadFingering(fakeStore({ "rp.fingering": "off" })), false);
  assert.equal(loadFingering(null), true);
  assert.equal(loadFingering(throwing), true);
  assert.doesNotThrow(() => saveFingering(throwing, false));
});

test("init and clicks", () => {
  const store = fakeStore();
  const b = fakeButton();
  const calls: boolean[] = [];
  initFingeringToggle(b, store, (on) => calls.push(on));
  assert.equal(b.attrs["aria-pressed"], "true");
  assert.deepEqual(calls, [true]);
  b.click();
  assert.equal(store.m.get("rp.fingering"), "off");
  assert.equal(b.attrs["aria-pressed"], "false");
  assert.deepEqual(calls, [true, false]);
  b.click();
  assert.equal(store.m.get("rp.fingering"), "on");
  assert.deepEqual(calls, [true, false, true]);
});

test("index.html and main.ts wiring", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  assert.match(html, /<button[^>]*id="fingering-toggle"[^>]*aria-pressed="true"/);
  assert.match(main, /initFingeringToggle\(/);
  assert.match(main, /piano\.setFingering\(/);
});
