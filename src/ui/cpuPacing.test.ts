import { describe, expect, it } from 'vitest';
import type { PublicState } from '../core/engine';
import type { Fx, LineKey } from '../core/types';
import {
  CPU_ROUTINE_BOOST,
  CpuTurnPacer,
  isRoutineCpuFx,
  isRoutineCpuSay,
} from './cpuPacing';

/** Minimal public state: seat 0 is the human, 1..3 are CPUs. */
const state = {
  current: 0,
  players: [
    { id: 0, isCpu: false },
    { id: 1, isCpu: true },
    { id: 2, isCpu: true },
    { id: 3, isCpu: true },
  ],
} as unknown as PublicState;

const routine = (fx: Fx, actor: number | null): boolean => isRoutineCpuFx({ fx, state, actor });

describe('CPU pacing classification', () => {
  it('speeds up a CPU turn, dice and movement', () => {
    expect(routine({ t: 'turn', playerId: 1 }, 1)).toBe(true);
    expect(routine({ t: 'dice', values: [3] }, 1)).toBe(true);
    expect(routine({ t: 'move', playerId: 1, path: ['a', 'b'] }, 1)).toBe(true);
  });

  it('never speeds up the human seat', () => {
    expect(routine({ t: 'turn', playerId: 0 }, 0)).toBe(false);
    expect(routine({ t: 'dice', values: [3] }, 0)).toBe(false);
    expect(routine({ t: 'move', playerId: 0, path: ['a'] }, 0)).toBe(false);
  });

  it('keeps the beats the human is playing for at normal speed', () => {
    const protectedFx: Fx[] = [
      { t: 'goal', playerId: 1, cityId: 'doha', bonus: 100 },
      { t: 'piper', holder: 1, level: 2, message: 'x' },
      { t: 'piper_roulette', holder: 1, from: 1, to: 2 },
      { t: 'piper_disaster', holder: 1, kind: 'k', title: 't', amount: 10, propertyIds: [] },
      { t: 'piper_gift', holder: 1, amount: 10, title: 't' },
      { t: 'buyout', playerId: 1, fromId: 0, propertyId: 'p', amount: 10, brokeMonopoly: false },
      { t: 'city_mod', cityId: 'doha', mult: 2, years: 1, label: 'l', kind: 'boom' },
      { t: 'skill', playerId: 1, characterId: 'c', name: 'n' },
      { t: 'final_year', year: 3, rules: [] },
      { t: 'event_open', eventId: 'e', playerId: 1 },
      { t: 'event_close' },
      { t: 'destination', cityId: 'doha' },
      { t: 'month', year: 1, month: 5 },
      { t: 'year_end', report: { year: 1, income: [], assets: [], headline: '' } },
      { t: 'skip', playerId: 1 },
      { t: 'warp', playerId: 1, nodeId: 'n' },
    ];
    for (const fx of protectedFx) expect(routine(fx, 1), fx.t).toBe(false);
  });

  it('speeds up ordinary bookkeeping only', () => {
    expect(routine({ t: 'cash', playerId: 1, delta: 12, reason: '青マス' }, 1)).toBe(true);
    expect(routine({ t: 'cash', playerId: 1, delta: -4, reason: '赤マス' }, 1)).toBe(true);
    expect(routine({ t: 'buy', playerId: 1, propertyId: 'p', monopoly: false }, 1)).toBe(true);
    expect(routine({ t: 'buy', playerId: 1, propertyId: 'p', monopoly: true }, 1)).toBe(false);
    expect(routine({ t: 'card_get', playerId: 1, cardId: 'c' }, 1)).toBe(true);
    expect(routine({ t: 'toast', text: '到着。物件を購入できる。' }, 1)).toBe(true);
    expect(routine({ t: 'toast', text: '新しい目的地は ドーハ（最短 24 歩）。' }, 1)).toBe(false);
    expect(routine({ t: 'toast', text: 'ドーハ を独占！ 決算収益が2倍になる。' }, 1)).toBe(false);
  });

  it('keeps every human cash change, and every transfer, at normal speed', () => {
    expect(routine({ t: 'cash', playerId: 0, delta: 12, reason: '青マス' }, 0)).toBe(false);
    expect(routine({ t: 'cash', playerId: 0, delta: 156, reason: '目的地ボーナス' }, 1)).toBe(false);
    expect(routine({ t: 'cash', playerId: 1, delta: 156, reason: '目的地ボーナス' }, 1)).toBe(false);
    for (const reason of ['決算', 'スリ', '肩代わり', '敵対的買収', '物件売却']) {
      expect(routine({ t: 'cash', playerId: 1, delta: 10, reason }, 1), reason).toBe(false);
    }
  });

  it('only condenses routine character lines', () => {
    const say = (lineKey: LineKey, playerId?: number) =>
      isRoutineCpuSay({ t: 'say', speaker: 'self', playerId, text: 'x', lineKey }, state);
    expect(say('turn', 1)).toBe(true);
    expect(say('blue', 1)).toBe(true);
    expect(say('goal', 1)).toBe(false);
    expect(say('monopoly', 1)).toBe(false);
    expect(say('piper_hit', 1)).toBe(false);
    expect(say('skill', 1)).toBe(false);
    expect(say('turn', 0)).toBe(false);
    expect(isRoutineCpuSay({ t: 'say', speaker: 'narrator', text: 'x' }, state)).toBe(false);
  });
});

describe('CpuTurnPacer', () => {
  it('tracks the turn actor and returns the boost', () => {
    const pacer = new CpuTurnPacer();
    expect(pacer.speedFor({ t: 'turn', playerId: 1 }, state)).toBe(CPU_ROUTINE_BOOST);
    expect(pacer.actorSeat).toBe(1);
    expect(pacer.speedFor({ t: 'dice', values: [2] }, state)).toBe(CPU_ROUTINE_BOOST);
    expect(pacer.speedFor({ t: 'goal', playerId: 1, cityId: 'x', bonus: 1 }, state)).toBe(1);
    // The next update may start without a fresh `turn` fx: the actor persists.
    expect(pacer.speedFor({ t: 'move', playerId: 1, path: ['a'] }, state)).toBe(CPU_ROUTINE_BOOST);
    expect(pacer.speedFor({ t: 'turn', playerId: 0 }, state)).toBe(1);
    expect(pacer.actorSeat).toBe(0);
    pacer.reset();
    expect(pacer.actorSeat).toBe(null);
  });
});