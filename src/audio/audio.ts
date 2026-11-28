// Web Audio playback for pre-generated voice lines, procedural SFX and looping BGM.
//
// Everything is created lazily inside unlock(): browsers (iOS Safari in particular) only allow an
// AudioContext to start from a user gesture. Until then every playback call is a silent no-op, so
// screens can call sfx()/bgm()/playVoice() freely while rendering.

import type { GameEventDef } from '../core/types';
import { voiceHash } from './voicekey';
import { voiceBudgetMs, voicePlaybackRate } from './voiceBudget';

export { voiceHash, voiceKeyOf } from './voicekey';

export type VolumeKind = 'master' | 'voice' | 'bgm' | 'sfx';
type Volumes = Record<VolumeKind, number>;

const SFX_NAMES = [
  'click',
  'dice_roll',
  'dice_land',
  'step',
  'coin_gain',
  'coin_loss',
  'buy',
  'monopoly',
  'card_get',
  'card_use',
  'event',
  'goal_fanfare',
  'piper',
  'bad',
  'year_end',
  'win',
  'lose',
  'stamp',
  'timer_tick',
  'error',
  'emote_pop',
  'throw',
  'hit',
  'chat',
  'shop_bell',
  'tornado',
  'portal',
  'rocket_launch',
  'train_horn',
  'ship_horn',
  'plane_whoosh',
  'roulette_tick',
  'roulette_stop',
] as const;

const BGM_NAMES = [
  'title',
  'lobby',
  'board_a',
  'board_b',
  'board_c',
  'event_news',
  'event_history',
  'event_fable',
  'event_crisis',
  'piper',
  'yearend',
  'result',
  'realm_heaven',
  'realm_hell',
  'realm_space',
] as const;

export type SfxName = (typeof SFX_NAMES)[number];
export type BgmName = (typeof BGM_NAMES)[number];

const SFX_SET: ReadonlySet<string> = new Set(SFX_NAMES);
const BGM_SET: ReadonlySet<string> = new Set(BGM_NAMES);

const ASSET_BASE = `${import.meta.env.BASE_URL}assets/`;
const VOLUME_KEY = 'fable.volume';
const VOLUME_KINDS: readonly VolumeKind[] = ['master', 'voice', 'bgm', 'sfx'];
const DEFAULT_VOLUMES: Volumes = { master: 1, voice: 1, bgm: 0.5, sfx: 0.8 };
const VOICE_CACHE_LIMIT = 30;
const CROSSFADE_SECONDS = 0.8;
const MAX_SFX_PER_NAME = 6;
const CHATTER_DUCKED_GAIN = 0.4;
const BGM_DUCKED_GAIN = 0.4;

let ctx: AudioContext | null = null;
let masterGain: GainNode | null = null;
let voiceBus: GainNode | null = null;
let chatterBus: GainNode | null = null;
let bgmBus: GainNode | null = null;
let bgmDuck: GainNode | null = null;
let sfxBus: GainNode | null = null;
let ready = false;

const volumes: Volumes = readVolumes();

// --- voice ----------------------------------------------------------------

interface ActiveVoice {
  source: AudioBufferSourceNode;
  /** Per-line gain: lets a superseded line duck out instead of clicking off mid-word. */
  gain: GainNode;
  resolve: () => void;
  done: boolean;
  timer: ReturnType<typeof globalThis.setTimeout> | null;
}

let activeVoice: ActiveVoice | null = null;
/**
 * Bumped whenever the pending/active voice must be dropped: an explicit skip (`stopVoice`), a
 * snapshot resync, or a さくさく hand-over. A line queued behind the running one checks this when
 * its turn comes and bails out instead of starting a line the player already skipped past.
 */
let voiceEpoch = 0;
/** Lines that requested the voice channel and have not settled yet (queued + playing). */
const voiceClaims = new Set<object>();
/** Tail of the serialised voice channel: each line starts only after the previous one ended. */
let voiceTail: Promise<void> = Promise.resolve();
/**
 * Fade-out of a line that is superseded before it ends, in ms. さくさく only: 標準/じっくり never
 * cut a line, they queue behind it (see {@link playVoice}).
 */
