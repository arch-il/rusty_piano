/// <reference types="vite/client" />
import "./styles.css";
import { ScoreView } from "./score-view";
import { PianoView } from "./piano-view";
import { createLiveKeys } from "./live-keys";
import { createEngineSocket, engineUrlFromSearch, statusTooltip } from "./engine-socket";
import type { NoteOnEvent } from "./engine-socket";
import { createKeyboardNotes, keyboardHint } from "./keyboard-notes";
import { createTopBar } from "./topbar";
import { createFollower, followButtonLabel, followStatusText } from "./follower";
import { createWaitMatcher } from "./note-matcher";
import { createLiveMatcher } from "./live-matcher";
import { barRuns, tempoSummary, timelineSummary } from "./score-timeline";
import { createTempoMap } from "./tempo-map";
import { createHoldChecker } from "./hold-checker";
import { practicePlan } from "./practice-steps";
import type { BarRange } from "./practice-steps";
import type { FollowOptions } from "./follower";
import { metricTexts, summaryRows } from "./practice-metrics";
import { handsLabel, practiceBpm, shownPercent, tempoText } from "./practice-ui";
import { loadSettings, mergeSettingsRaw, settingsOverrides } from "./follower-settings";
import settingsJson from "./follower-settings.json";
import { autoplaySchedule, createAutoplayer } from "./autoplay";
import { createSound } from "./web-audio";
import {
  autoplayKnobs,
  autoplaySlice,
  barsText,
  countInClicks,
  followOptions,
  rampedWaitTiming,
  rangeText,
  shiftedMsAt,
} from "./practice-config";
import type { PracticeUi } from "./practice-config";
import { createSidebar } from "./sidebar";
import { createSkillsView } from "./skills-view";
import { createLogView } from "./log-view";
import { createReplayView } from "./replay-view";
import { ApiError, fetchAttempt, fetchLog, fetchPlan, fetchScore, fetchScoreNotes, postAttempt, saveScoreNotes } from "./api";
import type { ReplayAttempt } from "./replay-logic";
import { createSightView } from "./sight-view";
import { fetchSightHistory } from "./api";
import type { SightParams, EarParams } from "./drill-link";
import { createEarView } from "./ear-view";
import { fetchEarHistory } from "./api";
import { createAttemptRecorder } from "./attempt-recorder";
import type { AttemptDrill } from "./attempt-recorder";
import { attachEvenness, evennessRows, unevenTitle } from "./evenness";
import type { AttemptWithEvenness, Evenness } from "./evenness";
import type { Score, ScoreList } from "./api";
import { drillHash, keepsPage, linkDrill, linkUi, parseRoute, replayHash } from "./drill-link";
import type { DrillParams } from "./drill-link";
import { initFingeringToggle } from "./fingering-toggle";
import { loadGeneratedFingering } from "./generated-fingering";
import { createScoreNotes } from "./score-notes-view";
import { createFreePlayView } from "./free-play-view";
import { isFreeHash } from "./free-play-slots";
import {
  EMPTY_LIBRARY,
  NOT_IN_LIBRARY_MESSAGE,
  scoreHash,
} from "./library-logic";

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error("Missing element #" + id);
  return el as T;
}

const messageEl = byId<HTMLElement>("score-message");
const scoreEl = byId<HTMLElement>("score");

let state: "idle" | "opening" | "open" | "hashError" = "idle";
let token = 0;
let currentId: string | null = null;
let currentScore: Score | null = null;
let activeDrill: AttemptDrill | null = null;
let activeLink: DrillParams | null = null;
let drillPicked = false;

function showMessage(text: string): void {
  messageEl.textContent = text;
  messageEl.hidden = false;
}

function showEmptyLibrary(): void {
  messageEl.textContent = "";
  const h = document.createElement("h2");
  h.textContent = EMPTY_LIBRARY.heading;
  const p = document.createElement("p");
  p.textContent = EMPTY_LIBRARY.text;
  const code = document.createElement("code");
  code.textContent = EMPTY_LIBRARY.command;
  const after = document.createElement("p");
  after.textContent = EMPTY_LIBRARY.after;
  messageEl.append(h, p, code, after);
  messageEl.hidden = false;
}

