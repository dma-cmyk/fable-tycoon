import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:net';
import type { Server as NetServer } from 'node:net';
import process from 'node:process';
import { Aedes } from 'aedes';
import type { Action, GameState } from '../core/types';
import { actorOf, cpuDecide } from '../core/engine';
import { GAME_DATA } from '../data/index';
import { MqttTransport } from './p2p/transport';
import { generateIdentity } from './p2p/identity';
import { PROTOCOL_VERSION } from './protocol';
import type { PublicState, ServerMsg } from './protocol';
import type { Session } from './session-types';
import {
  checkpointHostForTests,
  configureNetworkForTests,
  isNewerStateOrder,
  createOnlineRoom,
  joinOnlineRoom,
  killSessionForTests,
  resumeHostForTests,
  roomExists,
  transportInfo,
} from './online-session';

const PUBLIC = process.env.FABLE_PUBLIC_BROKER === '1';
const PROFILE = ['momotaro', 'alice', 'sinbad', 'red_hood'];

interface Waiter {
  test: (msg: ServerMsg) => boolean;
  resolve: (msg: ServerMsg) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** A browser tab as seen by the game: Session + optional auto-play driving cpuDecide. */
class Peer {
  readonly session: Session;
  readonly label: string;
  state: PublicState | null = null;
  seq = 0;
  seat: number | null = null;
  lastSentSeq = -1;
  history: ServerMsg[] = [];
  onState: ((state: PublicState, seq: number) => void) | null = null;
  private waiters: Waiter[] = [];
  private readonly autoPlay: boolean;

  constructor(session: Session, label: string, autoPlay: boolean) {
    this.session = session;
    this.label = label;
    this.autoPlay = autoPlay;
    session.subscribe((msg) => this.handle(msg));
  }

  waitFor(test: (msg: ServerMsg) => boolean, timeoutMs = 30_000, label = 'message'): Promise<ServerMsg> {
    for (const msg of this.history) {
      if (test(msg)) return Promise.resolve(msg);
    }
    return this.waitForNew(test, timeoutMs, label);
  }

