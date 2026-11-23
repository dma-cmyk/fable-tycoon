// Authoritative, deterministic rules engine.
//
// Public API (DESIGN §3):
//   createGame, step, actorOf, cpuDecide, netWorth, currentPrice, annualIncome, distance,
//   sanitizeState, EngineError.
//
// `step` clones the input state, validates that the caller owns the acting seat and that the
// action is legal for the current phase, then returns the new state plus presentation fx.

import type {
  Action,
  GameConfig,
  GameData,
  GameState,
  Fx,
  MoveOption,
  PlayerState,
  StepResult,
  YearReport,
} from './types';
import { pickOne, randInt } from './rng';
import {
  getGraph,
  isPortOrAdjacentSea,
  nodeForCity,
  reachableInExactly,
  shortestDistance,
} from './graph';
import {
  annualIncome,
  characterPerk,
  currentPrice,
  destinationBonus,
  findProperty,
  monopolises,
  netWorth,
  ownedProperties,
  purchasePrice,
  satiricalHeadline,
  sellPrice,
  STARTING_CASH,
  validateBoardCities,
  yearScale,
} from './economy';
import {
  CARD_TARGETS,
  consumeShield,
  drawCards,
  handLimitFor,
  isCardId,
  removeCard,
} from './cards';
import {
  applyEffects,
  emitEventOpening,
  markEventUsed,
  pickEvent,
} from './events';
import { assignPiperToFarthest, runPiperTurnStart, transferPiper } from './piper';
import { sayCharacterLine } from './speech';
import { cpuDecide as decideCpu } from './cpu';

export class EngineError extends Error {
  readonly code: string;

  constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = 'EngineError';
    this.code = code;
  }
}

export { annualIncome, currentPrice, netWorth };

/** Shortest-board-distance API (DESIGN §3). */
export function distance(data: GameData, fromNodeId: string, toNodeId: string): number {
  return shortestDistance(data, fromNodeId, toNodeId);
}

export function actorOf(state: GameState): number | null {
  if (state.phase.t === 'game_over') return null;
  return state.current;
}

export function cpuDecide(data: GameData, state: GameState): Action {
  return decideCpu(data, state);
}

/** State safe to broadcast: identical data with the RNG zeroed. */
export function sanitizeState(state: GameState): Omit<GameState, 'rng'> & { rng: 0 } {
  const clone = structuredClone(state);
  clone.rng = 0;
  return clone as Omit<GameState, 'rng'> & { rng: 0 };
}

// ---------------------------------------------------------------- creation

export function createGame(data: GameData, config: GameConfig): StepResult {
  validateConfig(data, config);
  const players = config.players;
  const rngSeed = (config.seed ?? 1) >>> 0;

  const missingCities = validateBoardCities(data);
  if (missingCities.length > 0) {
    throw new EngineError('illegal', `board is missing city nodes: ${missingCities.join(', ')}`);
  }
  if (data.cities.length === 0) throw new EngineError('illegal', 'GameData has no cities');

  const tier1 = data.cities.filter(
    (c) => c.tier === 1 && nodeForCity(data, c.id) !== null,
  );
  const startCity = pickOne({ rng: rngSeed }, tier1.length > 0 ? tier1 : data.cities);
  const startNode = nodeForCity(data, startCity.id) ?? '';
  if (!startNode) throw new EngineError('illegal', 'no usable start city');

  const playerStates: PlayerState[] = players.map((setup, id) => ({
    id,
    name: setup.name,
    characterId: setup.characterId,
    isCpu: setup.isCpu,
    cpuLevel: setup.cpuLevel ?? 1,
    cash: STARTING_CASH,
    nodeId: startNode,
    prevNodeId: null,
    cards: [],
    skipTurns: 0,
    goals: 0,
  }));

  const state: GameState = {
    version: 1,
    rng: rngSeed,
    config: structuredClone(config),
    year: 1,
    month: 4,
    round: 0,
    current: 0,
    phase: { t: 'turn_start' },
    players: playerStates,
    owner: {},
    priceMod: {},
    industryMods: [],
    destination: startCity.id,
    destinationStartDistance: 0,
    piper: { holder: null, level: 1, heldTurns: 0 },
    usedOnceEvents: [],
    activeEventId: null,
    assetHistory: [],
  };

  const fx: Fx[] = [];
  fx.push({ t: 'month', year: 1, month: 4 });
  chooseDestination(data, state, fx, startNode, { minDistance: 20, nearest: false });
  fx.push({ t: 'turn', playerId: 0 });
  sayCharacterLine(data, state, 0, 'turn', fx);
  return { state, fx };
}

