// 目的地直前へのワープ禁止 (2026-11-26) のルールテスト。
//
// 飛行機・ロケット・出口・「目的地の近くへ」系の効果は、目的地まで WARP_MIN_DEST_STEPS 未満
// になる都市へ着地できない。最後の数マスは盤上で競わせる。

import { describe, expect, it } from 'vitest';
import type { GameConfig, GameState } from './types';
import { fixtureData } from './test-fixture';
import { cpuDecide, createGame, distance, EngineError, step } from './engine';
import { applyEffects } from './events';
import {
  WARP_MIN_DEST_STEPS,
  filterWarpTargets,
  isWarpLandingAllowed,
  stepsAfterWarp,
} from './warpRules';

const data = fixtureData;

function config(levels: Array<1 | 2 | 3> = [1, 1, 1]): GameConfig {
  return {
    years: 3,
    seed: 1,
    players: levels.map((cpuLevel, i) => ({
      name: `P${i}`,
      characterId: ['momotaro', 'sinbad', 'alice', 'red_hood'][i],
      isCpu: true,
      cpuLevel,
    })),
  };
}

function fresh(levels: Array<1 | 2 | 3> = [1, 1, 1]): GameState {
  const state = createGame(data, config(levels)).state;
  state.phase = { t: 'turn_start' };
  state.pendingTurnStart = false;
  return state;
}

function targetOptions(state: GameState, cardId: string): string[] {
  state.players[0].cards = [cardId];
  const used = step(data, state, 0, { t: 'use_card', cardId });
  if (used.state.phase.t !== 'card_target') throw new Error('expected card_target');
  return used.state.phase.options;
}

describe('ワープ着地の目的地リング', () => {
  it('目的地そのものと残り3マス以内の都市には着地できない', () => {
    const state = fresh();
    state.destination = 'rio';
    const destNode = 'c:rio';
    for (const city of data.cities) {
      const node = `c:${city.id}`;
      const d = distance(data, node, destNode);
      expect(isWarpLandingAllowed(data, state, node)).toBe(d >= WARP_MIN_DEST_STEPS);
    }
    expect(isWarpLandingAllowed(data, state, destNode)).toBe(false);
    expect(stepsAfterWarp(data, state, destNode)).toBe(0);
  });

  it('飛行機の候補は目的地の近くを外し、空港の全滅はしない', () => {
    const state = fresh();
    state.destination = 'rio';
    const options = targetOptions(state, 'pegasus');
    expect(options.length).toBeGreaterThan(0);
    expect(options).not.toContain('c:rio');
    for (const option of options) {
      expect(isWarpLandingAllowed(data, state, option)).toBe(true);
    }
    const airports = data.cities
      .filter((c) => c.realm === undefined && c.airport)
      .map((c) => `c:${c.id}`);
    for (const airport of airports) {
      if (options.includes(airport)) continue;
      expect(isWarpLandingAllowed(data, state, airport)).toBe(false);
    }
  });

  it('ロケットの候補も同じリングを守り、宇宙だけは残る', () => {
    const state = fresh();
    state.destination = 'rio';
    const options = targetOptions(state, 'rocket');
    expect(options).toContain('r:space');
    expect(options).not.toContain('c:rio');
    for (const option of options) {
      if (option === 'r:space') continue;
      expect(isWarpLandingAllowed(data, state, option)).toBe(true);
    }
    const world = data.cities.filter((c) => c.realm === undefined).map((c) => `c:${c.id}`);
    expect(options.filter((o) => o !== 'r:space')).toEqual(
      filterWarpTargets(data, state, world).sort(),
    );
  });

  it('候補外の都市を直接指定すると拒否される', () => {
    const state = fresh();
    state.destination = 'rio';
    state.players[0].cards = ['pegasus'];
    const used = step(data, state, 0, { t: 'use_card', cardId: 'pegasus' });
    expect(() => step(data, used.state, 0, { t: 'card_target', target: 'c:rio' })).toThrow(
      EngineError,
    );
  });

  it('CPU は候補の中で目的地にいちばん近い都市を選ぶ（残り4マス以上）', () => {
    const state = fresh([1, 3, 1]);
    state.destination = 'rio';
    state.players[0].cards = ['rocket'];
    const used = step(data, state, 0, { t: 'use_card', cardId: 'rocket' });
    const action = cpuDecide(data, used.state);
    expect(action.t).toBe('card_target');
    if (action.t !== 'card_target') return;
    expect(isWarpLandingAllowed(data, state, action.target)).toBe(true);
    const chosenSteps = distance(data, action.target, 'c:rio');
    const best = Math.min(
      ...filterWarpTargets(
        data,
        state,
        data.cities.filter((c) => c.realm === undefined).map((c) => `c:${c.id}`),
      ).map((node) => distance(data, node, 'c:rio')),
    );
    expect(chosenSteps).toBe(best);
  });

  it('「目的地の近くへ」のイベント効果もリングの外へ着地する', () => {
    const state = fresh();
    state.destination = 'rio';
    state.players[0].nodeId = 'c:tokyo';
    const fx: Parameters<typeof applyEffects>[2] = [];
    applyEffects(data, state, fx, [{ op: 'move', who: 'self', to: 'destination_near' }], 0);
    const landed = state.players[0].nodeId;
    expect(distance(data, landed, 'c:rio')).toBeGreaterThanOrEqual(WARP_MIN_DEST_STEPS);
    expect(fx.some((f) => f.t === 'warp' && f.via === 'event')).toBe(true);
  });
});