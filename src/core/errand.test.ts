// 寄り道依頼（fun overhaul 第2弾）のテスト。
//
// 対象: 置き場所の制約 / 止まったときだけ達成 / 達成と期限切れの引き直し / 報酬式 /
// 決定性 / CPU の進路選択。フィクスチャ盤面は 12 都市の環状線なので距離が読みやすい。

import { describe, expect, it } from 'vitest';
import type { Fx, GameState, MoveOption } from './types';
import { createGame, cpuDecide, step } from './engine';
import { nodeForCity } from './graph';
import { effectiveDistance } from './realm';
import { fixtureData } from './test-fixture';
import {
  ERRAND_MAX_ROUNDS,
  ERRAND_SHARE_MAX,
  ERRAND_SHARE_MIN,
  ERRAND_TITLES,
  claimErrand,
  drawErrand,
  errandBonus,
  errandMoveBias,
  maybeRedrawErrand,
} from './errand';
import { ERRAND_NARRATION, errandNarration } from '../audio/narration';
import { GAME_DATA } from '../data/index';

const PLAYERS = [
  { name: 'P0', characterId: 'momotaro', isCpu: true, cpuLevel: 3 as const },
  { name: 'P1', characterId: 'sinbad', isCpu: true, cpuLevel: 3 as const },
];

function newGame(seed = 7): GameState {
  return createGame(fixtureData, { years: 3, seed, players: PLAYERS }).state;
}

describe('errand placement', () => {
  it('puts the errand on a world city 6–14 steps from at least two players', () => {
    for (let seed = 1; seed <= 20; seed += 1) {
      const state = newGame(seed);
      const errand = state.errand;
      expect(errand, `seed ${seed}`).toBeTruthy();
      if (!errand) continue;
      const city = fixtureData.cities.find((c) => c.id === errand.cityId);
      expect(city).toBeTruthy();
      expect(city?.realm).toBeUndefined();
      expect(errand.cityId).not.toBe(state.destination);
      const nodeId = nodeForCity(fixtureData, errand.cityId);
      expect(nodeId).not.toBeNull();
      const distances = state.players.map((p) => effectiveDistance(fixtureData, p.nodeId, nodeId as string));
      const inRange = distances.filter((d) => d >= 6 && d <= 14);
      expect(inRange.length).toBeGreaterThanOrEqual(2);
      expect(errand.drawnRound).toBe(0);
      expect(errand.bonus).toBeGreaterThan(0);
      expect(errand.requester).toBeTruthy();
      expect(errand.title).toBe(ERRAND_TITLES[errand.requester] ?? errand.title);
    }
  });

  it('does not re-use the current errand city and never the destination', () => {
    const state = newGame(11);
    const first = state.errand;
    expect(first).toBeTruthy();
    drawErrand(fixtureData, state, []);
    expect(state.errand).toBeTruthy();
    expect(state.errand?.cityId).not.toBe(first?.cityId);
    expect(state.errand?.cityId).not.toBe(state.destination);
  });

  it('offers no errand in a one-player game', () => {
    const state = createGame(fixtureData, {
      years: 3,
      seed: 3,
      players: [{ name: 'Solo', characterId: 'alice', isCpu: true, cpuLevel: 3 }],
    }).state;
    expect(state.errand ?? null).toBeNull();
  });
});

