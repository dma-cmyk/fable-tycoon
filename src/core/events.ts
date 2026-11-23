// Event drawing and the Effect DSL interpreter (DESIGN §2.6).
//
// `applyEffects` is pure with respect to the caller's inputs: `step` hands it an already
// cloned state. It reports the side conditions the engine must route into a phase:
//   moved     - the actor was warped (no landing square is processed)
//   needsSell - the actor's cash is negative and they still own property
//   skipped   - the actor now has skipTurns > 0

import type {
  Effect,
  Fx,
  GameData,
  GameEventDef,
  GameState,
  Industry,
  RealmId,
  Who,
} from './types';
import { nextRandom, pickOne, shuffled, weightedPick } from './rng';
import { getGraph, nodeForCity, shortestDistance } from './graph';
import {
  characterPerk,
  currentPrice,
  netWorth,
  ownedProperties,
  sellPrice,
  yearScale,
} from './economy';
import { drawCards, handLimitFor, isCardId } from './cards';
import { transferPiper } from './piper';
import { REALMS, randomWorldCityNodeId, realmEntryNodeId } from './realm';
import { emitDialogueLines, sayCharacterLine } from './speech';

function monthAllowed(event: GameEventDef, month: number): boolean {
  return !event.months || event.months.includes(month);
}

function realmAllowed(event: GameEventDef, realm: RealmId | 'world'): boolean {
  if (!event.realms || event.realms.length === 0) return realm === 'world';
  return event.realms.includes(realm);
}

/** Picks a weighted, year-, month-, realm- and once-eligible news event. */
export function pickEvent(
  data: GameData,
  state: GameState,
  realm: RealmId | 'world' = 'world',
): GameEventDef | null {
  const eligible = data.events.filter(
    (e) =>
      e.monthly !== true &&
      e.weight > 0 &&
      state.year >= (e.minYear ?? 1) &&
      monthAllowed(e, state.month) &&
      realmAllowed(e, realm) &&
      (!e.once || !state.usedOnceEvents.includes(e.id)),
  );
  return weightedPick(state, eligible, (e) => e.weight);
}

/** Month-start event candidates; the 30% chance roll lives in engine.ts. */
export function pickMonthlyEvent(
  data: GameData,
  state: GameState,
  month: number = state.month,
): GameEventDef | null {
  const eligible = data.events.filter(
    (e) =>
      e.monthly === true &&
      e.weight > 0 &&
      state.year >= (e.minYear ?? 1) &&
      monthAllowed(e, month) &&
      (!e.once || !state.usedOnceEvents.includes(e.id)),
  );
  return weightedPick(state, eligible, (e) => e.weight);
}

export function markEventUsed(state: GameState, event: GameEventDef): void {
  if (event.once && !state.usedOnceEvents.includes(event.id)) {
    state.usedOnceEvents.push(event.id);
  }
}

/** Emits the opening dialogue, then closes the event window. */
export function emitEventOpening(state: GameState, fx: Fx[], event: GameEventDef, actor: number): void {
  fx.push({ t: 'event_open', eventId: event.id, playerId: actor });
  emitDialogueLines(state, fx, event.lines, actor);
}

export function resolveTargets(data: GameData, state: GameState, who: Who, actor: number): number[] {
  const ids = state.players.map((p) => p.id);
  switch (who) {
    case 'self':
      return ids.includes(actor) ? [actor] : [];
    case 'all':
      return ids;
    case 'others':
      return ids.filter((id) => id !== actor);
    case 'richest':
    case 'poorest': {
      if (ids.length === 0) return [];
      let best = ids[0];
      for (const id of ids) {
        const a = netWorth(data, state, id);
        const b = netWorth(data, state, best);
        if (who === 'richest' ? a > b : a < b) best = id;
        // ties go to the lower player id (iteration order is ascending)
      }
      return [best];
    }
    case 'random_other': {
      const others = ids.filter((id) => id !== actor);
      return others.length === 0 ? [] : [pickOne(state, others)];
    }
    default:
      return [];
  }
}

