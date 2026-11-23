import { describe, expect, it } from 'vitest';
import type { GameConfig, GameData, Fx, GameState, StepResult } from './types';
import { fixtureData } from './test-fixture';
import {
  annualIncome,
  cpuDecide,
  createGame,
  distance,
  EngineError,
  netWorth,
  step,
} from './engine';
import { applyEffects, pickEvent, pickMonthlyEvent } from './events';
import { reachableInExactly, shortestDistance } from './graph';
import { randInt } from './rng';
import { isCardId } from './cards';
import { runPiperTurnStart } from './piper';
import { yearScale } from './economy';

const data: GameData = fixtureData;
const CHARACTERS = ['momotaro', 'sinbad', 'alice', 'red_hood'];

function config(levels: Array<1 | 2 | 3> = [1, 1, 1], years = 3, seed = 1): GameConfig {
  return {
    years,
    seed,
    players: levels.map((cpuLevel, i) => ({
      name: `P${i}`,
      characterId: CHARACTERS[i],
      isCpu: true,
      cpuLevel,
    })),
  };
}

function fresh(levels: Array<1 | 2 | 3> = [1, 1, 1], years = 3, seed = 1): GameState {
  const state = createGame(data, config(levels, years, seed)).state;
  state.phase = { t: 'turn_start' };
  state.pendingTurnStart = false;
  return state;
}

function cardState(cardId: string): GameState {
  const state = fresh();
  state.players[0].cards = [cardId];
  return state;
}

function moveOption(state: GameState, fromNodeId: string, path: string[], destination = 'rio') {
  state.current = 0;
  state.players[0].nodeId = fromNodeId;
  state.destination = destination;
  state.phase = {
    t: 'choose_dest',
    roll: path.length,
    options: [{ nodeId: path[path.length - 1], path }],
    dice: 1,
  };
  return state;
}

describe('destination range', () => {
  it('uses world cities in the 18–50 band', () => {
    for (let seed = 1; seed <= 20; seed += 1) {
      const state = createGame(data, config([1, 1], 3, seed)).state;
      const city = data.cities.find((c) => c.id === state.destination);
      expect(city?.realm).toBeUndefined();
      expect(state.destinationStartDistance ?? 0).toBeGreaterThanOrEqual(18);
      expect(state.destinationStartDistance ?? 0).toBeLessThanOrEqual(50);
    }
  });

  it('accepts 20-year games', () => {
    const state = createGame(data, config([1, 1], 20, 1)).state;
    expect(state.config.years).toBe(20);
  });
});