describe('errand claim', () => {
  function claimSetup(): { state: GameState; bonus: number } {
    const state = newGame(5);
    state.destination = 'mumbai';
    state.current = 0;
    state.phase = { t: 'choose_dest', roll: 1, options: [] };
    state.players[0].nodeId = 's:0-1';
    state.players[0].prevNodeId = 'c:tokyo';
    state.players[1].nodeId = 's:5-0';
    const bonus = 40;
    state.errand = {
      cityId: 'osaka',
      bonus,
      requester: 'red_hood',
      title: '赤ずきんのお使い：ワインを届けて',
      drawnRound: state.round,
    };
    return { state, bonus };
  }

  it('does not pay when the player only passes through the errand city', () => {
    const { state } = claimSetup();
    const cash = state.players[0].cash;
    const options: MoveOption[] = [
      // osaka を通過して singapore に止まる（通過は無効）。
      { nodeId: 'c:singapore', path: ['c:osaka', 's:1-0', 's:1-1', 'c:singapore'] },
    ];
    state.phase = { t: 'choose_dest', roll: 4, options };
    const result = step(fixtureData, state, 0, { t: 'move', nodeId: 'c:singapore' });
    expect(result.state.players[0].cash).toBe(cash);
    expect(result.fx.some((fx) => fx.t === 'errand_done')).toBe(false);
    expect(result.state.errand?.cityId).toBe('osaka');
  });

  it('pays the bonus and draws the next errand when the player stops there', () => {
    const { state, bonus } = claimSetup();
    const cash = state.players[0].cash;
    state.phase = {
      t: 'choose_dest',
      roll: 1,
      options: [{ nodeId: 'c:osaka', path: ['c:osaka'] }],
    };
    const result = step(fixtureData, state, 0, { t: 'move', nodeId: 'c:osaka' });
    expect(result.state.players[0].cash).toBe(cash + bonus);
    const done = result.fx.find((fx) => fx.t === 'errand_done');
    expect(done).toMatchObject({ t: 'errand_done', playerId: 0, cityId: 'osaka', bonus });
    // 購入フェーズには入る（依頼達成で手番は終わらない）。
    expect(result.state.phase.t).toBe('buy');
    // 次の依頼は別の都市で、今のラウンドに引かれている。
    expect(result.state.errand).toBeTruthy();
    expect(result.state.errand?.cityId).not.toBe('osaka');
    expect(result.state.errand?.drawnRound).toBe(result.state.round);
    // 取り立て屋は動かない。
    expect(result.state.piper.holder).toBe(state.piper.holder);
  });

  it('claimErrand ignores a non-errand city', () => {
    const { state } = claimSetup();
    const cash = state.players[0].cash;
    state.players[0].nodeId = 'c:kyoto';
    const fx: Fx[] = [];
    expect(claimErrand(fixtureData, state, fx, state.players[0])).toBe(false);
    expect(state.players[0].cash).toBe(cash);
  });
});

describe('errand redraw', () => {
  it('redraws an errand nobody claimed after 8 rounds', () => {
    const state = newGame(13);
    const first = state.errand;
    expect(first).toBeTruthy();
    state.round = (first?.drawnRound ?? 0) + ERRAND_MAX_ROUNDS;
    const fx: Fx[] = [];
    maybeRedrawErrand(fixtureData, state, fx);
    expect(state.errand?.drawnRound).toBe(state.round);
    expect(state.errand?.cityId).not.toBe(first?.cityId);
    expect(fx.some((item) => item.t === 'toast')).toBe(true);
  });

  it('keeps the errand before the deadline', () => {
    const state = newGame(13);
    const first = state.errand;
    state.round = (first?.drawnRound ?? 0) + ERRAND_MAX_ROUNDS - 1;
    maybeRedrawErrand(fixtureData, state, []);
    expect(state.errand).toEqual(first);
  });

  it('redraws during a real turn advance once the deadline passes', () => {
    const state = newGame(17);
    state.errand = {
      cityId: state.errand?.cityId ?? 'osaka',
      bonus: 20,
      requester: 'red_hood',
      title: '赤ずきんのお使い：ワインを届けて',
      drawnRound: 0,
    };
    state.round = 7;
    state.current = 1;
    state.phase = { t: 'buy', cityId: 'osaka' };
    const endBuy = step(fixtureData, state, 1, { t: 'end_buy' });
    // P0 の手番へ戻り、月が進んで round が 8 になる。
    expect(endBuy.state.round).toBe(8);
    expect(endBuy.fx.some((fx) => fx.t === 'errand')).toBe(true);
    expect(endBuy.state.errand?.drawnRound).toBe(8);
  });
});

