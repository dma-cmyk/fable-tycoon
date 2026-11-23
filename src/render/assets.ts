// Asset loading for the map renderer. Character sprite paths in characters.json still
// point at .png files while the shipped cut sprites are .webp, so ids drive the URLs.

import type { GameData } from '../core/types';
import type { LandJson, MapAssets } from './map';
import { VEHICLE_FILES, VEHICLE_KINDS } from './vehicles';
import { REALMS } from '../core/realm';
import type { RealmId } from '../core/types';

export type { LandJson, MapAssets };

export interface AssetProgress {
  loaded: number;
  total: number;
  label: string;
}

const IMAGE_TIMEOUT_MS = 15000;

function assetUrl(path: string): string {
  return new URL(`assets/${path}`, document.baseURI).href;
}

function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.decoding = 'async';
    let settled = false;
    const done = (value: HTMLImageElement | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const timer = setTimeout(() => done(null), IMAGE_TIMEOUT_MS);
    img.onload = () => {
      clearTimeout(timer);
      done(img);
    };
    img.onerror = () => {
      clearTimeout(timer);
      done(null);
    };
    img.src = url;
  });
}

/** Load every map asset: land polygons, character sprites, landmarks and NPC sprites. */
export async function loadMapAssets(
  data: GameData,
  onProgress?: (p: AssetProgress) => void,
): Promise<MapAssets> {
  const landUrl = assetUrl('map/land.json');
  const res = await fetch(landUrl);
  if (!res.ok) throw new Error(`land.json を読み込めません (${res.status})`);
  const land = (await res.json()) as LandJson;

  const chars = new Map<string, HTMLImageElement>();
  const landmarks = new Map<string, HTMLImageElement>();
  const npcs = new Map<string, HTMLImageElement>();
  const vehicles = new Map<string, HTMLImageElement>();
  const joy = new Map<string, HTMLImageElement>();
  const sad = new Map<string, HTMLImageElement>();
  const realms = new Map<RealmId, HTMLImageElement>();
  const stamps = new Map<string, HTMLImageElement>();

  interface Job {
    label: string;
    url: string;
    put: (img: HTMLImageElement) => void;
  }
  const jobs: Job[] = [];
  for (const c of data.characters) {
    jobs.push({
      label: `chars/${c.id}`,
      url: assetUrl(`chars/${c.id}.webp`),
      put: (img) => chars.set(c.id, img),
    });
  }
  for (const id of Object.keys(REALMS) as RealmId[]) {
    jobs.push({
      label: `realms/${id}`,
      url: assetUrl(REALMS[id].background.replace(/^assets\//, '')),
      put: (img) => realms.set(id, img),
    });
  }
  const stampNames = [
    'mountains', 'snow_mountain', 'volcano', 'conifer_forest', 'forest', 'palms', 'desert',
    'fields', 'town', 'metropolis', 'port_town', 'station', 'iceberg', 'ranch', 'oil_rig', 'factory',
  ];
  for (const name of stampNames) {
    jobs.push({
      label: `stamps/${name}`,
      url: assetUrl(`stamps/${name}.webp`),
      put: (img) => stamps.set(name, img),
    });
  }
  for (const kind of VEHICLE_KINDS) {
    jobs.push({
      label: `vehicles/${kind}`,
      url: assetUrl(`vehicles/${VEHICLE_FILES[kind]}`),
      put: (img) => vehicles.set(kind, img),
    });
  }
  for (const c of data.characters) {
    jobs.push({
      label: `chars/${c.id}_joy`,
      url: assetUrl(`chars/${c.id}_joy.webp`),
      put: (img) => joy.set(c.id, img),
    });
    jobs.push({
      label: `chars/${c.id}_sad`,
      url: assetUrl(`chars/${c.id}_sad.webp`),
      put: (img) => sad.set(c.id, img),
    });
  }
  const landmarkIds = new Set<string>();
  for (const c of data.cities) {
    if (c.landmark) landmarkIds.add(c.landmark);
  }
  for (const id of landmarkIds) {
    jobs.push({
      label: `landmarks/${id}`,
      url: assetUrl(`landmarks/${id}.webp`),
      put: (img) => landmarks.set(id, img),
    });
  }
  // The piper is the only NPC drawn on the board, but loading the whole set is cheap
  // and keeps room for future board-side cameos.
  for (const n of data.npcs) {
    if (!n.sprite) continue;
    jobs.push({
      label: `npcs/${n.id}`,
      url: assetUrl(`npcs/${n.id}.webp`),
      put: (img) => npcs.set(n.id, img),
    });
  }

  let loaded = 0;
  const total = jobs.length + 1;
  onProgress?.({ loaded, total, label: 'map/land.json' });
  await Promise.all(
    jobs.map(async (job) => {
      const img = await loadImage(job.url);
      if (img) job.put(img);
      loaded += 1;
      onProgress?.({ loaded, total, label: job.label });
    }),
  );
  // Let decode finish so the first frame never flashes empty sprites.
  await Promise.all(
    [
      ...chars.values(),
      ...landmarks.values(),
      ...npcs.values(),
      ...vehicles.values(),
      ...joy.values(),
      ...sad.values(),
      ...realms.values(),
      ...stamps.values(),
    ].map((img) => img.decode().catch(() => undefined)),
  );
  return { land, chars, landmarks, npcs, vehicles, joy, sad, realms, stamps };
}