import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (n: string): string => readFileSync(fileURLToPath(new URL("../src/" + n, import.meta.url)), "utf8");
const main = read("main.ts");
const topbar = read("topbar.ts");

test("top-bar Start is disabled while sight is shown", () => {
  const body = main.slice(main.indexOf("function renderFollow("), main.indexOf("function cancelFrames("));
  assert.ok(body.includes("startOff: sightShown()"));
  assert.ok(topbar.includes("startOff?: boolean"));
  assert.ok(topbar.includes("cursorStart.disabled = p.startOff === true"));
  assert.ok(topbar.includes('const cursorStart = byId<HTMLButtonElement>("cursor-start")'));
});
