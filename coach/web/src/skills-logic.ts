import type { DrillParams } from './drill-link';
import type { BarRange, Hands } from './practice-steps';

export interface PlanDrill {
  id: string;
  title: string;
  score: string;
  hands: Hands;
  mode: 'wait' | 'live';
  tempo: number;
  loop: boolean;
  bars: BarRange | null;
  goal: string;
  kind: 'generated' | 'segment';
  ramp?: boolean;
  target?: number;
}

export interface PlanNode {
  id: string;
  kind?: 'skill' | 'piece';
  track: string;
  title: string;
  summary?: string;
  requires: string[];
  drills: PlanDrill[];
  score?: string;
}

export interface PlanTrack {
  id: string;
  title: string;
}

export interface PlanTree {
  version: number;
  kind: string;
  decay_days: number;
  tracks: PlanTrack[];
  nodes: PlanNode[];
}

export interface GoodProgress {
  met: boolean;
  clean_runs?: number;
  need_runs?: number;
  days?: number;
  need_days?: number;
  drills_met?: number;
  drills_total?: number;
  missing?: string[];
}

export interface SolidProgress {
  met: boolean;
  clean_in_window?: number;
  need_clean?: number;
  window?: number;
  days?: number;
  need_days?: number;
  habit_free?: boolean;
  drills_met?: number;
  drills_total?: number;
  missing?: string[];
}

export interface MasteredProgress {
  met: boolean;
  cold_runs?: number;
  need_cold?: number;
  away_days?: number;
  materials?: number;
  need_materials?: number;
  drills_met?: number;
  drills_total?: number;
  missing?: string[];
}

export interface GateProgress {
  good?: GoodProgress;
  solid?: SolidProgress;
  mastered?: MasteredProgress;
}

export interface StateNode {
  level: number;
  verdict?: string;
  last_seen?: string | null;
  runs?: number;
  last_clean?: string | null;
  rusty?: boolean;
  locked?: boolean;
  max_level?: number;
  habits?: string[];
  gates?: GateProgress;
}

export interface StateHabit {
  id: string;
  title: string;
  status: 'active' | 'improving' | 'fixed';
  nodes: string[];
}

export interface PlanState {
  nodes: Record<string, StateNode>;
  habits: StateHabit[];
  plan_id: string | null;
  last_review: string | null;
  updated_at: string;
}

export interface PlanResponse {
  tree: PlanTree;
  state: PlanState | null;
  problems: string[];
}

export interface PanelModel {
  id: string;
  heading: string;
  title: string;
  summary: string;
  levelText: string;
  lockText: string | null;
  rusty: boolean;
  gateLines: string[];
  verdict: string;
  habits: string[];
  drills: { label: string; goal: string; href: string }[];
}

export interface Layout {
  width: number;
  height: number;
  tracks: { id: string; title: string; x: number; y: number }[];
  nodes: { id: string; x: number; y: number; w: number; h: number }[];
  edges: { from: string; to: string; d: string }[];
}

export const LEVEL_NAMES = ['Not started', 'Learning', 'Good enough', 'Solid', 'Mastered'];
export const STARTED_TEXT = 'Started, not yet at Learning';
export const NO_PRACTICE_TEXT = 'No practice recorded yet.';
export const RUNS_NO_GATES_TEXT = 'Runs recorded; gate progress is not counted yet.';
export const PIECE_TAG = 'Piece';
export const PAD = 12;
export const TRACK_LABEL_W = 88;
export const NODE_W = 90;
export const NODE_H = 52;
export const GAP_X = 12;
export const ROW_H = 80;
export const NAME_CHARS = 13;
export const TRACK_CHARS = 12;

export function isPieceNode(node: Pick<PlanNode, 'id' | 'kind'>): boolean {
  return node.kind === 'piece' || node.id.startsWith('piece-');
}

