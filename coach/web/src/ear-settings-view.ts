import { noteName } from './engine-socket.ts';
import { CHORDS, EAR_KEY_HIGH, EAR_KEY_LOW, INTERVALS, KEY_NAMES, SETS, normalizeSettings } from './ear-levels.ts';
import type { EarLevelDef, EarSettings } from './ear-levels.ts';

export interface EarControlValues {
  low?: number;
  high?: number;
  key: string;
  sets?: string[];
  echoSet?: string;
  bpm: number;
  lenMin?: number;
  lenMax?: number;
}

export interface EarSettingsChange {
  settings: EarSettings;
  autoNext: boolean;
  settingsChanged: boolean;
}

export interface EarSettingsOptions {
  el: HTMLElement;
  onChange(change: EarSettingsChange): void;
  onDefaults(): void;
}

export interface EarSettingsView {
  show(level: EarLevelDef, settings: EarSettings, autoNext: boolean): void;
  read(): EarSettings;
  autoNext(): boolean;
  setDisabled(disabled: boolean): void;
  setFreeNote(visible: boolean): void;
}

const RANGE_TYPES = ['echo', 'updown', 'interval', 'chord'];
const FREE_NOTE = 'Changed settings: this round does not count toward a drill.';

export function settingsFromControls(level: EarLevelDef, c: EarControlValues): EarSettings {
  const partial: Partial<EarSettings> = {
    key: c.key === 'any' ? null : Number(c.key),
    bpm: c.bpm,
  };
  if (c.low !== undefined) partial.low = c.low;
  if (c.high !== undefined) partial.high = c.high;
  if (level.type === 'echo') {
    if (c.echoSet !== undefined) partial.set = [c.echoSet];
  } else if (c.sets !== undefined) {
    partial.set = c.sets;
  }
  if (c.lenMin !== undefined) partial.lenMin = c.lenMin;
  if (c.lenMax !== undefined) partial.lenMax = c.lenMax;
  return normalizeSettings(level, partial);
}

function setLabel(level: EarLevelDef, id: string): string {
  if (level.type === 'interval') return INTERVALS.find((i) => i.id === id)?.name ?? id;
  if (level.type === 'chord') return CHORDS.find((c) => c.id === id)?.name ?? id;
  return id;
}

