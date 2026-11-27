import { describe, expect, it } from 'vitest';
import type { Fx } from './types';
import {
  BIG_SWING_RATIO,
  COMPACT_VOICE_WAIT_MS,
  compactDramaKind,
  cutsVoice,
  estimateSayVoiceMs,
  compactDramaMs,
  compactSayBeat,
  CPU_ROUTINE_BOOST,
  createDramaLedger,
  isCompactBuyout,
  isCompactSkill,
  isRoutineCpuFx,
  isRoutineCpuSay,
  noteDramaLedger,
  paceUpdate,
  ROUTINE_BOOST,
  routineFxDuration,
  SAY_REVEAL_ALLOWANCE_MS,
  routineFxScale,
  SAY_MIN_HOLD_MS,
  sayHoldMs,
  type FxPacingContext,
} from './fxPacing';

/** Nominal `FX_MS.goal`; kept local so the test does not import the net layer. */
const FX_GOAL_NOMINAL = 1600;

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
describe('repeated drama compacts after the first occurrence of the year', () => {
  const goal = (playerId: number): Fx => ({ t: 'goal', playerId, cityId: 'doha', bonus: 90 });
  const buyMono = (playerId: number): Fx => ({ t: 'buy', playerId, propertyId: 'p', monopoly: true });
  const roulette = (from: 1 | 2 | 3, to: 1 | 2 | 3): Fx => ({ t: 'piper_roulette', holder: 2, from, to });
  const mischief = (holder: number | null): Fx => ({ t: 'piper', holder, level: 1, message: 'm' });

  const fresh = (level: 'calm' | 'standard' | 'brisk' = 'standard'): FxPacingContext => ({
    ...cpu,
    level,
    year: 2,
    ledger: createDramaLedger(2),
  });

  it('plays the first CPU goal of a year full and every later one compact', () => {
    const ctx = fresh();
    const first = goal(1);
    expect(compactDramaKind(first, ctx)).toBe(null);
    noteDramaLedger(ctx.ledger!, 2, first);
    const second = goal(2);
    expect(compactDramaKind(second, ctx)).toBe('goal');
    expect(compactDramaMs('goal', 'standard')).toBeLessThan(FX_GOAL_NOMINAL);
    // The human's own goal is the reason they play: always full.
    expect(compactDramaKind(goal(0), ctx)).toBe(null);
  });

  it('compacts a repeated CPU monopoly but never the first', () => {
    const ctx = fresh();
    const first = buyMono(1);
    expect(compactDramaKind(first, ctx)).toBe(null);
    noteDramaLedger(ctx.ledger!, 2, first);
    expect(compactDramaKind(buyMono(2), ctx)).toBe('monopoly');
    expect(compactDramaKind(buyMono(0), ctx)).toBe(null);
  });

  it('compacts a roulette only when the form does not change and it is a repeat', () => {
    const ctx = fresh();
    const firstNoChange = roulette(2, 2);
    // 年の初出の「変わらないルーレット」はフル（何が起きたか一度は見せる）。
    expect(compactDramaKind(firstNoChange, ctx)).toBe(null);
    noteDramaLedger(ctx.ledger!, 2, firstNoChange);
    expect(compactDramaKind(roulette(2, 2), ctx)).toBe('piper_roulette');
    // 姿が変わるルーレットは何度でもフル（保有者の危険度が変わる）。
    expect(compactDramaKind(roulette(1, 2), ctx)).toBe(null);
    expect(compactDramaKind(roulette(3, 1), ctx)).toBe(null);
  });

  it('compacts repeated piper mischief on a CPU but not on the human', () => {
    const ctx = fresh();
    const first = mischief(2);
    expect(compactDramaKind(first, ctx)).toBe(null);
    noteDramaLedger(ctx.ledger!, 2, first);
    expect(compactDramaKind(mischief(3), ctx)).toBe('piper_mischief');
    expect(compactDramaKind(mischief(0), ctx)).toBe(null);
    expect(compactDramaKind(mischief(null), ctx)).toBe(null);
  });

  it('clears the counts at a year boundary and never compacts in じっくり', () => {
    const ctx = fresh();
    noteDramaLedger(ctx.ledger!, 2, goal(1));
    expect(compactDramaKind(goal(2), ctx)).toBe('goal');
    // New year: the ledger resets on the next note, so the first goal of year 3 is full again.
    ctx.year = 3;
    expect(compactDramaKind(goal(2), ctx)).toBe(null);
    const calm = fresh('calm');
    noteDramaLedger(calm.ledger!, 2, goal(1));
    expect(compactDramaKind(goal(2), calm)).toBe(null);
  });

  it('gives the repeat its own host budget and say hold', () => {
    const ctx = fresh();
    noteDramaLedger(ctx.ledger!, 2, goal(1));
    const second = goal(2);
    expect(routineFxDuration(FX_GOAL_NOMINAL, second, ctx)).toBe(compactDramaMs('goal', 'standard'));
    // 標準 never clips a voice: the hold is null and the client waits for the clip (tail 120ms).
    expect(sayHoldMs('こんにちは', { level: 'standard' })).toBe(null);
    expect(sayHoldMs('あ'.repeat(18), { level: 'standard' })).toBe(null);
    expect(cutsVoice('standard')).toBe(false);
    expect(cutsVoice('calm')).toBe(false);
    // さくさく reads at 11 chars/second and may cut the clip.
    expect(cutsVoice('brisk')).toBe(true);
    expect(sayHoldMs('こんにちは', { level: 'brisk' })).toBe(SAY_MIN_HOLD_MS);
    expect(sayHoldMs('あ'.repeat(22), { level: 'brisk' })).toBe(2000);
    expect(sayHoldMs('あ'.repeat(22), { level: 'brisk', compact: true })).toBe(COMPACT_VOICE_WAIT_MS);
    expect(sayHoldMs('あ'.repeat(22), { level: 'calm' })).toBe(null);
    // A long line still reaches its full reading time; only repeats are capped.
    expect(sayHoldMs('あ'.repeat(40), { level: 'brisk', compact: true })).toBe(COMPACT_VOICE_WAIT_MS);
  });

  it('budgets the same wait the client uses, per level', () => {
    const line = (text: string): Fx => ({ t: 'say', speaker: 'self', playerId: 1, text });
    const standard = fresh('standard');
    const brisk = fresh('brisk');
    const calm = fresh('calm');
    const text = 'あ'.repeat(20);
    // 標準: the voice is never clipped, and the DESIGN nominal stays the host budget (the real
    // clip decodes shorter than `estimateSpeechMs`; budgeting the estimate made the room idle).
    expect(routineFxDuration(1950, line(text), standard)).toBe(1950);
    // さくさく: the reading hold (11 chars/s) plus the typewriter reveal.
    expect(routineFxDuration(1950, line(text), brisk)).toBe(
      sayHoldMs(text, { level: 'brisk' })! + SAY_REVEAL_ALLOWANCE_MS,
    );
    // じっくり: the nominal budget is untouched.
    expect(routineFxDuration(1950, line(text), calm)).toBe(1950);
    expect(estimateSayVoiceMs(text)).toBe(900 + 20 * 110);
  });
});

