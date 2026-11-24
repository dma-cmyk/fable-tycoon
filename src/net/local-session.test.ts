import { describe, expect, it } from 'vitest';
import type { PlayerSetup } from '../core/types';
import type { ServerMsg } from './protocol';
import { createLocal, hasLocalSave, localSaveIssue, resumeLocal } from './local-session';

describe('LocalSession save version', () => {
  it('rejects a save from a different board and reports the reason', () => {
    const data = new Map<string, string>();
    const storage = {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => {
        data.set(key, String(value));
      },
      removeItem: (key: string) => {
        data.delete(key);
      },
    };
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
    const session = createLocal({
      players: [
        { name: 'A', characterId: 'momotaro', isCpu: false },
        { name: 'B', characterId: 'alice', isCpu: true },
      ],
      years: 1,
    });
    session.close();
    const raw = data.get('fable.local');
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw as string) as { boardVersion: string };
    parsed.boardVersion = 'obsolete-board';
    data.set('fable.local', JSON.stringify(parsed));
    expect(resumeLocal()).toBeNull();
    expect(localSaveIssue()).toContain('盤面');
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }, 15_000);
});

describe('LocalSession', () => {
  it('starts a hot-seat game through the same RoomController and routes actions', async () => {
    const players: PlayerSetup[] = [
      { name: 'human', characterId: 'momotaro', isCpu: false },
      { name: 'cpu', characterId: 'alice', isCpu: true, cpuLevel: 2 },
    ];
    const session = createLocal({ players, years: 20 });
    const snapshotSeen = Promise.withResolvers<Extract<ServerMsg, { t: 'snapshot' }>>();
    const updateSeen = Promise.withResolvers<Extract<ServerMsg, { t: 'update' }>>();
    let nextUpdate: ((msg: Extract<ServerMsg, { t: 'update' }>) => void) | null = null;
    const unsubscribe = session.subscribe((msg) => {
      if (msg.t === 'snapshot') snapshotSeen.resolve(msg);
      if (msg.t === 'update') {
        updateSeen.resolve(msg);
        nextUpdate?.(msg);
        nextUpdate = null;
      }
    });
    try {
      const snapshot = await snapshotSeen.promise;
      expect(session.mode).toBe('local');
      expect(session.mySeats()).toEqual([0]);
      expect(session.lobby()?.status).toBe('playing');
      expect(session.lobby()?.settings.years).toBe(20);
      expect(session.seatToPlayer(0)).toBe(0);
      expect(session.seatToPlayer(1)).toBe(1);
      expect(session.playerToSeat(1)).toBe(1);
      expect(session.seatToPlayer(2)).toBeNull();
      expect(snapshot.state.players.map((player) => player.isCpu)).toEqual([false, true]);

      const initial = await updateSeen.promise;
      const next = Promise.withResolvers<Extract<ServerMsg, { t: 'update' }>>();
      nextUpdate = next.resolve;
      session.send({ t: 'action', seq: initial.seq, action: { t: 'roll' } });
      const update = await next.promise;
      expect(update.seq).toBe(initial.seq + 1);
      expect(update.by).toBe(0);
      expect(update.state.phase.t).toBe('choose_dest');
    } finally {
      unsubscribe();
      session.close();
    }

    // Node has no localStorage; these must not throw and must report no save.
    expect(hasLocalSave()).toBe(false);
    expect(resumeLocal()).toBeNull();
  }, 15_000);

  it('applies live getSpeed changes to subsequent CPU turns (#2)', async () => {
    let speed = 1;
    const players: PlayerSetup[] = [
      { name: 'human', characterId: 'momotaro', isCpu: false },
      { name: 'cpu', characterId: 'alice', isCpu: true, cpuLevel: 2 },
    ];
    const session = createLocal({ players, years: 3, seed: 42, getSpeed: () => speed });
    const updates: Extract<ServerMsg, { t: 'update' }>[] = [];
    let waiter: (() => void) | null = null;
    const unsubscribe = session.subscribe((msg) => {
      if (msg.t === 'update') {
        updates.push(msg);
        waiter?.();
        waiter = null;
      }
    });
    const waitUpdate = async (minLen: number, timeoutMs = 6000): Promise<void> => {
      const deadline = Date.now() + timeoutMs;
      while (updates.length < minLen) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for update #${minLen}`);
        await new Promise<void>((r) => {
          waiter = r;
          setTimeout(r, 40);
        });
      }
    };
    try {
      await waitUpdate(1);
      // Switch live speed from 1x to 16x before ending the human turn.
      speed = 16;
      const seq1 = updates[updates.length - 1].seq;
      session.send({ t: 'action', seq: seq1, action: { t: 'roll' } });
      await waitUpdate(2);
      const afterRoll = updates[updates.length - 1];
      expect(afterRoll.state.phase.t).toBe('choose_dest');
      const target =
        afterRoll.state.phase.t === 'choose_dest' ? afterRoll.state.phase.options[0].nodeId : '';
      const beforeCpu = Date.now();
      session.send({ t: 'action', seq: afterRoll.seq, action: { t: 'move', nodeId: target } });
      await waitUpdate(3);
      // Finish any post-move human phase (buy / shop / event / discard) so the CPU takes over.
      while (updates[updates.length - 1].state.current === 0) {
        const cur = updates[updates.length - 1];
        const phase = cur.state.phase.t;
        const n = updates.length;
        if (phase === 'buy') session.send({ t: 'action', seq: cur.seq, action: { t: 'end_buy' } });
        else if (phase === 'shop') session.send({ t: 'action', seq: cur.seq, action: { t: 'end_shop' } });
        else if (phase === 'event') session.send({ t: 'action', seq: cur.seq, action: { t: 'choose', index: 0 } });
        else if (phase === 'discard') {
          session.send({ t: 'action', seq: cur.seq, action: { t: 'discard', cardId: cur.state.players[0].cards[0] } });
        } else {
          break;
        }
        await waitUpdate(n + 1);
      }
      // Wait until the CPU rolls & moves (at least 2 CPU updates), which at 1x takes >3.5s
      // but at 16x finishes well under 1.5s.
      const beforeCount = updates.length;
      await waitUpdate(beforeCount + 2, 2500);
      const elapsed = Date.now() - beforeCpu;
      expect(elapsed).toBeLessThan(2000);
    } finally {
      unsubscribe();
      session.close();
    }
  }, 15_000);
});