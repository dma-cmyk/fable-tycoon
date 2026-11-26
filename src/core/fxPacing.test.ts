import { describe, expect, it } from 'vitest';
import type { Fx } from './types';
import {
  BIG_SWING_RATIO,
  compactDramaKind,
  compactDramaMs,
  CPU_ROUTINE_BOOST,
  isCompactBuyout,
  isCompactSkill,
  isRoutineCpuFx,
  isRoutineCpuSay,
  ROUTINE_BOOST,
  routineFxDuration,
  routineFxScale,
  type FxPacingContext,
} from './fxPacing';

/** Seat 0 is the human, 1..3 are CPUs. `level` mirrors the client's 標準 setting. */
const cpu: FxPacingContext = {
  actor: 1,
  isCpu: (id) => id === 1 || id === 2 || id === 3,
  level: 'standard',
};
const human: FxPacingContext = { ...cpu, actor: 0 };

const skillFx = (playerId: number, targetId?: number): Extract<Fx, { t: 'skill' }> => ({
  t: 'skill',
  playerId,
  characterId: 'c',
  name: 'n',
  ...(targetId !== undefined ? { targetId } : {}),
});

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
      expect(routineFxScale(fx, cpu), fx.t).toBe(ROUTINE_BOOST.standard);
      expect(routineFxDuration(800, fx, cpu), fx.t).toBe(800 / ROUTINE_BOOST.standard);
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
      { t: 'city_mod', cityId: 'doha', mult: 2, years: 1, label: 'l', kind: 'boom' },
      { t: 'final_year', year: 3, rules: [] },
      { t: 'event_open', eventId: 'e', playerId: 1 },
      { t: 'event_close' },
      { t: 'destination', cityId: 'doha' },
      { t: 'month', year: 1, month: 5 },
      { t: 'skip', playerId: 1 },
      { t: 'warp', playerId: 1, nodeId: 'n' },
      { t: 'card_use', playerId: 1, cardId: 'c' },
      { t: 'errand', cityId: 'doha', bonus: 10, requester: 'c', title: 't' },
      { t: 'errand_done', playerId: 1, cityId: 'doha', bonus: 10 },
    ];
    for (const fx of protectedFx) {
      expect(routineFxScale(fx, cpu), fx.t).toBe(1);
      expect(routineFxDuration(900, fx, cpu), fx.t).toBe(900);
    }
    // A human's turn is normal even on the human context.
    expect(routineFxScale({ t: 'dice', values: [1] }, human)).toBe(1);
    expect(isRoutineCpuFx({ t: 'turn', playerId: 0 }, cpu)).toBe(false);
  });

  it('ties the routine boost to the 演出の長さ tier', () => {
    const turn: Fx = { t: 'turn', playerId: 1 };
    expect(routineFxScale(turn, { ...cpu, level: 'calm' })).toBe(CPU_ROUTINE_BOOST);
    expect(routineFxScale(turn, { ...cpu, level: 'standard' })).toBe(ROUTINE_BOOST.standard);
    expect(routineFxScale(turn, { ...cpu, level: 'brisk' })).toBe(ROUTINE_BOOST.brisk);
    expect(ROUTINE_BOOST.calm).toBeLessThan(ROUTINE_BOOST.standard);
    expect(ROUTINE_BOOST.standard).toBeLessThan(ROUTINE_BOOST.brisk);
  });

  it('routes routine character lines only for CPU speakers', () => {
    expect(isRoutineCpuSay({ t: 'say', speaker: 'self', playerId: 1, text: 'x', lineKey: 'turn' }, cpu)).toBe(true);
    expect(isRoutineCpuSay({ t: 'say', speaker: 'self', playerId: 1, text: 'x', lineKey: 'goal' }, cpu)).toBe(false);
    expect(isRoutineCpuSay({ t: 'say', speaker: 'self', playerId: 0, text: 'x', lineKey: 'turn' }, cpu)).toBe(false);
    expect(isRoutineCpuSay({ t: 'say', speaker: 'narrator', text: 'x' }, cpu)).toBe(false);
  });

  it('treats an unknown actor as normal', () => {
    const unknown: FxPacingContext = { ...cpu, actor: null };
    expect(routineFxScale({ t: 'dice', values: [1] }, unknown)).toBe(1);
    expect(routineFxScale({ t: 'move', playerId: 1, path: ['a'] }, unknown)).toBe(1);
  });
});