function hideMessage(): void {
  messageEl.textContent = "";
  messageEl.hidden = true;
}

const topbar = createTopBar({
  onToggleLibrary: () => sidebar.toggle(),
  onZoomIn: () => {
    view.zoomIn();
    topbar.setZoom(view.zoom);
  },
  onZoomOut: () => {
    view.zoomOut();
    topbar.setZoom(view.zoom);
  },
  onZoomReset: () => {
    view.resetZoom();
    topbar.setZoom(view.zoom);
  },
  onCursorStart: () => view.cursorStart(),
  onCursorPrev: () => view.cursorPrev(),
  onCursorNext: () => view.cursorNext(),
  onFollowToggle: () => {
    if (sightShown()) return;
    if (running()) stopRun();
    else startRun();
  },
  onModeChange: (mode) => {
    ui.mode = mode;
    renderFollow();
  },
  onHandsChange: (hands) => {
    ui.hands = hands;
    renderFollow();
  },
  onTempoInput: (percent) => {
    ui.percent = percent;
    renderFollow();
  },
  onLoopToggle: () => {
    ui.loop = !ui.loop;
    renderFollow();
  },
  onRampToggle: () => {
    ui.ramp = !ui.ramp;
    renderFollow();
  },
  onAutoplayToggle: () => {
    ui.autoplay = !ui.autoplay;
    sound.resume();
    if (running()) {
      if (ui.autoplay) startAutoplay();
      else {
        follower.dropHolds();
        stopAutoplay();
      }
    }
    if (!ui.autoplay) sound.stopNotes();
    renderFollow();
  },
  onSummaryAgain: () => {
    topbar.hideSummary();
    if (scoreReady) startRun();
  },
  onSummaryClose: () => topbar.hideSummary(),
});

let loaded = loadSettings(settingsJson);
if (import.meta.env.DEV) {
  const fs = new URLSearchParams(location.search).get("fs");
  if (fs) {
    const overrides = settingsOverrides(fs);
    console.info("follower settings override:", fs);
    loaded = loadSettings(mergeSettingsRaw(settingsJson, overrides.raw));
    for (const w of overrides.warnings) console.warn("follower settings:", w);
  }
}
const { settings, warnings } = loaded;
for (const w of warnings) console.warn("follower settings:", w);

const piano = new PianoView(byId<HTMLElement>("piano-view"));
let fingeringStore: Storage | null = null;
try {
  fingeringStore = localStorage;
} catch {
  fingeringStore = null;
}
initFingeringToggle(byId<HTMLButtonElement>("fingering-toggle"), fingeringStore, (on) => piano.setFingering(on));
const liveKeys = createLiveKeys();
const freePlay = createFreePlayView({ host: byId<HTMLElement>("free-play"), store: fingeringStore, keyboardHint: import.meta.env.DEV });

const view = new ScoreView(
  scoreEl,
  {
    onNoteHover: (n) => (n ? piano.show(n) : piano.clear()),
    onNextNotes: (n) => piano.setNext(n),
    onCursorMoved: (bar, total) => topbar.setCursor(bar, total),
    onBarSelected: (r) => {
      range = r;
      if (follower.status().state === "done") follower.stop();
      renderFollow();
    },
    onBarContextMenu: (info) => scoreNotes.contextMenu(info),
    onLayout: () => scoreNotes.layout(),
  },
  {
    followRepeats: settings.followRepeats,
    followJumps: settings.followJumps,
    repeatsAfterJump: settings.repeatsAfterJump,
    followTempo: settings.tempo.followChanges,
    fallbackBpm: settings.tempo.fallbackBpm,
    scrollMarginPx: settings.view.scrollMarginPx,
    zoomRedrawMs: settings.view.zoomRedrawMs,
    timingColours: { redScore: settings.timing.redScore, greenScore: settings.timing.greenScore },
  },
);

