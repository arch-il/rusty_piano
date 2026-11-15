import { fetchAttempt, fetchReplayAttempts, fetchReplaySessions, fetchSessionReplay } from './api';
import { createLiveKeys } from './live-keys';
import { createReplayPlayer } from './replay-player';
import { attemptItemText, attemptScript, clockText, isEmptyScript, sessionItemText, sessionScript } from './replay-logic';
import type { ReplayAttempt, ReplayMark, ReplayScript, ReplayStepLike } from './replay-logic';
import type { StepOutcome } from './note-matcher';
import type { Hands } from './practice-steps';
import { soundPromptVisible } from './sound-prompt';

export interface ReplayScoreView {
  timeline(): readonly ReplayStepLike[];
  setFollowing(on: boolean, hands?: Hands): void;
  showNeedle(step: number | null): void;
  slideNeedle(from: number, to: number | null, frac: number): void;
  markStep(step: number, outcome: StepOutcome | null, score?: number | null): void;
  flashWrong(step: number, attempts: number): void;
  markShort(step: number): void;
  markLong?(step: number): void;
  clearMarks(): void;
}

export interface ReplaySound {
  resume(): void;
  state?(): string;
  note(midi: number, velocity: number, durationMs: number, volume: number): void;
  stopAll(): void;
}

export interface ReplayDeps {
  view: ReplayScoreView;
  sound: ReplaySound;
  volume: number;
  onTimeMs: number;
  hands(): Hands;
  currentScore(): { id: string; title: string | null } | null;
  ready(): boolean;
  beforeStart(): void;
  showKeys(): void;
  showError(text: string): void;
}

