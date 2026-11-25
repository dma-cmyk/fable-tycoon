import { describe, expect, it } from 'vitest';
import type { GameConfig, GameData, GameState, MoveOption } from './types';
import { fixtureData } from './test-fixture';
import {
  actorOf,
  annualIncome,
  createGame,
  currentPrice,
  distance,
  EngineError,
  netWorth,
  step,
} from './engine';
import { reachableInExactly, isPortOrAdjacentSea, shortestDistance } from './graph';
import { destinationBonus, sellPrice, yearScale } from './economy';
import { handLimitFor } from './cards';
import { piperLevelForHeldTurns, runPiperTurnStart } from './piper';

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

function cardState(cardId: string, players = 3): GameState {
  const state = fresh(Array.from({ length: players }, () => 1 as const));
  state.players[0].cards = [cardId];
  return state;
}

describe('economy', () => {
  it('buys properties, flags the monopoly, and ends the buy phase', () => {
    const state = fresh();
    state.phase = { t: 'buy', cityId: 'tokyo' };
    const first = step(data, state, 0, { t: 'buy', propertyId: 'tokyo-tower' });
    expect(first.state.players[0].cash).toBe(60);
    expect(first.state.owner['tokyo-tower']).toBe(0);
    expect(first.fx.some((f) => f.t === 'buy' && !f.monopoly)).toBe(true);
    const second = step(data, first.state, 0, { t: 'buy', propertyId: 'tokyo-bank' });
    expect(second.state.players[0].cash).toBe(0);
    expect(second.fx.some((f) => f.t === 'buy' && f.monopoly)).toBe(true);
    expect(annualIncome(data, second.state, 0)).toBeCloseTo(8.8);
    const ended = step(data, second.state, 0, { t: 'end_buy' });
    expect(ended.state.current).toBe(1);
    expect(ended.state.phase.t).toBe('turn_start');
  });

  it('computes annual income and doubles it on city monopoly', () => {
    const state = fresh();
    state.owner['tokyo-tower'] = 0;
    expect(annualIncome(data, state, 0)).toBe(2); // 40×5% = 2
    state.owner['tokyo-bank'] = 0;
    expect(annualIncome(data, state, 0)).toBeCloseTo(8.8); // (2 + 2.4) × 2 = 8.8
    expect(netWorth(data, state, 0)).toBe(200); // 100 cash + 40 + 60
  });

  it('applies industry mods multiplicatively and price_mod to asset value', () => {
    const state = fresh();
    state.owner['tokyo-tower'] = 0;
    state.owner['tokyo-bank'] = 0;
    state.industryMods.push({ industry: 'tourism', mult: 2, yearsLeft: 1, label: 'test' });
    // tower: 2 × 2 × 2(mono) = 8, bank: 2.4 × 2(mono) = 4.8 → 12.8
    expect(annualIncome(data, state, 0)).toBeCloseTo(12.8);
    state.priceMod.finance = 1.5;
    expect(currentPrice(data, state, 'tokyo-bank')).toBe(90);
  });

  it('uses 0.7× sale value and yearScale / destination bonus formulas', () => {
    const state = fresh();
    expect(sellPrice(data, state, 'tokyo-tower')).toBe(28);
    expect(yearScale({ year: 1 })).toBe(1);
    expect(yearScale({ year: 3 })).toBeCloseTo(1.7);
    expect(destinationBonus({ year: 1 }, 20)).toBe(70);
    expect(destinationBonus({ year: 2 }, 20)).toBeCloseTo(94.5); // (30+40)×1.35
  });

  it('respects hand limits (card_shark gets 10)', () => {
    expect(handLimitFor('none')).toBe(8);
    expect(handLimitFor('card_shark')).toBe(10);
    expect(handLimitFor('piper_charm')).toBe(8);
  });
});

