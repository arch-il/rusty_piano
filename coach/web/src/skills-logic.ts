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
export const STARTED_TEXT = 'Started (no level yet)';
export const PAD = 16;
export const TRACK_LABEL_W = 110;
export const NODE_W = 132;
export const NODE_H = 44;
export const GAP_X = 28;
export const ROW_H = 76;

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
      const title = tree.nodes.find((n) => n.id === r)?.title;
      return title ? `${r} ${title}` : r;
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
  return lines.length > 0 ? lines : ['No practice recorded yet.'];
}

export function shortTitle(t: string, max = 18): string {
  return t.length <= max ? t : t.slice(0, max - 1) + '…';
}

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
  const pos = new Map<string, { x: number; y: number }>();
  let width = PAD * 2;
  rowTracks.forEach((t, r) => {
    const y = PAD + r * ROW_H;
    tracks.push({ id: t.id, title: t.title, x: PAD, y: y + NODE_H / 2 });
    tree.nodes
      .filter((n) => n.track === t.id)
      .forEach((n, c) => {
        const x = PAD + TRACK_LABEL_W + c * (NODE_W + GAP_X);
        nodes.push({ id: n.id, x, y, w: NODE_W, h: NODE_H });
        pos.set(n.id, { x, y });
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
      edges.push({ from: r, to: n.id, d: `M ${x1} ${y1} C ${x1 + 20} ${y1}, ${x2 - 20} ${y2}, ${x2} ${y2}` });
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
  return {
    id,
    title: node.title,
    summary: node.summary ?? '',
    levelText: levelText(tree, id, state),
    lockText: lockText(tree, id, state),
    rusty: state?.nodes[id]?.rusty === true,
    gateLines: gateLines(state?.nodes[id]?.gates, (did) => node.drills.find((d) => d.id === did)?.title ?? did),
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