export function prettyId(id: string): string {
  const words = id.replace(/^piece-/, '').split(/[-_]+/).filter((w) => w !== '');
  if (words.length === 0) return id;
  const text = words.join(' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function nodeTag(node: Pick<PlanNode, 'id' | 'kind'>): string {
  return isPieceNode(node) ? PIECE_TAG : node.id;
}

export function nodeName(node: Pick<PlanNode, 'id' | 'kind' | 'title'>): string {
  const t = node.title.trim();
  if (t !== '' && t !== node.id) return t;
  return isPieceNode(node) ? prettyId(node.id) : node.id;
}

export function nodeRef(node: Pick<PlanNode, 'id' | 'kind' | 'title'>): string {
  return isPieceNode(node) ? nodeName(node) : `${node.id} ${node.title}`;
}

export function nodeLevel(state: PlanState | null, id: string): number {
  const level = state?.nodes[id]?.level ?? 0;
  return Math.min(4, Math.max(0, Math.round(level)));
}

export function isLocked(tree: PlanTree, id: string, state: PlanState | null): boolean {
  const node = tree.nodes.find((n) => n.id === id);
  return (node?.requires ?? []).some((r) => nodeLevel(state, r) < 2);
}

export function hasRuns(state: PlanState | null, id: string): boolean {
  const node = state?.nodes[id];
  if (!node) return false;
  if (typeof node.runs === 'number') return node.runs > 0;
  return typeof node.last_seen === 'string' && node.last_seen !== '';
}

export function levelText(tree: PlanTree, id: string, state: PlanState | null): string {
  if (isLocked(tree, id, state)) return 'Locked';
  if (nodeLevel(state, id) === 0 && hasRuns(state, id)) return STARTED_TEXT;
  const rusty = state?.nodes[id]?.rusty === true ? ' (rusty)' : '';
  return LEVEL_NAMES[nodeLevel(state, id)] + rusty;
}

export function lockText(tree: PlanTree, id: string, state: PlanState | null): string | null {
  if (!isLocked(tree, id, state)) return null;
  const node = tree.nodes.find((n) => n.id === id);
  const unmet = (node?.requires ?? [])
    .filter((r) => nodeLevel(state, r) < 2)
    .map((r) => {
      const n = tree.nodes.find((x) => x.id === r);
      return n ? nodeRef(n) : r;
    });
  return 'Needs ' + unmet.join(', ') + ' at Good enough';
}

export function gateLines(g?: GateProgress, drillTitle: (id: string) => string = (id) => id): string[] {
  const lines: string[] = [];
  const tail = (x: { met: boolean; missing?: string[] }): string => {
    if (x.met) return ' (met)';
    const missing = x.missing ?? [];
    if (missing.length === 0) return '';
    const names = missing.slice(0, 3).map(drillTitle).join(', ');
    return `; still needed: ${names}` + (missing.length > 3 ? ` and ${missing.length - 3} more` : '');
  };
  if (g?.good) {
    const x = g.good;
    if (typeof x.drills_total === 'number') {
      lines.push(`Good enough: ${x.drills_met} of ${x.drills_total} drills` + tail(x));
    } else {
      lines.push(`Good enough: ${x.clean_runs} of ${x.need_runs} clean runs, ${x.days} of ${x.need_days} days` + (x.met ? ' (met)' : ''));
    }
  }
  if (g?.solid) {
    const x = g.solid;
    if (typeof x.drills_total === 'number') {
      lines.push(
        `Solid: ${x.drills_met} of ${x.drills_total} drills` + (x.habit_free === false ? ', an active habit holds it back' : '') + tail(x),
      );
    } else {
      lines.push(
        `Solid: ${x.clean_in_window} of ${x.need_clean} clean in the last ${x.window} runs, ${x.days} of ${x.need_days} days` +
          (x.habit_free ? '' : ', an active habit holds it back') +
          (x.met ? ' (met)' : ''),
      );
    }
  }
  if (g?.mastered) {
    const x = g.mastered;
    if (typeof x.drills_total === 'number') {
      lines.push(
        `Mastered: ${x.drills_met} of ${x.drills_total} drills` + (typeof x.need_cold === 'number' ? `, ${x.need_cold} cold runs each` : '') + tail(x),
      );
    } else {
      lines.push(
        `Mastered: ${x.cold_runs} of ${x.need_cold} cold runs, ${x.materials} of ${x.need_materials} materials` +
          (x.met ? ' (met)' : ''),
      );
    }
  }
  return lines.length > 0 ? lines : [NO_PRACTICE_TEXT];
}

export function shortTitle(t: string, max = 18): string {
  return t.length <= max ? t : t.slice(0, max - 1) + '…';
}

export function trackLines(title: string, max = 14): string[] {
  if (title.length <= max) return [title];
  const words = title.split(' ');
  if (words[0].length > max) return [shortTitle(title, max)];
  let line1 = words[0];
  let i = 1;
  while (i < words.length && (line1 + ' ' + words[i]).length <= max) {
    line1 += ' ' + words[i];
    i++;
  }
  if (i >= words.length) return [line1];
  return [line1, shortTitle(words.slice(i).join(' '), max)];
}

export const LOCK_PATH =
  'M4 7V5a4 4 0 0 1 8 0v2h.5A1.5 1.5 0 0 1 14 8.5v5A1.5 1.5 0 0 1 12.5 15h-9A1.5 1.5 0 0 1 2 13.5v-5A1.5 1.5 0 0 1 3.5 7H4zm2 0h4V5a2 2 0 0 0-4 0v2z';

export function nodeClasses(tree: PlanTree, id: string, state: PlanState | null, selected: boolean): string {
  let cls = `skill-node level-${nodeLevel(state, id)}`;
  if (isLocked(tree, id, state)) cls += ' locked';
  if (state?.nodes[id]?.rusty === true) cls += ' rusty';
  if (selected) cls += ' selected';
  return cls;
}

export function layout(tree: PlanTree): Layout {
  const rowTracks = tree.tracks.filter((t) => tree.nodes.some((n) => n.track === t.id));
  const tracks: Layout['tracks'] = [];
  const nodes: Layout['nodes'] = [];
  const pos = new Map<string, { x: number; y: number; row: number }>();
  let width = PAD * 2;
  rowTracks.forEach((t, r) => {
    const y = PAD + r * ROW_H;
    tracks.push({ id: t.id, title: t.title, x: PAD, y: y + NODE_H / 2 });
    tree.nodes
      .filter((n) => n.track === t.id)
      .forEach((n, c) => {
        const x = PAD + TRACK_LABEL_W + c * (NODE_W + GAP_X);
        nodes.push({ id: n.id, x, y, w: NODE_W, h: NODE_H });
        pos.set(n.id, { x, y, row: r });
        width = Math.max(width, x + NODE_W + PAD);
      });
  });
  const rows = rowTracks.length;
  const height = rows === 0 ? PAD * 2 : PAD * 2 + (rows - 1) * ROW_H + NODE_H;
  const edges: Layout['edges'] = [];
  for (const n of tree.nodes) {
    const to = pos.get(n.id);
    if (!to) continue;
    for (const r of n.requires) {
      const from = pos.get(r);
      if (!from) continue;
      const x1 = from.x + NODE_W;
      const y1 = from.y + NODE_H / 2;
      const x2 = to.x;
      const y2 = to.y + NODE_H / 2;
      const GUTTER = GAP_X / 2;
      const LANE = (ROW_H - NODE_H) / 2;
      if (from.row === to.row && to.x === x1 + GAP_X) {
        edges.push({ from: r, to: n.id, d: `M ${x1} ${y1} H ${x2}` });
        continue;
      }
      let lane: number;
      if (to.row > from.row) lane = to.y - LANE;
      else if (to.row < from.row) lane = to.y + NODE_H + LANE;
      else lane = to.row > 0 ? to.y - LANE : to.y + NODE_H + LANE;
      edges.push({
        from: r,
        to: n.id,
        d: `M ${x1} ${y1} H ${x1 + GUTTER} V ${lane} H ${x2 - GUTTER} V ${y2} H ${x2}`,
      });
    }
  }
  return { width, height, tracks, nodes, edges };
}

export function nodePanel(
  tree: PlanTree,
  state: PlanState | null,
  id: string,
  hashOf: (scoreId: string, p: DrillParams) => string,
): PanelModel | null {
  const node = tree.nodes.find((n) => n.id === id);
  if (!node) return null;
  const nodeHabits = state?.nodes[id]?.habits ?? [];
  const habits = (state?.habits ?? [])
    .filter((h) => h.nodes.includes(id) || nodeHabits.includes(h.id))
    .map((h) => `${h.title} (${h.status})`);
  const lines = gateLines(state?.nodes[id]?.gates, (did) => node.drills.find((d) => d.id === did)?.title ?? did);
  return {
    id,
    heading: nodeRef(node),
    title: nodeName(node),
    summary: node.summary ?? '',
    levelText: levelText(tree, id, state),
    lockText: lockText(tree, id, state),
    rusty: state?.nodes[id]?.rusty === true,
    gateLines: lines.length === 1 && lines[0] === NO_PRACTICE_TEXT && hasRuns(state, id) ? [RUNS_NO_GATES_TEXT] : lines,
    verdict: state?.nodes[id]?.verdict ?? '',
    habits,
    drills: node.drills.map((d) => ({
      label: d.title,
      goal: d.goal,
      href: hashOf(d.score, {
        drill: d.id,
        hands: d.hands,
        tempo: d.tempo,
        mode: d.mode,
        loop: d.loop,
        ...(d.bars ? { bars: d.bars } : {}),
        ...(d.ramp !== undefined ? { ramp: d.ramp } : {}),
        ...(d.target !== undefined ? { target: d.target } : {}),
      }),
    })),
  };
}
