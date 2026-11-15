import { noteName } from "./engine-socket";
import { keyLayout, stripView } from "./piano-keys";
import type { HandNotes } from "./piano-keys";

export class PianoView {
  private readonly label: HTMLElement;
  private readonly keys = new Map<number, HTMLElement>();

  private readonly ped: HTMLElement;
  private hover: HandNotes = { right: [], left: [] };
  private next: HandNotes | null = null;
  private live: number[] = [];
  private fingering = true;

  constructor(container: HTMLElement) {
    this.label = document.createElement("div");
    this.label.className = "piano-label";
    this.label.setAttribute("aria-live", "polite");
    this.ped = document.createElement("span");
    this.ped.className = "piano-ped";
    this.ped.setAttribute("aria-label", "Sustain pedal");
    this.ped.textContent = "Ped";
    const row = document.createElement("div");
    row.className = "piano-label-row";
    row.append(this.label);
    const strip = document.createElement("div");
    strip.className = "piano-keys";
    const spots = keyLayout();
    const ordered = [...spots.filter((s) => !s.black), ...spots.filter((s) => s.black)];
    for (const spot of ordered) {
      const key = document.createElement("div");
      key.className = spot.black ? "piano-key black" : "piano-key white";
      key.setAttribute("data-midi", String(spot.midi));
      key.style.left = `${spot.left}%`;
      key.style.width = `${spot.width}%`;
      strip.appendChild(key);
      this.keys.set(spot.midi, key);
    }
    container.append(this.ped, row, strip);
  }

  show(n: HandNotes): void {
    this.hover = n;
    this.render();
  }

  showLive(notes: number[], sustain: boolean): void {
    this.live = notes;
    this.ped.classList.toggle("on", sustain);
    this.render();
  }

  setNext(n: HandNotes | null): void {
    this.next = n;
    this.render();
  }

  setFingering(on: boolean): void {
    this.fingering = on;
    this.render();
  }

  private render(): void {
    for (const key of this.keys.values()) key.querySelectorAll(".piano-finger").forEach((el) => el.remove());
    for (const key of this.keys.values()) key.classList.remove("lit-right", "lit-left", "lit-both", "lit-live");
    const view = stripView(this.live, this.hover, this.next, this.fingering, noteName);
    for (const [midi, cls] of view.classes) this.keys.get(midi)?.classList.add(cls);
    for (const [midi, text] of view.fingers) {
      const span = document.createElement("span");
      span.className = "piano-finger";
      span.textContent = text;
      this.keys.get(midi)?.appendChild(span);
    }
    this.label.textContent = view.label;
  }

  clear(): void {
    this.show({ right: [], left: [] });
  }
}
