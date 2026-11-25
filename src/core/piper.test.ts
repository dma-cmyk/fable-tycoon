// 取り立て屋 (fun overhaul 2026-11) の集中的なルールテスト。
//
// 対象: 憑依ルーレットの分布 / 月替わりの変身 / キング災害の被害上限 / 弁護士軍団の半減 /
// 決定性 / 気まぐれな善行 / すれ違いで姿が移動する。

import { describe, expect, it } from 'vitest';
import type { Fx, GameConfig, GameState } from './types';
import { fixtureData } from './test-fixture';
import { createGame, netWorth, step } from './engine';
import {
  KING_DAMAGE_CAP,
  PIPER_ATTACH_LEVEL1,
  PIPER_ATTACH_LEVEL2,
  PIPER_GIFT_CHANCE,
  piperLevelForHeldTurns,
  rollPiperForm,
  runPiperMonthStart,
  runPiperTurnStart,
  transferPiper,
} from './piper';
import {
  PIPER_DEAL_EVENT_ID,
  PIPER_DEAL_NARRATION,
  PIPER_DISASTERS,
  PIPER_GIFTS,
} from './piperLines';
import { piperDealCpuChoice } from './piperCpu';

const data = fixtureData;

function config(levels: Array<1 | 2 | 3>, years = 3, seed = 1): GameConfig {
  const characters = ['momotaro', 'sinbad', 'alice', 'red_hood'];
  return {
    years,
    seed,
    players: levels.map((cpuLevel, i) => ({
      name: `P${i}`,
      characterId: characters[i],
      isCpu: true,
      cpuLevel,
    })),
  };
}

function fresh(levels: Array<1 | 2 | 3> = [1, 1, 1], years = 3, seed = 1): GameState {
  return createGame(data, config(levels, years, seed)).state;
}

/** 物件を全部 0 番に持たせた「王者」を作る（キング被害の上限テスト用）。 */
function makeRich(state: GameState): void {
  state.players[0].cash = 600;
  let i = 0;
  for (const city of data.cities) {
    for (const property of city.properties) {
      if (i % 3 === 0) state.owner[property.id] = 0;
      i += 1;
    }
  }
}

function disasterFx(fx: Fx[]): Extract<Fx, { t: 'piper_disaster' }> | undefined {
  return fx.find((f): f is Extract<Fx, { t: 'piper_disaster' }> => f.t === 'piper_disaster');
}

function giftFx(fx: Fx[]): Extract<Fx, { t: 'piper_gift' }> | undefined {
  return fx.find((f): f is Extract<Fx, { t: 'piper_gift' }> => f.t === 'piper_gift');
}

