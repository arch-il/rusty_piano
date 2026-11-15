import type { Box } from "./score-geometry";

export interface Column {
  key: string;
  x: number;
  top: number;
  height: number;
  barLeft: number;
  barRight: number;
  right: number[];
  left: number[];
  rightFingers?: Record<number, string>;
  leftFingers?: Record<number, string>;
}

export interface HoverCell {
  box: Box;
  col: Column;
}

export function columnCells(cols: Column[]): HoverCell[] {
  const groups = new Map<string, Column[]>();
  for (const c of cols) {
    const k = `${c.barLeft}|${c.barRight}|${c.top}`;
    const g = groups.get(k);
    if (g) g.push(c);
    else groups.set(k, [c]);
  }
  const cells: HoverCell[] = [];
  for (const g of groups.values()) {
    g.sort((a, b) => a.x - b.x);
    g.forEach((col, i) => {
      const from = i === 0 ? col.barLeft : (g[i - 1].x + col.x) / 2;
      const to = i === g.length - 1 ? col.barRight : (col.x + g[i + 1].x) / 2;
      cells.push({ box: { x: from, y: col.top, width: to - from, height: col.height }, col });
    });
  }
  return cells;
}

export function pickCell(cells: HoverCell[], x: number, y: number): HoverCell | null {
  for (const c of cells) {
    const b = c.box;
    if (x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height) return c;
  }
  return null;
}
