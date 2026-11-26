// Critical-path asset preloading for the first screens.
//
// Tiers run in the order the player meets them:
//   title  -> blocks the title screen (UI icons, logo, key art)
//   picker -> the 48 base portraits used by the character picker and the setup seats
//   map    -> everything the first board frame needs (map JSON, terrain, square/city tiles)
//   idle   -> the rest (emotion variants, events, realms, npcs, landmarks, stamps, city tiles)
//
// The title tier is small on purpose: the title stays interactive at most ~1 s after the
// bundle runs. Everything else keeps loading behind a small progress strip. The tier
// promises are shared with the screens that need them, so a screen can await its own tier
// instead of showing broken images.

import { GAME_DATA } from '../data/index';
import { REALMS } from '../core/realm';
import type { RealmId } from '../core/types';
import { UI_ICON_FILES } from './assetManifest';
import { rememberWarmedUrl } from './serviceWorker';
import {
  CITY_TILE_IDS,
  COMMON_CITY_TILE_KINDS,
  SQUARE_TILE_KINDS,
  squareTileAssetPath,
} from './squareInfo';

export type AssetTier = 'title' | 'picker' | 'map' | 'idle';

export interface PreloadProgress {
  loaded: number;
  total: number;
  tier: AssetTier;
}

const POOL_LIMIT = 6;
const IDLE_POOL_LIMIT = 4;
const RETRIES = 2;
const RETRY_DELAYS_MS = [320, 900];

/** Shared image cache. `assets.ts` reads it so the map never re-fetches a preloaded file. */
const images = new Map<string, HTMLImageElement>();
const pending = new Map<string, Promise<HTMLImageElement | null>>();
const failed = new Set<string>();
const jsonCache = new Map<string, Promise<unknown>>();

export function assetUrl(path: string): string {
  return new URL(path, document.baseURI).href;
}

function loadOne(url: string, attempt = 0): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      images.set(url, img);
      rememberWarmedUrl(url);
      // Decode before the screen uses it so the first paint is never blank.
      img.decode().catch(() => undefined).then(() => resolve(img));
    };
    img.onerror = () => {
      if (attempt < RETRIES) {
        window.setTimeout(() => resolve(loadOne(url, attempt + 1)), RETRY_DELAYS_MS[attempt] ?? 900);
        return;
      }
      failed.add(url);
      resolve(null);
    };
    img.src = url;
  });
}

/** Loads (or reuses) one image. Reads the shared cache that the screens use. */
export function loadImageShared(url: string): Promise<HTMLImageElement | null> {
  // Normalise first: call sites pass both `assets/x.webp` and absolute URLs.
  const absolute = url.startsWith('data:') ? url : new URL(url, document.baseURI).href;
  const hit = images.get(absolute);
  if (hit) return Promise.resolve(hit);
  if (failed.has(absolute)) return Promise.resolve(null);
  const existing = pending.get(absolute);
  if (existing) return existing;
  const promise = loadOne(absolute).finally(() => pending.delete(absolute));
  pending.set(absolute, promise);
  return promise;
}

/** Already-decoded image for `url`, if the preloader has it. Accepts relative or absolute. */
export function preloadedImage(url: string): HTMLImageElement | undefined {
  const hit = images.get(url);
  if (hit) return hit;
  const absolute = new URL(url, document.baseURI).href;
  return images.get(absolute);
}

export function imageFailed(url: string): boolean {
  return failed.has(url);
}

/** Fetch a JSON asset once and share it (the map loader reuses the same promise). */
export function fetchJsonShared<T>(url: string): Promise<T> {
  const hit = jsonCache.get(url);
  if (hit) return hit as Promise<T>;
  const promise = fetch(url)
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<T>;
    })
    .catch((error: unknown) => {
      // A failed fetch must be retryable next time (e.g. after the retry button).
      jsonCache.delete(url);
      throw error;
    });
  jsonCache.set(url, promise);
  return promise;
}

// ---------------------------------------------------------------- tier registry

interface TierState {
  total: number;
  loaded: number;
  started: boolean;
  finished: boolean;
  resolve: () => void;
  promise: Promise<void>;
  progress: Array<(p: PreloadProgress) => void>;
}

const tiers = new Map<AssetTier, TierState>();

function tierState(tier: AssetTier): TierState {
  let state = tiers.get(tier);
  if (!state) {
    const { promise, resolve } = Promise.withResolvers<void>();
    state = { total: 0, loaded: 0, started: false, finished: false, resolve, promise, progress: [] };
    tiers.set(tier, state);
  }
  return state;
}

/** Resolves when every image in `tier` has loaded, decoded or failed. */
export function ensureTier(tier: AssetTier): Promise<void> {
  const state = tierState(tier);
  if (!state.finished) startTier(tier);
  return state.promise;
}

export function tierProgress(tier: AssetTier): PreloadProgress {
  const state = tierState(tier);
  return { loaded: state.loaded, total: state.total, tier };
}

