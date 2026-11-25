// 都市イベント（city_mod）のルール検証。
// 価格・収益・積み上げ上限・年次失効・対象解決・最終年フィルタ・効果文言の同期を確認する。

import { describe, expect, it } from 'vitest';
import type { Effect, Fx, GameConfig, GameData, GameState } from './types';
import { fixtureData } from './test-fixture';
import { cpuDecide, createGame, step } from './engine';
import {
  CITY_MOD_MAX,
  CITY_MOD_MIN,
  annualIncome,
  cityModMultiplier,
  currentPrice,
  netWorth,
  purchasePrice,
  sellPrice,
} from './economy';
import { FINAL_YEAR_WEIGHT_BOOST, applyEffects, markEventUsed, pickEvent, pickMonthlyEvent, resolveTargets } from './events';
import { peekCityTarget, resolveCityTarget, tickCityMods } from './cityMods';
import { GAME_DATA } from '../data/index';
import { describeEffect } from '../ui/eventEffects';

const data: GameData = fixtureData;
const CHARACTERS = ['momotaro', 'sinbad', 'alice', 'red_hood'];

function config(years = 3, seed = 1): GameConfig {
  return {
    years,
    seed,
    players: CHARACTERS.map((characterId, i) => ({
      name: `P${i}`,
      characterId,
      isCpu: true,
      cpuLevel: 2 as const,
    })),
  };
}

function fresh(years = 3): GameState {
  const state = createGame(data, config(years)).state;
  state.phase = { t: 'turn_start' };
  state.pendingTurnStart = false;
  return state;
}

function cityMod(
  cityId: string,
  mult: number,
  yearsLeft = 2,
  label = 'テスト',
  kind: 'bubble' | 'damage' | 'blockade' | 'boom' = 'bubble',
) {
  return { cityId, mult, yearsLeft, label, kind } as const;
}

function setOwner(state: GameState, propertyId: string, playerId: number): void {
  state.owner[propertyId] = playerId;
}

describe('city modifiers: prices and income', () => {
  it('applies the bubble multiplier to price, buy price, sell price and net worth', () => {
    const state = fresh();
    state.cityMods.push(cityMod('tokyo', 2));
    expect(currentPrice(data, state, 'tokyo-tower')).toBeCloseTo(80); // 40 × 2
    expect(purchasePrice(data, state, 0, 'tokyo-tower')).toBeCloseTo(80);
    expect(sellPrice(data, state, 'tokyo-tower')).toBeCloseTo(80 * 0.7);
    setOwner(state, 'tokyo-tower', 0);
    const cash = state.players[0].cash;
    expect(netWorth(data, state, 0)).toBeCloseTo(cash + 80);
  });

  it('applies a damage multiplier to settlement income', () => {
    const state = fresh();
    setOwner(state, 'tokyo-tower', 0);
    const base = annualIncome(data, state, 0);
    expect(base).toBeCloseTo(2); // 40 × 5%
    state.cityMods.push(cityMod('tokyo', 0.5, 2, '災害', 'damage'));
    expect(annualIncome(data, state, 0)).toBeCloseTo(1);
  });

  it('keeps other cities untouched', () => {
    const state = fresh();
    state.cityMods.push(cityMod('tokyo', 2));
    expect(currentPrice(data, state, 'osaka-dotonbori')).toBeCloseTo(25);
    expect(cityModMultiplier(state, 'osaka')).toBe(1);
  });

  it('stacks multiplicatively and clamps the product to 0.3..3.0', () => {
    const state = fresh();
    state.cityMods.push(cityMod('tokyo', 1.5), cityMod('tokyo', 1.5, 1, '重ね'));
    expect(cityModMultiplier(state, 'tokyo')).toBeCloseTo(2.25);
    state.cityMods.push(cityMod('tokyo', 2, 2, 'さらに'));
    expect(cityModMultiplier(state, 'tokyo')).toBe(CITY_MOD_MAX);
    expect(currentPrice(data, state, 'tokyo-tower')).toBeCloseTo(40 * CITY_MOD_MAX);

    state.cityMods = [cityMod('osaka', 0.5, 2, '災害', 'damage'), cityMod('osaka', 0.4, 2, '追い打ち', 'damage')];
    expect(cityModMultiplier(state, 'osaka')).toBe(CITY_MOD_MIN);
    expect(CITY_MOD_MIN).toBe(0.3);
  });

  it('expires mods at year end and announces each one', () => {
    const state = fresh();
    state.cityMods = [cityMod('tokyo', 1.5, 1), cityMod('osaka', 0.7, 2, '災害', 'damage')];
    const fx: Fx[] = [];
    tickCityMods(data, state, fx);
    expect(state.cityMods).toHaveLength(1);
    expect(state.cityMods[0]).toMatchObject({ cityId: 'osaka', yearsLeft: 1 });
    expect(fx).toContainEqual({ t: 'toast', text: '東京の「テスト」が終わった。' });
  });

  it('decrements city mods during the engine year-end settlement', () => {
    let state = createGame(data, config(1)).state;
    state.cityMods = [cityMod('tokyo', 1.4, 1, '決算バブル', 'bubble')];
    const fx: Fx[] = [];
    let guard = 0;
    while (state.phase.t !== 'year_end' && guard < 4000) {
      guard += 1;
      const result = step(data, state, state.current, cpuDecide(data, state));
      state = result.state;
      fx.push(...result.fx);
    }
    expect(state.phase.t).toBe('year_end');
    expect(state.cityMods).toHaveLength(0);
    expect(fx.some((f) => f.t === 'toast' && f.text.includes('決算バブル'))).toBe(true);
  });
});

