import { describe, expect, it } from 'vitest';
import type { City, GameData, GameState, MoveOption } from '../core/types';
import type { StateView } from '../core/engine';
import { biasedMoveRecommendation, cityMoveInfo, moveChipPriceLabel } from './moveChipInfo';

const city: City = {
  id: 'testville',
  nameJa: 'テスト町',
  nameEn: 'Testville',
  country: 'JP',
  countryJa: '日本',
  region: 'east_asia',
  lat: 0,
  lon: 0,
  tier: 2,
  port: false,
  airport: false,
  blurb: 'テスト用。',
  properties: [
    { id: 'testville-1', name: '安い物件', industry: 'food', price: 20, yieldPct: 50 },
    { id: 'testville-2', name: '中くらいの物件', industry: 'tourism', price: 60, yieldPct: 12 },
    { id: 'testville-3', name: '高い物件', industry: 'finance', price: 400, yieldPct: 5 },
  ],
};

const data = { cities: [city], characters: [] } as unknown as GameData;

function gameState(input: {
  cash: number;
  owner?: Record<string, number>;
}): GameState {
  return {
    owner: input.owner ?? {},
    priceMod: {},
    industryMods: [],
    cityMods: [],
    players: [
      { id: 0, characterId: 'me', cash: input.cash },
      { id: 1, characterId: 'rival', cash: 100 },
    ],
  } as unknown as StateView as GameState;
}

describe('cityMoveInfo', () => {
  it('reports the cheapest unowned price and affordability', () => {
    const rich = cityMoveInfo(data, gameState({ cash: 100 }), 0, city);
    expect(rich.cheapest).toBe(20);
    expect(rich.affordable).toBe(true);
    expect(rich.otherOwnerIds).toEqual([]);

    const poor = cityMoveInfo(data, gameState({ cash: 15 }), 0, city);
    expect(poor.cheapest).toBe(20);
    expect(poor.affordable).toBe(false);
  });

  it('lists only other owners and keeps the cheapest still-unowned property', () => {
    const state = gameState({ cash: 30, owner: { 'testville-1': 1, 'testville-2': 0 } });
    const info = cityMoveInfo(data, state, 0, city);
    expect(info.cheapest).toBe(400);
    expect(info.affordable).toBe(false);
    expect(info.otherOwnerIds).toEqual([1]);
    expect(info.total).toBe(3);
  });

  it('has no price when everything is owned', () => {
    const state = gameState({
      cash: 9999,
      owner: { 'testville-1': 1, 'testville-2': 1, 'testville-3': 0 },
    });
    const info = cityMoveInfo(data, state, 0, city);
    expect(info.cheapest).toBe(null);
    expect(info.affordable).toBe(false);
    expect(info.otherOwnerIds).toEqual([1]);
    expect(moveChipPriceLabel(info)).toBe('空きなし');
  });
});

describe('moveChipPriceLabel', () => {
  const base = { otherOwnerIds: [], total: 3 };
  it('marks affordable and out-of-budget prices', () => {
    expect(moveChipPriceLabel({ ...base, cheapest: 25, affordable: true })).toBe('25億 買える');
    expect(moveChipPriceLabel({ ...base, cheapest: 220, affordable: false })).toBe('220億 予算外');
    expect(moveChipPriceLabel({ ...base, cheapest: null, affordable: false })).toBe('空きなし');
  });
});

describe('biasedMoveRecommendation', () => {
  const cityOption = (nodeId: string): MoveOption => ({ nodeId, path: [nodeId] });
  const squareOption = (nodeId: string): MoveOption => ({ nodeId, path: [nodeId] });
  const cityInfo = (affordable: boolean) => ({
    cheapest: affordable ? 30 : 900,
    affordable,
    otherOwnerIds: [],
    total: 3,
  });

  it('prefers an affordable city two steps off the shortest path when the race is hopeless', () => {
    const options = [squareOption('s1'), cityOption('c1')];
    const remain: Record<string, number> = { s1: 20, c1: 22 };
    const pick = biasedMoveRecommendation({
      options,
      remainOf: (id) => remain[id] ?? null,
      cityOf: (id) => (id === 'c1' ? city : null),
      infoFor: () => cityInfo(true),
    });
    expect(pick).toBe('c1');
  });

  it('does not detour when the goal is close, but may break an exact distance tie', () => {
    const options = [squareOption('s1'), cityOption('c1'), cityOption('c2')];
    const remain: Record<string, number> = { s1: 5, c1: 5, c2: 7 };
    const pick = biasedMoveRecommendation({
      options,
      remainOf: (id) => remain[id] ?? null,
      cityOf: (id) => (id.startsWith('c') ? city : null),
      infoFor: () => cityInfo(true),
    });
    expect(pick).toBe('c1');
  });

  it('keeps the plain distance pick when the shop is unaffordable or unknown', () => {
    const options = [squareOption('s1'), cityOption('c1')];
    const remain: Record<string, number> = { s1: 20, c1: 22 };
    expect(
      biasedMoveRecommendation({
        options,
        remainOf: (id) => remain[id] ?? null,
        cityOf: (id) => (id === 'c1' ? city : null),
        infoFor: () => cityInfo(false),
      }),
    ).toBe(null);
    expect(
      biasedMoveRecommendation({
        options,
        remainOf: () => null,
        cityOf: () => city,
        infoFor: () => cityInfo(true),
      }),
    ).toBe(null);
  });
});