describe('paceUpdate (one decision per update, shared by host and client)', () => {
  const goal = (playerId: number): Fx => ({ t: 'goal', playerId, cityId: 'doha', bonus: 90 });

  it('decides every fx against the ledger before advancing it', () => {
    const ledger = createDramaLedger(1);
    const ctx: FxPacingContext = { ...cpu, level: 'standard', year: 1, ledger };
    const first = [goal(1), { t: 'piper_roulette', holder: 2, from: 2, to: 2 } as Fx];
    const firstDecided = paceUpdate(first, ctx);
    // Both kinds are new this year, so both play full even though the ledger already counts them.
    expect(firstDecided.get(first[0])).toBe(null);
    expect(firstDecided.get(first[1])).toBe(null);

    const second = [goal(2), { t: 'piper_roulette', holder: 3, from: 3, to: 3 } as Fx];
    const secondDecided = paceUpdate(second, ctx);
    expect(secondDecided.get(second[0])).toBe('goal');
    expect(secondDecided.get(second[1])).toBe('piper_roulette');
  });

  it('answers the same tiers when the decision is handed back through compactOf', () => {
    const ledger = createDramaLedger(1);
    const ctx: FxPacingContext = { ...cpu, level: 'standard', year: 1, ledger };
    const update: Fx[] = [goal(1), { t: 'say', speaker: 'self', playerId: 1, text: 'x', lineKey: 'goal' }];
    const decided = paceUpdate(update, ctx);
    const replay = { ...ctx, compactOf: decided };
    expect(compactDramaKind(update[0], replay)).toBe(decided.get(update[0]));
    expect(compactDramaKind(update[0], replay)).toBe(null);
    // The 掛け合い of a full beat keeps its voice wait.
    expect(compactSayBeat(update[1] as Extract<Fx, { t: 'say' }>, replay)).toBe(null);
  });

  it('marks the 掛け合い of a compact repeat as colour', () => {
    const ledger = createDramaLedger(1);
    const ctx: FxPacingContext = { ...cpu, level: 'standard', year: 1, ledger };
    paceUpdate([goal(1)], ctx);
    const update: Fx[] = [goal(2), { t: 'say', speaker: 'self', playerId: 2, text: 'x', lineKey: 'goal' }];
    const decided = paceUpdate(update, { ...ctx, update });
    const replay = { ...ctx, update, compactOf: decided };
    expect(decided.get(update[0])).toBe('goal');
    expect(compactSayBeat(update[1] as Extract<Fx, { t: 'say' }>, replay)).toBe('goal');
    // The human's own line never becomes colour.
    const humanLine: Fx = { t: 'say', speaker: 'self', playerId: 0, text: 'x', lineKey: 'goal' };
    expect(compactSayBeat(humanLine as Extract<Fx, { t: 'say' }>, replay)).toBe(null);
  });
});
