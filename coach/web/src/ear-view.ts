import type { EngineStatus, LiveEvent, PlayAck } from './engine-socket.ts';
import { keyLayout } from './piano-keys.ts';
import { earHash } from './drill-link.ts';
import type { EarParams } from './drill-link.ts';
import { isLocked, levelText } from './skills-logic.ts';
import type { PlanResponse } from './skills-logic.ts';
import { createSound } from './web-audio.ts';
import {
  EAR_KEY_HIGH,
  EAR_KEY_LOW,
  EAR_NODES,
  LEVELS,
  instructionText,
  levelById,
  normalizeSettings,
} from './ear-levels.ts';
import type { EarHistory, EarLevelDef, EarNodeId, EarRound, EarSettings, EarStepRecord } from './ear-levels.ts';
import { createEarPlayer } from './ear-player.ts';
import { createEarController } from './ear-controller.ts';
import type { EarControllerStatus, EarEnd } from './ear-controller.ts';
import type { EarEffect, EarPhase } from './ear-session.ts';
import { earTreeHasDrills, liveStatsText, summaryModel } from './ear-stats.ts';
import { renderEarHistory } from './ear-history-view.ts';
import { createEarSettings } from './ear-settings-view.ts';

export interface EarViewOptions {
  engine: {
    onEvent(fn: (ev: LiveEvent) => void): () => void;
    onStatus(fn: (s: EngineStatus) => void): () => void;
    status(): EngineStatus;
    send(text: string): boolean;
    onAck(fn: (ack: PlayAck) => void): () => void;
  };
  postAttempt: (attempt: unknown) => Promise<unknown>;
  fetchHistory: (level: string | null) => Promise<EarHistory>;
  fetchPlan?: () => Promise<PlanResponse>;
  onBack: () => void;
  onToast?: (text: string) => void;
  now?: () => number;
}

export interface EarButtonStates {
  start: boolean;
  replay: boolean;
  replayLabel: string;
  reveal: boolean;
  next: boolean;
  stop: boolean;
}

export interface EarKeyState {
  given: readonly number[];
  pressed: ReadonlySet<number>;
  wrong: ReadonlySet<number>;
  answer: readonly number[];
}

export function earButtonStates(status: { phase: EarPhase; revealShown: boolean; replays: number }): EarButtonStates {
  const running = status.phase !== 'finished';
  const asking = status.phase === 'answering' || status.phase === 'answered';
  return {
    start: !running,
    replay: asking,
    replayLabel: running ? `Replay (${status.replays})` : 'Replay',
    reveal: running && !status.revealShown,
    next: status.phase === 'answered',
    stop: running,
  };
}

export function keyClasses(midi: number, state: EarKeyState): string[] {
  const out: string[] = [];
  if (state.given.includes(midi)) out.push('given');
  if (state.answer.includes(midi)) out.push('answer');
  if (state.wrong.has(midi)) out.push('wrong');
  if (state.pressed.has(midi)) out.push('pressed');
  return out;
}

const KEY_STATES = ['given', 'answer', 'wrong', 'pressed'];
const DEFAULT_LEVEL = 'echo-1';
const WRONG_FLASH_MS = 600;
const IDLE_HINT =
  'Pick a level and press Start. No piano connected? On the dev page the keys A to K play C4 to C5, Z and X shift the octave.';
const NO_DRILLS_TEXT = 'Rounds are saved, but they only count toward skills after you run: uv run coach ear add-drills';

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el as T;
}

export function linkPartial(p: EarParams): Partial<EarSettings> {
  const o: Partial<EarSettings> = {};
  if (p.low !== undefined && p.high !== undefined) {
    o.low = p.low;
    o.high = p.high;
  }
  if (p.key !== undefined) o.key = p.key === 'any' ? null : p.key;
  if (p.set !== undefined) o.set = p.set;
  if (p.direction !== undefined) o.direction = p.direction;
  if (p.harmonic !== undefined) o.harmonic = p.harmonic;
  if (p.bpm !== undefined) o.bpm = p.bpm;
  if (p.len !== undefined) {
    o.lenMin = p.len.min;
    o.lenMax = p.len.max;
  }
  return o;
}