export interface ReplayView {
  playAttempt(a: ReplayAttempt): void;
  stop(): void;
  active(): boolean;
  held(): number[];
  sustain(): boolean;
  setLastAttempt(a: ReplayAttempt | null): void;
  setEnabled(on: boolean): void;
  closeMenu(): void;
}

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} is missing from index.html`);
  return el as T;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createReplayView(deps: ReplayDeps): ReplayView {
  const toggle = byId<HTMLButtonElement>('replay-toggle');
  const menu = byId('replay-menu');
  const status = byId('replay-menu-status');
  const list = byId('replay-attempts');
  const sessionList = byId('replay-sessions');
  const summaryBtn = byId('summary-replay');
  const bar = byId('replay-bar');
  const label = byId('replay-label');
  const time = byId('replay-time');
  const pauseBtn = byId('replay-pause');
  const stopBtn = byId('replay-stop');
  const speedSel = byId<HTMLSelectElement>('replay-speed');
  const muteBtn = byId('replay-mute');
  const soundBtn = byId<HTMLButtonElement>('replay-sound');
  const wrap = toggle.parentElement;

  const keys = createLiveKeys();
  let muted = false;
  let speed = 1;
  let current: ReplayScript | null = null;
  let lastAttempt: ReplayAttempt | null = null;
  let menuToken = 0;
  let lastPos = 0;

  function checkSound(): void {
    soundBtn.hidden = !soundPromptVisible({
      audio: deps.sound.state?.() ?? 'running',
      muted,
      active: current !== null,
      posMs: lastPos,
    });
  }

  function applyMark(m: ReplayMark): void {
    if (m.kind === 'outcome') deps.view.markStep(m.step, m.outcome, m.score);
    else if (m.kind === 'wrong') deps.view.flashWrong(m.step, m.count);
    else if (m.kind === 'short') deps.view.markShort(m.step);
    else if (m.kind === 'long') deps.view.markLong?.(m.step);
    else deps.view.clearMarks();
  }

  function finish(): void {
    deps.view.showNeedle(null);
    deps.view.setFollowing(false, current?.hands ?? 'both');
    keys.reset();
    deps.showKeys();
    deps.sound.stopAll();
    bar.hidden = true;
    soundBtn.hidden = true;
    pauseBtn.textContent = 'Pause';
    current = null;
  }

  const player = createReplayPlayer(
    {
      now: () => performance.now(),
      every: (fn, ms) => window.setInterval(fn, ms),
      cancel: (id) => window.clearInterval(id as number),
    },
    {
      noteOn(note, velocity, durationMs) {
        if (!muted && deps.sound.state?.() !== 'suspended') deps.sound.note(note, velocity, durationMs, deps.volume);
        if (keys.apply({ type: 'note_on', t: 0, note, velocity, source: 'autoplay' })) deps.showKeys();
      },
      noteOff(note) {
        if (keys.apply({ type: 'note_off', t: 0, note, source: 'autoplay' })) deps.showKeys();
      },
      pedal(on) {
        if (keys.apply({ type: 'sustain', t: 0, on, source: 'autoplay' })) deps.showKeys();
      },
      mark: applyMark,
      needle(from, to, frac) {
        deps.view.slideNeedle(from, to, frac);
      },
      progress(pos, dur) {
        time.textContent = `${clockText(pos)} / ${clockText(dur)}`;
        lastPos = pos;
        checkSound();
      },
      end: finish,
    },
  );

  function startScript(script: ReplayScript): void {
    if (isEmptyScript(script)) {
      renderStatus('This run has no recorded notes to replay.', true);
      deps.showError('This run has no recorded notes to replay.');
      return;
    }
    deps.beforeStart();
    closeMenu();
    deps.sound.resume();
    keys.reset();
    deps.showKeys();
    deps.view.clearMarks();
    deps.view.setFollowing(true, script.hands);
    current = script;
    label.textContent = script.label;
    time.textContent = `0:00 / ${clockText(script.durationMs)}`;
    pauseBtn.textContent = 'Pause';
    bar.hidden = false;
    lastPos = 0;
    player.play(script, speed);
    for (const w of script.warnings) deps.showError(w);
  }

  function playAttempt(a: ReplayAttempt): void {
    const s = deps.currentScore();
    if (!deps.ready() || !s || s.id !== a.score.id) {
      const text = `Open ${a.score.title ?? a.score.id} first to replay this run.`;
      renderStatus(text, true);
      deps.showError(text);
      return;
    }
    try {
      startScript(attemptScript(a, deps.view.timeline()));
    } catch (err) {
      const text = 'Could not replay this run: ' + messageOf(err);
      renderStatus(text, true);
      deps.showError(text);
    }
  }

  function stop(): void {
    player.stop();
  }

  function renderStatus(text: string, isError: boolean): void {
    status.textContent = text;
    status.classList.toggle('error', isError);
  }

  function closeMenu(): void {
    menuToken++;
    menu.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
  }

  function pickAttempt(id: string): void {
    renderStatus('Loading the run…', false);
    const my = ++menuToken;
    fetchAttempt(id)
      .then((a) => {
        if (my === menuToken) playAttempt(a);
      })
      .catch((err: unknown) => {
        if (my === menuToken) renderStatus(messageOf(err), true);
      });
  }

  function pickSession(name: string): void {
    const s = deps.currentScore();
    if (!s || !deps.ready()) return;
    renderStatus('Matching the recording with the score… (this can take a few seconds)', false);
    const my = ++menuToken;
    fetchSessionReplay(name, s.id, deps.hands())
      .then((r) => {
        if (my !== menuToken) return;
        if (deps.currentScore()?.id !== r.score.id) return;
        try {
          startScript(sessionScript(r, deps.view.timeline(), deps.onTimeMs));
        } catch (err) {
          const text = 'Could not replay this recording: ' + messageOf(err);
          renderStatus(text, true);
          deps.showError(text);
        }
      })
      .catch((err: unknown) => {
        if (my === menuToken) renderStatus(messageOf(err), true);
      });
  }

  function openMenu(): void {
    const s = deps.currentScore();
    if (!s || !deps.ready()) return;
    menu.hidden = false;
    toggle.setAttribute('aria-expanded', 'true');
    renderStatus('Loading runs…', false);
    list.replaceChildren();
    const my = ++menuToken;
    fetchReplayAttempts(s.id).then(
      (items) => {
        if (my !== menuToken) return;
        renderStatus('', false);
        if (items.length === 0) {
          const li = document.createElement('li');
          li.className = 'replay-empty';
          li.textContent = 'No saved runs of this piece yet.';
          list.replaceChildren(li);
          return;
        }
        list.replaceChildren(
          ...items.map((item) => {
            const li = document.createElement('li');
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'replay-item';
            btn.textContent = attemptItemText(item);
            btn.addEventListener('click', () => pickAttempt(item.id));
            li.appendChild(btn);
            return li;
          }),
        );
      },
      (err: unknown) => {
        if (my === menuToken) renderStatus(messageOf(err), true);
      },
    );
    sessionList.replaceChildren();
    fetchReplaySessions().then(
      (items) => {
        if (my !== menuToken) return;
        if (items.length === 0) {
          const li = document.createElement('li');
          li.className = 'replay-empty';
          li.textContent = 'No recordings in coach/data/sessions yet.';
          sessionList.replaceChildren(li);
          return;
        }
        sessionList.replaceChildren(
          ...items.map((item) => {
            const li = document.createElement('li');
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'replay-item';
            btn.textContent = sessionItemText(item);
            btn.addEventListener('click', () => pickSession(item.name));
            li.appendChild(btn);
            return li;
          }),
        );
      },
      (err: unknown) => {
        if (my !== menuToken) return;
        const li = document.createElement('li');
        li.className = 'replay-empty';
        li.textContent = messageOf(err);
        sessionList.replaceChildren(li);
      },
    );
  }

  toggle.addEventListener('click', () => {
    if (menu.hidden) openMenu();
    else closeMenu();
  });
  document.addEventListener('click', (e) => {
    if (menu.hidden) return;
    if (e.target instanceof Node && wrap?.contains(e.target)) return;
    closeMenu();
  });

  pauseBtn.addEventListener('click', () => {
    const st = player.state();
    if (st === 'playing') {
      player.pause();
      deps.sound.stopAll();
      pauseBtn.textContent = 'Resume';
    } else if (st === 'paused') {
      player.resume();
      pauseBtn.textContent = 'Pause';
    }
  });
  stopBtn.addEventListener('click', () => stop());
  speedSel.addEventListener('change', () => {
    speed = Number(speedSel.value);
    player.setSpeed(speed);
  });
  muteBtn.addEventListener('click', () => {
    muted = !muted;
    muteBtn.setAttribute('aria-pressed', String(muted));
    if (muted) deps.sound.stopAll();
    checkSound();
  });
  soundBtn.addEventListener('click', () => {
    deps.sound.resume();
    window.setTimeout(checkSound, 200);
  });
  const unlock = (): void => {
    if (!soundBtn.hidden) {
      deps.sound.resume();
      window.setTimeout(checkSound, 200);
    }
  };
  document.addEventListener('pointerdown', unlock, true);
  document.addEventListener('keydown', unlock, true);
  summaryBtn.addEventListener('click', () => {
    if (lastAttempt) playAttempt(lastAttempt);
  });

  return {
    playAttempt,
    stop,
    active: () => player.state() !== 'idle',
    held: () => keys.held(),
    sustain: () => keys.sustain(),
    setLastAttempt(a) {
      lastAttempt = a;
      summaryBtn.hidden = a === null;
    },
    setEnabled(on) {
      toggle.disabled = !on;
      if (!on) closeMenu();
    },
    closeMenu,
  };
}
