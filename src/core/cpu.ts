// CPU players, levels 1–3 (DESIGN §2.8).
//
// Every function here is deterministic: no Math.random, no clock. cpuDecide() returns an
// action that is legal for the current phase and acting player.

import type { Action, Effect, GameData, GameState, MoveOption, PlayerState } from './types';
import { nodeForCity } from './graph';
import { effectiveDistance } from './realm';
import {
  annualIncome,
  characterPerk,
  currentPrice,
  findProperty,
  incomeMultiplier,
  netWorth,
  ownCount,
  ownedProperties,
  propertyAnnualIncome,
  purchasePrice,
  yearScale,
} from './economy';
import { handLimitFor } from './cards';

const CARD_VALUE: Readonly<Record<string, number>> = {
  shield: 100,
  golden_egg: 85,
  subsidy: 75,
  bailout: 70,
  piper_pass: 65,
  tariff: 60,
  takeover: 55,
  stop: 50,
  express3: 45,
  pegasus: 40,
  rocket: 80,
  express2: 35,
  carpet: 30,
  insider: 20,
};

export function cpuDecide(data: GameData, state: GameState): Action {
  if (state.phase.t === 'game_over') return { t: 'ack' };
  const actor = state.current;
  const player = state.players[actor];
  if (!player) return { t: 'ack' };

  switch (state.phase.t) {
    case 'turn_start':
      return chooseCard(data, state, player) ?? { t: 'roll' };
    case 'choose_dest':
      return { t: 'move', nodeId: chooseMove(data, state, state.phase.options) };
    case 'buy':
      return chooseBuy(data, state, player) ?? { t: 'end_buy' };
    case 'shop':
      return chooseShop(data, state, player);
    case 'event': {
      const eventId = state.phase.eventId;
      const event = data.events.find((e) => e.id === eventId);
      if (!event?.choices || event.choices.length === 0) return { t: 'choose', index: 0 };
      return { t: 'choose', index: chooseEventOption(data, state, player, event.choices) };
    }
    case 'card_target': {
      const cardId = state.phase.cardId;
      const options = state.phase.options;
      return { t: 'card_target', target: chooseCardTarget(data, state, player, cardId, options) };
    }
    case 'discard':
      return { t: 'discard', cardId: chooseDiscard(player) };
    case 'sell': {
      const owned = ownedProperties(data, state, player.id).sort((a, b) => {
        const pa = currentPrice(data, state, a.property.id);
        const pb = currentPrice(data, state, b.property.id);
        return pa !== pb ? pa - pb : a.property.id.localeCompare(b.property.id);
      });
      if (owned.length === 0) return { t: 'ack' };
      return { t: 'sell', propertyId: owned[0].property.id };
    }
    case 'year_end':
      return { t: 'ack' };
    default:
      return { t: 'ack' };
  }
}

// ---------------------------------------------------------------- shop

function chooseShop(data: GameData, state: GameState, player: PlayerState): Action {
  const phase = state.phase;
  if (phase.t !== 'shop') return { t: 'end_shop' };
  const limit = handLimitFor(characterPerk(data, state, player.id));
  if (player.cards.length >= limit) return { t: 'end_shop' };
  const reserve = player.cash * 0.3;
  const affordable = (cardId: string): boolean => {
    if (!phase.stock.includes(cardId)) return false;
    const card = data.cards.find((c) => c.id === cardId);
    if (!card) return false;
    const price = card.price * yearScale(state);
    return player.cash >= price && player.cash - price >= reserve;
  };
  const distance = distanceToDestination(data, state, player);

  if (distance > 30) {
    if (affordable('express3')) return { t: 'buy_card', cardId: 'express3' };
    if (affordable('express2')) return { t: 'buy_card', cardId: 'express2' };
  }
  if (state.piper.holder === player.id) {
    for (const cardId of ['piper_pass', 'stop', 'takeover']) {
      if (affordable(cardId)) return { t: 'buy_card', cardId };
    }
  }
  return { t: 'end_shop' };
}

function distanceToDestination(data: GameData, state: GameState, player: PlayerState): number {
  const destNode = nodeForCity(data, state.destination);
  return destNode ? effectiveDistance(data, player.nodeId, destNode) : 0;
}

// ---------------------------------------------------------------- cards

