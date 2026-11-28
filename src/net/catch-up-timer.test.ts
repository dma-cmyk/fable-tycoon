// The acting human's turn timer must not run while that seat's client is still presenting earlier
// fx (narration it has not caught up on). These tests drive the authoritative RoomController with a
// fake clock and a lagging `progress` reporter:
//
//  1. a lagging acting client is never timed out while catching up; its timer starts (with a full
//     turn) only after it reports playing the decision's own seq;
//  2. the hard cap still fires for a client that never reports, so a frozen/dead seat cannot
//     stall the room;
//  3. a lagging non-actor never holds anybody else's timer.

import { describe, expect, it } from 'vitest';
import type { Action, GameState } from '../core/types';
import { actorOf, cpuDecide } from '../core/engine';
import { GAME_DATA } from '../data/index';
import type { AllowedYears, PublicState, ServerMsg } from './protocol';
import { PROTOCOL_VERSION } from './protocol';
import { RoomController } from './room';
import type { RoomDeps } from './room';

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

interface Harness {
  clock: FakeClock;
  room: RoomController;
  broadcasts: ServerMsg[];
  deps: RoomDeps;
}

function makeHarness(overrides: Partial<RoomDeps> = {}): Harness {
  const clock = new FakeClock();
  let randomCounter = 0;
  const broadcasts: ServerMsg[] = [];
  const deps: RoomDeps = {
    roomId: 'CATCHUP',
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    randomInt: (n: number) => {
      randomCounter += 1;
      return (randomCounter * 7919) % Math.max(1, n);
    },
    data: GAME_DATA,
    send: () => undefined,
    broadcast: (msg) => broadcasts.push(msg),
    ...overrides,
  };
  return { clock, room: new RoomController(deps), broadcasts, deps };
}

function latest<T extends ServerMsg['t']>(messages: readonly ServerMsg[], type: T): Extract<ServerMsg, { t: T }> | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg.t === type) return msg as Extract<ServerMsg, { t: T }>;
  }
  return undefined;
}

interface Started {
  state: PublicState;
  seq: number;
}

function join(harness: Harness, conn: string, seat: number, characterId: string): void {
  harness.room.connect(conn);
  harness.room.message(conn, { t: 'hello', v: PROTOCOL_VERSION, roomId: 'CATCHUP', name: conn });
  harness.room.message(conn, { t: 'take_seat', index: seat });
  harness.room.message(conn, { t: 'pick_character', characterId });
}

function startTwoHumans(harness: Harness, turnSeconds: number): Started {
  join(harness, 'a', 0, 'momotaro');
  join(harness, 'b', 1, 'alice');
  harness.room.message('a', {
    t: 'settings',
    settings: { years: 1 as AllowedYears, turnSeconds },
  });
  harness.room.message('a', { t: 'start' });
  const snapshot = latest(harness.broadcasts, 'snapshot');
  const update = latest(harness.broadcasts, 'update');
  if (!snapshot || !update) throw new Error('game did not start');
  return { state: update.state, seq: update.seq };
}

function progress(harness: Harness, conn: string, seq: number): void {
  harness.room.message(conn, { t: 'progress', seq });
}

function act(harness: Harness, conn: string, seq: number, action: Action): { state: PublicState; seq: number } {
  harness.room.message(conn, { t: 'action', seq, action });
  const update = latest(harness.broadcasts, 'update');
  if (!update) throw new Error('update missing');
  return { state: update.state, seq: update.seq };
}

function timedOut(harness: Harness): boolean {
  return harness.broadcasts.some((msg) => msg.t === 'system' && msg.text.includes('時間切れ'));
}

/**
 * Drives seat 0's turn until the actor becomes seat 1. Seat 0 reports every update it presents, so
 * its own turn never holds; seat 1 never reports, so the decision that hands it the turn starts
 * with seat 1 behind (it is still at the game-start seq).
 */
function playUntilSeat1Acts(harness: Harness, started: Started): { state: PublicState; seq: number } {
  progress(harness, 'a', started.seq);
  progress(harness, 'b', started.seq);
  let state = started.state;
  let seq = started.seq;
  for (let guard = 0; guard < 400; guard += 1) {
    const actor = actorOf(state);
    if (actor === 1) return { state, seq };
    if (actor !== 0) throw new Error(`unexpected actor ${String(actor)}`);
    const action = cpuDecide(GAME_DATA, state as GameState);
    const next = act(harness, 'a', seq, action);
    state = next.state;
    seq = next.seq;
    // Seat 0 finished presenting this update: release whatever hold its own turn started.
    progress(harness, 'a', seq);
  }
  throw new Error('seat 1 never became the actor');
}

