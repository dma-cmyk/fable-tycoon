import { describe, expect, it } from 'vitest';
import type { Effect, GameConfig, GameData, GameState } from './types';
import { fixtureData } from './test-fixture';
import { createGame, cpuDecide, currentPrice, step } from './engine';
import { applyEffects, markEventUsed, pickEvent } from './events';
import { shortestDistance } from './graph';

const data: GameData = fixtureData;

function config(players = 3, seed = 1): GameConfig {
  const characters = ['momotaro', 'sinbad', 'alice', 'red_hood'];
  return {
    years: 3,
    seed,
    players: Array.from({ length: players }, (_, i) => ({
      name: `P${i}`,
      characterId: characters[i],
      isCpu: true,
      cpuLevel: 1 as const,
    })),
  };
}

function fresh(players = 3, seed = 1): GameState {
  return createGame(data, config(players, seed)).state;
}

function apply(state: GameState, effects: Effect[], actor = 0): string[] {
  const fx: Parameters<typeof applyEffects>[2] = [];
  applyEffects(data, state, fx, effects, actor);
  return fx.map((f) => f.t);
}

describe('Effect DSL', () => {
  it('cash uses yearScale unless scale:false', () => {
    const state = fresh();
    state.year = 3;
    state.players[0].cash = 0;
    apply(state, [{ op: 'cash', who: 'self', amount: 10 }]);
    expect(state.players[0].cash).toBe(17);
    apply(state, [{ op: 'cash', who: 'self', amount: 10, scale: false }]);
    expect(state.players[0].cash).toBe(27);
  });

  it('cash_pct applies to positive cash only', () => {
    const state = fresh();
    for (const p of state.players) p.cash = 100;
    apply(state, [{ op: 'cash_pct', who: 'all', pct: -10 }]);
    for (const p of state.players) expect(p.cash).toBe(90);
    state.players[0].cash = -50;
    apply(state, [{ op: 'cash_pct', who: 'self', pct: 10 }]);
    expect(state.players[0].cash).toBe(-50);
  });

  it('per_property counts matching industry, with scale', () => {
    const state = fresh();
    state.year = 2;
    state.owner['tokyo-tower'] = 0; // tourism
    state.owner['tokyo-bank'] = 0; // finance
    state.players[0].cash = 0;
    apply(state, [{ op: 'per_property', who: 'self', industry: 'tourism', perProperty: 3 }]);
    expect(state.players[0].cash).toBeCloseTo(4.05); // 3 × 1.35
    apply(state, [{ op: 'per_property', who: 'self', industry: 'any', perProperty: 2, scale: false }]);
    expect(state.players[0].cash).toBeCloseTo(8.05); // +2 × 2 properties
  });

  it('industry_mod stacks and is exposed via fx', () => {
    const state = fresh();
    const events = apply(state, [
      { op: 'industry_mod', industry: 'tech', mult: 2, years: 2, label: 'AI' },
      { op: 'industry_mod', industry: 'tech', mult: 1.5, years: 1, label: 'AI2' },
    ]);
    expect(events).toContain('industry');
    expect(state.industryMods).toHaveLength(2);
    expect(state.industryMods[0]).toEqual({ industry: 'tech', mult: 2, yearsLeft: 2, label: 'AI' });
  });

  it('price_mod permanently changes asset value', () => {
    const state = fresh();
    apply(state, [{ op: 'price_mod', industry: 'tech', mult: 0.5 }]);
    expect(state.priceMod.tech).toBe(0.5);
    expect(currentPrice(data, state, 'sf-ai')).toBe(32.5);
  });

  it('sell force-sells the cheapest matching properties first', () => {
    const state = fresh();
    state.players[1].cash = 0;
    state.owner['tokyo-tower'] = 1; // 40
    state.owner['tokyo-bank'] = 1; // 60
    const fx = apply(state, [{ op: 'sell', who: 'others', industry: 'any', count: 1, priceMult: 0.5 }]);
    expect(fx).toContain('sell');
    expect(state.owner['tokyo-tower']).toBeUndefined();
    expect(state.owner['tokyo-bank']).toBe(1);
    expect(state.players[1].cash).toBe(20);
  });

  it('card draws cards into the target hand', () => {
    const state = fresh();
    apply(state, [{ op: 'card', who: 'self', card: 'shield', count: 2 }]);
    expect(state.players[0].cards).toEqual(['shield', 'shield']);
  });

  it('move supports random_city, nearest_port, destination_near and a city id', () => {
    const state = fresh();
    state.players[0].nodeId = 'c:mumbai';
    state.destination = 'rio';
    apply(state, [{ op: 'move', who: 'self', to: 'random_city' }]);
    const randomNode = state.players[0].nodeId;
    expect(randomNode.startsWith('c:')).toBe(true);
    apply(state, [{ op: 'move', who: 'self', to: 'nearest_port' }]);
    const portCityId = state.players[0].nodeId.slice(2);
    expect(data.cities.find((c) => c.id === portCityId)?.port).toBe(true);
    apply(state, [{ op: 'move', who: 'self', to: 'destination_near' }]);
    expect(shortestDistance(data, state.players[0].nodeId, 'c:rio')).toBeLessThanOrEqual(4);
    apply(state, [{ op: 'move', who: 'self', to: 'cairo' }]);
    expect(state.players[0].nodeId).toBe('c:cairo');
    expect(state.players[0].prevNodeId).toBeNull();
  });

  it('skip adds skipTurns', () => {
    const state = fresh();
    apply(state, [{ op: 'skip', who: 'self', turns: 2 }]);
    expect(state.players[0].skipTurns).toBe(2);
  });

  it('piper assigns the holder directly', () => {
    const state = fresh(2);
    apply(state, [{ op: 'piper', to: 'self' }]);
    expect(state.piper.holder).toBe(0);
    apply(state, [{ op: 'piper', to: 'others' }]);
    expect(state.piper.holder).toBe(1);
  });

  it('gamble runs win/lose branches deterministically', () => {
    const state = fresh();
    state.players[0].cash = 0;
    apply(state, [
      { op: 'gamble', chance: 1, win: [{ op: 'cash', who: 'self', amount: 7, scale: false }], lose: [] },
      { op: 'gamble', chance: 0, win: [], lose: [{ op: 'cash', who: 'self', amount: -3, scale: false }] },
    ]);
    expect(state.players[0].cash).toBe(4);
  });

  it('richest / poorest / random_other resolve to valid players', () => {
    const state = fresh();
    state.players[0].cash = 10;
    state.players[1].cash = 100;
    state.players[2].cash = 50;
    state.owner = {};
    apply(state, [{ op: 'cash', who: 'richest', amount: 1, scale: false }]);
    expect(state.players[1].cash).toBe(101);
    apply(state, [{ op: 'cash', who: 'poorest', amount: 1, scale: false }]);
    expect(state.players[0].cash).toBe(11);
    const before = state.players.map((p) => p.cash);
    apply(state, [{ op: 'cash', who: 'random_other', amount: 1, scale: false }]);
    const changed = state.players.filter((p, i) => p.cash !== before[i]).map((p) => p.id);
    expect(changed).not.toContain(0);
    expect(changed).toHaveLength(1);
  });
});

