import { describe, expect, it } from 'vitest';
import type { Action, Fx, GameState } from '../core/types';
import { actorOf, cpuDecide } from '../core/engine';
import { GAME_DATA } from '../data/index';
import type { AllowedYears, ChatLine, PublicState, Report, ServerMsg } from './protocol';
import { COMM, PROTOCOL_VERSION } from './protocol';
import { fxDuration, RoomController, sumFxDuration } from './room';
import type { RoomDeps } from './room';

// ---------------------------------------------------------------- fake clock / harness

class FakeClock {
  nowMs: number;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();
  private nextId = 1;

  constructor(start = 1_000_000) {
    this.nowMs = start;
  }

  now = (): number => this.nowMs;

  setTimer = (ms: number, fn: () => void): number => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.nowMs + Math.max(0, ms), fn });
    return id;
  };

  clearTimer = (handle: unknown): void => {
    if (typeof handle === 'number') this.timers.delete(handle);
  };

  get pending(): number {
    return this.timers.size;
  }

  advance(ms: number): void {
    const target = this.nowMs + ms;
    let guard = 0;
    for (;;) {
      let bestId: number | null = null;
      let bestAt = Number.POSITIVE_INFINITY;
      let best: { at: number; fn: () => void } | null = null;
      for (const [id, timer] of this.timers) {
        if (timer.at <= target && (timer.at < bestAt || (timer.at === bestAt && bestId !== null && id < bestId))) {
          best = timer;
          bestAt = timer.at;
          bestId = id;
        }
      }
      if (best === null || bestId === null) break;
      this.timers.delete(bestId);
      this.nowMs = Math.max(this.nowMs, best.at);
      best.fn();
      guard += 1;
      if (guard > 20_000) throw new Error('fake clock runaway');
    }
    this.nowMs = target;
  }
}

interface Sent {
  connId: string;
  msg: ServerMsg;
}

interface Harness {
  clock: FakeClock;
  room: RoomController;
  sent: Sent[];
  broadcasts: ServerMsg[];
  reports: (Report & { room: string; recentChat: ChatLine[] })[];
  deps: RoomDeps;
}

function makeHarness(): Harness {
  const clock = new FakeClock();
  let randomCounter = 0;
  const sent: Sent[] = [];
  const broadcasts: ServerMsg[] = [];
  const reports: (Report & { room: string; recentChat: ChatLine[] })[] = [];
  const deps: RoomDeps = {
    roomId: 'ROOM01',
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    randomInt: (n: number) => {
      randomCounter += 1;
      return (randomCounter * 7919) % Math.max(1, n);
    },
    data: GAME_DATA,
    send: (connId, msg) => sent.push({ connId, msg }),
    broadcast: (msg) => broadcasts.push(msg),
    report: (report) => reports.push(report),
  };
  const room = new RoomController(deps);
  return { clock, room, sent, broadcasts, reports, deps };
}

function latest<T extends ServerMsg['t']>(messages: readonly ServerMsg[], type: T): Extract<ServerMsg, { t: T }> | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg.t === type) return msg as Extract<ServerMsg, { t: T }>;
  }
  return undefined;
}

function sentOf<T extends ServerMsg['t']>(
  harness: Harness,
  connId: string,
  type: T,
): Extract<ServerMsg, { t: T }> | undefined {
  for (let i = harness.sent.length - 1; i >= 0; i -= 1) {
    const entry = harness.sent[i];
    if (entry.connId === connId && entry.msg.t === type) {
      return entry.msg as Extract<ServerMsg, { t: T }>;
    }
  }
  return undefined;
}

function errorsOf(harness: Harness, connId: string): string[] {
  return harness.sent
    .filter((entry) => entry.connId === connId && entry.msg.t === 'error')
    .map((entry) => (entry.msg as Extract<ServerMsg, { t: 'error' }>).code);
}

function join(harness: Harness, conn: string, seat: number, characterId: string, name = conn): string {
  harness.room.connect(conn);
  harness.room.message(conn, {
    t: 'hello',
    v: PROTOCOL_VERSION,
    roomId: 'ROOM01',
    name,
  });
  harness.room.message(conn, { t: 'take_seat', index: seat });
  harness.room.message(conn, { t: 'pick_character', characterId });
  const welcome = sentOf(harness, conn, 'welcome');
  if (!welcome) throw new Error('welcome missing');
  return welcome.token;
}