describe('catch-up gate for the acting human turn timer', () => {
  it('does not time out a lagging client while it is catching up, then starts its turn timer', () => {
    const harness = makeHarness({ catchUpCapMs: 10 * 60_000 });
    const started = startTwoHumans(harness, 20);
    const turn = playUntilSeat1Acts(harness, started);
    const heldSeq = turn.seq;

    // The decision handed the turn to seat 1 while its client was still presenting older fx:
    // no deadline, no turn task, only the catch-up cap task.
    expect(harness.room.currentDeadline).toBeNull();
    const tasks = harness.room.debugSnapshot().tasks;
    expect(tasks.some((task) => task.key === 'catchup')).toBe(true);
    expect(tasks.some((task) => task.key === 'turn')).toBe(false);

    // Well past the normal 20s turn deadline + this update's fx budget, still below the cap:
    // the room must not take the turn away while the client is catching up.
    const fxMs = harness.room.turnFxBudgetMs;
    harness.clock.advance(fxMs + 30_000);
    expect(latest(harness.broadcasts, 'update')?.seq).toBe(heldSeq);
    expect(timedOut(harness)).toBe(false);
    expect(harness.room.lobbyView().seats[1].autoplay).toBe(false);

    // The client finally presents the decision's own update.
    progress(harness, 'b', heldSeq);
    const timer = latest(harness.broadcasts, 'turn_timer');
    expect(timer?.seq).toBe(heldSeq);
    expect(timer?.deadline).not.toBeNull();
    const deadline = harness.room.currentDeadline;
    expect(deadline).not.toBeNull();
    // A full 20s turn starts now, not the leftover of a timer that never ran.
    expect((deadline as number) - harness.clock.now()).toBeLessThanOrEqual(20_000);
    expect((deadline as number) - harness.clock.now()).toBeGreaterThan(18_000);
    expect(harness.room.debugSnapshot().tasks.some((task) => task.key === 'turn')).toBe(true);

    // And the human can actually act: the turn is theirs, not the CPU's.
    const action = cpuDecide(GAME_DATA, turn.state as GameState);
    const after = act(harness, 'b', heldSeq, action);
    expect(after.seq).toBeGreaterThan(heldSeq);
    expect(timedOut(harness)).toBe(false);
  });

  it('fires the hard cap for a client that never reports, so the room cannot stall forever', () => {
    const harness = makeHarness({ catchUpCapMs: 3_000 });
    const started = startTwoHumans(harness, 20);
    const turn = playUntilSeat1Acts(harness, started);
    const heldSeq = turn.seq;
    expect(harness.room.currentDeadline).toBeNull();

    // The dead client never reports. At the cap the normal timer starts, then expires into the
    // usual CPU autoplay takeover: a frozen device cannot hold the room forever.
    harness.clock.advance(3_000 + 10);
    const timer = latest(harness.broadcasts, 'turn_timer');
    expect(timer?.seq).toBe(heldSeq);
    expect(timer?.deadline).not.toBeNull();
    harness.clock.advance(20_000 + 5);
    expect(timedOut(harness)).toBe(true);
    expect(harness.room.lobbyView().seats[1].autoplay).toBe(true);
  });

  it('never holds a non-acting seat: only the acting seat’s own lag delays its own timer', () => {
    const harness = makeHarness({ catchUpCapMs: 10 * 60_000 });
    const started = startTwoHumans(harness, 20);
    // Seat 0 is the actor and has presented the current update; seat 1 is far behind.
    progress(harness, 'a', started.seq);
    progress(harness, 'b', 0);
    // Re-arming the same decision must not turn seat 1's lag into a hold on seat 0's turn.
    harness.room.rearmTurn();
    expect(harness.room.currentDeadline).not.toBeNull();
    expect(harness.room.debugSnapshot().tasks.some((task) => task.key === 'turn')).toBe(true);
    expect(harness.room.debugSnapshot().tasks.some((task) => task.key === 'catchup')).toBe(false);
  });
});