const VOICE_HANDOVER_MS = 180;
/** Breath between two queued lines (ms), so a hand-over cannot butt two clips together. */
const VOICE_QUEUE_GAP_MS = 90;
/** Hard bound on waiting for the previous line, in case its context never advances. */
const VOICE_QUEUE_MAX_WAIT_MS = 30_000;
/**
 * How many lines may wait behind the speaking one. A catch-up burst cannot stack a minute of
 * audio: past this the line is never started at all (dropping is not cutting).
 */
const VOICE_MAX_QUEUE = 4;
const voiceCache = new Map<string, AudioBuffer>();
const voiceFailed = new Set<string>();

let manifestPromise: Promise<Record<string, string>> | null = null;

// --- chatter (emotes / character actions) ---------------------------------

interface ActiveChatter {
  source: AudioBufferSourceNode;
  resolve: () => void;
  done: boolean;
  timer: ReturnType<typeof globalThis.setTimeout> | null;
}

let activeChatter: ActiveChatter | null = null;
let chatterBusy = false;

// --- bgm ------------------------------------------------------------------

interface ActiveBgm {
  name: BgmName;
  source: AudioBufferSourceNode;
  gain: GainNode;
}

interface BgmEntry {
  file: string;
  loopStart: number;
  loopEnd: number;
}

let activeBgm: ActiveBgm | null = null;
let bgmToken = 0;
/**
 * The track the app last asked for. Kept even while the AudioContext is unavailable so the first
 * user gesture (or a context that resumes after a tab switch) can start the music on its own.
 */
let requestedBgm: BgmName | null = null;
const bgmCache = new Map<BgmName, AudioBuffer>();
/** Failed load attempts per track; cleared on success and used only for the retry backoff. */
const bgmAttempts = new Map<BgmName, number>();
let bgmRetryTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
/** How many times a track that keeps failing is retried before the session gives up on it. */
const BGM_MAX_ATTEMPTS = 4;
/** Window in which a `bgm(null)` is treated as the outgoing screen's cleanup (see `bgm`). */
const BGM_HANDOFF_GRACE_MS = 400;
let lastNamedBgmAt = 0;
/** In-flight decodes, so the title screen's repeated `bgm('title')` calls share one fetch. */
const bgmLoading = new Map<BgmName, Promise<AudioBuffer | null>>();
let bgmManifestPromise: Promise<Record<string, BgmEntry>> | null = null;

// --- sfx ------------------------------------------------------------------

const sfxCache = new Map<SfxName, AudioBuffer>();
const sfxFailed = new Set<SfxName>();
const sfxLoading = new Map<SfxName, Promise<AudioBuffer | null>>();
const sfxPlaying = new Map<SfxName, number>();

// --- public API -----------------------------------------------------------