  waitForNew(test: (msg: ServerMsg) => boolean, timeoutMs = 30_000, label = 'message'): Promise<ServerMsg> {
    const { promise, resolve, reject } = Promise.withResolvers<ServerMsg>();
    const waiter: Waiter = {
      test,
      resolve,
      reject,
      timer: setTimeout(() => {
        this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
        reject(
          new Error(
            `${this.label}: timed out waiting for ${label} (seq ${this.seq}, seat ${String(this.seat)}, phase ${String(this.state?.phase.t)})`,
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
      waiter.reject(new Error(`${this.label}: session killed`));
    }
    this.waiters = [];
  }

  private handle(msg: ServerMsg): void {
    this.history.push(msg);
    if (this.history.length > 4_000) this.history.splice(0, this.history.length - 4_000);
    if (msg.t === 'welcome') {
      this.seat = msg.seat;
      this.lastSentSeq = -1;
    }
    if (msg.t === 'snapshot' || msg.t === 'update') {
      this.state = msg.state;
      this.seq = msg.seq;
      this.onState?.(msg.state, msg.seq);
      if (this.autoPlay && this.seat !== null && msg.state.phase.t !== 'game_over') {
        const actor = actorOf(msg.state);
        if (actor === this.seat && this.lastSentSeq !== msg.seq) {
          this.lastSentSeq = msg.seq;
          const action: Action = cpuDecide(GAME_DATA, msg.state as GameState);
          this.session.send({ t: 'action', seq: msg.seq, action });
        }
      }
    }
    const matching = this.waiters.filter((waiter) => waiter.test(msg));
    this.waiters = this.waiters.filter((waiter) => !matching.includes(waiter));
    for (const waiter of matching) {
      clearTimeout(waiter.timer);
      waiter.resolve(msg);
    }
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { promise, resolve };
}

async function takeSeats(host: Peer, peers: Peer[], firstSeat: number): Promise<void> {
  for (let index = 0; index < peers.length; index += 1) {
    const seatIndex = firstSeat + index;
    const peer = peers[index];
    const welcome = peer.waitForNew(
      (msg) => msg.t === 'welcome' && msg.seat === seatIndex,
      20_000,
      'seat welcome',
    );
    peer.session.send({ t: 'take_seat', index: seatIndex });
    await welcome;
    peer.session.send({ t: 'pick_character', characterId: PROFILE[seatIndex] });
  }
  await host.waitFor(
    (msg) =>
      msg.t === 'lobby' &&
      msg.lobby.seats.slice(0, firstSeat + peers.length).every((seat) => seat.characterId !== null),
    30_000,
    'host seats ready',
  );
}

describe('online P2P over an in-process MQTT broker', () => {
  let broker: Aedes;
  let netServer: NetServer;
  let brokerPort = 0;
  const active: Peer[] = [];

  beforeAll(async () => {
    broker = await Aedes.createBroker({ heartbeatInterval: 1_000 });
    netServer = createServer((socket) => broker.handle(socket));
    await new Promise<void>((resolve) => netServer.listen(0, '127.0.0.1', resolve));
    const address = netServer.address();
    if (typeof address !== 'object' || !address) throw new Error('broker did not bind');
    brokerPort = address.port;
    configureNetworkForTests({
      brokers: [`mqtt://127.0.0.1:${brokerPort}`],
      disableWebRtc: true,
      connectTimeoutMs: 2_000,
      heartbeatMs: 150,
      hostSilenceMs: 1_200,
      peerSilenceMs: 1_200,
      saveThrottleMs: 20,
      probeTimeoutMs: 4_000,
      graceMs: 300,
      replaceMs: 5_000,
      yearEndAckMs: 500,
      cpuDelayMs: 50,
      fxScale: 0.01,
      clientIds: {
        host: 'test-host',
        guest1: 'test-guest1',
        guest2: 'test-guest2',
        guest3: 'test-guest3',
        'guest2-rejoin': 'test-guest2',
        'smoke-host': 'smoke-host',
        'smoke-guest': 'smoke-guest',
      },
    });
  });

  afterAll(async () => {
    for (const peer of active) peer.stop();
    configureNetworkForTests({});
    await new Promise<void>((resolve) => netServer.close(() => resolve()));
    await new Promise<void>((resolve) => broker.close(() => resolve()));
  });

  it('plays a full year, survives a guest rejoin and host migration', async () => {
    const startedAt = Date.now();
    const hostSession = await createOnlineRoom('host');
    const host = new Peer(hostSession, 'host', true);
    active.push(host);
    expect(hostSession.mode).toBe('online');
    expect(hostSession.roomId).toMatch(/^[A-Z0-9]{6}-[A-Z0-9]{4}$/);
    expect(await roomExists(hostSession.roomId)).toBe(true);

    const hostWelcome = host.waitForNew((msg) => msg.t === 'welcome' && msg.seat === 0, 30_000, 'host seat welcome');
    hostSession.send({ t: 'take_seat', index: 0 });
    await hostWelcome;
    hostSession.send({ t: 'pick_character', characterId: PROFILE[0] });

    const guest1 = new Peer(joinOnlineRoom(hostSession.roomId, 'guest1'), 'guest1', true);
    let guest2 = new Peer(joinOnlineRoom(hostSession.roomId, 'guest2'), 'guest2', true);
    const guest3 = new Peer(joinOnlineRoom(hostSession.roomId, 'guest3'), 'guest3', true);
    active.push(guest1, guest2, guest3);
    await Promise.all([
      guest1.waitFor((msg) => msg.t === 'welcome', 30_000, 'guest welcome'),
      guest2.waitFor((msg) => msg.t === 'welcome', 30_000, 'guest welcome'),
      guest3.waitFor((msg) => msg.t === 'welcome', 30_000, 'guest welcome'),
    ]);
    await takeSeats(host, [guest1, guest2, guest3], 1);

    // A signed hello whose reconnect token does not match the signing key must not get a welcome.
    const rogue = new MqttTransport('rogue-key', {
      identity: await generateIdentity(),
      brokers: [`mqtt://127.0.0.1:${brokerPort}`],
      disableWebRtc: true,
      connectTimeoutMs: 2_000,
      log: () => {},
    });
    let rogueWelcomed = false;
    rogue.onMessage((_from, message) => {
      if ('t' in message && message.t === 'welcome') {
        rogueWelcomed = true;
      }
    });
    await rogue.connect(hostSession.roomId);
    await rogue.send('test-host', {
      t: 'hello',
      v: PROTOCOL_VERSION,
      roomId: hostSession.roomId,
      name: 'rogue',
      token: 'not-the-public-key',
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(rogueWelcomed).toBe(false);
    await rogue.close();

    hostSession.send({ t: 'settings', settings: { years: 1, turnSeconds: 0 } });
    const snapshots = [guest1, guest2, guest3].map((peer) =>
      peer.waitFor((msg) => msg.t === 'snapshot' || msg.t === 'update', 30_000, 'start state'),
    );
    hostSession.send({ t: 'start' });
    await Promise.all(snapshots);

    const killGuestGate = deferred();
    const killHostGate = deferred();
    const settled = Promise.withResolvers<PublicState>();
    let finished = false;
    let guest2Rejoined = false;
    let hostKilled = false;
    let hostCheckpoint: ReturnType<typeof checkpointHostForTests> = null;
    const gameTimeout = setTimeout(() => settled.reject(new Error('P2P game did not finish')), 60_000);

    function observe(peer: Peer): void {
      peer.onState = (state, seq) => {
        if (peer === guest2 && seq >= 12) killGuestGate.resolve();
        if (peer === guest1 && seq >= 30) killHostGate.resolve();
        if (finished || state.phase.t !== 'game_over') return;
        finished = true;
        clearTimeout(gameTimeout);
        settled.resolve(state);
      };
    }
    observe(guest1);
    observe(guest2);
    observe(guest3);

    const rejoin = (async () => {
      await killGuestGate.promise;
      if (finished) return;
      guest2.stop();
      guest2 = new Peer(joinOnlineRoom(hostSession.roomId, 'guest2-rejoin'), 'guest2b', true);
      active.push(guest2);
      observe(guest2);
      await guest2.waitForNew((msg) => msg.t === 'welcome' && msg.seat === 2, 30_000, 'rejoin welcome');
      await guest2.waitFor((msg) => msg.t === 'snapshot' || msg.t === 'update', 30_000, 'rejoin snapshot');
      guest2Rejoined = true;
    })();

    const killHost = (async () => {
      await rejoin;
      await killHostGate.promise;
      if (finished) return;
      hostCheckpoint = checkpointHostForTests(host.session);
      host.stop();
      hostKilled = true;
    })();

    await killHost;
    await rejoin;

    // Let the guests elect the next host before the old host comes back.
    await guest1.waitFor(
      (msg) => msg.t === 'lobby' && msg.lobby.seats.find((seat) => seat.isHost)?.index === 1,
      15_000,
      'new host elected',
    );

    // A returning old host must see the newer generation and step down to guest instead of
    // forking a second authoritative room.
    let returned: Peer | null = null;
    if (hostCheckpoint) {
      const returnedSession = resumeHostForTests(hostCheckpoint);
      returned = new Peer(returnedSession, 'returned-host', true);
      active.push(returned);
      await returned.waitFor(
        (msg) => msg.t === 'lobby' && msg.lobby.seats.find((seat) => seat.isHost)?.index === 1,
        20_000,
        'returned host sees generation 2',
      );
      expect(checkpointHostForTests(returnedSession)).toBeNull();
    }

    const finalState = await settled.promise;
    expect(hostCheckpoint).not.toBeNull();

    const remaining = [guest1, guest2, guest3];
    const finalSeen = remaining.map((peer) =>
      peer.waitFor(
        (msg) =>
          (msg.t === 'update' || msg.t === 'snapshot') && msg.state.phase.t === 'game_over',
        60_000,
        'final game_over state',
      ),
    );
    await Promise.all(finalSeen);

    expect(guest2Rejoined).toBe(true);
    expect(hostKilled).toBe(true);
    expect(finalState.phase.t).toBe('game_over');
    if (finalState.phase.t === 'game_over') expect(finalState.phase.ranking.length).toBe(4);

    const states = remaining.map((peer) => JSON.stringify(peer.state));
    expect(states[0]).toBe(states[1]);
    expect(states[0]).toBe(states[2]);

    for (const peer of remaining) {
      const seqs = peer.history
        .filter((msg): msg is Extract<ServerMsg, { t: 'update' }> => msg.t === 'update')
        .map((msg) => msg.seq);
      for (let i = 1; i < seqs.length; i += 1) expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }

    const rankings = remaining.map((peer) => {
      const state = peer.state;
      return state && state.phase.t === 'game_over' ? state.phase.ranking.join(',') : '';
    });
    expect(new Set(rankings).size).toBe(1);
    expect(rankings[0].split(',')).toHaveLength(4);

    // Seat 1 (guest1) is the lowest connected human seat and must have adopted the room.
    const lobby = guest1.session.lobby();
    expect(lobby?.seats.find((seat) => seat.isHost)?.index).toBe(1);
    const info = transportInfo(guest1.session);
    expect(info.broker).toContain(`127.0.0.1:${brokerPort}`);
    expect(info.p2pPeers).toBe(0); // Node tests intentionally run relay-only

    const elapsed = Date.now() - startedAt;
    console.log(`[p2p-e2e] 1-year 3-guest game (host migrated) in ${elapsed}ms, final seq ${guest1.seq}`);
  }, 90_000);

  it('orders host state by generation then seq', () => {
    expect(isNewerStateOrder(1, 5, 1, 5)).toBe(false);
    expect(isNewerStateOrder(1, 5, 1, 4)).toBe(false);
    expect(isNewerStateOrder(1, 5, 1, 6)).toBe(true);
    expect(isNewerStateOrder(1, 999, 2, 1)).toBe(true);
    expect(isNewerStateOrder(2, 1, 1, 999)).toBe(false);
  });

  it.skipIf(!PUBLIC)('smoke: public brokers accept an encrypted room', async () => {
    configureNetworkForTests({});
    const host = await createOnlineRoom('smoke-host');
    const guest = joinOnlineRoom(host.roomId, 'smoke-guest');
    const peer = new Peer(guest, 'smoke-guest', false);
    try {
      await peer.waitFor(
        (msg) => msg.t === 'welcome',
        45_000,
      );
      expect(peer.seat).toBeNull();
      expect(await roomExists(host.roomId)).toBe(true);
    } finally {
      peer.stop();
      killSessionForTests(host);
    }
  }, 90_000);
});