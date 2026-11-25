// Prices, income, net worth and the fiscal-year scaling rules (DESIGN §2.2/§2.3).

import type { CityModState, GameData, GameState, Industry, PerkId, Property, StateView } from './types';
import { getGraph } from './graph';

export const STARTING_CASH = 100;
export const SELL_RATE = 0.7;
export const HAND_LIMIT = 8;
export const CARD_SHARK_BONUS = 2;

/** 1 + 0.35 × (year − 1) */
export function yearScale(state: Pick<GameState, 'year'>): number {
  return 1 + 0.35 * (state.year - 1);
}

export interface PropertyRef {
  property: Property;
  city: GameData['cities'][number];
  cityId: string;
}

/** 都市 mod の積み上げ上限・下限（イベントの都市バブル／災害で使う）。 */
export const CITY_MOD_MIN = 0.3;
export const CITY_MOD_MAX = 3;

/** その都市に有効な city_mod だけを返す（UI のバッジ用）。 */
export function activeCityMods(state: StateView, cityId: string): CityModState[] {
  return (state.cityMods ?? []).filter((mod) => mod.cityId === cityId && mod.yearsLeft > 0);
}

/**
 * 都市単位の物件価格・収益に掛かる実効倍率。複数の mod は乗算し、
 * 積み上げ結果を 0.3〜3.0 にクランプする（1都市を1イベントで壊し切らないため）。
 */
export function cityModMultiplier(state: StateView, cityId: string): number {
  let mult = 1;
  for (const mod of state.cityMods ?? []) {
    if (mod.cityId === cityId && mod.yearsLeft > 0) mult *= mod.mult;
  }
  return Math.min(CITY_MOD_MAX, Math.max(CITY_MOD_MIN, mult));
}

export function findProperty(data: GameData, propertyId: string): PropertyRef | null {
  for (const city of data.cities) {
    for (const property of city.properties) {
      if (property.id === propertyId) return { property, city, cityId: city.id };
    }
  }
  return null;
}

export function industryPriceMult(state: StateView, industry: Industry): number {
  return state.priceMod[industry] ?? 1;
}

/** Asset value (and base purchase value before perk discounts). */
export function currentPrice(data: GameData, state: StateView, propertyId: string): number {
  const ref = findProperty(data, propertyId);
  if (!ref) throw new Error(`unknown property: ${propertyId}`);
  return (
    ref.property.price *
    industryPriceMult(state, ref.property.industry) *
    cityModMultiplier(state, ref.cityId)
  );
}

/** What `playerId` actually pays to buy (haggler −10%). */
export function purchasePrice(
  data: GameData,
  state: StateView,
  playerId: number,
  propertyId: string,
): number {
  const player = state.players[playerId];
  const ref = findProperty(data, propertyId);
  if (!ref || !player) throw new Error(`unknown property/player: ${propertyId}/${playerId}`);
  const discount = characterPerk(data, state, playerId) === 'haggler' ? 0.9 : 1;
  return (
    ref.property.price *
    industryPriceMult(state, ref.property.industry) *
    cityModMultiplier(state, ref.cityId) *
    discount
  );
}

export function sellPrice(data: GameData, state: StateView, propertyId: string): number {
  return currentPrice(data, state, propertyId) * SELL_RATE;
}

export function monopolises(
  data: GameData,
  state: StateView,
  playerId: number,
  cityId: string,
): boolean {
  const city = data.cities.find((c) => c.id === cityId);
  if (!city || city.properties.length === 0) return false;
  return city.properties.every((p) => state.owner[p.id] === playerId);
}

export function ownCount(
  data: GameData,
  state: StateView,
  playerId: number,
  cityId: string,
): number {
  const city = data.cities.find((c) => c.id === cityId);
  if (!city) return 0;
  return city.properties.filter((p) => state.owner[p.id] === playerId).length;
}

export function ownedProperties(
  data: GameData,
  state: StateView,
  playerId: number,
): PropertyRef[] {
  const out: PropertyRef[] = [];
  for (const city of data.cities) {
    for (const property of city.properties) {
      if (state.owner[property.id] === playerId) out.push({ property, city, cityId: city.id });
    }
  }
  return out;
}

