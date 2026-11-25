import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:net';
import type { Socket } from 'node:net';
import { Aedes } from 'aedes';
import type { Action, Fx, GameState } from '../core/types';
import { actorOf, cpuDecide } from '../core/engine';
import { GAME_DATA } from '../data/index';
import type { PublicState, ServerMsg } from './protocol';
import type { Session } from './session-types';
import { setNetDebugForTests } from './debug';
import { FxPlayer, estimateFxDurationMs } from '../ui/fxPlayer';
import { isIdenticalResync } from '../ui/resync';
import type { ResyncWatermark } from '../ui/resync';
import type { UiSettings } from '../ui/settings';
import {
  authorityInfoForTests,
  clearRoomTasksForTests,
  configureNetworkForTests,
  createOnlineRoom,
  joinOnlineRoom,
  killSessionForTests,
  netDebugSnapshotForTests,
  setBlockedPeersForTests,
} from './online-session';

const PROFILE = ['momotaro', 'alice', 'sinbad', 'red_hood'];

interface IsolatedBroker {
  url: string;
  close: () => Promise<void>;
}

async function startBroker(): Promise<IsolatedBroker> {
  const broker = await Aedes.createBroker({ heartbeatInterval: 1_000 });
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    broker.handle(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (typeof address !== 'object' || !address) throw new Error('broker failed to bind');
  let closed = false;
  return {
    url: `mqtt://127.0.0.1:${address.port}`,
    close: async () => {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await new Promise<void>((resolve) => broker.close(() => resolve()));
    },
  };
}

class TestPeer {
  readonly session: Session;
  readonly label: string;
  state: PublicState | null = null;
  seq = 0;
  gen = 0;
  seat: number | null = null;
  history: ServerMsg[] = [];
  private waiters: Array<{
    test: (msg: ServerMsg) => boolean;
    resolve: (msg: ServerMsg) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  constructor(session: Session, label: string) {
    this.session = session;
    this.label = label;
    session.subscribe((msg) => this.handle(msg));
  }

  waitFor(test: (msg: ServerMsg) => boolean, timeoutMs = 15_000, label = 'msg'): Promise<ServerMsg> {
    for (const msg of this.history) {
      if (test(msg)) return Promise.resolve(msg);
    }
    return this.waitForNew(test, timeoutMs, label);
  }

  waitForNew(test: (msg: ServerMsg) => boolean, timeoutMs = 15_000, label = 'msg'): Promise<ServerMsg> {
    const { promise, resolve, reject } = Promise.withResolvers<ServerMsg>();
    const waiter = {
      test,
      resolve,
      reject,
      timer: setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(
          new Error(
            `${this.label}: timed out waiting for ${label} (snap=${JSON.stringify(netDebugSnapshotForTests(this.session))})`,
          ),
        );
      }, timeoutMs),
    };
    this.waiters.push(waiter);
    return promise;
  }

  stop(): void {
    killSessionForTests(this.session);
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`${this.label}: stopped`));
    }
    this.waiters = [];
  }

  private handle(msg: ServerMsg): void {
    this.history.push(msg);
    if (msg.t === 'welcome') this.seat = msg.seat;
    if (msg.t === 'snapshot' || msg.t === 'update') {
      this.gen = msg.gen ?? this.gen;
      this.seq = msg.seq;
      this.state = msg.state;
    }
    const matched = this.waiters.filter((w) => w.test(msg));
    this.waiters = this.waiters.filter((w) => !matched.includes(w));
    for (const waiter of matched) {
      clearTimeout(waiter.timer);
      waiter.resolve(msg);
    }
  }
}