describe('graph and movement', () => {
  it('caches shortest distances symmetrically', () => {
    expect(distance(data, 'c:tokyo', 'c:tokyo')).toBe(0);
    expect(shortestDistance(data, 'c:tokyo', 'c:osaka')).toBe(4);
    expect(shortestDistance(data, 'c:osaka', 'c:tokyo')).toBe(4);
    expect(shortestDistance(data, 'c:tokyo', 'c:cairo')).toBe(24);
  });

  it('forbids immediate backtracking but folds back at dead ends', () => {
    const options = reachableInExactly(data, 'c:tokyo', 3, 's:0-0');
    expect(options.length).toBeGreaterThan(0);
    for (const option of options) {
      expect(option.path[0]).not.toBe('s:0-0');
      expect(option.path).toHaveLength(3);
    }
    const dead = reachableInExactly(data, 's:dead', 2, 'c:rio');
    expect(dead.length).toBeGreaterThan(0);
    for (const option of dead) expect(option.path[0]).toBe('c:rio');
  });

  it('truncates movement when the destination city is passed', () => {
    const options = reachableInExactly(data, 'c:tokyo', 6, null, 'c:osaka');
    const goal = options.find((o) => o.nodeId === 'c:osaka');
    expect(goal).toBeDefined();
    expect(goal?.path).toEqual(['s:0-0', 's:0-1', 's:0-2', 'c:osaka']);
    for (const option of options) {
      const firstGoal = option.path.indexOf('c:osaka');
      if (firstGoal >= 0) expect(firstGoal).toBe(option.path.length - 1);
    }
  });

  it('detects ports and sea-adjacent nodes', () => {
    expect(isPortOrAdjacentSea(data, 'c:tokyo')).toBe(true); // port
    expect(isPortOrAdjacentSea(data, 'c:cairo')).toBe(true); // sea edge to Tokyo
    expect(isPortOrAdjacentSea(data, 'c:mumbai')).toBe(false);
  });
});

describe('movement presentation and sailor rule', () => {
  it('emits move, then landing cash and say, then the next turn', () => {
    const state = fresh();
    state.players[0].nodeId = 'c:tokyo';
    state.destination = 'mumbai';
    state.phase = { t: 'choose_dest', roll: 1, options: [{ nodeId: 's:0-0', path: ['s:0-0'] }] };
    const result = step(data, state, 0, { t: 'move', nodeId: 's:0-0' });
    const tags = result.fx.map((f) => f.t);
    expect(tags[0]).toBe('move');
    const cashIndex = tags.indexOf('cash');
    const sayIndex = tags.indexOf('say');
    expect(cashIndex).toBeGreaterThan(0);
    expect(sayIndex).toBeGreaterThan(cashIndex);
    expect(tags).toContain('turn');
    expect(tags.lastIndexOf('turn')).toBeGreaterThan(sayIndex);
  });

  it('sailor rule adds +1 on a port or sea-adjacent start node', () => {
    const state = fresh();
    state.players[0].characterId = 'sinbad';
    state.players[0].nodeId = 'c:tokyo';
    const result = step(data, state, 0, { t: 'roll' });
    const dice = result.fx.find((f) => f.t === 'dice');
    expect(dice?.t).toBe('dice');
    if (dice?.t === 'dice') {
      const sum = dice.values.reduce((a, b) => a + b, 0);
      expect(result.state.phase.t === 'choose_dest' ? result.state.phase.roll : -1).toBe(sum + 1);
    }
  });

  it('does not add +1 inland', () => {
    const state = fresh();
    state.players[0].characterId = 'sinbad';
    state.players[0].nodeId = 'c:mumbai';
    const result = step(data, state, 0, { t: 'roll' });
    const dice = result.fx.find((f) => f.t === 'dice');
    if (dice?.t === 'dice') {
      const sum = dice.values.reduce((a, b) => a + b, 0);
      expect(result.state.phase.t === 'choose_dest' ? result.state.phase.roll : -1).toBe(sum);
    }
  });
});

describe('sell phase', () => {
  it('sells at 0.7× and returns to turn flow once solvent', () => {
    const state = fresh();
    state.players[0].cash = -5;
    state.owner['tokyo-tower'] = 0;
    state.phase = { t: 'sell' };
    const result = step(data, state, 0, { t: 'sell', propertyId: 'tokyo-tower' });
    expect(result.state.players[0].cash).toBe(23);
    expect(result.state.owner['tokyo-tower']).toBeUndefined();
    expect(result.state.phase.t).toBe('turn_start');
    expect(actorOf(result.state)).toBe(1);
  });

  it('stays in sell while still negative and keeps a loan when nothing is left', () => {
    const state = fresh();
    state.players[0].cash = -100;
    state.owner['rio-agri'] = 0; // sells for 10.5
    state.owner['tokyo-tower'] = 0; // sells for 28
    state.phase = { t: 'sell' };
    const first = step(data, state, 0, { t: 'sell', propertyId: 'rio-agri' });
    expect(first.state.players[0].cash).toBeCloseTo(-89.5);
    expect(first.state.phase.t).toBe('sell');
    const second = step(data, first.state, 0, { t: 'sell', propertyId: 'tokyo-tower' });
    expect(second.state.players[0].cash).toBeCloseTo(-61.5);
    expect(second.state.owner['tokyo-tower']).toBeUndefined();
    expect(second.state.phase.t).toBe('turn_start');
    expect(actorOf(second.state)).toBe(1);
  });
});