export function characterPerk(data: GameData, state: StateView, playerId: number): PerkId {
  const characterId = state.players[playerId]?.characterId;
  const character = data.characters.find((c) => c.id === characterId);
  return character?.perk ?? 'none';
}

/** Perk income multiplier for an industry (DESIGN §2.7). */
export function perkIndustryMultiplier(perk: PerkId, industry: Industry): number {
  switch (perk) {
    case 'agri_boost':
      return industry === 'agri' || industry === 'food' ? 1.25 : 1;
    case 'tech_boost':
      return industry === 'tech' || industry === 'media' ? 1.25 : 1;
    case 'tourism_boost':
      return industry === 'tourism' ? 1.3 : 1;
    case 'finance_boost':
      return industry === 'finance' || industry === 'energy' ? 1.2 : 1;
    default:
      return 1;
  }
}

/** Active `industry_mod` product for one industry and one player's perk. */
export function incomeMultiplier(
  data: GameData,
  state: StateView,
  playerId: number,
  industry: Industry,
): number {
  let mult = 1;
  for (const mod of state.industryMods) {
    if (mod.industry === industry && mod.yearsLeft > 0) mult *= mod.mult;
  }
  return mult * perkIndustryMultiplier(characterPerk(data, state, playerId), industry);
}

export function propertyAnnualIncome(
  data: GameData,
  state: StateView,
  playerId: number,
  property: Property,
  cityId: string,
): number {
  const base = (property.price * property.yieldPct) / 100;
  const mono = monopolises(data, state, playerId, cityId) ? 2 : 1;
  return (
    base *
    incomeMultiplier(data, state, playerId, property.industry) *
    mono *
    cityModMultiplier(state, cityId)
  );
}

/** Sum of all owned properties' annual income (億円, floats allowed; display rounds). */
export function annualIncome(data: GameData, state: StateView, playerId: number): number {
  let total = 0;
  for (const city of data.cities) {
    for (const property of city.properties) {
      if (state.owner[property.id] === playerId) {
        total += propertyAnnualIncome(data, state, playerId, property, city.id);
      }
    }
  }
  return total;
}

/** Cash + current asset value of every owned property. */
export function netWorth(data: GameData, state: StateView, playerId: number): number {
  const player = state.players[playerId];
  if (!player) return 0;
  let total = player.cash;
  for (const ref of ownedProperties(data, state, playerId)) {
    total += currentPrice(data, state, ref.property.id);
  }
  return total;
}

/** 目的地一番乗りボーナス = (30 + 2 × 開始時の最短歩数) × yearScale */
export function destinationBonus(state: Pick<GameState, 'year'>, startDistance: number): number {
  return (30 + 2 * Math.max(0, startDistance)) * yearScale(state);
}

/** `year_end` 用の風刺見出し。rng を使わず、勝者から決定的に選ぶ。 */
export function satiricalHeadline(data: GameData, state: StateView, winnerId: number): string {
  const winner = state.players[winnerId];
  const character = data.characters.find((c) => c.id === winner?.characterId);
  const who = character?.nameJa ?? winner?.name ?? '謎の投資家';
  const lines = [
    `${who}氏、世界の駅を買い占め「交通は私のもの」と会見`,
    `専門家「今年の好景気はたまたまです」と断言、根拠は不明`,
    `${who}氏の資産が増加、財務省「税制の勝利」と自画自賛`,
    `世界経済、童話キャラの物件投機で過去最高を更新`,
    `「富の再分配は済んだ」と誰かが言った気がする`,
  ];
  return lines[Math.abs(winnerId) % lines.length];
}

/** Verifies every city referenced by the board exists. Used by createGame validation. */
export function validateBoardCities(data: GameData): string[] {
  const graph = getGraph(data);
  const missing: string[] = [];
  for (const city of data.cities) {
    if (!graph.cityNode.has(city.id)) missing.push(city.id);
  }
  return missing;
}