function validateConfig(data: GameData, config: GameConfig): void {
  if (!Number.isInteger(config.years) || config.years < 1 || config.years > 10) {
    throw new EngineError('illegal', 'years must be an integer in 1..10');
  }
  if (!Array.isArray(config.players) || config.players.length < 1 || config.players.length > 4) {
    throw new EngineError('illegal', 'players must contain 1..4 entries');
  }
  const seen = new Set<string>();
  for (const setup of config.players) {
    const character = data.characters.find((c) => c.id === setup.characterId);
    if (!character) throw new EngineError('illegal', `unknown character: ${setup.characterId}`);
    if (seen.has(setup.characterId)) {
      throw new EngineError('illegal', `character already taken: ${setup.characterId}`);
    }
    seen.add(setup.characterId);
    if (setup.isCpu && ![1, 2, 3].includes(setup.cpuLevel ?? 1)) {
      throw new EngineError('illegal', 'cpuLevel must be 1, 2 or 3');
    }
  }
}

/** Picks and announces a new destination. Mutates the (cloned) state and rng. */
function chooseDestination(
  data: GameData,
  state: GameState,
  fx: Fx[],
  fromNodeId: string,
  opts: { minDistance: number; nearest: boolean },
): void {
  const usable = data.cities.filter((c) => nodeForCity(data, c.id) !== null);
  if (usable.length === 0) throw new EngineError('illegal', 'no cities with board nodes');

  interface Candidate {
    cityId: string;
    nodeId: string;
    dist: number;
  }
  const candidates: Candidate[] = usable
    .map((c) => {
      const nodeId = nodeForCity(data, c.id) as string;
      return { cityId: c.id, nodeId, dist: shortestDistance(data, fromNodeId, nodeId) };
    })
    .filter((c) => Number.isFinite(c.dist));

  if (candidates.length === 0) throw new EngineError('illegal', 'no reachable destination city');

  let eligible = candidates.filter((c) => c.dist >= opts.minDistance);
  if (eligible.length === 0) {
    // Very small maps cannot satisfy 20 steps; use the farthest city instead.
    const max = Math.max(...candidates.map((c) => c.dist));
    eligible = candidates.filter((c) => c.dist === max);
  }
  let chosen: Candidate;
  if (opts.nearest) {
    chosen = eligible.slice().sort((a, b) => {
      if (a.dist !== b.dist) return a.dist - b.dist;
      return a.cityId < b.cityId ? -1 : a.cityId > b.cityId ? 1 : 0;
    })[0];
  } else {
    chosen = pickOne(state, eligible);
  }
  state.destination = chosen.cityId;
  state.destinationStartDistance = chosen.dist;
  fx.push({ t: 'destination', cityId: chosen.cityId });
  const city = data.cities.find((c) => c.id === chosen.cityId);
  fx.push({
    t: 'toast',
    text: `新しい目的地は ${city?.nameJa ?? chosen.cityId}（最短 ${chosen.dist} 歩）。`,
  });
}

// ---------------------------------------------------------------- public step

export function step(
  data: GameData,
  state: GameState,
  playerId: number,
  action: Action,
): StepResult {
  const actor = actorOf(state);
  if (actor === null || playerId !== actor) {
    throw new EngineError('not_your_turn', 'this seat is not the active actor');
  }
  const next = structuredClone(state);
  const fx: Fx[] = [];
  switch (next.phase.t) {
    case 'turn_start':
      onTurnStart(data, next, fx, action);
      break;
    case 'choose_dest':
      onChooseDest(data, next, fx, action);
      break;
    case 'buy':
      onBuy(data, next, fx, action);
      break;
    case 'event':
      onEventChoice(data, next, fx, action);
      break;
    case 'card_target':
      onCardTarget(data, next, fx, action);
      break;
    case 'discard':
      onDiscard(data, next, fx, action);
      break;
    case 'sell':
      onSell(data, next, fx, action);
      break;
    case 'year_end':
      onAck(data, next, fx, action);
      break;
    case 'game_over':
      throw new EngineError('not_your_turn', 'the game is over');
    default: {
      const never: never = next.phase;
      throw new EngineError('illegal', `unknown phase ${JSON.stringify(never)}`);
    }
  }
  return { state: next, fx };
}

function illegal(message: string): never {
  throw new EngineError('illegal', message);
}

// ---------------------------------------------------------------- turn start & cards

