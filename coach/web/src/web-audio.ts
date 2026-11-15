import { midiToHz } from "./autoplay.ts";

export interface Sound {
  resume(): void;
  note(midi: number, velocity: number, durationMs: number, volume: number): void;
  click(atPerfMs: number, accent: boolean, volume: number): void;
  stopAll(): void;
  stopNotes(): void;
}

export function createSound(): Sound {
  let ctx: AudioContext | null = null;
  const active = new Set<OscillatorNode>();
  const notes = new Set<OscillatorNode>();

  const getCtx = (): AudioContext | null => {
    if (ctx === null) {
      if (typeof window === "undefined" || !window.AudioContext) return null;
      ctx = new window.AudioContext();
    }
    return ctx;
  };

  const track = (osc: OscillatorNode): void => {
    active.add(osc);
    osc.addEventListener("ended", () => active.delete(osc));
  };

  return {
    resume() {
      void getCtx()?.resume();
    },
    note(midi, velocity, durationMs, volume) {
      const c = getCtx();
      if (c === null) return;
      const now = c.currentTime;
      const peak = Math.max(0.001, (volume * velocity) / 127);
      const osc = c.createOscillator();
      osc.type = "triangle";
      osc.frequency.value = midiToHz(midi);
      const gain = c.createGain();
      gain.gain.setValueAtTime(0.001, now);
      gain.gain.linearRampToValueAtTime(peak, now + 0.005);
      gain.gain.setValueAtTime(peak, now + durationMs / 1000);
      gain.gain.exponentialRampToValueAtTime(0.001, now + durationMs / 1000 + 0.15);
      osc.connect(gain).connect(c.destination);
      track(osc);
      notes.add(osc);
      osc.addEventListener("ended", () => notes.delete(osc));
      osc.start(now);
      osc.stop(now + durationMs / 1000 + 0.16);
    },
    click(atPerfMs, accent, volume) {
      const c = getCtx();
      if (c === null) return;
      const when = c.currentTime + Math.max(0, (atPerfMs - performance.now()) / 1000);
      const osc = c.createOscillator();
      osc.type = "sine";
      osc.frequency.value = accent ? 1500 : 1000;
      const gain = c.createGain();
      const v = Math.max(0.001, volume);
      gain.gain.setValueAtTime(v, when);
      gain.gain.exponentialRampToValueAtTime(0.001, when + 0.03);
      osc.connect(gain).connect(c.destination);
      track(osc);
      osc.start(when);
      osc.stop(when + 0.04);
    },
    stopNotes() {
      for (const osc of [...notes]) {
        try {
          osc.stop();
        } catch {
          // already stopped
        }
        active.delete(osc);
      }
      notes.clear();
    },
    stopAll() {
      for (const osc of [...active]) {
        try {
          osc.stop();
        } catch {
          // already stopped
        }
      }
      active.clear();
      notes.clear();
    },
  };
}
