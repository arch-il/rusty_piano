import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { drillHash, keepsPage, linkDrill, parseRoute } from "../src/drill-link.ts";

const main = readFileSync(fileURLToPath(new URL("../src/main.ts", import.meta.url)), "utf8");

function fnBody(src: string, header: string): string {
  const start = src.indexOf(header);
  assert.ok(start >= 0, header);
  return src.slice(start, src.indexOf("\n}\n", start));
}

test("drillHash keeps drill= through a parse round trip", () => {
  const hash = "#gen:r2-steps?drill=gen.r2-steps&bars=1-2&tempo=60";
  const r = parseRoute(hash);
  assert.equal(r.route.kind, "score");
  if (r.route.kind !== "score") return;
  assert.ok(r.route.link);
  assert.equal(linkDrill(r.route.link!).drill_id, "gen.r2-steps");
  const back = parseRoute(drillHash(r.route.id, r.route.link!));
  assert.equal(back.route.kind, "score");
  if (back.route.kind !== "score") return;
  assert.equal(back.route.link!.drill, "gen.r2-steps");
  assert.equal(back.route.link!.tempo, 60);
});

test("keepsPage keeps the page only when returning from Skills to the same link", () => {
  const link = { drill: "gen.r2-steps", tempo: 60 };
  assert.equal(keepsPage(true, false, link, { ...link }), true);
  assert.equal(keepsPage(true, true, link, { ...link }), false);
  assert.equal(keepsPage(false, false, link, { ...link }), false);
  assert.equal(keepsPage(true, false, link, null), false);
});

test("leaveSkills writes drillHash(currentId, activeLink) so drill= stays in the hash", () => {
  const body = fnBody(main, "function leaveSkills(");
  assert.ok(body.includes("activeLink"));
  assert.ok(body.includes("drillHash(currentId, activeLink)"));
});

test("the no-link route branch is the only place besides applyLink that clears the tag", () => {
  const body = fnBody(main, "function applyRoute(");
  assert.ok(body.includes("activeDrill = null"));
  assert.ok(body.includes("keepsPage(fromSkills, picked, route.link, activeLink)"));
});