function chooseCard(data: GameData, state: GameState, player: PlayerState): Action | null {
  const level = player.cpuLevel;
  if (level === 1) return null;
  const hand = new Set(player.cards);
  const others = state.players.filter((p) => p.id !== player.id);

  if (player.cash < 0 && hand.has('bailout')) return { t: 'use_card', cardId: 'bailout' };
  if (hand.has('golden_egg') && annualIncome(data, state, player.id) >= 25) {
    return { t: 'use_card', cardId: 'golden_egg' };
  }
  if (hand.has('subsidy')) return { t: 'use_card', cardId: 'subsidy' };

  const othersCash = others.reduce((sum, p) => sum + Math.max(0, p.cash), 0);
  if (hand.has('tariff') && othersCash >= 40) return { t: 'use_card', cardId: 'tariff' };
  if (hand.has('piper_pass') && state.piper.holder === player.id && others.length > 0) {
    return { t: 'use_card', cardId: 'piper_pass' };
  }
  if (level >= 3) {
    const takeoverOptions = cpuTakeoverOptions(data, state, player);
    const completesMonopoly = takeoverOptions.some((option) => {
      const ref = findProperty(data, option.slice(2));
      return ref !== null && ownCount(data, state, player.id, ref.cityId) === ref.city.properties.length - 1;
    });
    if (hand.has('takeover') && completesMonopoly) {
      return { t: 'use_card', cardId: 'takeover' };
    }
  }

  const destNode = nodeForCity(data, state.destination);
  const currentDistance = destNode ? effectiveDistance(data, player.nodeId, destNode) : 0;
  if (hand.has('rocket') && currentDistance > 20) return { t: 'use_card', cardId: 'rocket' };
  if (currentDistance > 30) {
    if (hand.has('express3')) return { t: 'use_card', cardId: 'express3' };
    if (hand.has('express2')) return { t: 'use_card', cardId: 'express2' };
  }

  if (hand.has('pegasus') && destNode) {
    const airports = data.cities.filter((c) => c.realm === undefined && c.airport);
    let best = currentDistance;
    for (const city of airports) {
      const node = nodeForCity(data, city.id);
      if (!node) continue;
      best = Math.min(best, effectiveDistance(data, node, destNode));
    }
    if (best + 4 < currentDistance) return { t: 'use_card', cardId: 'pegasus' };
  }
  if (hand.has('carpet')) return { t: 'use_card', cardId: 'carpet' };
  if (hand.has('insider') && currentDistance > 26) return { t: 'use_card', cardId: 'insider' };
  return null;
}

function cpuTakeoverOptions(data: GameData, state: GameState, player: PlayerState): string[] {
  const out: string[] = [];
  for (const city of data.cities) {
    for (const property of city.properties) {
      const owner = state.owner[property.id];
      if (owner === undefined || owner === player.id) continue;
      if (player.cash >= currentPrice(data, state, property.id) * 1.5) {
        out.push(`p:${property.id}`);
      }
    }
  }
  return out.sort();
}

// ---------------------------------------------------------------- movement

function chooseMove(
  data: GameData,
  state: GameState,
  options: MoveOption[],
): string {
  const destNode = nodeForCity(data, state.destination);
  interface Scored {
    option: MoveOption;
    score: number;
  }
  const scored: Scored[] = options.map((option) => {
    let score = destNode ? effectiveDistance(data, option.nodeId, destNode) : 0;
    if (!Number.isFinite(score)) score = 9999;
    return { option, score };
  });
  scored.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    return a.option.nodeId < b.option.nodeId ? -1 : a.option.nodeId > b.option.nodeId ? 1 : 0;
  });
  return scored[0].option.nodeId;
}

// ---------------------------------------------------------------- buying

