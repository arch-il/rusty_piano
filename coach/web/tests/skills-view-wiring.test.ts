import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const html = read("../index.html");
const main = read("../src/main.ts");
const view = read("../src/skills-view.ts");
const css = read("../src/styles.css");

test("index.html has the skills ids", () => {
  for (const id of ["skills-link", "skills-view", "skills-back", "skills-status", "skills-graph", "skills-panel"]) {
    assert.ok(html.includes(`id="${id}"`), `missing #${id}`);
  }
  assert.ok(/id="skills-link"[^>]*href="#\/skills"/.test(html));
});

test("main.ts wires the skills view", () => {
  for (const s of ["createSkillsView(", "fetchPlan()", 'route.kind === "skills"', "enterSkills()", "leaveSkills", "skills.hide()"]) {
    assert.ok(main.includes(s), `missing ${s}`);
  }
});

test("skills view is created before the first route is applied", () => {
  assert.ok(main.indexOf("const skills = createSkillsView(") >= 0);
  assert.ok(main.indexOf("const skills = createSkillsView(") < main.indexOf("applyRoute(location.hash)"));
});

test("skills-view.ts uses plain DOM", () => {
  for (const s of ["replaceChildren(", "createElementNS(", "drillHash", "nodePanel("]) {
    assert.ok(view.includes(s), `missing ${s}`);
  }
  assert.ok(!view.includes("innerHTML"));
});

test("every class set in skills-view.ts has a CSS rule", () => {
  const names = [
    ...[...view.matchAll(/className = '([^']+)'/g)].map((m) => m[1]),
    ...[...view.matchAll(/setAttribute\('class', '([^']+)'\)/g)].map((m) => m[1]),
    ...[...view.matchAll(/svgEl\('[a-z]+', '([^']+)'\)/g)].map((m) => m[1]),
  ];
  assert.ok(names.length > 0);
  const dynamic = /^(level-\d|locked|rusty|selected)$/;
  for (const n of names.flatMap((x) => x.split(" ")).filter((c) => !dynamic.test(c))) {
    assert.ok(css.includes(`.${n}`), `missing .${n}`);
  }
});

test("level colours and variables exist", () => {
  for (let i = 0; i <= 4; i++) {
    assert.ok(new RegExp(`\\.skill-node\\.level-${i} \\.skill-box\\s*\\{[^}]*var\\(--color-level-${i}\\)`).test(css), `level-${i}`);
    assert.ok(css.includes(`--color-level-${i}:`));
  }
  for (const v of ["--color-locked:", "--color-rusty:", "--color-edge:", "--skills-panel-width:"]) {
    assert.ok(css.includes(v), `missing ${v}`);
  }
});

test("leaveSkills returns to the active drill link", () => {
  assert.ok(main.includes("let activeLink"));
  const start = main.indexOf("function leaveSkills(): void {");
  assert.ok(start >= 0);
  const body = main.slice(start, main.indexOf("\n}\n", start));
  assert.ok(body.includes("drillHash(currentId, activeLink)"), body);
});