const follower = createFollower({
  view,
  now: () => performance.now(),
  deps: { createWaitMatcher, createLiveMatcher, practicePlan, createTempoMap, createHoldChecker },
});
const recorder = createAttemptRecorder();
follower.onResult((r) => recorder.result(r));
let scoreReady = false;
const ui: PracticeUi = {
  mode: settings.mode,
  hands: settings.hands,
  percent: settings.tempo.percent,
  loop: settings.loop,
  ramp: settings.ramp.enabled,
  rampTarget: null as number | null,
  autoplay: settings.autoplay.enabled,
};
let range: BarRange | null = null;
let lastOpts: FollowOptions | null = null;
let rafId = 0;
let frameTimer = 0;
let prevState = "off";
let lastEvenness: Evenness | null = null;

const sound = createSound();
const autoplayer = createAutoplayer({
  publish: (ev) => engine.publish(ev),
  now: () => performance.now(),
  setTimer: (fn, ms) => window.setTimeout(fn, ms),
  clearTimer: (id) => window.clearTimeout(id as number),
  onNoteOn: (note, velocity, durationMs) => {
    if (settings.autoplay.sound) sound.note(note, velocity, durationMs, settings.autoplay.volume);
  },
});

const replay = createReplayView({
  view,
  sound,
  volume: settings.autoplay.volume,
  onTimeMs: settings.live.onTimeMs,
  hands: () => ui.hands,
  currentScore: () => (currentScore ? { id: currentScore.id, title: currentScore.title } : null),
  ready: () => scoreReady,
  beforeStart: () => {
    if (running()) stopRun();
    topbar.hideSummary();
    topbar.closeInfo();
    sidebar.close();
    follower.reset();
  },
  showKeys: () => renderKeys(),
  showError: (text) => showToast(text),
});

const scoreNotes = createScoreNotes({
  view,
  fetchNotes: (id) => fetchScoreNotes(id),
  saveNotes: (id, payload) => saveScoreNotes(id, payload),
  showError: (text) => showToast(text),
  store: fingeringStore,
  onPractise: (r) => {
    if (!scoreReady || running() || sightShown()) return;
    view.selectRange(r);
    view.goToBar(r.from);
    ui.loop = true;
    renderFollow();
  },
});

function renderKeys(): void {
  const held = [...new Set([...liveKeys.held(), ...replay.held()])].sort((a, b) => a - b);
  piano.showLive(held, liveKeys.sustain() || replay.sustain());
}

function stopAutoplay(): void {
  autoplayer.stop();
  if (liveKeys.releaseSource("autoplay")) renderKeys();
}

function running(): boolean {
  const st = follower.status().state;
  return st === "countin" || st === "following";
}

function currentBpm(): number {
  return practiceBpm(view.scoreInfo()?.tempoBpm ?? null, ui.percent, settings.tempo.fallbackBpm);
}

function renderFollow(): void {
  const s = follower.status();
  topbar.setFollow(
    followButtonLabel(s.state),
    s.state === "off" ? rangeText(range, ui.loop) : followStatusText(s),
    scoreReady && !sightShown(),
  );
  topbar.setMetrics(metricTexts(s.counts, s.bpm));
  const shown = shownPercent(ui.percent, s.percent, running());
  topbar.setPractice({
    ...ui,
    percent: shown,
    ramp: ui.ramp ?? false,
    tempoText: tempoText(shown, practiceBpm(view.scoreInfo()?.tempoBpm ?? null, shown, settings.tempo.fallbackBpm)),
    locked: running() || sightShown(),
    autoplayOff: sightShown(),
    startOff: sightShown(),
  });
  replay.setEnabled(scoreReady && !running() && !sightShown());
  scoreNotes.setEnabled(scoreReady && !running() && !sightShown());
}