describe('city_mod effect', () => {
  it('resolves a literal city id and emits the fx', () => {
    const state = fresh();
    const fx: Fx[] = [];
    const effect: Effect = { op: 'city_mod', city: 'tokyo', mult: 1.5, years: 2, label: '五輪特需', kind: 'boom' };
    applyEffects(data, state, fx, [effect], 0);
    expect(state.cityMods).toEqual([
      { cityId: 'tokyo', mult: 1.5, yearsLeft: 2, label: '五輪特需', kind: 'boom' },
    ]);
    expect(fx).toContainEqual({ t: 'city_mod', cityId: 'tokyo', mult: 1.5, years: 2, label: '五輪特需', kind: 'boom' });
  });

  it('merges repeated applies of the same label and keeps the longer life', () => {
    const state = fresh();
    const fx: Fx[] = [];
    const effect: Effect = { op: 'city_mod', city: 'tokyo', mult: 1.2, years: 1, label: '重ね', kind: 'boom' };
    applyEffects(data, state, fx, [effect], 0);
    applyEffects(data, state, fx, [{ ...effect, mult: 1.5, years: 3 }], 0);
    expect(state.cityMods).toHaveLength(1);
    expect(state.cityMods[0].mult).toBeCloseTo(1.8);
    expect(state.cityMods[0].yearsLeft).toBe(3);
  });

  it('resolves destination and here', () => {
    const state = fresh();
    const fx: Fx[] = [];
    state.destination = 'osaka';
    applyEffects(data, state, fx, [{ op: 'city_mod', city: 'destination', mult: 0.8, years: 1, label: '目的地', kind: 'damage' }], 0);
    expect(state.cityMods.map((m) => m.cityId)).toEqual(['osaka']);
    // P0's start city is random; move them onto Tokyo explicitly.
    state.players[0].nodeId = 'c:tokyo';
    applyEffects(data, state, fx, [{ op: 'city_mod', city: 'here', mult: 1.2, years: 1, label: '現在地', kind: 'boom' }], 0);
    expect(state.cityMods.some((m) => m.cityId === 'tokyo')).toBe(true);
  });
});

describe('city target resolution', () => {
  it('here: standing on a city uses it, otherwise the nearest city (ties by id)', () => {
    const state = fresh();
    state.players[0].nodeId = 'c:tokyo';
    expect(peekCityTarget(data, state, 'here', 0)).toBe('tokyo');
    // Ring order: c:tokyo, s:0-0, s:0-1, s:0-2, c:osaka. From s:0-1 both are 2 steps away.
    state.players[0].nodeId = 's:0-1';
    expect(peekCityTarget(data, state, 'here', 0)).toBe('osaka');
  });

  it('self_best / richest_best pick the city where the player owns most properties', () => {
    const state = fresh();
    setOwner(state, 'tokyo-tower', 0);
    setOwner(state, 'tokyo-bank', 0);
    setOwner(state, 'osaka-dotonbori', 1);
    setOwner(state, 'osaka-factory', 1);
    setOwner(state, 'newyork-tower', 1);
    state.players[0].cash = 10;
    state.players[1].cash = 900;
    expect(peekCityTarget(data, state, 'self_best', 0)).toBe('tokyo');
    expect(peekCityTarget(data, state, 'richest_best', 0)).toBe('osaka');
  });

  it('random is deterministic per rng and never uses a realm city', () => {
    const state = fresh();
    state.rng = 12345;
    const first = resolveCityTarget(data, state, 'random', 0);
    state.rng = 12345;
    const again = resolveCityTarget(data, state, 'random', 0);
    expect(first).toBe(again);
    const city = data.cities.find((c) => c.id === first);
    expect(city?.realm).toBeUndefined();
    expect(peekCityTarget(data, state, 'random', 0)).toBeNull();
  });

  it('unknown literal ids resolve to nobody', () => {
    const state = fresh();
    expect(peekCityTarget(data, state, 'nowhere', 0)).toBeNull();
  });
});

