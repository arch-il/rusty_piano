import { ApiError } from './api';
import { ATTEMPT_ID_RE, replayHash } from './drill-link';
import {
  NO_PIECES_MESSAGE,
  NO_PRACTICE_MESSAGE,
  barLayout,
  dayBars,
  minutesText,
  pieceMeta,
  pieceRows,
  skippedText,
  summaryItems,
} from './log-logic';
import type { LogResponse } from './log-logic';

const SVG_NS = 'http://www.w3.org/2000/svg';

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error('Missing element #' + id);
  return el as T;
}

function svgEl(name: string, cls?: string): SVGElement {
  const el = document.createElementNS(SVG_NS, name);
  if (cls) el.setAttribute('class', cls);
  return el as SVGElement;
}

function span(cls: string, text: string): HTMLSpanElement {
  const s = document.createElement('span');
  s.className = cls;
  s.textContent = text;
  return s;
}

function titled(el: SVGElement, text: string): SVGElement {
  const t = svgEl('title');
  t.textContent = text;
  el.appendChild(t);
  return el;
}

export function createLogView(opts: { fetchLog: () => Promise<LogResponse>; onBack: () => void }): {
  show(): void;
  hide(): void;
  visible(): boolean;
} {
  const section = byId<HTMLElement>('log-view');
  const statusEl = byId<HTMLElement>('log-status');
  const summaryEl = byId<HTMLElement>('log-summary');
  const chartEl = byId<HTMLElement>('log-chart');
  const piecesEl = byId<HTMLElement>('log-pieces');
  let token = 0;

  byId<HTMLElement>('log-back').addEventListener('click', () => opts.onBack());

  function renderStatus(text: string, isError: boolean): void {
    statusEl.textContent = text;
    statusEl.classList.toggle('error', isError);
  }

  function renderSummary(log: LogResponse): void {
    const divs = summaryItems(log).map(([label, value]) => {
      const div = document.createElement('div');
      div.className = 'log-stat';
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      dd.textContent = value;
      div.append(dt, dd);
      return div;
    });
    summaryEl.replaceChildren(...divs);
  }

  function renderChart(log: LogResponse): void {
    const bars = dayBars(log);
    const { rects, max } = barLayout(bars, 600, 110, 3);
    const svg = svgEl('svg', 'log-svg');
    svg.setAttribute('width', '720');
    svg.setAttribute('height', '140');
    svg.setAttribute('viewBox', '0 0 720 140');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Minutes per day, last 30 days');
    bars.forEach((bar, i) => {
      const r = rects[i];
      const hit = svgEl('rect', 'log-hit');
      hit.setAttribute('x', String(r.x));
      hit.setAttribute('y', '0');
      hit.setAttribute('width', String(r.w));
      hit.setAttribute('height', '110');
      svg.appendChild(titled(hit, bar.title));
      const rect = svgEl('rect', 'log-bar');
      rect.setAttribute('x', String(r.x));
      rect.setAttribute('y', String(r.y));
      rect.setAttribute('width', String(r.w));
      rect.setAttribute('height', String(r.h));
      svg.appendChild(titled(rect, bar.title));
      if (bar.showLabel) {
        const t = svgEl('text', 'log-day');
        t.setAttribute('x', String(r.x + r.w / 2));
        t.setAttribute('y', '128');
        t.setAttribute('text-anchor', 'middle');
        t.textContent = bar.label;
        svg.appendChild(t);
      }
    });
    if (bars.some((b) => b.minutes > 0)) {
      const axis = svgEl('text', 'log-axis');
      axis.setAttribute('x', '606');
      axis.setAttribute('y', '10');
      axis.setAttribute('text-anchor', 'start');
      axis.textContent = minutesText(max);
      svg.appendChild(axis);
    }
    chartEl.replaceChildren(svg);
  }

  function renderPieces(log: LogResponse): void {
    const rows = pieceRows(log);
    if (rows.length === 0) {
      const li = document.createElement('li');
      li.className = 'log-empty';
      li.textContent = log.days.length === 0 ? NO_PRACTICE_MESSAGE : NO_PIECES_MESSAGE;
      piecesEl.replaceChildren(li);
      return;
    }
    const items = rows.map((row) => {
      const li = document.createElement('li');
      li.className = 'log-piece';
      li.dataset.scoreId = row.scoreId;
      const a = document.createElement('a');
      a.className = 'log-piece-link';
      a.href = row.href;
      a.textContent = row.title;
      li.append(a, span('log-piece-meta', pieceMeta(row)));
      if (row.runs.length > 0) {
        const ul = document.createElement('ul');
        ul.className = 'log-runs';
        for (const run of row.runs) {
          const r = document.createElement('li');
          r.className = 'log-run';
          r.dataset.attemptId = run.attemptId ?? '';
          r.dataset.scoreId = row.scoreId;
          const actions = span('log-run-actions', '');
          const hasScore = !row.scoreId.startsWith('ear:') && !row.scoreId.startsWith('sight:');
          if (hasScore && run.attemptId && ATTEMPT_ID_RE.test(run.attemptId)) {
            const replayLink = document.createElement('a');
            replayLink.className = 'log-run-replay';
            replayLink.href = replayHash(run.attemptId);
            replayLink.textContent = 'Replay';
            replayLink.title = 'Replay this run on the score';
            actions.appendChild(replayLink);
          }
          r.append(
            span('log-run-when', run.when),
            span('log-run-acc', run.accuracyText),
            span('log-run-min', run.minutesText),
            actions,
          );
          ul.appendChild(r);
        }
        li.appendChild(ul);
      }
      return li;
    });
    piecesEl.replaceChildren(...items);
  }

  function render(log: LogResponse): void {
    renderSummary(log);
    renderChart(log);
    renderPieces(log);
  }

  function show(): void {
    section.hidden = false;
    renderStatus('Loading practice log…', false);
    summaryEl.replaceChildren();
    chartEl.replaceChildren();
    piecesEl.replaceChildren();
    const my = ++token;
    opts.fetchLog().then(
      (log) => {
        if (my !== token) return;
        render(log);
        renderStatus(skippedText(log), false);
      },
      (err) => {
        if (my !== token) return;
        if (err instanceof ApiError && err.status === 404) {
          renderStatus('The coach server does not have the practice log yet. Restart coach serve.', true);
        } else {
          renderStatus(err instanceof Error ? err.message : String(err), true);
        }
      },
    );
  }

  function hide(): void {
    token++;
    section.hidden = true;
  }

  return { show, hide, visible: () => !section.hidden };
}