export function onTierProgress(tier: AssetTier, cb: (p: PreloadProgress) => void): void {
  const state = tierState(tier);
  state.progress.push(cb);
  cb({ loaded: state.loaded, total: state.total, tier });
}

// ---------------------------------------------------------------- job queues

interface Job {
  url: string;
  tier: AssetTier;
}

interface Queue {
  jobs: Job[];
  active: number;
  limit: number;
}

const criticalQueue: Queue = { jobs: [], active: 0, limit: POOL_LIMIT };
const idleQueue: Queue = { jobs: [], active: 0, limit: IDLE_POOL_LIMIT };
const schedulers: Partial<Record<AssetTier, boolean>> = {};

function queueFor(tier: AssetTier): Queue {
  return tier === 'idle' ? idleQueue : criticalQueue;
}

function pump(queue: Queue): void {
  while (queue.active < queue.limit && queue.jobs.length > 0) {
    const job = queue.jobs.shift();
    if (!job) break;
    queue.active += 1;
    void loadImageShared(job.url).then((img) => {
      queue.active -= 1;
      const state = tierState(job.tier);
      state.loaded += 1;
      if (!img) failed.add(job.url);
      for (const cb of state.progress) cb({ loaded: state.loaded, total: state.total, tier: job.tier });
      maybeFinish(state);
      pump(queue);
    });
  }
}

function maybeFinish(state: TierState): void {
  if (state.finished || state.loaded < state.total) return;
  state.finished = true;
  state.resolve();
}

function startTier(tier: AssetTier): void {
  if (schedulers[tier]) return;
  schedulers[tier] = true;
  const state = tierState(tier);
  state.started = true;
  if (tier === 'map') fetchMapJson(state);
  pump(queueFor(tier));
}

/** The map's topology JSON; counted into the map tier so its bar includes them. */
function fetchMapJson(state: TierState): void {
  state.total += MAP_JSON.length;
  for (const path of MAP_JSON) {
    const url = assetUrl(path);
    void fetchJsonShared(url).then(
      () => settleMapJson(state),
      () => settleMapJson(state),
    );
  }
}

function enqueue(tier: AssetTier, paths: readonly string[]): void {
  const state = tierState(tier);
  const queue = queueFor(tier);
  const seen = new Set<string>();
  for (const path of paths) {
    const url = path.startsWith('data:') || path.startsWith('http') ? path : assetUrl(path);
    if (seen.has(url)) continue;
    seen.add(url);
    if (images.has(url)) {
      state.total += 1;
      state.loaded += 1;
      continue;
    }
    if (failed.has(url)) {
      state.total += 1;
      state.loaded += 1;
      continue;
    }
    state.total += 1;
    queue.jobs.push({ url, tier });
  }
  maybeFinish(state);
  if (state.started) pump(queue);
}

// ---------------------------------------------------------------- asset lists

export function uiPaths(): string[] {
  return [...UI_ICON_FILES].map((name) => `assets/ui/${name}.webp`);
}

/** Icons the title screen actually paints (3 menu buttons + 4 small buttons). */
const TITLE_ICONS = ['coins', 'chat', 'globe', 'hourglass', 'help', 'gear', 'trophy'];

/** Icons, logo and key art: exactly what the title paints before it is interactive. */
function titlePaths(): string[] {
  return [...TITLE_ICONS.map((name) => `assets/ui/${name}.webp`), 'assets/ui/logo.webp', 'assets/ui/keyart.webp'];
}

/** The remaining HUD icons are needed one tap later, so they ride with the first game tier. */
function hudIconPaths(): string[] {
  return uiPaths().filter((path) => !TITLE_ICONS.some((name) => path.endsWith(`/${name}.webp`)));
}

/** The 48 base portraits the picker and the setup seat cards draw. */
function pickerPaths(): string[] {
  const urls: string[] = [];
  for (const character of GAME_DATA.characters) urls.push(character.sprite);
  return urls;
}

const MAP_JSON = [
  'assets/map/land.json',
  'assets/map/rivers.json',
  'assets/map/lakes.json',
  'assets/map/borders.json',
  'assets/map/labels.json',
];

/** Everything `loadMapAssets` needs for the first board frame. */
function mapImagePaths(): string[] {
  const urls = ['assets/map/terrain.webp', 'assets/map/terrain_lo.webp', ...hudIconPaths()];
  for (const kind of SQUARE_TILE_KINDS) {
    urls.push(`assets/${squareTileAssetPath(kind, false)}`);
    urls.push(`assets/${squareTileAssetPath(kind, true)}`);
  }
  for (const kind of COMMON_CITY_TILE_KINDS) {
    urls.push(`assets/tiles/city/${kind}.webp`);
    urls.push(`assets/tiles/city/small/${kind}.webp`);
  }
  return urls;
}

/**
 * City tiles that can be the start city: the engine picks the start from the tier-1
 * world cities, so warming those makes the first board frame's own station art instant.
 */