/** Creates/resumes the AudioContext. Call from the first real user gesture (click / tap / key). */
function unlock(): void {
  if (typeof window === 'undefined') return;
  if (ctx) {
    if (ctx.state === 'closed') {
      // The browser tore the graph down (iOS after a long suspension, a lost audio device).
      // Rebuild it: the remembered BGM request and duck state are re-applied below.
      ctx = null;
      masterGain = null;
      voiceBus = null;
      chatterBus = null;
      bgmBus = null;
      bgmDuck = null;
      sfxBus = null;
      activeBgm = null;
      ready = false;
    } else {
      if (ctx.state !== 'running') void ctx.resume().catch(() => undefined);
      ensureBgmAfterResume();
      return;
    }
  }
  try {
    const webkit = (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    const Ctor = window.AudioContext ?? webkit;
    if (!Ctor) return;
    ctx = new Ctor({ latencyHint: 'interactive' });

    masterGain = ctx.createGain();
    voiceBus = ctx.createGain();
    chatterBus = ctx.createGain();
    bgmBus = ctx.createGain();
    bgmDuck = ctx.createGain();
    sfxBus = ctx.createGain();
    masterGain.connect(ctx.destination);
    voiceBus.connect(masterGain);
    chatterBus.connect(voiceBus);
    bgmBus.connect(bgmDuck);
    bgmDuck.connect(masterGain);
    sfxBus.connect(masterGain);

    masterGain.gain.value = volumes.master;
    voiceBus.gain.value = volumes.voice;
    chatterBus.gain.value = 1;
    bgmBus.gain.value = volumes.bgm;
    bgmDuck.gain.value = 1;
    sfxBus.gain.value = volumes.sfx;

    const context = ctx;
    context.onstatechange = () => {
      if (context.state === 'running') {
        updateBgmDuck();
        ensureBgmAfterResume();
      }
    };

    // Must happen inside the gesture. iOS keeps the context suspended otherwise.
    void ctx.resume().catch(() => undefined);

    // Playing a silent buffer in the same gesture unlocks Web Audio on older iOS Safari.
    const scratch = ctx.createBuffer(1, 1, 22050);
    const silent = ctx.createBufferSource();
    silent.buffer = scratch;
    silent.connect(masterGain);
    silent.start();

    ready = true;
    void loadManifest();
    // The screen that called bgm() before this gesture must not stay silent.
    ensureBgmAfterResume();
  } catch {
    ctx = null;
    masterGain = null;
    voiceBus = null;
    chatterBus = null;
    bgmBus = null;
    bgmDuck = null;
    sfxBus = null;
    ready = false;
  }
}

/** Resumes a suspended context (tab switch, phone call) and re-applies the duck + the track. */
function resumeAudio(): void {
  if (!ctx) return;
  // Safari reports `interrupted` (phone call, Siri) where Chrome reports `suspended`.
  const state: string = ctx.state;
  if (state === 'suspended' || state === 'interrupted') {
    void ctx.resume().catch(() => undefined);
  }
  updateBgmDuck();
  ensureBgmAfterResume();
}

/** Starts the remembered track again when the graph is running but nothing is playing. */
function ensureBgmAfterResume(): void {
  if (!ready || !ctx || !bgmBus) return;
  if (requestedBgm !== null && activeBgm === null) applyBgmRequest();
}

/**
 * A gesture is the only way to start audio on iOS/Android. The app calls {@link unlock} from its
 * own first-gesture handler, but a context created there can still come back suspended (or be
 * interrupted later), so the audio module keeps its own listeners: every gesture resumes, and a
 * returning tab resumes without one.
 */
let lifecycleInstalled = false;

function installAudioLifecycle(): void {
  if (typeof document === 'undefined' || lifecycleInstalled) return;
  lifecycleInstalled = true;
  const onGesture = (): void => {
    if (!ctx || !ready) {
      unlock();
      return;
    }
    resumeAudio();
  };
  for (const type of ['pointerdown', 'touchend', 'click', 'keydown'] as const) {
    document.addEventListener(type, onGesture, { capture: true, passive: true });
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') resumeAudio();
  });
}

installAudioLifecycle();

export interface PlayVoiceOptions {
  /** Requested speed-up (fx speed); capped by voicePlaybackRate() so voices never sound chipmunked. */
  rate?: number;
  /** Called right before audio playback starts, with the expected scaled duration in ms. */
  onStart?: (durationMs: number) => void;
  /**
   * What to do when a line is still speaking.
   *
   * - `'wait'` (default): queue behind it. The running line always reaches its end, and this one
   *   starts right after. 標準/じっくり use this: a clip is never cut except by an explicit skip.
   * - `'fade'`: duck the running line out over {@link VOICE_HANDOVER_MS} and start immediately.
   *   さくさく uses this, where the message window advances on reading time by design.
   */
  handover?: 'wait' | 'fade';
}

/**
 * Plays the manifest voice line for (voiceKey, text); resolves on end, stop or a missing line.
 *
 * Lines are serialised: a request while another line speaks waits its turn instead of cutting it.
 * The only ways a line ends early are {@link stopVoice} (explicit skip, screen change, resync) and
 * the `'fade'` hand-over of さくさく. `voiceClaims` keeps the BGM duck alive for the whole queue.
 */