describe('piper', () => {
  it('pays the goal bonus, redraws 20+ away, and assigns the piper to the farthest player', () => {
    const state = fresh();
    state.players[0].nodeId = 'c:tokyo';
    state.players[1].nodeId = 'c:london';
    state.players[2].nodeId = 'c:rio';
    state.destination = 'osaka';
    state.destinationStartDistance = 4;
    const option = reachableInExactly(data, 'c:tokyo', 4, null, 'c:osaka').find(
      (o) => o.nodeId === 'c:osaka',
    ) as MoveOption;
    state.phase = { t: 'choose_dest', roll: 4, options: [option] };
    const result = step(data, state, 0, { t: 'move', nodeId: 'c:osaka' });
    expect(result.state.players[0].goals).toBe(1);
    expect(result.state.players[0].cash).toBe(138); // 100 + (30 + 2×4)
    const goal = result.fx.find((f) => f.t === 'goal');
    expect(goal?.t === 'goal' ? goal.bonus : 0).toBe(38);
    expect(result.state.piper.holder).toBe(1);
    expect(result.state.destination).not.toBe('osaka');
    expect(result.state.destinationStartDistance ?? 0).toBeGreaterThanOrEqual(20);
    expect(result.state.phase.t).toBe('buy');
  });

  it('transfers when the holder passes another player', () => {
    const state = fresh();
    state.players[0].nodeId = 'c:tokyo';
    state.players[1].nodeId = 's:0-0';
    state.players[2].nodeId = 'c:london';
    state.destination = 'mumbai';
    state.destinationStartDistance = 20;
    state.piper = { holder: 0, level: 2, heldTurns: 13 };
    const options = reachableInExactly(data, 'c:tokyo', 2, null, 'c:mumbai');
    const option = options.find((o) => o.path.includes('s:0-0'));
    expect(option).toBeDefined();
    state.phase = { t: 'choose_dest', roll: 2, options: [option as MoveOption] };
    const result = step(data, state, 0, { t: 'move', nodeId: (option as MoveOption).nodeId });
    expect(result.state.piper.holder).toBe(1);
    // 2026-11 fun overhaul: すれ違いでは憑いた姿（フォルム）がそのまま移動する。
    expect(result.state.piper.level).toBe(2);
    expect(result.state.piper.heldTurns).toBe(1); // P1's turn started after the transfer
    expect(result.fx.some((f) => f.t === 'piper' && f.holder === 1)).toBe(true);
  });

  it('does not transfer when the mover is not the holder', () => {
    const state = fresh();
    state.players[0].nodeId = 'c:tokyo';
    state.players[1].nodeId = 's:0-0';
    state.destination = 'mumbai';
    state.piper = { holder: 2, level: 1, heldTurns: 0 };
    const option = reachableInExactly(data, 'c:tokyo', 2, null, 'c:mumbai').find((o) =>
      o.path.includes('s:0-0'),
    ) as MoveOption;
    state.phase = { t: 'choose_dest', roll: 2, options: [option] };
    const result = step(data, state, 0, { t: 'move', nodeId: option.nodeId });
    expect(result.state.piper.holder).toBe(2);
  });

  it('forcibly levels at 8 and 16 held turns', () => {
    expect(piperLevelForHeldTurns(7)).toBe(1);
    expect(piperLevelForHeldTurns(8)).toBe(2);
    expect(piperLevelForHeldTurns(15)).toBe(2);
    expect(piperLevelForHeldTurns(16)).toBe(3);
    const state = fresh([1, 1], 3, 12);
    state.current = 0;
    state.piper = { holder: 0, level: 1, heldTurns: 7 };
    const fx: Parameters<typeof runPiperTurnStart>[2] = [];
    const outcome = runPiperTurnStart(data, state, fx);
    expect(state.piper.heldTurns).toBe(8);
    expect(state.piper.level).toBe(2);
    expect(['continue', 'skip']).toContain(outcome);
  });
});

