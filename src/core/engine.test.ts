import { describe, expect, it } from 'vitest';
import type { Action, GameConfig, GameData, GameState, Phase } from './types';
import { fixtureData } from './test-fixture';
import {
  ALLOWED_YEARS,
  actorOf,
  cpuDecide,
  annualIncome,
  createGame,
  currentPrice,
  EngineError,
  netWorth,
  sanitizeState,
  step,
  withSeed,
} from './engine';

const data: GameData = fixtureData;

function config(levels: Array<1 | 2 | 3>, years: number, seed: number): GameConfig {
  const characters = ['momotaro', 'sinbad', 'alice', 'red_hood'];
  return {
    years,
    seed,
    players: levels.map((cpuLevel, i) => ({
      name: `CPU${i + 1}`,
      characterId: characters[i],
      isCpu: true,
      cpuLevel,
    })),
  };
}

interface RunResult {
  state: GameState;
  steps: number;
  phasesSeen: Set<Phase['t']>;
}

function play(levels: Array<1 | 2 | 3>, years: number, seed: number): RunResult {
  let state = createGame(data, config(levels, years, seed)).state;
  const phasesSeen = new Set<Phase['t']>();
  let steps = 0;
  while (state.phase.t !== 'game_over') {
    phasesSeen.add(state.phase.t);
    const actor = actorOf(state);
    expect(actor, `actor missing in phase ${state.phase.t}`).not.toBeNull();
    expect(Number.isInteger(actor)).toBe(true);
    const action: Action = cpuDecide(data, state);
    let result;
    try {
      result = step(data, state, actor as number, action);
    } catch (error) {
      throw new Error(
        `cpuDecide/step failed in phase ${state.phase.t} with ${JSON.stringify(action)}: ${String(error)}`,
      );
    }
    for (const player of result.state.players) {
      expect(Number.isFinite(player.cash), 'cash must never be NaN/Infinity').toBe(true);
    }
    state = result.state;
    steps += 1;
    if (steps > 50000) throw new Error('simulation did not terminate');
  }
  phasesSeen.add('game_over');
  return { state, steps, phasesSeen };
}

function validateOwners(state: GameState): void {
  const propertyOwner = new Map<string, string>();
  for (const city of data.cities) {
    for (const property of city.properties) {
      propertyOwner.set(property.id, city.id);
    }
  }
  for (const [propertyId, owner] of Object.entries(state.owner)) {
    expect(propertyOwner.has(propertyId), `unknown property id ${propertyId}`).toBe(true);
    expect(owner).toBeGreaterThanOrEqual(0);
    expect(owner).toBeLessThan(state.players.length);
  }
}

describe('engine full simulation', () => {
  it('runs 4 CPUs (levels 1,2,3,3) × 3 years × 30 seeds to game_over', () => {
    const byLevel: Record<number, number[]> = { 1: [], 2: [], 3: [] };
    let roundsTotal = 0;
    let goalsTotal = 0;
    let playerCount = 0;
    const allPhases = new Set<Phase['t']>();
    const levels: Array<1 | 2 | 3> = [1, 2, 3, 3];

    for (let seed = 1; seed <= 30; seed += 1) {
      const { state, phasesSeen } = play(levels, 3, seed);
      expect(state.phase.t).toBe('game_over');
      expect(state.year).toBe(3);
      expect(state.month).toBe(3);
      expect(state.round).toBe(36);
      expect(state.phase.t === 'game_over' ? state.phase.ranking.length : 0).toBe(4);
      validateOwners(state);
      for (const phase of phasesSeen) allPhases.add(phase);
      for (const player of state.players) {
        byLevel[player.cpuLevel].push(netWorth(data, state, player.id));
        goalsTotal += player.goals;
        playerCount += 1;
      }
      roundsTotal += state.round;
    }

    const average = (xs: number[]): number =>
      xs.length === 0 ? 0 : Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10;
    // Balance printout required by the acceptance criteria.
    console.log(
      [
        '--- balance: 30 seeds × 3 years × [Lv1,Lv2,Lv3,Lv3] ---',
        `avg final net worth Lv1: ${average(byLevel[1])}`,
        `avg final net worth Lv2: ${average(byLevel[2])}`,
        `avg final net worth Lv3: ${average(byLevel[3])}`,
        `avg rounds: ${Math.round((roundsTotal / 30) * 10) / 10}`,
        `avg goals/player: ${Math.round((goalsTotal / playerCount) * 100) / 100}`,
        `phases seen: ${[...allPhases].sort().join(', ')}`,
      ].join('\n'),
    );
    expect(allPhases.size).toBeGreaterThan(0);
    for (const tag of [
      'turn_start',
      'choose_dest',
      'buy',
      'event',
      'card_target',
      'discard',
      'sell',
      'year_end',
      'game_over',
    ] as Phase['t'][]) {
      expect(allPhases.has(tag), `phase ${tag} should be reachable`).toBe(true);
    }
  });

  it('runs 1 year with 2 players to game_over', () => {
    const { state, phasesSeen } = play([2, 3], 1, 7);
    expect(state.phase.t).toBe('game_over');
    expect(state.players).toHaveLength(2);
    expect(state.round).toBe(12);
    expect(state.month).toBe(3);
    expect(phasesSeen.has('year_end')).toBe(true);
    console.log('one-year phases:', [...phasesSeen].sort().join(', '));
  });

  it('is deterministic for a seed and transitions identically', () => {
    const a = play([1, 2, 3, 3], 3, 4242);
    const b = play([1, 2, 3, 3], 3, 4242);
    expect(a.steps).toBe(b.steps);
    expect(JSON.parse(JSON.stringify(a.state))).toEqual(JSON.parse(JSON.stringify(b.state)));
    const c = createGame(data, config([1, 2, 3, 3], 3, 4242));
    const d = createGame(data, config([1, 2, 3, 3], 3, 4242));
    expect(c.state).toEqual(d.state);
    expect(c.fx).toEqual(d.fx);
  });
});

