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
    const session = createLocal({ players, years: 1 });
    const snapshotSeen = Promise.withResolvers<Extract<ServerMsg, { t: 'snapshot' }>>();
    const updateSeen = Promise.withResolvers<Extract<ServerMsg, { t: 'update' }>>();
    const unsubscribe = session.subscribe((msg) => {
      if (msg.t === 'snapshot') snapshotSeen.resolve(msg);
      if (msg.t === 'update') updateSeen.resolve(msg);
    });
    try {
      const snapshot = await snapshotSeen.promise;
      expect(session.mode).toBe('local');
      expect(session.mySeats()).toEqual([0]);
      expect(session.lobby()?.status).toBe('playing');
      expect(snapshot.state.players.map((player) => player.isCpu)).toEqual([false, true]);
      expect(snapshot.state.rng).toBe(0);

      session.send({ t: 'action', seq: snapshot.seq, action: { t: 'roll' } });
      const update = await updateSeen.promise;
      expect(update.seq).toBe(snapshot.seq + 1);
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