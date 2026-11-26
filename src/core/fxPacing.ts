// Deterministic pacing rules for CPU routine fx — the single source of truth for both sides:
//
//  - the HOST (`RoomController.armTurn`) divides the budget it schedules CPU actions by;
//  - the CLIENT (`FxPlayer` via `src/ui/cpuPacing.ts`) multiplies its playback speed by.
//
// Keeping one pure function here is what prevents the two from drifting apart. Everything the
// human might act on is deliberately absent from these tables: goals, piper fx, buyouts,
// events, skills, city mods, the final year, monopolies and any cash change of a human stay at
// the nominal budget / chosen playback speed.
//
// Two tiers (2026-11-27 tempo slice):
//
//  1. `routine` — a CPU's bookkeeping (roll, walk, quip, blue square, purchase). Always sped up.
//  2. `compact drama` — a CPU's 固有技 / CPU-to-CPU 買収 that touches no human. It still shows a
//     beat (the human must see that something happened), just a short one. Whether it is compact
//     is decided from the *whole update's* fx list, which both sides hold identically, so the
//     host budget and the client playback always agree.
//
// `FxTempoLevel` is the player's 「演出の長さ」 setting. It only ever makes a *client* faster than
// the host's budget: `calm` (じっくり) is the nominal DESIGN timing the host uses for online rooms,
// so no client can ever be slower than the time the host already allotted.

import type { Fx, LineKey } from './types';

/** How much faster a routine CPU fx plays, and how much shorter its host budget is. */
export const CPU_ROUTINE_BOOST = 3;

/** 「演出の長さ」: calm = 今までどおり, standard = 標準 (default), brisk = さくさく. */
export type FxTempoLevel = 'calm' | 'standard' | 'brisk';

/** Default of the player-facing 「演出の長さ」 setting. */
export const DEFAULT_TEMPO_LEVEL: FxTempoLevel = 'standard';

/**
 * Tier a *room budget* assumes when no level is given: the nominal DESIGN timing. Online hosts
 * schedule with this, so a client can only ever finish early, never overrun the room's time.
 */
export const HOST_BUDGET_LEVEL: FxTempoLevel = 'calm';

/**
 * Routine CPU bookkeeping by tier. `calm` is what the room always did; 標準 tightens the
 * ordinary CPU-only turn further (the playtest still felt those), さくさく adds two notches.
 * The host schedules with the same number, so a room never overruns.
 */
export const ROUTINE_BOOST: Record<FxTempoLevel, number> = {
  calm: CPU_ROUTINE_BOOST,
  standard: 4,
  brisk: 6,
};

/**
 * Compact beat lengths (1x, ms). `standard` halves the 2.2s skill cut-in; `brisk` halves it
 * again. `calm` has no entry: it keeps the nominal DESIGN duration.
 */
export const COMPACT_DRAMA_MS = {
  skill: { standard: 800, brisk: 500 },
  buyout: { standard: 460, brisk: 320 },
} as const;

/** Nominal DESIGN lengths of the compacted beats (mirrors `FX_MS`; kept here so this module is self-contained). */
const NOMINAL_DRAMA_MS = { skill: 2200, buyout: 900 } as const;

/** A CPU's 固有技 swing at or above this share of the leader's net worth keeps the full cut-in. */
export const BIG_SWING_RATIO = 0.1;

/**
 * Character lines a CPU may deliver without the human having to read along.
 * `goal`, `monopoly`, `piper_*`, `win` and `lose` are deliberately absent: those
 * are the beats the human is playing for. `skill` is handled separately below, because a
 * *compact* CPU skill must not wait on its voice line while a big one still should.
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
  // 決算・関税は全員に同じタイミングで降りる。人間の行だけ通常速度で見せれば足りる。
  決算: true,
  関税: true,
};

export interface FxPacingContext {
  /** Seat whose turn is being presented (latest `turn` fx / the acting player of the step). */
  actor: number | null;
  /** Whether a player id is a CPU. */
  isCpu: (playerId: number | null | undefined) => boolean;
  /**
   * Every fx of the update being played. Lets the 固有技 / 買収 rules see the *consequences* of
   * the beat (a cash hit on the human, a broken monopoly) without consulting game data, so the
   * host and every client reach the same answer.
   */
  update?: readonly Fx[];
  /** 「演出の長さ」. Omitted = 標準. */
  level?: FxTempoLevel;
  /** Net worth (億) of the current leader; enables the "big swing keeps the full cut-in" rule. */
  leaderWorth?: number;
}

/** The fx of the current update, or just the fx itself when the caller passed no list. */
function updateOf(fx: Fx, ctx: FxPacingContext): readonly Fx[] {
  return ctx.update && ctx.update.length > 0 ? ctx.update : [fx];
}

/** Total absolute cash the update moved through generic event bookkeeping rows. */
function skillCashSwing(siblings: readonly Fx[]): number {
  let swing = 0;
  for (const item of siblings) {
    if (item.t !== 'cash') continue;
    if (item.reason !== 'イベント' && item.reason !== 'イベント物件収益') continue;
    swing += Math.abs(item.delta);
  }
  return swing;
}

/**
 * Seats whose money / assets an fx moves. `null` = the fx cannot touch a seat's holdings
 * (dice, month, a generic toast), so it says nothing about whether a skill touched anyone.
 */