describe('step rejection and immutability', () => {
  it('exports and enforces the allowed year options', () => {
    expect(ALLOWED_YEARS).toEqual([1, 3, 5, 10, 20]);
    expect(() => createGame(data, config([1, 2], 2, 1))).toThrowError(EngineError);
  });

  it('rejects a wrong player, an illegal action and a stale phase', () => {
    const game = createGame(data, config([1, 2], 1, 99));
    const state = game.state;
    expect(actorOf(state)).toBe(0);
    expect(() => step(data, state, 1, { t: 'roll' })).toThrowError(EngineError);
    try {
      step(data, state, 1, { t: 'roll' });
    } catch (error) {
      expect((error as EngineError).code).toBe('not_your_turn');
    }
    try {
      step(data, state, 0, { t: 'ack' });
      throw new Error('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(EngineError);
      expect((error as EngineError).code).toBe('illegal');
    }
    const rolled = step(data, state, 0, { t: 'roll' });
    expect(rolled.state.phase.t).toBe('choose_dest');
    try {
      step(data, rolled.state, 0, { t: 'roll' });
      throw new Error('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(EngineError);
      expect((error as EngineError).code).toBe('illegal');
    }
    try {
      step(data, rolled.state, 0, { t: 'move', nodeId: 's:nonexistent' });
      throw new Error('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(EngineError);
      expect((error as EngineError).code).toBe('illegal');
    }
  });

  it('never mutates the input state and returns JSON-serialisable state', () => {
    const game = createGame(data, config([1, 2, 3, 3], 1, 5));
    const before = JSON.stringify(game.state);
    const result = step(data, game.state, 0, { t: 'roll' });
    expect(JSON.stringify(game.state)).toBe(before);
    expect(JSON.parse(JSON.stringify(result.state))).toEqual(result.state);
    expect(result.state).not.toBe(game.state);
  });

  it('auto-advances players with skipTurns and emits skip fx', () => {
    const state = createGame(data, config([1, 1, 1], 1, 33)).state;
    state.current = 0;
    state.phase = { t: 'buy', cityId: 'osaka' };
    state.players[1].skipTurns = 1;
    const result = step(data, state, 0, { t: 'end_buy' });
    expect(result.fx.some((f) => f.t === 'skip' && f.playerId === 1)).toBe(true);
    expect(result.state.players[1].skipTurns).toBe(0);
    expect(result.state.current).toBe(2);
    expect(result.state.phase.t).toBe('turn_start');
  });

  it('waits for ack at year_end and emits month/year_end/game_over fx', () => {
    let state = createGame(data, config([2, 3], 1, 21)).state;
    const allFx: string[] = [];
    let guard = 0;
    while (state.phase.t !== 'year_end') {
      const actor = actorOf(state);
      expect(actor).not.toBeNull();
      const result = step(data, state, actor as number, cpuDecide(data, state));
      allFx.push(...result.fx.map((f) => f.t));
      state = result.state;
      guard += 1;
      if (guard > 10000) throw new Error('year did not end');
    }
    expect(state.phase.t).toBe('year_end');
    expect(actorOf(state)).toBe(0);
    expect(state.phase.t === 'year_end' ? state.phase.report.income : []).toHaveLength(2);
    expect(() => step(data, state, 1, { t: 'ack' })).toThrowError(EngineError);
    const acked = step(data, state, 0, { t: 'ack' });
    expect(acked.state.phase.t).toBe('game_over');
    expect(actorOf(acked.state)).toBeNull();
    expect(acked.fx.some((f) => f.t === 'game_over')).toBe(true);
    expect(allFx).toContain('year_end');
    expect(allFx).toContain('month');
    expect(allFx).toContain('turn');
    expect(allFx).toContain('dice');
    expect(allFx).toContain('move');
    expect(allFx).toContain('cash');
    expect(allFx).toContain('say');
    expect(allFx).toContain('destination');
  });

  it('sanitizeState removes rng and seed without touching the original', () => {
    const game = createGame(data, config([1, 2], 1, 11));
    expect('seed' in game.state.config).toBe(false);
    game.state.config.seed = 987654;
    const before = JSON.stringify(game.state);
    const pub = sanitizeState(game.state);
    expect('rng' in pub).toBe(false);
    expect('seed' in pub.config).toBe(false);
    const serialized = JSON.stringify(pub);
    expect(serialized).not.toContain('"rng"');
    expect(serialized).not.toContain('"seed"');
    expect(JSON.stringify(game.state)).toBe(before);
    expect(pub.players).toEqual(game.state.players);
    expect(pub).not.toBe(game.state);
    expect(actorOf(pub)).toBe(0);
    expect(netWorth(data, pub, 0)).toBe(netWorth(data, game.state, 0));
    expect(currentPrice(data, pub, 'tokyo-tower')).toBe(currentPrice(data, game.state, 'tokyo-tower'));
    expect(annualIncome(data, pub, 0)).toBe(annualIncome(data, game.state, 0));
  });

  it('withSeed re-seeds without storing a seed in config', () => {
    const game = createGame(data, config([1, 2], 1, 12));
    const reseeded = withSeed(game.state, 777);
    expect(reseeded.rng).toBe(777);
    expect('seed' in reseeded.config).toBe(false);
    expect(game.state.rng).not.toBe(777);
  });
});