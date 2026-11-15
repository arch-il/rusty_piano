export type FollowMode = 'wait' | 'live';
export type HandsSetting = 'both' | 'right' | 'left';

export interface FollowerSettings {
  mode: FollowMode;
  hands: HandsSetting;
  loop: boolean;
  followRepeats: boolean;
  followJumps: boolean;
  repeatsAfterJump: boolean;
  tempo: { percent: number; minPercent: number; maxPercent: number; stepPercent: number; fallbackBpm: number; followChanges: boolean };
  ramp: { enabled: boolean; stepPercent: number; targetPercent: number; backAfterBad: number };
  live: { windowMs: number; onTimeMs: number; needleSlide: boolean };
  timing: { perfectMs: number; zeroMs: number; curve: number; redScore: number; greenScore: number };
  countIn: { bars: number; click: boolean; volume: number };
  holds: { live: boolean; wait: boolean; minPercent: number; minNoteMs: number; pedal: boolean; staccatoMaxPercent: number };
  autoplay: {
    enabled: boolean;
    sound: boolean;
    volume: number;
    velocity: number;
    gatePercent: number;
    staccatoGatePercent: number;
    waitLeadMs: number;
    offsetMs: number;
    jitterMs: number;
    skipEvery: number;
    wrongEvery: number;
    seed: number;
    shortEvery: number;
  };
  view: { scrollMarginPx: number; zoomRedrawMs: number };
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

export const DEFAULT_SETTINGS: FollowerSettings = deepFreeze({
  mode: 'wait',
  hands: 'both',
  loop: false,
  followRepeats: true,
  followJumps: true,
  repeatsAfterJump: false,
  tempo: { percent: 60, minPercent: 20, maxPercent: 150, stepPercent: 5, fallbackBpm: 80, followChanges: true },
  ramp: { enabled: false, stepPercent: 5, targetPercent: 100, backAfterBad: 2 },
  live: { windowMs: 200, onTimeMs: 80, needleSlide: true },
  timing: { perfectMs: 20, zeroMs: 250, curve: 1, redScore: 30, greenScore: 90 },
  countIn: { bars: 1, click: true, volume: 0.6 },
  holds: { live: true, wait: false, minPercent: 50, minNoteMs: 500, pedal: true, staccatoMaxPercent: 60 },
  autoplay: {
    enabled: false,
    sound: true,
    volume: 0.4,
    velocity: 80,
    gatePercent: 90,
    staccatoGatePercent: 40,
    waitLeadMs: 600,
    offsetMs: 0,
    jitterMs: 0,
    skipEvery: 0,
    wrongEvery: 0,
    seed: 1,
    shortEvery: 0,
  },
  view: { scrollMarginPx: 32, zoomRedrawMs: 400 },
});

export const SETTING_KEYS: readonly string[] = [
  'mode',
  'hands',
  'loop',
  'followRepeats',
  'followJumps',
  'repeatsAfterJump',
  'tempo.percent',
  'tempo.minPercent',
  'tempo.maxPercent',
  'tempo.stepPercent',
  'tempo.fallbackBpm',
  'tempo.followChanges',
  'ramp.enabled',
  'ramp.stepPercent',
  'ramp.targetPercent',
  'ramp.backAfterBad',
  'live.windowMs',
  'live.onTimeMs',
  'live.needleSlide',
  'timing.perfectMs',
  'timing.zeroMs',
  'timing.curve',
  'timing.redScore',
  'timing.greenScore',
  'countIn.bars',
  'countIn.click',
  'countIn.volume',
  'holds.live',
  'holds.wait',
  'holds.minPercent',
  'holds.minNoteMs',
  'holds.pedal',
  'holds.staccatoMaxPercent',
  'autoplay.enabled',
  'autoplay.sound',
  'autoplay.volume',
  'autoplay.velocity',
  'autoplay.gatePercent',
  'autoplay.staccatoGatePercent',
  'autoplay.waitLeadMs',
  'autoplay.offsetMs',
  'autoplay.jitterMs',
  'autoplay.skipEvery',
  'autoplay.wrongEvery',
  'autoplay.seed',
  'autoplay.shortEvery',
  'view.scrollMarginPx',
  'view.zoomRedrawMs',
];

const SECTIONS = ['tempo', 'ramp', 'live', 'timing', 'countIn', 'holds', 'autoplay', 'view'];
const SCALARS = ['mode', 'hands', 'loop', 'followRepeats', 'followJumps', 'repeatsAfterJump'];

interface Spec {
  path: string;
  check: (v: unknown) => boolean;
  reason: string;
}

const choice = (path: string, options: string[]): Spec => ({
  path,
  check: v => typeof v === 'string' && options.includes(v),
  reason: `must be one of ${options.join(', ')}`,
});

const bool = (path: string): Spec => ({
  path,
  check: v => typeof v === 'boolean',
  reason: 'must be true or false',
});

const num = (path: string, min: number, max: number): Spec => ({
  path,
  check: v => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max,
  reason: `must be a number from ${min} to ${max}`,
});

const whole = (path: string, min: number, max: number): Spec => ({
  path,
  check: v => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max,
  reason: `must be a whole number from ${min} to ${max}`,
});

const SPECS: Spec[] = [
  choice('mode', ['wait', 'live']),
  choice('hands', ['both', 'right', 'left']),
  bool('loop'),
  bool('followRepeats'),
  bool('followJumps'),
  bool('repeatsAfterJump'),
  num('tempo.percent', 5, 300),
  num('tempo.minPercent', 5, 100),
  num('tempo.maxPercent', 100, 300),
  num('tempo.stepPercent', 1, 50),
  num('tempo.fallbackBpm', 20, 300),
  bool('tempo.followChanges'),
  bool('ramp.enabled'),
  whole('ramp.stepPercent', 1, 50),
  whole('ramp.targetPercent', 5, 300),
  whole('ramp.backAfterBad', 0, 10),
  num('live.windowMs', 50, 1000),
  num('live.onTimeMs', 0, 1000),
  bool('live.needleSlide'),
  num('timing.perfectMs', 0, 1000),
  num('timing.zeroMs', 1, 5000),
  num('timing.curve', 0.2, 5),
  num('timing.redScore', 0, 100),
  num('timing.greenScore', 0, 100),
  whole('countIn.bars', 0, 4),
  bool('countIn.click'),
  num('countIn.volume', 0, 1),
  bool('holds.live'),
  bool('holds.wait'),
  num('holds.minPercent', 10, 100),
  num('holds.minNoteMs', 0, 10000),
  bool('holds.pedal'),
  num('holds.staccatoMaxPercent', 10, 100),
  bool('autoplay.enabled'),
  bool('autoplay.sound'),
  num('autoplay.volume', 0, 1),
  whole('autoplay.velocity', 1, 127),
  num('autoplay.gatePercent', 10, 100),
  num('autoplay.staccatoGatePercent', 5, 100),
  num('autoplay.waitLeadMs', 0, 5000),
  num('autoplay.offsetMs', -1000, 1000),
  num('autoplay.jitterMs', 0, 1000),
  whole('autoplay.skipEvery', 0, 1000),
  whole('autoplay.wrongEvery', 0, 1000),
  whole('autoplay.seed', 0, 2147483647),
  whole('autoplay.shortEvery', 0, 1000),
  num('view.scrollMarginPx', 0, 400),
  num('view.zoomRedrawMs', 0, 2000),
];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function getAt(source: unknown, path: string): unknown {
  let o = source;
  for (const part of path.split('.')) {
    if (!isPlainObject(o)) return undefined;
    o = o[part];
  }
  return o;
}

function setAt(target: unknown, path: string, value: unknown): void {
  const parts = path.split('.');
  const last = parts.pop() as string;
  let o = target as Record<string, unknown>;
  for (const part of parts) o = o[part] as Record<string, unknown>;
  o[last] = value;
}

export function loadSettings(raw: unknown): { settings: FollowerSettings; warnings: string[] } {
  const settings = structuredClone(DEFAULT_SETTINGS);
  const warnings: string[] = [];
  if (!isPlainObject(raw)) {
    warnings.push('settings: must be an object, using defaults');
    return { settings, warnings };
  }

  for (const key of Object.keys(raw)) {
    if (key.startsWith('_')) continue;
    if (SECTIONS.includes(key)) {
      const section = raw[key];
      if (section === undefined) continue;
      if (!isPlainObject(section)) {
        warnings.push(`${key}: must be an object, using defaults`);
        continue;
      }
      for (const sub of Object.keys(section)) {
        if (!sub.startsWith('_') && !SETTING_KEYS.includes(`${key}.${sub}`)) {
          warnings.push(`${key}.${sub}: unknown setting, ignored`);
        }
      }
    } else if (!SCALARS.includes(key)) {
      warnings.push(`${key}: unknown setting, ignored`);
    }
  }

  for (const spec of SPECS) {
    const value = getAt(raw, spec.path);
    if (value === undefined) continue;
    if (spec.check(value)) {
      setAt(settings, spec.path, value);
    } else {
      warnings.push(`${spec.path}: ${spec.reason}, using ${JSON.stringify(getAt(DEFAULT_SETTINGS, spec.path))}`);
    }
  }

  const { minPercent, maxPercent, percent } = settings.tempo;
  if (minPercent >= maxPercent) {
    settings.tempo.minPercent = 20;
    settings.tempo.maxPercent = 150;
    warnings.push('tempo.minPercent: must be lower than tempo.maxPercent, using 20 and 150');
  }
  if (percent < settings.tempo.minPercent || percent > settings.tempo.maxPercent) {
    const clamped = Math.min(settings.tempo.maxPercent, Math.max(settings.tempo.minPercent, percent));
    settings.tempo.percent = clamped;
    warnings.push(`tempo.percent: outside ${settings.tempo.minPercent} to ${settings.tempo.maxPercent}, using ${clamped}`);
  }
  if (settings.live.onTimeMs > settings.live.windowMs) {
    settings.live.onTimeMs = settings.live.windowMs;
    warnings.push(`live.onTimeMs: larger than live.windowMs, using ${settings.live.windowMs}`);
  }

  const t = settings.timing;
  if (t.zeroMs <= t.perfectMs) {
    t.perfectMs = DEFAULT_SETTINGS.timing.perfectMs;
    t.zeroMs = DEFAULT_SETTINGS.timing.zeroMs;
    warnings.push(`timing.zeroMs: must be larger than timing.perfectMs, using ${t.perfectMs} and ${t.zeroMs}`);
  }
  if (t.greenScore <= t.redScore) {
    t.redScore = DEFAULT_SETTINGS.timing.redScore;
    t.greenScore = DEFAULT_SETTINGS.timing.greenScore;
    warnings.push(`timing.greenScore: must be larger than timing.redScore, using ${t.redScore} and ${t.greenScore}`);
  }

  return { settings, warnings };
}

const FORBIDDEN_KEYS = ['__proto__', 'constructor', 'prototype'];

export function settingsOverrides(query: string): { raw: Record<string, unknown>; warnings: string[] } {
  const raw: Record<string, unknown> = {};
  const warnings: string[] = [];
  for (const pair of query.split(',')) {
    if (pair.trim() === '') continue;
    const colon = pair.indexOf(':');
    const path = (colon < 0 ? pair : pair.slice(0, colon)).trim();
    if (colon < 0 || path === '') {
      warnings.push(`${pair.trim()}: expected key:value, skipped`);
      continue;
    }
    const parts = path.split('.');
    if (parts.some(part => FORBIDDEN_KEYS.includes(part))) {
      warnings.push(`${path}: not a setting key, skipped`);
      continue;
    }
    const text = pair.slice(colon + 1).trim();
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      value = text;
    }
    let o = raw;
    for (const part of parts.slice(0, -1)) {
      if (!isPlainObject(o[part])) o[part] = {};
      o = o[part] as Record<string, unknown>;
    }
    o[parts[parts.length - 1]] = value;
  }
  return { raw, warnings };
}

export function mergeSettingsRaw(base: unknown, overrides: Record<string, unknown>): unknown {
  const out: Record<string, unknown> = isPlainObject(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(overrides)) {
    if (FORBIDDEN_KEYS.includes(key)) continue;
    const current = out[key];
    out[key] = isPlainObject(current) && isPlainObject(value) ? mergeSettingsRaw(current, value) : value;
  }
  return out;
}