describe("who: 'target'", () => {
  it('resolves to the passed targetId only', () => {
    const state = fresh();
    expect(resolveTargets(data, state, 'target', 0, 2)).toEqual([2]);
    expect(resolveTargets(data, state, 'target', 0)).toEqual([]);
    expect(resolveTargets(data, state, 'target', 0, 99)).toEqual([]);
  });

  it('applies effects to the chosen player and nobody when missing', () => {
    const state = fresh();
    const before = state.players.map((p) => p.cash);
    const fx: Fx[] = [];
    applyEffects(data, state, fx, [{ op: 'cash', who: 'target', amount: -10, scale: false }], 0, 1);
    applyEffects(data, state, fx, [{ op: 'cash', who: 'target', amount: -10, scale: false }], 0);
    expect(state.players[0].cash).toBe(before[0]);
    expect(state.players[1].cash).toBe(before[1] - 10);
  });
});

describe('finalYear events', () => {
  const base = () => data.events[0];
  function finalYearClone(): GameData {
    const clone = structuredClone(data);
    clone.events = [
      { ...base(), id: 'ev-normal', finalYear: undefined, monthly: false, weight: 1 },
      { ...base(), id: 'ev-final', finalYear: true, monthly: false, weight: 1 },
      { ...base(), id: 'ev-monthly-final', finalYear: true, monthly: true, months: [4, 5], weight: 1 },
    ];
    return clone;
  }

  it('never draws final-year events outside the final year', () => {
    const clone = finalYearClone();
    const state = fresh(3);
    state.year = 1;
    state.month = 4;
    for (let seed = 1; seed <= 60; seed += 1) {
      state.rng = seed;
      expect(pickEvent(clone, state)?.id).toBe('ev-normal');
    }
  });

  it('boosts final-year event weight in the final year', () => {
    const clone = finalYearClone();
    const state = fresh(3);
    state.year = 3;
    state.month = 4;
    let finalHits = 0;
    const runs = 600;
    for (let seed = 1; seed <= runs; seed += 1) {
      state.rng = seed;
      if (pickEvent(clone, state)?.id === 'ev-final') finalHits += 1;
    }
    const expected = FINAL_YEAR_WEIGHT_BOOST / (FINAL_YEAR_WEIGHT_BOOST + 1);
    expect(finalHits / runs).toBeGreaterThan(expected - 0.12);
    expect(finalHits / runs).toBeLessThan(expected + 0.12);
  });

  it('applies the finalYear filter to monthly events too', () => {
    const clone = finalYearClone();
    const state = fresh(3);
    state.year = 1;
    state.month = 4;
    expect(pickMonthlyEvent(clone, state)?.id).not.toBe('ev-monthly-final');
    state.year = 3;
    state.month = 4;
    expect(pickMonthlyEvent(clone, state)?.id).toBe('ev-monthly-final');
  });

  it('treats the last three months of a one-year game as the final year', () => {
    const clone = finalYearClone();
    const state = fresh(1);
    state.year = 1;
    state.month = 4;
    expect(state.config.years).toBe(1);
    for (let seed = 1; seed <= 30; seed += 1) {
      state.rng = seed;
      expect(pickEvent(clone, state)?.id).toBe('ev-normal');
    }
    state.month = 1;
    let finalHits = 0;
    for (let seed = 1; seed <= 60; seed += 1) {
      state.rng = seed;
      if (pickEvent(clone, state)?.id === 'ev-final') finalHits += 1;
    }
    expect(finalHits).toBeGreaterThan(0);
  });
});

