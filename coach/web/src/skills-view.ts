import { drillHash } from './drill-link';
import { LOCK_PATH, NAME_CHARS, TRACK_CHARS, layout, levelText, nodeClasses, nodeName, nodePanel, nodeRef, nodeTag, trackLines } from './skills-logic';
import type { PlanResponse } from './skills-logic';

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

export function createSkillsView(opts: { fetchPlan: () => Promise<PlanResponse>; onBack: () => void; onDrill?: () => void }): {
  show(): void;
  hide(): void;
  visible(): boolean;
  panelOpen(): boolean;
  closePanel(): void;
} {
  const section = byId<HTMLElement>('skills-view');
  const statusEl = byId<HTMLElement>('skills-status');
  const graphEl = byId<HTMLElement>('skills-graph');
  const panel = byId<HTMLElement>('skills-panel');
  let token = 0;
  let data: PlanResponse | null = null;
  let selected: string | null = null;
  let phase: 'loading' | 'ready' | 'error' = 'loading';

  byId<HTMLElement>('skills-back').addEventListener('click', () => opts.onBack());

  function renderStatus(text: string, isError: boolean): void {
    statusEl.textContent = text;
    statusEl.classList.toggle('error', isError);
  }

  function renderGraph(): void {
    graphEl.replaceChildren();
    graphEl.dataset.phase = phase;
    if (data === null) return;
    const { tree, state } = data;
    const lay = layout(tree);
    const svg = svgEl('svg', 'skills-svg');
    svg.setAttribute('width', String(lay.width));
    svg.setAttribute('height', String(lay.height));
    svg.setAttribute('viewBox', `0 0 ${lay.width} ${lay.height}`);
    for (const t of lay.tracks) {
      const text = svgEl('text', 'skills-track');
      text.setAttribute('x', String(t.x));
      text.setAttribute('y', String(t.y));
      const lines = trackLines(t.title, TRACK_CHARS);
      if (lines.length === 1) {
        text.textContent = lines[0];
      } else {
        const ys = [t.y - 7, t.y + 8];
        lines.forEach((line, i) => {
          const span = svgEl('tspan');
          span.setAttribute('x', String(t.x));
          span.setAttribute('y', String(ys[i]));
          span.textContent = line;
          text.append(span);
        });
      }
      const full = svgEl('title');
      full.textContent = t.title;
      text.append(full);
      svg.append(text);
    }
    for (const e of lay.edges) {
      const path = svgEl('path', 'skill-edge');
      path.setAttribute('d', e.d);
      svg.append(path);
    }
    for (const n of lay.nodes) {
      const node = tree.nodes.find((x) => x.id === n.id);
      if (!node) continue;
      const cls = nodeClasses(tree, n.id, state, selected === n.id);
      const g = svgEl('g', cls);
      g.setAttribute('role', 'button');
      g.setAttribute('tabindex', '0');
      g.setAttribute('aria-label', `${nodeRef(node)}: ${levelText(tree, n.id, state)}`);
      g.setAttribute('transform', `translate(${n.x} ${n.y})`);
      const rect = svgEl('rect', 'skill-box');
      rect.setAttribute('width', String(n.w));
      rect.setAttribute('height', String(n.h));
      rect.setAttribute('rx', '6');
      const id = svgEl('text', 'skill-id');
      id.setAttribute('x', '6');
      id.setAttribute('y', '15');
      id.textContent = nodeTag(node);
      const name = svgEl('text', 'skill-name');
      trackLines(nodeName(node), NAME_CHARS).forEach((line, i) => {
        const span = svgEl('tspan');
        span.setAttribute('x', '6');
        span.setAttribute('y', String(31 + i * 14));
        span.textContent = line;
        name.append(span);
      });
      const tip = svgEl('title');
      tip.textContent = `${nodeRef(node)}: ${levelText(tree, n.id, state)}`;
      g.append(tip, rect, id, name);
      const locked = cls.split(' ').includes('locked');
      const rusty = cls.split(' ').includes('rusty');
      if (locked) {
        const lock = svgEl('path', 'skill-lock');
        lock.setAttribute('d', LOCK_PATH);
        lock.setAttribute('fill-rule', 'evenodd');
        lock.setAttribute('transform', `translate(${n.w - 18} 5) scale(0.75)`);
        g.append(lock);
      } else if (rusty) {
        const mark = svgEl('text', 'skill-mark');
        mark.setAttribute('x', String(n.w - 6));
        mark.setAttribute('y', '15');
        mark.setAttribute('text-anchor', 'end');
        mark.textContent = 'rusty';
        g.append(mark);
      }
      g.addEventListener('click', () => select(n.id));
      g.addEventListener('keydown', (ev) => {
        const k = (ev as KeyboardEvent).key;
        if (k === 'Enter' || k === ' ') {
          ev.preventDefault();
          select(n.id);
        }
      });
      svg.append(g);
    }
    graphEl.append(svg);
  }

  function renderPanel(): void {
    const model = data && selected !== null ? nodePanel(data.tree, data.state, selected, drillHash) : null;
    if (!model) {
      panel.hidden = true;
      panel.replaceChildren();
      section.classList.toggle('panel-open', !panel.hidden);
      return;
    }
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'btn skills-panel-close';
    close.textContent = 'Close';
    close.addEventListener('click', () => closePanel());
    const h3 = document.createElement('h3');
    h3.textContent = model.heading;
    const summary = document.createElement('p');
    summary.textContent = model.summary;
    const level = document.createElement('p');
    level.className = 'skills-level';
    level.textContent = model.levelText;
    const parts: HTMLElement[] = [close, h3, summary, level];
    if (model.lockText !== null) {
      const lock = document.createElement('p');
      lock.className = 'skills-lock';
      lock.textContent = model.lockText;
      parts.push(lock);
    }
    const gates = document.createElement('ul');
    gates.className = 'skills-gates';
    for (const line of model.gateLines) {
      const li = document.createElement('li');
      li.textContent = line;
      gates.append(li);
    }
    parts.push(gates);
    if (model.verdict !== '') {
      const v = document.createElement('p');
      v.className = 'skills-verdict';
      v.textContent = model.verdict;
      parts.push(v);
    }
    if (model.habits.length > 0) {
      const hh = document.createElement('h4');
      hh.textContent = 'Habits';
      const ul = document.createElement('ul');
      ul.className = 'skills-habits';
      for (const h of model.habits) {
        const li = document.createElement('li');
        li.textContent = h;
        ul.append(li);
      }
      parts.push(hh, ul);
    }
    const dh = document.createElement('h4');
    dh.textContent = 'Drills';
    parts.push(dh);
    if (model.drills.length === 0) {
      const none = document.createElement('p');
      none.textContent = 'No drills yet.';
      parts.push(none);
    } else {
      for (const d of model.drills) {
        const a = document.createElement('a');
        a.className = 'btn skills-drill';
        a.href = d.href;
        a.addEventListener('click', (e) => {
          if (e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey) opts.onDrill?.();
        });
        a.textContent = d.label;
        a.title = d.goal;
        parts.push(a);
      }
    }
    panel.replaceChildren(...parts);
    panel.hidden = false;
    section.classList.toggle('panel-open', !panel.hidden);
  }

  function select(id: string): void {
    selected = id;
    renderGraph();
    renderPanel();
  }

  function closePanel(): void {
    selected = null;
    renderGraph();
    renderPanel();
  }

  function show(): void {
    section.hidden = false;
    phase = 'loading';
    data = null;
    renderStatus('Loading skills…', false);
    renderGraph();
    renderPanel();
    const my = ++token;
    opts.fetchPlan().then(
      (res) => {
        if (my !== token) return;
        phase = 'ready';
        data = res;
        renderStatus(
          res.problems.length ? `Plan problems: ${res.problems.length} (run uv run coach plan check)` : '',
          false,
        );
        renderGraph();
        renderPanel();
      },
      (err: unknown) => {
        if (my !== token) return;
        phase = 'error';
        data = null;
        renderStatus(err instanceof Error ? err.message : String(err), true);
        renderGraph();
        renderPanel();
      },
    );
  }

  function hide(): void {
    token++;
    selected = null;
    section.hidden = true;
    renderPanel();
  }

  return {
    show,
    hide,
    visible: () => !section.hidden,
    panelOpen: () => !panel.hidden,
    closePanel,
  };
}