function startCityTilePaths(): string[] {
  const urls: string[] = [];
  const startCandidates = GAME_DATA.cities.filter((city) => city.realm === undefined && city.tier === 1);
  for (const city of startCandidates) {
    if (!CITY_TILE_IDS.has(city.id)) continue;
    urls.push(`assets/tiles/cities/${city.id}.webp`);
    urls.push(`assets/tiles/cities/small/${city.id}.webp`);
  }
  return urls;
}

function idlePaths(): string[] {
  const urls: string[] = [];
  for (const character of GAME_DATA.characters) {
    urls.push(`assets/chars/${character.id}_joy.webp`);
    urls.push(`assets/chars/${character.id}_sad.webp`);
  }
  for (const id of Object.keys(REALMS) as RealmId[]) {
    urls.push(REALMS[id].background.replace(/^assets\//, ''));
  }
  for (const event of GAME_DATA.events) {
    if (event.image) urls.push(event.image.replace(/^assets\//, ''));
  }
  for (const npc of GAME_DATA.npcs) {
    if (npc.sprite) urls.push(npc.sprite.replace(/^assets\//, ''));
  }
  for (const id of new Set(GAME_DATA.cities.map((city) => city.landmark).filter(Boolean) as string[])) {
    urls.push(`assets/landmarks/${id}.webp`);
  }
  for (const name of [
    'mountains', 'snow_mountain', 'volcano', 'conifer_forest', 'forest', 'palms', 'desert',
    'fields', 'town', 'metropolis', 'port_town', 'station', 'iceberg', 'ranch', 'oil_rig', 'factory',
  ]) {
    urls.push(`assets/stamps/${name}.webp`);
  }
  for (const id of ['bullet_train', 'carpet', 'express', 'ferry', 'plane', 'rocket', 'sailboat', 'train']) {
    urls.push(`assets/vehicles/${id}.webp`);
  }
  urls.push(...startCityTilePaths());
  return urls;
}

// ---------------------------------------------------------------- public entry

const TIER_PATHS: Record<AssetTier, () => string[]> = {
  title: titlePaths,
  picker: pickerPaths,
  map: mapImagePaths,
  idle: idlePaths,
};

let prepared = false;

/** Queues every tier (without starting anything) so `ensureTier` can pull them in order. */
function prepareTiers(): void {
  if (prepared) return;
  prepared = true;
  // Queue order is the order the player meets the screens: the picker is two taps away,
  // the board is reachable only after the picker is dismissed.
  for (const tier of ['title', 'picker', 'map', 'idle'] as AssetTier[]) {
    enqueue(tier, TIER_PATHS[tier]());
  }
}

function settleMapJson(state: TierState): void {
  state.loaded += 1;
  for (const cb of state.progress) cb({ loaded: state.loaded, total: state.total, tier: 'map' });
  if (state.loaded >= state.total && !state.finished) {
    state.finished = true;
    state.resolve();
  }
}

/** Starts the blocking title tier. Call once from `main.ts` before `app.boot()`. */
export function startCriticalAssets(onProgress?: (p: PreloadProgress) => void): Promise<void> {
  prepareTiers();
  if (onProgress) onTierProgress('title', onProgress);
  return ensureTier('title');
}

/**
 * After the title is up: pull the remaining tiers in the background, in screen order.
 * Picker and map start together (the player may jump straight into a game), with the shared
 * critical pool keeping the request count sane. Idle-tier work waits for a real idle frame.
 */
export function continueAssetWarmup(): void {
  const pickerDone = ensureTier('picker');
  const mapDone = ensureTier('map');
  void Promise.all([pickerDone, mapDone]).then(() => new Promise<void>((resolve) => {
    const idle = (window as Window & { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number })
      .requestIdleCallback;
    if (idle) idle(() => resolve(), { timeout: 2500 });
    else window.setTimeout(resolve, 1200);
  })).then(() => {
    startTier('idle');
  });
}

/** Comedic loading lines. `ratio` is 0..1. */
export function loadingLine(ratio: number, tier: AssetTier): string {
  const pct = Math.round(Math.min(1, Math.max(0, ratio)) * 100);
  const stage = (tier === 'title' ? [
    '地図係が倉庫から地球を出しています',
    '国境線に定規を当てています',
    '王冠を磨いています',
  ] : tier === 'picker' ? [
    '48 人分の顔写真を並べています',
    '桃太郎にきびだんごを渡しています',
    'キャラの名札を書き直しています',
  ] : tier === 'map' ? [
    '大陸を一枚ずつ貼っています',
    '海に青を塗っています',
    '駅の看板を立てています',
  ] : [
    '天国と地獄の背景を干しています',
    '感情の差分をこっそり描き足しています',
    '新聞の見出しを考えています',
  ])[Math.min(2, Math.floor(ratio * 3))];
  return `${stage}… ${pct}%`;
}