interface Started {
  snapshot: Extract<ServerMsg, { t: 'snapshot' }>;
  state: PublicState;
  seq: number;
  tokenA: string;
  tokenB: string;
}

function startTwoHumans(
  harness: Harness,
  options: { years?: AllowedYears; turnSeconds?: number; characters?: [string, string] } = {},
): Started {
  const tokenA = join(harness, 'a', 0, options.characters?.[0] ?? 'momotaro', 'あリス');
  const tokenB = join(harness, 'b', 1, options.characters?.[1] ?? 'alice', 'ぼリス');
  harness.room.message('a', {
    t: 'settings',
    settings: {
      years: (options.years ?? 1) as AllowedYears,
      turnSeconds: options.turnSeconds ?? 0,
    },
  });
  harness.room.message('a', { t: 'start' });
  const snapshot = latest(harness.broadcasts, 'snapshot');
  if (!snapshot) {
    throw new Error(
      `game did not start: ${JSON.stringify(harness.sent.slice(-8).map((entry) => entry.msg))}`,
    );
  }
  const initial = latest(harness.broadcasts, 'update');
  return {
    snapshot,
    state: initial?.state ?? snapshot.state,
    seq: initial?.seq ?? snapshot.seq,
    tokenA,
    tokenB,
  };
}

function act(harness: Harness, conn: string, seq: number, action: Action): Extract<ServerMsg, { t: 'update' }> {
  harness.room.message(conn, { t: 'action', seq, action });
  const update = latest(harness.broadcasts, 'update');
  if (!update) throw new Error('update missing');
  return update;
}

function drive(
  harness: Harness,
  state: PublicState,
  seq: number,
  connForSeat: (seat: number) => string,
  limit = 50_000,
): { state: PublicState; seq: number; steps: number } {
  let current = state;
  let currentSeq = seq;
  let steps = 0;
  while (current.phase.t !== 'game_over') {
    const actor = actorOf(current);
    if (actor === null) throw new Error('actor missing');
    const action = cpuDecide(GAME_DATA, current as GameState);
    const update = act(harness, connForSeat(actor), currentSeq, action);
    current = update.state;
    currentSeq = update.seq;
    steps += 1;
    if (steps > limit) throw new Error('game did not finish');
  }
  return { state: current, seq: currentSeq, steps };
}

// ---------------------------------------------------------------- lobby

