// Card definitions the engine implements (DESIGN §2.5), hand limits and shield handling.

import type { Fx, GameData, GameState, PerkId } from './types';
import { randInt, weightedPick } from './rng';
import { CARD_SHARK_BONUS, HAND_LIMIT } from './economy';

export const CARD_IDS = [
  'express2',
  'express3',
  'pegasus',
  'carpet',
  'rocket',
  'tariff',
  'subsidy',
  'bailout',
  'stop',
  'takeover',
  'piper_pass',
  'golden_egg',
  'insider',
  'shield',
] as const;

export type CardId = (typeof CARD_IDS)[number];

const CARD_ID_SET: ReadonlySet<string> = new Set(CARD_IDS);

export type CardTargetKind = 'player' | 'city' | 'airport' | 'property' | null;

/** Target kind required by each engine card (null = resolves immediately). */
export const CARD_TARGETS: Readonly<Record<CardId, CardTargetKind>> = {
  express2: null,
  express3: null,
  pegasus: 'airport',
  carpet: 'city',
  rocket: 'city',
  tariff: null,
  subsidy: null,
  bailout: null,
  stop: 'player',
  takeover: 'property',
  piper_pass: 'player',
  golden_egg: null,
  insider: null,
  shield: null,
};

export function isCardId(id: string): id is CardId {
  return CARD_ID_SET.has(id);
}

export function handLimitFor(perk: PerkId): number {
  return HAND_LIMIT + (perk === 'card_shark' ? CARD_SHARK_BONUS : 0);
}

/** Draws one weighted card from the deck (unknown ids are ignored). */
export function drawCard(data: GameData, state: GameState): string | null {
  const candidates = data.cards.filter((c) => isCardId(c.id) && c.weight > 0);
  const picked = weightedPick(state, candidates, (c) => c.weight);
  return picked?.id ?? null;
}

export function drawCards(data: GameData, state: GameState, count: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const id = drawCard(data, state);
    if (!id) break;
    out.push(id);
  }
  return out;
}

/**
 * Automatically spends a `shield` when its holder is hit. Returns true when a shield
 * was consumed (the caller must then skip the damage entirely).
 */
export function consumeShield(state: GameState, playerId: number, fx: Fx[]): boolean {
  const player = state.players[playerId];
  if (!player) return false;
  const index = player.cards.indexOf('shield');
  if (index < 0) return false;
  player.cards.splice(index, 1);
  fx.push({ t: 'card_use', playerId, cardId: 'shield' });
  fx.push({ t: 'toast', text: `${player.name} の弁護士軍団が攻撃を無効化した！` });
  return true;
}

/** Number of cards discarded by a piper mischief (1–2, DESIGN §2.4). */
export function piperDiscardCount(state: GameState): number {
  return randInt(state, 1, 2);
}

/** Remove one instance of a card id from a hand; returns false when absent. */
export function removeCard(cards: string[], cardId: string): boolean {
  const i = cards.indexOf(cardId);
  if (i < 0) return false;
  cards.splice(i, 1);
  return true;
}