function affectedSeats(fx: Fx): (number | null)[] | null {
  switch (fx.t) {
    case 'cash':
    case 'buy':
    case 'sell':
    case 'card_get':
    case 'card_use':
    case 'move':
    case 'warp':
    case 'skip':
    case 'goal':
    case 'errand_done':
    case 'buyout':
      return [fx.playerId, ...(fx.t === 'buyout' ? [fx.fromId] : [])];
    case 'piper':
    case 'piper_roulette':
    case 'piper_disaster':
    case 'piper_gift':
      return [fx.holder];
    default:
      return null;
  }
}

/**
 * True when a CPU's 固有技 changes nothing the human holds: no cash, property, piper or skip on
 * a non-CPU seat, and a swing smaller than {@link BIG_SWING_RATIO} of the leader's net worth.
 */
export function isCompactSkill(
  fx: Extract<Fx, { t: 'skill' }>,
  ctx: FxPacingContext,
): boolean {
  if (!ctx.isCpu(fx.playerId)) return false;
  if ((ctx.level ?? HOST_BUDGET_LEVEL) === 'calm') return false;
  const siblings = updateOf(fx, ctx);
  if (fx.targetId !== undefined && ctx.isCpu(fx.targetId) === false) return false;
  for (const item of siblings) {
    const seats = affectedSeats(item);
    if (seats === null) {
      // A monopoly flip is not a bookkeeping row: it reshapes the income race for everyone.
      if (item.t === 'toast' && item.text.includes('独占')) return false;
      continue;
    }
    for (const seat of seats) {
      if (seat !== null && ctx.isCpu(seat) === false) return false;
    }
  }
  const worth = ctx.leaderWorth ?? 0;
  const swing = skillCashSwing(siblings);
  // Without a leader worth, 40億 is the same 10% at the year-1 scale of an average table.
  if (worth > 0 ? swing >= worth * BIG_SWING_RATIO : swing >= 40) return false;
  return true;
}

/** True when both sides of a 買収 are CPUs — the human neither buys nor loses the property. */
export function isCompactBuyout(fx: Extract<Fx, { t: 'buyout' }>, ctx: FxPacingContext): boolean {
  if ((ctx.level ?? HOST_BUDGET_LEVEL) === 'calm') return false;
  if (!ctx.isCpu(fx.playerId) || !ctx.isCpu(fx.fromId)) return false;
  // A monopoly breaking reshapes the income race: keep its full beat (confetti + warning).
  if (fx.brokeMonopoly) return false;
  return true;
}

/** The compact tier an fx belongs to, or null when it plays at its nominal length. */
export function compactDramaKind(fx: Fx, ctx: FxPacingContext): 'skill' | 'buyout' | null {
  if (fx.t === 'skill' && isCompactSkill(fx, ctx)) return 'skill';
  if (fx.t === 'buyout' && isCompactBuyout(fx, ctx)) return 'buyout';
  return null;
}

/**
 * Host budget / client nominal length of a compacted beat. `calm` returns the DESIGN nominal,
 * so a じっくり room schedules exactly what it always did.
 */
export function compactDramaMs(
  kind: 'skill' | 'buyout',
  level: FxTempoLevel | undefined,
): number {
  const resolved = level ?? HOST_BUDGET_LEVEL;
  if (resolved === 'calm') return NOMINAL_DRAMA_MS[kind];
  return COMPACT_DRAMA_MS[kind][resolved];
}

/**
 * A `say` fx that can play briefly: the text still reaches the message window and the log,
 * just without the voice wait. Speaker must be the acting CPU itself, so victim/reaction
 * lines (piper_get on someone else, event replies) keep their presentation.
 */
export function isRoutineCpuSay(fx: Extract<Fx, { t: 'say' }>, ctx: FxPacingContext): boolean {
  if (!ctx.isCpu(fx.playerId)) return false;
  if (fx.lineKey !== undefined && ROUTINE_LINE_KEYS[fx.lineKey] === true) return true;
  // 固有技の決め台詞: only the compact tier drops the voice wait. A big skill's line still lands.
  if (fx.lineKey === 'skill') {
    const skill = updateOf(fx, ctx).find(
      (item): item is Extract<Fx, { t: 'skill' }> =>
        item.t === 'skill' && item.playerId === fx.playerId,
    );
    return skill !== undefined && isCompactSkill(skill, ctx);
  }
  // A CPU buying a CPU's property is a compact toast beat: its 掛け合い is colour as well.
  if (fx.lineKey === undefined) {
    return updateOf(fx, ctx).some(
      (item) => item.t === 'buyout' && isCompactBuyout(item, ctx),
    );
  }
  return false;
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
    case 'errand':
    case 'errand_done':
      // 寄り道依頼は人間も狙う共有の山場。CPU が達成しても早送りしない。
      return false;
    default:
      return false;
  }
}

/** 1 for normal playback, the routine boost for routine CPU bookkeeping. */
export function routineFxScale(fx: Fx, ctx: FxPacingContext): number {
  return isRoutineCpuFx(fx, ctx) ? ROUTINE_BOOST[ctx.level ?? HOST_BUDGET_LEVEL] : 1;
}

/**
 * Host-side per-fx budget: the nominal duration shortened by exactly the factor the client
 * plays it at. Compact drama uses its own short length; everything else keeps `nominalMs`.
 */
export function routineFxDuration(nominalMs: number, fx: Fx, ctx: FxPacingContext): number {
  const kind = compactDramaKind(fx, ctx);
  if (kind !== null) return compactDramaMs(kind, ctx.level);
  const scale = routineFxScale(fx, ctx);
  return scale === 1 ? nominalMs : nominalMs / scale;
}
