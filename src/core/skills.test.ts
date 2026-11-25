// 固有技（1 年 1 回）のルール。fixture の 4 キャラで流れを、実データ全 48 人で
// 「どの技も例外なく適用でき、所持金が有限に収まる」ことを確かめる。

import { describe, expect, it } from 'vitest';
import { actorOf, createGame, EngineError, netWorth, step, cpuDecide } from './engine';
import { fixtureData } from './test-fixture';
import { GAME_DATA } from '../data/index';
import { canUseSkill, skillFor } from './skills';
import type { Fx, GameConfig, GameData, GameState } from './types';

function config(characterIds: string[], years = 1, seed = 7): GameConfig {
  return {
    years,
    seed,
    players: characterIds.map((characterId, i) => ({
      name: `P${i}`,
      characterId,
      isCpu: true,
      cpuLevel: 3 as const,
    })),
  };
}

/** 手番開始の局面を作る（月頭イベントのフェーズを避ける）。 */
function freshTurn(data: GameData, characterIds: string[], seed = 7): GameState {
  const state = createGame(data, config(characterIds, 1, seed)).state;
  state.phase = { t: 'turn_start' };
  return state;
}

const skillFx = (fx: Fx[]): Extract<Fx, { t: 'skill' }>[] =>
  fx.filter((f): f is Extract<Fx, { t: 'skill' }> => f.t === 'skill');

describe('固有技: 1 年 1 回', () => {
  it('使うと今年の使用済みになり、同じ年にはもう使えない', () => {
    const state = freshTurn(fixtureData, ['momotaro', 'sinbad', 'alice', 'red_hood']);
    const before = state.players[0].cash;

    const used = step(fixtureData, state, 0, { t: 'use_skill' });
    expect(used.state.players[0].skillUsedYear).toBe(1);
    expect(used.state.phase.t).toBe('turn_start');
    expect(skillFx(used.fx)).toHaveLength(1);
    expect(skillFx(used.fx)[0].name).toBe('きびだんご外交');
    expect(used.fx.some((f) => f.t === 'say' && f.lineKey === 'skill')).toBe(true);
    // 技の効果（ほかの全員から5億円ずつ、自分は+15億円）が適用されている
    expect(used.state.players[0].cash).toBeCloseTo(before + 15, 5);
    expect(used.state.players[1].cash).toBeCloseTo(before - 5, 5);

    // 同じ年には二度目を使えない（合法判定も false）
    expect(canUseSkill(fixtureData, used.state, used.state.players[0])).toBe(false);
    expect(() => step(fixtureData, used.state, 0, { t: 'use_skill' })).toThrowError(EngineError);

    // 年が変わればまた使える
    const nextYear = structuredClone(used.state);
    nextYear.year = 2;
    expect(canUseSkill(fixtureData, nextYear, nextYear.players[0])).toBe(true);
  });

  it('使っても手番は終わらず、そのままサイコロをふれる', () => {
    const state = freshTurn(fixtureData, ['red_hood', 'sinbad', 'alice', 'momotaro']);
    const used = step(fixtureData, state, 0, { t: 'use_skill' });
    expect(used.state.phase.t).toBe('turn_start');
    const rolled = step(fixtureData, used.state, 0, { t: 'roll' });
    expect(['choose_dest', 'turn_start']).toContain(rolled.state.phase.t);
    expect(rolled.fx.some((f) => f.t === 'dice')).toBe(true);
  });
});

describe('固有技: 対象を選ぶ技', () => {
  it('use_skill で skill_target に入り、cancel すると発動しない', () => {
    const state = freshTurn(fixtureData, ['alice', 'momotaro', 'sinbad', 'red_hood']);
    const targeting = step(fixtureData, state, 0, { t: 'use_skill' });
    expect(targeting.state.phase.t).toBe('skill_target');
    if (targeting.state.phase.t !== 'skill_target') throw new Error('unreachable');
    expect(targeting.state.phase.options).toEqual(['1', '2', '3']);
    expect(skillFx(targeting.fx)).toHaveLength(0);
    expect(targeting.state.players[0].skillUsedYear).toBeUndefined();

    const cancelled = step(fixtureData, targeting.state, 0, { t: 'cancel' });
    expect(cancelled.state.phase.t).toBe('turn_start');
    expect(cancelled.state.players[0].skillUsedYear).toBeUndefined();
    expect(cancelled.state.players[2].skipTurns).toBe(0);
    expect(skillFx(cancelled.fx)).toHaveLength(0);

    // キャンセル後に選び直せる
    const again = step(fixtureData, cancelled.state, 0, { t: 'use_skill' });
    expect(again.state.phase.t).toBe('skill_target');
  });

  it('skill_target で選んだ相手にだけ効果がかかる', () => {
    const state = freshTurn(fixtureData, ['alice', 'momotaro', 'sinbad', 'red_hood']);
    const targeting = step(fixtureData, state, 0, { t: 'use_skill' });
    const resolved = step(fixtureData, targeting.state, 0, { t: 'skill_target', target: '2' });
    expect(resolved.state.players[2].skipTurns).toBe(1);
    expect(resolved.state.players[1].skipTurns).toBe(0);
    expect(resolved.state.players[3].skipTurns).toBe(0);
    expect(resolved.state.players[0].skillUsedYear).toBe(1);
    expect(skillFx(resolved.fx)[0].targetId).toBe(2);
    expect(resolved.state.phase.t).toBe('turn_start');
  });

  it('選択肢にない相手は EngineError', () => {
    const state = freshTurn(fixtureData, ['alice', 'momotaro', 'sinbad', 'red_hood']);
    const targeting = step(fixtureData, state, 0, { t: 'use_skill' });
    expect(() => step(fixtureData, targeting.state, 0, { t: 'skill_target', target: '9' })).toThrowError(
      EngineError,
    );
    expect(() => step(fixtureData, targeting.state, 0, { t: 'roll' })).toThrowError(EngineError);
  });
});

