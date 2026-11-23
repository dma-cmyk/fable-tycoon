// Real-data balance harness. Skipped unless FABLE_SIM=1 so the normal core suite stays fast
// and independent of concurrently generated JSON.
//
//   FABLE_SIM=1 npx vitest run src/core/sim.test.ts --reporter=verbose
//
// Target: 5–8 destination goals per 3-year, 4-player game.

import { describe, expect, it } from 'vitest';
import type { GameConfig, GameData, Fx, GameState } from './types';
import { actorOf, createGame, cpuDecide, netWorth, step } from './engine';
import { GAME_DATA } from '../data/index';

const RUN_REAL_DATA = process.env.FABLE_SIM === '1';
const realDescribe = RUN_REAL_DATA ? describe : describe.skip;
const SEEDS = 12;
const LEVELS: Array<1 | 2 | 3> = [1, 2, 3, 3];
const CHARACTERS = ['momotaro', 'sinbad', 'alice', 'red_hood'];

interface SimStats {
  goals: number;
  events: number;
  buys: number;
  destinationDistances: number[];
  finalNetWorth: Record<1 | 2 | 3, number[]>;
}

function config(seed: number): GameConfig {
  return {
    years: 3,
    seed,
    players: LEVELS.map((cpuLevel, i) => ({
      name: `CPU${i + 1}`,
      characterId: CHARACTERS[i],
      isCpu: true,
      cpuLevel,
    })),
  };
}

function collectDestination(state: GameState, fx: Fx[], out: number[]): void {
  if (fx.some((f) => f.t === 'destination')) {
    out.push(state.destinationStartDistance ?? 0);
  }
}

function runOne(data: GameData, seed: number): SimStats {
  const created = createGame(data, config(seed));
  let state = created.state;
  const stats: SimStats = {
    goals: 0,
    events: 0,
    buys: 0,
    destinationDistances: [],
    finalNetWorth: { 1: [], 2: [], 3: [] },
  };
  collectDestination(state, created.fx, stats.destinationDistances);
  for (const fx of created.fx) {
    if (fx.t === 'event_open') stats.events += 1;
    if (fx.t === 'buy') stats.buys += 1;
  }

  let steps = 0;
  while (state.phase.t !== 'game_over') {
    const actor = actorOf(state);
    if (actor === null) throw new Error(`no actor in phase ${state.phase.t}`);
    const result = step(data, state, actor, cpuDecide(data, state));
    collectDestination(result.state, result.fx, stats.destinationDistances);
    for (const fx of result.fx) {
      if (fx.t === 'event_open') stats.events += 1;
      if (fx.t === 'buy') stats.buys += 1;
    }
    state = result.state;
    steps += 1;
    if (steps > 1_000_000) throw new Error('simulation did not terminate');
  }

  stats.goals = state.players.reduce((sum, p) => sum + p.goals, 0);
  for (const player of state.players) {
    stats.finalNetWorth[player.cpuLevel].push(netWorth(data, state, player.id));
  }
  return stats;
}

realDescribe('real-data balance (FABLE_SIM=1)', () => {
  it(
    'runs 12 seeds × 3 years × 4 CPUs and prints balance metrics',
    () => {
      const boardCityIds = new Set(
        GAME_DATA.board.nodes.filter((n) => n.kind === 'city').map((n) => n.cityId),
      );
      const missing = GAME_DATA.cities.filter((c) => !boardCityIds.has(c.id)).map((c) => c.id);
      const data: GameData =
        missing.length === 0
          ? GAME_DATA
          : { ...GAME_DATA, cities: GAME_DATA.cities.filter((c) => boardCityIds.has(c.id)) };

      const all: SimStats[] = [];
      for (let seed = 1; seed <= SEEDS; seed += 1) all.push(runOne(data, seed));

      const avg = (xs: number[]): number =>
        xs.length === 0 ? 0 : Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100;
      const goalsPerGame = avg(all.map((s) => s.goals));
      const eventsPerGame = avg(all.map((s) => s.events));
      const buysPerGame = avg(all.map((s) => s.buys));
      const assignmentDistance = avg(all.flatMap((s) => s.destinationDistances));
      const byLevel = (level: 1 | 2 | 3): number =>
        avg(all.flatMap((s) => s.finalNetWorth[level]));

      console.log(
        [
          '--- real-data balance: 12 seeds × 3 years × 4 CPUs [Lv1,Lv2,Lv3,Lv3] ---',
          `cities=${data.cities.length}${missing.length > 0 ? ` (filtered missing board cities: ${missing.join(', ')})` : ''}`,
          `goals/game: ${goalsPerGame} (target 5–8)`,
          `events/game: ${eventsPerGame}`,
          `buys/game: ${buysPerGame}`,
          `avg distance at destination assignment: ${assignmentDistance}`,
          `avg final net worth Lv1: ${byLevel(1)}`,
          `avg final net worth Lv2: ${byLevel(2)}`,
          `avg final net worth Lv3: ${byLevel(3)}`,
        ].join('\n'),
      );

      expect(all).toHaveLength(SEEDS);
      expect(goalsPerGame).toBeGreaterThan(0);
      expect(Number.isFinite(assignmentDistance)).toBe(true);
      if (goalsPerGame < 5 || goalsPerGame > 8) {
        console.log(`WARN: goals/game ${goalsPerGame} is outside the 5–8 target.`);
      }
    },
    600_000,
  );
});