describe('RoomController lobby', () => {
  it('lets two humans claim seats, rejects duplicate characters and starts a game', () => {
    const harness = makeHarness();
    const token = join(harness, 'a', 0, 'momotaro');
    expect(token.length).toBeGreaterThan(8);

    const welcome = sentOf(harness, 'a', 'welcome');
    expect(welcome?.seat).toBe(0);
    expect(welcome?.lobby.seats[0].kind).toBe('human');
    expect(welcome?.lobby.seats[0].isHost).toBe(true);

    harness.room.connect('b');
    harness.room.message('b', { t: 'hello', v: 1, roomId: 'ROOM01', name: 'B' });
    harness.room.message('b', { t: 'take_seat', index: 1 });
    harness.room.message('b', { t: 'pick_character', characterId: 'momotaro' });
    expect(errorsOf(harness, 'b')).toContain('character_taken');

    harness.room.message('b', { t: 'pick_character', characterId: 'alice' });
    const lobby = latest(harness.broadcasts, 'lobby')?.lobby;
    expect(lobby?.seats[1].characterId).toBe('alice');

    // A lost welcome is recoverable: repeating take_seat re-sends the welcome for the same seat.
    harness.room.message('b', { t: 'take_seat', index: 1 });
    expect(sentOf(harness, 'b', 'welcome')?.seat).toBe(1);
    expect(errorsOf(harness, 'b')).not.toContain('bad_request');

    harness.room.message('a', { t: 'start' });
    const snapshot = latest(harness.broadcasts, 'snapshot');
    expect(snapshot?.state.players.map((player) => player.characterId)).toEqual([
      'momotaro',
      'alice',
    ]);
    expect(snapshot?.seq).toBe(1);
    expect(snapshot?.lobby.status).toBe('playing');
    const initialFx = latest(harness.broadcasts, 'update');
    expect(initialFx?.seq).toBe(2);
    expect(initialFx?.fx.length).toBeGreaterThan(0);
  });

  it('enforces host-only settings and start conditions', () => {
    const harness = makeHarness();
    join(harness, 'a', 0, 'momotaro');
    harness.room.connect('b');
    harness.room.message('b', { t: 'hello', v: 1, roomId: 'ROOM01', name: 'B' });
    harness.room.message('b', { t: 'take_seat', index: 1 });
    harness.room.message('b', { t: 'settings', settings: { years: 5 } });
    expect(errorsOf(harness, 'b')).toContain('not_host');
    harness.room.message('b', { t: 'start' });
    expect(errorsOf(harness, 'b')).toContain('not_host');
    harness.room.message('a', { t: 'settings', settings: { years: 2 as AllowedYears } });
    expect(errorsOf(harness, 'a')).toContain('bad_request');
    harness.room.message('a', { t: 'settings', settings: { years: 20 } });
    expect(latest(harness.broadcasts, 'lobby')?.lobby.settings.years).toBe(20);
    expect(harness.broadcasts.some((msg) => msg.t === 'snapshot')).toBe(false);
  });

  it('migrates the host when the host disconnects or leaves', () => {
    const harness = makeHarness();
    join(harness, 'a', 0, 'momotaro');
    join(harness, 'b', 1, 'alice');
    harness.room.disconnect('a');
    const lobby = latest(harness.broadcasts, 'lobby')?.lobby;
    expect(lobby?.seats[1].isHost).toBe(true);
    expect(lobby?.seats[0].connected).toBe(false);
    harness.room.message('b', { t: 'settings', settings: { years: 1 } });
    expect(errorsOf(harness, 'b')).not.toContain('not_host');
  });
});

// ---------------------------------------------------------------- turn validation

describe('RoomController actions', () => {
  it('rejects an action from the non-acting seat and a stale seq', () => {
    const harness = makeHarness();
    const started = startTwoHumans(harness);
    harness.room.message('b', { t: 'action', seq: started.seq, action: { t: 'roll' } });
    expect(errorsOf(harness, 'b')).toContain('not_your_turn');
    harness.room.message('a', { t: 'action', seq: 999, action: { t: 'roll' } });
    expect(errorsOf(harness, 'a')).toContain('stale');
    const update = act(harness, 'a', started.seq, { t: 'roll' });
    expect(update.seq).toBe(started.seq + 1);
    expect(update.by).toBe(0);
    expect(update.state.phase.t).toBe('choose_dest');
  });

  it('times out a human turn into autoplay and includes fx in the update', () => {
    const harness = makeHarness();
    const started = startTwoHumans(harness, { turnSeconds: 20 });
    expect(started.snapshot.deadline).not.toBeNull();
    const before = started.seq;
    harness.clock.advance((started.snapshot.deadline as number) - harness.clock.now());
    const update = latest(harness.broadcasts, 'update');
    expect(update?.seq).toBe(before + 1);
    expect(update?.fx.length).toBeGreaterThan(0);
    expect(harness.broadcasts.some((msg) => msg.t === 'system' && msg.text.includes('時間切れ'))).toBe(true);
    const lobby = latest(harness.broadcasts, 'lobby')?.lobby;
    expect(lobby?.seats[0].autoplay).toBe(true);
  });
});

// ---------------------------------------------------------------- disconnect / reconnect

