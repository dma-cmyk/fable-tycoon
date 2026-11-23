// Web Audio playback for pre-generated voice lines, procedural SFX and looping BGM.
//
// Everything is created lazily inside unlock(): browsers (iOS Safari in particular) only allow an
// AudioContext to start from a user gesture. Until then every playback call is a silent no-op, so
// screens can call sfx()/bgm()/playVoice() freely while rendering.

import type { GameEventDef } from '../core/types';
import { voiceHash } from './voicekey';

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

let ctx: AudioContext | null = null;
let masterGain: GainNode | null = null;
let voiceBus: GainNode | null = null;
let chatterBus: GainNode | null = null;
let bgmBus: GainNode | null = null;
let sfxBus: GainNode | null = null;
let ready = false;

const volumes: Volumes = readVolumes();

// --- voice ----------------------------------------------------------------

interface ActiveVoice {
  source: AudioBufferSourceNode;
  resolve: () => void;
  done: boolean;
}

let activeVoice: ActiveVoice | null = null;
let voiceToken = 0;
const voiceCache = new Map<string, AudioBuffer>();
const voiceFailed = new Set<string>();

let manifestPromise: Promise<Record<string, string>> | null = null;

// --- chatter (emotes / character actions) ---------------------------------

interface ActiveChatter {
  source: AudioBufferSourceNode;
  resolve: () => void;
  done: boolean;
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
const bgmCache = new Map<BgmName, AudioBuffer>();
const bgmFailed = new Set<BgmName>();
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
    void ctx.resume().catch(() => undefined);
    return;
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
    sfxBus = ctx.createGain();
    masterGain.connect(ctx.destination);
    voiceBus.connect(masterGain);
    chatterBus.connect(voiceBus);
    bgmBus.connect(masterGain);
    sfxBus.connect(masterGain);

    masterGain.gain.value = volumes.master;
    voiceBus.gain.value = volumes.voice;
    chatterBus.gain.value = 1;
    bgmBus.gain.value = volumes.bgm;
    sfxBus.gain.value = volumes.sfx;

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
  } catch {
    ctx = null;
    masterGain = null;
    voiceBus = null;
    chatterBus = null;
    bgmBus = null;
    sfxBus = null;
    ready = false;
  }
}

/** Plays the manifest voice line for (voiceKey, text); resolves on end, stop or a missing line. */
async function playVoice(voiceKey: string, text: string): Promise<void> {
  if (!ready || !ctx) return;

  const token = ++voiceToken;
  stopActiveVoice();

  const hash = voiceHash(voiceKey, text);
  const manifest = await loadManifest();
  if (token !== voiceToken || !ready) return;

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
    if (token !== voiceToken) return;
    rememberVoice(hash, buffer);
  }

  if (token !== voiceToken || !ready) return;
  await startVoice(buffer);
}

/** Stops the current line (its playVoice promise resolves) and prevents a pending one from starting. */
function stopVoice(): void {
  voiceToken++;
  stopActiveVoice();
}

/**
 * Plays an emote / character-action line on the chatter channel. Only one chatter plays at a
 * time; a call while one is playing (or loading) is skipped and resolves immediately. The channel
 * is ducked to 40% while a game voice line is speaking. Resolves on end, skip or missing line.
 */
async function playChatter(voiceKey: string, text: string): Promise<void> {
  if (!ready || !ctx || chatterBusy) return;
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

/** Starts a looping BGM track, or fades out with null. Switching tracks crossfades over 0.8 s. */
function bgm(name: BgmName | null): void {
  if (!ready || !ctx || !bgmBus) return;

  const token = ++bgmToken;

  if (name === null) {
    const current = activeBgm;
    activeBgm = null;
    fadeOutBgm(current);
    return;
  }
  if (!BGM_SET.has(name)) return;
  if (activeBgm?.name === name) return;

  const current = activeBgm;
  activeBgm = null;
  fadeOutBgm(current);

  void (async () => {
    const entries = await loadBgmManifest();
    const entry = entries[name];
    let buffer = bgmCache.get(name);
    if (!buffer) {
      if (bgmFailed.has(name)) return;
      const file = entry && typeof entry.file === 'string' && entry.file.length > 0
        ? entry.file
        : `bgm/${name}.mp3`;
      try {
        buffer = await loadBuffer(`${ASSET_BASE}${file}`);
      } catch {
        bgmFailed.add(name);
        return;
      }
      bgmCache.set(name, buffer);
    }
    if (token !== bgmToken || !ready || !ctx || !bgmBus) return;

    const context = ctx;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    const requestedStart = entry && Number.isFinite(entry.loopStart) ? entry.loopStart : 0;
    const requestedEnd = entry && Number.isFinite(entry.loopEnd) ? entry.loopEnd : buffer.duration;
    source.loopStart = Math.min(Math.max(requestedStart, 0), Math.max(0, buffer.duration - 0.05));
    source.loopEnd = Math.min(
      Math.max(requestedEnd, source.loopStart + 0.05),
      buffer.duration,
    );

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
    }
  })();
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

function startVoice(buffer: AudioBuffer): Promise<void> {
  const context = ctx;
  const bus = voiceBus;
  if (!context || !bus) return Promise.resolve();

  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(bus);

  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  const active: ActiveVoice = { source, resolve: resolvePromise, done: false };
  activeVoice = active;
  updateChatterDuck();
  source.onended = () => {
    try {
      source.disconnect();
    } catch {
      /* already disconnected */
    }
    finishVoice(active);
  };
  try {
    source.start();
  } catch {
    finishVoice(active);
  }
  return promise;
}

function finishVoice(voice: ActiveVoice): void {
  if (voice.done) return;
  voice.done = true;
  if (activeVoice === voice) activeVoice = null;
  updateChatterDuck();
  voice.resolve();
}

function stopActiveVoice(): void {
  const voice = activeVoice;
  if (!voice) return;
  activeVoice = null;
  try {
    voice.source.stop();
  } catch {
    /* not started or already stopped */
  }
  finishVoice(voice);
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
  const active: ActiveChatter = { source, resolve: resolvePromise, done: false };
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
  if (activeChatter === chatter) activeChatter = null;
  chatter.resolve();
}

function updateChatterDuck(): void {
  if (!ctx || !chatterBus) return;
  const now = ctx.currentTime;
  chatterBus.gain.cancelScheduledValues(now);
  chatterBus.gain.setTargetAtTime(activeVoice ? CHATTER_DUCKED_GAIN : 1, now, 0.05);
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