function chooseBuy(data: GameData, state: GameState, player: PlayerState): Action | null {
  const phase = state.phase;
  if (phase.t !== 'buy') return null;
  const city = data.cities.find((c) => c.id === phase.cityId);
  if (!city) return null;
  const available = city.properties.filter(
    (p) => state.owner[p.id] === undefined && player.cash >= purchasePrice(data, state, player.id, p.id),
  );
  if (available.length === 0) return null;

  if (player.cpuLevel === 1) {
    const pick = available.find(
      (p) => player.cash - purchasePrice(data, state, player.id, p.id) >= 20,
    );
    return pick ? { t: 'buy', propertyId: pick.id } : null;
  }

  const currentOwned = ownCount(data, state, player.id, city.id);
  const completingMonopoly =
    player.cpuLevel >= 3 && currentOwned === city.properties.length - 1;
  const reserve =
    player.cpuLevel >= 3
      ? player.cash * (completingMonopoly ? 0.1 : 0.3)
      : player.cash * 0.3;
  const remainingSettlements = Math.max(1, state.config.years - state.year + 1);
  const sorted = available.slice().sort((a, b) => {
    const score = (p: typeof a): number => {
      const cost = purchasePrice(data, state, player.id, p.id);
      const multiplier = incomeMultiplier(data, state, player.id, p.industry);
      const ownedInCity = city.properties.filter(
        (q) => q.id !== p.id && state.owner[q.id] === player.id,
      );
      const completesMonopoly = ownedInCity.length === city.properties.length - 1;
      let marginalIncome = ((p.price * p.yieldPct) / 100) * multiplier * (completesMonopoly ? 2 : 1);
      if (completesMonopoly) {
        for (const other of ownedInCity) {
          marginalIncome += propertyAnnualIncome(data, state, player.id, other, city.id);
        }
      }
      return (marginalIncome * remainingSettlements) / Math.max(1, cost);
    };
    const sa = score(a);
    const sb = score(b);
    return sa !== sb ? sb - sa : a.id.localeCompare(b.id);
  });
  for (const property of sorted) {
    const cost = purchasePrice(data, state, player.id, property.id);
    if (player.cash - cost >= reserve) return { t: 'buy', propertyId: property.id };
  }
  return null;
}

// ---------------------------------------------------------------- events

function chooseEventOption(
  data: GameData,
  state: GameState,
  player: PlayerState,
  choices: NonNullable<GameData['events'][number]['choices']>,
): number {
  if (player.cpuLevel === 1) return 0;
  let best = 0;
  let bestWeight = -Infinity;
  let bestExpectation = -Infinity;
  for (let i = 0; i < choices.length; i += 1) {
    const choice = choices[i];
    const weight = choice.cpuWeight ?? 1;
    // Lv3 uses expected value only as a tie-break: tuned cpuWeight reflects narrative/fun
    // balance and pure effect-EV proved too willing to take cash-losing gambles.
    const expectation =
      player.cpuLevel >= 3 ? effectListValue(data, state, player.id, choice.effects) : 0;
    if (weight > bestWeight || (weight === bestWeight && expectation > bestExpectation)) {
      bestWeight = weight;
      bestExpectation = expectation;
      best = i;
    }
  }
  return best;
}

function effectListValue(data: GameData, state: GameState, actor: number, effects: Effect[]): number {
  return effects.reduce((sum, effect) => sum + effectValue(data, state, actor, effect), 0);
}

function effectValue(data: GameData, state: GameState, actor: number, effect: Effect): number {
  const player = state.players[actor];
  const actorOwned = ownedProperties(data, state, actor);
  switch (effect.op) {
    case 'cash': {
      const amount = effect.amount * (effect.scale === false ? 1 : 1 + 0.35 * (state.year - 1));
      if (effect.who === 'self') return amount;
      if (effect.who === 'all') return amount;
      if (effect.who === 'others') return amount < 0 ? -amount * 0.5 : amount * 0.1;
      return amount * 0.2;
    }
    case 'cash_pct': {
      const amount = Math.max(0, player.cash) * (effect.pct / 100);
      if (effect.who === 'self') return amount;
      if (effect.who === 'all') return amount;
      if (effect.who === 'others') return effect.pct < 0 ? -amount * 0.5 : amount * 0.1;
      return amount * 0.2;
    }
    case 'per_property': {
      if (effect.who === 'self' || effect.who === 'all') {
        const count = actorOwned.filter(
          (ref) => effect.industry === 'any' || ref.property.industry === effect.industry,
        ).length;
        return effect.perProperty * (effect.scale === false ? 1 : 1 + 0.35 * (state.year - 1)) * count;
      }
      return 0;
    }
    case 'industry_mod':
      return actorOwned
        .filter((ref) => ref.property.industry === effect.industry)
        .reduce((sum, ref) => sum + (ref.property.price * ref.property.yieldPct) / 100, 0) *
        (effect.mult - 1) *
        Math.max(1, effect.years);
    case 'price_mod':
      return actorOwned
        .filter((ref) => ref.property.industry === effect.industry)
        .reduce((sum, ref) => sum + currentPrice(data, state, ref.property.id), 0) *
        (effect.mult - 1);
    case 'sell': {
      const owned = actorOwned
        .filter((ref) => effect.industry === 'any' || ref.property.industry === effect.industry)
        .sort((a, b) => currentPrice(data, state, a.property.id) - currentPrice(data, state, b.property.id))
        .slice(0, Math.max(0, effect.count));
      const loss = owned.reduce((sum, ref) => sum + currentPrice(data, state, ref.property.id) * 0.7, 0);
      return effect.who === 'self' ? -loss : effect.who === 'all' ? -loss : loss * 0.2;
    }
    case 'card':
      return 35 * (effect.count ?? 1);
    case 'move':
      return 15;
    case 'skip':
      return effect.who === 'self' ? -60 * effect.turns : 15 * effect.turns;
    case 'piper':
      return effect.to === 'self' ? -70 : 20;
    case 'gamble':
      return (
        effect.chance * effectListValue(data, state, actor, effect.win) +
        (1 - effect.chance) * effectListValue(data, state, actor, effect.lose)
      );
    default:
      return 0;
  }
}