describe('取り立て屋の変身ルーレット', () => {
  it('憑依時の姿は 72% / 20% / 8% で振り分けられる', () => {
    const state = fresh();
    const counts = [0, 0, 0];
    const runs = 6000;
    for (let seed = 1; seed <= runs; seed += 1) {
      state.rng = seed;
      counts[rollPiperForm(state) - 1] += 1;
    }
    expect(Math.abs(counts[0] / runs - PIPER_ATTACH_LEVEL1)).toBeLessThan(0.02);
    expect(Math.abs(counts[1] / runs - (PIPER_ATTACH_LEVEL2 - PIPER_ATTACH_LEVEL1))).toBeLessThan(0.02);
    expect(Math.abs(counts[2] / runs - (1 - PIPER_ATTACH_LEVEL2))).toBeLessThan(0.02);
  });

  it('月替わりに Lv1→2 は約 15%、Lv2→3 は約 10%、キングは約 20% で退散/縮小する', () => {
    const runs = 4000;
    let up12 = 0;
    let up23 = 0;
    let kingChanged = 0;
    for (let seed = 1; seed <= runs; seed += 1) {
      const state = fresh();
      state.piper = { holder: 0, level: 1, heldTurns: 0 };
      state.rng = seed;
      runPiperMonthStart(state, []);
      if (state.piper.level === 2) up12 += 1;

      state.piper = { holder: 0, level: 2, heldTurns: 0 };
      state.rng = seed;
      runPiperMonthStart(state, []);
      if (state.piper.level === 3) up23 += 1;

      state.piper = { holder: 0, level: 3, heldTurns: 0 };
      state.rng = seed;
      runPiperMonthStart(state, []);
      if (state.piper.holder === null || state.piper.level < 3) kingChanged += 1;
    }
    expect(Math.abs(up12 / runs - 0.15)).toBeLessThan(0.025);
    expect(Math.abs(up23 / runs - 0.1)).toBeLessThan(0.025);
    expect(Math.abs(kingChanged / runs - 0.2)).toBeLessThan(0.03);
  });

  it('憑かれた手番数 8 / 16 で強制エスカレーションする', () => {
    expect(piperLevelForHeldTurns(7)).toBe(1);
    expect(piperLevelForHeldTurns(8)).toBe(2);
    expect(piperLevelForHeldTurns(15)).toBe(2);
    expect(piperLevelForHeldTurns(16)).toBe(3);

    const state = fresh([1, 1, 1], 3, 5);
    state.current = 0;
    state.piper = { holder: 0, level: 1, heldTurns: 15 };
    const fx: Fx[] = [];
    runPiperTurnStart(data, state, fx);
    expect(state.piper.level).toBe(3);
    expect(fx.some((f) => f.t === 'piper_roulette' && f.to === 3)).toBe(true);
  });

  it('すれ違いでは姿がそのまま移動し、新規憑依ではルーレットを振り直す', () => {
    const state = fresh();
    state.piper = { holder: 0, level: 3, heldTurns: 4 };
    const fx: Fx[] = [];
    transferPiper(state, fx, 1, '押し付けた', { keepForm: true });
    expect(state.piper).toMatchObject({ holder: 1, level: 3, heldTurns: 0 });
    expect(fx.some((f) => f.t === 'piper_roulette')).toBe(false);

    const forms = new Set<number>();
    for (let seed = 1; seed <= 200; seed += 1) {
      const freshState = fresh();
      freshState.rng = seed;
      const freshFx: Fx[] = [];
      transferPiper(freshState, freshFx, 1, '憑いた');
      forms.add(freshState.piper.level);
      expect(freshFx.some((f) => f.t === 'piper_roulette' && f.to === freshState.piper.level)).toBe(true);
    }
    expect([...forms].sort()).toEqual([1, 2, 3]);
  });
});

describe('キングの災害', () => {
  it('1 回の災害は純資産の 35% を超えない', () => {
    let disasters = 0;
    let maxRatio = 0;
    for (let seed = 1; seed <= 240; seed += 1) {
      const state = fresh([1, 1, 1, 1], 3, seed);
      makeRich(state);
      state.current = 0;
      state.piper = { holder: 0, level: 2, heldTurns: 15 };
      state.rng = seed;
      const before = netWorth(data, state, 0);
      const fx: Fx[] = [];
      runPiperTurnStart(data, state, fx);
      expect(state.piper.level).toBe(3);
      const disaster = disasterFx(fx);
      if (!disaster) continue;
      disasters += 1;
      const ratio = before > 0 ? disaster.amount / before : 0;
      maxRatio = Math.max(maxRatio, ratio);
      expect(disaster.amount).toBeGreaterThanOrEqual(0);
      expect(disaster.title.length).toBeGreaterThan(1);
      expect(ratio).toBeLessThanOrEqual(KING_DAMAGE_CAP + 1e-6);
    }
    expect(disasters).toBeGreaterThan(100);
    expect(maxRatio).toBeGreaterThan(0.05);
  });

  it('災害は 5〜7 種類あり、すべて風刺タイトルを持つ', () => {
    expect(PIPER_DISASTERS.length).toBeGreaterThanOrEqual(5);
    expect(PIPER_DISASTERS.length).toBeLessThanOrEqual(7);
    for (const disaster of PIPER_DISASTERS) {
      expect(disaster.title.length).toBeGreaterThan(2);
      expect(disaster.narration.length).toBeGreaterThan(2);
    }
  });

  it('弁護士軍団はキング被害を半減させる（無効化はしない）', () => {
    let compared = 0;
    for (let seed = 1; seed <= 240; seed += 1) {
      const run = (shielded: boolean): { amount: number; kind: string } => {
        const state = fresh([1, 1, 1, 1], 3, seed);
        makeRich(state);
        state.current = 0;
        state.piper = { holder: 0, level: 2, heldTurns: 15 };
        state.rng = seed;
        if (shielded) state.players[0].cards = ['shield'];
        const fx: Fx[] = [];
        runPiperTurnStart(data, state, fx);
        const disaster = disasterFx(fx);
        return { amount: disaster?.amount ?? 0, kind: disaster?.kind ?? '' };
      };
      const plain = run(false);
      const shielded = run(true);
      // 護符は乱数列を消費しない。地獄送りだけは護符で完全に防ぐので種類が変わる。
      if (plain.kind === 'hell_ride') continue;
      expect(shielded.kind).toBe(plain.kind);
      if (plain.amount <= 0.5) continue;
      compared += 1;
      expect(shielded.amount).toBeGreaterThan(0);
      expect(shielded.amount).toBeLessThanOrEqual(plain.amount * 0.5 + 1e-6);
    }
    expect(compared).toBeGreaterThan(60);
  });
});

