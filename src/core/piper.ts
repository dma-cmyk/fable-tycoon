// ハーメルンの取り立て屋 (DESIGN §2.4).
//
// Mischief kinds, rolled once at the holder's turn start:
//   0 cash 5–15%     1 property confiscation   2 discard 1–2 cards
//   3 junk info product for 10億   4 skip one turn
// Level 1/2/3 damage multiplier = 1/2/3; `piper_charm` halves numeric damage; `shield`
// (弁護士軍団) cancels one complete mischief automatically.

import type { Fx, GameData, GameState } from './types';
import { randInt, shuffled } from './rng';
import { consumeShield, piperDiscardCount } from './cards';
import { characterPerk, ownedProperties, sellPrice } from './economy';
import { sayCharacterLine } from './speech';
import { shortestDistance } from './graph';

export const PIPER_LEVEL_TURNS: readonly number[] = [12, 24];

export function piperLevelForHeldTurns(heldTurns: number): 1 | 2 | 3 {
  if (heldTurns >= PIPER_LEVEL_TURNS[1]) return 3;
  if (heldTurns >= PIPER_LEVEL_TURNS[0]) return 2;
  return 1;
}

/** Moves the piper to `holder` (null = unassigned), resetting its level, and emits fx. */
export function transferPiper(
  state: GameState,
  fx: Fx[],
  holder: number | null,
  message: string,
): void {
  state.piper = { holder, level: 1, heldTurns: 0 };
  fx.push({ t: 'piper', holder, level: 1, message });
}

/** After a goal: the player farthest (shortest steps) from the claimed city gets the piper. */
export function assignPiperToFarthest(
  data: GameData,
  state: GameState,
  fx: Fx[],
  cityBoardNodeId: string,
  claimedBy: number,
): number | null {
  let holder: number | null = null;
  let best = -1;
  for (const player of state.players) {
    const d = shortestDistance(data, cityBoardNodeId, player.nodeId);
    const value = Number.isFinite(d) ? d : 9999;
    if (value > best) {
      best = value;
      holder = player.id;
    }
  }
  if (holder === null) return null;
  const target = state.players[holder];
  transferPiper(
    state,
    fx,
    holder,
    `目的地から最も遠い ${target.name} に取り立て屋が憑いた！`,
  );
  sayCharacterLine(data, state, holder, 'piper_get', fx);
  if (holder === claimedBy) {
    fx.push({ t: 'toast', text: `${target.name} は一番乗りなのに取り立て屋まで背負った。世知辛い。` });
  }
  return holder;
}

/** Runs the holder's turn-start mischief. Returns whether the turn must be skipped. */
export function runPiperTurnStart(
  data: GameData,
  state: GameState,
  fx: Fx[],
): 'continue' | 'skip' {
  const playerId = state.current;
  if (state.piper.holder !== playerId) return 'continue';
  const player = state.players[playerId];
  if (!player) return 'continue';

  state.piper.heldTurns += 1;
  const nextLevel = piperLevelForHeldTurns(state.piper.heldTurns);
  if (nextLevel !== state.piper.level) {
    state.piper.level = nextLevel;
    fx.push({
      t: 'piper',
      holder: playerId,
      level: nextLevel,
      message:
        nextLevel === 2
          ? '取り立て屋がブラック化した！ 被害2倍。'
          : '取り立て屋がキング化した！ 被害3倍、物件もまとめて没収。',
    });
  }

  if (consumeShield(state, playerId, fx)) {
    fx.push({ t: 'toast', text: '弁護士軍団が今回の取り立てを丸ごと無効化した。' });
    return 'continue';
  }

  const level = state.piper.level;
  const charm = characterPerk(data, state, playerId) === 'piper_charm' ? 0.5 : 1;
  const kind = randInt(state, 0, 4);

  if (kind === 0) {
    const pct = randInt(state, 5, 15);
    const amount = Math.max(0, player.cash) * (pct / 100) * level * charm;
    player.cash -= amount;
    fx.push({ t: 'cash', playerId, delta: -amount, reason: '取り立て' });
    sayCharacterLine(data, state, playerId, 'piper_hit', fx);
    fx.push({ t: 'toast', text: `${player.name} の所持金 ${pct}%×Lv${level} を取り立てられた。` });
  } else if (kind === 1) {
    const owned = ownedProperties(data, state, playerId);
    const count = level === 3 ? Math.min(2, owned.length) : Math.min(1, owned.length);
    if (count === 0) {
      fx.push({ t: 'toast', text: '取り立て屋は没収する物件がなく、渋々帰った。' });
    } else {
      for (const ref of shuffled(state, owned).slice(0, count)) {
        const amount = sellPrice(data, state, ref.property.id);
        delete state.owner[ref.property.id];
        player.cash += amount;
        fx.push({ t: 'sell', playerId, propertyId: ref.property.id, amount });
      }
      sayCharacterLine(data, state, playerId, 'piper_hit', fx);
      fx.push({
        t: 'toast',
        text: `${player.name} の物件${count}件が「没収売却」された。`,
      });
    }
  } else if (kind === 2) {
    const count = Math.min(piperDiscardCount(state), player.cards.length);
    if (count === 0) {
      fx.push({ t: 'toast', text: '取り立て屋は捨てるカードがなく、渋々帰った。' });
    } else {
      for (const cardId of shuffled(state, player.cards).slice(0, count)) {
        const i = player.cards.indexOf(cardId);
        if (i >= 0) player.cards.splice(i, 1);
      }
      sayCharacterLine(data, state, playerId, 'piper_hit', fx);
      fx.push({ t: 'toast', text: `${player.name} はカードを${count}枚捨てさせられた。` });
    }
  } else if (kind === 3) {
    const cost = 10 * level * charm;
    player.cash -= cost;
    fx.push({ t: 'cash', playerId, delta: -cost, reason: 'ガラクタ情報商材' });
    sayCharacterLine(data, state, playerId, 'piper_hit', fx);
    fx.push({ t: 'toast', text: `${player.name} は「AI式・金運ブレスレット」を${cost}億で買わされた。` });
  } else {
    player.skipTurns += 1;
    sayCharacterLine(data, state, playerId, 'piper_hit', fx);
    fx.push({ t: 'toast', text: `${player.name} は取り立て屋の嫌がらせで1回休み。` });
    return 'skip';
  }

  if (player.cash < 0) {
    fx.push({ t: 'toast', text: `${player.name} は借金を抱えた。` });
  }
  return 'continue';
}