import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseRoute } from "../src/drill-link.ts";

const main = readFileSync(fileURLToPath(new URL("../src/main.ts", import.meta.url)), "utf8");
const html = readFileSync(fileURLToPath(new URL("../index.html", import.meta.url)), "utf8");

function body(name: string): string {
  return main.slice(main.indexOf(name), main.indexOf("\n}\n", main.indexOf(name)));
}

test("index.html has a Free play nav link after Ear and before the nav end", () => {
  assert.match(html, /id="free-link"[^>]*href="#\/free"[^>]*>Free play</);
  const free = html.indexOf('id="free-link"');
  assert.ok(free > html.indexOf('id="ear-link"'));
  assert.ok(free < html.indexOf("</nav>"));
});

test("main.ts wires the free play view and free hash", () => {
  for (const s of [
    "createFreePlayView(",
    'byId<HTMLElement>("free-play")',
    "engine.onEvent((ev) => freePlay.handle(ev))",
    "isFreeHash(hash)",
    "function closeScore(",
    "function syncFreePlay(",
  ]) {
    assert.ok(main.includes(s), s);
  }
  assert.ok(!main.includes("NO_PIECE_MESSAGE"));
});

test("an empty library message is hidden when no piece is open", () => {
  const sidebar = main.slice(main.indexOf("const sidebar = createSidebar("), main.indexOf("});", main.indexOf("const sidebar = createSidebar(")));
  assert.ok(sidebar.includes("else hideMessage();"));
});

test("closeScore resets the score and syncs free play in order", () => {
  const b = body("function closeScore(");
  const order = [
    "stopFollowing()",
    "topbar.closeInfo()",
    "token++",
    "view.clear()",
    'state = "idle"',
    "sidebar.setCurrent(null)",
    "topbar.setScore(null)",
    "hideMessage()",
    "syncFreePlay()",
  ];
  let last = -1;
  for (const s of order) {
    const i = b.indexOf(s);
    assert.ok(i > last, s);
    last = i;
  }
});

test("syncFreePlay gates on idle or hashError and the other views", () => {
  const b = body("function syncFreePlay(");
  for (const s of [
    'state === "idle"',
    'state === "hashError"',
    "sightShown()",
    "skills.visible()",
    "logView.visible()",
    "freePlay.setActive(",
  ]) {
    assert.ok(b.includes(s), s);
  }
});

test("openScore and openFromHash sync free play after entering opening", () => {
  const s = body("async function openScore(");
  assert.ok(s.indexOf("syncFreePlay()") > s.indexOf('state = "opening"'));
  const f = body("async function openFromHash(");
  assert.ok(f.split("syncFreePlay()").length - 1 >= 2);
});

test("applyRoute closes the score for the free hash before the score check", () => {
  const b = body("function applyRoute(");
  assert.ok(b.includes('if (state !== "idle") closeScore();'));
  const i = b.indexOf("if (isFreeHash(hash))");
  assert.ok(i > b.indexOf("const fromSkills = skills.visible();"));
  assert.ok(i < b.indexOf('if (route.kind !== "score") return;'));
});

test("hashchange also syncs free play", () => {
  assert.match(main, /addEventListener\("hashchange", \(\) => \{\s*applyRoute\(location\.hash\);\s*syncFreePlay\(\);/);
});

test("startup syncs free play after the last applyRoute", () => {
  const i = main.lastIndexOf("applyRoute(location.hash);");
  assert.ok(main.slice(i, i + 80).includes("syncFreePlay();"));
});

test("free play view is created between liveKeys and the score view", () => {
  const c = main.indexOf("createFreePlayView(");
  assert.ok(c > main.indexOf("const liveKeys = createLiveKeys();"));
  assert.ok(c < main.indexOf("const view = new ScoreView("));
});

test("#/free parses as no route with no warnings", () => {
  const { route, warnings } = parseRoute("#/free");
  assert.equal(route.kind, "none");
  assert.deepEqual(warnings, []);
});
