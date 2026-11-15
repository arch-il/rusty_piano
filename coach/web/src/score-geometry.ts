export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function unevenMarkPoint(
  box: Box,
  prev: Box | null,
  hand: "right" | "left",
): { x: number; y: number; side: "above" | "below" } {
  const x = prev !== null && Math.abs(prev.y - box.y) <= 1 && prev.x < box.x ? (prev.x + box.x) / 2 : box.x;
  if (hand === "right") return { x, y: box.y, side: "above" };
  return { x, y: box.y + box.height, side: "below" };
}

export const ZOOM_STEPS = [0.5, 0.6, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 2;

export function unionBoxes(boxes: (Box | null | undefined)[]): Box | null {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  let any = false;
  for (const b of boxes) {
    if (!b) continue;
    any = true;
    left = Math.min(left, b.x);
    top = Math.min(top, b.y);
    right = Math.max(right, b.x + b.width);
    bottom = Math.max(bottom, b.y + b.height);
  }
  return any ? { x: left, y: top, width: right - left, height: bottom - top } : null;
}

export function barRects(
  measureBoxes: (Box | null | undefined)[][],
  zoom: number,
  padUnits = 1,
  unitPx = 10,
): (Box | null)[] {
  const k = unitPx * zoom;
  return measureBoxes.map((boxes) => {
    const u = unionBoxes(boxes);
    if (!u) return null;
    return {
      x: u.x * k,
      y: (u.y - padUnits) * k,
      width: u.width * k,
      height: (u.height + 2 * padUnits) * k,
    };
  });
}

export const FOLLOW_MARGIN_PX = 32;

export function needleRect(
  x: number,
  top: number,
  bottom: number,
  zoom: number,
  padUnits = 1,
  unitPx = 10,
): Box {
  const k = unitPx * zoom;
  return { x: x * k, y: (top - padUnits) * k, width: 0, height: (bottom - top + 2 * padUnits) * k };
}

export function followScrollTop(
  lineTop: number,
  lineBottom: number,
  scrollTop: number,
  viewHeight: number,
  aheadPx: number,
  marginPx = FOLLOW_MARGIN_PX,
): number | null {
  if (lineTop - marginPx >= scrollTop && lineBottom + aheadPx <= scrollTop + viewHeight) return null;
  const t = Math.max(0, Math.round(lineTop - marginPx));
  return t === Math.round(scrollTop) ? null : t;
}

export function hitTest(rects: (Box | null)[], x: number, y: number): number {
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    if (r && x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height) return i;
  }
  return -1;
}

export function clampZoom(z: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
}

export function stepZoom(current: number, direction: 1 | -1): number {
  const eps = 1e-9;
  if (direction === 1) {
    for (const s of ZOOM_STEPS) if (s > current + eps) return s;
    return MAX_ZOOM;
  }
  for (let i = ZOOM_STEPS.length - 1; i >= 0; i--) {
    if (ZOOM_STEPS[i] < current - eps) return ZOOM_STEPS[i];
  }
  return MIN_ZOOM;
}

export function formatZoom(z: number): string {
  return Math.round(z * 100) + "%";
}

export function slideX(a: Box, b: Box | null, frac: number): number {
  if (!b || Math.abs(a.y - b.y) > 1 || b.x <= a.x) return a.x;
  return a.x + (b.x - a.x) * Math.min(1, Math.max(0, frac));
}

export function extendRange(anchor: number, bar: number): { from: number; to: number } {
  return { from: Math.min(anchor, bar), to: Math.max(anchor, bar) };
}