export function createEarSettings(opts: EarSettingsOptions): EarSettingsView {
  let level: EarLevelDef | null = null;
  let controls: (HTMLInputElement | HTMLSelectElement | HTMLButtonElement)[] = [];
  let lowSel: HTMLSelectElement | null = null;
  let highSel: HTMLSelectElement | null = null;
  let keySel: HTMLSelectElement | null = null;
  let echoSel: HTMLSelectElement | null = null;
  let bpmInput: HTMLInputElement | null = null;
  let lenMinInput: HTMLInputElement | null = null;
  let lenMaxInput: HTMLInputElement | null = null;
  let autoBox: HTMLInputElement | null = null;
  let setBoxes = new Map<string, HTMLInputElement>();
  const note = document.createElement('p');
  note.className = 'ear-free-note';
  note.textContent = FREE_NOTE;
  note.hidden = true;

  function labelled(text: string, control: HTMLElement): HTMLLabelElement {
    const label = document.createElement('label');
    label.className = 'ear-setting';
    label.append(text + ' ', control);
    return label;
  }

  function noteSelect(): HTMLSelectElement {
    const sel = document.createElement('select');
    for (let m = EAR_KEY_LOW; m <= EAR_KEY_HIGH; m++) {
      const o = document.createElement('option');
      o.value = String(m);
      o.textContent = noteName(m);
      sel.appendChild(o);
    }
    return sel;
  }

  function numberInput(min: number, max: number): HTMLInputElement {
    const input = document.createElement('input');
    input.type = 'number';
    input.min = String(min);
    input.max = String(max);
    return input;
  }

  function values(): EarControlValues {
    const c: EarControlValues = { key: keySel ? keySel.value : 'any', bpm: bpmInput ? Number(bpmInput.value) : NaN };
    if (lowSel) c.low = Number(lowSel.value);
    if (highSel) c.high = Number(highSel.value);
    if (echoSel) c.echoSet = echoSel.value;
    if (setBoxes.size > 0) c.sets = [...setBoxes].filter(([, b]) => b.checked).map(([id]) => id);
    if (lenMinInput) c.lenMin = Number(lenMinInput.value);
    if (lenMaxInput) c.lenMax = Number(lenMaxInput.value);
    return c;
  }

  function read(): EarSettings {
    return settingsFromControls(level!, values());
  }

  function write(s: EarSettings): void {
    if (lowSel) lowSel.value = String(s.low);
    if (highSel) highSel.value = String(s.high);
    if (keySel) keySel.value = s.key === null ? 'any' : String(s.key);
    if (echoSel) echoSel.value = s.set[0] ?? 'scale';
    for (const [id, b] of setBoxes) b.checked = s.set.includes(id);
    if (bpmInput) bpmInput.value = String(s.bpm);
    if (lenMinInput) lenMinInput.value = String(s.lenMin);
    if (lenMaxInput) lenMaxInput.value = String(s.lenMax);
  }

  function changed(el: HTMLElement, settingsChanged: boolean): void {
    const settings = read();
    write(settings);
    if (el instanceof HTMLSelectElement) el.blur();
    opts.onChange({ settings, autoNext: autoBox ? autoBox.checked : true, settingsChanged });
  }

  return {
    show(lv, settings, autoNext) {
      level = lv;
      controls = [];
      setBoxes = new Map();
      lowSel = null;
      highSel = null;
      echoSel = null;
      lenMinInput = null;
      lenMaxInput = null;
      const rows: HTMLElement[] = [];
      const track = (el: HTMLInputElement | HTMLSelectElement | HTMLButtonElement, settingsChange: boolean): void => {
        controls.push(el);
        el.addEventListener('change', () => changed(el, settingsChange));
      };

      if (RANGE_TYPES.includes(lv.type)) {
        lowSel = noteSelect();
        highSel = noteSelect();
        track(lowSel, true);
        track(highSel, true);
        rows.push(labelled('Range low', lowSel), labelled('high', highSel));
      }

      keySel = document.createElement('select');
      for (const [value, text] of [['any', 'Any'], ...KEY_NAMES.map((n, i) => [String(i), n])]) {
        const o = document.createElement('option');
        o.value = value;
        o.textContent = text;
        keySel.appendChild(o);
      }
      track(keySel, true);
      rows.push(labelled('Key', keySel));

      if (lv.type === 'echo') {
        echoSel = document.createElement('select');
        for (const id of SETS.echo) {
          const o = document.createElement('option');
          o.value = id;
          o.textContent = id;
          echoSel.appendChild(o);
        }
        track(echoSel, true);
        rows.push(labelled('Notes', echoSel));
      } else {
        const group = document.createElement('div');
        group.className = 'ear-setting-sets';
        for (const id of SETS[lv.type]) {
          const box = document.createElement('input');
          box.type = 'checkbox';
          setBoxes.set(id, box);
          track(box, true);
          group.appendChild(labelled(setLabel(lv, id), box));
        }
        rows.push(group);
      }

      bpmInput = numberInput(40, 200);
      track(bpmInput, true);
      rows.push(labelled('Tempo (bpm)', bpmInput));

      if (lv.defaults.lenMax > 1 && lv.type !== 'bass') {
        lenMinInput = numberInput(1, 8);
        lenMaxInput = numberInput(1, 8);
        track(lenMinInput, true);
        track(lenMaxInput, true);
        rows.push(labelled('Phrase length min', lenMinInput), labelled('max', lenMaxInput));
      }

      autoBox = document.createElement('input');
      autoBox.type = 'checkbox';
      autoBox.checked = autoNext;
      track(autoBox, false);
      rows.push(labelled('Auto next', autoBox));

      const defaults = document.createElement('button');
      defaults.type = 'button';
      defaults.className = 'btn';
      defaults.textContent = 'Level defaults';
      defaults.addEventListener('click', () => opts.onDefaults());
      controls.push(defaults);

      write(settings);
      opts.el.replaceChildren(...rows, defaults, note);
    },
    read,
    autoNext() {
      return autoBox ? autoBox.checked : true;
    },
    setDisabled(disabled) {
      for (const c of controls) c.disabled = disabled;
    },
    setFreeNote(visible) {
      note.hidden = !visible;
    },
  };
}
