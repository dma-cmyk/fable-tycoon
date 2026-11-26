// Move-chip information and the destination-race recommendation bias.
//
// Sol's playtest picked the recommended route into Doha (cheapest property 200億, cash 100億)
// and Pune (220億) two months running, then could only close the dialog. The chips now carry
// the cheapest unaffordable / affordable price and the owners already sitting in the city, and
// the recommended move prefers a stop where the human can actually buy something — but only
// when that costs (nearly) no distance, so it can never sabotage a live race.

import type { GameData, City, MoveOption } from '../core/types';
import type { StateView } from '../core/engine';
import { purchasePrice } from '../core/economy';

export interface CityMoveInfo {
  /** Cheapest property nobody owns yet, at the price this player would pay. */
  cheapest: number | null;
  /** Cash covers `cheapest` right now. */
  affordable: boolean;
  /** Other players who already own a property in this city, in seat order. */
  otherOwnerIds: number[];
  /** Property count in the city (for "3/4 所有" style copy). */
  total: number;
}

export function cityMoveInfo(
  data: GameData,
  state: StateView,
  playerId: number,
  city: City,
): CityMoveInfo {
  let cheapest: number | null = null;
  const owners = new Set<number>();
  for (const property of city.properties) {
    const owner = state.owner[property.id];
    if (owner === undefined) {
      const price = purchasePrice(data, state, playerId, property.id);
      if (cheapest === null || price < cheapest) cheapest = price;
    } else if (owner !== playerId) {
      owners.add(owner);
    }
  }
  return {
    cheapest,
    affordable: cheapest !== null && (state.players[playerId]?.cash ?? 0) >= cheapest,
    otherOwnerIds: [...owners].sort((a, b) => a - b),
    total: city.properties.length,
  };
}

export interface MoveRecommendationInput {
  options: readonly MoveOption[];
  /** Remaining hops from a candidate node to the destination (null when unknown). */
  remainOf: (nodeId: string) => number | null;
  /** City sitting on a board node, or null for a plain square. */
  cityOf: (nodeId: string) => City | null;
  infoFor: (city: City) => CityMoveInfo;
  /** 寄り道依頼の都市（依頼なしは null）。 */
  errandCityId?: string | null;
  /** 依頼の報酬（億円）。大きいほど遠回りしてでも寄る価値がある。 */
  errandBonus?: number;
}

/**
 * Extra distance the recommendation may spend to reach an affordable property.
 *
 * A normal roll is 1–6 (3.5 average), so 2 steps is about half a turn. When the nearest
 * candidate still leaves ≥12 steps, the soonest possible arrival is already ~4 turns away;
 * half a turn of detour is under 15% of the remaining journey, and the buy adds property
 * income to every following settlement. Under 12 steps the goal is still live, so only an
 * exact distance tie may be broken toward a shop.
 */
const HOPELESS_DETOUR = 2;
const HOPELESS_REMAIN = 12;

/**
 * Returns the node the "おすすめ" chip should point at, or null to keep the map's plain
 * distance-first pick. Only ever overrides when an affordable unowned property costs at most
 * `HOPELESS_DETOUR` extra steps (0 when the goal is still reachable soon).
 */
export function biasedMoveRecommendation(input: MoveRecommendationInput): string | null {
  let minRemain = Number.POSITIVE_INFINITY;
  for (const option of input.options) {
    const remain = input.remainOf(option.nodeId);
    if (remain !== null && remain < minRemain) minRemain = remain;
  }
  if (!Number.isFinite(minRemain)) return null;

  const allowedDetour = minRemain >= HOPELESS_REMAIN ? HOPELESS_DETOUR : 0;
  let best: { nodeId: string; remain: number; price: number } | null = null;
  for (const option of input.options) {
    const city = input.cityOf(option.nodeId);
    if (!city) continue;
    const info = input.infoFor(city);
    if (info.cheapest === null || !info.affordable) continue;
    const remain = input.remainOf(option.nodeId);
    if (remain === null || remain - minRemain > allowedDetour) continue;
    if (
      best === null ||
      remain < best.remain ||
      (remain === best.remain && info.cheapest < best.price)
    ) {
      best = { nodeId: option.nodeId, remain, price: info.cheapest };
    }
  }

  // 寄り道依頼: 報酬の歩数換算（1 歩 ≒ 8 億）ぶんまでは遠回りしてよい。
  // 目的地がまだ遠いときだけ候補にする（目前のゴールを依頼で潰さない）。
  const errandId = input.errandCityId ?? null;
  const errandBonus = input.errandBonus ?? 0;
  if (errandId && errandBonus > 0 && minRemain >= 8) {
    const errandDetour = Math.min(4, Math.max(0, Math.round(errandBonus / 8)));
    let errand: { nodeId: string; remain: number } | null = null;
    for (const option of input.options) {
      const city = input.cityOf(option.nodeId);
      if (!city || city.id !== errandId) continue;
      const remain = input.remainOf(option.nodeId);
      if (remain === null || remain - minRemain > errandDetour) continue;
      if (errand === null || remain < errand.remain) errand = { nodeId: option.nodeId, remain };
    }
    if (errand && (best === null || errand.remain <= best.remain)) return errand.nodeId;
  }
  return best?.nodeId ?? null;
}

/** Compact chip copy for the destination distance / price line. */
export function moveChipPriceLabel(info: CityMoveInfo): string {
  if (info.cheapest === null) return '空きなし';
  const price = `${Math.round(info.cheapest)}億`;
  return info.affordable ? `${price} 買える` : `${price} 予算外`;
}