function onTurnStart(data: GameData, state: GameState, fx: Fx[], action: Action): void {
  if (action.t === 'roll') {
    resolveRoll(data, state, fx, 1);
    return;
  }
  if (action.t === 'use_card') {
    useCard(data, state, fx, action.cardId);
    return;
  }
  illegal(`action ${action.t} is not legal at turn start`);
}

function useCard(data: GameData, state: GameState, fx: Fx[], cardId: string): void {
  const player = state.players[state.current];
  if (!player.cards.includes(cardId)) illegal('card not in hand');
  if (!isCardId(cardId)) illegal('card is not implemented');
  if (cardId === 'shield') illegal('shield is consumed automatically, not played');

  const targetKind = CARD_TARGETS[cardId];
  if (targetKind !== null) {
    const options = cardTargetOptions(data, state, cardId);
    if (options.length === 0) illegal('card has no legal target');
    removeCard(player.cards, cardId);
    fx.push({ t: 'card_use', playerId: player.id, cardId });
    sayCharacterLine(data, state, player.id, 'card', fx);
    state.phase = { t: 'card_target', cardId, options };
    return;
  }

  removeCard(player.cards, cardId);
  fx.push({ t: 'card_use', playerId: player.id, cardId });
  sayCharacterLine(data, state, player.id, 'card', fx);

  switch (cardId) {
    case 'express2':
      resolveRoll(data, state, fx, 2);
      return;
    case 'express3':
      resolveRoll(data, state, fx, 3);
      return;
    case 'tariff': {
      let gained = 0;
      for (const other of state.players) {
        if (other.id === player.id) continue;
        if (consumeShield(state, other.id, fx)) continue;
        const amount = Math.max(0, other.cash) * 0.05;
        other.cash -= amount;
        player.cash += amount;
        gained += amount;
        fx.push({ t: 'cash', playerId: other.id, delta: -amount, reason: '関税' });
        fx.push({ t: 'cash', playerId: player.id, delta: amount, reason: '関税' });
      }
      fx.push({ t: 'toast', text: `関税カードで ${gained} 億円を徴収した。` });
      resolveRoll(data, state, fx, 1);
      return;
    }
    case 'subsidy': {
      const amount = 40 * yearScale(state);
      player.cash += amount;
      fx.push({ t: 'cash', playerId: player.id, delta: amount, reason: '謎の補助金' });
      resolveRoll(data, state, fx, 1);
      return;
    }
    case 'bailout': {
      const debt = Math.max(0, -player.cash);
      const others = state.players.filter((p) => p.id !== player.id);
      if (debt <= 0 || others.length === 0) {
        fx.push({ t: 'toast', text: '借金がなかったので肩代わりは空振りに終わった。' });
      } else {
        const share = debt / others.length;
        for (const other of others) {
          other.cash -= share;
          fx.push({ t: 'cash', playerId: other.id, delta: -share, reason: '肩代わり' });
          settleDebtAutomatically(data, state, fx, other.id);
        }
        player.cash += debt;
        fx.push({ t: 'cash', playerId: player.id, delta: debt, reason: '肩代わり' });
        fx.push({ t: 'toast', text: `借金 ${debt} 億円を全員で等分に肩代わりした。` });
      }
      resolveRoll(data, state, fx, 1);
      return;
    }
    case 'golden_egg': {
      const amount = annualIncome(data, state, player.id) * 0.3;
      player.cash += amount;
      fx.push({ t: 'cash', playerId: player.id, delta: amount, reason: '金の卵' });
      resolveRoll(data, state, fx, 1);
      return;
    }
    case 'insider': {
      chooseDestination(data, state, fx, player.nodeId, { minDistance: 20, nearest: true });
      resolveRoll(data, state, fx, 1);
      return;
    }
    default:
      illegal(`card ${cardId} has no implementation`);
  }
}

/**
 * `Phase.card_target.options` encoding (UI / CPU contract):
 *  - stop / piper_pass: player id as a string ("0".."3")
 *  - takeover: "p:<propertyId>"
 *  - pegasus / carpet: city board node id ("c:<cityId>")
 */