export function applyEffects(
  data: GameData,
  state: GameState,
  fx: Fx[],
  effects: Effect[] | undefined,
  actor: number,
): void {
  for (const effect of effects ?? []) applyEffect(data, state, fx, effect, actor);

  // Other players cannot enter a per-player sell phase mid-turn; settle them automatically.
  for (const player of state.players) {
    if (player.id === actor) continue;
    while (player.cash < 0 && ownedProperties(data, state, player.id).length > 0) {
      const cheapest = ownedProperties(data, state, player.id).sort(
        (a, b) => {
          const pa = currentPrice(data, state, a.property.id);
          const pb = currentPrice(data, state, b.property.id);
          return pa !== pb ? pa - pb : a.property.id.localeCompare(b.property.id);
        },
      )[0];
      const amount = sellPrice(data, state, cheapest.property.id);
      delete state.owner[cheapest.property.id];
      player.cash += amount;
      fx.push({ t: 'sell', playerId: player.id, amount, propertyId: cheapest.property.id });
    }
    const limit = handLimitFor(characterPerk(data, state, player.id));
    if (player.cards.length > limit) {
      const drop = shuffled(state, player.cards).slice(0, player.cards.length - limit);
      for (const cardId of drop) {
        const index = player.cards.indexOf(cardId);
        if (index >= 0) player.cards.splice(index, 1);
      }
      fx.push({ t: 'toast', text: `${player.name} の手札が上限を超えたため ${drop.length} 枚捨てた。` });
    }
  }
}

function applyEffect(
  data: GameData,
  state: GameState,
  fx: Fx[],
  effect: Effect,
  actor: number,
): void {
  switch (effect.op) {
    case 'cash': {
      const amount = effect.amount * (effect.scale === false ? 1 : yearScale(state));
      for (const id of resolveTargets(data, state, effect.who, actor)) {
        const p = state.players[id];
        p.cash += amount;
        fx.push({ t: 'cash', playerId: id, delta: amount, reason: 'イベント' });
      }
      return;
    }
    case 'cash_pct': {
      for (const id of resolveTargets(data, state, effect.who, actor)) {
        const p = state.players[id];
        const delta = Math.max(0, p.cash) * (effect.pct / 100);
        p.cash += delta;
        fx.push({ t: 'cash', playerId: id, delta, reason: 'イベント' });
      }
      return;
    }
    case 'per_property': {
      const scale = effect.scale === false ? 1 : yearScale(state);
      for (const id of resolveTargets(data, state, effect.who, actor)) {
        const count = ownedProperties(data, state, id).filter(
          (ref) => effect.industry === 'any' || ref.property.industry === effect.industry,
        ).length;
        const delta = effect.perProperty * scale * count;
        state.players[id].cash += delta;
        fx.push({ t: 'cash', playerId: id, delta, reason: 'イベント物件収益' });
      }
      return;
    }
    case 'industry_mod': {
      state.industryMods.push({
        industry: effect.industry,
        mult: effect.mult,
        yearsLeft: effect.years,
        label: effect.label,
      });
      fx.push({ t: 'industry', industry: effect.industry, mult: effect.mult, label: effect.label });
      return;
    }
    case 'price_mod': {
      const prev = state.priceMod[effect.industry] ?? 1;
      state.priceMod[effect.industry] = prev * effect.mult;
      fx.push({
        t: 'toast',
        text: `${industryLabel(effect.industry)}の物件価格が ${Math.round((prev * effect.mult - 1) * 100)}% 変動した。`,
      });
      return;
    }
    case 'sell': {
      for (const id of resolveTargets(data, state, effect.who, actor)) {
        forceSell(data, state, fx, id, effect.industry, effect.count, effect.priceMult);
      }
      return;
    }
    case 'card': {
      const count = effect.count ?? 1;
      for (const id of resolveTargets(data, state, effect.who, actor)) {
        const drawn = isCardId(effect.card) ? Array.from({ length: count }, () => effect.card) : drawCards(data, state, count);
        for (const cardId of drawn) {
          state.players[id].cards.push(cardId);
          fx.push({ t: 'card_get', playerId: id, cardId });
        }
      }
      return;
    }
    case 'move': {
      for (const id of resolveTargets(data, state, effect.who, actor)) {
        const nodeId = resolveMoveNode(data, state, id, effect.to);
        if (!nodeId) continue;
        state.players[id].nodeId = nodeId;
        state.players[id].prevNodeId = null;
        fx.push({ t: 'warp', playerId: id, nodeId, via: 'event' });
      }
      return;
    }
    case 'skip': {
      for (const id of resolveTargets(data, state, effect.who, actor)) {
        state.players[id].skipTurns += effect.turns;
        fx.push({ t: 'toast', text: `${state.players[id].name} は ${effect.turns} 回休みになった。` });
      }
      return;
    }
    case 'piper': {
      const targets = resolveTargets(data, state, effect.to, actor);
      for (const id of targets) {
        transferPiper(state, fx, id, `イベントの力で ${state.players[id].name} に取り立て屋が移った！`);
        sayCharacterLine(data, state, id, 'piper_get', fx);
      }
      return;
    }
    case 'realm': {
      for (const id of resolveTargets(data, state, effect.who, actor)) {
        const node =
          effect.realm === 'world'
            ? randomWorldCityNodeId(data, state)
            : realmEntryNodeId(data, effect.realm);
        if (!node) continue;
        state.players[id].nodeId = node;
        state.players[id].prevNodeId = null;
        fx.push({ t: 'warp', playerId: id, nodeId: node, via: 'realm' });
        fx.push({
          t: 'toast',
          text:
            effect.realm === 'world'
              ? `${state.players[id].name} は地上へ戻された。`
              : `${state.players[id].name} は ${REALMS[effect.realm].nameJa} へ飛ばされた。`,
        });
      }
      return;
    }
    case 'gamble': {
      const win = nextRandom(state) < effect.chance;
      fx.push({ t: 'toast', text: win ? '賭けに勝った！' : '賭けに負けた……' });
      for (const child of win ? effect.win : effect.lose) {
        applyEffect(data, state, fx, child, actor);
      }
      return;
    }
    default: {
      const never: never = effect;
      throw new Error(`unknown effect: ${JSON.stringify(never)}`);
    }
  }
}