let sightOpen = false;
let earOpen = false;
function sightShown(): boolean {
  return sightOpen || earOpen;
}

function cancelFrames(): void {
  cancelAnimationFrame(rafId);
  window.clearInterval(frameTimer);
}

function startFrames(): void {
  const frame = (): void => {
    follower.tick();
    const st = follower.status().state;
    if (st === "countin" || st === "following") rafId = requestAnimationFrame(frame);
  };
  rafId = requestAnimationFrame(frame);
  frameTimer = window.setInterval(() => {
    follower.tick();
    const st = follower.status().state;
    if (st !== "countin" && st !== "following") window.clearInterval(frameTimer);
  }, 40);
}

function startAutoplay(): void {
  const plan = follower.plan();
  const tempo = follower.tempo();
  if (!plan || !lastOpts || !tempo || plan.steps.length === 0) return;
  const knobs = autoplayKnobs(settings);
  if (lastOpts.mode === "live") {
    const t0 = follower.startTime();
    if (t0 === null) return;
    const len = tempo.msAt(plan.lengthQuarters);
    autoplayer.play(
      autoplaySchedule(plan.steps, 60000 / tempo.bpmAt(0), knobs, plan.lengthQuarters, (q) => tempo.msAt(q)),
      t0,
      lastOpts.loop && len > 0 ? len : null,
      lastOpts.loop && lastOpts.ramp ? { cycleTiming: (k: number) => follower.cycleTiming(k + 1) } : undefined,
    );
  } else {
    const from = follower.status().step;
    const sl = autoplaySlice(plan, from);
    const fromQ = plan.steps[from]?.time ?? 0;
    const rw = rampedWaitTiming(
      shiftedMsAt((q) => tempo.msAt(q), fromQ),
      (c) => follower.waitCycleScale(c),
      follower.status().cycle,
    );
    const len = rw.msAt(sl.lengthQuarters);
    autoplayer.play(
      autoplaySchedule(sl.steps, 60000 / tempo.bpmAt(fromQ), knobs, sl.lengthQuarters, rw.msAt),
      performance.now() + settings.autoplay.waitLeadMs,
      lastOpts.loop && from === 0 && len > 0 ? len : null,
      { shiftToNow: true, ...(lastOpts.loop && lastOpts.ramp ? { cycleScale: rw.cycleScale } : {}) },
    );
  }
}

const toastEl = byId<HTMLElement>("toast");
let toastTimer = 0;

function showToast(text: string): void {
  toastEl.textContent = text;
  toastEl.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toastEl.hidden = true;
  }, 8000);
}

function summaryContext(o: FollowOptions) {
  return { hands: handsLabel(o.hands), bars: barsText(o.range, o.loop), percent: o.mode === "live" ? ui.percent : null };
}

function saveAttempt(end: "done" | "stop" | "interrupted"): void {
  try {
    if (!recorder.active()) return;
    const s = follower.status();
    if (!s.counts || !lastOpts) {
      recorder.cancel();
      return;
    }
    const attempt = recorder.finish({
      end,
      endedWall: new Date().toISOString(),
      endedPageMs: performance.now(),
      counts: s.counts,
      metrics: metricTexts(s.counts, s.bpm),
      rows: summaryRows(s.counts, summaryContext(lastOpts)),
    });
    if (!attempt) return;
    try {
      const ev = attachEvenness(attempt as AttemptWithEvenness);
      lastEvenness = ev;
      if (ev) view.markUneven(ev.weak_spots.map((w) => ({ step: w.source_step, title: unevenTitle(w), hand: w.hand })));
    } catch (err) {
      console.error(err);
    }
    replay.setLastAttempt(attempt);
    postAttempt(attempt).then(
      (saved) => {
        if (import.meta.env.DEV) console.info("attempt saved", saved.id);
      },
      (err: unknown) => showToast("Attempt not saved: " + (err instanceof Error ? err.message : String(err))),
    );
  } catch (err) {
    console.error(err);
    showToast("Attempt not saved: " + (err instanceof Error ? err.message : String(err)));
  }
}

