// Asset loading for the map renderer. Character sprite paths in characters.json still
// point at .png files while the shipped cut sprites are .webp, so ids drive the URLs.
//
// Two phases:
//   critical  - land data, terrain, tiles, sprites the board needs on its very first frame;
//               this is what the loading bar waits for.
//   deferred  - emotion variants, landmarks, stamps, realms, npcs; loaded in the background
//               after the board is playable. `MapAssets` is a live object, so a late image
//               simply appears on the next repaint instead of blocking the screen.
//
// Both phases reuse `loadImageShared`, so anything the boot preloader already fetched (the
// map tier, the picker portraits) is served from memory instead of the network.

import type { GameData } from '../core/types';
import type { LandJson, MapAssets, MapArtData } from './map';
import { VEHICLE_FILES, VEHICLE_KINDS } from './vehicles';
import { REALMS } from '../core/realm';
import type { RealmId } from '../core/types';
import { fetchJsonShared, loadImageShared, preloadedImage } from '../ui/assetPreload';
import {
  COMMON_CITY_TILE_KINDS,
  SQUARE_TILE_KINDS,
  squareTileAssetPath,
} from '../ui/squareInfo';

export type { LandJson, MapAssets };

export interface AssetProgress {
  loaded: number;
  total: number;
  label: string;
}

// Flip once public/assets/map/{terrain,terrain_lo,rivers,lakes,borders,labels} exist.
// Keeping this false avoids noisy 404s for the optional MapArt bundle.
const MAP_ART_READY = true; // terrain/borders/labels bundle
const MAP_ART_VECTORS_READY = true; // rivers.json/lakes.json have landed

function assetUrl(path: string): string {
  return new URL(`assets/${path}`, document.baseURI).href;
}

/** Runs `jobs` with a small concurrency window; resolves once all have settled. */
async function runLimited(limit: number, jobs: Array<() => Promise<void>>): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, jobs.length) }, async () => {
    while (cursor < jobs.length) {
      const job = jobs[cursor];
      cursor += 1;
      await job();
    }
  });
  await Promise.all(workers);
}

export interface LoadMapAssetsOptions {
  /** Called after the board is playable and each deferred image arrives (for a repaint). */
  onLateAsset?: () => void;
}

