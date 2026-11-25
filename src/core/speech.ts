// Small helpers that turn character lines and event dialogue into presentation `say` fx.

import type { DialogueLine, Fx, GameData, GameState, LineKey, TurnLines } from './types';
import { netWorth } from './economy';
import { nodeForCity } from './graph';
import { effectiveDistance, nodeRealm } from './realm';

/** Emits a fixed character voice line (`lineKey`) for a player. */
export function sayCharacterLine(
  data: GameData,
  state: GameState,
  playerId: number,
  lineKey: LineKey,
  fx: Fx[],
): void {
  const player = state.players[playerId];
  const character = data.characters.find((c) => c.id === player?.characterId);
  fx.push({
    t: 'say',
    speaker: 'self',
    playerId,
    text: character?.lines[lineKey] ?? '',
    lineKey,
  });
}

// ---------------------------------------------------------------- turn lines

/** Distance (in steps) at or below which the destination counts as "near". */
export const NEAR_DESTINATION_STEPS = 6;

/** A share of the higher net worth (or this many units) that counts as a clear gap. */
const CLEAR_MARGIN_RATIO = 0.15;
const CLEAR_MARGIN_MIN = 20;

export type TurnSituation = keyof TurnLines;

/**
 * Deterministic 32-bit hash (FNV-1a over UTF-16 units). Presentation-only: it never reads or
 * advances the state rng, so seeded game outcomes are unaffected by line selection.
 */
function hash32(key: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  // Finalizer: FNV-1a leaves low bits poorly mixed (parity of the input), which would make two
  // hashes of strings sharing a prefix flip together. Avalanche so 50/50 gates are independent.
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d) >>> 0;
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x846ca68b) >>> 0;
  hash ^= hash >>> 16;
  return hash >>> 0;
}

/** Clear gap to the next player: a share of the higher worth, or an absolute floor. */
function hasClearMargin(top: number, next: number): boolean {
  return top - next >= Math.max(CLEAR_MARGIN_MIN, Math.abs(top) * CLEAR_MARGIN_RATIO);
}

/** `lead`/`last` only when the net-worth gap to the next player is clear (and 2+ players). */
function standingSituation(data: GameData, state: GameState, playerId: number): 'lead' | 'last' | null {
  if (state.players.length < 2) return null;
  const mine = netWorth(data, state, playerId);
  const others: number[] = [];
  for (const player of state.players) {
    if (player.id !== playerId) others.push(netWorth(data, state, player.id));
  }
  const bestOther = Math.max(...others);
  const worstOther = Math.min(...others);
  if (mine >= bestOther && hasClearMargin(mine, bestOther)) return 'lead';
  if (mine <= worstOther && hasClearMargin(worstOther, mine)) return 'last';
  return null;
}

/** Highest-priority situational line for this turn, ignoring the normal-mix gate. */
function primarySituation(data: GameData, state: GameState, playerId: number): TurnSituation | null {
  const player = state.players[playerId];
  if (!player) return null;
  if (state.piper.holder === playerId) return 'piper';
  if (nodeRealm(data, player.nodeId) !== 'world') return 'realm';
  const destinationNode = nodeForCity(data, state.destination);
  if (destinationNode !== null && effectiveDistance(data, player.nodeId, destinationNode) <= NEAR_DESTINATION_STEPS) {
    return 'near';
  }
  return standingSituation(data, state, playerId);
}

/**
 * Situation for this turn. In the final year, half of the turns use `final` and the rest fall
 * through to the other situations. For every other situation, half of the turns still use
 * `normal` so the situational lines stay special. Both splits are hash-based (no rng).
 */
export function pickTurnSituation(data: GameData, state: GameState, playerId: number): TurnSituation {
  const finalYear = state.year === state.config.years;
  if (finalYear && hash32(`${state.round}:${playerId}:final-year`) % 2 === 0) return 'final';
  const situation = primarySituation(data, state, playerId);
  if (situation === null) return 'normal';
  return hash32(`${state.round}:${playerId}:mix:${situation}`) % 2 === 0 ? 'normal' : situation;
}

/**
 * Rotates through a situation's list by `state.round`, so one player never hears the same text
 * on two consecutive turns (`round` advances between turns). No rng is consumed.
 */
function pickTurnText(list: readonly string[], round: number, playerId: number, situation: TurnSituation): string {
  const offset = hash32(`${playerId}:${situation}`) % list.length;
  return list[(((round + offset) % list.length) + list.length) % list.length];
}

/**
 * Emits a situational turn-start line for a player, falling back to `lines.turn` when the
 * character has no `turnLines` entry. The `say` fx uses `lineKey: 'turn'` exactly like
 * `sayCharacterLine`, because the UI keys emotion and voice lookup on it.
 */
export function sayTurnLine(data: GameData, state: GameState, playerId: number, fx: Fx[]): void {
  const player = state.players[playerId];
  const character = data.characters.find((c) => c.id === player?.characterId);
  let text = character?.lines.turn ?? '';
  const turnLines = character ? data.turnLines?.[character.id] : undefined;
  if (turnLines) {
    const situation = pickTurnSituation(data, state, playerId);
    const list = turnLines[situation];
    if (list && list.length > 0) text = pickTurnText(list, state.round, playerId, situation);
  }
  fx.push({ t: 'say', speaker: 'self', playerId, text, lineKey: 'turn' });
}

/** Emits every DialogueLine in order; `self` is resolved to the acting player. */
export function emitDialogueLines(
  state: GameState,
  fx: Fx[],
  lines: DialogueLine[] | undefined,
  actorId: number,
): void {
  for (const line of lines ?? []) {
    if (line.speaker === 'self') {
      fx.push({ t: 'say', speaker: 'self', playerId: state.players[actorId]?.id ?? actorId, text: line.text });
    } else {
      fx.push({ t: 'say', speaker: line.speaker, text: line.text });
    }
  }
}