function startRun(): void {
  replay.stop();
  replay.setLastAttempt(null);
  if (recorder.active()) saveAttempt("stop");
  lastEvenness = null;
  sound.resume();
  topbar.hideSummary();
  stopAutoplay();
  sound.stopAll();
  cancelFrames();
  const info = view.scoreInfo();
  const bpm = currentBpm();
  const opts = followOptions(settings, ui, info, range, bpm);
  lastOpts = opts;
  const wallMs = Date.now();
  follower.start(opts);
  const plan0 = follower.plan();
  const st0 = follower.status();
  if (currentScore && plan0 && plan0.steps.length > 0 && st0.counts && running()) {
    recorder.begin({
      score: { id: currentScore.id, title: currentScore.title, composer: currentScore.composer },
      options: opts,
      plan: plan0,
      timeline: view.timeline(),
      settings,
      startedWall: new Date(wallMs).toISOString(),
      pageStartMs: st0.counts.startedAt,
      t0Ms: follower.startTime(),
      pedalDown: ui.autoplay ? follower.pedal("autoplay") : follower.pedal(),
      autoplayOn: ui.autoplay,
      drill: activeDrill,
    });
  }
  if (import.meta.env.DEV) {
    console.info("follow timeline", timelineSummary(view.timeline()));
    console.info("follow order", barRuns(view.timeline()));
    console.info("follow tempo", tempoSummary(view.timeline()));
    if (info && info.jumps.length > 0) {
      console.info("follow jumps", (settings.followRepeats && settings.followJumps ? "followed: " : "off: ") + info.jumps.join(", "));
    }
  }
  if (opts.mode === "live" && settings.countIn.click && opts.countInBeats > 0) {
    const t0 = follower.startTime();
    if (t0 !== null) {
      const tempo = follower.tempo();
      const beatMs = (opts.beatQuarters * 60000) / (tempo ? tempo.bpmAt(0) : bpm);
      for (const c of countInClicks(t0, opts.countInBeats, beatMs, info?.beats ?? 4)) {
        sound.click(c.at, c.accent, settings.countIn.volume);
      }
    }
  }
  if (ui.autoplay && running()) startAutoplay();
  if (opts.mode === "live" && running()) startFrames();
}

function showSummaryNow(): void {
  const s = follower.status();
  const plan = follower.plan();
  if (!s.counts || !lastOpts) return;
  if (!plan || plan.steps.length === 0) return;
  if (s.counts.expectedNotes === 0 && s.counts.wrongNotes === 0) return;
  const rows = summaryRows(s.counts, summaryContext(lastOpts));
  if (lastEvenness) rows.push(...evennessRows(lastEvenness));
  topbar.showSummary("Practice summary", rows);
}

function stopRun(): void {
  const was = running();
  follower.stop();
  if (was) saveAttempt("stop");
  stopAutoplay();
  sound.stopAll();
  cancelFrames();
  keyboard?.resetOctave();
  renderEngine();
  if (was) showSummaryNow();
}

function stopFollowing(): void {
  replay.stop();
  scoreReady = false;
  if (running()) {
    follower.stop();
    saveAttempt("interrupted");
  }
  lastEvenness = null;
  replay.setLastAttempt(null);
  stopAutoplay();
  sound.stopAll();
  cancelFrames();
  follower.reset();
  keyboard?.resetOctave();
  renderEngine();
  topbar.hideSummary();
  range = null;
  renderFollow();
}

follower.onStatus((s) => {
  if (prevState !== "done" && s.state === "done") {
    saveAttempt("done");
    stopAutoplay();
    cancelFrames();
    keyboard?.resetOctave();
    renderEngine();
    showSummaryNow();
  }
  prevState = s.state;
  renderFollow();
});

