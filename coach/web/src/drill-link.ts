import type { BarRange, Hands } from './practice-steps';

export interface DrillParams {
  drill?: string;
  plan?: string;
  hands?: Hands;
  bars?: BarRange;
  tempo?: number;
  mode?: 'wait' | 'live';
  loop?: boolean;
  ramp?: boolean;
  target?: number;
  tags?: string[];
}

export interface SightParams {
  level: string | null;
  drill?: string;
  plan?: string;
  tags?: string[];
  clef?: 'treble' | 'bass' | 'grand';
  low?: number;
  high?: number;
  acc?: boolean;
}

export interface EarParams {
  level: string | null;
  drill?: string;
  plan?: string;
  tags?: string[];
  low?: number;
  high?: number;
  key?: number | 'any';
  set?: string[];
  direction?: 'up' | 'down' | 'both';
  harmonic?: 'melodic' | 'harmonic' | 'mixed';
  free?: boolean;
  bpm?: number;
  len?: { min: number; max: number };
  seed?: number;
}

export type Route =
  | { kind: 'none' }
  | { kind: 'skills' }
  | { kind: 'log' } | { kind: 'replay'; attemptId: string } | { kind: 'score'; id: string; link: DrillParams | null }
  | { kind: 'sight'; params: SightParams }
  | { kind: 'ear'; params: EarParams };

const DRILL_RE = /^[a-z][a-z0-9]*([.][a-z0-9-]+)+$/;
const PLAN_RE = /^[A-Za-z0-9._-]{1,40}$/;
const TAG_RE = /^[a-z0-9-]{1,20}$/;
const LEVEL_RE = /^[a-z0-9-]{1,30}$/;
const SET_RE = /^[A-Za-z0-9-]{1,20}$/;
const SIGHT_IGNORED = new Set(['hands', 'tempo', 'mode', 'loop', 'bars']);
const EAR_IGNORED = new Set(['hands', 'tempo', 'mode', 'loop', 'bars', 'ramp', 'target']);
const NOTE_PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const KEY_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const HANDS_IN: Record<string, Hands> = { r: 'right', right: 'right', l: 'left', left: 'left', b: 'both', both: 'both' };
const HANDS_OUT: Record<Hands, string> = { right: 'R', left: 'L', both: 'B' };

export function parseRoute(hash: string): { route: Route; warnings: string[] } {
  const warnings: string[] = [];
  if (hash === '' || hash === '#') return { route: { kind: 'none' }, warnings };
  if (hash === '#/skills' || hash === '#/skills/') return { route: { kind: 'skills' }, warnings };
  if (hash === '#/log' || hash === '#/log/') return { route: { kind: 'log' }, warnings };
  if (hash.startsWith('#/replay/')) {
    const id = hash.slice('#/replay/'.length);
    if (ATTEMPT_ID_RE.test(id)) return { route: { kind: 'replay', attemptId: id }, warnings };
    warnings.push(`bad replay link: '${id}'`);
    return { route: { kind: 'none' }, warnings };
  }
  if (hash === '#/sight' || hash === '#/sight/') return { route: { kind: 'sight', params: { level: null } }, warnings };
  if (hash.startsWith('#/sight?')) {
    return { route: { kind: 'sight', params: parseSightQuery(hash.slice('#/sight?'.length), warnings) }, warnings };
  }
  if (hash === '#/ear' || hash === '#/ear/') return { route: { kind: 'ear', params: { level: null } }, warnings };
  if (hash.startsWith('#/ear?')) {
    return { route: { kind: 'ear', params: parseEarQuery(hash.slice('#/ear?'.length), warnings) }, warnings };
  }

  let idPart: string;
  let query: string | null;
  if (hash.startsWith('#score=')) {
    const rest = hash.slice('#score='.length);
    const cut = rest.search(/[&?]/);
    idPart = cut < 0 ? rest : rest.slice(0, cut);
    query = cut < 0 ? null : rest.slice(cut + 1);
  } else {
    if (hash.startsWith('#/')) return { route: { kind: 'none' }, warnings };
    const rest = hash.slice(1);
    const cut = rest.indexOf('?');
    idPart = cut < 0 ? rest : rest.slice(0, cut);
    query = cut < 0 ? null : rest.slice(cut + 1);
  }

  let id: string;
  try {
    id = decodeURIComponent(idPart);
  } catch {
    return { route: { kind: 'none' }, warnings };
  }
  if (id === '') return { route: { kind: 'none' }, warnings };
  if (!hash.startsWith('#score=') && !id.includes(':')) return { route: { kind: 'none' }, warnings };

  if (id.startsWith('sight:')) {
    const idLevel = id.slice('sight:'.length);
    const params: SightParams = query === null ? { level: null } : parseSightQuery(query, warnings);
    if (LEVEL_RE.test(idLevel)) params.level = idLevel;
    else {
      params.level = null;
      warnings.push(`bad value for 'level': '${idLevel}'`);
    }
    return { route: { kind: 'sight', params }, warnings };
  }

  if (id.startsWith('ear:')) {
    const idLevel = id.slice('ear:'.length);
    const params: EarParams = query === null ? { level: null } : parseEarQuery(query, warnings);
    if (LEVEL_RE.test(idLevel)) params.level = idLevel;
    else {
      params.level = null;
      warnings.push(`bad value for 'level': '${idLevel}'`);
    }
    return { route: { kind: 'ear', params }, warnings };
  }

  const link = query === null ? null : parseLink(query, warnings);
  return { route: { kind: 'score', id, link }, warnings };
}