async function playVoice(voiceKey: string, text: string, options?: PlayVoiceOptions): Promise<void> {
  // A suspended/unavailable context never reaches `onended`; do not let the caller await forever.
  if (!ready || !ctx || ctx.state !== 'running') return;

  const handover = options?.handover ?? 'wait';
  const rate = voicePlaybackRate(options?.rate);
  if (handover === 'wait' && voiceClaims.size > VOICE_MAX_QUEUE) return;
  stopActiveChatter();
  if (handover === 'fade') {
    // Supersede anything queued and fade the running line: the next beat must not wait for audio.
    voiceEpoch += 1;
    stopActiveVoice(VOICE_HANDOVER_MS);
  }

  const epoch = voiceEpoch;
  const claim = {};
  const previous = voiceTail;
  const queuedBehind = voiceClaims.size > 0;
  const link = Promise.withResolvers<void>();
  voiceTail = link.promise;
  voiceClaims.add(claim);
  updateBgmDuck();

  try {
    if (handover === 'wait' && queuedBehind) {
      // Never cut the line that is speaking: wait for it (bounded) and start after a short breath.
      await Promise.race([previous, delay(VOICE_QUEUE_MAX_WAIT_MS)]);
      if (epoch !== voiceEpoch || !ready || !ctx || ctx.state !== 'running') return;
      await delay(VOICE_QUEUE_GAP_MS);
      if (epoch !== voiceEpoch || !ready || !ctx || ctx.state !== 'running') return;
    }

    const hash = voiceHash(voiceKey, text);
    const manifest = await loadManifest();
    if (epoch !== voiceEpoch || !ready) return;

    const relPath = manifest[hash];
    if (typeof relPath !== 'string' || relPath.length === 0) return;

    let buffer = voiceCache.get(hash);
    if (buffer) {
      rememberVoice(hash, buffer);
    } else {
      if (voiceFailed.has(hash)) return;
      try {
        buffer = await loadBuffer(`${ASSET_BASE}${relPath}`);
      } catch {
        voiceFailed.add(hash);
        return;
      }
      if (epoch !== voiceEpoch) return;
      rememberVoice(hash, buffer);
    }

    if (epoch !== voiceEpoch || !ready || !ctx) return;
    await startVoice(buffer, rate, options?.onStart);
  } finally {
    voiceClaims.delete(claim);
    link.resolve();
    updateBgmDuck();
  }
}

/**
 * Stops the current line (its playVoice promise resolves) and drops every queued one. Used by an
 * explicit user skip, a screen change and a snapshot resync — never by an automatic hand-over.
 */
function stopVoice(): void {
  voiceEpoch += 1;
  stopActiveVoice();
  updateBgmDuck();
}

/** Settles after `ms`, never rejecting. */
function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  globalThis.setTimeout(resolve, Math.max(0, ms));
  return promise;
}

/**
 * Plays an emote / character-action line on the chatter channel. Only one chatter plays at a
 * time; a call while one is playing (or loading) is skipped and resolves immediately. The channel
 * is ducked to 40% while a game voice line is speaking. Resolves on end, skip or missing line.
 */
async function playChatter(voiceKey: string, text: string): Promise<void> {
  if (!ready || !ctx || ctx.state !== 'running' || chatterBusy || voiceBusy()) return;
  chatterBusy = true;
  const hash = voiceHash(voiceKey, text);
  try {
    const manifest = await loadManifest();
    if (!ready || !ctx) return;

    const relPath = manifest[hash];
    if (typeof relPath !== 'string' || relPath.length === 0) return;

    let buffer = voiceCache.get(hash);
    if (buffer) {
      rememberVoice(hash, buffer);
    } else {
      if (voiceFailed.has(hash)) return;
      try {
        buffer = await loadBuffer(`${ASSET_BASE}${relPath}`);
      } catch {
        voiceFailed.add(hash);
        return;
      }
      rememberVoice(hash, buffer);
    }

    if (!ready || !ctx) return;
    await startChatter(buffer);
  } finally {
    chatterBusy = false;
  }
}

/** Plays an SFX, overlapping up to MAX_SFX_PER_NAME copies of the same sound. */
function sfx(name: SfxName): void {
  if (!ready || !ctx || !sfxBus) return;
  if (!SFX_SET.has(name)) return;
  if ((sfxPlaying.get(name) ?? 0) >= MAX_SFX_PER_NAME) return;

  const cached = sfxCache.get(name);
  if (cached) {
    playSfxBuffer(name, cached);
    return;
  }
  if (sfxFailed.has(name)) return;

  let pending = sfxLoading.get(name);
  if (!pending) {
    pending = loadBuffer(`${ASSET_BASE}sfx/${name}.mp3`).catch(() => null);
    sfxLoading.set(name, pending);
    void pending.then((buffer) => {
      sfxLoading.delete(name);
      if (buffer) sfxCache.set(name, buffer);
      else sfxFailed.add(name);
    });
  }
  void pending.then((buffer) => {
    if (!buffer || !ready || !ctx || !sfxBus) return;
    if ((sfxPlaying.get(name) ?? 0) >= MAX_SFX_PER_NAME) return;
    playSfxBuffer(name, buffer);
  });
}

