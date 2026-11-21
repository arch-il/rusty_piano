// Tracks whether the coach server answered the last API request. Pure, no DOM.
export interface ReachState {
  report(ok: boolean): void;
  down(): boolean;
  onChange(fn: (down: boolean) => void): void;
}

export function createReachState(): ReachState {
  let isDown = false;
  const listeners: ((down: boolean) => void)[] = [];
  return {
    report(ok) {
      const next = !ok;
      if (next === isDown) return;
      isDown = next;
      for (const fn of listeners) fn(isDown);
    },
    down: () => isDown,
    onChange(fn) {
      listeners.push(fn);
    },
  };
}
