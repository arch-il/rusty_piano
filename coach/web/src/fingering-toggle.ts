export const FINGERING_KEY = "rp.fingering";

export interface KV {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

export function loadFingering(store: KV | null): boolean {
  try {
    return store === null ? true : store.getItem(FINGERING_KEY) !== "off";
  } catch {
    return true;
  }
}

export function saveFingering(store: KV | null, on: boolean): void {
  try {
    store?.setItem(FINGERING_KEY, on ? "on" : "off");
  } catch {
    // ignore
  }
}

export function initFingeringToggle(
  button: {
    setAttribute(n: string, v: string): void;
    addEventListener(t: "click", f: () => void): void;
  },
  store: KV | null,
  onChange: (on: boolean) => void,
): void {
  let on = loadFingering(store);
  button.setAttribute("aria-pressed", on ? "true" : "false");
  onChange(on);
  button.addEventListener("click", () => {
    on = !on;
    button.setAttribute("aria-pressed", on ? "true" : "false");
    saveFingering(store, on);
    onChange(on);
  });
}