function cardTargetOptions(data: GameData, state: GameState, cardId: string): string[] {
  const player = state.players[state.current];
  switch (cardId) {
    case 'stop':
    case 'piper_pass': {
      if (cardId === 'piper_pass' && state.piper.holder !== player.id) return [];
      return state.players
        .filter((p) => p.id !== player.id)
        .map((p) => String(p.id))
        .sort();
    }
    case 'takeover': {
      const options: string[] = [];
      for (const city of data.cities) {
        for (const property of city.properties) {
          const owner = state.owner[property.id];
          if (owner === undefined || owner === player.id) continue;
          const cost = takeoverCost(data, state, property.id);
          if (player.cash >= cost) options.push(`p:${property.id}`);
        }
      }
      return options.sort();
    }
    case 'pegasus':
      return data.cities
        .filter((c) => c.airport)
        .map((c) => nodeForCity(data, c.id))
        .filter((n): n is string => n !== null)
        .sort();
    case 'carpet': {
      const destNode = nodeForCity(data, state.destination);
      if (!destNode) return [];
      interface Cand {
        nodeId: string;
        dist: number;
        cityId: string;
      }
      const all: Cand[] = data.cities
        .map((c) => {
          const nodeId = nodeForCity(data, c.id);
          return nodeId ? { nodeId, cityId: c.id, dist: shortestDistance(data, destNode, nodeId) } : null;
        })
        .filter((c): c is Cand => c !== null && Number.isFinite(c.dist));
      const inRange = all.filter((c) => c.dist >= 5 && c.dist <= 10);
      const pool =
        inRange.length > 0
          ? inRange
          : all.slice().sort((a, b) => (a.dist !== b.dist ? a.dist - b.dist : a.cityId.localeCompare(b.cityId))).slice(0, 1);
      return pool.map((c) => c.nodeId).sort();
    }
    default:
      return [];
  }
}

function takeoverCost(data: GameData, state: GameState, propertyId: string): number {
  return currentPrice(data, state, propertyId) * 1.5;
}

// ---------------------------------------------------------------- dice & movement

function resolveRoll(data: GameData, state: GameState, fx: Fx[], diceCount: number): void {
  const player = state.players[state.current];
  const values: number[] = [];
  for (let i = 0; i < diceCount; i += 1) values.push(randInt(state, 1, 6));
  let total = values.reduce((sum, v) => sum + v, 0);

  // Sailor choice for this engine: +1 when the player starts the move on a port city or on
  // any node adjacent to a sea edge (rather than inspecting "the first edge taken", which is
  // unknowable before the player picks a destination path).
  const sailor = characterPerk(data, state, player.id) === 'sailor' && isPortOrAdjacentSea(data, player.nodeId);
  if (sailor) total += 1;

  fx.push({ t: 'dice', values });
  if (sailor) fx.push({ t: 'toast', text: '船員の勘で出目 +1！' });

  const destinationNode = nodeForCity(data, state.destination);
  let options = reachableInExactly(data, player.nodeId, total, player.prevNodeId, destinationNode);
  if (options.length === 0 && player.prevNodeId !== null) {
    options = reachableInExactly(data, player.nodeId, total, null, destinationNode);
  }
  if (options.length === 0) {
    fx.push({ t: 'toast', text: '進めるマスがなく、手番を終えた。' });
    endTurn(data, state, fx);
    return;
  }
  state.phase = { t: 'choose_dest', roll: total, options };
}

function onChooseDest(data: GameData, state: GameState, fx: Fx[], action: Action): void {
  if (action.t !== 'move') illegal(`action ${action.t} is not legal while choosing a destination`);
  const phase = state.phase;
  if (phase.t !== 'choose_dest') illegal('not choosing a destination');
  const option = phase.options.find((o) => o.nodeId === action.nodeId);
  if (!option) illegal('node is not one of the rolled options');
  moveAlong(data, state, fx, option);
}

function moveAlong(data: GameData, state: GameState, fx: Fx[], option: MoveOption): void {
  const player = state.players[state.current];
  const startNode = player.nodeId;
  fx.push({ t: 'move', playerId: player.id, path: option.path });

  for (const nodeId of option.path) {
    player.nodeId = nodeId;
    const others = state.players.filter((p) => p.id !== player.id && p.nodeId === nodeId);
    if (others.length === 0) continue;

    if (state.piper.holder === player.id) {
      const victim = others[0];
      transferPiper(
        state,
        fx,
        victim.id,
        `${player.name} が通過した ${victim.name} に取り立て屋を押し付けた！`,
      );
      sayCharacterLine(data, state, victim.id, 'piper_get', fx);
    }

    if (characterPerk(data, state, player.id) === 'pickpocket') {
      for (const other of others) {
        const amount = Math.max(0, other.cash) * 0.02;
        if (amount <= 0) continue;
        other.cash -= amount;
        player.cash += amount;
        fx.push({ t: 'cash', playerId: other.id, delta: -amount, reason: 'スリ' });
        fx.push({ t: 'cash', playerId: player.id, delta: amount, reason: 'スリ' });
      }
    }
  }

  player.prevNodeId =
    option.path.length >= 2 ? option.path[option.path.length - 2] : startNode;

  const finalNode = getGraph(data).nodes.get(player.nodeId);
  if (finalNode?.kind === 'city' && finalNode.cityId === state.destination) {
    claimDestination(data, state, fx, player);
  }
  processLanding(data, state, fx);
}

