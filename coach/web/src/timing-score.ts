// Graded timing score: turns a note's onset offset (ms against the beat) into 0-100,
// and a score into a colour on a red -> yellow -> green gradient.
// The constants live in follower-settings.json ("timing"). They never change with the
// player's level, so scores from different days stay comparable.

export interface TimingCurve {
  perfectMs: number; // |offset| up to this scores 100
  zeroMs: number; // |offset| from this on scores 0
  curve: number; // shape between them: 1 = straight line, >1 kinder to small offsets, <1 stricter
}

export interface TimingColours {
  redScore: number; // at or below this score the colour is the low (red) colour
  greenScore: number; // at or above this score the colour is the high (green) colour
}

// Same values as "timing" in follower-settings.json (a test checks they match).
export const DEFAULT_CURVE: TimingCurve = Object.freeze({ perfectMs: 20, zeroMs: 250, curve: 1 });
export const DEFAULT_COLOURS: TimingColours = Object.freeze({ redScore: 30, greenScore: 90 });

export type StepTiming = 'hit' | 'early' | 'late';

export function timingScore(offsetMs: number | null | undefined, c: TimingCurve): number | null {
  if (offsetMs === null || offsetMs === undefined || !Number.isFinite(offsetMs)) return null;
  const d = Math.abs(offsetMs);
  if (d <= c.perfectMs) return 100;
  if (d >= c.zeroMs) return 0;
  const x = (d - c.perfectMs) / (c.zeroMs - c.perfectMs);
  return Math.round(100 * (1 - Math.pow(x, c.curve)));
}

// The old three-way outcome, derived from the raw offset and the fixed on-time window.
export function outcomeOf(offsetMs: number, onTimeMs: number): StepTiming {
  if (Math.abs(offsetMs) <= onTimeMs) return 'hit';
  return offsetMs < 0 ? 'early' : 'late';
}

// Position of a score on the gradient: 0 = red, 0.5 = yellow, 1 = green.
export function gradientPosition(score: number, c: TimingColours): number {
  if (score <= c.redScore) return 0;
  if (score >= c.greenScore) return 1;
  return (score - c.redScore) / (c.greenScore - c.redScore);
}

export function parseHex(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(hex.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

const toHex = (rgb: number[]): string => '#' + rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

// Colour for a score, blended from low -> mid -> high (hex colours, usually the CSS variables).
export function scoreColour(
  score: number,
  c: TimingColours,
  stops: { low: string; mid: string; high: string },
): string {
  const low = parseHex(stops.low) ?? [200, 50, 42];
  const mid = parseHex(stops.mid) ?? [217, 166, 43];
  const high = parseHex(stops.high) ?? [46, 139, 69];
  const p = gradientPosition(score, c);
  const [a, b, t] = p <= 0.5 ? [low, mid, p * 2] : [mid, high, (p - 0.5) * 2];
  return toHex(a.map((v, i) => v + (b[i] - v) * t));
}

export const SCORE_COLOUR_VARS = {
  low: '--color-score-low',
  mid: '--color-score-mid',
  high: '--color-score-high',
} as const;

export function meanScore(sum: number | undefined, count: number | undefined): number | null {
  if (!count || !(count > 0) || sum === undefined) return null;
  return Math.round(sum / count);
}