describe('event selection and dialogue', () => {
  it('CPU event choices use cpuWeight first and Lv3 expected value as a tie-break', () => {
    const state = fresh(1, 12);
    state.phase = { t: 'event', eventId: 'ev-ai-bubble' };
    state.players[0].cpuLevel = 1;
    expect(cpuDecide(data, state)).toEqual({ t: 'choose', index: 0 });
    state.players[0].cpuLevel = 2;
    expect(cpuDecide(data, state)).toEqual({ t: 'choose', index: 0 });
    state.players[0].cpuLevel = 3;
    expect(cpuDecide(data, state)).toEqual({ t: 'choose', index: 0 });

    const tied = structuredClone(data);
    const event = tied.events.find((e) => e.id === 'ev-ai-bubble');
    if (!event?.choices) throw new Error('fixture event missing choices');
    event.choices = event.choices.map((choice) => ({ ...choice, cpuWeight: 1 }));
    const tieState = structuredClone(state);
    tieState.players[0].cpuLevel = 3;
    // Equal weights: option 1's card is worth more than option 0's gamble in expectation.
    expect(cpuDecide(tied, tieState)).toEqual({ t: 'choose', index: 1 });
  });

  it('picks eligible events and records once events', () => {
    const state = fresh(2, 9);
    const event = pickEvent(data, state);
    expect(event).not.toBeNull();
    expect(data.events.some((e) => e.id === event?.id)).toBe(true);
    // Year 1 excludes the minYear:2 event.
    expect(event?.id).not.toBe('ev-once-midas');
    const once = data.events.find((e) => e.id === 'ev-once-midas');
    expect(once).toBeDefined();
    if (once) {
      markEventUsed(state, once);
      expect(state.usedOnceEvents).toContain('ev-once-midas');
    }
  });

  it('emits event_open, every DialogueLine as say, then event_close (no choices)', () => {
    const state = fresh(2, 3);
    const newsData: GameData = structuredClone(data);
    newsData.events = [data.events.find((e) => e.id === 'ev-harvest-fable') as (typeof data.events)[number]];
    state.players[0].nodeId = 'c:osaka';
    state.destination = 'mumbai';
    state.phase = { t: 'choose_dest', roll: 1, options: [{ nodeId: 's:1-0', path: ['s:1-0'] }] };
    const result = step(newsData, state, 0, { t: 'move', nodeId: 's:1-0' });
    const open = result.fx.find((f) => f.t === 'event_open');
    expect(open?.t === 'event_open' ? open.eventId : '').toBe('ev-harvest-fable');
    // 見出し＋掛け合い 2 行＋自動適用の予告＋結果の実況（計 5 行、ナレーターが 4 行）。
    const says = result.fx.filter((f) => f.t === 'say' && !f.lineKey);
    expect(says).toHaveLength(5);
    expect(says[0]).toMatchObject({ speaker: 'narrator', text: '創作寓話！豊作の年に' });
    expect(says.at(-1)).toMatchObject({ speaker: 'narrator' });
    expect(result.fx.some((f) => f.t === 'event_close')).toBe(true);
    const openIndex = result.fx.findIndex((f) => f.t === 'event_open');
    const firstSay = result.fx.findIndex((f) => f.t === 'say' && !f.lineKey);
    const closeIndex = result.fx.findIndex((f) => f.t === 'event_close');
    expect(openIndex).toBeGreaterThanOrEqual(0);
    expect(openIndex).toBeLessThan(firstSay);
    expect(firstSay).toBeLessThan(closeIndex);
    expect(result.state.phase.t).not.toBe('event');
  });

  it('waits for a choice and plays reply lines before closing', () => {
    const state = fresh(2, 5);
    const choiceData: GameData = structuredClone(data);
    choiceData.events = [data.events.find((e) => e.id === 'ev-ai-bubble') as (typeof data.events)[number]];
    state.players[0].nodeId = 'c:osaka';
    state.destination = 'mumbai';
    state.phase = { t: 'choose_dest', roll: 1, options: [{ nodeId: 's:1-0', path: ['s:1-0'] }] };
    const landed = step(choiceData, state, 0, { t: 'move', nodeId: 's:1-0' });
    expect(landed.state.phase.t).toBe('event');
    const eventId = landed.state.phase.t === 'event' ? landed.state.phase.eventId : '';
    expect(eventId).toBe('ev-ai-bubble');
    // 見出し＋掛け合い 3 行＋「どうする？」の問いかけ。
    const opened = landed.fx.filter((f) => f.t === 'say');
    expect(opened).toHaveLength(5);
    expect(opened[0]).toMatchObject({ speaker: 'narrator', text: '世界ニュース！AIバブル再来！？' });
    const chosen = step(choiceData, landed.state, 0, { t: 'choose', index: 0 });
    const reply = chosen.fx.filter((f) => f.t === 'say');
    expect(reply.length).toBeGreaterThanOrEqual(2);
    expect(chosen.fx.some((f) => f.t === 'event_close')).toBe(true);
    const replyIndex = chosen.fx.findIndex((f) => f.t === 'say');
    const closeIndex = chosen.fx.findIndex((f) => f.t === 'event_close');
    expect(replyIndex).toBeLessThan(closeIndex);
    expect(chosen.state.activeEventId).toBeNull();
  });
});