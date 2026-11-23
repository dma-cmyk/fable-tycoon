// 異世界マップ（天国・地獄・宇宙）の共有定数。ルールの正本は docs/DESIGN.md §10。
import type { GameData, RealmId } from './types';
import { getGraph, nodeForCity, shortestDistance } from './graph';
import { pickOne, type RngHolder } from './rng';

/** 異世界ノードの座標系（背景画像 public/assets/realms/<id>.webp と同じ比率） */
export const REALM_W = 2400;
export const REALM_H = 1350;

/**
 * Heuristic distance added when crossing between a realm and the world (DESIGN §10).
 * Graph BFS is physically disconnected, but destination/piper/CPU comparisons use
 * `steps to nearest portal + REALM_EXIT_DISTANCE`.
 */
export const REALM_EXIT_DISTANCE = 20;

export interface RealmInfo {
  id: RealmId;
  nameJa: string;
  /** マス効果の倍率（青・赤） */
  blueMult: number;
  redMult: number;
  /** portal を踏んだときの戻り先 */
  exit: 'near_destination' | 'random_city' | 'choose_airport';
  background: string; // public-relative
  bgm: string; // BgmName
}

export const REALMS: Record<RealmId, RealmInfo> = {
  heaven: {
    id: 'heaven', nameJa: '天下り天国', blueMult: 3, redMult: 0.5, exit: 'near_destination',
    background: 'assets/realms/heaven.webp', bgm: 'realm_heaven',
  },
  hell: {
    id: 'hell', nameJa: '借金地獄', blueMult: 0.5, redMult: 3, exit: 'random_city',
    background: 'assets/realms/hell.webp', bgm: 'realm_hell',
  },
  space: {
    id: 'space', nameJa: '宇宙ビジネス特区', blueMult: 1.5, redMult: 1.5, exit: 'choose_airport',
    background: 'assets/realms/space.webp', bgm: 'realm_space',
  },
};

export const realmOf = (node: { realm?: RealmId }): RealmId | 'world' => node.realm ?? 'world';

export function nodeRealm(data: GameData, nodeId: string): RealmId | 'world' {
  return realmOf(getGraph(data).nodes.get(nodeId) ?? {});
}

/** Realm cities always have a board node; world destinations exclude these. */
export function worldCityNodeIds(data: GameData): string[] {
  return data.cities
    .filter((c) => c.realm === undefined)
    .map((c) => nodeForCity(data, c.id))
    .filter((id): id is string => id !== null);
}

/**
 * Entry node: a realm city whose id ends in -gate, else the first board node of that realm
 * in board order.
 */
export function realmEntryNodeId(data: GameData, realm: RealmId): string | null {
  const gate = data.cities.find((c) => c.realm === realm && c.id.endsWith('-gate'));
  if (gate) {
    const node = nodeForCity(data, gate.id);
    if (node) return node;
  }
  for (const [id, node] of getGraph(data).nodes) {
    if (node.realm === realm) return id;
  }
  return null;
}

export function portalNodeIds(data: GameData, realm: RealmId): string[] {
  const out: string[] = [];
  for (const [id, node] of getGraph(data).nodes) {
    if (node.kind === 'portal' && node.realm === realm) out.push(id);
  }
  return out;
}

export function stepsToNearestPortal(data: GameData, nodeId: string): number {
  const realm = nodeRealm(data, nodeId);
  if (realm === 'world') return 0;
  let best = Infinity;
  for (const portalId of portalNodeIds(data, realm)) {
    best = Math.min(best, shortestDistance(data, nodeId, portalId));
  }
  return best;
}

/** Distance used by destination, piper and CPU heuristics across disconnected realm maps. */
export function effectiveDistance(data: GameData, fromNodeId: string, toNodeId: string): number {
  const fromRealm = nodeRealm(data, fromNodeId);
  const toRealm = nodeRealm(data, toNodeId);
  if (fromRealm === toRealm) return shortestDistance(data, fromNodeId, toNodeId);
  if (fromRealm !== 'world' && toRealm === 'world') {
    return stepsToNearestPortal(data, fromNodeId) + REALM_EXIT_DISTANCE;
  }
  if (fromRealm === 'world' && toRealm !== 'world') {
    const entry = realmEntryNodeId(data, toRealm);
    return REALM_EXIT_DISTANCE + (entry ? shortestDistance(data, entry, toNodeId) : 0);
  }
  return (
    stepsToNearestPortal(data, fromNodeId) +
    REALM_EXIT_DISTANCE * 2 +
    stepsToNearestPortal(data, toNodeId)
  );
}

export function randomWorldCityNodeId(data: GameData, holder: RngHolder): string | null {
  const nodes = worldCityNodeIds(data);
  return nodes.length > 0 ? pickOne(holder, nodes) : null;
}
