// Deterministic pacing rules for CPU routine fx — the single source of truth for both sides:
//
//  - the HOST (`RoomController.armTurn`) divides the budget it schedules CPU actions by;
//  - the CLIENT (`FxPlayer` via `src/ui/cpuPacing.ts`) multiplies its playback speed by.
//
// Keeping one pure function here is what prevents the two from drifting apart. Everything the
// human might act on is deliberately absent from these tables: goals, piper fx, buyouts,
// events, skills, city mods, the final year, monopolies and any cash change of a human stay at
// the nominal budget / chosen playback speed.

import type { Fx, LineKey } from './types';

/** How much faster a routine CPU fx plays, and how much shorter its host budget is. */
export const CPU_ROUTINE_BOOST = 3;

/**
 * Character lines a CPU may deliver without the human having to read along.
 * `goal`, `monopoly`, `piper_*`, `skill`, `win` and `lose` are deliberately absent: those
 * are the beats the human is playing for.
 */
const ROUTINE_LINE_KEYS: Partial<Record<LineKey, true>> = {
  turn: true,
  buy: true,
  blue: true,
  red: true,
  card: true,
};

/**
 * Cash reasons that are pure bookkeeping for the CPU. Transfers (`スリ`, `肩代わり`,
 * `敵対的買収`, `決算`, `目的地ボーナス`, …) are absent: they either touch the human or are
 * the payoff of a beat that should land.
 */
const ROUTINE_CASH_REASONS: Record<string, true> = {
  青マス: true,
  赤マス: true,
  物件購入: true,
  カード購入: true,
  カード売却: true,
};

export interface FxPacingContext {
  /** Seat whose turn is being presented (latest `turn` fx / the acting player of the step). */
  actor: number | null;
  /** Whether a player id is a CPU. */
  isCpu: (playerId: number | null | undefined) => boolean;
}

/**
 * A `say` fx that can play briefly: the text still reaches the message window and the log,
 * just without the voice wait. Speaker must be the acting CPU itself, so victim/reaction
 * lines (piper_get on someone else, event replies) keep their presentation.
 */
export function isRoutineCpuSay(fx: Extract<Fx, { t: 'say' }>, ctx: FxPacingContext): boolean {
  if (fx.lineKey === undefined || ROUTINE_LINE_KEYS[fx.lineKey] !== true) return false;
  return ctx.isCpu(fx.playerId);
}

/**
 * True when the fx is a CPU's routine bookkeeping and can be painted faster / budgeted shorter.
 * The actor is required for `dice` / `move` / `toast`, which carry no playerId of their own.
 */
export function isRoutineCpuFx(fx: Fx, ctx: FxPacingContext): boolean {
  switch (fx.t) {
    case 'turn':
      return ctx.isCpu(fx.playerId);
    case 'dice':
    case 'move':
      return ctx.isCpu(ctx.actor);
    case 'say':
      return isRoutineCpuSay(fx, ctx);
    case 'cash':
      // The human's own ledger always lands at the normal speed / budget.
      return ROUTINE_CASH_REASONS[fx.reason] === true && ctx.isCpu(fx.playerId);
    case 'buy':
      // A monopoly flips the income race; keep its beat at normal speed.
      return !fx.monopoly && ctx.isCpu(fx.playerId);
    case 'toast':
      // The "new destination" toast is owned by the roulette announcement; do not race it.
      // Monopoly news is the payoff of a normal-speed `buy` fx, so its toast stays readable too.
      return (
        !fx.text.startsWith('新しい目的地は') &&
        !fx.text.includes('独占') &&
        ctx.isCpu(ctx.actor)
      );
    case 'card_get':
      return ctx.isCpu(fx.playerId);
    default:
      return false;
  }
}

/** 1 for normal playback, {@link CPU_ROUTINE_BOOST} for routine CPU bookkeeping. */
export function routineFxScale(fx: Fx, ctx: FxPacingContext): number {
  return isRoutineCpuFx(fx, ctx) ? CPU_ROUTINE_BOOST : 1;
}

/**
 * Host-side per-fx budget: the nominal duration shortened by exactly the factor the client
 * plays it at. Non-routine fx (and anything without a known CPU actor) keep `nominalMs`.
 */
export function routineFxDuration(nominalMs: number, fx: Fx, ctx: FxPacingContext): number {
  const scale = routineFxScale(fx, ctx);
  return scale === 1 ? nominalMs : nominalMs / scale;
}