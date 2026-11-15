import type { EarLevelDef, EarRound } from './ear-levels.ts';
import { categoryStats, roundsOfLevel, trendChart } from './ear-stats.ts';

const SVG_NS = 'http://www.w3.org/2000/svg';
const WIDTH = 560;
const HEIGHT = 180;
const CATEGORY_ROWS = 8;
const NO_DRILLS_TEXT = 'Rounds are saved, but they only count toward skills after you run: uv run coach ear add-drills';

function svg(tag: string, cls: string, attrs: Record<string, string | number> = {}): SVGElement {
  const e = document.createElementNS(SVG_NS, tag);
  e.setAttribute('class', cls);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

function polyline(cls: string, points: { x: number; y: number }[]): SVGElement {
  return svg('polyline', cls, { points: points.map((p) => `${p.x},${p.y}`).join(' ') });
}

function element(tag: string, cls: string, text: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  e.textContent = text;
  return e;
}

function cell(tag: 'th' | 'td', text: string): HTMLElement {
  const e = document.createElement(tag);
  e.textContent = text;
  return e;
}

export function renderEarHistory(
  el: HTMLElement,
  model: { rounds: EarRound[]; level: EarLevelDef; hasDrills: boolean },
): void {
  const rounds = roundsOfLevel(model.rounds, model.level.id);
  const children: Element[] = [element('h3', 'ear-history-title', 'Progress: ' + model.level.title)];

  if (rounds.length === 0) {
    children.push(element('p', 'ear-history-empty', 'No rounds yet on this level.'));
  } else {
    const chart = trendChart(rounds, WIDTH, HEIGHT);
    const trend = svg('svg', 'ear-trend', { width: WIDTH, height: HEIGHT, viewBox: `0 0 ${WIDTH} ${HEIGHT}` });
    trend.append(polyline('ear-trend-acc', chart.accuracy), polyline('ear-trend-time', chart.time));

    const legend = document.createElement('p');
    legend.className = 'ear-trend-legend';
    const swAcc = element('span', 'ear-swatch-acc', 'first try %');
    const swTime = element('span', 'ear-swatch-time', 'median time per answer');
    legend.append(swAcc, ' ', swTime);

    const table = document.createElement('table');
    table.className = 'ear-cats';
    const headRow = document.createElement('tr');
    headRow.append(cell('th', 'Category'), cell('th', 'Items'), cell('th', 'First try %'));
    const thead = document.createElement('thead');
    thead.appendChild(headRow);
    const tbody = document.createElement('tbody');
    for (const c of categoryStats(rounds).slice(0, CATEGORY_ROWS)) {
      const row = document.createElement('tr');
      row.append(cell('td', c.category), cell('td', String(c.items)), cell('td', Math.round(c.share * 100) + '%'));
      tbody.appendChild(row);
    }
    table.append(thead, tbody);

    children.push(trend, legend, table);
  }

  if (!model.hasDrills) children.push(element('p', 'ear-no-drills', NO_DRILLS_TEXT));
  el.replaceChildren(...children);
}
