export interface StepCursor {
  previous(): void;
  next(): void;
  reset(): void;
  Iterator: { FrontReached: boolean; EndReached: boolean };
}

export function stepBack(c: StepCursor): void {
  c.previous();
  if (c.Iterator.FrontReached) c.reset();
}

export function stepForward(c: StepCursor): void {
  c.next();
  if (c.Iterator.EndReached) c.previous();
}
