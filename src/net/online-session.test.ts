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
import type { P2PControl } from './p2p/transport';
import type { PublicState, ServerMsg } from './protocol';
import type { Session } from './session-types';
import {
  appendReportEvidence,
  authorityInfoForTests,
  bumpGenerationForTests,
  onlineSaveIssue,
  hostKeyFingerprintForSession,
  resumeOnline,
  verifiedSuccessorForRoom,
  checkpointHostForTests,
  configureNetworkForTests,
  exportReports,
  isNewerStateOrder,
  createOnlineRoom,
  joinOnlineRoom,
  killSessionForTests,
  resumeHostForTests,
  reportVotesForTests,
  resyncPeerForTests,
  roomExists,
  setBlockedPeersForTests,
  setNetworkPartitionForTests,
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
  lastRejectedSeq = -1;
  /** Generation of the last state applied; a change re-arms the action (the UI re-derives). */
  gen = 0;
  history: ServerMsg[] = [];
  onState: ((state: PublicState, seq: number) => void) | null = null;
  private waiters: Waiter[] = [];
  autoPlay: boolean;

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

  kickAutoPlay(): void {
    if (!this.autoPlay || !this.state || this.seat === null || this.state.phase.t === 'game_over') return;
    const actor = actorOf(this.state);
    if (actor !== this.seat || this.lastSentSeq === this.seq) return;
    this.lastSentSeq = this.seq;
    this.session.send({ t: 'action', seq: this.seq, action: cpuDecide(GAME_DATA, this.state as GameState) });
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
    if (msg.t === 'error' && msg.code === 'stale' && this.lastSentSeq === this.seq) {
      // A soft rejection (authority switch / stale screen) re-opens the turn, exactly like the
      // UI re-rendering its action buttons. Retry once per seq so a real loop stays visible.
      if (this.lastRejectedSeq !== this.seq) {
        this.lastRejectedSeq = this.seq;
        this.lastSentSeq = -1;
        queueMicrotask(() => this.kickAutoPlay());
      }
    }
    if (this.history.length > 4_000) this.history.splice(0, this.history.length - 4_000);
    if (msg.t === 'welcome') {
      this.seat = msg.seat;
      this.lastSentSeq = -1;
    }
    if (msg.t === 'snapshot' || msg.t === 'update') {
      const gen = msg.gen ?? 1;
      if (gen !== this.gen) {
        this.gen = gen;
        this.lastSentSeq = -1; // a new authority generation re-opens the current turn
        this.lastRejectedSeq = -1;
      }
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

async function waitUntil(
  condition: () => boolean,
  timeoutMs: number,
  label: string,
  tick?: () => void,
): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    if (condition()) return;
    if (Date.now() - startedAt > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    tick?.();
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Act like a human at the controls: keep offering the current turn's action while we wait. */
async function waitForMsgWithPump(
  peer: Peer,
  test: (msg: ServerMsg) => boolean,
  peers: readonly Peer[],
  timeoutMs: number,
  label: string,
): Promise<ServerMsg> {
  const timer = setInterval(() => {
    for (const candidate of peers) candidate.kickAutoPlay();
  }, 100);
  try {
    return await peer.waitForNew(test, timeoutMs, label);
  } finally {
    clearInterval(timer);
  }
}

function pumpActions(peers: readonly Peer[]): () => void {
  return () => {
    for (const peer of peers) peer.kickAutoPlay();
  };
}

/** All peers agree on one host, and the peer that is host reports authority ready. */
function everyonesAuthorityIsReady(peers: readonly Peer[]): boolean {
  const hostSeats = peers.map(
    (peer) => peer.session.lobby()?.seats.find((seat) => seat.isHost)?.index ?? null,
  );
  if (new Set(hostSeats).size !== 1 || hostSeats[0] === null) return false;
  return peers.every((peer) => {
    if (peer.seat !== hostSeats[0]) return true;
    return authorityInfoForTests(peer.session)?.frozen === false;
  });
}

interface IsolatedBroker {
  url: string;
  close: () => Promise<void>;
}

/** A dedicated broker per test removes cross-test packet/timer interference on slow CI. */
/** Re-apply the suite-wide shared broker config (isolated-broker tests must restore it). */
function restoreSharedNetwork(brokerPort: number): void {
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
      'late-host': 'late-host',
      'late-guest': 'late-guest',
      'resync-host': 'resync-host',
      'resync-guest': 'resync-guest',
    },
  });
}

async function startIsolatedBroker(): Promise<IsolatedBroker> {
  const broker = await Aedes.createBroker({ heartbeatInterval: 1_000 });
  const sockets = new Set<import('node:net').Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    broker.handle(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (typeof address !== 'object' || !address) throw new Error('isolated broker did not bind');
  let closed = false;
  return {
    url: `mqtt://127.0.0.1:${address.port}`,
    close: async () => {
      if (closed) return;
      closed = true;
      // Kill live sockets first: server.close() waits for them, and MQTT clients reconnect forever.
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await new Promise<void>((resolve) => broker.close(() => resolve()));
    },
  };
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

async function createSplitRoom(
  hostName: string,
  guestNames: [string, string, string],
): Promise<{ host: Peer; guests: [Peer, Peer, Peer]; roomId: string }> {
  const hostSession = await createOnlineRoom(hostName);
  const host = new Peer(hostSession, hostName, true);
  const guests = [
    new Peer(joinOnlineRoom(hostSession.roomId, guestNames[0]), guestNames[0], true),
    new Peer(joinOnlineRoom(hostSession.roomId, guestNames[1]), guestNames[1], true),
    new Peer(joinOnlineRoom(hostSession.roomId, guestNames[2]), guestNames[2], true),
  ] as [Peer, Peer, Peer];
  active.push(host, ...guests);
  await Promise.all(guests.map((peer) => peer.waitFor((msg) => msg.t === 'welcome')));
  const hostWelcome = host.waitForNew((msg) => msg.t === 'welcome' && msg.seat === 0);
  hostSession.send({ t: 'take_seat', index: 0 });
  await hostWelcome;
  hostSession.send({ t: 'pick_character', characterId: 'momotaro' });
  await takeSeats(host, guests, 1);
  hostSession.send({ t: 'settings', settings: { years: 10, turnSeconds: 0 } });
  const started = [host, ...guests].map((peer) =>
    peer.waitFor((msg) => msg.t === 'snapshot' || msg.t === 'update', 20_000, 'split start'),
  );
  hostSession.send({ t: 'start' });
  await Promise.all(started);
  return { host, guests, roomId: hostSession.roomId };
}


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

    // A competing host claim signed by a key that is not pinned to a known seat must be ignored.
    const rogueHost = new MqttTransport('rogue-host', {
      identity: await generateIdentity(),
      brokers: [`mqtt://127.0.0.1:${brokerPort}`],
      disableWebRtc: true,
      connectTimeoutMs: 2_000,
      log: () => {},
    });
    await rogueHost.connect(hostSession.roomId);
    const lobbyNow = guest1.session.lobby();
    if (lobbyNow) {
      const claim: P2PControl = {
        k: 'host',
        hostPeerId: 'rogue-host',
        seat: 1,
        hostSeat: 1,
        seatKeys: { ...lobbyNow.seats.reduce<Record<string, string>>((acc, seat) => { acc[String(seat.index)] = 'rogue-key'; return acc; }, {}) },
        reportVotes: {},
        lobby: lobbyNow,
        seq: 99999,
        gen: 99,
        connectedHumans: 4,
        stateHash: 'deadbeef',
        broker: null,
        at: Date.now(),
      };
      await rogueHost.send('test-guest1', claim);
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(guest1.session.lobby()?.seats.find((seat) => seat.isHost)?.index).toBe(0);
    }
    await rogueHost.close();

    const killGuestGate = deferred();
    const killHostGate = deferred();
    const settled = Promise.withResolvers<PublicState>();
    let finished = false;
    let guest2Rejoined = false;
    let hostKilled = false;
    let hostCheckpoint: ReturnType<typeof checkpointHostForTests> = null;
    const gameTimeout = setTimeout(() => settled.reject(new Error('P2P game did not finish')), 150_000);

    function observe(peer: Peer): void {
      peer.onState = (state, seq) => {
        if (peer === guest2 && seq >= 12) killGuestGate.resolve();
        if (finished || state.phase.t !== 'game_over') return;
        finished = true;
        clearTimeout(gameTimeout);
        killGuestGate.resolve();
        killHostGate.resolve();
        settled.resolve(state);
      };
    }
    observe(guest1);
    observe(guest2);
    observe(guest3);

    // Kill the host while it is the current actor in choose_dest (the browser failure case),
    // only after guest2 has finished rejoining so disabling host.autoPlay cannot deadlock rejoin.
    host.onState = (state) => {
      if (guest2Rejoined && state.current === 0 && state.phase.t === 'choose_dest') {
        host.autoPlay = false;
        killHostGate.resolve();
      }
    };

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

    await guest1.waitFor(
      (msg) =>
        msg.t === 'lobby' &&
        msg.lobby.seats.find((seat) => seat.isHost)?.index === 1 &&
        [1, 2, 3].every((seatIndex) => msg.lobby.seats[seatIndex]?.connected === true),
      15_000,
      'all guests rebound to the new host',
    );
    // The old host seat must be driven by the new host's grace/CPU path even if the old host
    // never comes back. Wait for a state advance before resuming it.
    await waitForMsgWithPump(
      guest1,
      (msg) => msg.t === 'lobby' && msg.lobby.seats[0].kind === 'cpu',
      [guest1, guest2, guest3],
      60_000,
      'old host seat replaced by CPU',
    );
    const seqAfterMigration = guest1.seq;
    await waitForMsgWithPump(
      guest1,
      (msg) => (msg.t === 'update' || msg.t === 'snapshot') && msg.seq > seqAfterMigration,
      [guest1, guest2, guest3],
      60_000,
      'game advances without old host',
    );
    const authority = authorityInfoForTests(guest1.session);
    expect(authority?.ready).toBe(true);
    expect(authority?.requiredAcks).toBeGreaterThanOrEqual(1);
    expect(authority?.acks).toBeGreaterThanOrEqual(authority?.requiredAcks ?? 0);

    const finalState = await settled.promise;
    expect(hostCheckpoint).not.toBeNull();

    // A returning old host must see the newer generation and step down to guest instead of
    // forking a second authoritative room. Resume only after the migrated game is over so its
    // local controller cannot race the live room.
    let returned: Peer | null = null;
    if (hostCheckpoint) {
      const returnedSession = resumeHostForTests(hostCheckpoint);
      returned = new Peer(returnedSession, 'returned-host', false);
      active.push(returned);
      await returned.waitFor(
        (msg) =>
          (msg.t === 'welcome' || msg.t === 'lobby' || msg.t === 'snapshot') &&
          msg.lobby.seats.find((seat) => seat.isHost)?.index === 1,
        20_000,
        'returned host sees generation 2',
      );
      expect(checkpointHostForTests(returnedSession)).toBeNull();
    }

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
      for (const msg of peer.history) {
        if (msg.t === 'snapshot' || msg.t === 'update') expect(msg.gen).toBeGreaterThanOrEqual(1);
      }
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
    expect([1, 2, 3].every((seatIndex) => lobby?.seats[seatIndex].connected === true)).toBe(true);
    const info = transportInfo(guest1.session);
    expect(info.broker).toContain(`127.0.0.1:${brokerPort}`);
    expect(info.p2pPeers).toBe(0); // Node tests intentionally run relay-only

    const elapsed = Date.now() - startedAt;
    console.log(`[p2p-e2e] 1-year 3-guest game (host migrated) in ${elapsed}ms, final seq ${guest1.seq}`);
  }, 400_000);

  it('does not fork the room from a minority partition and rejoins on heal', async () => {
    for (const peer of active) peer.stop();
    active.length = 0;
    const iso = await startIsolatedBroker();
    try {
      configureNetworkForTests({
        brokers: [iso.url],
        disableWebRtc: true,
        connectTimeoutMs: 2_000,
        heartbeatMs: 150,
        hostSilenceMs: 800,
        peerSilenceMs: 3_000,
        probeMs: 250,
        hostGoneMs: 2_500,
        selfHostGraceMs: 800,
        saveThrottleMs: 20,
        probeTimeoutMs: 4_000,
        graceMs: 120_000,
        replaceMs: 120_000,
        yearEndAckMs: 120_000,
        cpuDelayMs: 50,
        fxScale: 0.01,
        clientIds: {
          confhost: 'conf-host',
          conf1: 'conf-p1',
          conf2: 'conf-p2',
          conf3: 'conf-p3',
        },
      });

      const hostSession = await createOnlineRoom('confhost');
      const host = new Peer(hostSession, 'conf-host', true);
      const guest1 = new Peer(joinOnlineRoom(hostSession.roomId, 'conf1'), 'conf1', true);
      const guest2 = new Peer(joinOnlineRoom(hostSession.roomId, 'conf2'), 'conf2', true);
      const guest3 = new Peer(joinOnlineRoom(hostSession.roomId, 'conf3'), 'conf3', true);
      active.push(host, guest1, guest2, guest3);
      await Promise.all([
        guest1.waitFor((msg) => msg.t === 'welcome'),
        guest2.waitFor((msg) => msg.t === 'welcome'),
        guest3.waitFor((msg) => msg.t === 'welcome'),
      ]);
      const hostWelcome = host.waitForNew((msg) => msg.t === 'welcome' && msg.seat === 0);
      hostSession.send({ t: 'take_seat', index: 0 });
      await hostWelcome;
      hostSession.send({ t: 'pick_character', characterId: 'momotaro' });
      await takeSeats(host, [guest1, guest2, guest3], 1);
      hostSession.send({ t: 'settings', settings: { years: 10, turnSeconds: 0 } });
      const started = [guest1, guest2, guest3].map((peer) =>
        peer.waitFor((msg) => msg.t === 'snapshot' || msg.t === 'update', 20_000, 'conflict start'),
      );
      hostSession.send({ t: 'start' });
      await Promise.all(started);

      // A guest that is cut off from everyone is a MINORITY (1 of 4). It must never promote itself
      // and fork the room; it keeps searching for the real authority instead.
      guest3.autoPlay = false;
      setNetworkPartitionForTests(guest3.session, true);
      await new Promise((resolve) => setTimeout(resolve, 6_000));
      expect(guest3.session.lobby()?.seats.find((seat) => seat.isHost)?.index).toBe(0);
      expect(authorityInfoForTests(guest3.session)?.frozen).not.toBe(true);

      setNetworkPartitionForTests(guest3.session, false);
      const before = guest3.seq;
      await waitForMsgWithPump(
        guest3,
        (msg) => (msg.t === 'update' || msg.t === 'snapshot') && msg.seq > before,
        [host, guest1, guest2, guest3],
        45_000,
        'isolated guest rejoins the real authority after heal',
      );
      guest3.autoPlay = true;
      expect(guest3.session.lobby()?.seats[3].connected).toBe(true);
      expect(checkpointHostForTests(guest3.session)).toBeNull();
    } finally {
      for (const peer of active) peer.stop();
      active.length = 0;
      await iso.close();
      restoreSharedNetwork(brokerPort);
    }
  }, 180_000);

  it('appends report evidence without overwriting it', () => {
    const data = new Map<string, string>([['fable.reports', '[{"old":1}]']]);
    const storage = {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => {
        data.set(key, String(value));
      },
      removeItem: (key: string) => {
        data.delete(key);
      },
    };
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', {
      value: { localStorage: storage, sessionStorage: storage },
      configurable: true,
    });
    try {
      appendReportEvidence({ new: 1 });
      const stored: unknown = JSON.parse(exportReports());
      expect(Array.isArray(stored) ? stored.length : 0).toBe(2);
      expect(stored).toEqual([{ old: 1 }, { new: 1 }]);
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'window', descriptor);
      else Reflect.deleteProperty(globalThis, 'window');
    }
  });

  it('delivers a stateful snapshot to a late subscriber before any fx', async () => {
    const hostSession = await createOnlineRoom('late-host');
    const host = new Peer(hostSession, 'late-host', false);
    const guest = new Peer(joinOnlineRoom(hostSession.roomId, 'late-guest'), 'late-guest', false);
    active.push(host, guest);
    try {
      await guest.waitFor((msg) => msg.t === 'welcome');
      const hostWelcome = host.waitForNew((msg) => msg.t === 'welcome' && msg.seat === 0);
      hostSession.send({ t: 'take_seat', index: 0 });
      await hostWelcome;
      hostSession.send({ t: 'pick_character', characterId: 'momotaro' });
      const guestWelcome = guest.waitForNew((msg) => msg.t === 'welcome' && msg.seat === 1);
      guest.session.send({ t: 'take_seat', index: 1 });
      await guestWelcome;
      guest.session.send({ t: 'pick_character', characterId: 'alice' });
      hostSession.send({ t: 'settings', settings: { years: 1, turnSeconds: 0 } });
      const started = guest.waitFor((msg) => msg.t === 'update', 15_000, 'start update');
      hostSession.send({ t: 'start' });
      const firstUpdate = await started;
      expect(firstUpdate.t).toBe('update');

      // A newly opened GameScreen subscribes after several updates: it must receive the board
      // (a snapshot carrying state) before anything else, not an fx-bearing update alone.
      const late: ServerMsg[] = [];
      const unsubscribe = guest.session.subscribe((msg) => late.push(msg));
      try {
        const stateful = late.find((msg) => msg.t === 'snapshot' || msg.t === 'update');
        expect(stateful?.t).toBe('snapshot');
        if (stateful?.t === 'snapshot') {
          expect(stateful.state.phase.t).not.toBe('game_over');
          expect(stateful.seq).toBe(guest.seq);
          expect(stateful.resync).toBe(true);
        }
        expect(late.some((msg) => msg.t === 'update')).toBe(false);
      } finally {
        unsubscribe();
      }
    } finally {
      host.stop();
      guest.stop();
    }
  }, 30_000);

  it('delivers same-seq resync snapshots to guests', async () => {
    const hostSession = await createOnlineRoom('resync-host');
    const host = new Peer(hostSession, 'resync-host', false);
    const guest = new Peer(joinOnlineRoom(hostSession.roomId, 'resync-guest'), 'resync-guest', false);
    active.push(host, guest);
    try {
      await guest.waitFor((msg) => msg.t === 'welcome');
      const hostWelcome = host.waitForNew((msg) => msg.t === 'welcome' && msg.seat === 0);
      hostSession.send({ t: 'take_seat', index: 0 });
      await hostWelcome;
      hostSession.send({ t: 'pick_character', characterId: 'momotaro' });
      const guestWelcome = guest.waitForNew((msg) => msg.t === 'welcome' && msg.seat === 1);
      guest.session.send({ t: 'take_seat', index: 1 });
      await guestWelcome;
      guest.session.send({ t: 'pick_character', characterId: 'alice' });
      guest.session.send({ t: 'report', seat: 0, reason: 'spam' });
      for (let i = 0; i < 40; i += 1) {
        if ((reportVotesForTests(guest.session)?.['0']?.length ?? 0) > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(reportVotesForTests(guest.session)?.['0']?.length).toBeGreaterThan(0);
      hostSession.send({ t: 'settings', settings: { years: 1, turnSeconds: 0 } });
      const started = guest.waitFor((msg) => msg.t === 'update', 15_000, 'start update');
      hostSession.send({ t: 'start' });
      const update = await started;
      expect(update.t).toBe('update');

      const snapshotBefore = guest.history.filter((msg) => msg.t === 'snapshot').length;
      // Ask the host to resend the same (gen, seq) snapshot: the session must deliver it.
      const replay = guest.waitFor(
        (msg) => msg.t === 'snapshot' && msg.resync === true,
        10_000,
        'resync snapshot',
      );
      resyncPeerForTests(hostSession, 'resync-guest');
      await replay;
      expect(guest.history.filter((msg) => msg.t === 'snapshot').length).toBeGreaterThanOrEqual(
        snapshotBefore + 1,
      );
    } finally {
      host.stop();
      guest.stop();
    }
  }, 30_000);

  it('freezes both sides of a 2/2 split until heal', async () => {
    for (const peer of active) peer.stop();
    active.length = 0;
    const iso = await startIsolatedBroker();
    try {
      configureNetworkForTests({
        brokers: [iso.url],
        disableWebRtc: true,
        connectTimeoutMs: 2_000,
        heartbeatMs: 150,
        hostSilenceMs: 800,
        peerSilenceMs: 3_000,
        probeMs: 250,
        hostGoneMs: 2_500,
        selfHostGraceMs: 800,
        saveThrottleMs: 20,
        probeTimeoutMs: 4_000,
        graceMs: 120_000,
        replaceMs: 120_000,
        yearEndAckMs: 120_000,
        cpuDelayMs: 50,
        fxScale: 0.01,
        clientIds: {
          s2host: 's2-host',
          s2a: 's2-a',
          s2b: 's2-b',
          s2c: 's2-c',
        },
      });
      const { host, guests } = await createSplitRoom('s2host', ['s2a', 's2b', 's2c']);
      const everyone = [host, ...guests];
      const pump = pumpActions(everyone);
      setBlockedPeersForTests(host.session, ['s2-b', 's2-c']);
      setBlockedPeersForTests(guests[0].session, ['s2-b', 's2-c']);
      setBlockedPeersForTests(guests[1].session, ['s2-host', 's2-a']);
      setBlockedPeersForTests(guests[2].session, ['s2-host', 's2-a']);
      // Explicit event instead of a fixed settling time: the host must lose its majority.
      await waitUntil(
        () => authorityInfoForTests(host.session)?.frozen === true,
        30_000,
        'host frozen by the 2/2 split',
        pump,
      );

      const hostSeq = host.seq;
      const frozenSeqs = everyone.map((peer) => peer.seq);
      // No side may advance during the split: a 2/2 partition has no strict majority anywhere.
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      everyone.forEach((peer, index) => {
        expect(peer.seq).toBeLessThanOrEqual(frozenSeqs[index] + 1);
      });

      for (const peer of everyone) setBlockedPeersForTests(peer.session, []);
      // Explicit authority resolution: all clients agree on one host and it is not frozen.
      await waitUntil(
        () => {
          const hostSeats = everyone.map(
            (peer) => peer.session.lobby()?.seats.find((seat) => seat.isHost)?.index ?? null,
          );
          const agreed = new Set(hostSeats);
          if (agreed.size !== 1 || hostSeats[0] === null) return false;
          return everyonesAuthorityIsReady(everyone);
        },
        60_000,
        'single authority after 2/2 heal',
        pump,
      );
      // ... and then a real turn must advance under that authority.
      await waitForMsgWithPump(
        host,
        (msg) => (msg.t === 'update' || msg.t === 'snapshot') && msg.seq > hostSeq,
        everyone,
        45_000,
        'game resumes after 2/2 heal',
      );
    } finally {
      for (const peer of active) peer.stop();
      active.length = 0;
      await iso.close();
      restoreSharedNetwork(brokerPort);
    }
  }, 150_000);

  it('keeps the 3-person side authoritative during a 3/1 split', async () => {
    for (const peer of active) peer.stop();
    active.length = 0;
    const iso = await startIsolatedBroker();
    try {
      configureNetworkForTests({
        brokers: [iso.url],
        disableWebRtc: true,
        connectTimeoutMs: 2_000,
        heartbeatMs: 150,
        hostSilenceMs: 800,
        peerSilenceMs: 3_000,
        probeMs: 250,
        hostGoneMs: 2_500,
        selfHostGraceMs: 800,
        saveThrottleMs: 20,
        probeTimeoutMs: 4_000,
        graceMs: 120_000,
        replaceMs: 120_000,
        yearEndAckMs: 120_000,
        cpuDelayMs: 50,
        fxScale: 0.01,
        clientIds: {
          s3host: 's3-host',
          s3a: 's3-a',
          s3b: 's3-b',
          s3c: 's3-c',
        },
      });
      const { host, guests } = await createSplitRoom('s3host', ['s3a', 's3b', 's3c']);
      const everyone = [host, ...guests];
      const pump = pumpActions(everyone);
      setBlockedPeersForTests(host.session, ['s3-c']);
      setBlockedPeersForTests(guests[0].session, ['s3-c']);
      setBlockedPeersForTests(guests[1].session, ['s3-c']);
      setBlockedPeersForTests(guests[2].session, ['s3-host', 's3-a', 's3-b']);
      // The 3-person side keeps a strict majority, so it must keep advancing the game.
      const majoritySeq = host.seq;
      await waitForMsgWithPump(
        host,
        (msg) => msg.t === 'update' && msg.seq > majoritySeq,
        everyone,
        45_000,
        'majority side keeps playing',
      );
      expect(authorityInfoForTests(host.session)?.frozen).toBe(false);
      // The isolated seat stops advancing (it has no majority).
      const isolatedSeq = guests[2].seq;
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(guests[2].seq).toBeLessThanOrEqual(isolatedSeq + 1);
      for (const peer of everyone) setBlockedPeersForTests(peer.session, []);
      const isolatedBefore = guests[2].seq;
      await waitUntil(
        () => everyonesAuthorityIsReady(everyone),
        60_000,
        'single authority after 3/1 heal',
        pump,
      );
      await waitForMsgWithPump(
        guests[2],
        (msg) => (msg.t === 'update' || msg.t === 'snapshot') && msg.seq > isolatedBefore,
        everyone,
        45_000,
        'isolated seat rejoins the live updates',
      );
      const healedLobby = host.session.lobby();
      expect([1, 2, 3].every((i) => healedLobby?.seats[i].connected === true)).toBe(true);
    } finally {
      for (const peer of active) peer.stop();
      active.length = 0;
      await iso.close();
      restoreSharedNetwork(brokerPort);
    }
  }, 150_000);

  it('keeps a guest on one broker connected across host migration (host mirrors)', async () => {
    for (const peer of active) peer.stop();
    active.length = 0;
    const brokerA = await startIsolatedBroker();
    const brokerB = await startIsolatedBroker();
    try {
      const base = {
        disableWebRtc: true,
        connectTimeoutMs: 2_000,
        heartbeatMs: 150,
        hostSilenceMs: 1_200,
        peerSilenceMs: 3_000,
        probeMs: 250,
        hostGoneMs: 3_000,
        selfHostGraceMs: 1_000,
        saveThrottleMs: 20,
        probeTimeoutMs: 4_000,
        graceMs: 300,
        replaceMs: 120_000,
        yearEndAckMs: 120_000,
        cpuDelayMs: 50,
        fxScale: 0.01,
      } as const;
      // Host and the future host can reach BOTH brokers; the B-only guest can reach just one.
      configureNetworkForTests({
        ...base,
        brokers: [brokerA.url, brokerB.url],
        clientIds: { blendhost: 'blend-host', blenda: 'blend-a', blendb: 'blend-b' },
      });
      const hostSession = await createOnlineRoom('blendhost');
      const host = new Peer(hostSession, 'blend-host', true);
      const guestA = new Peer(joinOnlineRoom(hostSession.roomId, 'blenda'), 'blend-a', true);
      const guestB = new Peer(joinOnlineRoom(hostSession.roomId, 'blendb'), 'blend-b', true);
      active.push(host, guestA, guestB);
      await Promise.all([
        guestA.waitFor((msg) => msg.t === 'welcome', 30_000, 'guest A welcome'),
        guestB.waitFor((msg) => msg.t === 'welcome', 30_000, 'guest B welcome'),
      ]);
      const hostWelcome = host.waitForNew((msg) => msg.t === 'welcome' && msg.seat === 0);
      hostSession.send({ t: 'take_seat', index: 0 });
      await hostWelcome;
      hostSession.send({ t: 'pick_character', characterId: 'momotaro' });
      await takeSeats(host, [guestA, guestB], 1);
      hostSession.send({ t: 'settings', settings: { years: 10, turnSeconds: 0 } });
      const started = [host, guestA, guestB].map((peer) =>
        peer.waitFor((msg) => msg.t === 'snapshot' || msg.t === 'update', 20_000, 'mirror start'),
      );
      hostSession.send({ t: 'start' });
      await Promise.all(started);

      // Kill the host: the two guests form a 2/3 majority; seat 1 takes over and keeps mirroring.
      const beforeKill = guestB.seq;
      killSessionForTests(host.session);
      await guestB.waitFor(
        (msg) => msg.t === 'lobby' && msg.lobby.seats.find((seat) => seat.isHost)?.index === 1,
        45_000,
        'migration visible to the single-broker guest',
      );
      await waitForMsgWithPump(
        guestB,
        (msg) => (msg.t === 'update' || msg.t === 'snapshot') && msg.seq > beforeKill,
        [guestA, guestB],
        45_000,
        'single-broker guest receives updates from the promoted host',
      );
    } finally {
      for (const peer of active) peer.stop();
      active.length = 0;
      await brokerA.close();
      await brokerB.close();
      restoreSharedNetwork(brokerPort);
    }
  }, 180_000);

  it('rotates a guest off a dead broker and converges on the live one', async () => {
    for (const peer of active) peer.stop();
    active.length = 0;
    const brokerA = await startIsolatedBroker();
    const brokerB = await startIsolatedBroker();
    try {
      const base = {
        disableWebRtc: true,
        connectTimeoutMs: 2_000,
        heartbeatMs: 150,
        hostSilenceMs: 1_200,
        peerSilenceMs: 3_000,
        probeMs: 250,
        hostGoneMs: 3_000,
        selfHostGraceMs: 1_000,
        saveThrottleMs: 20,
        probeTimeoutMs: 4_000,
        graceMs: 120_000,
        replaceMs: 120_000,
        yearEndAckMs: 120_000,
        cpuDelayMs: 50,
        fxScale: 0.01,
        brokerRetryMs: 500,
        hostReplySilenceMs: 1_500,
      } as const;
      configureNetworkForTests({
        ...base,
        brokers: [brokerA.url, brokerB.url],
        clientIds: { 'rot-host': 'rot-host' },
      });
      const hostSession = await createOnlineRoom('rot-host');
      const host = new Peer(hostSession, 'rot-host', true);
      active.push(host);
      // Guest connects to A only (no mirror) so killing A forces a real rotation to B.
      configureNetworkForTests({
        ...base,
        brokers: [brokerA.url, brokerB.url],
        redundantBrokers: 0,
        clientIds: { 'rot-guest': 'rot-guest' },
      });
      const guest = new Peer(joinOnlineRoom(hostSession.roomId, 'rot-guest'), 'rot-guest', true);
      active.push(guest);
      await guest.waitFor((msg) => msg.t === 'welcome', 30_000, 'rotation guest welcome');
      const hostWelcome = host.waitForNew((msg) => msg.t === 'welcome' && msg.seat === 0);
      hostSession.send({ t: 'take_seat', index: 0 });
      await hostWelcome;
      hostSession.send({ t: 'pick_character', characterId: 'momotaro' });
      await takeSeats(host, [guest], 1);
      hostSession.send({ t: 'settings', settings: { years: 10, turnSeconds: 0 } });
      const started = [host, guest].map((peer) =>
        peer.waitFor((msg) => msg.t === 'snapshot' || msg.t === 'update', 20_000, 'rotation start'),
      );
      hostSession.send({ t: 'start' });
      await Promise.all(started);

      await brokerA.close();
      const before = guest.seq;
      await waitForMsgWithPump(
        guest,
        (msg) => (msg.t === 'update' || msg.t === 'snapshot') && msg.seq > before,
        [host, guest],
        60_000,
        'guest converges after its broker dies',
      );
    } finally {
      for (const peer of active) peer.stop();
      active.length = 0;
      await brokerA.close().catch(() => undefined);
      await brokerB.close();
      restoreSharedNetwork(brokerPort);
    }
  }, 180_000);

  it('discovers the host on a secondary broker before joining', async () => {
    const second = await Aedes.createBroker({ heartbeatInterval: 1_000 });
    const secondServer = createServer((socket) => second.handle(socket));
    await new Promise<void>((resolve) => secondServer.listen(0, '127.0.0.1', resolve));
    const address = secondServer.address();
    if (typeof address !== 'object' || !address) throw new Error('second broker did not bind');
    const secondUrl = `mqtt://127.0.0.1:${address.port}`;
    const common = {
      disableWebRtc: true,
      connectTimeoutMs: 2_000,
      heartbeatMs: 150,
      hostSilenceMs: 1_200,
      peerSilenceMs: 3_000,
      saveThrottleMs: 20,
      probeTimeoutMs: 5_000,
      graceMs: 300,
      replaceMs: 5_000,
      yearEndAckMs: 500,
      cpuDelayMs: 50,
      fxScale: 0.01,
      clientIds: { bhost: 'b-host', bguest: 'b-guest' },
    } as const;
    configureNetworkForTests({ ...common, brokers: [secondUrl] });
    const hostSession = await createOnlineRoom('bhost');
    const host = new Peer(hostSession, 'b-host', false);
    configureNetworkForTests({
      ...common,
      brokers: [`mqtt://127.0.0.1:${brokerPort}`, secondUrl],
    });
    expect(await roomExists(hostSession.roomId)).toBe(true);
    const guest = new Peer(joinOnlineRoom(hostSession.roomId, 'bguest'), 'b-guest', false);
    active.push(host, guest);
    try {
      await guest.waitFor((msg) => msg.t === 'welcome', 12_000, 'welcome via discovered broker');
      expect(guest.seat).toBeNull();
    } finally {
      host.stop();
      guest.stop();
      await new Promise<void>((resolve) => secondServer.close(() => resolve()));
      await new Promise<void>((resolve) => second.close(() => resolve()));
    }
  }, 30_000);

  it('keeps a human turn playable when only the generation changes', async () => {
    const hostSession = await createOnlineRoom('gen-host');
    const host = new Peer(hostSession, 'gen-host', false);
    const guest = new Peer(joinOnlineRoom(hostSession.roomId, 'gen-guest'), 'gen-guest', false);
    active.push(host, guest);
    try {
      await guest.waitFor((msg) => msg.t === 'welcome');
      const hostWelcome = host.waitForNew((msg) => msg.t === 'welcome' && msg.seat === 0);
      hostSession.send({ t: 'take_seat', index: 0 });
      await hostWelcome;
      hostSession.send({ t: 'pick_character', characterId: 'momotaro' });
      const guestWelcome = guest.waitForNew((msg) => msg.t === 'welcome' && msg.seat === 1);
      guest.session.send({ t: 'take_seat', index: 1 });
      await guestWelcome;
      guest.session.send({ t: 'pick_character', characterId: 'alice' });
      // No turn limit: nothing else will ever move the board after a generation-only bump.
      hostSession.send({ t: 'settings', settings: { years: 1, turnSeconds: 0 } });
      const started = [host, guest].map((peer) =>
        peer.waitFor((msg) => msg.t === 'snapshot' || msg.t === 'update', 20_000, 'gen start'),
      );
      hostSession.send({ t: 'start' });
      await Promise.all(started);
      await host.waitFor((msg) => msg.t === 'update', 20_000, 'host sees the opening update');

      const seqBefore = host.seq;
      const genBefore = host.gen;
      expect(bumpGenerationForTests(guest.session)).toBe(true);

      // Both sides must receive an fx-less snapshot of the SAME (gen, seq) with the new gen.
      const hostSnap = host.waitForNew(
        (msg) => msg.t === 'snapshot' && (msg.gen ?? 0) > genBefore,
        20_000,
        'host re-broadcasts the board for the new generation',
      );
      const guestSnap = guest.waitForNew(
        (msg) => msg.t === 'snapshot' && (msg.gen ?? 0) > genBefore,
        20_000,
        'guest receives the board for the new generation',
      );
      const [hostBoard, guestBoard] = await Promise.all([hostSnap, guestSnap]);
      if (hostBoard.t !== 'snapshot' || guestBoard.t !== 'snapshot') throw new Error('not a snapshot');
      expect(hostBoard.seq).toBe(seqBefore);
      expect(hostBoard.gen).toBe(guestBoard.gen);
      expect(host.session.appliedOrder?.()?.gen).toBe(hostBoard.gen);
      expect(guest.session.appliedOrder?.()?.gen).toBe(guestBoard.gen);
      expect(hostBoard.resync).toBe(true);
      expect(guestBoard.resync).toBe(true);
      // Same seq, new generation: both clients must adopt it (not be filtered as stale).
      expect(hostBoard.gen).toBeGreaterThan(genBefore);
      expect(guest.seq).toBe(seqBefore);

      // The acting human can play immediately against the new generation - on both clients.
      const actorPeer = host.state && actorOf(host.state) === 0 ? host : guest;
      const before = actorPeer.seq;
      // Register the wait BEFORE sending: a local host applies its own action synchronously, so
      // the update can be delivered before a later waitForNew would be installed.
      const advanced = waitForMsgWithPump(
        host,
        (msg) => msg.t === 'update' && msg.seq > before,
        [host, guest],
        15_000,
        'the human turn advances after the generation-only bump',
      );
      actorPeer.session.send({
        t: 'action',
        seq: before,
        action: cpuDecide(GAME_DATA, actorPeer.state as GameState),
      });
      await advanced;
    } finally {
      host.stop();
      guest.stop();
    }
  }, 60_000);

  it('rejects an online host save from a different board version', () => {
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
    const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', {
      value: { localStorage: storage, sessionStorage: storage },
      configurable: true,
    });
    try {
      data.set(
        'fable.online.host',
        JSON.stringify({
          roomId: 'ABC123-XYZ9',
          name: 'host',
          snapshot: '{"v":1}',
          generation: 1,
          boardVersion: 'obsolete-board-version',
          savedAt: 1,
        }),
      );
      expect(resumeOnline()).toBeNull();
      expect(onlineSaveIssue()).toContain('盤面');
      expect(data.has('fable.online.host')).toBe(false);

      // A save with no version field at all is also rejected (it predates the board check).
      data.set(
        'fable.online.host',
        JSON.stringify({ roomId: 'ABC123-XYZ9', name: 'host', snapshot: '{"v":1}', generation: 1 }),
      );
      expect(resumeOnline()).toBeNull();
      expect(onlineSaveIssue()).toContain('古い');
    } finally {
      if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor);
      else Reflect.deleteProperty(globalThis, 'window');
    }
  });

  it('prefers a verified successor over the invite URL pin after a host transfer', () => {
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
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', {
      value: { localStorage: storage, sessionStorage: storage },
      configurable: true,
    });
    try {
      // The invite URL pinned the ORIGINAL host; storage holds a majority-approved successor.
      data.set(
        'fable.keychain.KCHAIN-TEST1',
        JSON.stringify([
          { fp: 'a'.repeat(64), gen: 1, approvedBy: [], needed: 1 },
          { fp: 'b'.repeat(64), gen: 3, approvedBy: ['c'.repeat(64), 'd'.repeat(64)], needed: 1 },
        ]),
      );
      const successor = verifiedSuccessorForRoom('KCHAIN-TEST1', ['a'.repeat(64), 'c'.repeat(64), 'd'.repeat(64)]);
      expect(successor).toEqual({ fp: 'b'.repeat(64), gen: 3 });
      // An approval list containing a key that is not an agreed seat is not verified.
      expect(
        verifiedSuccessorForRoom('KCHAIN-TEST1', ['a'.repeat(64), 'c'.repeat(64)]),
      ).toBeNull();
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'window', descriptor);
      else Reflect.deleteProperty(globalThis, 'window');
    }
  });

  it('preserves a reporter guest vote when the reporter immediately inherits host', async () => {
    for (const peer of active) peer.stop();
    active.length = 0;
    const iso = await startIsolatedBroker();
    try {
      configureNetworkForTests({
        brokers: [iso.url],
        disableWebRtc: true,
        connectTimeoutMs: 2_000,
        heartbeatMs: 150,
        hostSilenceMs: 900,
        peerSilenceMs: 2_000,
        probeMs: 200,
        hostGoneMs: 2_000,
        selfHostGraceMs: 800,
        saveThrottleMs: 20,
        probeTimeoutMs: 4_000,
        graceMs: 30_000,
        replaceMs: 60_000,
        yearEndAckMs: 30_000,
        cpuDelayMs: 50,
        fxScale: 0.01,
        clientIds: {
          rphost: 'rp-host',
          rp1: 'rp-g1',
          rp2: 'rp-g2',
          rp3: 'rp-g3',
        },
      });
      const hostSession = await createOnlineRoom('rphost');
      const host = new Peer(hostSession, 'rp-host', false);
      const guest1 = new Peer(joinOnlineRoom(hostSession.roomId, 'rp1'), 'rp1', false);
      const guest2 = new Peer(joinOnlineRoom(hostSession.roomId, 'rp2'), 'rp2', false);
      const guest3 = new Peer(joinOnlineRoom(hostSession.roomId, 'rp3'), 'rp3', false);
      active.push(host, guest1, guest2, guest3);
      await Promise.all([guest1, guest2, guest3].map((p) => p.waitFor((m) => m.t === 'welcome')));
      const hw = host.waitForNew((m) => m.t === 'welcome' && m.seat === 0);
      hostSession.send({ t: 'take_seat', index: 0 });
      await hw;
      hostSession.send({ t: 'pick_character', characterId: 'momotaro' });
      await takeSeats(host, [guest1, guest2, guest3], 1);

      // Guest1 (seat 1, next-in-line successor) reports seat 3. Wait until guest1 itself has the vote.
      guest1.session.send({ t: 'report', seat: 3, reason: 'spam' });
      await waitUntil(
        () => (reportVotesForTests(guest1.session)?.['3']?.length ?? 0) === 1,
        10_000,
        'reporter guest1 receives its own replicated vote',
      );

      // Host crashes and seat 1 (the reporter) inherits host.
      killSessionForTests(host.session);
      await guest1.waitFor(
        (m) => m.t === 'lobby' && m.lobby.seats.find((s) => s.isHost)?.index === 1,
        20_000,
        'reporter guest1 becomes host',
      );
      await waitUntil(
        () => authorityInfoForTests(guest1.session)?.ready === true,
        15_000,
        'guest1 host confirmed',
      );

      // Second report from guest2 against seat 3 must immediately trigger auto-mute flag!
      const flagged = guest2.waitFor((m) => m.t === 'flag' && m.seat === 3, 15_000, 'auto-mute flag');
      guest2.session.send({ t: 'report', seat: 3, reason: 'abuse' });
      await flagged;
    } finally {
      for (const peer of active) peer.stop();
      active.length = 0;
      await iso.close();
      restoreSharedNetwork(brokerPort);
    }
  }, 90_000);

  it('reconverges into one match after both sides CPU-replace each other during a partition', async () => {
    for (const peer of active) peer.stop();
    active.length = 0;
    const iso = await startIsolatedBroker();
    try {
      configureNetworkForTests({
        brokers: [iso.url],
        disableWebRtc: true,
        connectTimeoutMs: 2_000,
        heartbeatMs: 120,
        hostSilenceMs: 700,
        peerSilenceMs: 1_200,
        probeMs: 200,
        hostGoneMs: 1_500,
        selfHostGraceMs: 800,
        saveThrottleMs: 20,
        probeTimeoutMs: 4_000,
        graceMs: 300,
        replaceMs: 1_800,
        yearEndAckMs: 500,
        cpuDelayMs: 60,
        fxScale: 0.01,
        clientIds: {
          cpuhost: 'cpu-host',
          cpuguest: 'cpu-guest',
        },
      });
      const hostSession = await createOnlineRoom('cpuhost');
      const host = new Peer(hostSession, 'cpu-host', true);
      const guest = new Peer(joinOnlineRoom(hostSession.roomId, 'cpuguest'), 'cpu-guest', true);
      active.push(host, guest);
      await guest.waitFor((m) => m.t === 'welcome');
      const hw = host.waitForNew((m) => m.t === 'welcome' && m.seat === 0);
      hostSession.send({ t: 'take_seat', index: 0 });
      await hw;
      hostSession.send({ t: 'pick_character', characterId: 'momotaro' });
      await takeSeats(host, [guest], 1);
      hostSession.send({ t: 'settings', settings: { years: 10, turnSeconds: 0 } });
      const started = [host, guest].map((p) => p.waitFor((m) => m.t === 'update', 15_000, 'cpu split start'));
      hostSession.send({ t: 'start' });
      await Promise.all(started);

      // Partition the 2 humans long enough for the host to CPU-replace seat 1 and keep advancing,
      // and for the guest to promote and CPU-replace seat 0 as well.
      setBlockedPeersForTests(host.session, ['cpu-guest']);
      setBlockedPeersForTests(guest.session, ['cpu-host']);
      await waitUntil(
        () => host.session.lobby()?.seats[1]?.kind === 'cpu' && host.seq >= 6,
        20_000,
        'host CPU-replaces guest and advances',
        pumpActions([host, guest]),
      );
      await new Promise((resolve) => setTimeout(resolve, 1_000));

      // Heal partition: both sides must converge onto one host and seat 1 reclaims its human seat.
      setBlockedPeersForTests(host.session, []);
      setBlockedPeersForTests(guest.session, []);
      await waitUntil(
        () =>
          everyonesAuthorityIsReady([host, guest]) &&
          host.session.lobby()?.seats[1]?.kind === 'human' &&
          host.session.lobby()?.seats[1]?.connected === true,
        30_000,
        'reconverged into one room with seat 1 reclaimed',
        pumpActions([host, guest]),
      );
      const seqAfterHeal = Math.max(host.seq, guest.seq);
      await waitForMsgWithPump(
        guest,
        (m) => (m.t === 'update' || m.t === 'snapshot') && m.seq > seqAfterHeal,
        [host, guest],
        20_000,
        'both peers advance together after reconvergence',
      );
      expect(Math.abs(host.seq - guest.seq)).toBeLessThanOrEqual(2);
    } finally {
      for (const peer of active) peer.stop();
      active.length = 0;
      await iso.close();
      restoreSharedNetwork(brokerPort);
    }
  }, 120_000);

  it('lets an offline guest rejoin from the old invite URL after a host transfer via signed TransferProof', async () => {
    for (const peer of active) peer.stop();
    active.length = 0;
    const iso = await startIsolatedBroker();
    try {
      configureNetworkForTests({
        brokers: [iso.url],
        disableWebRtc: true,
        connectTimeoutMs: 2_000,
        heartbeatMs: 120,
        hostSilenceMs: 800,
        peerSilenceMs: 2_000,
        probeMs: 200,
        hostGoneMs: 2_000,
        selfHostGraceMs: 800,
        saveThrottleMs: 20,
        probeTimeoutMs: 4_000,
        graceMs: 30_000,
        replaceMs: 60_000,
        yearEndAckMs: 30_000,
        cpuDelayMs: 50,
        fxScale: 0.01,
        clientIds: {
          tp0: 'tp-host0',
          tp1: 'tp-guest1',
          tp2: 'tp-guest2',
          'tp0-rejoin': 'tp-host0',
          'tp-spectator': 'tp-spec',
        },
      });
      const hostSession = await createOnlineRoom('tp0');
      const initialInvitePin = hostKeyFingerprintForSession(hostSession)?.slice(0, 16) ?? '';
      expect(initialInvitePin).toHaveLength(16);

      const host = new Peer(hostSession, 'tp-host0', false);
      const guest1 = new Peer(joinOnlineRoom(hostSession.roomId, 'tp1', { hostKeyHint: initialInvitePin }), 'tp1', false);
      const guest2 = new Peer(joinOnlineRoom(hostSession.roomId, 'tp2', { hostKeyHint: initialInvitePin }), 'tp2', false);
      active.push(host, guest1, guest2);
      await Promise.all([guest1, guest2].map((p) => p.waitFor((m) => m.t === 'welcome')));
      const hw = host.waitForNew((m) => m.t === 'welcome' && m.seat === 0);
      hostSession.send({ t: 'take_seat', index: 0 });
      await hw;
      hostSession.send({ t: 'pick_character', characterId: 'momotaro' });
      await takeSeats(host, [guest1, guest2], 1);
      hostSession.send({ t: 'settings', settings: { years: 1, turnSeconds: 0 } });
      const started = [guest1, guest2].map((p) => p.waitFor((m) => m.t === 'update', 15_000, 'tp start'));
      hostSession.send({ t: 'start' });
      await Promise.all(started);
      // Let the initial host broadcast its signed SeatRosterCert to all guests.
      await new Promise((resolve) => setTimeout(resolve, 400));

      // Host0 goes down; guest1 + guest2 form a 2/3 majority and confirm the host transfer.
      killSessionForTests(host.session);
      await guest1.waitFor(
        (m) => m.t === 'lobby' && m.lobby.seats.find((s) => s.isHost)?.index === 1,
        20_000,
        'guest1 becomes host',
      );
      await waitUntil(
        () => authorityInfoForTests(guest1.session)?.ready === true,
        15_000,
        'guest1 host confirmed with majority approvals',
      );
      // Give async transfer approval signatures a tick to attach to guest1's TransferProof.
      await new Promise((resolve) => setTimeout(resolve, 400));

      // A returning client that missed the transfer and only has the OLD invite URL (?k=<initial host>)
      // must verify guest1's signed TransferProof and rejoin its seat (or spectate) smoothly.
      const returning = new Peer(
        joinOnlineRoom(hostSession.roomId, 'tp0-rejoin', { hostKeyHint: initialInvitePin }),
        'tp0-rejoin',
        false,
      );
      active.push(returning);
      const welcome = await returning.waitFor(
        (m) => m.t === 'welcome' && m.seat === 0,
        20_000,
        'returning seat 0 rejoins via old invite URL + TransferProof',
      );
      expect(welcome.t).toBe('welcome');
      await returning.waitFor(
        (m) => m.t === 'snapshot' || m.t === 'update',
        15_000,
        'returning peer receives current board snapshot',
      );
      expect(returning.session.lobby()?.seats.find((s) => s.isHost)?.index).toBe(1);
    } finally {
      for (const peer of active) peer.stop();
      active.length = 0;
      await iso.close();
      restoreSharedNetwork(brokerPort);
    }
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