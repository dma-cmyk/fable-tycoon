import { describe, expect, it } from 'vitest';
import type { PlayerSetup } from '../core/types';
import type { ServerMsg } from './protocol';
import { createLocal, hasLocalSave, resumeLocal } from './local-session';

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
});