// ---------------------------------------------------------------- targets / discard

function chooseCardTarget(
  data: GameData,
  state: GameState,
  player: PlayerState,
  cardId: string,
  options: string[],
): string {
  if (options.length === 0) return '';
  const level = player.cpuLevel;

  switch (cardId) {
    case 'stop': {
      return options.slice().sort((a, b) => {
        const pa = state.players[Number(a)];
        const pb = state.players[Number(b)];
        const wa = pa ? netWorth(data, state, pa.id) : -Infinity;
        const wb = pb ? netWorth(data, state, pb.id) : -Infinity;
        return wa !== wb ? wb - wa : a.localeCompare(b);
      })[0];
    }
    case 'piper_pass': {
      if (level === 1) return options[0];
      return options.slice().sort((a, b) => {
        const pa = state.players[Number(a)];
        const pb = state.players[Number(b)];
        const wa = pa ? netWorth(data, state, pa.id) : -Infinity;
        const wb = pb ? netWorth(data, state, pb.id) : -Infinity;
        return wa !== wb ? wb - wa : a.localeCompare(b);
      })[0];
    }
    case 'takeover': {
      if (level === 1) return options[0];
      const scored = options.slice().sort((a, b) => {
        const pa = propertyScore(data, state, player.id, a.slice(2));
        const pb = propertyScore(data, state, player.id, b.slice(2));
        return pa !== pb ? pb - pa : a.localeCompare(b);
      });
      return scored[0];
    }
    case 'portal': {
      const destNode = nodeForCity(data, state.destination);
      if (!destNode) return options[0];
      return options.slice().sort((a, b) => {
        const da = effectiveDistance(data, a, destNode);
        const db = effectiveDistance(data, b, destNode);
        return da !== db ? da - db : a.localeCompare(b);
      })[0];
    }
    case 'rocket': {
      const destNode = nodeForCity(data, state.destination);
      if (!destNode) return options[0];
      const scored = options.map((node) => ({
        node,
        score: node.startsWith('r:') ? 9999 : effectiveDistance(data, node, destNode),
      }));
      scored.sort((a, b) => (a.score !== b.score ? a.score - b.score : a.node.localeCompare(b.node)));
      return scored[0].node;
    }
    case 'pegasus':
    case 'carpet': {
      const destNode = nodeForCity(data, state.destination);
      if (!destNode) return options[0];
      return options.slice().sort((a, b) => {
        const da = effectiveDistance(data, a, destNode);
        const db = effectiveDistance(data, b, destNode);
        return da !== db ? da - db : a.localeCompare(b);
      })[0];
    }
    default:
      return options[0];
  }
}

function propertyScore(data: GameData, state: GameState, playerId: number, propertyId: string): number {
  const ref = findProperty(data, propertyId);
  if (!ref) return -Infinity;
  const cost = Math.max(1, currentPrice(data, state, propertyId) * 1.5);
  let score = (ref.property.yieldPct * ref.property.price) / cost;
  const owned = ownCount(data, state, playerId, ref.cityId);
  if (owned > 0) score += 3;
  if (owned === ref.city.properties.length - 1) score += 1000;
  return score;
}

function chooseDiscard(player: PlayerState): string {
  let worst = player.cards[0];
  let worstValue = CARD_VALUE[worst] ?? 50;
  for (const cardId of player.cards.slice(1)) {
    const value = CARD_VALUE[cardId] ?? 50;
    if (value < worstValue) {
      worst = cardId;
      worstValue = value;
    }
  }
  return worst;
}