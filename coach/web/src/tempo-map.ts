export interface TempoChange {
  q: number;
  bpm: number;
}

export interface TempoMap {
  msAt(q: number): number;
  quartersAt(ms: number): number;
  bpmAt(q: number): number;
  changes(): TempoChange[];
}

interface Segment {
  q: number;
  bpm: number;
  mpq: number;
  ms: number;
}

export function createTempoMap(
  changes: readonly TempoChange[],
  scale = 1,
  fallbackBpm = 120,
): TempoMap {
  const valid = changes
    .filter((c) => Number.isFinite(c.q) && Number.isFinite(c.bpm) && c.bpm > 0)
    .map((c, i) => ({ q: c.q, bpm: c.bpm, i }))
    .sort((a, b) => a.q - b.q || a.i - b.i);

  const deduped: TempoChange[] = [];
  for (const c of valid) {
    const last = deduped[deduped.length - 1];
    if (last && last.q === c.q) {
      last.bpm = c.bpm;
    } else {
      deduped.push({ q: c.q, bpm: c.bpm });
    }
  }

  if (deduped.length === 0) deduped.push({ q: 0, bpm: fallbackBpm });
  deduped[0].q = 0;

  const merged: TempoChange[] = [];
  for (const c of deduped) {
    const last = merged[merged.length - 1];
    if (last && last.bpm === c.bpm) continue;
    merged.push(c);
  }

  const segs: Segment[] = [];
  for (const c of merged) {
    const bpm = c.bpm * scale;
    const prev = segs[segs.length - 1];
    segs.push({
      q: c.q,
      bpm,
      mpq: 60000 / bpm,
      ms: prev ? prev.ms + (c.q - prev.q) * prev.mpq : 0,
    });
  }

  function lastBy(pred: (s: Segment) => boolean): Segment {
    let found = segs[0];
    for (const s of segs) {
      if (pred(s)) found = s;
      else break;
    }
    return found;
  }

  return {
    msAt(q) {
      if (q <= 0) return q * segs[0].mpq;
      const s = lastBy((x) => x.q <= q);
      return s.ms + (q - s.q) * s.mpq;
    },
    quartersAt(ms) {
      if (ms <= 0) return ms / segs[0].mpq;
      const s = lastBy((x) => x.ms <= ms);
      return s.q + (ms - s.ms) / s.mpq;
    },
    bpmAt(q) {
      return lastBy((x) => x.q <= q).bpm;
    },
    changes() {
      return segs.map((s) => ({ q: s.q, bpm: s.bpm }));
    },
  };
}