/**
 * Asks for a looping BGM track, or `null` to fade the music out. Switching tracks crossfades over
 * 0.8 s.
 *
 * The request is remembered even before the AudioContext exists (the first visit renders the title
 * before any gesture), so {@link unlock} and a context that comes back from suspension can start
 * the track the screen asked for. This is what makes music play after the first tap on iOS.
 */
function bgm(name: BgmName | null): void {
  if (name !== null) {
    if (!BGM_SET.has(name)) return;
    lastNamedBgmAt = performance.now();
    requestedBgm = name;
    applyBgmRequest();
    return;
  }
  // `App.showScreen` builds the new screen before it destroys the old one, so the outgoing
  // screen's `bgm(null)` arrives right after the incoming screen's request. Honour the screen
  // that is actually on screen: a stop this soon after a named request is the old screen's
  // cleanup, not the new screen's wish for silence.
  if (performance.now() - lastNamedBgmAt < BGM_HANDOFF_GRACE_MS) return;
  requestedBgm = null;
  applyBgmRequest();
}

/** Starts, stops or retries the audio for the last {@link bgm} request. No-op before unlock. */
function applyBgmRequest(): void {
  if (!ready || !ctx || !bgmBus) return;
  const name = requestedBgm;
  const token = ++bgmToken;
  if (name === null) {
    const current = activeBgm;
    activeBgm = null;
    fadeOutBgm(current);
    return;
  }
  if (activeBgm?.name === name) return;
  const current = activeBgm;
  activeBgm = null;
  fadeOutBgm(current);
  void startBgm(name, token);
}

/** Loads (or reuses) one track, then crossfades it in. Retries a failed load while still wanted. */
async function startBgm(name: BgmName, token: number): Promise<void> {
  const entries = await loadBgmManifest();
  const entry = entries[name];
  let buffer = bgmCache.get(name);
  if (!buffer) {
    const file = entry && typeof entry.file === 'string' && entry.file.length > 0
      ? entry.file
      : `bgm/${name}.mp3`;
    let pending = bgmLoading.get(name);
    if (!pending) {
      pending = loadBuffer(`${ASSET_BASE}${file}`)
        .then((loaded) => {
          bgmCache.set(name, loaded);
          return loaded;
        })
        .catch(() => {
          // A transient failure (offline start, a service-worker hiccup) must not silence this
          // track for the rest of the session: back off and ask again while it is still wanted.
          scheduleBgmRetry(name, token);
          return null;
        })
        .finally(() => bgmLoading.delete(name));
      bgmLoading.set(name, pending);
    }
    buffer = (await pending) ?? undefined;
    if (!buffer) return;
  }
  if (token !== bgmToken || !ready || !ctx || !bgmBus) return;
  bgmAttempts.delete(name);

  const context = ctx;
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.loop = true;
  const requestedStart = entry && Number.isFinite(entry.loopStart) ? entry.loopStart : 0;
  const requestedEnd = entry && Number.isFinite(entry.loopEnd) ? entry.loopEnd : buffer.duration;
  source.loopStart = Math.min(Math.max(requestedStart, 0), Math.max(0, buffer.duration - 0.05));
  source.loopEnd = Math.min(Math.max(requestedEnd, source.loopStart + 0.05), buffer.duration);

  const gain = context.createGain();
  const now = context.currentTime;
  gain.gain.setValueAtTime(0, now);
  source.connect(gain);
  gain.connect(bgmBus);

  const track: ActiveBgm = { name, source, gain };
  activeBgm = track;
  gain.gain.linearRampToValueAtTime(1, now + CROSSFADE_SECONDS);
  source.onended = () => {
    try {
      source.disconnect();
      gain.disconnect();
    } catch {
      /* already disconnected */
    }
    if (activeBgm === track) activeBgm = null;
  };
  try {
    source.start();
  } catch {
    activeBgm = null;
    try {
      source.disconnect();
      gain.disconnect();
    } catch {
      /* already disconnected */
    }
    scheduleBgmRetry(name, token);
  }
}