describe('errand bonus', () => {
  it('is 35–45% of the destination bonus for the same distance', () => {
    const state = newGame(1);
    expect(errandBonus(state, 10, 0.4)).toBe(20);
    expect(errandBonus(state, 6, ERRAND_SHARE_MIN)).toBe(Math.round((30 + 12) * 0.35));
    expect(errandBonus(state, 14, ERRAND_SHARE_MAX)).toBe(Math.round((30 + 28) * 0.45));

    for (let seed = 1; seed <= 20; seed += 1) {
      const game = newGame(seed);
      const errand = game.errand;
      if (!errand) continue;
      const nodeId = nodeForCity(fixtureData, errand.cityId) as string;
      const minDistance = Math.min(
        ...game.players.map((p) => effectiveDistance(fixtureData, p.nodeId, nodeId)),
      );
      const base = 30 + 2 * minDistance;
      const ratio = errand.bonus / base;
      expect(ratio).toBeGreaterThanOrEqual(ERRAND_SHARE_MIN - 0.02);
      expect(ratio).toBeLessThanOrEqual(ERRAND_SHARE_MAX + 0.02);
    }
  });

  it('doubles in the final year', () => {
    const state = newGame(1);
    const normal = errandBonus(state, 10, 0.4);
    const finalYear: GameState = { ...state, year: 3, month: 6, config: { ...state.config, years: 3 } };
    expect(errandBonus(finalYear, 10, 0.4)).toBe(normal * 2 * 1.7);
  });
});

describe('errand determinism', () => {
  it('draws the same errand from the same state', () => {
    const state = newGame(23);
    const clone = structuredClone(state);
    const fxA: Fx[] = [];
    const fxB: Fx[] = [];
    drawErrand(fixtureData, state, fxA);
    drawErrand(fixtureData, clone, fxB);
    expect(state.errand).toEqual(clone.errand);
    expect(state.rng).toBe(clone.rng);
    expect(fxA).toEqual(fxB);
  });
});

describe('errand CPU', () => {
  function cpuSetup(): { state: GameState; options: MoveOption[] } {
    const state = newGame(31);
    state.current = 0;
    state.destination = 'mumbai';
    state.destinationStartDistance = 20;
    state.players[0].nodeId = 's:0-2';
    state.players[0].prevNodeId = 's:0-1';
    state.players[0].cpuLevel = 3;
    state.players[1].nodeId = 's:5-0';
    state.errand = {
      cityId: 'tokyo',
      bonus: 40,
      requester: 'red_hood',
      title: '赤ずきんのお使い：ワインを届けて',
      drawnRound: 0,
    };
    const options: MoveOption[] = [
      { nodeId: 'c:tokyo', path: ['s:0-1', 'c:tokyo'] },
      { nodeId: 'c:osaka', path: ['s:0-3', 'c:osaka'] },
    ];
    state.phase = { t: 'choose_dest', roll: 2, options };
    return { state, options };
  }

  it('Lv3 detours to claim the errand when the bonus pays for the extra steps', () => {
    const { state, options } = cpuSetup();
    expect(errandMoveBias(fixtureData, state, state.players[0], options[0])).toBeLessThan(0);
    expect(errandMoveBias(fixtureData, state, state.players[0], options[1])).toBe(0);
    expect(cpuDecide(fixtureData, state)).toEqual({ t: 'move', nodeId: 'c:tokyo' });
  });

  it('Lv3 ignores a token errand and heads for the destination', () => {
    const { state } = cpuSetup();
    state.errand = { ...state.errand!, bonus: 1 };
    expect(cpuDecide(fixtureData, state)).toEqual({ t: 'move', nodeId: 'c:osaka' });
  });

  it('Lv1 never detours for the errand', () => {
    const { state } = cpuSetup();
    state.players[0].cpuLevel = 1;
    expect(cpuDecide(fixtureData, state)).toEqual({ t: 'move', nodeId: 'c:osaka' });
  });
});

describe('errand data', () => {
  it('has a title and a voiced narration line for every character', () => {
    for (const character of GAME_DATA.characters) {
      expect(ERRAND_TITLES[character.id], character.id).toBeTruthy();
      const line = errandNarration(character.id);
      expect(line).toBe(ERRAND_NARRATION[character.id]);
      expect([...line].length).toBeLessThan(45);
      expect(/[A-Za-z0-9０-９Ａ-Ｚａ-ｚ]/.test(line)).toBe(false);
      expect(ERRAND_TITLES[character.id]).toContain('：');
    }
  });
});