describe('固有技: 実データ全 48 人', () => {
  const base = createGame(
    GAME_DATA,
    config(['momotaro', 'sinbad', 'alice', 'red_hood'], 1, 11),
  ).state;

  it('どのキャラの技も例外なく適用でき、所持金が有限に収まる', () => {
    for (const character of GAME_DATA.characters) {
      const state = structuredClone(base);
      state.phase = { t: 'turn_start' };
      state.current = 0;
      state.players[0].characterId = character.id;
      state.players[0].skillUsedYear = undefined;
      const skill = skillFor(GAME_DATA, character.id);
      expect(skill, character.id).not.toBeNull();

      const first = step(GAME_DATA, state, 0, { t: 'use_skill' });
      let result = first;
      if (first.state.phase.t === 'skill_target') {
        const target = first.state.phase.options[0];
        result = step(GAME_DATA, first.state, 0, { t: 'skill_target', target });
        expect(skillFx(result.fx)[0].targetId).toBe(Number(target));
      }
      const fx = skillFx(result.fx);
      expect(fx, character.id).toHaveLength(1);
      expect(fx[0].characterId).toBe(character.id);
      expect(fx[0].name).toBe(skill?.name);
      for (const player of result.state.players) {
        expect(Number.isFinite(player.cash), `${character.id} → ${player.name}`).toBe(true);
        expect(Number.isFinite(netWorth(GAME_DATA, result.state, player.id))).toBe(true);
      }
      expect(result.state.players[0].skillUsedYear).toBe(1);
      expect(result.state.phase.t).toBe('turn_start');
    }
  });

  it('全キャラの技名と説明が埋まっていて、対象の宣言と実装が一致する', () => {
    for (const character of GAME_DATA.characters) {
      const skill = character.skill;
      expect(skill.name.length, character.id).toBeGreaterThan(0);
      expect(skill.desc.length, character.id).toBeGreaterThan(0);
      expect(character.lines.skill.length, character.id).toBeGreaterThan(0);
      expect([...character.lines.skill].length, character.id).toBeLessThanOrEqual(45);
      const usesTarget = JSON.stringify(skill.effects).includes('"target"');
      expect(usesTarget, character.id).toBe(skill.target === 'player');
    }
  });
});

describe('固有技: CPU', () => {
  it('1 年のあいだに CPU が技を使い、同じ年には二度使わない', () => {
    for (const seed of [1, 2, 3]) {
      let state = createGame(fixtureData, config(['momotaro', 'sinbad', 'alice', 'red_hood'], 1, seed)).state;
      const usedBy = [0, 0, 0, 0];
      const seenPhase = new Set<string>();
      let steps = 0;
      while (state.phase.t !== 'game_over') {
        seenPhase.add(state.phase.t);
        const actor = actorOf(state);
        if (actor === null) throw new Error(`no actor in ${state.phase.t}`);
        const result = step(fixtureData, state, actor, cpuDecide(fixtureData, state));
        for (const fx of skillFx(result.fx)) usedBy[fx.playerId] += 1;
        state = result.state;
        if (++steps > 100_000) throw new Error('did not terminate');
      }
      expect(seenPhase.has('skill_target') || usedBy.some((n) => n > 0)).toBe(true);
      expect(usedBy.reduce((a, b) => a + b, 0), `seed ${seed}`).toBeGreaterThanOrEqual(3);
      for (const count of usedBy) expect(count, `seed ${seed}`).toBeLessThanOrEqual(1);
      for (const player of state.players) expect(player.skillUsedYear).toBe(1);
    }
  });

  it('対象を選ぶ局面でも CPU は必ず合法な対象を返す', () => {
    const state = freshTurn(fixtureData, ['alice', 'momotaro', 'sinbad', 'red_hood']);
    const targeting = step(fixtureData, state, 0, { t: 'use_skill' });
    expect(targeting.state.phase.t).toBe('skill_target');
    const action = cpuDecide(fixtureData, targeting.state);
    expect(action.t).toBe('skill_target');
    if (action.t !== 'skill_target') throw new Error('unreachable');
    if (targeting.state.phase.t !== 'skill_target') throw new Error('unreachable');
    expect(targeting.state.phase.options).toContain(action.target);
  });
});