describe('RoomController reconnect and replacement', () => {
  it('gives a disconnected actor 15s of grace, autoplays, then replaces it with CPU after 120s', () => {
    const harness = makeHarness();
    startTwoHumans(harness, { years: 10, turnSeconds: 0 });
    const disconnectedAt = harness.clock.now();
    harness.room.disconnect('a');
    expect(harness.broadcasts.some((msg) => msg.t === 'system' && msg.text.includes('切断'))).toBe(true);
    const beforeGrace = latest(harness.broadcasts, 'update')?.seq;
    harness.clock.advance(14_000);
    expect(latest(harness.broadcasts, 'update')?.seq).toBe(beforeGrace);
    harness.clock.advance(1_500);
    expect(latest(harness.broadcasts, 'update')?.seq).toBeGreaterThan(beforeGrace ?? 0);
    expect(latest(harness.broadcasts, 'lobby')?.lobby.seats[0].autoplay).toBe(true);

    harness.clock.advance(disconnectedAt + 120_000 - harness.clock.now());
    const lobby = latest(harness.broadcasts, 'lobby')?.lobby;
    expect(lobby?.seats[0].kind).toBe('cpu');
    expect(harness.broadcasts.some((msg) => msg.t === 'system' && msg.text.includes('120'))).toBe(true);
  });

  it('reconnects with the seat token to the same seat and receives a snapshot', () => {
    const harness = makeHarness();
    const started = startTwoHumans(harness);
    harness.room.disconnect('a');
    harness.room.connect('a2');
    harness.room.message('a2', {
      t: 'hello',
      v: 1,
      roomId: 'ROOM01',
      name: 'A',
      token: started.tokenA,
    });
    const welcome = sentOf(harness, 'a2', 'welcome');
    expect(welcome?.seat).toBe(0);
    const snapshot = sentOf(harness, 'a2', 'snapshot');
    expect(snapshot?.seq).toBe(started.seq);
    expect(snapshot?.state.players[0].characterId).toBe('momotaro');

    const action = act(harness, 'a2', snapshot?.seq ?? 0, { t: 'roll' });
    expect(action.by).toBe(0);
  });

  it('binds a seat to the newest connection and rejects the old socket', () => {
    const harness = makeHarness();
    const started = startTwoHumans(harness);
    harness.room.connect('a2');
    harness.room.message('a2', {
      t: 'hello',
      v: 1,
      roomId: 'ROOM01',
      name: 'A',
      token: started.tokenA,
    });
    harness.room.message('a', { t: 'action', seq: started.seq, action: { t: 'roll' } });
    expect(errorsOf(harness, 'a')).toContain('not_your_turn');
    const update = act(harness, 'a2', started.seq, { t: 'roll' });
    expect(update.by).toBe(0);
  });

  it('immediately converts a leaving human seat to CPU while keeping assets', () => {
    const harness = makeHarness();
    const started = startTwoHumans(harness);
    const cash = started.state.players[0].cash;
    harness.room.message('a', { t: 'leave' });
    const lobby = latest(harness.broadcasts, 'lobby')?.lobby;
    expect(lobby?.seats[0].kind).toBe('cpu');
    expect(lobby?.seats[0].characterId).toBe('momotaro');
    const after = harness.room.publicState();
    expect(after?.players[0].cash).toBe(cash);
  });

  it('uses an unknown token for the fresh connection but does not restore a seat', () => {
    const harness = makeHarness();
    startTwoHumans(harness);
    harness.room.connect('x');
    harness.room.message('x', { t: 'hello', v: 1, roomId: 'ROOM01', name: 'X', token: 'NOPE' });
    const welcome = sentOf(harness, 'x', 'welcome');
    expect(welcome?.seat).toBeNull();
    expect(welcome?.token).toBe('NOPE'); // becomes this connection's token for a future seat claim
  });
});

// ---------------------------------------------------------------- chat / emotes / reports

