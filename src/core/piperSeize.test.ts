// 取り立て屋 Lv1 / Lv2 の物件没収上限と示談 (2026-11-26 Sol プレイテスト対応) のテスト。
//
// Sol は 160 億の物件を一撃で失い、純資産が 466→338 億、独占も消えた。
// 通常形態の没収は純資産の 12%（ブラックは 20%）を上限にし、上限内の物件がなければ現金へ。
// 人間は「物件を差し出す / 示談金を払う」を選べる。

import { describe, expect, it } from 'vitest';
import type { Fx, GameConfig, GameState } from './types';
import { fixtureData } from './test-fixture';
import { createGame, cpuDecide, netWorth, step } from './engine';
import {
  PIPER_CONFISCATE_EVENT,
  PIPER_CONFISCATE_EVENT_ID,
  PIPER_CONFISCATE_NARRATION,
} from './piperLines';
import {
  PIPER_SEIZE_CAP,
  PIPER_SEIZE_DEAL_RATE,
  piperSeizePlan,
} from './piperSeize';
import {
  applyPiperConfiscationDeal,
  piperConfiscateCpuChoice,
  runPiperTurnStart,
} from './piper';
import { currentPrice } from './economy';

const data = fixtureData;

function config(levels: Array<1 | 2 | 3> = [1, 1, 1, 1], seed = 1): GameConfig {
  return {
    years: 3,
    seed,
    players: levels.map((cpuLevel, i) => ({
      name: `P${i}`,
      characterId: ['momotaro', 'sinbad', 'alice', 'red_hood'][i],
      isCpu: true,
      cpuLevel,
    })),
  };
}

function fresh(seed = 1): GameState {
  return createGame(data, config([1, 1, 1, 1], seed)).state;
}

/** 0 番に全物件を均等ではなく 1 件ずつ持たせ、現金も入れる。 */
function giveProperties(state: GameState, step = 3): void {
  let i = 0;
  for (const city of data.cities) {
    for (const property of city.properties) {
      if (i % step === 0) state.owner[property.id] = 0;
      i += 1;
    }
  }
}

const ALL_PROPERTY_IDS: readonly string[] = data.cities.flatMap((city) => city.properties.map((property) => property.id));