describe('取り立て屋の決定性', () => {
  it('同じ状態と乱数なら同じ結果になる', () => {
    const snapshot = (seed: number): { fx: Fx[]; state: GameState } => {
      const state = fresh([1, 1, 1, 1], 3, seed);
      makeRich(state);
      state.current = 0;
      state.piper = { holder: 0, level: 2, heldTurns: 15 };
      state.rng = seed;
      const fx: Fx[] = [];
      runPiperTurnStart(data, state, fx);
      return { fx, state };
    };
    for (const seed of [3, 17, 99]) {
      const a = snapshot(seed);
      const b = snapshot(seed);
      expect(b.fx).toEqual(a.fx);
      expect(b.state).toEqual(a.state);
    }
  });

  it('200 手番ぶん回しても壊れない（現金が有限・物件 owner が整合）', () => {
    const state = fresh([1, 1, 1, 1], 3, 42);
    const fx: Fx[] = [];
    for (let i = 0; i < 200; i += 1) {
      state.current = i % 4;
      if (state.piper.holder === null) {
        state.piper = { holder: state.current, level: 1, heldTurns: 0 };
      } else if (state.piper.holder !== state.current) {
        state.piper.holder = state.current;
      }
      runPiperTurnStart(data, state, fx);
    }
    for (const player of state.players) {
      expect(Number.isFinite(player.cash)).toBe(true);
    }
    for (const owner of Object.values(state.owner)) {
      expect([0, 1, 2, 3]).toContain(owner);
    }
    expect(fx.length).toBeGreaterThan(50);
  });
});