async function waitUntil(
  condition: () => boolean,
  timeoutMs: number,
  label: string,
  diag?: () => unknown,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (condition()) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for ${label}: ${JSON.stringify(diag?.())}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

async function seatAll(host: TestPeer, guests: TestPeer[]): Promise<void> {
  const hw = host.waitForNew((m) => m.t === 'welcome' && m.seat === 0);
  host.session.send({ t: 'take_seat', index: 0 });
  await hw;
  host.session.send({ t: 'pick_character', characterId: PROFILE[0] });
  for (let i = 0; i < guests.length; i += 1) {
    const seat = i + 1;
    const w = guests[i].waitForNew((m) => m.t === 'welcome' && m.seat === seat);
    guests[i].session.send({ t: 'take_seat', index: seat });
    await w;
    guests[i].session.send({ t: 'pick_character', characterId: PROFILE[seat] });
  }
  await host.waitFor(
    (m) =>
      m.t === 'lobby' &&
      m.lobby.seats.slice(0, guests.length + 1).every((s) => s.kind === 'human' && s.characterId !== null),
    15_000,
    'all seated',
  );
}

describe('host migration stall reproductions & regressions', () => {
  const activePeers: TestPeer[] = [];
  const activeBrokers: IsolatedBroker[] = [];

  afterEach(async () => {
    for (const p of activePeers.splice(0)) p.stop();
    configureNetworkForTests({});
    setNetDebugForTests(null);
    for (const b of activeBrokers.splice(0)) await b.close();
  });

  it('mode 1a: guest action in flight when host crashes + quorum dip confirms promotion, resyncs gen, and stays idempotent on duplicate retry', async () => {
    const broker = await startBroker();
    activeBrokers.push(broker);
    configureNetworkForTests({
      brokers: [broker.url],
      disableWebRtc: true,
      connectTimeoutMs: 2_000,
      heartbeatMs: 120,
      hostSilenceMs: 700,
      peerSilenceMs: 1_500,
      probeMs: 200,
      hostGoneMs: 1_500,
      selfHostGraceMs: 800,
      saveThrottleMs: 20,
      probeTimeoutMs: 4_000,
      graceMs: 30_000,
      replaceMs: 60_000,
      yearEndAckMs: 30_000,
      cpuDelayMs: 50,
      fxScale: 0.01,
      clientIds: {
        m1h: 'm1-host',
        m1g1: 'm1-g1',
        m1g2: 'm1-g2',
        m1g3: 'm1-g3',
      },
    });

    const host = new TestPeer(await createOnlineRoom('m1h'), 'm1-host');
    const g1 = new TestPeer(joinOnlineRoom(host.session.roomId, 'm1g1'), 'm1-g1');
    const g2 = new TestPeer(joinOnlineRoom(host.session.roomId, 'm1g2'), 'm1-g2');
    const g3 = new TestPeer(joinOnlineRoom(host.session.roomId, 'm1g3'), 'm1-g3');
    activePeers.push(host, g1, g2, g3);

    await Promise.all([g1, g2, g3].map((g) => g.waitFor((m) => m.t === 'welcome')));
    await seatAll(host, [g1, g2, g3]);
    host.session.send({ t: 'settings', settings: { years: 1, turnSeconds: 0 } });
    const startUpdates = [host, g1, g2, g3].map((p) => p.waitFor((m) => m.t === 'update'));
    host.session.send({ t: 'start' });
    await Promise.all(startUpdates);

    // Advance until seat 2 (g2) is the active actor.
    const peersBySeat = [host, g1, g2, g3];
    for (let guard = 0; guard < 40; guard += 1) {
      const st = host.state;
      if (!st) break;
      const actor = actorOf(st);
      if (actor === 2) break;
      const actorPeer = peersBySeat[actor ?? 0];
      const targetSeq = host.seq;
      const waitNext = Promise.all(
        peersBySeat.map((p) => p.waitFor((m) => m.t === 'update' && m.seq > targetSeq)),
      );
      actorPeer.session.send({
        t: 'action',
        seq: actorPeer.seq,
        action: cpuDecide(GAME_DATA, actorPeer.state as GameState),
      });
      await waitNext;
    }
    expect(actorOf(g2.state as PublicState)).toBe(2);

    // Guest 2 sends an action right as Host 0 drops it and crashes.
    const seqAtCrash = g2.seq;
    const actionAtCrash: Action = cpuDecide(GAME_DATA, g2.state as GameState);
    setBlockedPeersForTests(host.session, ['m1-g2']);
    g2.session.send({ t: 'action', seq: seqAtCrash, action: actionAtCrash });
    expect(netDebugSnapshotForTests(g2.session)?.pendingAction?.seq).toBe(seqAtCrash);

    killSessionForTests(host.session);

    // Wait until g1 promotes to host, THEN briefly block g1's inbound so quorum dips (1/3)
    // before g2/g3 acks arrive (reproducing the final8/final9 updateHostQuorum bypass!).
    await waitUntil(
      () => netDebugSnapshotForTests(g1.session)?.role === 'host',
      8_000,
      'g1 promotes to host',
      () => netDebugSnapshotForTests(g1.session),
    );
    setBlockedPeersForTests(g1.session, ['m1-g2', 'm1-g3']);
    await waitUntil(
      () => netDebugSnapshotForTests(g1.session)?.authority.quorumOk === false,
      5_000,
      'g1 quorum dips to false before acks',
      () => netDebugSnapshotForTests(g1.session),
    );
    setBlockedPeersForTests(g1.session, []);

    // New host g1 MUST set promotionConfirmed=true (not just quorumOk=true!) AND deliver gen>=2 snapshot.
    await waitUntil(
      () => {
        const s1 = netDebugSnapshotForTests(g1.session);
        const s2 = netDebugSnapshotForTests(g2.session);
        return (
          s1?.role === 'host' &&
          s1.authority.ready === true &&
          s1.authority.promotionConfirmed === true &&
          s1.authority.frozen === false &&
          (s2?.applied?.gen ?? 0) >= 2
        );
      },
      10_000,
      'g1 promotionConfirmed=true and g2 received gen>=2 snapshot',
      () => ({
        g1: netDebugSnapshotForTests(g1.session),
        g2: netDebugSnapshotForTests(g2.session),
      }),
    );

    // Guest 2 acts under gen 2, then sends the exact same (gen, seq, action) a second time
    // (simulating a client retry after a lost update): host must NOT double-apply or send stale error!
    const beforeSeq = g2.seq;
    const g2Action = cpuDecide(GAME_DATA, g2.state as GameState);
    const errorsBefore = g2.history.filter((m) => m.t === 'error').length;
    const waitApplied = g2.waitForNew((m) => m.t === 'update' && m.seq === beforeSeq + 1, 8_000, 'g2 act');
    g2.session.send({ t: 'action', seq: beforeSeq, action: g2Action });
    await waitApplied;
    expect(g1.seq).toBe(beforeSeq + 1);

    // Duplicate retry of the exact same (seq, action) must be idempotent: seq stays beforeSeq+1, no stale error.
    g2.session.send({ t: 'action', seq: beforeSeq, action: g2Action });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(g1.seq).toBe(beforeSeq + 1);
    expect(g2.history.filter((m) => m.t === 'error' && m.code === 'stale').length).toBe(errorsBefore);
  }, 60_000);

  it('mode 2a: promoted host upgrades broker mirrors so a guest pinned to a 3rd broker is never stranded', async () => {
    const brokerA = await startBroker();
    const brokerB = await startBroker();
    const brokerC = await startBroker();
    activeBrokers.push(brokerA, brokerB, brokerC);

    const common = {
      disableWebRtc: true,
      connectTimeoutMs: 2_000,
      heartbeatMs: 120,
      hostSilenceMs: 700,
      peerSilenceMs: 1_800,
      probeMs: 200,
      hostGoneMs: 1_500,
      selfHostGraceMs: 800,
      // Production ratio: welcome watchdog (5s) fires BEFORE hostReplySilenceMs (8s)!
      hostReplySilenceMs: 8_000,
      brokerRetryMs: 400,
      saveThrottleMs: 20,
      probeTimeoutMs: 4_000,
      graceMs: 300,
      replaceMs: 60_000,
      yearEndAckMs: 500,
      cpuDelayMs: 50,
      fxScale: 0.01,
    } as const;

    // Host 0 connects to A (primary) + mirrors B & C.
    configureNetworkForTests({
      ...common,
      brokers: [brokerA.url, brokerB.url, brokerC.url],
      clientIds: { mbh: 'mb-host' },
    });
    const host = new TestPeer(await createOnlineRoom('mbh'), 'mb-host');
    activePeers.push(host);
    await waitUntil(
      () => (netDebugSnapshotForTests(host.session)?.mirrors.length ?? 0) >= 2,
      8_000,
      'host mirrors all 3 brokers',
    );

    // Guest 1 & Guest 3 connect to A + mirror B (guest default redundantBrokers=1, so NOT on C!).
    // Wait until g1 and g3 finish connecting BEFORE overriding the global test config for g2.
    configureNetworkForTests({
      ...common,
      brokers: [brokerA.url, brokerB.url, brokerC.url],
      redundantBrokers: 1,
      clientIds: { mbg1: 'mb-g1', mbg3: 'mb-g3' },
    });
    const g1 = new TestPeer(joinOnlineRoom(host.session.roomId, 'mbg1'), 'mb-g1');
    const g3 = new TestPeer(joinOnlineRoom(host.session.roomId, 'mbg3'), 'mb-g3');
    activePeers.push(g1, g3);
    await Promise.all([g1, g3].map((g) => g.waitFor((m) => m.t === 'welcome')));
    await waitUntil(
      () => (netDebugSnapshotForTests(g1.session)?.mirrors.length ?? 0) === 1,
      5_000,
      'g1 connects its 1 guest mirror',
    );
    expect(netDebugSnapshotForTests(g1.session)?.broker).toBe(brokerA.url);
    expect(netDebugSnapshotForTests(g1.session)?.mirrors).toEqual([brokerB.url]);

    // Guest 2 can ONLY reach broker C (simulating a client isolated on a 3rd public broker, like Firefox on HiveMQ in final9!).
    configureNetworkForTests({
      ...common,
      brokers: [brokerC.url],
      redundantBrokers: 0,
      clientIds: { mbg2: 'mb-g2' },
    });
    const g2 = new TestPeer(joinOnlineRoom(host.session.roomId, 'mbg2'), 'mb-g2');
    activePeers.push(g2);

    await g2.waitFor((m) => m.t === 'welcome');
    expect(netDebugSnapshotForTests(g2.session)?.broker).toBe(brokerC.url);
    await seatAll(host, [g1, g2, g3]);
    host.session.send({ t: 'settings', settings: { years: 1, turnSeconds: 20 } });
    const started = [host, g1, g2, g3].map((p) => p.waitFor((m) => m.t === 'update'));
    host.session.send({ t: 'start' });
    await Promise.all(started);

    // Restore full 3-broker config (host role default must mirror all brokers on promotion!).
    configureNetworkForTests({
      ...common,
      brokers: [brokerA.url, brokerB.url, brokerC.url],
      clientIds: { mbh: 'mb-host', mbg1: 'mb-g1', mbg2: 'mb-g2', mbg3: 'mb-g3' },
    });

    const seqBeforeKill = host.seq;
    // Kill Host 0 during its turn.
    killSessionForTests(host.session);

    // g1 promotes on A+B: unless g1 upgrades its mirrors to cover broker C, g2 on C can NEVER reach g1,
    // so g1 stays stuck at 2/3 quorum forever and the killed host's turn NEVER advances!
    await waitUntil(
      () => {
        const s1 = netDebugSnapshotForTests(g1.session);
        return (
          s1?.role === 'host' &&
          s1.mirrors.includes(brokerC.url) &&
          s1.authority.ready === true &&
          s1.authority.promotionConfirmed === true &&
          s1.authority.frozen === false &&
          g1.seq > seqBeforeKill &&
          g2.seq > seqBeforeKill &&
          g3.seq > seqBeforeKill
        );
      },
      12_000,
      'promoted host mirrors broker C so g2 confirms quorum and board advances',
      () => ({
        g1: netDebugSnapshotForTests(g1.session),
        g2: netDebugSnapshotForTests(g2.session),
        g3: netDebugSnapshotForTests(g3.session),
      }),
    );
  }, 45_000);

  it('mode 2b: host crash during CPU turn + quorum dip confirms promotion, re-arms CPU task, and advances board', async () => {
    const broker = await startBroker();
    activeBrokers.push(broker);
    configureNetworkForTests({
      brokers: [broker.url],
      disableWebRtc: true,
      connectTimeoutMs: 2_000,
      heartbeatMs: 120,
      hostSilenceMs: 700,
      peerSilenceMs: 1_500,
      probeMs: 200,
      hostGoneMs: 1_500,
      selfHostGraceMs: 800,
      saveThrottleMs: 20,
      probeTimeoutMs: 4_000,
      graceMs: 10_000,
      replaceMs: 60_000,
      yearEndAckMs: 500,
      cpuDelayMs: 600,
      fxScale: 0.01,
      clientIds: {
        c2h: 'c2-host',
        c2g1: 'c2-g1',
        c2g2: 'c2-g2',
        c2g3: 'c2-g3',
      },
    });

    const host = new TestPeer(await createOnlineRoom('c2h'), 'c2-host');
    const g1 = new TestPeer(joinOnlineRoom(host.session.roomId, 'c2g1'), 'c2-g1');
    const g2 = new TestPeer(joinOnlineRoom(host.session.roomId, 'c2g2'), 'c2-g2');
    activePeers.push(host, g1, g2);

    await Promise.all([g1, g2].map((g) => g.waitFor((m) => m.t === 'welcome')));
    await seatAll(host, [g1, g2]);
    host.session.send({ t: 'set_seat', index: 3, kind: 'cpu', cpuLevel: 2 });
    host.session.send({ t: 'pick_character', characterId: PROFILE[3], seat: 3 });
    await host.waitFor((m) => m.t === 'lobby' && m.lobby.seats[3].kind === 'cpu' && m.lobby.seats[3].characterId === PROFILE[3]);

    host.session.send({ t: 'settings', settings: { years: 1, turnSeconds: 0 } });
    const started = [host, g1, g2].map((p) => p.waitFor((m) => m.t === 'update'));
    host.session.send({ t: 'start' });
    await Promise.all(started);

    const humans = [host, g1, g2];
    for (let guard = 0; guard < 60; guard += 1) {
      const st = host.state;
      if (!st) break;
      const actor = actorOf(st);
      if (actor === 3) break;
      const peer = humans[actor ?? 0];
      const before = host.seq;
      const allSaw = Promise.all(humans.map((p) => p.waitFor((m) => m.t === 'update' && m.seq > before)));
      peer.session.send({
        t: 'action',
        seq: peer.seq,
        action: cpuDecide(GAME_DATA, peer.state as GameState),
      });
      await allSaw;
    }
    expect(actorOf(g1.state as PublicState)).toBe(3);
    const seqAtCpuTurn = g1.seq;

    // Delay g2's traffic to g1 right as host crashes so g1 promotes into a quorum dip before g2 acks.
    setBlockedPeersForTests(g2.session, ['c2-g1']);
    killSessionForTests(host.session);

    await waitUntil(
      () => netDebugSnapshotForTests(g1.session)?.role === 'host',
      8_000,
      'g1 promotes during CPU turn',
      () => netDebugSnapshotForTests(g1.session),
    );
    await waitUntil(
      () => netDebugSnapshotForTests(g1.session)?.authority.quorumOk === false,
      5_000,
      'g1 loses quorum before g2 acks during CPU turn',
      () => netDebugSnapshotForTests(g1.session),
    );
    // Restore g2 -> g1 path: g1 must confirm promotion, re-arm the CPU task, and advance the board.
    setBlockedPeersForTests(g2.session, []);

    await waitUntil(
      () => {
        const snap = netDebugSnapshotForTests(g1.session);
        return (
          snap?.role === 'host' &&
          snap.authority.ready === true &&
          snap.authority.promotionConfirmed === true &&
          snap.authority.frozen === false &&
          g1.seq > seqAtCpuTurn &&
          g2.seq > seqAtCpuTurn
        );
      },
      10_000,
      'new host confirms authority and advances CPU turn after host crash',
      () => ({
        g1: netDebugSnapshotForTests(g1.session),
        g2: netDebugSnapshotForTests(g2.session),
      }),
    );
    expect(authorityInfoForTests(g1.session)?.ready).toBe(true);
  }, 45_000);

  it('mode 3: FxPlayer watchdog still fires when a resync snapshot interrupts an in-flight fx right before a new update stalls', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const settings: UiSettings = { fxSpeed: 8, autoAdvance: true, showChat: true, reducedMotion: false };
      const state1 = { current: 0, players: [] } as unknown as PublicState;
      const state2 = { current: 1, players: [] } as unknown as PublicState;
      const diceFx: Fx = { t: 'dice', values: [6] };
      const applied: Array<{ seq: number; gen: number | undefined }> = [];
      let call = 0;
      let releaseFirst!: () => void;

      const player = new FxPlayer({
        settings: () => settings,
        handleFx: (_fx, _state, control) => {
          call += 1;
          if (call === 1) {
            const { promise, resolve } = Promise.withResolvers<void>();
            releaseFirst = resolve;
            control.onSkip(() => queueMicrotask(resolve));
            return promise;
          }
          return new Promise<void>(() => undefined);
        },
        applyState: (_state, _deadline, seq, gen) => applied.push({ seq, gen }),
        setBusy: () => undefined,
        setSkippable: () => undefined,
        onQueueChange: () => undefined,
      });

      player.enqueue({ seq: 10, fx: [diceFx], state: state1, deadline: null, gen: 1 });
      expect(player.busy).toBe(true);

      player.reset();
      player.enqueue({ seq: 11, fx: [diceFx], state: state2, deadline: null, gen: 2 });
      expect(player.busy).toBe(true);

      releaseFirst();
      await Promise.resolve();
      await Promise.resolve();

      const budget = estimateFxDurationMs(diceFx) * 2 + 8000;
      await vi.advanceTimersByTimeAsync(budget + 500);

      expect(player.busy).toBe(false);
      expect(applied).toEqual([{ seq: 11, gen: 2 }]);
      expect(warn).toHaveBeenCalledTimes(1);
      player.destroy();
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it('mode 1b: client safety net resends same (gen, seq), escalates to resync, and bounds retries cleanly', async () => {
    const broker = await startBroker();
    activeBrokers.push(broker);
    configureNetworkForTests({
      brokers: [broker.url],
      disableWebRtc: true,
      connectTimeoutMs: 2_000,
      heartbeatMs: 120,
      hostSilenceMs: 10_000,
      peerSilenceMs: 10_000,
      saveThrottleMs: 20,
      graceMs: 30_000,
      replaceMs: 60_000,
      yearEndAckMs: 30_000,
      cpuDelayMs: 50,
      fxScale: 0.01,
      actionRetryMs: 300,
      actionResyncMs: 250,
      maxActionRetries: 2,
      maxActionResyncs: 2,
      clientIds: { s1h: 's1-host', s1g: 's1-guest' },
    });

    const host = new TestPeer(await createOnlineRoom('s1h'), 's1-host');
    const guest = new TestPeer(joinOnlineRoom(host.session.roomId, 's1g'), 's1-guest');
    activePeers.push(host, guest);

    await guest.waitFor((m) => m.t === 'welcome');
    await seatAll(host, [guest]);
    host.session.send({ t: 'settings', settings: { years: 1, turnSeconds: 0 } });
    const started = [host, guest].map((p) => p.waitFor((m) => m.t === 'update'));
    host.session.send({ t: 'start' });
    await Promise.all(started);

    // Advance to seat 1 (guest).
    const peers = [host, guest];
    for (let i = 0; i < 30 && actorOf(host.state as PublicState) !== 1; i += 1) {
      const a = actorOf(host.state as PublicState) ?? 0;
      const before = host.seq;
      const wait = Promise.all(peers.map((p) => p.waitFor((m) => m.t === 'update' && m.seq > before)));
      peers[a].session.send({ t: 'action', seq: peers[a].seq, action: cpuDecide(GAME_DATA, peers[a].state as GameState) });
      await wait;
    }
    expect(actorOf(guest.state as PublicState)).toBe(1);

    // Part A: host temporarily drops guest's first send -> guest resends with same (gen, seq) and succeeds.
    const seq1 = guest.seq;
    const act1 = cpuDecide(GAME_DATA, guest.state as GameState);
    setBlockedPeersForTests(host.session, ['s1-guest']);
    guest.session.send({ t: 'action', seq: seq1, action: act1 });
    await waitUntil(
      () => (netDebugSnapshotForTests(guest.session)?.pendingAction?.retries ?? 0) >= 1,
      3_000,
      'guest increments resend retry counter',
      () => netDebugSnapshotForTests(guest.session),
    );
    setBlockedPeersForTests(host.session, []);
    await guest.waitFor((m) => m.t === 'update' && m.seq === seq1 + 1, 5_000, 'resent action applied');
    expect(host.seq).toBe(seq1 + 1);
    expect(netDebugSnapshotForTests(guest.session)?.pendingAction).toBeNull();

    // Part B: host drops ALL messages from guest -> guest resends maxActionRetries (2), escalates to
    // maxActionResyncs (2), and then clears pendingAction with a bounded softReject (no infinite loop).
    for (let i = 0; i < 30 && actorOf(host.state as PublicState) !== 1; i += 1) {
      const a = actorOf(host.state as PublicState) ?? 0;
      const before = host.seq;
      const wait = Promise.all(peers.map((p) => p.waitFor((m) => m.t === 'update' && m.seq > before)));
      peers[a].session.send({ t: 'action', seq: peers[a].seq, action: cpuDecide(GAME_DATA, peers[a].state as GameState) });
      await wait;
    }
    const seq2 = guest.seq;
    const act2 = cpuDecide(GAME_DATA, guest.state as GameState);
    const errsBefore = guest.history.filter((m) => m.t === 'error' && m.code === 'stale').length;
    setBlockedPeersForTests(host.session, ['s1-guest']);
    guest.session.send({ t: 'action', seq: seq2, action: act2 });
    await waitUntil(
      () =>
        netDebugSnapshotForTests(guest.session)?.pendingAction === null &&
        guest.history.filter((m) => m.t === 'error' && m.code === 'stale').length > errsBefore,
      5_000,
      'bounded pending action timeout clears lock after retries + resyncs',
      () => netDebugSnapshotForTests(guest.session),
    );
    expect(host.seq).toBe(seq2);
  }, 45_000);

  it('mode 1c: host resync still replies after peer connection drop and never leaves guest stale', async () => {
    const broker = await startBroker();
    activeBrokers.push(broker);
    configureNetworkForTests({
      brokers: [broker.url],
      disableWebRtc: true,
      connectTimeoutMs: 2_000,
      heartbeatMs: 120,
      hostSilenceMs: 10_000,
      peerSilenceMs: 500,
      saveThrottleMs: 20,
      graceMs: 30_000,
      replaceMs: 60_000,
      yearEndAckMs: 30_000,
      cpuDelayMs: 50,
      fxScale: 0.01,
      clientIds: { r1h: 'r1-host', r1g: 'r1-guest' },
    });

    const host = new TestPeer(await createOnlineRoom('r1h'), 'r1-host');
    const guest = new TestPeer(joinOnlineRoom(host.session.roomId, 'r1g'), 'r1-guest');
    activePeers.push(host, guest);
    await guest.waitFor((m) => m.t === 'welcome');
    await seatAll(host, [guest]);
    host.session.send({ t: 'settings', settings: { years: 1, turnSeconds: 0 } });
    const started = [host, guest].map((p) => p.waitFor((m) => m.t === 'update'));
    host.session.send({ t: 'start' });
    await Promise.all(started);

    // Block guest -> host until host's peerSilenceMs disconnects guest's conn in RoomController.
    setBlockedPeersForTests(host.session, ['r1-guest']);
    await waitUntil(
      () => host.history.some((m) => m.t === 'lobby' && m.lobby.seats[1]?.connected === false),
      4_000,
      'host disconnects silent guest',
    );
    const snapCountBefore = guest.history.filter((m) => m.t === 'snapshot').length;
    setBlockedPeersForTests(host.session, []);
    guest.session.requestResync?.();

    await waitUntil(
      () => guest.history.filter((m) => m.t === 'snapshot').length > snapCountBefore,
      4_000,
      'host responds to resync even after conn was deleted',
    );
  }, 30_000);

  it('mode 2c: welcome watchdog rotates off a pinned unresponsive hostBroker instead of looping forever', async () => {
    const brokerA = await startBroker();
    const brokerB = await startBroker();
    activeBrokers.push(brokerA, brokerB);

    const common = {
      disableWebRtc: true,
      connectTimeoutMs: 2_000,
      heartbeatMs: 120,
      hostSilenceMs: 700,
      peerSilenceMs: 1_500,
      probeMs: 200,
      hostGoneMs: 1_500,
      selfHostGraceMs: 800,
      welcomeTimeoutMs: 500,
      hostReplySilenceMs: 1_200,
      brokerRetryMs: 300,
      saveThrottleMs: 20,
      graceMs: 30_000,
      replaceMs: 60_000,
      yearEndAckMs: 30_000,
      cpuDelayMs: 50,
      fxScale: 0.01,
    } as const;

    // Initial host starts on brokerA (records discoveredBroker = brokerA) + mirror brokerB.
    configureNetworkForTests({
      ...common,
      brokers: [brokerA.url, brokerB.url],
      clientIds: { w3h: 'w3-host' },
    });
    const h2 = new TestPeer(await createOnlineRoom('w3h'), 'w3-host');
    activePeers.push(h2);
    await waitUntil(() => (netDebugSnapshotForTests(h2.session)?.mirrors.length ?? 0) >= 1, 5_000, 'h2 mirror B');

    configureNetworkForTests({
      ...common,
      brokers: [brokerB.url],
      redundantBrokers: 0,
      clientIds: { w3g1: 'w3-g1' },
    });
    const gOnB = new TestPeer(joinOnlineRoom(h2.session.roomId, 'w3g1'), 'w3-g1');
    activePeers.push(gOnB);
    await gOnB.waitFor((m) => m.t === 'welcome');
    expect(netDebugSnapshotForTests(gOnB.session)?.broker).toBe(brokerB.url);
    await seatAll(h2, [gOnB]);

    // Kill h2: gOnB promotes as host on brokerB ONLY (brokerA stays UP with NO host,
    // while discoveredBroker[h2.session.roomId] STILL points to brokerA!).
    killSessionForTests(h2.session);
    await waitUntil(
      () => netDebugSnapshotForTests(gOnB.session)?.role === 'host',
      8_000,
      'gOnB promotes on brokerB only',
      () => netDebugSnapshotForTests(gOnB.session),
    );

    // Late joiner starts with discoveredBroker=brokerA and redundantBrokers=0:
    // welcome watchdog fires on brokerA, MUST add brokerA to brokerMisses and rotate to brokerB!
    configureNetworkForTests({
      ...common,
      brokers: [brokerA.url, brokerB.url],
      redundantBrokers: 0,
      clientIds: { w3late: 'w3-late' },
    });
    const late = new TestPeer(joinOnlineRoom(h2.session.roomId, 'w3late', { hostKeyHint: null }), 'w3-late');
    activePeers.push(late);
    await late.waitFor((m) => m.t === 'welcome', 8_000, 'late guest rotates off brokerA to brokerB');
    expect(netDebugSnapshotForTests(late.session)?.broker).toBe(brokerB.url);
  }, 45_000);

  it('mode 3b: Aedes host migration resync during active FxPlayer does not disarm watchdog on next gen update', async () => {
    const broker = await startBroker();
    activeBrokers.push(broker);
    configureNetworkForTests({
      brokers: [broker.url],
      disableWebRtc: true,
      connectTimeoutMs: 2_000,
      heartbeatMs: 120,
      hostSilenceMs: 700,
      peerSilenceMs: 1_500,
      probeMs: 200,
      hostGoneMs: 1_500,
      selfHostGraceMs: 800,
      saveThrottleMs: 20,
      graceMs: 30_000,
      replaceMs: 60_000,
      yearEndAckMs: 30_000,
      cpuDelayMs: 50,
      fxScale: 0.01,
      clientIds: { f3h: 'f3-host', f3g1: 'f3-g1', f3g2: 'f3-g2' },
    });

    const host = new TestPeer(await createOnlineRoom('f3h'), 'f3-host');
    const g1 = new TestPeer(joinOnlineRoom(host.session.roomId, 'f3g1'), 'f3-g1');
    const g2 = new TestPeer(joinOnlineRoom(host.session.roomId, 'f3g2'), 'f3-g2');
    activePeers.push(host, g1, g2);
    await Promise.all([g1, g2].map((g) => g.waitFor((m) => m.t === 'welcome')));
    await seatAll(host, [g1, g2]);
    host.session.send({ t: 'settings', settings: { years: 1, turnSeconds: 0 } });
    const started = [host, g1, g2].map((p) => p.waitFor((m) => m.t === 'update'));
    host.session.send({ t: 'start' });
    await Promise.all(started);

    // Wire a real FxPlayer onto g2's session stream, mimicking GameScreen.onMessage.
    const settings: UiSettings = { fxSpeed: 8, autoAdvance: true, showChat: true, reducedMotion: false };
    const applied: Array<{ seq: number; gen: number | undefined }> = [];
    const releaseHolder: { fn: (() => void) | null } = { fn: null };
    let hangOnGen1 = true;
    const fxPlayer = new FxPlayer({
      settings: () => settings,
      handleFx: (_fx, _state, control) => {
        if (hangOnGen1) {
          const { promise, resolve } = Promise.withResolvers<void>();
          releaseHolder.fn = resolve;
          control.onSkip(() => queueMicrotask(resolve));
          return promise;
        }
        return Promise.resolve();
      },
      applyState: (_s, _d, seq, gen) => applied.push({ seq, gen }),
      setBusy: () => undefined,
      setSkippable: () => undefined,
      onQueueChange: () => undefined,
    });
    const unsub = g2.session.subscribe((msg) => {
      if (msg.t === 'snapshot') {
        fxPlayer.reset();
        applied.push({ seq: msg.seq, gen: msg.gen });
      } else if (msg.t === 'update') {
        fxPlayer.enqueue({ seq: msg.seq, fx: msg.fx, state: msg.state, deadline: msg.deadline, gen: msg.gen });
      }
    });
    try {
      // Trigger a gen-1 update that leaves g2's FxPlayer mid-animation.
      const actor = actorOf(host.state as PublicState) ?? 0;
      const actorPeer = [host, g1, g2][actor];
      const beforeSeq = host.seq;
      actorPeer.session.send({
        t: 'action',
        seq: actorPeer.seq,
        action: cpuDecide(GAME_DATA, actorPeer.state as GameState),
      });
      await g2.waitFor((m) => m.t === 'update' && m.seq > beforeSeq, 5_000, 'gen 1 fx starts');
      expect(fxPlayer.busy).toBe(true);

      // Kill host while g2's FxPlayer is busy -> g1 promotes -> gen=2 resync snapshot resets FxPlayer!
      hangOnGen1 = false;
      killSessionForTests(host.session);
      await waitUntil(
        () =>
          netDebugSnapshotForTests(g1.session)?.role === 'host' &&
          netDebugSnapshotForTests(g1.session)?.authority.promotionConfirmed === true &&
          applied.some((a) => (a.gen ?? 0) >= 2),
        10_000,
        'migration resync resets FxPlayer and delivers gen 2 state',
        () => ({ g1: netDebugSnapshotForTests(g1.session), applied }),
      );
      releaseHolder.fn?.();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(fxPlayer.busy).toBe(false);
    } finally {
      unsub();
      fxPlayer.destroy();
    }
  }, 45_000);

  it('mode 2d: host stall watchdog warns, re-arms missing room tasks, and advances stalled CPU turn', async () => {
    const broker = await startBroker();
    activeBrokers.push(broker);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      configureNetworkForTests({
        brokers: [broker.url],
        disableWebRtc: true,
        connectTimeoutMs: 2_000,
        heartbeatMs: 120,
        hostSilenceMs: 10_000,
        peerSilenceMs: 10_000,
        saveThrottleMs: 20,
        graceMs: 30_000,
        replaceMs: 60_000,
        yearEndAckMs: 30_000,
        cpuDelayMs: 120,
        fxScale: 0.01,
        hostStallExtraMs: 300,
        maxHostStallRearms: 3,
        clientIds: { st0h: 'st0-host' },
      });

      const host = new TestPeer(await createOnlineRoom('st0h'), 'st0-host');
      activePeers.push(host);
      const hw = host.waitForNew((m) => m.t === 'welcome' && m.seat === 0);
      host.session.send({ t: 'take_seat', index: 0 });
      await hw;
      host.session.send({ t: 'pick_character', characterId: PROFILE[0] });
      host.session.send({ t: 'set_seat', index: 1, kind: 'cpu', cpuLevel: 2 });
      host.session.send({ t: 'pick_character', characterId: PROFILE[1], seat: 1 });
      host.session.send({ t: 'settings', settings: { years: 1, turnSeconds: 0 } });
      const started = host.waitFor((m) => m.t === 'update');
      host.session.send({ t: 'start' });
      await started;

      // Advance until seat 1 (CPU) is the active actor, then wipe scheduled tasks to simulate a lost task.
      for (let i = 0; i < 30 && actorOf(host.state as PublicState) !== 1; i += 1) {
        const before = host.seq;
        const next = host.waitFor((m) => m.t === 'update' && m.seq > before);
        host.session.send({
          t: 'action',
          seq: host.seq,
          action: cpuDecide(GAME_DATA, host.state as GameState),
        });
        await next;
      }
      expect(actorOf(host.state as PublicState)).toBe(1);
      const stalledSeq = host.seq;
      clearRoomTasksForTests(host.session);
      expect(netDebugSnapshotForTests(host.session)?.controller?.tasks).toEqual([]);

      // Host stall watchdog MUST detect missing task, log a warning, re-arm CPU, and advance seq!
      await waitUntil(
        () => host.seq > stalledSeq,
        5_000,
        'host stall watchdog re-arms CPU task and advances seq',
        () => netDebugSnapshotForTests(host.session),
      );
      expect(
        warn.mock.calls.some((args) => String(args[0] ?? '').includes('host board stalled')),
      ).toBe(true);
    } finally {
      warn.mockRestore();
    }
  }, 30_000);

  it('instrumentation: debugSnapshot exposes (gen, seq), pendingAction, tasks, frozen; console.debug is opt-in', async () => {
    const broker = await startBroker();
    activeBrokers.push(broker);
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    try {
      configureNetworkForTests({
        brokers: [broker.url],
        disableWebRtc: true,
        connectTimeoutMs: 2_000,
        heartbeatMs: 200,
        saveThrottleMs: 20,
        cpuDelayMs: 500,
        fxScale: 0.01,
        clientIds: { dbh: 'db-host', dbg: 'db-guest' },
      });

      // Default: console.debug MUST stay silent.
      setNetDebugForTests(false);
      const host = new TestPeer(await createOnlineRoom('dbh'), 'db-host');
      const guest = new TestPeer(joinOnlineRoom(host.session.roomId, 'dbg'), 'db-guest');
      activePeers.push(host, guest);
      await guest.waitFor((m) => m.t === 'welcome');
      await seatAll(host, [guest]);
      host.session.send({ t: 'settings', settings: { years: 1, turnSeconds: 20 } });
      const started = [host, guest].map((p) => p.waitFor((m) => m.t === 'update'));
      host.session.send({ t: 'start' });
      await Promise.all(started);
      expect(debugSpy).not.toHaveBeenCalled();

      // Snapshot exposes required observability fields on both host and guest.
      const hostSnap = netDebugSnapshotForTests(host.session);
      const guestSnap = netDebugSnapshotForTests(guest.session);
      expect(hostSnap?.lastReceived).toEqual({ gen: 1, seq: host.seq });
      expect(hostSnap?.controller?.frozen).toBe(false);
      expect(hostSnap?.controller?.tasks.some((t) => t.kind === 'turn')).toBe(true);
      expect(guestSnap?.lastReceived).toEqual({ gen: 1, seq: guest.seq });

      // Opt-in (?debug=net / setNetDebugForTests(true)): console.debug emits net diagnostics.
      setNetDebugForTests(true);
      const before = host.seq;
      const waitNext = guest.waitFor((m) => m.t === 'update' && m.seq > before);
      host.session.send({
        t: 'action',
        seq: host.seq,
        action: cpuDecide(GAME_DATA, host.state as GameState),
      });
      await waitNext;
      expect(debugSpy).toHaveBeenCalled();
    } finally {
      debugSpy.mockRestore();
      setNetDebugForTests(null);
    }
  }, 30_000);

  it('repro 1a: 20s turn deadline still fires within 25s and advances via CPU despite quorum flapping every 5s', async () => {
    const broker = await startBroker();
    activeBrokers.push(broker);
    configureNetworkForTests({
      brokers: [broker.url],
      disableWebRtc: true,
      connectTimeoutMs: 2_000,
      heartbeatMs: 120,
      hostSilenceMs: 12_000,
      peerSilenceMs: 900,
      probeMs: 300,
      hostGoneMs: 15_000,
      selfHostGraceMs: 2_000,
      saveThrottleMs: 20,
      graceMs: 30_000,
      replaceMs: 120_000,
      yearEndAckMs: 30_000,
      cpuDelayMs: 80,
      fxScale: 0.01,
      clientIds: { qfh: 'qf-host', qfg1: 'qf-g1', qfg2: 'qf-g2' },
    });

    const host = new TestPeer(await createOnlineRoom('qfh'), 'qf-host');
    const g1 = new TestPeer(joinOnlineRoom(host.session.roomId, 'qfg1'), 'qf-g1');
    const g2 = new TestPeer(joinOnlineRoom(host.session.roomId, 'qfg2'), 'qf-g2');
    activePeers.push(host, g1, g2);
    await Promise.all([g1, g2].map((g) => g.waitFor((m) => m.t === 'welcome')));
    await seatAll(host, [g1, g2]);
    host.session.send({ t: 'settings', settings: { years: 1, turnSeconds: 20 } });
    const started = [host, g1, g2].map((p) => p.waitFor((m) => m.t === 'update'));
    host.session.send({ t: 'start' });
    await Promise.all(started);

    // Advance until seat 2 (g2) is the acting human, then let nobody act.
    const peers = [host, g1, g2];
    for (let i = 0; i < 40 && actorOf(host.state as PublicState) !== 2; i += 1) {
      const a = actorOf(host.state as PublicState) ?? 0;
      const before = host.seq;
      const allSaw = Promise.all(peers.map((p) => p.waitFor((m) => m.t === 'update' && m.seq > before)));
      peers[a].session.send({
        t: 'action',
        seq: peers[a].seq,
        action: cpuDecide(GAME_DATA, peers[a].state as GameState),
      });
      await allSaw;
    }
    expect(actorOf(host.state as PublicState)).toBe(2);
    const seqAtTurnStart = host.seq;
    const turnStartMs = Date.now();

    // Flap host quorum every 5 seconds: lose quorum for ~2.2s, restore for ~2.8s.
    let quorumLosses = 0;
    const flapDone = (async () => {
      for (let cycle = 0; cycle < 5; cycle += 1) {
        if (host.seq > seqAtTurnStart) break;
        const nextLossAt = turnStartMs + (cycle + 1) * 5_000 - 2_200;
        const waitBefore = nextLossAt - Date.now();
        if (waitBefore > 0) await new Promise((r) => setTimeout(r, waitBefore));
        if (host.seq > seqAtTurnStart) break;
        setBlockedPeersForTests(host.session, ['qf-g1', 'qf-g2']);
        try {
          await waitUntil(
            () => netDebugSnapshotForTests(host.session)?.authority.quorumOk === false || host.seq > seqAtTurnStart,
            2_500,
            'quorum dips',
          );
          if (netDebugSnapshotForTests(host.session)?.authority.quorumOk === false) quorumLosses += 1;
        } catch {
          // ignore if seq already advanced
        }
        await new Promise((r) => setTimeout(r, 1_400));
        setBlockedPeersForTests(host.session, []);
        try {
          await waitUntil(
            () => netDebugSnapshotForTests(host.session)?.authority.quorumOk === true || host.seq > seqAtTurnStart,
            2_500,
            'quorum restores',
          );
        } catch {
          // ignore
        }
      }
      setBlockedPeersForTests(host.session, []);
    })();

    try {
      await waitUntil(
        () => host.seq > seqAtTurnStart && g2.seq > seqAtTurnStart,
        25_000,
        '20s turn deadline fires within 25s despite quorum flapping every 5s',
        () => ({
          elapsedMs: Date.now() - turnStartMs,
          quorumLosses,
          host: netDebugSnapshotForTests(host.session),
        }),
      );
      expect(Date.now() - turnStartMs).toBeLessThanOrEqual(25_000);
      expect(quorumLosses).toBeGreaterThanOrEqual(2);
      expect(host.history.some((m) => m.t === 'system' && m.text.includes('時間切れ'))).toBe(true);
    } finally {
      setBlockedPeersForTests(host.session, []);
      await flapDone;
    }
  }, 45_000);

  it('repro 1b: host migration preserves elapsed turn time via relative turnElapsedMs instead of resetting to +20s', async () => {
    const broker = await startBroker();
    activeBrokers.push(broker);
    configureNetworkForTests({
      brokers: [broker.url],
      disableWebRtc: true,
      connectTimeoutMs: 2_000,
      heartbeatMs: 150,
      hostSilenceMs: 700,
      peerSilenceMs: 1_800,
      probeMs: 200,
      hostGoneMs: 1_500,
      selfHostGraceMs: 800,
      saveThrottleMs: 20,
      graceMs: 30_000,
      replaceMs: 120_000,
      yearEndAckMs: 30_000,
      cpuDelayMs: 80,
      fxScale: 0.01,
      clientIds: { elh: 'el-host', elg1: 'el-g1', elg2: 'el-g2' },
    });

    const host = new TestPeer(await createOnlineRoom('elh'), 'el-host');
    const g1 = new TestPeer(joinOnlineRoom(host.session.roomId, 'elg1'), 'el-g1');
    const g2 = new TestPeer(joinOnlineRoom(host.session.roomId, 'elg2'), 'el-g2');
    activePeers.push(host, g1, g2);
    await Promise.all([g1, g2].map((g) => g.waitFor((m) => m.t === 'welcome')));
    await seatAll(host, [g1, g2]);
    host.session.send({ t: 'settings', settings: { years: 1, turnSeconds: 20 } });
    const started = [host, g1, g2].map((p) => p.waitFor((m) => m.t === 'update'));
    host.session.send({ t: 'start' });
    await Promise.all(started);

    // Move to seat 2 (g2) so g2 is acting human and remains alive across migration.
    const peers = [host, g1, g2];
    for (let i = 0; i < 40 && actorOf(host.state as PublicState) !== 2; i += 1) {
      const a = actorOf(host.state as PublicState) ?? 0;
      const before = host.seq;
      const allSaw = Promise.all(peers.map((p) => p.waitFor((m) => m.t === 'update' && m.seq > before)));
      peers[a].session.send({
        t: 'action',
        seq: peers[a].seq,
        action: cpuDecide(GAME_DATA, peers[a].state as GameState),
      });
      await allSaw;
    }
    expect(actorOf(host.state as PublicState)).toBe(2);
    const seqAtStart = host.seq;
    const turnStartedAt = Date.now();

    // Let 6 seconds elapse on the original host, then kill host so g1 adopts the room.
    await new Promise((r) => setTimeout(r, 6_000));
    killSessionForTests(host.session);

    await waitUntil(
      () =>
        netDebugSnapshotForTests(g1.session)?.role === 'host' &&
        netDebugSnapshotForTests(g1.session)?.authority.promotionConfirmed === true,
      8_000,
      'g1 confirms host authority',
      () => netDebugSnapshotForTests(g1.session),
    );
    const remainingAfterConfirm =
      (netDebugSnapshotForTests(g1.session)?.controller?.deadline ?? Number.POSITIVE_INFINITY) - Date.now();
    // With 6s elapsed before crash + ~1.5s migration, remaining MUST be <= 15s (NOT reset to 20s!).
    expect(remainingAfterConfirm).toBeLessThan(15_500);

    // The original 20s deadline must still fire within 24s of turn start.
    await waitUntil(
      () => g1.seq > seqAtStart && g2.seq > seqAtStart,
      24_000 - (Date.now() - turnStartedAt),
      'migrated turn deadline fires on original schedule',
      () => ({ elapsedMs: Date.now() - turnStartedAt, g1: netDebugSnapshotForTests(g1.session) }),
    );
  }, 45_000);

  it('repro 2: same-(gen, seq) resync and FxPlayer watchdog never leave cutscene stuck in busy state', async () => {
    const broker = await startBroker();
    activeBrokers.push(broker);
    configureNetworkForTests({
      brokers: [broker.url],
      disableWebRtc: true,
      connectTimeoutMs: 2_000,
      heartbeatMs: 120,
      hostSilenceMs: 10_000,
      peerSilenceMs: 10_000,
      saveThrottleMs: 20,
      graceMs: 30_000,
      replaceMs: 60_000,
      yearEndAckMs: 30_000,
      cpuDelayMs: 50,
      fxScale: 0.01,
      clientIds: { rs2h: 'rs2-host', rs2g: 'rs2-guest' },
    });

    const host = new TestPeer(await createOnlineRoom('rs2h'), 'rs2-host');
    const guest = new TestPeer(joinOnlineRoom(host.session.roomId, 'rs2g'), 'rs2-guest');
    activePeers.push(host, guest);
    await guest.waitFor((m) => m.t === 'welcome');
    await seatAll(host, [guest]);
    host.session.send({ t: 'settings', settings: { years: 1, turnSeconds: 0 } });
    const started = [host, guest].map((p) => p.waitFor((m) => m.t === 'update'));
    host.session.send({ t: 'start' });
    await Promise.all(started);

    const settings: UiSettings = { fxSpeed: 8, autoAdvance: true, showChat: true, reducedMotion: false };
    let watermark: ResyncWatermark | null = null;
    let fxBusy = false;
    let hangFx = true;
    const fxPlayer = new FxPlayer({
      settings: () => settings,
      handleFx: () => (hangFx ? new Promise<void>(() => undefined) : Promise.resolve()),
      applyState: (state, _deadline, seq, gen) => {
        watermark = { gen: gen ?? 1, seq, state };
      },
      setBusy: (busy) => {
        fxBusy = busy;
      },
      setSkippable: () => undefined,
      onQueueChange: () => undefined,
    });
    const unsub = guest.session.subscribe((msg) => {
      if (msg.t === 'snapshot') {
        const gen = msg.gen ?? 1;
        if (msg.resync && !fxPlayer.busy && !fxBusy && isIdenticalResync(watermark, { gen, seq: msg.seq, state: msg.state })) {
          return;
        }
        fxPlayer.reset();
        watermark = { gen, seq: msg.seq, state: msg.state };
      } else if (msg.t === 'update') {
        fxPlayer.enqueue({ seq: msg.seq, fx: msg.fx, state: msg.state, deadline: msg.deadline, gen: msg.gen });
      }
    });
    try {
      const beforeSeq = host.seq;
      host.session.send({
        t: 'action',
        seq: beforeSeq,
        action: cpuDecide(GAME_DATA, host.state as GameState),
      });
      await guest.waitFor((m) => m.t === 'update' && m.seq > beforeSeq, 5_000, 'guest receives update');
      expect(fxPlayer.busy).toBe(true);
      expect(fxBusy).toBe(true);

      // Guest requests explicit resync for the SAME (gen, seq) while FxPlayer is hung on that update.
      guest.session.requestResync?.();
      await waitUntil(
        () => !fxPlayer.busy && !fxBusy && watermark?.seq === host.seq,
        5_000,
        'same-(gen, seq) resync clears hung FxPlayer and adopts board',
        () => ({ busy: fxPlayer.busy, fxBusy, watermarkSeq: watermark?.seq, hostSeq: host.seq }),
      );
      hangFx = false;
    } finally {
      unsub();
      fxPlayer.destroy();
    }
  }, 30_000);

  it('repro 3a: migration avoids false quorum-lost spam and guests restore mirror brokers after broker rotation', async () => {
    const brokerA = await startBroker();
    const brokerB = await startBroker();
    const brokerC = await startBroker();
    activeBrokers.push(brokerA, brokerB, brokerC);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const common = {
        disableWebRtc: true,
        connectTimeoutMs: 2_000,
        heartbeatMs: 120,
        hostSilenceMs: 700,
        peerSilenceMs: 2_000,
        probeMs: 200,
        hostGoneMs: 1_500,
        selfHostGraceMs: 800,
        welcomeTimeoutMs: 600,
        hostReplySilenceMs: 1_000,
        brokerRetryMs: 300,
        saveThrottleMs: 20,
        graceMs: 30_000,
        replaceMs: 60_000,
        yearEndAckMs: 30_000,
        cpuDelayMs: 50,
        fxScale: 0.01,
      } as const;

      configureNetworkForTests({
        ...common,
        brokers: [brokerA.url, brokerB.url, brokerC.url],
        clientIds: { q3h: 'q3-host', q3g1: 'q3-g1', q3g2: 'q3-g2', q3g3: 'q3-g3' },
      });

      const host = new TestPeer(await createOnlineRoom('q3h'), 'q3-host');
      const g1 = new TestPeer(joinOnlineRoom(host.session.roomId, 'q3g1'), 'q3-g1');
      const g2 = new TestPeer(joinOnlineRoom(host.session.roomId, 'q3g2'), 'q3-g2');
      const g3 = new TestPeer(joinOnlineRoom(host.session.roomId, 'q3g3'), 'q3-g3');
      activePeers.push(host, g1, g2, g3);
      await Promise.all([g1, g2, g3].map((g) => g.waitFor((m) => m.t === 'welcome')));
      await seatAll(host, [g1, g2, g3]);
      host.session.send({ t: 'settings', settings: { years: 1, turnSeconds: 20 } });
      const started = [host, g1, g2, g3].map((p) => p.waitFor((m) => m.t === 'update'));
      host.session.send({ t: 'start' });
      await Promise.all(started);

      // Kill host: g1 promotes, g2/g3 may rotate brokers during host silence.
      warn.mockClear();
      killSessionForTests(host.session);

      await waitUntil(
        () => {
          const s1 = netDebugSnapshotForTests(g1.session);
          const s2 = netDebugSnapshotForTests(g2.session);
          const s3 = netDebugSnapshotForTests(g3.session);
          return (
            s1?.role === 'host' &&
            s1.authority.ready === true &&
            s1.authority.promotionConfirmed === true &&
            s1.mirrors.length === 2 &&
            (s2?.mirrors.length ?? 0) >= 1 &&
            (s3?.mirrors.length ?? 0) >= 1 &&
            s2?.applied?.gen === s1.generation &&
            s3?.applied?.gen === s1.generation
          );
        },
        15_000,
        'promoted host confirms without false quorum-lost flap and guests retain mirror brokers',
        () => ({
          g1: netDebugSnapshotForTests(g1.session),
          g2: netDebugSnapshotForTests(g2.session),
          g3: netDebugSnapshotForTests(g3.session),
        }),
      );

      // Healthy migration must NOT have logged a spurious `host quorum lost (1/3)`!
      const quorumLostLogs = warn.mock.calls
        .map((args) => String(args[0] ?? ''))
        .filter((text) => text.includes('host quorum lost'));
      expect(quorumLostLogs).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  }, 45_000);

  it('repro 1c: host stall watchdog forces deadline to now with prominent warning when hitting maxHostStallRearms', async () => {
    const broker = await startBroker();
    activeBrokers.push(broker);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      configureNetworkForTests({
        brokers: [broker.url],
        disableWebRtc: true,
        connectTimeoutMs: 2_000,
        heartbeatMs: 120,
        hostSilenceMs: 10_000,
        peerSilenceMs: 10_000,
        saveThrottleMs: 20,
        graceMs: 30_000,
        replaceMs: 60_000,
        yearEndAckMs: 30_000,
        cpuDelayMs: 80,
        fxScale: 0.01,
        hostStallExtraMs: 250,
        maxHostStallRearms: 2,
        clientIds: { sfh: 'sf-host', sfg: 'sf-guest' },
      });

      const host = new TestPeer(await createOnlineRoom('sfh'), 'sf-host');
      const guest = new TestPeer(joinOnlineRoom(host.session.roomId, 'sfg'), 'sf-guest');
      activePeers.push(host, guest);
      await guest.waitFor((m) => m.t === 'welcome');
      await seatAll(host, [guest]);
      host.session.send({ t: 'settings', settings: { years: 1, turnSeconds: 20 } });
      const started = [host, guest].map((p) => p.waitFor((m) => m.t === 'update'));
      host.session.send({ t: 'start' });
      await Promise.all(started);

      const stalledSeq = host.seq;
      const startAt = Date.now();
      // First wipe: stall watchdog rearm 1/2 restores the turn task (without expiring 20s deadline).
      clearRoomTasksForTests(host.session);
      await waitUntil(
        () => warn.mock.calls.some((args) => String(args[0] ?? '').includes('rearm 1/2')),
        4_000,
        'host stall watchdog runs rearm 1/2',
        () => netDebugSnapshotForTests(host.session),
      );
      expect(host.seq).toBe(stalledSeq);

      // Second wipe: hitting maxHostStallRearms (2/2) MUST emit [STALL-FORCE] and expire deadline NOW!
      clearRoomTasksForTests(host.session);
      await waitUntil(
        () => host.seq > stalledSeq && guest.seq > stalledSeq,
        5_000,
        'host stall watchdog forces deadline expiry at maxHostStallRearms',
        () => ({ elapsed: Date.now() - startAt, host: netDebugSnapshotForTests(host.session) }),
      );
      expect(Date.now() - startAt).toBeLessThan(10_000);
      expect(
        warn.mock.calls.some((args) => String(args[0] ?? '').includes('[STALL-FORCE]')),
      ).toBe(true);
      expect(host.history.some((m) => m.t === 'system' && m.text.includes('時間切れ'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  }, 30_000);
});