describe('event repetition', () => {
  function repeatClone(): GameData {
    const clone = structuredClone(data);
    const base = data.events[0];
    clone.events = ['ev-a', 'ev-b', 'ev-c'].map((id) => ({
      ...base,
      id,
      monthly: false,
      finalYear: undefined,
      months: undefined,
      weight: 1,
    }));
    return clone;
  }

  it('skips events drawn in the last 12 draws', () => {
    const clone = repeatClone();
    const state = fresh(3);
    state.month = 4;
    state.recentEvents = ['ev-a', 'ev-b'];
    for (let seed = 1; seed <= 80; seed += 1) {
      state.rng = seed;
      expect(pickEvent(clone, state)?.id).toBe('ev-c');
    }
  });

  it('falls back to the full pool when every candidate is recent', () => {
    const clone = repeatClone();
    const state = fresh(3);
    state.month = 4;
    state.recentEvents = ['ev-a', 'ev-b', 'ev-c'];
    const seen = new Set<string>();
    for (let seed = 1; seed <= 80; seed += 1) {
      state.rng = seed;
      const picked = pickEvent(clone, state);
      expect(picked).not.toBeNull();
      if (picked) seen.add(picked.id);
    }
    expect(seen.size).toBeGreaterThan(0);
  });

  it('only looks at the last 12 draws', () => {
    const clone = repeatClone();
    const state = fresh(3);
    state.month = 4;
    // All three were drawn long ago, then 12 others → the 12-deep window forgets them.
    state.recentEvents = ['ev-a', 'ev-b', 'ev-c', ...Array(12).fill('ev-x')];
    const seen = new Set<string>();
    for (let seed = 1; seed <= 200; seed += 1) {
      state.rng = seed;
      const picked = pickEvent(clone, state);
      if (picked) seen.add(picked.id);
    }
    expect([...seen].sort()).toEqual(['ev-a', 'ev-b', 'ev-c']);
  });

  it('records every draw in recentEvents', () => {
    const state = fresh(3);
    markEventUsed(state, data.events[0]);
    markEventUsed(state, data.events[1]);
    markEventUsed(state, data.events[1]);
    expect(state.recentEvents).toEqual([data.events[0].id, data.events[1].id, data.events[1].id]);
  });

  it('boosts unseen events in the final month', () => {
    const clone = structuredClone(data);
    const base = data.events[0];
    clone.events = ['ev-new', 'ev-old'].map((id) => ({
      ...base,
      id,
      monthly: false,
      finalYear: undefined,
      months: undefined,
      weight: 1,
    }));
    const state = fresh(3);
    state.year = 3;
    state.month = 3;
    // ev-old is known but outside the 12-deep recency window, so it is eligible without the fresh bonus.
    state.recentEvents = ['ev-old', ...Array(12).fill('ev-x')];
    let newHits = 0;
    const runs = 400;
    for (let seed = 1; seed <= runs; seed += 1) {
      state.rng = seed;
      if (pickEvent(clone, state)?.id === 'ev-new') newHits += 1;
    }
    // ev-new is ×2, ev-old ×1 → 2/3 of the draws.
    const share = newHits / runs;
    expect(share).toBeGreaterThan(0.55);
    expect(share).toBeLessThan(0.78);
  });
});

describe('event data sync', () => {
  it('every city_mod effect is described verbatim in its choice detail', () => {
    const walk = (effects: Effect[] | undefined, visit: (e: Effect) => void): void => {
      for (const effect of effects ?? []) {
        visit(effect);
        if (effect.op === 'gamble') {
          walk(effect.win, visit);
          walk(effect.lose, visit);
        }
      }
    };
    let checked = 0;
    for (const event of GAME_DATA.events) {
      for (const choice of event.choices ?? []) {
        walk(choice.effects, (effect) => {
          if (effect.op !== 'city_mod') return;
          checked += 1;
          expect(choice.detail, `${event.id} / ${choice.label}`).toContain(describeEffect(effect));
        });
      }
    }
    expect(checked).toBeGreaterThanOrEqual(20);
  });

  it('final-year events use leader or last-place targets', () => {
    const finalEvents = GAME_DATA.events.filter((e) => e.finalYear);
    expect(finalEvents.length).toBeGreaterThanOrEqual(8);
    for (const event of finalEvents) {
      expect(event.monthly).not.toBe(true);
      const text = JSON.stringify({ effects: event.effects, choices: event.choices });
      expect(text).toMatch(/richest|poorest/);
    }
  });
});