function claimDestination(data: GameData, state: GameState, fx: Fx[], player: PlayerState): void {
  const cityId = state.destination;
  const cityNode = nodeForCity(data, cityId);
  if (!cityNode) return;
  const startDistance = state.destinationStartDistance ?? 20;
  const bonus = destinationBonus(state, startDistance);
  player.cash += bonus;
  player.goals += 1;
  fx.push({ t: 'goal', playerId: player.id, cityId, bonus });
  fx.push({ t: 'cash', playerId: player.id, delta: bonus, reason: '目的地ボーナス' });
  sayCharacterLine(data, state, player.id, 'goal', fx);

  assignPiperToFarthest(data, state, fx, cityNode, player.id);
  chooseDestination(data, state, fx, player.nodeId, { minDistance: 20, nearest: false });
}

// ---------------------------------------------------------------- landing squares

function processLanding(data: GameData, state: GameState, fx: Fx[]): void {
  const player = state.players[state.current];
  const node = getGraph(data).nodes.get(player.nodeId);
  if (!node) {
    endTurn(data, state, fx);
    return;
  }
  switch (node.kind) {
    case 'city': {
      const cityId = node.cityId;
      if (!cityId) {
        endTurn(data, state, fx);
        return;
      }
      state.phase = { t: 'buy', cityId };
      const city = data.cities.find((c) => c.id === cityId);
      fx.push({ t: 'toast', text: `${city?.nameJa ?? cityId} に到着。物件を購入できる。` });
      return;
    }
    case 'blue': {
      let amount = randInt(state, 8, 20) * yearScale(state);
      if (characterPerk(data, state, player.id) === 'lucky') amount *= 1.3;
      player.cash += amount;
      fx.push({ t: 'cash', playerId: player.id, delta: amount, reason: '青マス' });
      sayCharacterLine(data, state, player.id, 'blue', fx);
      endTurn(data, state, fx);
      return;
    }
    case 'red': {
      let amount = randInt(state, 5, 15) * yearScale(state);
      if (characterPerk(data, state, player.id) === 'tough') amount *= 0.6;
      if (consumeShield(state, player.id, fx)) amount = 0;
      if (amount > 0) {
        player.cash -= amount;
        fx.push({ t: 'cash', playerId: player.id, delta: -amount, reason: '赤マス' });
      }
      sayCharacterLine(data, state, player.id, 'red', fx);
      if (player.cash < 0 && ownedProperties(data, state, player.id).length > 0) {
        state.phase = { t: 'sell' };
        fx.push({ t: 'toast', text: '資金不足！ 物件を売却して支払おう。' });
        return;
      }
      endTurn(data, state, fx);
      return;
    }
    case 'yellow': {
      const count = characterPerk(data, state, player.id) === 'card_shark' ? 2 : 1;
      const drawn = drawCards(data, state, count);
      for (const cardId of drawn) {
        player.cards.push(cardId);
        fx.push({ t: 'card_get', playerId: player.id, cardId });
      }
      if (drawn.length === 0) fx.push({ t: 'toast', text: 'カード山が空だった。' });
      const limit = handLimitFor(characterPerk(data, state, player.id));
      if (player.cards.length > limit) {
        state.phase = { t: 'discard' };
        fx.push({ t: 'toast', text: `手札上限 ${limit} 枚を超えた。カードを捨てよう。` });
        return;
      }
      endTurn(data, state, fx);
      return;
    }
    case 'news': {
      const event = pickEvent(data, state);
      if (!event) {
        fx.push({ t: 'toast', text: 'ニュースは流れなかった。平和である。' });
        endTurn(data, state, fx);
        return;
      }
      markEventUsed(state, event);
      state.activeEventId = event.id;
      emitEventOpening(state, fx, event, player.id);
      if (event.choices && event.choices.length > 0) {
        state.phase = { t: 'event', eventId: event.id };
        return;
      }
      applyEventAndFinish(data, state, fx, player.id, undefined);
      return;
    }
    default:
      endTurn(data, state, fx);
  }
}