describe('RoomController communication', () => {
  it('rate-limits chat, drops duplicate text and filters URLs / NG words', () => {
    const harness = makeHarness();
    join(harness, 'a', 0, 'momotaro');
    for (let i = 0; i < COMM.chatBurst; i += 1) {
      harness.room.message('a', { t: 'chat', text: `hello ${i}` });
    }
    harness.room.message('a', { t: 'chat', text: 'one too many' });
    expect(errorsOf(harness, 'a')).toContain('rate_limited');
    const chats = harness.broadcasts.filter(
      (msg): msg is Extract<ServerMsg, { t: 'chat' }> => msg.t === 'chat',
    );
    expect(chats.length).toBe(COMM.chatBurst);

    harness.clock.advance(COMM.chatMinIntervalMs + 100);
    harness.room.message('a', { t: 'chat', text: 'hello 2' });
    expect(
      harness.broadcasts.filter((msg) => msg.t === 'chat').length,
    ).toBe(COMM.chatBurst); // duplicate within 10s

    harness.clock.advance(COMM.duplicateWindowMs + 100);
    harness.room.message('a', { t: 'chat', text: 'hello 2' });
    harness.room.message('a', {
      t: 'chat',
      text: '死ね https://example.com/a?b=c',
    });
    const filtered = latest(harness.broadcasts, 'chat')?.line;
    expect(filtered?.text).toContain('[URL]');
    expect(filtered?.text).not.toContain('死ね');
    expect(filtered?.text).toContain('＊');

    const before = harness.broadcasts.filter((msg) => msg.t === 'chat').length;
    harness.clock.advance(2_000);
    harness.room.message('a', { t: 'chat', text: 'ＡＢＣ１２３' });
    expect(harness.broadcasts.filter((msg) => msg.t === 'chat').length).toBe(before + 1);
    harness.clock.advance(2_000);
    harness.room.message('a', { t: 'chat', text: 'a b c 1 2 3' });
    expect(harness.broadcasts.filter((msg) => msg.t === 'chat').length).toBe(before + 1);
    harness.clock.advance(2_000);
    harness.room.message('a', {
      t: 'chat',
      text: 'ｈｔｔｐｓ：／／ｅｘａｍｐｌｅ．ｃｏｍ 死ね',
    });
    const normalized = latest(harness.broadcasts, 'chat')?.line.text ?? '';
    expect(normalized).toContain('[URL]');
    expect(normalized).not.toContain('死ね');
    expect(normalized).toContain('＊');
  });

  it('enforces per-emote cooldown, unique ownership and target validation', () => {
    const harness = makeHarness();
    join(harness, 'a', 0, 'momotaro');
    join(harness, 'b', 1, 'alice');
    harness.room.message('a', { t: 'emote', emoteId: 'u_alice' });
    expect(errorsOf(harness, 'a')).toContain('bad_request');
    harness.room.message('a', { t: 'emote', emoteId: 'u_momotaro' });
    expect(errorsOf(harness, 'a')).toContain('bad_request'); // targeted without target
    harness.room.message('a', { t: 'emote', emoteId: 'u_momotaro', target: 2 });
    expect(errorsOf(harness, 'a')).toContain('bad_request'); // open seat
    harness.room.message('a', { t: 'emote', emoteId: 'u_momotaro', target: 1 });
    expect(harness.broadcasts.filter((msg) => msg.t === 'emote').length).toBe(1);

    harness.room.message('a', { t: 'emote', emoteId: 'u_momotaro', target: 1 });
    expect(errorsOf(harness, 'a')).toContain('rate_limited');
    expect(harness.broadcasts.filter((msg) => msg.t === 'emote').length).toBe(1);

    harness.clock.advance(13_000);
    harness.room.message('b', { t: 'emote', emoteId: 'u_alice' });
    expect(harness.broadcasts.filter((msg) => msg.t === 'emote').length).toBe(2);

    harness.clock.advance(3_100);
    harness.room.message('a', { t: 'emote', emoteId: 'joy' });
    harness.room.message('a', { t: 'emote', emoteId: 'joy' });
    expect(errorsOf(harness, 'a')).toContain('rate_limited');
  });

  it('flags a seat after two distinct reporters and stores report evidence', () => {
    const harness = makeHarness();
    join(harness, 'a', 0, 'momotaro');
    join(harness, 'b', 1, 'alice');
    const tokenC = join(harness, 'c', 2, 'sinbad');
    harness.clock.advance(5_000);
    harness.room.message('c', { t: 'chat', text: '通報テスト' });
    harness.room.message('a', { t: 'report', seat: 2, reason: 'spam' });
    expect(harness.reports.length).toBe(1);
    expect(harness.reports[0].recentChat.map((line) => line.text)).toContain('通報テスト');
    expect(harness.broadcasts.some((msg) => msg.t === 'flag')).toBe(false);

    harness.room.message('b', { t: 'report', seat: 2, reason: 'abuse' });
    expect(harness.broadcasts.some((msg) => msg.t === 'flag' && msg.seat === 2)).toBe(true);
    expect(latest(harness.broadcasts, 'lobby')?.lobby.seats[2].flagged).toBe(true);
    expect(harness.reports.length).toBe(2);

    harness.room.disconnect('c');
    harness.room.connect('c2');
    harness.room.message('c2', {
      t: 'hello',
      v: 1,
      roomId: 'ROOM01',
      name: 'C',
      token: tokenC,
    });
    expect(sentOf(harness, 'c2', 'welcome')?.lobby.seats[2].flagged).toBe(true);
  });
});

