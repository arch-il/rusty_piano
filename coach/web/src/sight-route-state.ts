import type { SightParams } from "./drill-link.ts";

const DEFAULT_LEVEL = "r2-treble";

export function nextShow(
  state: { visible: boolean; running: boolean; selectedId: string },
  p: SightParams,
  knownLevel: (id: string) => boolean,
): { selectedId: string; interrupt: boolean; unknown: string | null } {
  let selectedId = DEFAULT_LEVEL;
  let unknown: string | null = null;
  if (p.level === null) {
    if (state.visible) selectedId = state.selectedId;
  } else if (knownLevel(p.level)) {
    selectedId = p.level;
  } else {
    unknown = p.level;
  }
  return { selectedId, interrupt: state.running && selectedId !== state.selectedId, unknown };
}

export function paramsAfterPick(params: SightParams, id: string): SightParams {
  if (id !== params.level) return { level: id };
  return { ...params, level: id };
}