const sidebar = createSidebar({
  onPick: (score) => void openScore(score),
  onOpenChange: (open) => topbar.setLibraryOpen(open),
  onResult: (list: ScoreList | null, error: string | null) => {
    if (state !== "idle") return;
    if (error) showMessage(error);
    else if (list && list.total === 0) showEmptyLibrary();
    else hideMessage();
  },
});

const skills = createSkillsView({ fetchPlan: () => fetchPlan(), onBack: leaveSkills, onDrill: () => { drillPicked = true; } });

function leaveSkills(): void {
  if (currentId && scoreReady && activeLink) location.hash = drillHash(currentId, activeLink);
  else location.hash = currentId && scoreReady ? scoreHash(currentId) : "";
}

function enterSkills(): void {
  replay.stop();
  if (running()) stopRun();
  topbar.closeInfo();
  topbar.hideSummary();
  sidebar.close();
  skills.show();
}

const logView = createLogView({ fetchLog: () => fetchLog(), onBack: leaveLog });

function leaveLog(): void {
  leaveSkills();
}

function enterLog(): void {
  replay.stop();
  if (running()) stopRun();
  topbar.closeInfo();
  topbar.hideSummary();
  sidebar.close();
  sight.hide();
  sightOpen = false;
  ear.hide();
  earOpen = false;
  logView.show();
}

function enterEar(params: EarParams): void {
  if (running()) stopRun();
  topbar.closeInfo();
  topbar.hideSummary();
  sidebar.close();
  skills.hide();
  logView.hide();
  sight.hide();
  sightOpen = false;
  replay.stop();
  ear.show(params);
  earOpen = true;
  renderFollow();
}

function enterSight(params: SightParams): void {
  if (running()) stopRun();
  topbar.closeInfo();
  topbar.hideSummary();
  sidebar.close();
  skills.hide();
  logView.hide();
  ear.hide();
  earOpen = false;
  replay.stop();
  sight.show(params);
  sightOpen = true;
  renderFollow();
}

function applyLink(link: DrillParams): void {
  const next = linkUi(link, ui, { mode: settings.mode, loop: settings.loop, ramp: settings.ramp.enabled, minPercent: settings.tempo.minPercent, maxPercent: settings.tempo.maxPercent, stepPercent: settings.tempo.stepPercent });
  ui.mode = next.mode; ui.hands = next.hands; ui.percent = next.percent; ui.loop = next.loop; ui.ramp = next.ramp; ui.rampTarget = next.rampTarget;
  view.selectRange(link.bars ?? null);
  activeDrill = linkDrill(link);
  activeLink = link;
  renderFollow();
}

async function openScore(score: Score, link: DrillParams | null = null): Promise<void> {
  stopFollowing();
  scoreNotes.close();
  ear.hide();
  earOpen = false;
  sight.hide();
  sightOpen = false;
  activeDrill = null;
  activeLink = null;
  ui.rampTarget = null;
  currentScore = score;
  const mine = ++token;
  currentId = score.id;
  state = "opening";
  syncFreePlay();
  sidebar.close();
  sidebar.setCurrent(score.id);
  topbar.setScore(score);
  showMessage("Loading…");
  try {
    await view.load(score.file_url, score.format);
    if (mine !== token) return;
    state = "open";
    hideMessage();
    scoreReady = true;
    if (link) {
      applyLink(link);
      history.replaceState(null, "", drillHash(score.id, link));
    } else {
      history.replaceState(null, "", scoreHash(score.id));
    }
    renderFollow();
    void loadGeneratedFingering(score.id, {
      isCurrent: () => mine === token && currentId === score.id,
      onReady: (map) => view.setGeneratedFingering(map),
    });
    scoreNotes.open(score.id);
  } catch (e) {
    if (mine !== token) return;
    state = "open";
    renderFollow();
    showMessage("Could not show this score: " + (e instanceof Error ? e.message : String(e)));
  }
}

