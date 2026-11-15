import { formatSeconds } from "./sight-levels.ts";
import type { LevelDef, SightRound } from "./sight-levels.ts";
import { noteMap, noteMapKeys, roundsOfLevel, trendChart, weakest } from "./sight-stats.ts";
import { noteName } from "./engine-socket.ts";
import type { PlanTree } from "./skills-logic.ts";

const SVG_NS = "http://www.w3.org/2000/svg";
const WIDTH = 560;
const HEIGHT = 180;
const PAD = 32;

export function treeHasDrill(tree: PlanTree, drillId: string): boolean {
  return tree.nodes.some((n) => n.drills.some((d) => d.id === drillId));
}

function svg(tag: string, cls: string, attrs: Record<string, string | number> = {}): SVGElement {
  const e = document.createElementNS(SVG_NS, tag);
  e.setAttribute("class", cls);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

function titled(e: SVGElement, text: string): SVGElement {
  const t = document.createElementNS(SVG_NS, "title");
  t.textContent = text;
  e.appendChild(t);
  return e;
}

function text(cls: string, x: number, y: number, anchor: string, s: string): SVGElement {
  const t = svg("text", cls, { x, y, "text-anchor": anchor });
  t.textContent = s;
  return t;
}

function heading(s: string): HTMLElement {
  const h = document.createElement("h3");
  h.className = "sight-history-title";
  h.textContent = s;
  return h;
}

export function renderSightHistory(el: HTMLElement, rounds: readonly SightRound[], level: LevelDef): void {
  const levelRounds = roundsOfLevel(rounds, level.id);
  const title = heading("Progress: " + level.title);
  if (levelRounds.length === 0) {
    const p = document.createElement("p");
    p.className = "sight-empty";
    p.textContent = "No rounds yet for this level.";
    el.replaceChildren(title, p);
    return;
  }

  const chart = trendChart(levelRounds, { width: WIDTH, height: HEIGHT, pad: PAD });
  const trend = svg("svg", "sight-trend", { width: WIDTH, height: HEIGHT, viewBox: `0 0 ${WIDTH} ${HEIGHT}` });
  trend.append(
    svg("line", "sight-trend-axis", { x1: PAD, y1: HEIGHT - PAD, x2: WIDTH - PAD, y2: HEIGHT - PAD }),
    svg("line", "sight-trend-axis", { x1: PAD, y1: PAD, x2: PAD, y2: HEIGHT - PAD }),
    svg("path", "sight-trend-acc", { d: chart.accPath }),
    svg("path", "sight-trend-time", { d: chart.timePath }),
  );
  for (const d of chart.accDots) trend.appendChild(titled(svg("circle", "sight-trend-dot-acc", { cx: d.x, cy: d.y, r: 3 }), d.title));
  for (const d of chart.timeDots) trend.appendChild(titled(svg("circle", "sight-trend-dot-time", { cx: d.x, cy: d.y, r: 3 }), d.title));
  for (const l of chart.xLabels) trend.appendChild(text("sight-trend-label", l.x, HEIGHT - 8, "middle", l.text));
  for (const t of chart.accTicks) trend.appendChild(text("sight-trend-label", PAD - 4, t.y + 4, "end", t.text));
  for (const t of chart.timeTicks) trend.appendChild(text("sight-trend-label", WIDTH - PAD + 4, t.y + 4, "start", t.text));

  const legend = document.createElement("p");
  legend.className = "sight-trend-legend";
  const swAcc = document.createElement("span");
  swAcc.className = "sight-swatch-acc";
  swAcc.textContent = "first try %";
  const swTime = document.createElement("span");
  swTime.className = "sight-swatch-time";
  swTime.textContent = "median time";
  legend.append(swAcc, " ", swTime);

  const stats = noteMap(levelRounds);
  const keys = noteMapKeys(stats, level.kind);
  const map = svg("svg", "sight-notemap", {
    width: "100%",
    height: 60,
    viewBox: "0 0 100 60",
    preserveAspectRatio: "none",
  });
  for (const k of [...keys.filter((x) => !x.black), ...keys.filter((x) => x.black)]) {
    map.appendChild(
      titled(
        svg("rect", "nm-key " + k.cls, { x: k.x, y: 0, width: k.width, height: k.black ? 36 : 60 }),
        k.title,
      ),
    );
  }

  const list = document.createElement("ul");
  list.className = "sight-weak-list";
  for (const s of weakest(stats, 5)) {
    const li = document.createElement("li");
    li.textContent = `${noteName(s.midi)}: ${Math.round(s.rate * 100)}% first try, median ${formatSeconds(s.medianMs)}`;
    list.appendChild(li);
  }

  el.replaceChildren(title, trend, legend, heading("Notes: first try and speed"), map, list);
}