// ---------------------------------------------------------------- event & card target resolution

function onEventChoice(data: GameData, state: GameState, fx: Fx[], action: Action): void {
  if (action.t !== 'choose') illegal(`action ${action.t} is not legal during an event`);
  const phase = state.phase;
  if (phase.t !== 'event') illegal('not resolving an event');
  const event = data.events.find((e) => e.id === phase.eventId);
  if (!event) illegal('event not found');
  if (!event.choices || !Number.isInteger(action.index) || action.index < 0 || action.index >= event.choices.length) {
    illegal('invalid event choice');
  }
  const choice = event.choices[action.index];
  for (const line of choice.reply ?? []) {
    fx.push({
      t: 'say',
      speaker: line.speaker,
      text: line.text,
      ...(line.speaker === 'self' ? { playerId: state.current } : {}),
    });
  }
  applyEventAndFinish(data, state, fx, state.current, choice.effects);
}

function applyEventAndFinish(
  data: GameData,
  state: GameState,
  fx: Fx[],
  actor: number,
  effects: Parameters<typeof applyEffects>[3],
): void {
  applyEffects(data, state, fx, effects, actor);
  fx.push({ t: 'event_close' });
  state.activeEventId = null;
  finishAfterEffects(data, state, fx);
}

function finishAfterEffects(
  data: GameData,
  state: GameState,
  fx: Fx[],
): void {
  const player = state.players[state.current];
  if (player.cash < 0 && ownedProperties(data, state, player.id).length > 0) {
    state.phase = { t: 'sell' };
    fx.push({ t: 'toast', text: '支払いで資金不足になった。物件を売却しよう。' });
    return;
  }
  const limit = handLimitFor(characterPerk(data, state, player.id));
  if (player.cards.length > limit) {
    state.phase = { t: 'discard' };
    fx.push({ t: 'toast', text: `手札上限 ${limit} 枚を超えた。カードを捨てよう。` });
    return;
  }
  endTurn(data, state, fx);
}

function onCardTarget(data: GameData, state: GameState, fx: Fx[], action: Action): void {
  const phase = state.phase;
  if (phase.t !== 'card_target') illegal('not choosing a card target');
  if (action.t === 'cancel') {
    const player = state.players[state.current];
    player.cards.push(phase.cardId);
    state.phase = { t: 'turn_start' };
    fx.push({ t: 'toast', text: 'カードの使用を取り消した。' });
    return;
  }
  if (action.t !== 'card_target') illegal(`action ${action.t} is not legal while choosing a card target`);
  if (!phase.options.includes(action.target)) illegal('target is not one of the options');
  const player = state.players[state.current];

  switch (phase.cardId) {
    case 'stop': {
      const target = state.players[Number(action.target)];
      if (!target) illegal('invalid player target');
      if (consumeShield(state, target.id, fx)) {
        resolveRoll(data, state, fx, 1);
        return;
      }
      target.skipTurns += 1;
      fx.push({ t: 'toast', text: `${target.name} は牛歩法案で1回休みになった。` });
      resolveRoll(data, state, fx, 1);
      return;
    }
    case 'piper_pass': {
      const target = state.players[Number(action.target)];
      if (!target) illegal('invalid player target');
      if (consumeShield(state, target.id, fx)) {
        resolveRoll(data, state, fx, 1);
        return;
      }
      transferPiper(state, fx, target.id, `${player.name} は取り立て屋を ${target.name} に押し付けた！`);
      sayCharacterLine(data, state, target.id, 'piper_get', fx);
      resolveRoll(data, state, fx, 1);
      return;
    }
    case 'takeover': {
      if (!action.target.startsWith('p:')) illegal('invalid takeover target');
      const propertyId = action.target.slice(2);
      const ownerId = state.owner[propertyId];
      if (ownerId === undefined || ownerId === player.id) illegal('property cannot be taken over');
      const cost = takeoverCost(data, state, propertyId);
      if (player.cash < cost) illegal('not enough cash for takeover');
      const owner = state.players[ownerId];
      if (consumeShield(state, ownerId, fx)) {
        resolveRoll(data, state, fx, 1);
        return;
      }
      player.cash -= cost;
      owner.cash += cost;
      state.owner[propertyId] = player.id;
      fx.push({ t: 'cash', playerId: player.id, delta: -cost, reason: '敵対的買収' });
      fx.push({ t: 'cash', playerId: owner.id, delta: cost, reason: '敵対的買収' });
      const ref = findProperty(data, propertyId);
      const mono = ref ? monopolises(data, state, player.id, ref.cityId) : false;
      fx.push({ t: 'buy', playerId: player.id, propertyId, monopoly: mono });
      fx.push({ t: 'toast', text: `${owner.name} から ${ref?.property.name ?? propertyId} を ${cost} 億で強制買収した。` });
      resolveRoll(data, state, fx, 1);
      return;
    }
    case 'pegasus':
    case 'carpet': {
      const node = getGraph(data).nodes.get(action.target);
      if (!node || node.kind !== 'city') illegal('invalid city target');
      player.nodeId = action.target;
      player.prevNodeId = null;
      fx.push({ t: 'warp', playerId: player.id, nodeId: action.target });
      if (node.cityId === state.destination) claimDestination(data, state, fx, player);
      processLanding(data, state, fx);
      return;
    }
    default:
      illegal(`card ${phase.cardId} does not take a target`);
  }
}