/** Re-asks for a track whose load failed, with a short backoff, while it is still the request. */
function scheduleBgmRetry(name: BgmName, token: number): void {
  if (token !== bgmToken || requestedBgm !== name) return;
  const attempts = (bgmAttempts.get(name) ?? 0) + 1;
  bgmAttempts.set(name, attempts);
  if (attempts > BGM_MAX_ATTEMPTS) return;
  if (bgmRetryTimer !== null) globalThis.clearTimeout(bgmRetryTimer);
  bgmRetryTimer = globalThis.setTimeout(() => {
    bgmRetryTimer = null;
    if (requestedBgm === name) applyBgmRequest();
  }, Math.min(8000, 400 * 2 ** attempts));
}

function setVolume(kind: VolumeKind, value: number): void {
  volumes[kind] = clamp01(value);
  persistVolumes();
  applyVolumes();
}

function getVolume(kind: VolumeKind): number {
  return volumes[kind];
}

export const Audio = {
  unlock,
  playVoice,
  playChatter,
  stopVoice,
  sfx,
  bgm,
  setVolume,
  getVolume,
} as const;

/** What `window.__audioDebug()` reports: enough for a headless run to assert the audio state. */
export interface AudioDebugSnapshot {
  context: AudioContextState | 'none';
  requestedBgm: BgmName | null;
  activeBgm: BgmName | null;
  /** Envelope of the playing track (0→1 after the crossfade); null when nothing plays. */
  bgmGain: number | null;
  /** BGM duck node: 1 normally, 0.4 while a voice line speaks or is queued. */
  duck: number | null;
  voiceBusy: boolean;
  voiceQueue: number;
  /** Tracks whose load failed and are waiting for their next retry. */
  bgmRetries: Partial<Record<BgmName, number>>;
}

function audioDebugSnapshot(): AudioDebugSnapshot {
  return {
    context: ctx ? ctx.state : 'none',
    requestedBgm,
    activeBgm: activeBgm?.name ?? null,
    bgmGain: activeBgm ? activeBgm.gain.gain.value : null,
    duck: bgmDuck ? bgmDuck.gain.value : null,
    voiceBusy: voiceBusy(),
    voiceQueue: voiceClaims.size,
    bgmRetries: Object.fromEntries(bgmAttempts) as Partial<Record<BgmName, number>>,
  };
}

// QA seam for headless runs: `?audioDebug=1` (or any dev build) exposes the live audio state,
// so a test can assert that the first gesture actually started the requested track.
if (import.meta.env.DEV || (typeof location !== 'undefined' && new URLSearchParams(location.search).has('audioDebug'))) {
  (globalThis as { __audioDebug?: () => AudioDebugSnapshot }).__audioDebug = audioDebugSnapshot;
}

/** BGM for an event panel: the event's own valid `bgm`, else the default for its kind. */
export function bgmForEvent(ev: GameEventDef): BgmName {
  if (typeof ev.bgm === 'string' && BGM_SET.has(ev.bgm)) return ev.bgm as BgmName;
  if (ev.kind === 'history') return 'event_history';
  if (ev.kind === 'fable') return 'event_fable';
  return 'event_news';
}

// --- internals ------------------------------------------------------------

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function readVolumes(): Volumes {
  const out: Volumes = { ...DEFAULT_VOLUMES };
  try {
    if (typeof localStorage === 'undefined') return out;
    const raw = localStorage.getItem(VOLUME_KEY);
    if (!raw) return out;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return out;
    for (const kind of VOLUME_KINDS) {
      const value = (parsed as Record<string, unknown>)[kind];
      if (typeof value === 'number' && Number.isFinite(value)) out[kind] = clamp01(value);
    }
  } catch {
    /* unreadable localStorage: keep defaults */
  }
  return out;
}

function persistVolumes(): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(VOLUME_KEY, JSON.stringify(volumes));
  } catch {
    /* private mode / quota: volumes stay in memory */
  }
}

