import { describe, expect, it } from 'vitest';
import type { Fx } from './types';
import {
  CPU_ROUTINE_BOOST,
  isRoutineCpuFx,
  isRoutineCpuSay,
  routineFxDuration,
  routineFxScale,
  type FxPacingContext,
} from './fxPacing';

const cpu: FxPacingContext = { actor: 1, isCpu: (id) => id === 1 };
const human: FxPacingContext = { actor: 0, isCpu: (id) => id === 1 };

describe('fxPacing (shared by host budget and client playback)', () => {
  it('shortens only routine CPU bookkeeping', () => {
    const routine: Fx[] = [
      { t: 'turn', playerId: 1 },
      { t: 'dice', values: [3] },
      { t: 'move', playerId: 1, path: ['a', 'b'] },
      { t: 'cash', playerId: 1, delta: 12, reason: '青マス' },
      { t: 'buy', playerId: 1, propertyId: 'p', monopoly: false },
      { t: 'toast', text: '到着。物件を購入できる。' },
      { t: 'card_get', playerId: 1, cardId: 'c' },
    ];
    for (const fx of routine) {
      expect(routineFxScale(fx, cpu), fx.t).toBe(CPU_ROUTINE_BOOST);
      expect(routineFxDuration(900, fx, cpu), fx.t).toBe(900 / CPU_ROUTINE_BOOST);
    }
  });

  it('keeps the human and the protected beats at the nominal budget', () => {
    const protectedFx: Fx[] = [
      { t: 'turn', playerId: 0 },
      { t: 'cash', playerId: 0, delta: 12, reason: '青マス' },
      { t: 'cash', playerId: 1, delta: 156, reason: '目的地ボーナス' },
      { t: 'buy', playerId: 1, propertyId: 'p', monopoly: true },
      { t: 'toast', text: 'ドーハ を独占！ 決算収益が2倍になる。' },
      { t: 'toast', text: '新しい目的地は ドーハ（最短 24 歩）。' },
      { t: 'goal', playerId: 1, cityId: 'doha', bonus: 100 },
      { t: 'piper', holder: 1, level: 2, message: 'x' },
      { t: 'piper_roulette', holder: 1, from: 1, to: 2 },
      { t: 'piper_disaster', holder: 1, kind: 'k', title: 't', amount: 1, propertyIds: [] },
      { t: 'piper_gift', holder: 1, amount: 1, title: 't' },
      { t: 'buyout', playerId: 1, fromId: 0, propertyId: 'p', amount: 1, brokeMonopoly: false },
      { t: 'city_mod', cityId: 'doha', mult: 2, years: 1, label: 'l', kind: 'boom' },
      { t: 'skill', playerId: 1, characterId: 'c', name: 'n' },
      { t: 'final_year', year: 3, rules: [] },
      { t: 'event_open', eventId: 'e', playerId: 1 },
      { t: 'event_close' },
      { t: 'destination', cityId: 'doha' },
      { t: 'month', year: 1, month: 5 },
      { t: 'skip', playerId: 1 },
      { t: 'warp', playerId: 1, nodeId: 'n' },
      { t: 'card_use', playerId: 1, cardId: 'c' },
    ];
    for (const fx of protectedFx) {
      expect(routineFxScale(fx, cpu), fx.t).toBe(1);
      expect(routineFxDuration(900, fx, cpu), fx.t).toBe(900);
    }
    // A human's turn is normal even on the human context.
    expect(routineFxScale({ t: 'dice', values: [1] }, human)).toBe(1);
    expect(isRoutineCpuFx({ t: 'turn', playerId: 0 }, cpu)).toBe(false);
  });

  it('routes routine character lines only for CPU speakers', () => {
    expect(isRoutineCpuSay({ t: 'say', speaker: 'self', playerId: 1, text: 'x', lineKey: 'turn' }, cpu)).toBe(true);
    expect(isRoutineCpuSay({ t: 'say', speaker: 'self', playerId: 1, text: 'x', lineKey: 'goal' }, cpu)).toBe(false);
    expect(isRoutineCpuSay({ t: 'say', speaker: 'self', playerId: 0, text: 'x', lineKey: 'turn' }, cpu)).toBe(false);
    expect(isRoutineCpuSay({ t: 'say', speaker: 'narrator', text: 'x' }, cpu)).toBe(false);
  });

  it('treats an unknown actor as normal', () => {
    const unknown: FxPacingContext = { actor: null, isCpu: (id) => id === 1 };
    expect(routineFxScale({ t: 'dice', values: [1] }, unknown)).toBe(1);
    expect(routineFxScale({ t: 'move', playerId: 1, path: ['a'] }, unknown)).toBe(1);
  });
});