// ---------------------------------------------------------------- buy / sell / discard

function onBuy(data: GameData, state: GameState, fx: Fx[], action: Action): void {
  const phase = state.phase;
  if (phase.t !== 'buy') illegal('not in the buy phase');
  const player = state.players[state.current];
  if (action.t === 'end_buy') {
    endTurn(data, state, fx);
    return;
  }
  if (action.t !== 'buy') illegal(`action ${action.t} is not legal while buying`);

  const city = data.cities.find((c) => c.id === phase.cityId);
  const property = city?.properties.find((p) => p.id === action.propertyId);
  if (!city || !property) illegal('property does not belong to this city');
  if (state.owner[property.id] !== undefined) illegal('property already owned');
  const cost = purchasePrice(data, state, player.id, property.id);
  if (player.cash < cost) illegal('not enough cash');

  player.cash -= cost;
  state.owner[property.id] = player.id;
  const mono = monopolises(data, state, player.id, city.id);
  fx.push({ t: 'cash', playerId: player.id, delta: -cost, reason: '物件購入' });
  fx.push({ t: 'buy', playerId: player.id, propertyId: property.id, monopoly: mono });
  sayCharacterLine(data, state, player.id, 'buy', fx);
  if (mono) {
    fx.push({ t: 'toast', text: `${city.nameJa} を独占！ 決算収益が2倍になる。` });
    sayCharacterLine(data, state, player.id, 'monopoly', fx);
  }
}

function onSell(data: GameData, state: GameState, fx: Fx[], action: Action): void {
  if (action.t !== 'sell') illegal(`action ${action.t} is not legal while selling`);
  const player = state.players[state.current];
  if (state.owner[action.propertyId] !== player.id) illegal('you do not own this property');
  const amount = sellPrice(data, state, action.propertyId);
  delete state.owner[action.propertyId];
  player.cash += amount;
  fx.push({ t: 'sell', playerId: player.id, propertyId: action.propertyId, amount });
  fx.push({ t: 'cash', playerId: player.id, delta: amount, reason: '物件売却' });
  if (player.cash >= 0 || ownedProperties(data, state, player.id).length === 0) {
    endTurn(data, state, fx);
  }
}

function onDiscard(data: GameData, state: GameState, fx: Fx[], action: Action): void {
  if (action.t !== 'discard') illegal(`action ${action.t} is not legal while discarding`);
  const player = state.players[state.current];
  if (!removeCard(player.cards, action.cardId)) illegal('card not in hand');
  fx.push({ t: 'toast', text: `${player.name} は ${action.cardId} を捨てた。` });
  const limit = handLimitFor(characterPerk(data, state, player.id));
  if (player.cards.length <= limit) endTurn(data, state, fx);
}

function settleDebtAutomatically(
  data: GameData,
  state: GameState,
  fx: Fx[],
  playerId: number,
): void {
  const player = state.players[playerId];
  while (player.cash < 0 && ownedProperties(data, state, playerId).length > 0) {
    const cheapest = ownedProperties(data, state, playerId).sort((a, b) => {
      const pa = currentPrice(data, state, a.property.id);
      const pb = currentPrice(data, state, b.property.id);
      return pa !== pb ? pa - pb : a.property.id.localeCompare(b.property.id);
    })[0];
    const amount = sellPrice(data, state, cheapest.property.id);
    delete state.owner[cheapest.property.id];
    player.cash += amount;
    fx.push({ t: 'sell', playerId, propertyId: cheapest.property.id, amount });
    fx.push({ t: 'cash', playerId, delta: amount, reason: '自動売却' });
  }
}

// ---------------------------------------------------------------- turn advance & settlement

