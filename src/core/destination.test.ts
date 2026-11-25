// Opt-in destination-distance harness. Skipped unless FABLE_SIM=1.
//
//   FABLE_SIM=1 npx vitest run src/core/destination.test.ts --silent=false
//
// Sol's playtest hit a 47-step destination and the race felt meaningless. Target:
// typical draws 20–35 steps, p95 at most ~40, while the 3-year sim still scores 5–8 goals.

import { describe, expect, it } from 'vitest';
import type { Fx, GameConfig, GameState } from './types';
import { actorOf, createGame, cpuDecide, step } from './engine';
import { GAME_DATA } from '../data/index';

const run = process.env.FABLE_SIM === '1' ? describe : describe.skip;
const SEEDS = Number(process.env.FABLE_DEST_SEEDS ?? 40);
const CHARACTERS = ['momotaro', 'sinbad', 'alice', 'red_hood'];

function config(seed: number): GameConfig {
  return {
    years: 3,
    seed,
    players: CHARACTERS.map((characterId, index) => ({
      name: `CPU${index + 1}`,
      characterId,
      isCpu: true,
      cpuLevel: 3 as const,
    })),
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
  return sorted[index];
}

function collect(state: GameState, fx: Fx[], out: number[]): void {
  if (fx.some((f) => f.t === 'destination')) out.push(state.destinationStartDistance ?? 0);
}

run('destination distance distribution (real data)', () => {
  it('reports the assignment distribution and goals per game', () => {
    const distances: number[] = [];
    const goals: number[] = [];
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const created = createGame(GAME_DATA, config(seed));
      let state = created.state;
      collect(state, created.fx, distances);
      let steps = 0;
      while (state.phase.t !== 'game_over') {
        const actor = actorOf(state);
        if (actor === null) throw new Error(`no actor in phase ${state.phase.t}`);
        const result = step(GAME_DATA, state, actor, cpuDecide(GAME_DATA, state));
        collect(result.state, result.fx, distances);
        state = result.state;
        steps += 1;
        if (steps > 1_000_000) throw new Error('simulation did not terminate');
      }
      goals.push(state.players.reduce((sum, p) => sum + p.goals, 0));
    }

    const sorted = [...distances].sort((a, b) => a - b);
    const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
    const histogram = new Map<string, number>();
    for (const value of sorted) {
      const bucket = `${Math.floor(value / 5) * 5}–${Math.floor(value / 5) * 5 + 4}`;
      histogram.set(bucket, (histogram.get(bucket) ?? 0) + 1);
    }
    const sortedGoals = [...goals].sort((a, b) => a - b);
    console.log(
      [
        `--- destination assignment: ${SEEDS} seeds × 3 years × 4× Lv3 (${sorted.length} draws) ---`,
        `mean ${mean.toFixed(1)} | p50 ${percentile(sorted, 0.5)} | p90 ${percentile(sorted, 0.9)} | p95 ${percentile(sorted, 0.95)} | max ${sorted[sorted.length - 1]}`,
        `histogram: ${[...histogram.entries()].sort().map(([bucket, n]) => `${bucket}:${n}`).join(' ')}`,
        `goals/game: median ${percentile(sortedGoals, 0.5)} | min ${sortedGoals[0]} | max ${sortedGoals[sortedGoals.length - 1]} (target 5–8)`,
      ].join('\n'),
    );

    expect(sorted.length).toBeGreaterThan(0);
    // Tuning guard: the long tail that made Sol's race feel hopeless is gone.
    expect(percentile(sorted, 0.95)).toBeLessThanOrEqual(42);
    expect(percentile(sorted, 0.5)).toBeGreaterThanOrEqual(18);
    expect(percentile(sorted, 0.5)).toBeLessThanOrEqual(36);
  }, 900_000);
});