export function initialDrillId(p: EarParams, level: EarLevelDef): string | null {
  return p.free === true ? null : (p.drill ?? level.drill);
}

export function defaultsParams(p: EarParams): EarParams {
  if (p.free !== true) return p;
  const o: EarParams = { level: p.level };
  if (p.plan !== undefined) o.plan = p.plan;
  if (p.tags !== undefined) o.tags = p.tags;
  return o;
}

export function repeatParams(
  run: { level: EarLevelDef; settings: EarSettings; drillId: string | null; seed: number },
  current: EarParams,
): EarParams {
  const s = run.settings;
  const p: EarParams = { level: run.level.id };
  if (run.drillId !== null) p.drill = run.drillId;
  else if (run.level.drill !== null) p.free = true;
  if (current.plan !== undefined) p.plan = current.plan;
  if (current.tags !== undefined) p.tags = current.tags;
  p.low = s.low;
  p.high = s.high;
  p.key = s.key === null ? 'any' : s.key;
  p.set = s.set;
  p.direction = s.direction;
  p.harmonic = s.harmonic;
  p.bpm = s.bpm;
  if (run.level.defaults.lenMax !== 1) p.len = { min: s.lenMin, max: s.lenMax };
  p.seed = run.seed;
  return p;
}

function promptText(level: EarLevelDef, st: { item: number; total: number; lastEffect: EarEffect | null }): string {
  const e = st.lastEffect;
  let text = instructionText(level);
  if (e && e.kind === 'correct') text = e.firstTry ? 'Right!' : 'Right (not first try)';
  else if (e && e.kind === 'wrong') text = 'Not that one';
  return `${st.item + 1}/${st.total} ${text}`;
}