function parseLink(query: string, warnings: string[]): DrillParams {
  const last = new Map<string, string>();
  new URLSearchParams(query).forEach((value, key) => last.set(key, value));
  const link: DrillParams = {};
  const bad = (name: string, value: string): void => {
    warnings.push(`bad value for '${name}': '${value}'`);
  };
  for (const [name, value] of last) {
    if (name === 'drill') {
      if (DRILL_RE.test(value)) link.drill = value;
      else bad(name, value);
    } else if (name === 'plan') {
      if (PLAN_RE.test(value)) link.plan = value;
      else bad(name, value);
    } else if (name === 'hands') {
      const hands = HANDS_IN[value.toLowerCase()];
      if (hands) link.hands = hands;
      else bad(name, value);
    } else if (name === 'bars') {
      const m = /^(\d+)(?:-(\d+))?$/.exec(value);
      const from = m ? Number(m[1]) : NaN;
      const to = m && m[2] !== undefined ? Number(m[2]) : from;
      if (m && from <= to) link.bars = { from, to };
      else bad(name, value);
    } else if (name === 'tempo') {
      const t = /^\d+$/.test(value) ? Number(value) : NaN;
      if (t >= 1 && t <= 300) link.tempo = t;
      else bad(name, value);
    } else if (name === 'mode') {
      if (value === 'wait' || value === 'live') link.mode = value;
      else bad(name, value);
    } else if (name === 'loop') {
      if (value === '1' || value === 'true') link.loop = true;
      else if (value === '0' || value === 'false') link.loop = false;
      else bad(name, value);
    } else if (name === 'ramp') {
      if (value === '1' || value === 'true') link.ramp = true;
      else if (value === '0' || value === 'false') link.ramp = false;
      else bad(name, value);
    } else if (name === 'target') {
      const t = /^\d+$/.test(value) ? Number(value) : NaN;
      if (t >= 1 && t <= 300) link.target = t;
      else bad(name, value);
    } else if (name === 'tag') {
      const items = value.split(',');
      if (items.length >= 1 && items.length <= 10 && items.every((t) => TAG_RE.test(t))) link.tags = items;
      else bad(name, value);
    } else {
      warnings.push(`unknown link parameter '${name}'`);
    }
  }
  return link;
}

export const ATTEMPT_ID_RE = /^attempt-\d{8}-\d{6}-[0-9a-f]{6}(-\d+)?$/;

export function replayHash(attemptId: string): string {
  return '#/replay/' + encodeURIComponent(attemptId);
}

function parseSightQuery(query: string, warnings: string[]): SightParams {
  const last = new Map<string, string>();
  new URLSearchParams(query).forEach((value, key) => last.set(key, value));
  const p: SightParams = { level: null };
  const bad = (name: string, value: string): void => {
    warnings.push(`bad value for '${name}': '${value}'`);
  };
  for (const [name, value] of last) {
    if (name === 'level') {
      if (LEVEL_RE.test(value)) p.level = value;
      else bad(name, value);
    } else if (name === 'drill') {
      if (DRILL_RE.test(value)) p.drill = value;
      else bad(name, value);
    } else if (name === 'plan') {
      if (PLAN_RE.test(value)) p.plan = value;
      else bad(name, value);
    } else if (name === 'tag') {
      const items = value.split(',');
      if (items.length >= 1 && items.length <= 10 && items.every((t) => TAG_RE.test(t))) p.tags = items;
      else bad(name, value);
    } else if (name === 'clef') {
      if (value === 'treble' || value === 'bass' || value === 'grand') p.clef = value;
      else bad(name, value);
    } else if (name === 'low' || name === 'high') {
      const n = /^\d+$/.test(value) ? Number(value) : NaN;
      if (n >= 21 && n <= 108) p[name] = n;
      else bad(name, value);
    } else if (name === 'acc') {
      if (value === '1' || value === 'true') p.acc = true;
      else if (value === '0' || value === 'false') p.acc = false;
      else bad(name, value);
    } else if (!SIGHT_IGNORED.has(name)) {
      warnings.push(`unknown link parameter '${name}'`);
    }
  }
  return p;
}