describe('気まぐれな善行', () => {
  it('借金持ちには借金を払ってくれる（約 5% の手番）', () => {
    let gifts = 0;
    const runs = 4000;
    for (let seed = 1; seed <= runs; seed += 1) {
      const state = fresh([1, 1, 1, 1], 3, seed);
      state.current = 0;
      state.players[0].cash = -40;
      state.piper = { holder: 0, level: 1, heldTurns: 0 };
      state.rng = seed;
      const fx: Fx[] = [];
      runPiperTurnStart(data, state, fx);
      const gift = giftFx(fx);
      if (!gift) continue;
      gifts += 1;
      expect(gift.title).toBe(PIPER_GIFTS[0].title);
      expect(state.players[0].cash).toBe(0);
      expect(gift.amount).toBeCloseTo(40);
    }
    expect(Math.abs(gifts / runs - PIPER_GIFT_CHANCE)).toBeLessThan(0.025);
    expect(gifts).toBeGreaterThan(80);
  });

  it('物件が買える場所なら勝手に物件を買ってくれる', () => {
    let bought = 0;
    for (let seed = 1; seed <= 800; seed += 1) {
      const state = fresh([1, 1, 1, 1], 3, seed);
      state.current = 0;
      state.players[0].nodeId = 'c:tokyo';
      state.players[0].cash = 30;
      state.piper = { holder: 0, level: 1, heldTurns: 0 };
      state.rng = seed;
      const fx: Fx[] = [];
      runPiperTurnStart(data, state, fx);
      const gift = giftFx(fx);
      if (!gift || gift.title !== PIPER_GIFTS[1].title) continue;
      bought += 1;
      const owned = Object.entries(state.owner).filter(([, id]) => id === 0).map(([id]) => id);
      expect(owned.length).toBe(1);
      expect(fx.some((f) => f.t === 'buy' && f.playerId === 0)).toBe(true);
      expect(gift.amount).toBeGreaterThan(0);
    }
    expect(bought).toBeGreaterThan(5);
  });
});
describe('「1回休み」の示談（人間の手番）', () => {
  /** 1回休みのいたずらを引くまで seed を回し、その状態を返す。 */
  function skipMischiefState(): GameState | null {
    for (let seed = 1; seed <= 500; seed += 1) {
      const state = fresh([1, 1, 1, 1], 3, seed);
      state.players[0].isCpu = false;
      state.players[0].cash = 400;
      state.current = 0;
      state.piper = { holder: 0, level: 1, heldTurns: 0 };
      state.rng = seed;
      const fx: Fx[] = [];
      runPiperTurnStart(data, state, fx);
      if (state.phase.t === 'event') return state;
    }
    return null;
  }

  it('休むか示談かの 2 択を既存の event フェーズで出す', () => {
    const state = skipMischiefState();
    expect(state).not.toBeNull();
    const deal = state as GameState;
    expect(deal.phase.t).toBe('event');
    if (deal.phase.t !== 'event') return;
    expect(deal.phase.eventId).toBe(PIPER_DEAL_EVENT_ID);
    expect(PIPER_DEAL_NARRATION.length).toBeGreaterThan(0);
  });

  it('「休む」を選ぶとその手番を失う', () => {
    const state = skipMischiefState();
    expect(state).not.toBeNull();
    const deal = state as GameState;
    const next = step(data, deal, 0, { t: 'choose', index: 0 });
    expect(next.state.current).toBe(1);
    expect(next.state.phase.t).toBe('turn_start');
    expect(next.state.players[0].skipTurns).toBe(0);
    expect(next.fx.some((f) => f.t === 'skip' && f.playerId === 0)).toBe(true);
  });

  it('「示談金」を選ぶと純資産の約5%を払って手番を続けられる', () => {
    const state = skipMischiefState();
    expect(state).not.toBeNull();
    const deal = state as GameState;
    const worth = netWorth(data, deal, 0);
    const cashBefore = deal.players[0].cash;
    const next = step(data, deal, 0, { t: 'choose', index: 1 });
    expect(next.state.phase.t).toBe('turn_start');
    expect(next.state.current).toBe(0);
    const paid = cashBefore - next.state.players[0].cash;
    expect(paid).toBeCloseTo(worth * 0.05, 5);
    expect(next.fx.some((f) => f.t === 'cash' && f.reason === '示談金')).toBe(true);
  });

  it('CPU は現金で払えるなら示談金を払い、手持ちが足りなければ休む', () => {
    const state = fresh([1, 1, 1, 1], 3, 3);
    state.current = 0;
    state.piper = { holder: 0, level: 1, heldTurns: 0 };
    state.players[0].cash = 400;
    expect(piperDealCpuChoice(data, state, state.players[0])).toBe(1);
    // 現金 0 + 物件で純資産がある場合: 示談金 5% すら現金で払えないので休む。
    state.players[0].cash = 0;
    state.owner['tokyo-tower'] = 0;
    expect(netWorth(data, state, 0)).toBeGreaterThan(0);
    expect(piperDealCpuChoice(data, state, state.players[0])).toBe(0);
    // ブラックは 10%。現金が足りるなら払う。
    state.piper.level = 2;
    state.players[0].cash = 100;
    expect(piperDealCpuChoice(data, state, state.players[0])).toBe(1);
  });

  it('CPU の手番では示談を出さず、そのまま 1 回休みになる', () => {
    let skips = 0;
    for (let seed = 1; seed <= 500 && skips < 3; seed += 1) {
      const state = fresh([1, 1, 1, 1], 3, seed);
      state.current = 0;
      state.piper = { holder: 0, level: 1, heldTurns: 0 };
      state.rng = seed;
      const fx: Fx[] = [];
      const outcome = runPiperTurnStart(data, state, fx);
      if (fx.some((f) => f.t === 'event_open')) {
        throw new Error('CPU に示談イベントが出た');
      }
      if (outcome === 'skip') skips += 1;
    }
    expect(skips).toBeGreaterThan(0);
  });
});