function applyVolumes(): void {
  if (!ctx) return;
  const now = ctx.currentTime;
  setNodeGain(masterGain, volumes.master, now);
  setNodeGain(voiceBus, volumes.voice, now);
  setNodeGain(bgmBus, volumes.bgm, now);
  setNodeGain(sfxBus, volumes.sfx, now);
}

function setNodeGain(node: GainNode | null, value: number, at: number): void {
  if (!node) return;
  node.gain.cancelScheduledValues(at);
  node.gain.setTargetAtTime(value, at, 0.015);
}

function loadManifest(): Promise<Record<string, string>> {
  if (!manifestPromise) {
    manifestPromise = fetch(`${ASSET_BASE}voice/manifest.json`, { cache: 'force-cache' })
      .then(async (response) => {
        if (!response.ok) return {};
        const parsed: unknown = await response.json();
        return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
      })
      .catch(() => ({}));
  }
  return manifestPromise;
}

function loadBgmManifest(): Promise<Record<string, BgmEntry>> {
  if (!bgmManifestPromise) {
    bgmManifestPromise = fetch(`${ASSET_BASE}bgm/bgm.json`, { cache: 'force-cache' })
      .then(async (response) => {
        if (!response.ok) return {};
        const parsed: unknown = await response.json();
        return parsed && typeof parsed === 'object' ? (parsed as Record<string, BgmEntry>) : {};
      })
      .catch(() => ({}));
  }
  return bgmManifestPromise;
}

async function loadBuffer(url: string): Promise<AudioBuffer> {
  const context = ctx;
  if (!context) throw new Error('audio context is not ready');
  const response = await fetch(url);
  if (!response.ok) throw new Error(`audio fetch failed (${response.status}): ${url}`);
  return context.decodeAudioData(await response.arrayBuffer());
}

function rememberVoice(hash: string, buffer: AudioBuffer): void {
  voiceCache.delete(hash);
  voiceCache.set(hash, buffer);
  while (voiceCache.size > VOICE_CACHE_LIMIT) {
    const oldest = voiceCache.keys().next();
    if (oldest.done) break;
    voiceCache.delete(oldest.value);
  }
}

function startVoice(
  buffer: AudioBuffer,
  rate = 1,
  onStart?: (durationMs: number) => void,
): Promise<void> {
  const context = ctx;
  const bus = voiceBus;
  if (!context || !bus) return Promise.resolve();

  const clampedRate = voicePlaybackRate(rate);
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.playbackRate.value = clampedRate;
  const gain = context.createGain();
  source.connect(gain);
  gain.connect(bus);

  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  const active: ActiveVoice = { source, gain, resolve: resolvePromise, done: false, timer: null };
  activeVoice = active;
  updateChatterDuck();
  updateBgmDuck();
  source.onended = () => {
    try {
      source.disconnect();
      gain.disconnect();
    } catch {
      /* already disconnected */
    }
    finishVoice(active);
  };
  // Safari/Chrome may not fire `ended` for a suspended context; never await the line forever.
  active.timer = globalThis.setTimeout(
    () => finishVoice(active),
    voiceBudgetMs(buffer.duration * 1000, '', clampedRate),
  );
  try {
    onStart?.((buffer.duration * 1000) / clampedRate);
    source.start();
  } catch {
    finishVoice(active);
  }
  return promise;
}

function finishVoice(voice: ActiveVoice): void {
  if (voice.done) return;
  voice.done = true;
  if (voice.timer !== null) {
    globalThis.clearTimeout(voice.timer);
    voice.timer = null;
  }
  if (activeVoice === voice) activeVoice = null;
  updateChatterDuck();
  updateBgmDuck();
  voice.resolve();
}

/**
 * Stops the current line (its playVoice promise resolves). With `duckMs` the line is faded out
 * over that long instead of cut: a new line may start on top of the tail without a click and
 * without two voices ever speaking at full level together.
 */