function parseEarQuery(query: string, warnings: string[]): EarParams {
  const last = new Map<string, string>();
  new URLSearchParams(query).forEach((value, key) => last.set(key, value));
  const p: EarParams = { level: null };
  const bad = (name: string, value: string): void => {
    warnings.push(`bad value for '${name}': '${value}'`);
  };
  for (const [name, value] of last) {
    if (name === 'level') {
      if (LEVEL_RE.test(value)) p.level = value;
      else bad(name, value);
    } else if (name === 'drill') {
      if (DRILL_RE.test(value)) p.drill = value;
      else bad(name, value);
    } else if (name === 'plan') {
      if (PLAN_RE.test(value)) p.plan = value;
      else bad(name, value);
    } else if (name === 'tag') {
      const items = value.split(',');
      if (items.length >= 1 && items.length <= 10 && items.every((t) => TAG_RE.test(t))) p.tags = items;
      else bad(name, value);
    } else if (name === 'range') {
      const m = /^(\d+)-(\d+)$/.exec(value);
      const a = m ? Number(m[1]) : NaN;
      const b = m ? Number(m[2]) : NaN;
      if (m && a >= 21 && a <= b && b <= 108) {
        p.low = a;
        p.high = b;
      } else bad(name, value);
    } else if (name === 'key') {
      const pc = value === 'any' ? 'any' : parseKeyName(value);
      if (pc !== null) p.key = pc;
      else bad(name, value);
    } else if (name === 'set') {
      const items = value.split(',');
      if (items.length >= 1 && items.length <= 16 && items.every((s) => SET_RE.test(s))) p.set = items;
      else bad(name, value);
    } else if (name === 'dir') {
      if (value === 'up' || value === 'down' || value === 'both') p.direction = value;
      else bad(name, value);
    } else if (name === 'harm') {
      if (value === 'melodic' || value === 'harmonic' || value === 'mixed') p.harmonic = value;
      else bad(name, value);
    } else if (name === 'free') {
      if (value === '1') p.free = true;
      else bad(name, value);
    } else if (name === 'bpm') {
      const n = /^\d+$/.test(value) ? Number(value) : NaN;
      if (n >= 40 && n <= 200) p.bpm = n;
      else bad(name, value);
    } else if (name === 'len') {
      const m = /^(\d+)(?:-(\d+))?$/.exec(value);
      const min = m ? Number(m[1]) : NaN;
      const max = m && m[2] !== undefined ? Number(m[2]) : min;
      if (m && min >= 1 && min <= max && max <= 8) p.len = { min, max };
      else bad(name, value);
    } else if (name === 'seed') {
      const n = /^\d{1,10}$/.test(value) ? Number(value) : NaN;
      if (n >= 0 && n <= 4294967295) p.seed = n;
      else bad(name, value);
    } else if (!EAR_IGNORED.has(name)) {
      warnings.push(`unknown link parameter '${name}'`);
    }
  }
  return p;
}