// ---------------------------------------------------------------- full game / persistence

describe('RoomController full game', () => {
  it('plays a full year with two human clients driven by cpuDecide', () => {
    const harness = makeHarness();
    const started = startTwoHumans(harness, { years: 1, turnSeconds: 0 });
    const result = drive(harness, started.state, started.seq, (seat) => (seat === 0 ? 'a' : 'b'));
    expect(result.state.phase.t).toBe('game_over');
    if (result.state.phase.t === 'game_over') {
      expect(result.state.phase.ranking.length).toBe(2);
    }
    expect(result.steps).toBeGreaterThan(20);
    const updates = harness.broadcasts.filter((msg) => msg.t === 'update');
    expect(updates[updates.length - 1].seq).toBe(result.seq);
    expect(harness.room.roomStatus).toBe('finished');
  });

  it('serializes and restores mid-game so both rooms finish identically', () => {
    const harnessA = makeHarness();
    const started = startTwoHumans(harnessA, { years: 1, turnSeconds: 0 });
    let state = started.state;
    let seq = started.seq;
    for (let i = 0; i < 24; i += 1) {
      const actor = actorOf(state);
      if (actor === null || state.phase.t === 'game_over') break;
      const update = act(harnessA, actor === 0 ? 'a' : 'b', seq, cpuDecide(GAME_DATA, state as GameState));
      state = update.state;
      seq = update.seq;
    }

    const json = harnessA.room.serialize();
    const clockB = new FakeClock(harnessA.clock.now());
    let counterB = 0;
    const harnessB: Harness = {
      clock: clockB,
      room: undefined as unknown as RoomController,
      sent: [],
      broadcasts: [],
      reports: [],
      deps: undefined as unknown as RoomDeps,
    };
    harnessB.deps = {
      roomId: 'ROOM01',
      now: clockB.now,
      setTimer: clockB.setTimer,
      clearTimer: clockB.clearTimer,
      randomInt: (n) => {
        counterB += 1;
        return (counterB * 7919) % Math.max(1, n);
      },
      data: GAME_DATA,
      send: (connId, msg) => harnessB.sent.push({ connId, msg }),
      broadcast: (msg) => harnessB.broadcasts.push(msg),
    };
    harnessB.room = RoomController.restore(json, harnessB.deps, { connections: true });
    expect(harnessB.room.publicState()).toEqual(state);

    const finishA = drive(harnessA, state, seq, (seat) => (seat === 0 ? 'a' : 'b'));
    const finishB = drive(harnessB, state, seq, (seat) => (seat === 0 ? 'a' : 'b'));
    expect(finishB.state).toEqual(finishA.state);
    expect(finishB.seq).toBe(finishA.seq);
  });

  it('paces CPU seats by fx duration plus 400ms', () => {
    const harness = makeHarness();
    join(harness, 'a', 0, 'momotaro');
    harness.room.message('a', { t: 'set_seat', index: 1, kind: 'cpu', cpuLevel: 2 });
    harness.room.message('a', { t: 'pick_character', characterId: 'alice', seat: 1 });
    harness.room.message('a', { t: 'start' });
    const snapshot = latest(harness.broadcasts, 'snapshot');
    if (!snapshot) throw new Error('missing snapshot');

    const initial = latest(harness.broadcasts, 'update');
    let state = initial?.state ?? snapshot.state;
    let seq = initial?.seq ?? snapshot.seq;
    let handover = initial;
    for (let i = 0; i < 100; i += 1) {
      if (actorOf(state) === 1) break;
      handover = act(harness, 'a', seq, cpuDecide(GAME_DATA, state as GameState));
      state = handover.state;
      seq = handover.seq;
    }
    expect(actorOf(state)).toBe(1);
    if (!handover) throw new Error('cpu handover missing');
    expect(handover.by).toBe(0);
    const delay = sumFxDuration(handover.fx) + 400;
    harness.clock.advance(delay - 1);
    expect(latest(harness.broadcasts, 'update')).toBe(handover);
    harness.clock.advance(1);
    expect(latest(harness.broadcasts, 'update')?.by).toBe(1);
  });
it('adopts a public snapshot, reseeds rng and marks the old host disconnected', () => {
    const harness = makeHarness();
    const started = startTwoHumans(harness);
    expect('rng' in started.snapshot.state).toBe(false);
    const pub = harness.room.publicSnapshot();
    expect(pub.seatKeys['0']).toBeTruthy();
    expect(pub.seatKeys['1']).toBeTruthy();

    const adoptedHarness = makeHarness();
    const adopted = RoomController.adopt({ ...pub, hostSeat: 1 }, adoptedHarness.deps);
    expect(adopted.currentSeq).toBe(pub.seq);
    expect(adopted.publicState()?.players).toEqual(pub.state?.players);
    expect(adopted.publicState()?.phase).toEqual(pub.state?.phase);
    expect(adopted.lobbyView().seats[0].connected).toBe(false);
    expect(adopted.lobbyView().seats[1].isHost).toBe(true);

    const token = pub.seatKeys['1'];
    adopted.connect('g1');
    adopted.message('g1', {
      t: 'hello',
      v: PROTOCOL_VERSION,
      roomId: 'ROOM01',
      name: 'B',
      token,
    });
    expect(sentOf(adoptedHarness, 'g1', 'welcome')?.seat).toBe(1);
    expect(latest(adoptedHarness.broadcasts, 'lobby')?.lobby.seats[1].connected).toBe(true);
  });
});

