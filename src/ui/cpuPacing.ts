// Presentation pacing for CPU turns — the client half.
//
// Sol's playtest (2026-11-26) spent most of the first year watching three CPUs roll, walk,
// quip and bank blue-square cash at 1x. The engine and the room's authority rules must not
// change: this module only decides how fast the CLIENT paints an fx. The classification itself
// lives in `src/core/fxPacing.ts` and is shared with the host's CPU turn budget, so the client
// can never play slower than the time the host already allotted for the turn.
//
// 2026-11-27 tempo slice: a CPU's 固有技 / CPU-to-CPU 買収 that touches no human now plays a
// compact beat. `CpuTurnPacer` classifies the whole update at once (a skill's consequences are
// fx of the same update), so `control.compact` and the playback speed always agree.

import type { PublicState } from '../core/engine';
import type { Fx } from '../core/types';
import {
  compactDramaKind,
  compactSayBeat,
  createDramaLedger,
  isRoutineCpuFx as coreRoutineCpuFx,
  isRoutineCpuSay as coreRoutineCpuSay,
  paceUpdate,
  routineFxScale,
  type CompactDramaKind,
  type DramaLedger,
  type FxPacingContext,
  type FxTempoLevel,
} from '../core/fxPacing';
import { effectiveTempoLevel } from './settings';

export {
  BIG_SWING_RATIO,
  COMPACT_VOICE_WAIT_MS,
  compactDramaMs,
  CPU_ROUTINE_BOOST,
  cutsVoice,
  estimateSayVoiceMs,
  ROUTINE_BOOST,
  READ_CHARS_PER_SECOND,
  SAY_MIN_HOLD_MS,
  SAY_VOICE_TAIL_MS,
  sayHoldMs,
  DEFAULT_TEMPO_LEVEL,
  type CompactDramaKind,
  type DramaRepeatKind,
  type FxTempoLevel,
} from '../core/fxPacing';

/** Hard ceiling after multiplying, so ?speed=8 does not turn into a single frame. */
export const MAX_PACED_SPEED = 12;

/** One helper for "is this seat a CPU"; every pacing rule below reads it the same way. */
export function isCpuSeat(state: PublicState, playerId: number | null | undefined): boolean {
  if (playerId === null || playerId === undefined) return false;
  return state.players[playerId]?.isCpu === true;
}

function contextOf(state: PublicState, actor: number | null): FxPacingContext {
  return { actor, isCpu: (playerId) => isCpuSeat(state, playerId) };
}

/**
 * Only the drama classifiers need net worth; routine bookkeeping must not walk every property.
 * The value itself comes from the host (which owns GAME_DATA and `netWorth`), so this module
 * stays free of the data bundle.
 */
function needsLeaderWorth(fx: Fx, update: readonly Fx[] | undefined): boolean {
  return (
    fx.t === 'skill' ||
    fx.t === 'buyout' ||
    (fx.t === 'say' && (fx.lineKey === 'skill' || fx.lineKey === undefined)) ||
    (update?.some((item) => item.t === 'skill' || item.t === 'buyout') ?? false)
  );
}

/** A `say` fx that can play without the voice wait (see `fxPacing.isRoutineCpuSay`). */
export function isRoutineCpuSay(fx: Extract<Fx, { t: 'say' }>, state: PublicState): boolean {
  return coreRoutineCpuSay(fx, contextOf(state, null));
}

export interface RoutineFxInput {
  fx: Fx;
  state: PublicState;
  /** Seat whose turn is currently being presented (latest `turn` fx), if known. */
  actor: number | null;
  /** Every fx of the update being played; the 固有技 / 買収 rules read it. */
  update?: readonly Fx[];
  /** 「演出の長さ」. Omitted = the player's saved setting. */
  level?: FxTempoLevel;
  /** Net worth (億) of the current leader, when the caller can compute it. */
  leaderWorth?: number;
}

export function isRoutineCpuFx({ fx, state, actor, update, level, leaderWorth }: RoutineFxInput): boolean {
  return coreRoutineCpuFx(fx, {
    ...contextOf(state, actor),
    ...(update ? { update } : {}),
    level: level ?? effectiveTempoLevel(),
    ...(leaderWorth === undefined ? {} : { leaderWorth }),
  });
}

/**
 * Tracks whose turn is on screen and answers the per-fx speed multiplier plus the compact
 * presentation tier. Fed by FxPlayer once per fx; `reset()` on snapshot adoption.
 */
export class CpuTurnPacer {
  private actor: number | null = null;
  private compact: CompactDramaKind | null = null;
  /** Repeat counts of the current year (see `fxPacing.DramaLedger`). */
  private readonly ledger: DramaLedger = createDramaLedger();
  /** The update whose compact tiers are already decided, and their decision. */
  private decidedUpdate: readonly Fx[] | null = null;
  private decidedCompact: ReadonlyMap<Fx, CompactDramaKind | null> | null = null;
  /** Leader net worth, recomputed once per update (netWorth walks every property). */
  private worthCache: { state: PublicState; worth: number } | null = null;

  reset(): void {
    this.actor = null;
    this.compact = null;
    this.decidedUpdate = null;
    this.decidedCompact = null;
    this.worthCache = null;
  }

  get actorSeat(): number | null {
    return this.actor;
  }

  /** Compact tier of the fx that `speedFor` was last called for. */
  get compactBeat(): CompactDramaKind | null {
    return this.compact;
  }

  /**
   * Feeds one fx, then returns its playback multiplier (1 = unchanged).
   * `update` is the whole update so a skill beat can weigh its consequences; `leaderWorth`
   * is only requested from the host for the drama classifiers (see {@link needsLeaderWorth}).
   */
  speedFor(
    fx: Fx,
    state: PublicState,
    options: {
      update?: readonly Fx[];
      level?: FxTempoLevel;
      leaderWorth?: (state: PublicState) => number;
    } = {},
  ): number {
    if (fx.t === 'turn') this.actor = fx.playerId;
    const { update, level } = options;
    let leaderWorth: number | undefined;
    if (options.leaderWorth && needsLeaderWorth(fx, update)) {
      if (!this.worthCache || this.worthCache.state !== state) {
        this.worthCache = { state, worth: options.leaderWorth(state) };
      }
      leaderWorth = this.worthCache.worth;
    }
    const year = state.year ?? 0;
    const ctx: FxPacingContext = {
      actor: this.actor,
      isCpu: (playerId) => isCpuSeat(state, playerId),
      ...(update && update.length > 0 ? { update } : {}),
      level: level ?? effectiveTempoLevel(),
      year,
      ledger: this.ledger,
      ...(leaderWorth === undefined ? {} : { leaderWorth }),
    };
    // The host budgets the update the same way: every compact tier is decided against the
    // year's ledger, and only then is it advanced (see `paceUpdate`).
    if (update && update.length > 0 && this.decidedUpdate !== update) {
      this.decidedUpdate = update;
      this.decidedCompact = paceUpdate(update, ctx);
    }
    const decided = this.decidedCompact ? { ...ctx, compactOf: this.decidedCompact } : ctx;
    this.compact = compactDramaKind(fx, decided);
    if (fx.t === 'say' && this.compact === null) {
      // A line that belongs to a compact beat (CPU-only 固有技, CPU-to-CPU 買収, a repeated CPU
      // goal/monopoly/roulette/mischief) is colour: its 掛け合い does not wait on the voice.
      this.compact = compactSayBeat(fx, decided);
    }
    return routineFxScale(fx, decided);
  }
}
