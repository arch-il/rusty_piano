// Must match MIN_SOURCE_QUERY and the word rule (\w+) in coach/src/rusty_piano_coach/server.py.
export const MIN_SOURCE_QUERY = 2;

export function sourceQueryLength(q: string): number {
  return (q.match(/[\p{L}\p{N}_]+/gu) ?? []).join("").length;
}

export function searchesSources(q: string): boolean {
  return sourceQueryLength(q) >= MIN_SOURCE_QUERY;
}
