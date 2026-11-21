import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

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

test("580px block wraps the replay bar and moves the server banner to the bottom", () => {
  assert.equal(css.split("@media (max-width: 580px)").length - 1, 1, "exactly one 580px media block");
  const b580 = mediaBlock(580);
  assert.ok(b580, "580px media block missing");
  assert.ok(b580.includes(".replay-bar {"));
  assert.ok(b580.includes("flex-wrap: wrap"));
  assert.ok(b580.includes(".server-banner {"));
  assert.ok(b580.includes("top: auto"));
});
