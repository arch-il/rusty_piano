import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const css = readFileSync(fileURLToPath(new URL("../src/styles.css", import.meta.url)), "utf8");

function mediaBlock(width: number): string | undefined {
  const head = `@media (max-width: ${width}px) {`;
  const start = css.indexOf(head);
  if (start < 0) return undefined;
  const open = start + head.length - 1;
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  return undefined;
}

function ruleIn(block: string, selector: string): string | undefined {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`(^|[}\\s])${esc}\\s*\\{`).exec(block);
  if (!m) return undefined;
  const from = m.index + m[0].length;
  const end = block.indexOf("}", from);
  return block.slice(from, end).replace(/\s+/g, " ");
}

test("400 px block shows the follow status under the top bar", () => {
  const block = mediaBlock(400);
  assert.ok(block);
  const rule = ruleIn(block, ".follow-status");
  assert.ok(rule);
  assert.ok(rule.includes("position: fixed"));
  assert.ok(rule.includes("top: var(--topbar-height)"));
  assert.ok(!/display\s*:/.test(rule));
});

test("580 px block keeps the Options popup inside the window", () => {
  const block = mediaBlock(580);
  assert.ok(block);
  const rule = ruleIn(block, ".practice-options");
  assert.ok(rule);
  assert.ok(rule.includes("position: fixed"));
  assert.ok(rule.includes("left: var(--space-2)"));
  assert.ok(rule.includes("max-width: calc(100vw - 2 * var(--space-2))"));
});

test(".follow-status:empty is still hidden", () => {
  const rule = ruleIn(css, ".follow-status:empty");
  assert.ok(rule);
  assert.ok(rule.includes("display: none"));
});