describe('shop squares', () => {
  function landedShop(): GameState {
    const state = fresh();
    moveOption(state, 'c:osaka', ['s:shop']);
    return step(data, state, 0, { t: 'move', nodeId: 's:shop' }).state;
  }

  it('landing opens a shop with five weighted cards', () => {
    const state = landedShop();
    expect(state.phase.t).toBe('shop');
    if (state.phase.t === 'shop') {
      expect(state.phase.stock).toHaveLength(5);
      for (const cardId of state.phase.stock) expect(isCardId(cardId)).toBe(true);
    }
  });

  it('buys at price × yearScale, rejects a full hand', () => {
    const state = landedShop();
    if (state.phase.t !== 'shop') throw new Error('expected shop');
    const cardId = state.phase.stock[0];
    const card = data.cards.find((c) => c.id === cardId);
    expect(card).toBeDefined();
    state.players[0].cash = 1000;
    state.year = 2;
    const before = state.players[0].cash;
    const stockBefore = state.phase.stock.length;
    const result = step(data, state, 0, { t: 'buy_card', cardId });
    expect(result.state.players[0].cards).toContain(cardId);
    expect(result.state.players[0].cash).toBeCloseTo(before - (card?.price ?? 0) * yearScale(state));
    if (result.state.phase.t === 'shop') expect(result.state.phase.stock).toHaveLength(stockBefore - 1);
    expect(result.fx.some((f) => f.t === 'card_get' && f.cardId === cardId)).toBe(true);

    const full = landedShop();
    full.players[0].cash = 1000;
    full.players[0].cards = Array.from({ length: 8 }, () => 'shield');
    if (full.phase.t !== 'shop') throw new Error('expected shop');
    try {
      step(data, full, 0, { t: 'buy_card', cardId: full.phase.stock[0] });
      throw new Error('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(EngineError);
      expect((error as EngineError).code).toBe('illegal');
    }
  });

  it('sells a card for half price and ends the visit', () => {
    const state = fresh();
    state.phase = { t: 'shop', stock: [] };
    state.players[0].cash = 0;
    state.players[0].cards = ['rocket'];
    const sold = step(data, state, 0, { t: 'sell_card', cardId: 'rocket' });
    expect(sold.state.players[0].cash).toBeCloseTo(50);
    expect(sold.state.players[0].cards).not.toContain('rocket');
    const ended = step(data, sold.state, 0, { t: 'end_shop' });
    expect(ended.state.current).toBe(1);
  });

  it('CPU buys piper_pass when it holds the piper and keeps a 30% reserve', () => {
    const state = fresh([1, 2, 1]);
    state.phase = { t: 'shop', stock: ['piper_pass', 'stop'] };
    state.piper = { holder: 0, level: 1, heldTurns: 0 };
    state.players[0].cash = 100;
    expect(cpuDecide(data, state)).toEqual({ t: 'buy_card', cardId: 'piper_pass' });
    state.players[0].cash = 40;
    expect(cpuDecide(data, state)).toEqual({ t: 'end_shop' });
  });
});

describe('movement backtracking', () => {
  it('allows stepping back to last turn’s previous node on a new move', () => {
    const state = fresh();
    state.players[0].nodeId = 'c:osaka';
    state.players[0].prevNodeId = 's:0-2';
    state.destination = 'mumbai';
    state.phase = { t: 'turn_start' };
    state.rng = 7; // randInt(1..6) => 1
    const rolled = step(data, state, 0, { t: 'roll' });
    expect(rolled.state.phase.t).toBe('choose_dest');
    if (rolled.state.phase.t === 'choose_dest') {
      expect(rolled.state.phase.roll).toBe(1);
      expect(rolled.state.phase.options.some((o) => o.nodeId === 's:0-2')).toBe(true);
    }
  });
});

describe('tornado / portal / realm movement', () => {
  it('warp square normally throws the player to a far world city', () => {
    const state = fresh();
    moveOption(state, 'c:shanghai', ['s:warp'], 'rio');
    state.rng = 1; // > 0.1, no realm detour
    const result = step(data, state, 0, { t: 'move', nodeId: 's:warp' });
    const warp = result.fx.find((f) => f.t === 'warp');
    expect(warp?.t === 'warp' ? warp.via : '').toBe('tornado');
    expect(shortestDistance(data, 'c:rio', result.state.players[0].nodeId)).toBeGreaterThan(15);
    expect(result.state.phase.t).toBe('buy');
  });

  it('warp square has 5% heaven and 5% hell outcomes', () => {
    const heaven = fresh();
    moveOption(heaven, 'c:shanghai', ['s:warp'], 'rio');
    heaven.rng = 7; // first mulberry value 0.0117
    const h = step(data, heaven, 0, { t: 'move', nodeId: 's:warp' });
    expect(h.state.players[0].nodeId).toBe('c:heaven-gate');
    expect(h.fx.some((f) => f.t === 'warp' && f.via === 'realm')).toBe(true);

    const hell = fresh();
    moveOption(hell, 'c:shanghai', ['s:warp'], 'rio');
    hell.rng = 19; // first mulberry value 0.0585
    const l = step(data, hell, 0, { t: 'move', nodeId: 's:warp' });
    expect(l.state.players[0].nodeId).toBe('c:hell-gate');
  });

  it('heaven portal exits to a city 5–10 steps from the destination', () => {
    const state = fresh();
    moveOption(state, 'c:heaven-estate', ['s:heaven-0', 's:heaven-1', 's:heaven-2', 's:heaven-portal'], 'tokyo');
    const result = step(data, state, 0, { t: 'move', nodeId: 's:heaven-portal' });
    expect(result.fx.some((f) => f.t === 'warp' && f.via === 'realm')).toBe(true);
    const node = result.state.players[0].nodeId;
    expect(data.cities.find((c) => `c:${c.id}` === node)?.realm).toBeUndefined();
    const d = shortestDistance(data, 'c:tokyo', node);
    expect(d).toBeGreaterThanOrEqual(5);
    expect(d).toBeLessThanOrEqual(10);
    expect(result.state.phase.t).toBe('buy');
  });

  it('space portal asks for an airport and CPU picks one', () => {
    const state = fresh();
    moveOption(
      state,
      'c:space-gate',
      ['c:space-moon', 's:space-0', 's:space-1', 's:space-2', 's:space-portal'],
      'rio',
    );
    const landed = step(data, state, 0, { t: 'move', nodeId: 's:space-portal' });
    expect(landed.state.phase.t).toBe('card_target');
    if (landed.state.phase.t === 'card_target') {
      expect(landed.state.phase.cardId).toBe('portal');
      expect(landed.state.phase.options.length).toBeGreaterThan(0);
      expect(landed.state.phase.options.every((o) => o.startsWith('c:'))).toBe(true);
      const target = cpuDecide(data, landed.state);
      expect(target.t).toBe('card_target');
      const chosen = step(data, landed.state, 0, target);
      expect(chosen.state.players[0].nodeId).toBe(
        target.t === 'card_target' ? target.target : '',
      );
      expect(chosen.fx.some((f) => f.t === 'warp' && f.via === 'realm')).toBe(true);
      expect(chosen.state.phase.t).toBe('buy');
    }
  });

  it('reachable movement stops at a portal', () => {
    const options = reachableInExactly(
      data,
      'c:heaven-estate',
      6,
      null,
      null,
      new Set(['s:heaven-portal']),
    );
    const portal = options.find((o) => o.nodeId === 's:heaven-portal');
    expect(portal).toBeDefined();
    expect(portal?.path).toHaveLength(2);
  });

  it('realm blue/red multipliers apply', () => {
    const heaven = fresh();
    moveOption(heaven, 'c:heaven-estate', ['s:heaven-0'], 'rio');
    heaven.rng = 1;
    const blueRoll = randInt({ rng: 1 }, 8, 20);
    const blue = step(data, heaven, 0, { t: 'move', nodeId: 's:heaven-0' });
    const blueCash = blue.fx.find((f) => f.t === 'cash' && f.reason === '青マス');
    expect(blueCash?.t === 'cash' ? blueCash.delta : 0).toBe(blueRoll * 3);

    const hell = fresh();
    moveOption(hell, 'c:hell-tax', ['s:hell-0', 's:hell-1'], 'rio');
    hell.rng = 1;
    const redRoll = randInt({ rng: 1 }, 5, 15);
    const red = step(data, hell, 0, { t: 'move', nodeId: 's:hell-1' });
    const redCash = red.fx.find((f) => f.t === 'cash' && f.reason === '赤マス');
    expect(redCash?.t === 'cash' ? redCash.delta : 0).toBe(-redRoll * 3);
  });

  it('realm properties count for income, monopoly and net worth', () => {
    const state = fresh();
    state.owner['heaven-mansion'] = 0;
    expect(annualIncome(data, state, 0)).toBeCloseTo(160);
    expect(netWorth(data, state, 0)).toBeCloseTo(900);
  });

  it('realm distance is steps to portal + 20 and raw BFS stays Infinity', () => {
    expect(shortestDistance(data, 'c:heaven-gate', 'c:tokyo')).toBe(Infinity);
    expect(distance(data, 'c:heaven-gate', 'c:tokyo')).toBe(21);
    expect(distance(data, 'c:tokyo', 'c:heaven-gate')).toBe(20);
    // Direction matters: piper assignment starts from the player's realm position.
    expect(distance(data, 'c:heaven-estate', 'c:tokyo')).toBe(22);
    expect(distance(data, 'c:tokyo', 'c:heaven-estate')).toBe(21);
  });

  it('realm effect op warps to the gate and back to a world city', () => {
    const state = fresh();
    const fx: Fx[] = [];
    applyEffects(data, state, fx, [{ op: 'realm', who: 'self', realm: 'heaven' }], 0);
    expect(state.players[0].nodeId).toBe('c:heaven-gate');
    expect(fx.some((f) => f.t === 'warp' && f.via === 'realm')).toBe(true);
    applyEffects(data, state, fx, [{ op: 'realm', who: 'self', realm: 'world' }], 0);
    expect(data.cities.find((c) => `c:${c.id}` === state.players[0].nodeId)?.realm).toBeUndefined();
  });

  it('king piper can drag the holder to hell', () => {
    const state = fresh([1, 1], 3, 5);
    state.current = 0;
    state.piper = { holder: 0, level: 2, heldTurns: 23 };
    state.rng = 7;
    const fx: Fx[] = [];
    const outcome = runPiperTurnStart(data, state, fx);
    expect(state.piper.level).toBe(3);
    expect(state.players[0].nodeId).toBe('c:hell-gate');
    expect(outcome).toBe('continue');
    expect(fx.some((f) => f.t === 'warp' && f.via === 'realm')).toBe(true);
  });

  it('third goal sends the player to heaven after the new destination is drawn', () => {
    const state = fresh();
    state.players[0].nodeId = 'c:tokyo';
    state.players[0].goals = 2;
    state.destination = 'osaka';
    state.destinationStartDistance = 4;
    const option = reachableInExactly(data, 'c:tokyo', 4, null, 'c:osaka').find(
      (o) => o.nodeId === 'c:osaka',
    ) as { nodeId: string; path: string[] };
    state.phase = { t: 'choose_dest', roll: 4, options: [option], dice: 1 };
    const result = step(data, state, 0, { t: 'move', nodeId: 'c:osaka' });
    expect(result.state.players[0].goals).toBe(3);
    expect(result.state.players[0].nodeId).toBe('c:heaven-gate');
    expect(result.fx.some((f) => f.t === 'warp' && f.via === 'realm')).toBe(true);
    expect(result.fx.some((f) => f.t === 'toast')).toBe(true);
    expect(result.state.phase.t).toBe('buy');
  });
});

describe('rocket card, dice and via fields', () => {
  it('rocket offers every world city plus the space option', () => {
    const state = cardState('rocket');
    state.destination = 'rio';
    const used = step(data, state, 0, { t: 'use_card', cardId: 'rocket' });
    expect(used.state.phase.t).toBe('card_target');
    if (used.state.phase.t === 'card_target') {
      const world = data.cities.filter((c) => c.realm === undefined);
      expect(used.state.phase.options).toContain('r:space');
      for (const city of world) expect(used.state.phase.options).toContain(`c:${city.id}`);
      expect(used.state.phase.options).toHaveLength(world.length + 1);
    }
  });

  it('rocket warps to the chosen world city or space', () => {
    const state = cardState('rocket');
    state.destination = 'rio';
    const used = step(data, state, 0, { t: 'use_card', cardId: 'rocket' });
    const chosen = step(data, used.state, 0, { t: 'card_target', target: 'c:rio' });
    expect(chosen.state.players[0].nodeId).toBe('c:rio');
    expect(chosen.fx.some((f) => f.t === 'warp' && f.via === 'rocket')).toBe(true);

    const space = cardState('rocket');
    const usedSpace = step(data, space, 0, { t: 'use_card', cardId: 'rocket' });
    const toSpace = step(data, usedSpace.state, 0, { t: 'card_target', target: 'r:space' });
    expect(toSpace.state.players[0].nodeId).toBe('c:space-gate');
    expect(toSpace.fx.some((f) => f.t === 'warp' && f.via === 'rocket')).toBe(true);
    expect(toSpace.state.phase.t).toBe('buy');
  });

  it('CPU rocket target minimizes distance to destination', () => {
    const state = fresh([1, 2, 1]);
    state.phase = { t: 'card_target', cardId: 'rocket', options: ['c:tokyo', 'c:osaka'] };
    state.destination = 'osaka';
    expect(cpuDecide(data, state)).toEqual({ t: 'card_target', target: 'c:osaka' });
  });

  it('CPU values marginal settlement income, not raw yield/price', () => {
    const state = fresh([3, 1, 1]);
    state.phase = { t: 'buy', cityId: 'shanghai' };
    state.players[0].cash = 100;
    state.industryMods = [{ industry: 'tech', mult: 2, yearsLeft: 2, label: 'AI' }];
    expect(cpuDecide(data, state)).toEqual({ t: 'buy', propertyId: 'shanghai-tech' });
  });

  it('move fx carries dice count for normal and express moves', () => {
    const normal = fresh();
    const rolled = step(data, normal, 0, { t: 'roll' });
    expect(rolled.state.phase.t).toBe('choose_dest');
    if (rolled.state.phase.t === 'choose_dest') {
      const option = rolled.state.phase.options[0];
      const moved = step(data, rolled.state, 0, { t: 'move', nodeId: option.nodeId });
      const move = moved.fx.find((f) => f.t === 'move');
      expect(move?.t === 'move' ? move.dice : 0).toBe(1);
    }

    for (const [cardId, count] of [
      ['express2', 2],
      ['express3', 3],
    ] as const) {
      const state = cardState(cardId);
      const used = step(data, state, 0, { t: 'use_card', cardId });
      expect(used.state.phase.t).toBe('choose_dest');
      if (used.state.phase.t === 'choose_dest') {
        expect(used.state.phase.dice).toBe(count);
        const option = used.state.phase.options[0];
        const moved = step(data, used.state, 0, { t: 'move', nodeId: option.nodeId });
        const move = moved.fx.find((f) => f.t === 'move');
        expect(move?.t === 'move' ? move.dice : 0).toBe(count);
      }
    }
  });

  it('vehicle cards emit plane/carpet/event via values', () => {
    const plane = cardState('pegasus');
    plane.destination = 'rio';
    const usedPlane = step(data, plane, 0, { t: 'use_card', cardId: 'pegasus' });
    if (usedPlane.state.phase.t === 'card_target') {
      const target = usedPlane.state.phase.options.find((o) => o !== 'c:rio') as string;
      const result = step(data, usedPlane.state, 0, { t: 'card_target', target });
      expect(result.fx.some((f) => f.t === 'warp' && f.via === 'plane')).toBe(true);
    }

    const carpet = cardState('carpet');
    carpet.destination = 'rio';
    const usedCarpet = step(data, carpet, 0, { t: 'use_card', cardId: 'carpet' });
    if (usedCarpet.state.phase.t === 'card_target') {
      const target = usedCarpet.state.phase.options[0];
      const result = step(data, usedCarpet.state, 0, { t: 'card_target', target });
      expect(result.fx.some((f) => f.t === 'warp' && f.via === 'carpet')).toBe(true);
    }

    const event = fresh();
    const fx: Fx[] = [];
    applyEffects(data, event, fx, [{ op: 'move', who: 'self', to: 'random_city' }], 0);
    expect(fx.some((f) => f.t === 'warp' && f.via === 'event')).toBe(true);
  });
});

describe('monthly events', () => {
  it('filters monthly candidates by months', () => {
    const clone = structuredClone(data);
    const base = data.events[0];
    clone.events = [
      {
        ...base,
        id: 'ev-monthly-april',
        monthly: true,
        months: [4],
        weight: 100,
        choices: undefined,
        lines: [{ speaker: 'narrator', text: 'April.' }],
        effects: [],
      },
    ];
    const state = fresh();
    state.month = 4;
    expect(pickMonthlyEvent(clone, state)?.id).toBe('ev-monthly-april');
    state.month = 1;
    expect(pickMonthlyEvent(clone, state)).toBeNull();
  });

  it('game-start monthly event pauses and then resumes the first turn', () => {
    const clone = structuredClone(data);
    const base = data.events[0];
    clone.events = [
      {
        ...base,
        id: 'ev-monthly-test',
        monthly: true,
        months: [4],
        weight: 100,
        lines: [{ speaker: 'narrator', text: 'Monthly test.' }],
        choices: [
          {
            label: 'accept',
            detail: '+5',
            effects: [{ op: 'cash', who: 'self', amount: 5, scale: false }],
            reply: [{ speaker: 'narrator', text: 'Accepted.' }],
          },
        ],
        effects: undefined,
      },
    ];
    let found: StepResult | null = null;
    for (let seed = 1; seed <= 80 && found === null; seed += 1) {
      const game = createGame(clone, config([1, 1], 1, seed));
      if (game.state.phase.t === 'event' && game.state.activeEventId === 'ev-monthly-test') {
        found = game;
      }
    }
    expect(found).not.toBeNull();
    if (!found) return;
    expect(found.state.pendingTurnStart).toBe(true);
    expect(found.state.current).toBe(0);
    expect(found.fx.some((f) => f.t === 'event_open')).toBe(true);
    const chosen = step(clone, found.state, 0, { t: 'choose', index: 0 });
    expect(chosen.state.phase.t).toBe('turn_start');
    expect(chosen.state.current).toBe(0);
    expect(chosen.state.pendingTurnStart).toBe(false);
    expect(chosen.fx.some((f) => f.t === 'event_close')).toBe(true);
    expect(chosen.state.players[0].cash).toBeCloseTo(105);
  });

  it('news events respect months', () => {
    const clone = structuredClone(data);
    const base = data.events[0];
    clone.events = [
      { ...base, id: 'ev-jan', months: [1], monthly: false },
      { ...base, id: 'ev-apr', months: [4], monthly: false },
    ];
    const state = fresh();
    state.month = 4;
    expect(pickEvent(clone, state, 'world')?.id).toBe('ev-apr');
    state.month = 1;
    expect(pickEvent(clone, state, 'world')?.id).toBe('ev-jan');
    state.month = 8;
    expect(pickEvent(clone, state, 'world')).toBeNull();
  });

  it('news events filter by realm', () => {
    const clone = structuredClone(data);
    const base = data.events[0];
    clone.events = [
      { ...base, id: 'ev-world', realms: ['world'], monthly: false },
      { ...base, id: 'ev-hell', realms: ['hell'], monthly: false },
      { ...base, id: 'ev-any-world', realms: undefined, monthly: false },
    ];
    const state = fresh();
    expect(pickEvent(clone, state, 'hell')?.id).toBe('ev-hell');
    expect(pickEvent(clone, state, 'heaven')).toBeNull();
    const world = pickEvent(clone, state, 'world');
    expect(['ev-world', 'ev-any-world']).toContain(world?.id);
  });
});