/** Load every map asset: land polygons, character sprites, landmarks and NPC sprites. */
export async function loadMapAssets(
  data: GameData,
  onProgress?: (p: AssetProgress) => void,
  options: LoadMapAssetsOptions = {},
): Promise<MapAssets> {
  const landUrl = assetUrl('map/land.json');
  const land = await fetchJsonShared<LandJson>(landUrl);
  let mapArt: MapArtData = {};
  if (MAP_ART_READY || MAP_ART_VECTORS_READY) {
    const [rivers, lakes, borders, labels] = await Promise.all([
      fetchJsonShared<NonNullable<MapArtData['rivers']>>(assetUrl('map/rivers.json')).catch(() => null),
      fetchJsonShared<NonNullable<MapArtData['lakes']>>(assetUrl('map/lakes.json')).catch(() => null),
      MAP_ART_READY ? fetchJsonShared<NonNullable<MapArtData['borders']>>(assetUrl('map/borders.json')).catch(() => null) : Promise.resolve(null),
      MAP_ART_READY ? fetchJsonShared<NonNullable<MapArtData['labels']>>(assetUrl('map/labels.json')).catch(() => null) : Promise.resolve(null),
    ]);
    mapArt = { rivers: rivers ?? undefined, lakes: lakes ?? undefined, borders: borders ?? undefined, labels: labels ?? undefined };
  }

  const chars = new Map<string, HTMLImageElement>();
  const landmarks = new Map<string, HTMLImageElement>();
  const npcs = new Map<string, HTMLImageElement>();
  const vehicles = new Map<string, HTMLImageElement>();
  const joy = new Map<string, HTMLImageElement>();
  const sad = new Map<string, HTMLImageElement>();
  const realms = new Map<RealmId, HTMLImageElement>();
  const stamps = new Map<string, HTMLImageElement>();
  const squareTiles = new Map<string, HTMLImageElement>();
  const squareTilesSmall = new Map<string, HTMLImageElement>();
  const cityTiles = new Map<string, HTMLImageElement>();
  const cityTilesSmall = new Map<string, HTMLImageElement>();
  let terrain: HTMLImageElement | undefined;
  let terrainLo: HTMLImageElement | undefined;

  interface Job {
    label: string;
    url: string;
    put: (img: HTMLImageElement) => void;
    deferred?: boolean;
  }
  const critical: Job[] = [];
  const late: Job[] = [];

  const add = (job: Job): void => {
    (job.deferred ? late : critical).push(job);
  };

  for (const c of data.characters) {
    add({ label: `chars/${c.id}`, url: assetUrl(`chars/${c.id}.webp`), put: (img) => chars.set(c.id, img) });
  }
  for (const id of Object.keys(REALMS) as RealmId[]) {
    add({
      label: `realms/${id}`,
      url: assetUrl(REALMS[id].background.replace(/^assets\//, '')),
      put: (img) => realms.set(id, img),
      deferred: true,
    });
  }
  const stampNames = [
    'mountains', 'snow_mountain', 'volcano', 'conifer_forest', 'forest', 'palms', 'desert',
    'fields', 'town', 'metropolis', 'port_town', 'station', 'iceberg', 'ranch', 'oil_rig', 'factory',
  ];
  if (MAP_ART_READY) {
    add({ label: 'map/terrain', url: assetUrl('map/terrain.webp'), put: (img) => { terrain = img; } });
    add({ label: 'map/terrain_lo', url: assetUrl('map/terrain_lo.webp'), put: (img) => { terrainLo = img; } });
  }
  for (const name of stampNames) {
    add({
      label: `stamps/${name}`,
      url: assetUrl(`stamps/${name}.webp`),
      put: (img) => stamps.set(name, img),
      deferred: true,
    });
  }
  for (const kind of SQUARE_TILE_KINDS) {
    add({
      label: `tiles/${kind}`,
      url: assetUrl(squareTileAssetPath(kind, false)),
      put: (img) => squareTiles.set(kind, img),
    });
    add({
      label: `tiles/small/${kind}`,
      url: assetUrl(squareTileAssetPath(kind, true)),
      put: (img) => squareTilesSmall.set(kind, img),
    });
  }
  for (const kind of COMMON_CITY_TILE_KINDS) {
    add({
      label: `tiles/city/${kind}`,
      url: assetUrl(`tiles/city/${kind}.webp`),
      put: (img) => cityTiles.set(kind, img),
    });
    add({
      label: `tiles/city/small/${kind}`,
      url: assetUrl(`tiles/city/small/${kind}.webp`),
      put: (img) => cityTilesSmall.set(kind, img),
    });
  }
  for (const kind of VEHICLE_KINDS) {
    add({
      label: `vehicles/${kind}`,
      url: assetUrl(`vehicles/${VEHICLE_FILES[kind]}`),
      put: (img) => vehicles.set(kind, img),
      deferred: true,
    });
  }
  for (const c of data.characters) {
    add({
      label: `chars/${c.id}_joy`,
      url: assetUrl(`chars/${c.id}_joy.webp`),
      put: (img) => joy.set(c.id, img),
      deferred: true,
    });
    add({
      label: `chars/${c.id}_sad`,
      url: assetUrl(`chars/${c.id}_sad.webp`),
      put: (img) => sad.set(c.id, img),
      deferred: true,
    });
  }
  const landmarkIds = new Set<string>();
  for (const c of data.cities) {
    if (c.landmark) landmarkIds.add(c.landmark);
  }
  for (const id of landmarkIds) {
    add({
      label: `landmarks/${id}`,
      url: assetUrl(`landmarks/${id}.webp`),
      put: (img) => landmarks.set(id, img),
      deferred: true,
    });
  }
  // The piper is the only NPC drawn on the board, but loading the whole set is cheap
  // and keeps room for future board-side cameos.
  for (const n of data.npcs) {
    if (!n.sprite) continue;
    add({
      label: `npcs/${n.id}`,
      url: assetUrl(`npcs/${n.id}.webp`),
      put: (img) => npcs.set(n.id, img),
      deferred: true,
    });
  }

  const putIfLoaded = (job: Job): boolean => {
    const img = preloadedImage(job.url);
    if (!img) return false;
    job.put(img);
    return true;
  };

  let loaded = 0;
  const total = critical.length;
  onProgress?.({ loaded, total, label: 'map/land.json' });
  // Several files are already decoded by the boot preloader; count those instantly so the
  // bar reflects the real remaining work instead of stalling on cached images.
  const pendingJobs: Array<() => Promise<void>> = [];
  for (const job of critical) {
    if (putIfLoaded(job)) {
      loaded += 1;
      onProgress?.({ loaded, total, label: job.label });
      continue;
    }
    pendingJobs.push(async () => {
      const img = await loadImageShared(job.url);
      if (img) job.put(img);
      loaded += 1;
      onProgress?.({ loaded, total, label: job.label });
    });
  }
  await runLimited(6, pendingJobs);
  // Let decode finish so the first frame never flashes empty sprites.
  await Promise.all(
    [
      ...chars.values(),
      ...vehicles.values(),
      ...stamps.values(),
      ...squareTiles.values(),
      ...squareTilesSmall.values(),
      ...cityTiles.values(),
      ...cityTilesSmall.values(),
      ...[terrain, terrainLo].filter((img): img is HTMLImageElement => !!img),
    ].map((img) => img.decode().catch(() => undefined)),
  );

  const assets: MapAssets = {
    land,
    chars,
    landmarks,
    npcs,
    vehicles,
    joy,
    sad,
    realms,
    stamps,
    squareTiles,
    squareTilesSmall,
    cityTiles,
    cityTilesSmall,
    terrain,
    terrainLo,
    mapArt,
  };

  // Deferred art: drain it in the background so the board is playable immediately.
  void (async () => {
    const jobs = late.map((job) => async () => {
      if (putIfLoaded(job)) return;
      const img = await loadImageShared(job.url);
      if (img) {
        job.put(img);
        options.onLateAsset?.();
      }
    });
    await runLimited(4, jobs);
    options.onLateAsset?.();
  })();

  return assets;
}