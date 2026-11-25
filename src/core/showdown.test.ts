// Showdown slice tests: final year, comeback card and buyouts (fun overhaul 2026-11-26).
//
// Everything here runs against the hand-written board fixture so the geometry is stable:
// a 48-node rail ring with the 12 world cities spaced 4 steps apart.

import { describe, expect, it } from 'vitest';
import type { GameConfig, GameData, GameState, MoveOption } from './types';
import { fixtureData } from './test-fixture';
import { createGame, cpuDecide, EngineError, netWorth, step } from './engine';
import { reachableInExactly } from './graph';
import { destinationBonus, currentPrice } from './economy';
import {
  BUYOUT_MONOPOLY_MULT,
  BUYOUT_MULT,
  UNDERDOG_CARD_ID,
  UNDERDOG_GAP_SHARE,
  buyoutQuote,
  canUseUnderdog,
  checkBuyout,
  chooseBuyoutAction,
  destinationBonusMultiplier,
  finalYearBlueMultiplier,
  isFinalYearActive,
  isFinalYearOpening,
  underdogShare,
} from './showdown';

const data: GameData = fixtureData;

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

describe('final year', () => {
  it('defines the final year as year N for 3+ year games and months 1–3 for 1-year games', () => {
    expect(isFinalYearActive({ year: 2, month: 4, config: { years: 3 } })).toBe(false);
    expect(isFinalYearActive({ year: 3, month: 4, config: { years: 3 } })).toBe(true);
    expect(isFinalYearActive({ year: 3, month: 3, config: { years: 3 } })).toBe(true);
    // 1-year games: the last three months are the final stretch.
    expect(isFinalYearActive({ year: 1, month: 12, config: { years: 1 } })).toBe(false);
    expect(isFinalYearActive({ year: 1, month: 1, config: { years: 1 } })).toBe(true);
    expect(isFinalYearActive({ year: 1, month: 3, config: { years: 1 } })).toBe(true);
    // Opening fires exactly once.
    expect(isFinalYearOpening({ year: 3, month: 4, config: { years: 3 } })).toBe(true);
    expect(isFinalYearOpening({ year: 3, month: 5, config: { years: 3 } })).toBe(false);
    expect(isFinalYearOpening({ year: 1, month: 1, config: { years: 1 } })).toBe(true);
    expect(isFinalYearOpening({ year: 1, month: 2, config: { years: 1 } })).toBe(false);
  });

  it('emits final_year fx when the last year opens', () => {
    const state = fresh([1, 1, 1], 3);
    state.year = 2;
    state.month = 3;
    state.phase = { t: 'year_end', report: { year: 2, income: [], assets: [], headline: '' } };
    const result = step(data, state, 0, { t: 'ack' });
    const fx = result.fx.find((f) => f.t === 'final_year');
    expect(fx).toBeDefined();
    expect(fx?.t === 'final_year' ? fx.year : 0).toBe(3);
    expect(fx?.t === 'final_year' ? fx.rules.join('') : '').toContain('目的地ボーナス ×2');
    // …and never again inside the same year.
    const midYear = structuredClone(result.state);
    midYear.month = 5;
    midYear.phase = { t: 'year_end', report: { year: 3, income: [], assets: [], headline: '' } };
    const again = step(data, midYear, 0, { t: 'ack' });
    expect(again.fx.some((f) => f.t === 'final_year')).toBe(false);
  });

  it('emits the final stretch at month 1 in a 1-year game', () => {
    const state = fresh([1, 1, 1], 1);
    state.year = 1;
    state.month = 12;
    state.round = 8;
    state.current = 2;
    state.phase = { t: 'buy', cityId: 'tokyo' };
    // Seat 2 holds the last seat of December; ending it rolls the month over to January.
    const advanced = step(data, state, 2, { t: 'end_buy' });
    expect(advanced.state.month).toBe(1);
    expect(advanced.state.year).toBe(1);
    expect(advanced.fx.some((f) => f.t === 'final_year')).toBe(true);
  });

  it('doubles the destination bonus in the final year only', () => {
    expect(destinationBonusMultiplier({ year: 1, month: 5, config: { years: 3 } })).toBe(1);
    expect(destinationBonusMultiplier({ year: 3, month: 5, config: { years: 3 } })).toBe(2);

    const state = fresh([1, 1, 1], 3);
    state.year = 3;
    state.players[0].nodeId = 'c:tokyo';
    state.destination = 'osaka';
    state.destinationStartDistance = 4;
    const option = reachableInExactly(data, 'c:tokyo', 4, null, 'c:osaka').find(
      (o) => o.nodeId === 'c:osaka',
    ) as MoveOption;
    state.phase = { t: 'choose_dest', roll: 4, options: [option] };
    const result = step(data, state, 0, { t: 'move', nodeId: 'c:osaka' });
    const expected = destinationBonus(state, 4) * 2;
    expect(result.state.players[0].cash).toBe(100 + expected);
    const goal = result.fx.find((f) => f.t === 'goal');
    expect(goal?.t === 'goal' ? goal.bonus : 0).toBe(expected);
  });

  it('pays the doubled bonus in the final stretch of a 1-year game', () => {
    const state = fresh([1, 1, 1], 1);
    state.month = 2;
    state.players[0].nodeId = 'c:tokyo';
    state.destination = 'osaka';
    state.destinationStartDistance = 4;
    const option = reachableInExactly(data, 'c:tokyo', 4, null, 'c:osaka').find(
      (o) => o.nodeId === 'c:osaka',
    ) as MoveOption;
    state.phase = { t: 'choose_dest', roll: 4, options: [option] };
    const result = step(data, state, 0, { t: 'move', nodeId: 'c:osaka' });
    expect(result.state.players[0].cash).toBe(100 + destinationBonus(state, 4) * 2);
  });

  it('boosts blue squares for everyone except the leader in the final year', () => {
    const state = fresh([1, 1, 1], 3);
    state.year = 3;
    state.players[0].cash = 500;
    expect(finalYearBlueMultiplier(data, state, 0)).toBe(1);
    expect(finalYearBlueMultiplier(data, state, 1)).toBe(1.5);
    state.year = 1;
    expect(finalYearBlueMultiplier(data, state, 1)).toBe(1);
  });
});

