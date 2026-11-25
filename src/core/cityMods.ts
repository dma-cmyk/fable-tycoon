// 都市単位のイベント効果（バブル・好況・災害・封鎖）。
//
// `city_mod` は 1 つの都市の物件価格（資産価値・購入価格・売却価格）と決算収益に
// 掛かる倍率を、年数付きで積む。積み上げのクランプは economy.cityModMultiplier が持つ。
// 対象都市の決め方（CityTarget）はここで一元的に解決する。乱数は state.rng のみ。

import type { CityTarget, Effect, Fx, GameData, GameState, StateView } from './types';
import { netWorth, ownedProperties } from './economy';
import { getGraph, nodeForCity, shortestDistance } from './graph';
import { pickOne } from './rng';

export type CityModEffect = Extract<Effect, { op: 'city_mod' }>;

/** 盤面ノードから立っている都市を返す（都市ノードでなければ null）。 */
function cityAtNode(data: GameData, nodeId: string | null | undefined): string | null {
  if (!nodeId) return null;
  const node = getGraph(data).nodes.get(nodeId);
  return node?.kind === 'city' && node.cityId ? node.cityId : null;
}

/** プレイヤーの現在地から最短歩数の都市。同距離は cityId 昇順で決める。 */
function nearestCity(data: GameData, nodeId: string | null | undefined): string | null {
  if (!nodeId) return null;
  let best: string | null = null;
  let bestDist = Infinity;
  for (const city of data.cities) {
    const node = nodeForCity(data, city.id);
    if (!node) continue;
    const dist = shortestDistance(data, nodeId, node);
    if (dist < bestDist || (dist === bestDist && (best === null || city.id < best))) {
      best = city.id;
      bestDist = dist;
    }
  }
  return best;
}

function hereCity(data: GameData, state: StateView, playerId: number): string | null {
  const player = state.players[playerId];
  if (!player) return null;
  return cityAtNode(data, player.nodeId) ?? nearestCity(data, player.nodeId);
}

/** そのプレイヤーが最も多く物件を持つ都市。1件も持っていなければ最寄りの都市。 */
function bestOwnedCity(data: GameData, state: StateView, playerId: number): string | null {
  const counts = new Map<string, number>();
  for (const ref of ownedProperties(data, state, playerId)) {
    counts.set(ref.cityId, (counts.get(ref.cityId) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [cityId, count] of counts) {
    if (count > bestCount || (count === bestCount && best !== null && cityId < best)) {
      best = cityId;
      bestCount = count;
    }
  }
  return best ?? hereCity(data, state, playerId);
}

function richestPlayerId(data: GameData, state: StateView): number | null {
  let best: number | null = null;
  for (const player of state.players) {
    if (best === null || netWorth(data, state, player.id) > netWorth(data, state, best)) {
      best = player.id;
    }
  }
  return best;
}

function worldCityId(data: GameData, cityId: string): string | null {
  const city = data.cities.find((c) => c.id === cityId);
  return city && city.realm === undefined ? city.id : null;
}

/**
 * 乱数を使わない対象解決（UI のプレビュー用）。'random' は候補なしとして null。
 * イベントの効果説明で「この街が対象」と出すために使う。
 */
export function peekCityTarget(
  data: GameData,
  state: StateView,
  target: CityTarget,
  actor: number,
): string | null {
  switch (target) {
    case 'here':
      return hereCity(data, state, actor);
    case 'destination':
      return state.destination ? worldCityId(data, state.destination) : null;
    case 'random':
      return null;
    case 'richest_best': {
      const id = richestPlayerId(data, state);
      return id === null ? null : bestOwnedCity(data, state, id);
    }
    case 'self_best':
      return bestOwnedCity(data, state, actor);
    default:
      return worldCityId(data, target);
  }
}

/** 効果適用時の対象解決。'random' だけが state.rng を進める。 */
export function resolveCityTarget(
  data: GameData,
  state: GameState,
  target: CityTarget,
  actor: number,
): string | null {
  if (target !== 'random') return peekCityTarget(data, state, target, actor);
  const pool = data.cities.filter((c) => c.realm === undefined && nodeForCity(data, c.id) !== null);
  return pool.length === 0 ? null : pickOne(state, pool).id;
}

/**
 * `city_mod` を state に積み、地図演出用の fx を出す。
 * 同じ都市・同じラベルの効果は年数を延ばし、倍率は掛け合わせて積む（実効値は economy 側でクランプ）。
 */
export function applyCityMod(
  data: GameData,
  state: GameState,
  fx: Fx[],
  effect: CityModEffect,
  actor: number,
): string | null {
  const cityId = resolveCityTarget(data, state, effect.city, actor);
  if (!cityId) return null;
  const same = state.cityMods.find((m) => m.cityId === cityId && m.label === effect.label);
  if (same) {
    same.mult *= effect.mult;
    same.yearsLeft = Math.max(same.yearsLeft, effect.years);
    same.kind = effect.kind;
  } else {
    state.cityMods.push({
      cityId,
      mult: effect.mult,
      yearsLeft: effect.years,
      label: effect.label,
      kind: effect.kind,
    });
  }
  fx.push({
    t: 'city_mod',
    cityId,
    mult: effect.mult,
    years: effect.years,
    label: effect.label,
    kind: effect.kind,
  });
  return cityId;
}

/**
 * 決算時の寿命処理。決算収益を計算した後に呼ぶ（その年の効果は効き、年をまたぐと1年減る）。
 * 失効した効果は 1 件ずつトーストで知らせる。
 */
export function tickCityMods(data: GameData, state: GameState, fx: Fx[]): void {
  for (const mod of state.cityMods) {
    if (mod.yearsLeft <= 1) {
      const name = data.cities.find((c) => c.id === mod.cityId)?.nameJa ?? mod.cityId;
      fx.push({ t: 'toast', text: `${name}の「${mod.label}」が終わった。` });
    }
  }
  state.cityMods = state.cityMods
    .map((mod) => ({ ...mod, yearsLeft: mod.yearsLeft - 1 }))
    .filter((mod) => mod.yearsLeft > 0);
}