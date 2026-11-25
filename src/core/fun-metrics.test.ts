// Opt-in "fun" metrics over CPU-only games (Lv3 ×4, 3 years). Skipped unless FABLE_SIM=1.
//
//   FABLE_SIM=1 npx vitest run src/core/fun-metrics.test.ts --silent=false
//
// Baseline before the fun overhaul (2026-11-26, HEAD fb8f559, 30 seeds, medians):
//   leadChanges 4, piperTransfers 8, goals 7, monopolies 4, winner/2nd 1.32, winner/last 3.47,
//   y1 leader wins 17/30, piper damage ≈ 6% of settlement income, takeover cards 0.0/game.
// Targets of the overhaul: y1 leader wins ≤ 12/30, leadChanges ≥ 6, piper level 3 seen in most games,
// piper damage 15–30% of settlement income, ≥ 1 buyout and ≥ 3 skills per game.

import { describe, it } from 'vitest';
import type { Fx, GameState } from './types';
import { actorOf, createGame, cpuDecide, netWorth, step } from './engine';
import { GAME_DATA } from '../data/index';

const run = process.env.FABLE_SIM === '1' ? describe : describe.skip;
const SEEDS = 30;

run('fun metrics (real data)', () => {
  it('reports lead changes, interaction and swings', () => {
    const data = GAME_DATA;
    const perGame: Record<string, number[]> = {};
    const record = (key: string, value: number) => (perGame[key] ??= []).push(value);
    const cashByReason: Record<string, number> = {};
    let y1LeaderWins = 0;
    let gamesWithKing = 0;

    for (let seed = 1; seed <= SEEDS; seed++) {
      const created = createGame(data, {
        years: 3,
        seed,
        players: ['momotaro', 'sinbad', 'alice', 'red_hood'].map((characterId, i) => ({
          name: `P${i}`,
          characterId,
          isCpu: true,
          cpuLevel: 3 as const,
        })),
      });
      let state: GameState = created.state;
      const counts: Record<string, number> = {};
      let leader = -1;
      let leadChanges = 0;
      let month = 0;
      let y1Leader = -1;
      let lastHolder: number | null = null;
      let piperTransfers = 0;
      let sawKing = false;
      let piperDamage = 0;
      let settlementIncome = 0;
      let piperGifts = 0;

      const handle = (fx: Fx[]) => {
        for (const f of fx) {
          counts[f.t] = (counts[f.t] ?? 0) + 1;
          if (f.t === 'card_use') counts[`card:${f.cardId}`] = (counts[`card:${f.cardId}`] ?? 0) + 1;
          if (f.t === 'card_get') counts[`card_get:${f.cardId}`] = (counts[`card_get:${f.cardId}`] ?? 0) + 1;
          if (f.t === 'cash') {
            const reason = f.reason.replace(/[0-9０-９.]+/g, '#').slice(0, 20);
            cashByReason[reason] = (cashByReason[reason] ?? 0) + Math.abs(f.delta);
            if (f.reason === '取り立て') piperDamage += Math.abs(f.delta);
            if (f.reason === '決算' && f.delta > 0) settlementIncome += f.delta;
          }
          if (f.t === 'piper_disaster') piperDamage += f.amount;
          if (f.t === 'piper_gift') piperGifts += 1;
          if (f.t === 'piper') {
            if (lastHolder !== null && f.holder !== null && f.holder !== lastHolder) piperTransfers++;
            lastHolder = f.holder;
            if (f.level === 3) sawKing = true;
          }
          if (f.t === 'piper_roulette' && f.to === 3) sawKing = true;
          if (f.t === 'buy' && f.monopoly) counts.monopoly = (counts.monopoly ?? 0) + 1;
          if (f.t === 'month') {
            month++;
            const worth = state.players.map((p) => netWorth(data, state, p.id));
            const top = worth.indexOf(Math.max(...worth));
            if (leader !== -1 && top !== leader) leadChanges++;
            leader = top;
            if (month === 12) y1Leader = top;
          }
        }
      };

      handle(created.fx);
      let steps = 0;
      while (state.phase.t !== 'game_over') {
        const actor = actorOf(state);
        if (actor === null) throw new Error(`no actor in phase ${state.phase.t}`);
        const result = step(data, state, actor, cpuDecide(data, state));
        state = result.state;
        handle(result.fx);
        if (++steps > 500_000) throw new Error('simulation did not terminate');
      }

      const worth = state.players.map((p) => netWorth(data, state, p.id));
      const sorted = [...worth].sort((a, b) => b - a);
      if (worth.indexOf(sorted[0]) === y1Leader) y1LeaderWins++;
      if (sawKing) gamesWithKing++;
      record('leadChanges', leadChanges);
      record('piperTransfers', piperTransfers);
      record('goals', counts.goal ?? 0);
      record('monopolies', counts.monopoly ?? 0);
      record('buyouts', counts.buyout ?? 0);
      record('skills', counts.skill ?? 0);
      record('piperDisasters', counts.piper_disaster ?? 0);
      record('piperGifts', piperGifts);
      record('piperSharePct', settlementIncome > 0 ? (piperDamage / settlementIncome) * 100 : 0);
      record('cityMods', counts.city_mod ?? 0);
      record('events', counts.event_open ?? 0);
      record('takeoverCards', counts['card:takeover'] ?? 0);
      record('underdogUses', counts['card:underdog'] ?? 0);
      record('underdogGrants', counts['card_get:underdog'] ?? 0);
      record('finalYears', counts.final_year ?? 0);
      record('negativeWorth', worth.filter((value) => value < 0).length);
      record('winnerOver2nd', sorted[0] / Math.max(1, sorted[1]));
      record('winnerOverLast', sorted[0] / Math.max(1, sorted[sorted.length - 1]));
    }

    const median = (values: number[]) => [...values].sort((a, b) => a - b)[values.length >> 1];
    for (const [key, values] of Object.entries(perGame)) {
      console.log(`${key}: median ${median(values).toFixed(2)} min ${Math.min(...values).toFixed(2)} max ${Math.max(...values).toFixed(2)}`);
    }
    console.log(`y1 leader wins ${y1LeaderWins}/${SEEDS}, games with king ${gamesWithKing}/${SEEDS}`);
    console.log(
      'cash by reason per game:',
      Object.entries(cashByReason)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 16)
        .map(([reason, total]) => `${reason} ${(total / SEEDS).toFixed(0)}`)
        .join(' | '),
    );
  }, 900_000);
});