describe('cards', () => {
  it('express2 / express3 roll two / three dice', () => {
    for (const [cardId, count] of [
      ['express2', 2],
      ['express3', 3],
    ] as const) {
      const state = cardState(cardId);
      const result = step(data, state, 0, { t: 'use_card', cardId });
      const dice = result.fx.find((f) => f.t === 'dice');
      expect(dice?.t === 'dice' ? dice.values.length : 0).toBe(count);
      expect(result.state.players[0].cards).not.toContain(cardId);
      expect(result.state.phase.t).toBe('choose_dest');
    }
  });

  it('tariff takes 5% from everyone else', () => {
    const state = cardState('tariff');
    for (const p of state.players) p.cash = 100;
    const result = step(data, state, 0, { t: 'use_card', cardId: 'tariff' });
    expect(result.state.players[0].cash).toBe(110);
    expect(result.state.players[1].cash).toBe(95);
    expect(result.state.players[2].cash).toBe(95);
  });

  it('subsidy grants 40 × yearScale', () => {
    const state = cardState('subsidy');
    state.year = 2;
    const before = state.players[0].cash;
    const result = step(data, state, 0, { t: 'use_card', cardId: 'subsidy' });
    expect(result.state.players[0].cash).toBe(before + 54);
  });

  it('bailout splits the debt across the other players', () => {
    const state = cardState('bailout');
    state.players[0].cash = -50;
    state.players[1].cash = 100;
    state.players[2].cash = 100;
    const result = step(data, state, 0, { t: 'use_card', cardId: 'bailout' });
    expect(result.state.players[0].cash).toBe(0);
    expect(result.state.players[1].cash).toBe(75);
    expect(result.state.players[2].cash).toBe(75);
  });

  it('golden_egg pays 30% of annual property income', () => {
    const state = cardState('golden_egg');
    state.owner['tokyo-tower'] = 0;
    state.owner['tokyo-bank'] = 0;
    const income = annualIncome(data, state, 0);
    const before = state.players[0].cash;
    const result = step(data, state, 0, { t: 'use_card', cardId: 'golden_egg' });
    expect(result.state.players[0].cash).toBeCloseTo(before + income * 0.3);
  });

  it('stop skips the chosen player', () => {
    const state = cardState('stop');
    const used = step(data, state, 0, { t: 'use_card', cardId: 'stop' });
    expect(used.state.phase.t).toBe('card_target');
    const options = used.state.phase.t === 'card_target' ? used.state.phase.options : [];
    expect(options).toEqual(['1', '2']);
    const result = step(data, used.state, 0, { t: 'card_target', target: '1' });
    expect(result.fx.some((f) => f.t === 'skip' && f.playerId === 1)).toBe(false);
    expect(result.state.players[1].skipTurns).toBe(1);
    expect(result.state.phase.t).toBe('choose_dest');
    expect(result.state.current).toBe(0);
  });

  it('takeover forces a 1.5× purchase and transfers ownership', () => {
    const state = cardState('takeover');
    state.players[0].cash = 100;
    state.players[1].cash = 100;
    state.owner['tokyo-tower'] = 1;
    const used = step(data, state, 0, { t: 'use_card', cardId: 'takeover' });
    expect(used.state.phase.t).toBe('card_target');
    const options = used.state.phase.t === 'card_target' ? used.state.phase.options : [];
    expect(options).toContain('p:tokyo-tower');
    const result = step(data, used.state, 0, { t: 'card_target', target: 'p:tokyo-tower' });
    expect(result.state.owner['tokyo-tower']).toBe(0);
    expect(result.state.players[0].cash).toBe(40);
    expect(result.state.players[1].cash).toBe(160);
    expect(result.state.phase.t).toBe('choose_dest');
  });

  it('piper_pass moves the piper to the chosen player', () => {
    const state = cardState('piper_pass');
    state.piper = { holder: 0, level: 1, heldTurns: 4 };
    const used = step(data, state, 0, { t: 'use_card', cardId: 'piper_pass' });
    expect(used.state.phase.t).toBe('card_target');
    const result = step(data, used.state, 0, { t: 'card_target', target: '1' });
    expect(result.state.piper.holder).toBe(1);
    expect(result.state.phase.t).toBe('choose_dest');
  });

  it('pegasus warps to an airport and resolves landing', () => {
    const state = cardState('pegasus');
    state.destination = 'rio';
    const used = step(data, state, 0, { t: 'use_card', cardId: 'pegasus' });
    expect(used.state.phase.t).toBe('card_target');
    const options = used.state.phase.t === 'card_target' ? used.state.phase.options : [];
    const target = options.find((o) => o !== 'c:rio') as string;
    expect(target).toBeDefined();
    const result = step(data, used.state, 0, { t: 'card_target', target });
    expect(result.state.players[0].nodeId).toBe(target);
    expect(result.fx.some((f) => f.t === 'warp' && f.playerId === 0)).toBe(true);
    expect(result.state.phase.t).toBe('buy');
  });

  it('carpet warps 5–10 steps from the destination', () => {
    const state = cardState('carpet');
    const destNode = `c:${state.destination}`;
    const used = step(data, state, 0, { t: 'use_card', cardId: 'carpet' });
    expect(used.state.phase.t).toBe('card_target');
    const options = used.state.phase.t === 'card_target' ? used.state.phase.options : [];
    expect(options.length).toBeGreaterThan(0);
    const target = options[0];
    const d = shortestDistance(data, destNode, target);
    expect(d).toBeGreaterThanOrEqual(5);
    expect(d).toBeLessThanOrEqual(10);
    const result = step(data, used.state, 0, { t: 'card_target', target });
    expect(result.state.players[0].nodeId).toBe(target);
  });

  it('insider redraws a destination at least 20 steps away', () => {
    const state = cardState('insider');
    state.players[0].nodeId = 'c:london';
    state.destination = 'cairo';
    const result = step(data, state, 0, { t: 'use_card', cardId: 'insider' });
    expect(result.fx.some((f) => f.t === 'destination')).toBe(true);
    expect(result.state.destination).not.toBe('cairo');
    expect(result.state.destinationStartDistance ?? 0).toBeGreaterThanOrEqual(20);
  });

  it('shield cannot be played but is consumed automatically on red', () => {
    const state = cardState('shield');
    expect(() => step(data, state, 0, { t: 'use_card', cardId: 'shield' })).toThrowError(EngineError);
    // Put P0 on the red square next to Tokyo, then force a one-step move onto it.
    state.players[0].nodeId = 's:0-0';
    state.destination = 'mumbai';
    state.phase = { t: 'choose_dest', roll: 1, options: [{ nodeId: 's:0-1', path: ['s:0-1'] }] };
    const before = state.players[0].cash;
    const result = step(data, state, 0, { t: 'move', nodeId: 's:0-1' });
    expect(result.state.players[0].cards).not.toContain('shield');
    expect(result.state.players[0].cash).toBe(before);
    expect(result.fx.some((f) => f.t === 'card_use' && f.cardId === 'shield')).toBe(true);
  });

  it('cancelling a targeted card returns it to hand', () => {
    const state = cardState('stop');
    const used = step(data, state, 0, { t: 'use_card', cardId: 'stop' });
    expect(used.state.players[0].cards).not.toContain('stop');
    const cancelled = step(data, used.state, 0, { t: 'cancel' });
    expect(cancelled.state.players[0].cards).toContain('stop');
    expect(cancelled.state.phase.t).toBe('turn_start');
  });

  it('shield blocks an attack card automatically', () => {
    const state = cardState('stop');
    state.players[1].cards = ['shield'];
    const used = step(data, state, 0, { t: 'use_card', cardId: 'stop' });
    const result = step(data, used.state, 0, { t: 'card_target', target: '1' });
    expect(result.state.players[1].cards).not.toContain('shield');
    expect(result.state.players[1].skipTurns).toBe(0);
    expect(result.fx.some((f) => f.t === 'card_use' && f.cardId === 'shield')).toBe(true);
  });

  it('rejects losing cards that are not in hand', () => {
    const state = fresh();
    expect(() => step(data, state, 0, { t: 'use_card', cardId: 'subsidy' })).toThrowError(EngineError);
    expect(state.phase.t).toBe('turn_start');
  });
});