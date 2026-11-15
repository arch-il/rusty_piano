import type { LiveEvent, LiveSource } from "./engine-socket";

export function createLiveKeys() {
  const notes = new Map<LiveSource, Set<number>>();
  const pedal = new Set<LiveSource>();

  function held(): number[] {
    const all = new Set<number>();
    for (const set of notes.values()) for (const n of set) all.add(n);
    return [...all].sort((a, b) => a - b);
  }

  function sustain(): boolean {
    return pedal.size > 0;
  }

  function snapshot(): string {
    return `${held().join(",")}|${sustain()}`;
  }

  function apply(ev: LiveEvent): boolean {
    const before = snapshot();
    if (ev.type === "note_on") {
      let set = notes.get(ev.source);
      if (!set) notes.set(ev.source, (set = new Set()));
      set.add(ev.note);
    } else if (ev.type === "note_off") {
      notes.get(ev.source)?.delete(ev.note);
    } else if (ev.on) {
      pedal.add(ev.source);
    } else {
      pedal.delete(ev.source);
    }
    return snapshot() !== before;
  }

  function releaseSource(source: LiveSource): boolean {
    const before = snapshot();
    notes.delete(source);
    pedal.delete(source);
    return snapshot() !== before;
  }

  function reset(): void {
    notes.clear();
    pedal.clear();
  }

  return { apply, held, sustain, releaseSource, reset };
}