describe('compact CPU-only drama', () => {
  it('condenses a CPU skill that touches no human', () => {
    const skill = skillFx(1);
    const update: Fx[] = [
      skill,
      { t: 'say', speaker: 'self', playerId: 1, text: 'x', lineKey: 'skill' },
      { t: 'cash', playerId: 1, delta: 12, reason: 'イベント' },
    ];
    const ctx: FxPacingContext = { ...cpu, update, leaderWorth: 800 };
    expect(isCompactSkill(skill, ctx)).toBe(true);
    expect(compactDramaKind(skill, ctx)).toBe('skill');
    expect(compactDramaMs('skill', 'standard')).toBe(800);
    expect(routineFxDuration(2200, skill, ctx)).toBe(800);
    // The 決め台詞 plays as colour: no voice wait, but it still reaches the window and the log.
    expect(isRoutineCpuSay(update[1] as Extract<Fx, { t: 'say' }>, ctx)).toBe(true);
  });

  it('keeps the full cut-in when the human is hit, targeted or the swing is big', () => {
    const skill = skillFx(1);
    const humanHit: Fx[] = [skill, { t: 'cash', playerId: 0, delta: -20, reason: 'イベント' }];
    expect(isCompactSkill(skill, { ...cpu, update: humanHit, leaderWorth: 800 })).toBe(false);

    const humanTarget = skillFx(1, 0);
    expect(isCompactSkill(humanTarget, { ...cpu, update: [humanTarget], leaderWorth: 800 })).toBe(false);

    const big: Fx[] = [skill, { t: 'cash', playerId: 1, delta: 200, reason: 'イベント' }];
    expect(isCompactSkill(skill, { ...cpu, update: big, leaderWorth: 800 })).toBe(false);
    // 200億 >= 10% of an 800億 leader: exactly the border is protected.
    const border: Fx[] = [skill, { t: 'cash', playerId: 1, delta: 800 * BIG_SWING_RATIO, reason: 'イベント' }];
    expect(isCompactSkill(skill, { ...cpu, update: border, leaderWorth: 800 })).toBe(false);

    const monopoly: Fx[] = [skill, { t: 'toast', text: 'ドーハ を独占！' }];
    expect(isCompactSkill(skill, { ...cpu, update: monopoly, leaderWorth: 800 })).toBe(false);
  });

  it('never condenses a human skill, and じっくり keeps every full cut-in', () => {
    const skill = skillFx(0);
    expect(isCompactSkill(skill, { ...cpu, update: [skill], leaderWorth: 800 })).toBe(false);
    expect(isCompactSkill(skillFx(1), { ...cpu, level: 'calm', update: [skillFx(1)], leaderWorth: 800 })).toBe(false);
  });

  it('condenses only CPU-to-CPU buyouts without a broken monopoly', () => {
    const buyout = (playerId: number, fromId: number, brokeMonopoly = false): Extract<Fx, { t: 'buyout' }> => ({
      t: 'buyout',
      playerId,
      fromId,
      propertyId: 'p',
      amount: 40,
      brokeMonopoly,
    });
    expect(isCompactBuyout(buyout(1, 2), cpu)).toBe(true);
    expect(isCompactBuyout(buyout(1, 0), cpu)).toBe(false);
    expect(isCompactBuyout(buyout(0, 1), cpu)).toBe(false);
    expect(isCompactBuyout(buyout(1, 2, true), cpu)).toBe(false);
    expect(isCompactBuyout(buyout(1, 2), { ...cpu, level: 'calm' })).toBe(false);

    const update: Fx[] = [
      buyout(1, 2),
      { t: 'say', speaker: 'self', playerId: 2, text: '買収された', lineKey: undefined },
    ];
    const ctx: FxPacingContext = { ...cpu, update };
    expect(compactDramaKind(update[0], ctx)).toBe('buyout');
    expect(routineFxDuration(900, update[0], ctx)).toBe(compactDramaMs('buyout', 'standard'));
    expect(isRoutineCpuSay(update[1] as Extract<Fx, { t: 'say' }>, ctx)).toBe(true);
  });

  it('lets さくさく compact more without ever lengthening a beat', () => {
    expect(compactDramaMs('skill', 'brisk')).toBeLessThan(compactDramaMs('skill', 'standard'));
    expect(compactDramaMs('buyout', 'brisk')).toBeLessThan(compactDramaMs('buyout', 'standard'));
    expect(compactDramaMs('skill', 'calm')).toBe(2200);
    expect(compactDramaMs('buyout', 'calm')).toBe(900);
  });
});