describe('没収上限', () => {
  it('Lv1 は純資産の 12%・Lv2 は 20% を超える物件を狙わない', () => {
    const state = fresh();
    giveProperties(state);
    state.players[0].cash = 100;
    const worth = netWorth(data, state, 0);
    for (const level of [1, 2] as const) {
      const plan = piperSeizePlan(data, state, state.players[0], level);
      expect(plan.propertyIds.length).toBeGreaterThan(0);
      expect(plan.value).toBeLessThanOrEqual(worth * PIPER_SEIZE_CAP[level] + 1e-9);
      for (const id of plan.propertyIds) {
        expect(state.owner[id]).toBe(0);
        expect(currentPrice(data, state, id)).toBeLessThanOrEqual(worth * PIPER_SEIZE_CAP[level]);
      }
      expect(plan.dealCost).toBeCloseTo(plan.value * PIPER_SEIZE_DEAL_RATE, 6);
    }
  });

  it('高額物件しか持っていなければ狙わない（160 億の被害を再現しない）', () => {
    const state = fresh();
    // 純資産 180 億（現金 100 + 80 億の物件 1 件）で、12% = 21.6 億。80 億の物件は対象外。
    const priceyId = 'tokyo-tower';
    state.owner[priceyId] = 0;
    state.players[0].cash = 0;
    for (const id of ALL_PROPERTY_IDS) if (id !== priceyId) delete state.owner[id];
    const price = currentPrice(data, state, priceyId);
    const worth = netWorth(data, state, 0);
    expect(worth).toBeCloseTo(price, 6);
    const plan = piperSeizePlan(data, state, state.players[0], 1);
    expect(plan.propertyIds).not.toContain(priceyId);
    // 純資産 = 物件価格そのものなので、12% を超える 1 件は必ず対象外になる。
    expect(price).toBeGreaterThan(worth * PIPER_SEIZE_CAP[1]);
  });

  it('対象がなければ空の計画を返し、呼び出し側が現金の取り立てに切り替える', () => {
    const state = fresh();
    state.owner['tokyo-tower'] = 0;
    state.players[0].cash = 0;
    const plan = piperSeizePlan(data, state, state.players[0], 1);
    expect(plan.propertyIds).toEqual([]);
    expect(plan.dealCost).toBe(0);
  });

  it('Lv2 は上限内で 2 件まで', () => {
    const state = fresh();
    state.players[0].cash = 5000;
    giveProperties(state, 1);
    const plan = piperSeizePlan(data, state, state.players[0], 2);
    expect(plan.propertyIds.length).toBeLessThanOrEqual(2);
  });

  it('実フローでも Lv1 の没収・示談の被害は純資産の 12% 以内', () => {
    let checked = 0;
    for (let seed = 1; seed <= 4000 && checked < 3; seed += 1) {
      const state = createGame(data, config([1, 1, 1, 1], seed)).state;
      state.players[0].cash = 100;
      giveProperties(state);
      state.current = 0;
      state.piper = { holder: 0, level: 1, heldTurns: 0 };
      state.rng = seed;
      const worth = netWorth(data, state, 0);
      const fx: Fx[] = [];
      runPiperTurnStart(data, state, fx);
      const confiscation = fx.some(
        (f) =>
          f.t === 'toast' &&
          (f.text.includes('二束三文で没収した') || f.text.includes('払って物件を守った')),
      );
      if (!confiscation) continue;
      // 差し出しは「額面 − 手取り」、示談は支払額。どちらも reason '取り立て' で記録される。
      const damage = fx.reduce(
        (sum, f) => sum + (f.t === 'cash' && f.reason === '取り立て' ? Math.abs(f.delta) : 0),
        0,
      );
      expect(damage).toBeGreaterThan(0);
      expect(damage).toBeLessThanOrEqual(worth * PIPER_SEIZE_CAP[1] + 1e-6);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe('没収の示談（人間）', () => {
  /** 没収のいたずら（kind 1）を引いて event フェーズになるまで seed を回す。 */
  function confiscationState(): GameState | null {
    for (let seed = 1; seed <= 4000; seed += 1) {
      const state = createGame(data, config([1, 1, 1, 1], seed)).state;
      state.players[0].isCpu = false;
      state.players[0].cash = 120;
      giveProperties(state);
      state.current = 0;
      state.piper = { holder: 0, level: 1, heldTurns: 0 };
      state.rng = seed;
      const fx: Fx[] = [];
      runPiperTurnStart(data, state, fx);
      if (state.phase.t === 'event' && state.phase.eventId === PIPER_CONFISCATE_EVENT_ID) {
        return state;
      }
    }
    return null;
  }

  it('人間には「差し出す / 示談金」の 2 択を出す（休みではない）', () => {
    const state = confiscationState();
    expect(state).not.toBeNull();
    const deal = state as GameState;
    expect(deal.activeEventId).toBe(PIPER_CONFISCATE_EVENT_ID);
    expect(PIPER_CONFISCATE_NARRATION.length).toBeGreaterThan(0);
    const definition = PIPER_CONFISCATE_EVENT;
    expect(definition.choices).toHaveLength(2);
    expect(definition.choices?.[0].label).toContain('物件を差し出す');
    expect(definition.choices?.[1].label).toContain('示談金');
  });

  it('示談金を払うと物件を守り、手番は続く', () => {
    const state = confiscationState();
    expect(state).not.toBeNull();
    const deal = state as GameState;
    const level: 1 | 2 = deal.piper.level === 2 ? 2 : 1;
    const plan = piperSeizePlan(data, deal, deal.players[0], level);
    const cashBefore = deal.players[0].cash;
    const next = step(data, deal, 0, { t: 'choose', index: 1 });
    for (const id of plan.propertyIds) expect(next.state.owner[id]).toBe(0);
    expect(cashBefore - next.state.players[0].cash).toBeCloseTo(plan.dealCost, 6);
    expect(next.state.phase.t).toBe('turn_start');
    expect(next.state.activeEventId).toBeNull();
    expect(next.fx.some((f) => f.t === 'cash' && f.reason === '取り立て')).toBe(true);
  });

  it('物件を差し出すと対象だけを失い、手番は続く', () => {
    const state = confiscationState();
    expect(state).not.toBeNull();
    const deal = state as GameState;
    const level: 1 | 2 = deal.piper.level === 2 ? 2 : 1;
    const plan = piperSeizePlan(data, deal, deal.players[0], level);
    const ownedBefore = ALL_PROPERTY_IDS.filter((id) => deal.owner[id] === 0);
    const next = step(data, deal, 0, { t: 'choose', index: 0 });
    const ownedAfter = ALL_PROPERTY_IDS.filter((id) => next.state.owner[id] === 0);
    expect(ownedAfter).toEqual(ownedBefore.filter((id) => !plan.propertyIds.includes(id)));
    expect(next.state.phase.t).toBe('turn_start');
  });

  it('ホストの代行（cpuDecide）でも示談イベントを解決できる', () => {
    const state = confiscationState();
    expect(state).not.toBeNull();
    const deal = state as GameState;
    const action = cpuDecide(data, deal);
    expect(action.t).toBe('choose');
    const next = step(data, deal, 0, action);
    expect(next.state.phase.t).toBe('turn_start');
    expect(next.state.activeEventId).toBeNull();
  });

  it('直接呼ぶと示談金を払って守る', () => {
    const state = fresh(7);
    giveProperties(state);
    state.current = 0;
    state.players[0].cash = 300;
    state.piper = { holder: 0, level: 1, heldTurns: 0 };
    const plan = piperSeizePlan(data, state, state.players[0], 1);
    const fx: Fx[] = [];
    const outcome = applyPiperConfiscationDeal(data, state, fx, 1);
    expect(outcome).toBe('pay');
    for (const id of plan.propertyIds) expect(state.owner[id]).toBe(0);
  });
});

describe('没収の示談（CPU）', () => {
  it('現金で払えるなら示談し、足りなければ物件を差し出す', () => {
    const state = fresh(3);
    giveProperties(state);
    state.current = 0;
    state.piper = { holder: 0, level: 1, heldTurns: 0 };
    const plan = piperSeizePlan(data, state, state.players[0], 1);
    state.players[0].cash = plan.dealCost + 1;
    expect(piperConfiscateCpuChoice(data, state, state.players[0])).toBe(1);
    state.players[0].cash = 0;
    expect(piperConfiscateCpuChoice(data, state, state.players[0])).toBe(0);
  });

  it('CPU の手番では event を開かず、その場で解決する', () => {
    let resolved = 0;
    for (let seed = 1; seed <= 800 && resolved < 3; seed += 1) {
      const state = createGame(data, config([1, 1, 1, 1], seed)).state;
      state.players[0].cash = 200;
      giveProperties(state);
      state.current = 0;
      state.piper = { holder: 0, level: 1, heldTurns: 0 };
      state.rng = seed;
      const fx: Fx[] = [];
      runPiperTurnStart(data, state, fx);
      expect(state.phase.t).not.toBe('event');
      if (state.phase.t !== 'event') resolved += 1;
    }
    expect(resolved).toBeGreaterThan(0);
  });
});