describe('RoomController timing, mapping and normalization', () => {
  it('does not extend the deadline when an action is rejected', () => {
    const harness = makeHarness();
    const started = startTwoHumans(harness, { turnSeconds: 20 });
    const deadline = started.snapshot.deadline;
    if (deadline === null) throw new Error('expected deadline');
    harness.room.message('a', {
      t: 'action',
      seq: started.seq,
      action: { t: 'end_buy' },
    });
    expect(errorsOf(harness, 'a')).toContain('illegal');
    harness.clock.advance(deadline - harness.clock.now());
    expect(latest(harness.broadcasts, 'update')?.seq ?? 0).toBeGreaterThan(started.seq);
  });

  it('restores the existing deadline on reconnect instead of starting a new turn', () => {
    const harness = makeHarness();
    const started = startTwoHumans(harness, { turnSeconds: 20 });
    const deadline = started.snapshot.deadline;
    if (deadline === null) throw new Error('expected deadline');
    harness.room.disconnect('a');
    harness.clock.advance(5_000);
    harness.room.connect('a2');
    harness.room.message('a2', {
      t: 'hello',
      v: PROTOCOL_VERSION,
      roomId: 'ROOM01',
      name: 'A',
      token: started.tokenA,
    });
    expect(sentOf(harness, 'a2', 'snapshot')?.deadline).toBe(deadline);
  });

  it('maps gapped lobby seats densely to player ids', () => {
    const harness = makeHarness();
    join(harness, 'a', 0, 'momotaro');
    join(harness, 'b', 2, 'alice');
    harness.room.message('a', { t: 'start' });
    expect(harness.room.seatToPlayer(0)).toBe(0);
    expect(harness.room.seatToPlayer(2)).toBe(1);
    expect(harness.room.seatToPlayer(1)).toBeNull();
    expect(harness.room.playerToSeat(0)).toBe(0);
    expect(harness.room.playerToSeat(1)).toBe(2);
    expect(harness.room.playerToSeat(2)).toBeNull();
  });
});

describe('fxDuration', () => {
  it('uses the standard presentation times', () => {
    const dice: Fx = { t: 'dice', values: [1, 2] };
    const say: Fx = { t: 'say', speaker: 'narrator', text: 'あいう' };
    expect(fxDuration(dice)).toBe(1300);
    expect(fxDuration(say)).toBe(700 + 3 * 95);
    expect(fxDuration({ t: 'game_over', ranking: [0] })).toBe(2000);
  });
});