describe('comeback card', () => {
  it('is usable only from last place (bottom half in a 2-player game)', () => {
    const state = fresh([1, 1, 1]);
    state.players[0].cash = 500;
    state.players[1].cash = 200;
    state.players[2].cash = 100;
    expect(canUseUnderdog(data, state, 0)).toBe(false);
    expect(canUseUnderdog(data, state, 1)).toBe(false);
    expect(canUseUnderdog(data, state, 2)).toBe(true);

    const two = fresh([1, 1]);
    two.players[0].cash = 300;
    two.players[1].cash = 100;
    expect(canUseUnderdog(data, two, 1)).toBe(true);
    expect(canUseUnderdog(data, two, 0)).toBe(false);

    // A tie at the top must never be "last place".
    const tied = fresh([1, 1]);
    expect(canUseUnderdog(data, tied, 0)).toBe(false);
    expect(canUseUnderdog(data, tied, 1)).toBe(false);
  });

  it('takes 18% of the net-worth gap from the leader', () => {
    const state = fresh([1, 1, 1]);
    state.players[0].cash = 900;
    state.players[1].cash = 200;
    state.players[2].cash = 100;
    expect(netWorth(data, state, 0)).toBe(900);
    expect(netWorth(data, state, 1)).toBe(200);
    expect(underdogShare(data, state, 2)).toBe(Math.round(800 * UNDERDOG_GAP_SHARE));
    expect(underdogShare(data, state, 1)).toBe(Math.round(700 * UNDERDOG_GAP_SHARE));
    expect(underdogShare(data, state, 0)).toBe(0);
  });

  it('transfers the share from the leader to the last-place player', () => {
    const state = fresh([1, 1, 1]);
    state.players[0].cash = 900;
    state.players[1].cash = 200;
    state.players[2].cash = 100;
    state.players[2].cards = [UNDERDOG_CARD_ID];
    state.current = 2;
    const share = underdogShare(data, state, 2);
    expect(share).toBe(Math.round(800 * UNDERDOG_GAP_SHARE));

    const result = step(data, state, 2, { t: 'use_card', cardId: UNDERDOG_CARD_ID });
    expect(result.state.players[0].cash).toBe(900 - share);
    expect(result.state.players[2].cash).toBe(100 + share);
    expect(result.state.players[2].cards).not.toContain(UNDERDOG_CARD_ID);
    expect(result.fx.some((f) => f.t === 'cash' && f.reason === '下剋上の豆')).toBe(true);
    expect(result.state.phase.t).toBe('choose_dest'); // it also rolls the dice
  });

  it('rejects the card when the player is not last', () => {
    const state = fresh([1, 1, 1]);
    state.players[0].cash = 900;
    state.players[1].cash = 200;
    state.players[2].cash = 100;
    state.players[0].cards = [UNDERDOG_CARD_ID];
    expect(() => step(data, state, 0, { t: 'use_card', cardId: UNDERDOG_CARD_ID })).toThrow(EngineError);
  });

  it('seizes the leader property when their cash cannot cover the share', () => {
    const state = fresh([1, 1, 1]);
    state.players[0].cash = 5;
    state.owner['tokyo-tower'] = 0;
    state.owner['tokyo-bank'] = 0;
    state.players[2].cash = 0;
    state.players[2].cards = [UNDERDOG_CARD_ID];
    state.current = 2;
    // Leader: cash 5 + tower 40 + bank 60 = 105. Last: 0. Share = 19 > 5 cash.
    const share = underdogShare(data, state, 2);
    expect(share).toBe(Math.round(105 * UNDERDOG_GAP_SHARE));
    const result = step(data, state, 2, { t: 'use_card', cardId: UNDERDOG_CARD_ID });
    // Cash 5 first, then the cheapest property is liquidated and the missing 14 is paid over.
    expect(result.state.players[2].cash).toBe(share);
    expect(result.state.owner['tokyo-tower']).toBeUndefined();
    expect(result.state.owner['tokyo-bank']).toBe(0);
    expect(result.state.players[0].cash).toBe(Math.floor(40 * 0.7) - (share - 5));
    expect(result.fx.some((f) => f.t === 'sell' && f.playerId === 0)).toBe(true);
  });

  it('is granted to last place at every year-end except the last', () => {
    const state = fresh([1, 1, 1], 3);
    state.year = 1;
    state.month = 3;
    state.current = 2;
    state.players[0].cash = 900;
    state.players[2].cash = 10;
    state.phase = { t: 'buy', cityId: 'tokyo' };
    const settled = step(data, state, 2, { t: 'end_buy' });
    expect(settled.state.phase.t).toBe('year_end');
    expect(settled.state.players[2].cards).toContain(UNDERDOG_CARD_ID);
    expect(settled.fx.some((f) => f.t === 'card_get' && f.cardId === UNDERDOG_CARD_ID)).toBe(true);

    // The last (final) year-end does not grant the card again.
    const final = fresh([1, 1, 1], 3);
    final.year = 3;
    final.month = 3;
    final.current = 2;
    final.players[0].cash = 900;
    final.players[2].cash = 10;
    final.phase = { t: 'buy', cityId: 'tokyo' };
    const done = step(data, final, 2, { t: 'end_buy' });
    expect(done.state.phase.t).toBe('year_end');
    expect(done.state.players[2].cards).not.toContain(UNDERDOG_CARD_ID);
  });

  it('does not stack duplicate cards when last place already holds one', () => {
    const state = fresh([1, 1, 1], 3);
    state.year = 1;
    state.month = 3;
    state.current = 2;
    state.players[2].cash = 5;
    state.players[2].cards = [UNDERDOG_CARD_ID];
    state.phase = { t: 'buy', cityId: 'tokyo' };
    const settled = step(data, state, 2, { t: 'end_buy' });
    expect(settled.state.players[2].cards.filter((c) => c === UNDERDOG_CARD_ID)).toHaveLength(1);
  });
});