async function openFromHash(id: string, link: DrillParams | null = null): Promise<void> {
  stopFollowing();
  const mine = ++token;
  currentId = id;
  state = "opening";
  syncFreePlay();
  showMessage("Loading…");
  let score: Score;
  try {
    score = await fetchScore(id);
  } catch (e) {
    if (mine !== token) return;
    state = "hashError";
    syncFreePlay();
    currentId = null;
    if (e instanceof ApiError && e.status === 404) showMessage(NOT_IN_LIBRARY_MESSAGE);
    else showMessage(e instanceof Error ? e.message : String(e));
    return;
  }
  if (mine !== token) return;
  await openScore(score, link);
}

function syncFreePlay(): void {
  freePlay.setActive(
    (state === "idle" || state === "hashError") &&
      !sightShown() &&
      !skills.visible() &&
      !logView.visible() &&
      !running() &&
      !replay.active(),
  );
}

function closeScore(): void {
  stopFollowing();
  topbar.closeInfo();
  token++;
  view.clearMarks();
  view.clear();
  currentId = null;
  currentScore = null;
  activeDrill = null;
  activeLink = null;
  ui.rampTarget = null;
  state = "idle";
  sidebar.setCurrent(null);
  topbar.setScore(null);
  hideMessage();
  renderFollow();
  syncFreePlay();
}

async function replayFromRoute(attemptId: string): Promise<void> {
  replay.stop();
  let attempt: ReplayAttempt;
  try {
    attempt = await fetchAttempt(attemptId);
  } catch (e) {
    showToast("Could not load this run: " + (e instanceof Error ? e.message : String(e)));
    return;
  }
  if (location.hash !== replayHash(attemptId)) return;
  const scoreId = attempt.score.id;
  if (scoreId !== currentId || !scoreReady) await openFromHash(scoreId);
  else history.replaceState(null, "", activeLink ? drillHash(scoreId, activeLink) : scoreHash(scoreId));
  if (logView.visible() || skills.visible()) return;
  if (currentId === scoreId && scoreReady) replay.playAttempt(attempt);
  else showToast("Could not open the score for this run.");
}

function applyRoute(hash: string): void {
  const { route, warnings } = parseRoute(hash);
  if (import.meta.env.DEV) {
    for (const w of warnings) console.warn("drill link:", w);
  }
  const picked = drillPicked;
  drillPicked = false;
  if (route.kind === "ear") {
    enterEar(route.params);
    return;
  }
  if (route.kind === "sight") {
    enterSight(route.params);
    return;
  }
  ear.hide();
  earOpen = false;
  sight.hide();
  sightOpen = false;
  renderFollow();
  if (route.kind === "skills") {
    logView.hide();
    enterSkills();
    return;
  }
  if (route.kind === "log") {
    skills.hide();
    enterLog();
    return;
  }
  if (route.kind === "replay") {
    skills.hide();
    logView.hide();
    void replayFromRoute(route.attemptId);
    return;
  }
  const fromSkills = skills.visible();
  skills.hide();
  logView.hide();
  if (isFreeHash(hash)) {
    if (state !== "idle") closeScore();
    return;
  }
  if (route.kind !== "score") return;
  if (route.id !== currentId || !scoreReady) {
    void openFromHash(route.id, route.link);
    return;
  }
  if (route.link) {
    // back from Skills: keep tempo, bars and mode as the user left them
    if (keepsPage(fromSkills, picked, route.link, activeLink)) return;
    if (running()) stopRun();
    applyLink(route.link);
  } else {
    activeDrill = null;
    activeLink = null;
    ui.rampTarget = null;
  }
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (logView.visible()) {
      leaveLog();
      return;
    }
    if (ear.visible()) {
      ear.escape();
      return;
    }
    if (sight.visible()) {
      sight.escape();
      return;
    }
    if (skills.visible()) {
      if (skills.panelOpen()) skills.closePanel();
      else leaveSkills();
      return;
    }
    if (scoreNotes.closeMenus()) return;
    replay.closeMenu();
    if (replay.active()) {
      replay.stop();
      return;
    }
    topbar.closeInfo();
    sidebar.close();
    if (running()) stopRun();
    else {
      topbar.hideSummary();
      if (follower.status().state === "done") follower.stop();
    }
    return;
  }
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  const tag = (e.target as HTMLElement | null)?.tagName;
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
  e.preventDefault();
  if (e.key === "ArrowLeft") view.cursorPrev();
  else view.cursorNext();
});

