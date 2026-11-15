import type { Hands } from "./practice-steps";

export function practiceBpm(writtenBpm: number | null, percent: number, fallbackBpm: number): number {
  return Math.max(1, Math.round(((writtenBpm ?? fallbackBpm) * percent) / 100));
}

export function tempoText(percent: number, bpm: number): string {
  return `${percent}% · ${bpm} bpm`;
}

export function shownPercent(uiPercent: number, rampPercent: number | null, running: boolean): number {
  return running && rampPercent !== null ? rampPercent : uiPercent;
}

export function sliderStep(percent: number, min: number, step: number): string {
  if (!Number.isFinite(step) || step <= 0) return "any";
  const k = (percent - min) / step;
  return Math.abs(k - Math.round(k)) < 1e-9 ? String(step) : "any";
}

export function handsLabel(h: Hands): string {
  if (h === "right") return "Right hand";
  if (h === "left") return "Left hand";
  return "Both hands";
}
