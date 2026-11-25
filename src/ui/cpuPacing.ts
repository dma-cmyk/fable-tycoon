// Presentation pacing for CPU turns — the client half.
//
// Sol's playtest (2026-11-26) spent most of the first year watching three CPUs roll, walk,
// quip and bank blue-square cash at 1x. The engine and the room's authority rules must not
// change: this module only decides how fast the CLIENT paints an fx. The classification itself
// lives in `src/core/fxPacing.ts` and is shared with the host's CPU turn budget, so the client
// can never play slower than the time the host already allotted for the turn.

import type { PublicState } from '../core/engine';
import type { Fx } from '../core/types';
import {
  isRoutineCpuFx as coreRoutineCpuFx,
  isRoutineCpuSay as coreRoutineCpuSay,
  routineFxScale,
  type FxPacingContext,
} from '../core/fxPacing';

export { CPU_ROUTINE_BOOST } from '../core/fxPacing';

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

/** A `say` fx that can play without the voice wait (see `fxPacing.isRoutineCpuSay`). */
export function isRoutineCpuSay(fx: Extract<Fx, { t: 'say' }>, state: PublicState): boolean {
  return coreRoutineCpuSay(fx, contextOf(state, null));
}

export interface RoutineFxInput {
  fx: Fx;
  state: PublicState;
  /** Seat whose turn is currently being presented (latest `turn` fx), if known. */
  actor: number | null;
}

export function isRoutineCpuFx({ fx, state, actor }: RoutineFxInput): boolean {
  return coreRoutineCpuFx(fx, contextOf(state, actor));
}

/**
 * Tracks whose turn is on screen and answers the per-fx speed multiplier.
 * Fed by FxPlayer once per fx; `reset()` on snapshot adoption.
 */
export class CpuTurnPacer {
  private actor: number | null = null;

  reset(): void {
    this.actor = null;
  }

  get actorSeat(): number | null {
    return this.actor;
  }

  /** Feeds `turn` fx, then returns the extra playback multiplier (1 = unchanged). */
  speedFor(fx: Fx, state: PublicState): number {
    if (fx.t === 'turn') this.actor = fx.playerId;
    return routineFxScale(fx, contextOf(state, this.actor));
  }
}