window.addEventListener("hashchange", () => {
  applyRoute(location.hash);
  syncFreePlay();
});

topbar.setZoom(view.zoom);
topbar.setTempoRange(settings.tempo.minPercent, settings.tempo.maxPercent, settings.tempo.stepPercent);

const engine = createEngineSocket({ url: engineUrlFromSearch(location.search) });
const keyboard = import.meta.env.DEV ? createKeyboardNotes() : null;
let lastNote: NoteOnEvent | null = null;

function nowMs(): number {
  return Math.round(performance.now());
}

function renderEngine(): void {
  const s = engine.status();
  const hint = keyboard && s.state !== "connected" ? keyboardHint(keyboard.octaveShift()) : null;
  topbar.setEngine(s.state, statusTooltip(s, lastNote, hint));
}

// keys first: follower.handle may stop auto-play re-entrantly and its note_off must come after the note_on is applied
engine.onEvent((ev) => {
  if (liveKeys.apply(ev)) renderKeys();
});
engine.onEvent((ev) => {
  recorder.event(ev, performance.now());
  follower.handle(ev);
});
engine.onEvent((ev) => {
  if (ev.type !== "note_on") return;
  lastNote = ev;
  topbar.pulseEngine();
  renderEngine();
});
engine.onEvent((ev) => freePlay.handle(ev));
engine.onStatus((s) => {
  if (s.state !== "connected" && liveKeys.releaseSource("engine")) renderKeys();
  if (keyboard && s.state === "connected") {
    for (const ev of keyboard.releaseAll(nowMs())) engine.publish(ev);
  }
  renderEngine();
});
if (import.meta.env.DEV) engine.onEvent((ev) => console.info("live event", ev));

if (keyboard) {
  const isTextField = (target: EventTarget | null): boolean =>
    target instanceof HTMLElement &&
    (target.tagName === "INPUT" ||
      target.tagName === "SELECT" ||
      target.tagName === "TEXTAREA" ||
      target.isContentEditable);

  document.addEventListener("keydown", (e) => {
    if (engine.status().state === "connected" || isTextField(e.target) || e.isComposing) return;
    const r = keyboard.keyDown(e, nowMs());
    if (!r.handled) return;
    e.preventDefault();
    for (const ev of r.events) engine.publish(ev);
    if (e.code === "KeyZ" || e.code === "KeyX") renderEngine();
  });
  document.addEventListener("keyup", (e) => {
    if (engine.status().state === "connected") return;
    const r = keyboard.keyUp(e, nowMs());
    if (!r.handled) return;
    if (!isTextField(e.target)) e.preventDefault();
    for (const ev of r.events) engine.publish(ev);
  });
  window.addEventListener("blur", () => {
    for (const ev of keyboard.releaseAll(nowMs())) engine.publish(ev);
  });
}

const sight = createSightView({ engine, postAttempt: (a) => postAttempt(a), fetchHistory: (level) => fetchSightHistory(level), fetchPlan: () => fetchPlan(), onBack: () => leaveSkills(), onToast: showToast });
const ear = createEarView({ engine, postAttempt: (a) => postAttempt(a), fetchHistory: (level) => fetchEarHistory(level), fetchPlan: () => fetchPlan(), onBack: () => leaveSkills(), onToast: showToast });
const startRoute = parseRoute(location.hash).route;
if (startRoute.kind === "score") state = "opening";
void sidebar.refresh();
applyRoute(location.hash);
syncFreePlay();

renderEngine();
renderFollow();
engine.start();
