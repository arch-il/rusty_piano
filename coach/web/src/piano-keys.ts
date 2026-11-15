export const FIRST_KEY = 21;
export const LAST_KEY = 108;

const BLACK_CLASSES = [1, 3, 6, 8, 10];
const BLACK_WIDTH_RATIO = 0.6;

export function isBlack(midi: number): boolean {
  return BLACK_CLASSES.includes(((midi % 12) + 12) % 12);
}

export interface KeySpot {
  midi: number;
  black: boolean;
  left: number;
  width: number;
}

export function keyLayout(first: number = FIRST_KEY, last: number = LAST_KEY): KeySpot[] {
  let whites = 0;
  for (let m = first; m <= last; m++) if (!isBlack(m)) whites++;
  const whiteWidth = 100 / whites;
  const blackWidth = whiteWidth * BLACK_WIDTH_RATIO;
  const spots: KeySpot[] = [];
  let whiteIndex = 0;
  for (let m = first; m <= last; m++) {
    if (isBlack(m)) {
      spots.push({ midi: m, black: true, left: whiteIndex * whiteWidth - blackWidth / 2, width: blackWidth });
    } else {
      spots.push({ midi: m, black: false, left: whiteIndex * whiteWidth, width: whiteWidth });
      whiteIndex++;
    }
  }
  return spots;
}

export function hoverLabel(midis: number[], nameOf: (midi: number) => string): string {
  return [...new Set(midis)].sort((a, b) => a - b).map(nameOf).join(" ");
}

export interface HandNotes {
  right: number[];
  left: number[];
  rightFingers?: Record<number, string>;
  leftFingers?: Record<number, string>;
}

export function fingerText(ref: unknown): string | null {
  const v = (ref as { Fingering?: { value?: unknown } } | null | undefined)?.Fingering?.value;
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
}

export function keyFingers(n: HandNotes): Map<number, string> {
  const map = new Map<number, string>();
  const midis = new Set([...n.right, ...n.left]);
  for (const m of midis) {
    const r = n.right.includes(m) ? n.rightFingers?.[m] : undefined;
    const l = n.left.includes(m) ? n.leftFingers?.[m] : undefined;
    if (r && l) map.set(m, r === l ? r : `${r}/${l}`);
    else if (r || l) map.set(m, (r || l) as string);
  }
  return map;
}

export function keyHands(n: HandNotes): Map<number, "right" | "left" | "both"> {
  const map = new Map<number, "right" | "left" | "both">();
  for (const m of n.right) map.set(m, "right");
  for (const m of n.left) map.set(m, map.has(m) ? "both" : "left");
  return map;
}

export function handsLabel(n: HandNotes, nameOf: (midi: number) => string, withFingers = false): string {
  const named = (midis: number[], fingers?: Record<number, string>): string =>
    hoverLabel(midis, (m) => (withFingers && fingers?.[m] ? `${nameOf(m)}(${fingers[m]})` : nameOf(m)));
  const parts: string[] = [];
  if (n.right.length) parts.push(`R: ${named(n.right, n.rightFingers)}`);
  if (n.left.length) parts.push(`L: ${named(n.left, n.leftFingers)}`);
  return parts.join("  ");
}

function hasNotes(n: HandNotes): boolean {
  return n.right.length + n.left.length > 0;
}

function handClasses(n: HandNotes): Map<number, string> {
  const classes = new Map<number, string>();
  for (const [midi, hand] of keyHands(n)) classes.set(midi, `lit-${hand}`);
  return classes;
}

export function stripView(
  live: number[],
  hover: HandNotes,
  next: HandNotes | null,
  fingering: boolean,
  nameOf: (midi: number) => string,
): { classes: Map<number, string>; fingers: Map<number, string>; label: string } {
  const held = `Held: ${live.map((m) => nameOf(m)).join(" ")}`;
  if (!fingering) {
    if (live.length > 0) {
      return { classes: new Map(live.map((m) => [m, "lit-live"])), fingers: new Map(), label: held };
    }
    return { classes: handClasses(hover), fingers: new Map(), label: handsLabel(hover, nameOf, false) };
  }
  if (live.length > 0) {
    const fromNext = next !== null && hasNotes(next);
    const guide = fromNext ? next : hover;
    const classes = handClasses(guide);
    for (const m of live) classes.set(m, "lit-live");
    return {
      classes,
      fingers: keyFingers(guide),
      label: fromNext ? `${held}  Next: ${handsLabel(next, nameOf, true)}` : held,
    };
  }
  const guide = hasNotes(hover) ? hover : next ?? hover;
  return { classes: handClasses(guide), fingers: keyFingers(guide), label: handsLabel(guide, nameOf, true) };
}