function endTurn(data: GameData, state: GameState, fx: Fx[]): void {
  state.activeEventId = null;
  advanceTurn(data, state, fx);
}

function advanceTurn(data: GameData, state: GameState, fx: Fx[]): void {
  const n = state.players.length;
  let guard = 0;
  for (;;) {
    state.current = (state.current + 1) % n;
    if (state.current === 0) {
      if (state.month === 3) {
        settleYear(data, state, fx);
        return;
      }
      state.month = state.month === 12 ? 1 : state.month + 1;
      state.round += 1;
      state.assetHistory.push(state.players.map((p) => netWorth(data, state, p.id)));
      fx.push({ t: 'month', year: state.year, month: state.month });
    }
    const player = state.players[state.current];
    if (player.skipTurns > 0) {
      player.skipTurns -= 1;
      fx.push({ t: 'skip', playerId: player.id });
      guard += 1;
      if (guard > n * 10000) {
        for (const p of state.players) p.skipTurns = 0;
      }
      continue;
    }
    beginTurn(data, state, fx);
    return;
  }
}

function beginTurn(data: GameData, state: GameState, fx: Fx[]): void {
  const player = state.players[state.current];
  if (player.skipTurns > 0) {
    player.skipTurns -= 1;
    fx.push({ t: 'skip', playerId: player.id });
    advanceTurn(data, state, fx);
    return;
  }
  state.phase = { t: 'turn_start' };
  fx.push({ t: 'turn', playerId: player.id });
  sayCharacterLine(data, state, player.id, 'turn', fx);

  const skip = runPiperTurnStart(data, state, fx);
  if (skip === 'skip') {
    player.skipTurns = Math.max(0, player.skipTurns - 1);
    fx.push({ t: 'skip', playerId: player.id });
    advanceTurn(data, state, fx);
    return;
  }
  if (player.cash < 0 && ownedProperties(data, state, player.id).length > 0) {
    state.phase = { t: 'sell' };
    fx.push({ t: 'toast', text: '取り立てで資金不足になった。物件を売却しよう。' });
    return;
  }
}

function settleYear(data: GameData, state: GameState, fx: Fx[]): void {
  const year = state.year;
  const income: YearReport['income'] = [];
  for (const player of state.players) {
    const amount = annualIncome(data, state, player.id);
    player.cash += amount;
    income.push({ playerId: player.id, amount });
    fx.push({ t: 'cash', playerId: player.id, delta: amount, reason: '決算' });
  }

  state.industryMods = state.industryMods
    .map((m) => ({ ...m, yearsLeft: m.yearsLeft - 1 }))
    .filter((m) => m.yearsLeft > 0);

  const assets: YearReport['assets'] = state.players.map((p) => ({
    playerId: p.id,
    total: netWorth(data, state, p.id),
  }));
  const ranking = [...state.players]
    .sort((a, b) => {
      const wa = netWorth(data, state, a.id);
      const wb = netWorth(data, state, b.id);
      return wa !== wb ? wb - wa : a.id - b.id;
    })
    .map((p) => p.id);
  const headline = satiricalHeadline(data, state, ranking[0]);
  const report: YearReport = { year, income, assets, headline };
  state.assetHistory.push(assets.map((a) => a.total));
  state.round += 1;
  state.current = 0;
  state.phase = { t: 'year_end', report };
  fx.push({ t: 'year_end', report });
}

function onAck(data: GameData, state: GameState, fx: Fx[], action: Action): void {
  if (action.t !== 'ack') illegal(`action ${action.t} is not legal at year end`);
  if (state.year >= state.config.years) {
    const ranking = [...state.players]
      .sort((a, b) => {
        const wa = netWorth(data, state, a.id);
        const wb = netWorth(data, state, b.id);
        return wa !== wb ? wb - wa : a.id - b.id;
      })
      .map((p) => p.id);
    state.phase = { t: 'game_over', ranking };
    state.activeEventId = null;
    fx.push({ t: 'game_over', ranking });
    fx.push({ t: 'toast', text: `優勝は ${state.players[ranking[0]].name}！ 世界は今日も平和に格差した。` });
    sayCharacterLine(data, state, ranking[0], 'win', fx);
    if (ranking.length > 1) sayCharacterLine(data, state, ranking[ranking.length - 1], 'lose', fx);
    return;
  }
  state.year += 1;
  state.month = 4;
  state.current = 0;
  fx.push({ t: 'month', year: state.year, month: 4 });
  beginTurn(data, state, fx);
}