function stopActiveVoice(duckMs = 0): void {
  const voice = activeVoice;
  if (!voice) return;
  activeVoice = null;
  const context = ctx;
  if (duckMs > 0 && context && context.state === 'running') {
    try {
      const now = context.currentTime;
      const end = now + duckMs / 1000;
      voice.gain.gain.cancelScheduledValues(now);
      voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
      voice.gain.gain.linearRampToValueAtTime(0.0001, end);
      // `onended` still disconnects the nodes; `finishVoice` already resolved the promise.
      voice.source.stop(end + 0.02);
    } catch {
      /* not started or already stopped */
    }
  } else {
    try {
      voice.source.stop();
    } catch {
      /* not started or already stopped */
    }
  }
  finishVoice(voice);
}

function stopActiveChatter(): void {
  const chatter = activeChatter;
  if (!chatter) return;
  activeChatter = null;
  try {
    chatter.source.stop();
  } catch {
    /* not started or already stopped */
  }
  finishChatter(chatter);
}

function startChatter(buffer: AudioBuffer): Promise<void> {
  const context = ctx;
  const bus = chatterBus;
  if (!context || !bus) return Promise.resolve();

  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(bus);

  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  const active: ActiveChatter = { source, resolve: resolvePromise, done: false, timer: null };
  activeChatter = active;
  updateChatterDuck();
  source.onended = () => {
    try {
      source.disconnect();
    } catch {
      /* already disconnected */
    }
    finishChatter(active);
  };
  active.timer = globalThis.setTimeout(() => finishChatter(active), voiceBudgetMs(buffer.duration * 1000, ''));
  try {
    source.start();
  } catch {
    finishChatter(active);
  }
  return promise;
}

function finishChatter(chatter: ActiveChatter): void {
  if (chatter.done) return;
  chatter.done = true;
  if (chatter.timer !== null) {
    globalThis.clearTimeout(chatter.timer);
    chatter.timer = null;
  }
  if (activeChatter === chatter) activeChatter = null;
  chatter.resolve();
}

function updateChatterDuck(): void {
  if (!ctx || !chatterBus) return;
  const now = ctx.currentTime;
  chatterBus.gain.cancelScheduledValues(now);
  chatterBus.gain.setTargetAtTime(activeVoice ? CHATTER_DUCKED_GAIN : 1, now, 0.05);
}

/** True while any voice line is speaking or waiting for its turn on the voice channel. */
function voiceBusy(): boolean {
  return activeVoice !== null || voiceClaims.size > 0;
}

/**
 * Ducks BGM by 8 dB while a game voice line is speaking or queued. Recomputed from the live claim
 * set, so a skipped or never-started line can never leave the music stuck under the duck.
 */
function updateBgmDuck(): void {
  if (!ctx || !bgmDuck) return;
  const target = voiceBusy() ? BGM_DUCKED_GAIN : 1;
  const now = ctx.currentTime;
  const gain = bgmDuck.gain;
  const current = gain.value;
  gain.cancelScheduledValues(now);
  gain.setValueAtTime(current, now);
  gain.linearRampToValueAtTime(target, now + (target < current ? 0.15 : 0.3));
}

function fadeOutBgm(track: ActiveBgm | null): void {
  if (!track || !ctx) return;
  const context = ctx;
  const now = context.currentTime;
  const end = now + CROSSFADE_SECONDS;
  const gain = track.gain.gain;
  gain.cancelScheduledValues(now);
  gain.setValueAtTime(gain.value, now);
  gain.linearRampToValueAtTime(0, end);
  try {
    track.source.stop(end + 0.05);
  } catch {
    /* already stopped */
  }
}

function playSfxBuffer(name: SfxName, buffer: AudioBuffer): void {
  const context = ctx;
  const bus = sfxBus;
  if (!context || !bus) return;

  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(bus);

  sfxPlaying.set(name, (sfxPlaying.get(name) ?? 0) + 1);
  source.onended = () => {
    const remaining = (sfxPlaying.get(name) ?? 1) - 1;
    if (remaining <= 0) sfxPlaying.delete(name);
    else sfxPlaying.set(name, remaining);
    try {
      source.disconnect();
    } catch {
      /* already disconnected */
    }
  };
  try {
    source.start();
  } catch {
    const remaining = (sfxPlaying.get(name) ?? 1) - 1;
    if (remaining <= 0) sfxPlaying.delete(name);
    else sfxPlaying.set(name, remaining);
  }
}