function forceSell(
  data: GameData,
  state: GameState,
  fx: Fx[],
  playerId: number,
  industry: Industry | 'any',
  count: number,
  priceMult: number,
): void {
  const owned = ownedProperties(data, state, playerId)
    .filter((ref) => industry === 'any' || ref.property.industry === industry)
    .sort((a, b) => {
      const pa = currentPrice(data, state, a.property.id);
      const pb = currentPrice(data, state, b.property.id);
      return pa !== pb ? pa - pb : a.property.id.localeCompare(b.property.id);
    });
  for (const ref of owned.slice(0, Math.max(0, count))) {
    const amount = currentPrice(data, state, ref.property.id) * priceMult;
    delete state.owner[ref.property.id];
    state.players[playerId].cash += amount;
    fx.push({ t: 'sell', playerId, propertyId: ref.property.id, amount });
  }
}

function resolveMoveNode(
  data: GameData,
  state: GameState,
  playerId: number,
  to: string,
): string | null {
  const cities = data.cities;
  if (cities.length === 0) return null;
  const player = state.players[playerId];
  if (to === 'random_city') {
    return randomWorldCityNodeId(data, state);
  }
  if (to === 'nearest_port') {
    const ports = cities.filter((c) => c.realm === undefined && c.port);
    if (ports.length === 0) {
      const world = cities.filter((c) => c.realm === undefined);
      return world.length > 0 ? nodeForCity(data, world[0].id) : null;
    }
    const sorted = ports.slice().sort((a, b) => {
      const na = nodeForCity(data, a.id) ?? '';
      const nb = nodeForCity(data, b.id) ?? '';
      const da = shortestDistance(data, player.nodeId, na);
      const db = shortestDistance(data, player.nodeId, nb);
      return da !== db ? da - db : a.id.localeCompare(b.id);
    });
    return nodeForCity(data, sorted[0].id);
  }
  if (to === 'destination_near') {
    const destNode = nodeForCity(data, state.destination);
    if (!destNode) return null;
    const sorted = cities
      .filter((c) => c.realm === undefined)
      .slice()
      .sort((a, b) => {
      const na = nodeForCity(data, a.id) ?? '';
      const nb = nodeForCity(data, b.id) ?? '';
      const da = shortestDistance(data, destNode, na);
      const db = shortestDistance(data, destNode, nb);
      return da !== db ? da - db : a.id.localeCompare(b.id);
    });
    return nodeForCity(data, sorted[0].id);
  }
  const graph = getGraph(data);
  if (graph.nodes.has(to)) return to;
  const node = graph.cityNode.get(to);
  if (node) return node;
  // Unknown string: leave the player where they are rather than corrupting the state.
  return null;
}

function industryLabel(industry: Industry): string {
  const labels: Record<Industry, string> = {
    agri: '農林水産',
    food: '食品・飲食',
    tourism: '観光',
    industry: '工業',
    tech: 'IT・AI',
    finance: '金融',
    energy: '資源・エネルギー',
    shipping: '物流・海運',
    media: '娯楽・メディア',
  };
  return labels[industry];
}