export function createEarView(opts: EarViewOptions): {
  show(params: EarParams): void;
  hide(): void;
  visible(): boolean;
  escape(): void;
  running(): boolean;
} {
  const section = byId<HTMLElement>('ear-view');
  const statusEl = byId<HTMLElement>('ear-status');
  const levelsEl = byId<HTMLElement>('ear-levels');
  const settingsBodyEl = byId<HTMLElement>('ear-settings-body');
  const soundEl = byId<HTMLElement>('ear-sound');
  const promptEl = byId<HTMLElement>('ear-prompt');
  const answerEl = byId<HTMLElement>('ear-answer');
  const statsEl = byId<HTMLElement>('ear-stats');
  const keysEl = byId<HTMLElement>('ear-keys');
  const startBtn = byId<HTMLButtonElement>('ear-start');
  const replayBtn = byId<HTMLButtonElement>('ear-replay');
  const revealBtn = byId<HTMLButtonElement>('ear-reveal');
  const nextBtn = byId<HTMLButtonElement>('ear-next');
  const stopBtn = byId<HTMLButtonElement>('ear-stop');
  const summaryEl = byId<HTMLElement>('ear-summary');
  const backBtn = byId<HTMLButtonElement>('ear-back');
  const historyEl = byId<HTMLElement>('ear-history');

  let selectedId = DEFAULT_LEVEL;
  let params: EarParams = { level: null };
  let settings: EarSettings = normalizeSettings(levelById(DEFAULT_LEVEL) ?? LEVELS[0], {});
  let drillId: string | null = null;
  let autoNext = true;
  let rounds: EarRound[] = [];
  let planTree: PlanResponse['tree'] | null = null;
  let historyToken = 0;
  let lastRun: { level: EarLevelDef; settings: EarSettings; drillId: string | null; seed: number } | null = null;

  const levelButtons = new Map<string, HTMLButtonElement>();
  const groups = new Map<string, HTMLElement>();
  const keyEls = new Map<number, HTMLElement>();
  const pressed = new Set<number>();
  const wrongTimers = new Map<number, number>();
  const wrongSet = new Set<number>();
  let litGiven: number[] = [];
  let litAnswer: number[] = [];

  function setStatus(text: string): void {
    statusEl.textContent = text;
  }

  function currentLevel(): EarLevelDef {
    return levelById(selectedId) ?? LEVELS[0];
  }

  // Sound
  const sound = createSound();
  const player = createEarPlayer({
    engineConnected: () => opts.engine.status().state === 'connected',
    engineSource: () => opts.engine.status().engineSource,
    send: (text) => opts.engine.send(text),
    onAck: (fn) => opts.engine.onAck(fn),
    browserAvailable: () => typeof window !== 'undefined' && !!window.AudioContext,
    browserNote: (midi, velocity, durMs) => {
      sound.resume();
      sound.note(midi, velocity, durMs, 0.3);
    },
    browserStop: () => sound.stopNotes(),
    setTimer: (fn, ms) => window.setTimeout(fn, ms),
    clearTimer: (id) => window.clearTimeout(id as number),
  });
  opts.engine.onStatus((s) => {
    if (s.state === 'connected') player.resetEngine();
  });
  if (opts.engine.status().state === 'connected') player.resetEngine();

  // Settings
  const settingsView = createEarSettings({
    el: settingsBodyEl,
    onChange: (c) => {
      settings = c.settings;
      autoNext = c.autoNext;
      if (c.settingsChanged) {
        drillId = null;
        settingsView.setFreeNote(true);
      }
    },
    onDefaults: () => {
      const level = currentLevel();
      params = defaultsParams(params);
      settings = normalizeSettings(level, linkPartial(params));
      drillId = initialDrillId(params, level);
      settingsView.show(level, settings, autoNext);
      settingsView.setFreeNote(false);
    },
  });

  function applyLevel(): void {
    const level = currentLevel();
    settings = normalizeSettings(level, linkPartial(params));
    drillId = initialDrillId(params, level);
    settingsView.show(level, settings, autoNext);
    settingsView.setFreeNote(params.free === true);
  }

  // Level picker
  for (const node of Object.keys(EAR_NODES) as EarNodeId[]) {
    const group = document.createElement('div');
    group.className = 'ear-group';
    const head = document.createElement('h3');
    head.className = 'ear-group-title';
    head.textContent = `${node} ${EAR_NODES[node]}`;
    const row = document.createElement('div');
    row.className = 'ear-group-levels';
    for (const level of LEVELS.filter((l) => l.node === node)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn ear-level';
      b.setAttribute('data-level', level.id);
      b.setAttribute('aria-pressed', 'false');
      b.textContent = level.title;
      b.addEventListener('click', () => pick(level.id));
      levelButtons.set(level.id, b);
      row.appendChild(b);
    }
    group.append(head, row);
    groups.set(node, group);
    levelsEl.appendChild(group);
  }

  function addressParams(): EarParams {
    const p: EarParams = { level: selectedId };
    if (params.plan !== undefined) p.plan = params.plan;
    if (params.tags !== undefined) p.tags = params.tags;
    return p;
  }

  function pick(id: string): void {
    if (controller.running()) return;
    const next: EarParams = { level: id };
    if (params.plan !== undefined) next.plan = params.plan;
    if (params.tags !== undefined) next.tags = params.tags;
    params = next;
    selectedId = id;
    history.replaceState(null, '', earHash(addressParams()));
    applyLevel();
    setStatus('');
    hideSummary();
    render();
    clearHistory();
    reloadHistory();
    ladderNotice();
  }

  // Key strip
  const spots = keyLayout(EAR_KEY_LOW, EAR_KEY_HIGH);
  for (const spot of [...spots.filter((s) => !s.black), ...spots.filter((s) => s.black)]) {
    const key = document.createElement('div');
    key.className = spot.black ? 'ear-key black' : 'ear-key white';
    key.setAttribute('data-midi', String(spot.midi));
    key.style.left = `${spot.left}%`;
    key.style.width = `${spot.width}%`;
    keysEl.appendChild(key);
    keyEls.set(spot.midi, key);
  }

  function paintKey(midi: number): void {
    const el = keyEls.get(midi);
    if (!el) return;
    const on = keyClasses(midi, { given: litGiven, pressed, wrong: wrongSet, answer: litAnswer });
    for (const name of KEY_STATES) el.classList.toggle(name, on.includes(name));
  }

  function paintAllKeys(): void {
    for (const midi of keyEls.keys()) paintKey(midi);
  }

  function flashWrong(midi: number): void {
    const old = wrongTimers.get(midi);
    if (old !== undefined) window.clearTimeout(old);
    wrongSet.add(midi);
    wrongTimers.set(
      midi,
      window.setTimeout(() => {
        wrongTimers.delete(midi);
        wrongSet.delete(midi);
        paintKey(midi);
      }, WRONG_FLASH_MS),
    );
    paintKey(midi);
  }

  // History
  function clearHistory(): void {
    rounds = [];
    renderEarHistory(historyEl, { rounds: [], level: currentLevel(), hasDrills: hasDrills() });
  }

  function hasDrills(): boolean {
    return planTree === null || earTreeHasDrills(planTree);
  }

  function paintLadder(plan: PlanResponse): void {
    for (const node of Object.keys(EAR_NODES) as EarNodeId[]) {
      const group = groups.get(node);
      if (!group) continue;
      group.querySelector('.ear-level-state')?.remove();
      const span = document.createElement('span');
      span.className = 'ear-level-state';
      span.textContent = levelText(plan.tree, node, plan.state);
      group.querySelector('.ear-group-title')?.append(' ', span);
      group.classList.toggle('locked', isLocked(plan.tree, node, plan.state));
    }
  }

  function ladderNotice(): void {
    if (planTree && !earTreeHasDrills(planTree)) setStatus(NO_DRILLS_TEXT);
  }

  function loadPlan(): void {
    if (!opts.fetchPlan) return;
    opts
      .fetchPlan()
      .then((plan) => {
        planTree = plan.tree;
        paintLadder(plan);
        ladderNotice();
        renderEarHistory(historyEl, { rounds, level: currentLevel(), hasDrills: hasDrills() });
      })
      .catch(() => undefined);
  }

  function reloadHistory(): void {
    const mine = ++historyToken;
    opts
      .fetchHistory(selectedId)
      .then((h) => {
        if (mine !== historyToken) return;
        rounds = h.rounds;
        renderEarHistory(historyEl, { rounds, level: currentLevel(), hasDrills: hasDrills() });
      })
      .catch((e: unknown) => {
        if (mine === historyToken) setStatus('History not available: ' + messageOf(e));
      });
  }

  // Controls and texts
  function render(): void {
    const st: EarControllerStatus = controller.status();
    const running = controller.running();
    const level = controller.level() ?? currentLevel();
    const b = earButtonStates(running ? st : { ...st, phase: 'finished' });
    startBtn.disabled = !b.start;
    replayBtn.disabled = !b.replay;
    replayBtn.textContent = b.replayLabel;
    revealBtn.disabled = !b.reveal;
    nextBtn.disabled = !b.next;
    stopBtn.disabled = !b.stop;
    for (const [id, btn] of levelButtons) {
      btn.setAttribute('aria-pressed', String(id === selectedId));
      btn.disabled = running;
    }
    settingsView.setDisabled(running);

    const item = running ? st.currentItem : null;
    litGiven = item ? [...item.given] : [];
    litAnswer = item && st.revealShown ? [...item.answerNotes] : [];
    paintAllKeys();

    if (running && item) {
      promptEl.textContent = promptText(level, st);
      statsEl.textContent = liveStatsText(st.item + 1, st.total, {
        items: st.records,
        firstTry: st.firstTry,
        accuracy: null,
        medianStepMs: st.medianStepMs,
        replays: 0,
        revealed: 0,
      });
      answerEl.hidden = !st.revealShown;
      answerEl.textContent = st.revealShown ? item.label : '';
      soundEl.textContent = st.sound === 'engine' ? 'Sound: engine piano' : (st.soundNote ?? '');
    } else {
      promptEl.textContent = IDLE_HINT;
      statsEl.textContent = '';
      answerEl.hidden = true;
      answerEl.textContent = '';
      soundEl.textContent = '';
    }
  }

  // Summary
  function hideSummary(): void {
    summaryEl.hidden = true;
    summaryEl.replaceChildren();
  }

  function repeatHash(run: NonNullable<typeof lastRun>): string {
    return earHash(repeatParams(run, params));
  }

  function showSummary(steps: readonly EarStepRecord[], end: string, counted: boolean): void {
    const level = controller.level() ?? currentLevel();
    const model = summaryModel(steps, rounds, level, end === 'done', counted);
    const h = document.createElement('h3');
    h.textContent = 'Round summary';
    const dl = document.createElement('dl');
    for (const [k, v] of model.rows) {
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = v;
      dl.append(dt, dd);
    }
    const lines = [model.compare, model.clean].map((t) => {
      const p = document.createElement('p');
      p.textContent = t;
      return p;
    });
    const children: HTMLElement[] = [h, dl, ...lines];
    if (lastRun) {
      const again = document.createElement('a');
      again.className = 'btn';
      again.href = repeatHash(lastRun);
      again.textContent = 'Repeat this round';
      children.push(again);
    }
    summaryEl.replaceChildren(...children);
    summaryEl.hidden = false;
  }

  function onAttempt(a: unknown): void {
    const attempt = a as { end: string; steps: EarStepRecord[]; settings: { ear: { counted: boolean } } };
    if (attempt.end === 'interrupted') return;
    showSummary(attempt.steps, attempt.end, attempt.settings.ear.counted);
  }

  const controller = createEarController({
    now: opts.now ?? (() => performance.now()),
    wallIso: () => new Date().toISOString(),
    player,
    setTimer: (fn, ms) => window.setTimeout(fn, ms),
    clearTimer: (id) => window.clearTimeout(id as number),
    postAttempt: (a) => {
      onAttempt(a);
      return opts.postAttempt(a);
    },
    onChange: render,
    onSaved: (ok, msg) => {
      if (ok) {
        setStatus('Round saved.');
        reloadHistory();
      } else {
        opts.onToast?.('Round not saved: ' + (msg ?? ''));
      }
    },
  });

  function finish(end: EarEnd): void {
    if (!controller.running()) return;
    const r = controller.finish(end);
    if (r === null && end !== 'interrupted') setStatus('Nothing played, round not saved.');
    render();
  }

  function startRound(): void {
    if (controller.running()) return;
    const level = currentLevel();
    const seed = params.seed ?? Math.floor(Math.random() * 4294967296);
    setStatus('');
    hideSummary();
    ladderNotice();
    lastRun = { level, settings, drillId, seed };
    controller.start({
      level,
      settings,
      drillId,
      seed,
      planId: params.plan ?? null,
      tags: params.tags ?? [],
      autoNext,
    });
    render();
  }

  startBtn.addEventListener('click', startRound);
  replayBtn.addEventListener('click', () => controller.replay());
  revealBtn.addEventListener('click', () => controller.reveal());
  nextBtn.addEventListener('click', () => controller.next());
  stopBtn.addEventListener('click', () => finish('stop'));
  backBtn.addEventListener('click', () => opts.onBack());

  // Engine events
  opts.engine.onEvent((ev) => {
    if (section.hidden) return;
    if (ev.type === 'note_on' && ev.velocity > 0) pressed.add(ev.note);
    else if (ev.type === 'note_off' || (ev.type === 'note_on' && ev.velocity === 0)) pressed.delete(ev.note);
    if (ev.type !== 'sustain') paintKey(ev.note);
    if (!controller.running()) return;
    for (const e of controller.handle(ev)) {
      if (e.kind === 'wrong') flashWrong(e.note);
    }
    render();
  });

  function clearKeys(): void {
    pressed.clear();
    for (const t of wrongTimers.values()) window.clearTimeout(t);
    wrongTimers.clear();
    wrongSet.clear();
    litGiven = [];
    litAnswer = [];
    paintAllKeys();
  }

  render();

  return {
    show(p) {
      params = p;
      section.hidden = false;
      let target = selectedId;
      let unknown: string | null = null;
      if (p.level !== null) {
        if (levelById(p.level)) target = p.level;
        else unknown = p.level;
      }
      if (controller.running()) {
        if (target === selectedId) {
          render();
          return;
        }
        finish('interrupted');
      }
      selectedId = target;
      applyLevel();
      setStatus(unknown !== null ? `Unknown ear level '${unknown}'.` : '');
      hideSummary();
      render();
      clearHistory();
      reloadHistory();
      loadPlan();
    },
    hide() {
      if (controller.running()) finish('interrupted');
      player.stop();
      hideSummary();
      clearKeys();
      section.hidden = true;
    },
    visible() {
      return !section.hidden;
    },
    escape() {
      if (controller.running()) finish('stop');
      else opts.onBack();
    },
    running() {
      return controller.running();
    },
  };
}
