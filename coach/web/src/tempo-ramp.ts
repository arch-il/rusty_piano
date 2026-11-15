export interface RampOptions { stepPercent: number; targetPercent: number; backAfterBad: number }
export interface Ramp { percent(): number; reached(): boolean; next(clean: boolean): number }

const round = (x: number): number => Math.round(x * 10) / 10;

export function createRamp(startPercent: number, o: RampOptions): Ramp {
  let p = startPercent;
  let bad = 0;
  return {
    percent: () => p,
    reached: () => p >= o.targetPercent,
    next(clean: boolean): number {
      if (clean) {
        bad = 0;
        if (p < o.targetPercent) p = round(Math.min(o.targetPercent, p + o.stepPercent));
      } else {
        bad += 1;
        if (o.backAfterBad > 0 && bad >= o.backAfterBad) {
          p = round(Math.max(startPercent, p - o.stepPercent));
          bad = 0;
        }
      }
      return p;
    },
  };
}