function parseKeyName(value: string): number | null {
  if (!/^[A-Ga-g](#|b)?$/.test(value)) return null;
  const acc = value.slice(1);
  const shift = acc === '#' ? 1 : acc === 'b' ? -1 : 0;
  return (((NOTE_PC[value[0].toUpperCase()] + shift) % 12) + 12) % 12;
}

export function earHash(p: EarParams): string {
  const parts: string[] = [];
  if (p.level !== null) parts.push('level=' + p.level);
  if (p.drill !== undefined) parts.push('drill=' + p.drill);
  if (p.plan !== undefined) parts.push('plan=' + p.plan);
  if (p.tags !== undefined && p.tags.length > 0) parts.push('tag=' + p.tags.join(','));
  if (p.low !== undefined && p.high !== undefined) parts.push('range=' + p.low + '-' + p.high);
  if (p.key !== undefined) parts.push('key=' + (p.key === 'any' ? 'any' : KEY_NAMES[p.key]));
  if (p.set !== undefined && p.set.length > 0) parts.push('set=' + p.set.join(','));
  if (p.direction !== undefined) parts.push('dir=' + p.direction);
  if (p.harmonic !== undefined) parts.push('harm=' + p.harmonic);
  if (p.bpm !== undefined) parts.push('bpm=' + p.bpm);
  if (p.len !== undefined) parts.push('len=' + (p.len.min === p.len.max ? String(p.len.min) : p.len.min + '-' + p.len.max));
  if (p.seed !== undefined) parts.push('seed=' + p.seed);
  if (p.free === true) parts.push('free=1');
  return '#/ear' + (parts.length > 0 ? '?' + parts.join('&') : '');
}

export function sightHash(p: SightParams): string {
  const parts: string[] = [];
  if (p.level !== null) parts.push('level=' + p.level);
  if (p.drill !== undefined) parts.push('drill=' + p.drill);
  if (p.plan !== undefined) parts.push('plan=' + p.plan);
  if (p.tags !== undefined && p.tags.length > 0) parts.push('tag=' + p.tags.join(','));
  if (p.clef !== undefined) parts.push('clef=' + p.clef);
  if (p.low !== undefined) parts.push('low=' + p.low);
  if (p.high !== undefined) parts.push('high=' + p.high);
  if (p.acc !== undefined) parts.push('acc=' + (p.acc ? '1' : '0'));
  return '#/sight' + (parts.length > 0 ? '?' + parts.join('&') : '');
}

export function encodeScoreId(id: string): string {
  return encodeURIComponent(id).replace(/%3A/g, ':');
}

export function drillHash(scoreId: string, p: DrillParams): string {
  const parts: string[] = [];
  if (p.drill !== undefined) parts.push('drill=' + p.drill);
  if (p.plan !== undefined) parts.push('plan=' + p.plan);
  if (p.hands !== undefined) parts.push('hands=' + HANDS_OUT[p.hands]);
  if (p.bars !== undefined) {
    parts.push('bars=' + (p.bars.from === p.bars.to ? String(p.bars.from) : p.bars.from + '-' + p.bars.to));
  }
  if (p.tempo !== undefined) parts.push('tempo=' + p.tempo);
  if (p.mode !== undefined) parts.push('mode=' + p.mode);
  if (p.loop !== undefined) parts.push('loop=' + (p.loop ? '1' : '0'));
  if (p.ramp !== undefined) parts.push('ramp=' + (p.ramp ? '1' : '0'));
  if (p.target !== undefined) parts.push('target=' + p.target);
  if (p.tags !== undefined && p.tags.length > 0) parts.push('tag=' + p.tags.join(','));
  return '#' + encodeScoreId(scoreId) + (parts.length > 0 ? '?' + parts.join('&') : '');
}

export function clampTempo(percent: number, min: number, max: number, step: number): number {
  return Math.min(max, Math.max(min, Math.round(percent / step) * step));
}

export interface LinkDefaults {
  mode: 'wait' | 'live';
  loop: boolean;
  ramp: boolean;
  minPercent: number;
  maxPercent: number;
  stepPercent: number;
}

export interface LinkUi {
  mode: 'wait' | 'live';
  hands: Hands;
  percent: number;
  loop: boolean;
  ramp: boolean;
  rampTarget: number | null;
}

export function linkUi(link: DrillParams, cur: { hands: Hands; percent: number }, d: LinkDefaults): LinkUi {
  return {
    mode: link.mode ?? d.mode,
    hands: link.hands ?? cur.hands,
    percent: link.tempo !== undefined ? clampTempo(link.tempo, d.minPercent, d.maxPercent, d.stepPercent) : cur.percent,
    loop: link.loop ?? d.loop,
    ramp: link.ramp ?? d.ramp,
    rampTarget: link.target ?? null,
  };
}

export function sameLink(a: DrillParams | null, b: DrillParams | null): boolean {
  if (a === null || b === null) return a === b;
  return drillHash('x:y', a) === drillHash('x:y', b);
}

export function keepsPage(fromSkills: boolean, picked: boolean, link: DrillParams | null, active: DrillParams | null): boolean {
  return fromSkills && !picked && link !== null && sameLink(link, active);
}

export function linkDrill(p: DrillParams): { drill_id: string | null; plan_id: string | null; tags: string[] } {
  return { drill_id: p.drill ?? null, plan_id: p.plan ?? null, tags: p.tags ? [...p.tags] : [] };
}
