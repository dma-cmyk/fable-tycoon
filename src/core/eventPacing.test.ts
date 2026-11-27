// Event pacing rules: an event is a story, so nothing inside it compacts, speeds up or gets cut.
import { describe, expect, it } from 'vitest';
import type { Fx } from './types';
import {
  compactDramaKind,
  compactSayBeat,
  createDramaLedger,
  estimateSayVoiceMs,
  EVENT_READ_MIN_MS,
  EVENT_TAP_TIMEOUT_MS,
  EVENT_VOICE_TAIL_MS,
  eventReadFloor,
  eventSayBudgetMs,
  eventVoiceTailMs,
  isEventUpdate,
  isRoutineCpuFx,
  isRoutineCpuSay,
  routineFxDuration,
  SAY_REVEAL_ALLOWANCE_MS,
  type FxPacingContext,
} from './fxPacing';

const cpu: FxPacingContext = {
  actor: 1,
  isCpu: (id) => id === 1 || id === 2 || id === 3,
  level: 'standard',
};

const line = (text: string): Fx => ({ t: 'say', speaker: 'npc:narrator', text });

const eventUpdate = (text: string): Fx[] => [
  { t: 'event_open', eventId: 'ev', playerId: 1 },
  { t: 'say', speaker: 'npc:narrator', text },
  { t: 'cash', playerId: 1, delta: -10, reason: 'イベント' },
  { t: 'event_close' },
];

describe('isEventUpdate', () => {
  it('recognises an event from its opening or its closing beat', () => {
    expect(isEventUpdate(undefined)).toBe(false);
    expect(isEventUpdate([])).toBe(false);
    expect(isEventUpdate([{ t: 'event_open', eventId: 'ev', playerId: 0 }])).toBe(true);
    expect(isEventUpdate([{ t: 'event_close' }])).toBe(true);
    expect(isEventUpdate([{ t: 'cash', playerId: 1, delta: 1, reason: '青マス' }])).toBe(false);
  });
});

describe('events are never compacted', () => {
  const text = 'あ'.repeat(30);

  it('keeps the full 固有技 beat of a CPU when the update is an event', () => {
    const skill: Fx = { t: 'skill', playerId: 1, characterId: 'c', name: 'n' };
    const update: Fx[] = [{ t: 'event_open', eventId: 'ev', playerId: 1 }, skill, { t: 'event_close' }];
    const ctx: FxPacingContext = { ...cpu, update, year: 1, ledger: createDramaLedger(1) };
    expect(compactDramaKind(skill, ctx)).toBe(null);
    expect(isRoutineCpuFx(skill, ctx)).toBe(false);
  });

  it('never treats an event reply as a routine CPU quip', () => {
    const update = eventUpdate(text);
    const reply = update[1] as Extract<Fx, { t: 'say' }>;
    const ctx: FxPacingContext = { ...cpu, update };
    expect(isRoutineCpuSay(reply, ctx)).toBe(false);
    expect(compactSayBeat(reply, ctx)).toBe(null);
  });

  it('keeps repeated CPU drama full inside an event update', () => {
    const goal: Fx = { t: 'goal', playerId: 1, cityId: 'doha', bonus: 90 };
    const ledger = createDramaLedger(1);
    ledger.counts.goal = 3;
    const ctx: FxPacingContext = { ...cpu, update: [goal, { t: 'event_close' }], year: 1, ledger };
    expect(compactDramaKind(goal, ctx)).toBe(null);
  });

  it('does not boost a CPU toast that belongs to an event', () => {
    const toast: Fx = { t: 'toast', text: '世界に衝撃が走った。' };
    const ctx: FxPacingContext = { ...cpu, update: [toast, { t: 'event_open', eventId: 'x', playerId: 1 }] };
    expect(isRoutineCpuFx(toast, ctx)).toBe(false);
  });
});

describe('event line budgets', () => {
  it('reads unvoiced event text at 6 characters per second, never under 1.5 s', () => {
    expect(eventReadFloor('standard')).toEqual({ perCharMs: 167, minMs: EVENT_READ_MIN_MS });
    expect(eventReadFloor('calm')).toEqual({ perCharMs: 167, minMs: EVENT_READ_MIN_MS });
    // さくさく stays faster but readable.
    expect(eventReadFloor('brisk').perCharMs).toBeLessThan(167);
    expect(eventReadFloor('brisk').minMs).toBe(900);
  });

  it('waits 0.6 s after an event voice in 標準, less in さくさく', () => {
    expect(eventVoiceTailMs('standard')).toBe(EVENT_VOICE_TAIL_MS);
    expect(eventVoiceTailMs('calm')).toBe(EVENT_VOICE_TAIL_MS);
    expect(eventVoiceTailMs('brisk')).toBeLessThan(EVENT_VOICE_TAIL_MS);
    expect(EVENT_TAP_TIMEOUT_MS).toBeGreaterThanOrEqual(15_000);
  });

  it('budgets the voice plus the reading floor and the tail for the host', () => {
    const text = 'あ'.repeat(30);
    const budget = eventSayBudgetMs(text, 'standard');
    const floor = Math.max(EVENT_READ_MIN_MS, 30 * eventReadFloor('standard').perCharMs);
    expect(budget).toBe(estimateSayVoiceMs(text) + floor + EVENT_VOICE_TAIL_MS + SAY_REVEAL_ALLOWANCE_MS);
    // The client waits for the real clip, so the host budget must exceed the reading floor alone.
    expect(budget).toBeGreaterThan(floor);
  });

  it('uses the event budget for an event say and the nominal for a normal one', () => {
    const text = 'あ'.repeat(24);
    const inEvent: FxPacingContext = { ...cpu, update: eventUpdate(text) };
    const normal: FxPacingContext = { ...cpu, update: [line(text)] };
    expect(routineFxDuration(1950, line(text), inEvent)).toBe(eventSayBudgetMs(text, 'standard'));
    expect(routineFxDuration(1950, line(text), normal)).toBe(1950);
  });
});