describe('buyouts', () => {
  it('prices at 1.5× and pays the owner', () => {
    const state = fresh([1, 1, 1]);
    state.owner['tokyo-tower'] = 1;
    state.phase = { t: 'buy', cityId: 'tokyo' };
    const quote = buyoutQuote(data, state, 'tokyo-tower');
    expect(quote?.basePrice).toBeCloseTo(currentPrice(data, state, 'tokyo-tower'));
    expect(quote?.mult).toBe(BUYOUT_MULT);
    expect(quote?.price).toBeCloseTo(currentPrice(data, state, 'tokyo-tower') * BUYOUT_MULT);
    const cash0 = state.players[0].cash;
    const cash1 = state.players[1].cash;
    const result = step(data, state, 0, { t: 'buyout', propertyId: 'tokyo-tower' });
    expect(result.state.owner['tokyo-tower']).toBe(0);
    expect(result.state.players[0].cash).toBeCloseTo(cash0 - (quote?.price ?? 0));
    expect(result.state.players[1].cash).toBeCloseTo(cash1 + (quote?.price ?? 0));
    const fx = result.fx.find((f) => f.t === 'buyout');
    expect(fx).toMatchObject({ playerId: 0, fromId: 1, propertyId: 'tokyo-tower', brokeMonopoly: false });
  });

  it('prices a monopoly property at 2.0× and breaks the monopoly', () => {
    const state = fresh([1, 1, 1]);
    state.owner['tokyo-tower'] = 1;
    state.owner['tokyo-bank'] = 1;
    state.players[0].cash = 300;
    state.phase = { t: 'buy', cityId: 'tokyo' };
    const quote = buyoutQuote(data, state, 'tokyo-bank');
    expect(quote?.brokeMonopoly).toBe(true);
    expect(quote?.basePrice).toBeCloseTo(currentPrice(data, state, 'tokyo-bank'));
    expect(quote?.mult).toBe(BUYOUT_MONOPOLY_MULT);
    expect(quote?.price).toBeCloseTo(currentPrice(data, state, 'tokyo-bank') * BUYOUT_MONOPOLY_MULT);
    const result = step(data, state, 0, { t: 'buyout', propertyId: 'tokyo-bank' });
    expect(result.state.owner['tokyo-bank']).toBe(0);
    // The other owner keeps one property, so the monopoly is gone.
    expect(result.state.owner['tokyo-tower']).toBe(1);
    expect(result.fx.some((f) => f.t === 'buyout' && f.brokeMonopoly)).toBe(true);
    expect(result.fx.some((f) => f.t === 'say' && f.speaker === 'narrator')).toBe(true);
  });

  it('allows only one buyout per visit but still allows normal purchases after it', () => {
    const state = fresh([1, 1, 1]);
    state.owner['tokyo-tower'] = 1;
    state.owner['tokyo-bank'] = 2;
    state.players[0].cash = 300;
    state.phase = { t: 'buy', cityId: 'tokyo' };
    const first = step(data, state, 0, { t: 'buyout', propertyId: 'tokyo-tower' });
    expect(first.state.phase.t).toBe('buy');
    expect(first.state.phase.t === 'buy' ? first.state.phase.boughtOut : false).toBe(true);
    expect(() => step(data, first.state, 0, { t: 'buyout', propertyId: 'tokyo-bank' })).toThrow(EngineError);

    const later = fresh([1, 1, 1]);
    later.owner['tokyo-tower'] = 1;
    later.players[0].cash = 300;
    later.phase = { t: 'buy', cityId: 'tokyo' };
    const bought = step(data, later, 0, { t: 'buyout', propertyId: 'tokyo-tower' });
    const boughtVacant = step(data, bought.state, 0, { t: 'buy', propertyId: 'tokyo-bank' });
    expect(boughtVacant.state.owner['tokyo-bank']).toBe(0);
    expect(boughtVacant.state.phase.t).toBe('buy');
  });

  it('rejects buying a property that is not in this city, unowned, or one you own', () => {
    const state = fresh([1, 1, 1]);
    state.owner['tokyo-tower'] = 1;
    state.owner['osaka-dotonbori'] = 1;
    state.phase = { t: 'buy', cityId: 'tokyo' };
    expect(checkBuyout(data, state, 0, 'tokyo', 'osaka-dotonbori', false).ok).toBe(false);
    expect(checkBuyout(data, state, 0, 'tokyo', 'tokyo-bank', false).ok).toBe(false);
    state.owner['tokyo-bank'] = 0;
    expect(checkBuyout(data, state, 0, 'tokyo', 'tokyo-bank', false).ok).toBe(false);
  });

  it('rejects the buyout when cash is short', () => {
    const state = fresh([1, 1, 1]);
    state.owner['tokyo-bank'] = 1;
    state.owner['tokyo-tower'] = 1;
    state.players[0].cash = 10;
    state.phase = { t: 'buy', cityId: 'tokyo' };
    expect(() => step(data, state, 0, { t: 'buyout', propertyId: 'tokyo-bank' })).toThrow(EngineError);
  });

  it('CPU Lv2 buys out a monopoly property when it completes its own monopoly', () => {
    const state = fresh([2, 1, 1]);
    // P0 owns one of Tokyo's two properties; P1 owns the other (completing P0's monopoly).
    state.owner['tokyo-tower'] = 0;
    state.owner['tokyo-bank'] = 1;
    state.players[0].cash = 400;
    state.phase = { t: 'buy', cityId: 'tokyo' };
    const action = cpuDecide(data, state);
    expect(action).toEqual({ t: 'buyout', propertyId: 'tokyo-bank' });
  });

  it('CPU Lv2 breaks the leader monopoly and then stops buying out', () => {
    const state = fresh([2, 1, 1]);
    state.owner['tokyo-tower'] = 1;
    state.owner['tokyo-bank'] = 1;
    state.players[1].cash = 900;
    state.players[0].cash = 300;
    state.phase = { t: 'buy', cityId: 'tokyo' };
    const first = cpuDecide(data, state);
    expect(first.t).toBe('buyout');
    const applied = step(data, state, 0, first);
    expect(applied.state.phase.t === 'buy' ? applied.state.phase.boughtOut : false).toBe(true);
    // Already bought out this visit: the CPU must not ask for a second buyout.
    const second = cpuDecide(data, applied.state);
    expect(second.t).not.toBe('buyout');
  });

  it('CPU Lv1 never buys out', () => {
    const state = fresh([1, 1, 1]);
    state.owner['tokyo-tower'] = 1;
    state.owner['tokyo-bank'] = 1;
    state.phase = { t: 'buy', cityId: 'tokyo' };
    expect(chooseBuyoutAction(data, state, state.players[0])).toBeNull();
  });
});

describe('integration', () => {
  it('drives a full 3-year CPU game with all the new rules enabled', () => {
    let current = fresh([3, 3, 3], 3);
    let steps = 0;
    let buyouts = 0;
    let grants = 0;
    while (current.phase.t !== 'game_over' && steps < 200_000) {
      const result = step(data, current, current.current, cpuDecide(data, current));
      buyouts += result.fx.filter((f) => f.t === 'buyout').length;
      grants += result.fx.filter((f) => f.t === 'card_get' && f.cardId === UNDERDOG_CARD_ID).length;
      current = result.state;
      steps += 1;
    }
    expect(current.phase.t).toBe('game_over');
    expect(grants).toBeGreaterThanOrEqual(1); // at least one year-end grant happened
    expect(Number.isFinite(netWorth(data, current, current.phase.t === 'game_over' ? current.phase.ranking[0] : 0))).toBe(true);
    void buyouts;
  });
});
