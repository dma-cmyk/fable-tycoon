// Serverless online play.
//
// There is no game server: the HOST'S BROWSER runs the authoritative RoomController. Guests talk to
// it over encrypted public MQTT and, when possible, an automatic WebRTC DataChannel. Every client
// keeps a public snapshot; if the host disappears for 10 seconds the lowest-index connected human
// seat adopts the room and continues with a fresh crypto-random rng seed.

import type { Action, GameData } from '../core/types';
import type { RoomDeps } from './room';
import { RoomController } from './room';
import type { RoomPublicSnapshot } from './room';
import type {
  ChatLine,
  ClientMsg,
  LobbyView,
  PublicState,
  Report,
  ServerMsg,
} from './protocol';
import { COMM, PROTOCOL_VERSION } from './protocol';
import type { ConnectionState, Session } from './session-types';
import { GAME_DATA } from '../data/index';
import { MqttTransport, DEFAULT_BROKERS, isP2PControl } from './p2p/transport';
import { loadIdentity } from './p2p/identity';
import type { ClientIdentity } from './p2p/identity';
import type { P2PControl, P2PMessage, TransportStatus } from './p2p/transport';

const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const REPORTS_KEY = 'fable.reports';
const CLIENT_KEY = 'fable.client';
const GUEST_SAVE_KEY = 'fable.online.guest';
const HOST_SAVE_KEY = 'fable.online.host';
const DEFAULT_HEARTBEAT_MS = 3_000;
const DEFAULT_HOST_SILENCE_MS = 10_000;
const DEFAULT_PEER_SILENCE_MS = 10_000;
const PROBE_TIMEOUT_MS = 5_000;

const data: GameData = GAME_DATA;

export interface NetworkConfig {
  brokers?: readonly string[];
  disableWebRtc?: boolean;
  connectTimeoutMs?: number;
  heartbeatMs?: number;
  hostSilenceMs?: number;
  peerSilenceMs?: number;
  /** Persistent client id per display name (Node tests; browsers use localStorage). */
  clientIds?: Record<string, string>;
  saveThrottleMs?: number;
  probeTimeoutMs?: number;
  /** RoomController timing overrides for fast tests; production leaves them undefined. */
  graceMs?: number;
  replaceMs?: number;
  yearEndAckMs?: number;
  cpuDelayMs?: number;
  fxScale?: number;
}

let networkConfig: NetworkConfig = {};

/** Test seam: point sessions at an in-process broker and shorten heartbeat timers. */
export function configureNetworkForTests(config: NetworkConfig = {}): void {
  networkConfig = { ...config };
}

const transportRegistry = new WeakMap<Session, MqttTransport>();

export function transportInfo(session: Session): {
  broker: string | null;
  p2pPeers: number;
  relayPeers: number;
} {
  const transport = transportRegistry.get(session);
  return {
    broker: transport?.broker() ?? null,
    p2pPeers: transport?.p2pPeers() ?? 0,
    relayPeers: transport?.relayPeers() ?? 0,
  };
}

// ---------------------------------------------------------------- storage / ids

function storageGet(storage: 'local' | 'session', key: string): string | null {
  try {
    if (typeof window === 'undefined') return null;
    const store = storage === 'local' ? window.localStorage : window.sessionStorage;
    return store.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(storage: 'local' | 'session', key: string, value: string): void {
  try {
    if (typeof window === 'undefined') return;
    const store = storage === 'local' ? window.localStorage : window.sessionStorage;
    store.setItem(key, value);
  } catch {
    // quota / private mode
  }
}

function storageRemove(storage: 'local' | 'session', key: string): void {
  try {
    if (typeof window === 'undefined') return;
    const store = storage === 'local' ? window.localStorage : window.sessionStorage;
    store.removeItem(key);
  } catch {
    // ignore
  }
}

function randomToken(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < length; i += 1) out += chars[bytes[i] % chars.length];
  return out;
}

function clientIdFor(name: string): string {
  const mapped = networkConfig.clientIds?.[name];
  if (mapped) return mapped;
  const stored = storageGet('local', CLIENT_KEY);
  if (stored) return stored;
  const id = `c${randomToken(20)}`;
  storageSet('local', CLIENT_KEY, id);
  return id;
}

function generateRoomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  let id = '';
  for (let i = 0; i < 6; i += 1) id += ROOM_ALPHABET[bytes[i] % ROOM_ALPHABET.length];
  let secret = '';
  for (let i = 6; i < 10; i += 1) secret += ROOM_ALPHABET[bytes[i] % ROOM_ALPHABET.length];
  return `${id}-${secret}`;
}

function normalizeRoomId(raw: string): string {
  return raw.trim().toUpperCase();
}

function isValidRoomId(roomId: string): boolean {
  return /^(?:[A-Z0-9]{6}|[A-Z0-9]{6}-[A-Z0-9]{4})$/.test(roomId);
}

// ---------------------------------------------------------------- type guards

function isClientMsg(value: P2PMessage): value is ClientMsg {
  if (!('t' in value)) return false;
  switch (value.t) {
    case 'hello':
    case 'take_seat':
    case 'leave_seat':
    case 'pick_character':
    case 'set_seat':
    case 'settings':
    case 'start':
    case 'action':
    case 'chat':
    case 'emote':
    case 'report':
    case 'leave':
    case 'ping':
      return true;
    default:
      return false;
  }
}

export function isNewerStateOrder(
  currentGeneration: number,
  currentSeq: number,
  incomingGeneration: number,
  incomingSeq: number,
): boolean {
  if (incomingGeneration < currentGeneration) return false;
  if (incomingGeneration > currentGeneration) return true;
  return incomingSeq > currentSeq;
}

function genOf(message: ServerMsg): number | undefined {
  if ('gen' in message && typeof message.gen === 'number') return message.gen;
  return undefined;
}

function isServerMsg(value: P2PMessage): value is ServerMsg {
  if (!('t' in value)) return false;
  switch (value.t) {
    case 'welcome':
    case 'lobby':
    case 'snapshot':
    case 'update':
    case 'chat':
    case 'emote':
    case 'system':
    case 'flag':
    case 'error':
    case 'pong':
      return true;
    default:
      return false;
  }
}

// ---------------------------------------------------------------- session

interface HostSave {
  roomId: string;
  name: string;
  snapshot: string;
  generation: number;
  savedAt: number;
}

interface GuestSave {
  roomId: string;
  name: string;
}

export interface HostCheckpoint {
  roomId: string;
  name: string;
  snapshot: string;
  generation: number;
}

interface Shadow {
  lobby: LobbyView | null;
  state: PublicState | null;
  seq: number;
  chat: ChatLine[];
  seatKeys: Record<string, string>;
  hostSeat: number | null;
  lastFx: RoomPublicSnapshot['lastFx'];
  deadline: number | null;
}

function emptyShadow(): Shadow {
  return {
    lobby: null,
    state: null,
    seq: 0,
    chat: [],
    seatKeys: {},
    hostSeat: null,
    lastFx: [],
    deadline: null,
  };
}

function parseHostSave(raw: string | null): HostSave | null {
  if (!raw) return null;
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object') return null;
  if (!('roomId' in parsed) || typeof parsed.roomId !== 'string') return null;
  if (!('name' in parsed) || typeof parsed.name !== 'string') return null;
  if (!('snapshot' in parsed) || typeof parsed.snapshot !== 'string') return null;
  return {
    roomId: parsed.roomId,
    name: parsed.name,
    snapshot: parsed.snapshot,
    generation: 'generation' in parsed && typeof parsed.generation === 'number' ? parsed.generation : 1,
    savedAt: 'savedAt' in parsed && typeof parsed.savedAt === 'number' ? parsed.savedAt : 0,
  };
}

function parseGuestSave(raw: string | null): GuestSave | null {
  if (!raw) return null;
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object') return null;
  if (!('roomId' in parsed) || typeof parsed.roomId !== 'string') return null;
  if (!('name' in parsed) || typeof parsed.name !== 'string') return null;
  return { roomId: parsed.roomId, name: parsed.name };
}

function clearHandle(handle: unknown): void {
  if (handle !== null && handle !== undefined) clearInterval(handle as number);
}

export class OnlineSession implements Session {
  readonly mode = 'online' as const;
  readonly roomId: string;

  private readonly name: string;
  private readonly clientId: string;
  private role: 'host' | 'guest';
  private transport: MqttTransport | null = null;
  private controller: RoomController | null = null;
  private loopbackId = 'loopback';

  private connectionState: ConnectionState = 'connecting';
  private identity: ClientIdentity | null = null;
  private seat: number | null = null;
  private generation = 0;
  private hostKeyFingerprint: string | null = null;
  private hostBroker: string | null = null;
  private peerKeys = new Map<string, string>();
  private hostPeerId: string | null = null;
  private hostSeat: number | null = null;
  private lastHostHeartbeatAt = 0;
  private peerSeen = new Map<string, number>();
  private guestSeen = new Map<string, number>();
  private queue: ClientMsg[] = [];
  private shadow = emptyShadow();

  private readonly listeners = new Set<(msg: ServerMsg) => void>();
  private readonly connectionListeners = new Set<(state: ConnectionState) => void>();
  private heartbeatTimer: unknown = null;
  private watchdogTimer: unknown = null;
  private saveTimer: unknown = null;
  private welcomeTimer: unknown = null;
  private brokerAttempt = 0;
  private timersStarted = false;
  private closed = false;
  private crashed = false;
  private promoting = false;
  private lastResyncAt = 0;
  private pendingSeat: number | null = null;
  private pendingCharacter: string | null = null;
  private pendingAction: { seq: number; action: Action; sentAt: number } | null = null;
  private lastLobbyRetryAt = 0;
  private reports: (Report & { room: string; recentChat: ChatLine[] })[] = [];

  private lastWelcome: Extract<ServerMsg, { t: 'welcome' }> | null = null;
  private lastLobby: LobbyView | null = null;
  private lastSnapshot: Extract<ServerMsg, { t: 'snapshot' }> | null = null;
  private lastUpdate: Extract<ServerMsg, { t: 'update' }> | null = null;

  private constructor(roomId: string, name: string, role: 'host' | 'guest') {
    this.roomId = normalizeRoomId(roomId);
    this.name = name.trim().slice(0, 16) || 'プレイヤー';
    this.role = role;
    this.clientId = clientIdFor(this.name);
    this.peerSeen.set(this.clientId, Date.now());
  }

  // ---------------------------------------------------------------- factories

  static async host(name: string, saved?: string): Promise<OnlineSession> {
    const roomId = generateRoomId();
    const session = new OnlineSession(roomId, name, 'host');
    await session.beginHost(saved);
    return session;
  }

  static resumeHost(save: HostSave): OnlineSession {
    const session = new OnlineSession(save.roomId, save.name, 'host');
    void session.beginHost(save.snapshot, save.generation).catch(() => {
      session.fail();
    });
    return session;
  }

  static resumeFromCheckpoint(checkpoint: HostCheckpoint): OnlineSession {
    const session = new OnlineSession(checkpoint.roomId, checkpoint.name, 'host');
    void session.beginHost(checkpoint.snapshot, checkpoint.generation).catch(() => session.fail());
    return session;
  }

  hostCheckpoint(): HostCheckpoint | null {
    if (this.role !== 'host' || !this.controller) return null;
    return {
      roomId: this.roomId,
      name: this.name,
      snapshot: this.controller.serialize(),
      generation: this.generation,
    };
  }

  static guest(roomId: string, name: string): OnlineSession {
    const session = new OnlineSession(roomId, name, 'guest');
    storageSet('local', GUEST_SAVE_KEY, JSON.stringify({ roomId: session.roomId, name: session.name }));
    void session.beginGuest();
    return session;
  }

  // ---------------------------------------------------------------- Session

  mySeats(): number[] {
    return this.seat === null ? [] : [this.seat];
  }

  seatToPlayer(seat: number): number | null {
    if (this.role === 'host' && this.controller) return this.controller.seatToPlayer(seat);
    const seats = this.occupiedSeats();
    const index = seats.indexOf(seat);
    return index < 0 ? null : index;
  }

  playerToSeat(playerId: number): number | null {
    if (this.role === 'host' && this.controller) return this.controller.playerToSeat(playerId);
    return this.occupiedSeats()[playerId] ?? null;
  }

  private occupiedSeats(): number[] {
    const lobby = this.lastLobby ?? this.lastWelcome?.lobby;
    if (!lobby) return [];
    return lobby.seats
      .filter((seat) => seat.kind !== 'open')
      .map((seat) => seat.index)
      .sort((a, b) => a - b);
  }

  lobby(): LobbyView | null {
    return this.lastLobby ?? this.lastWelcome?.lobby ?? null;
  }

  connection(): ConnectionState {
    return this.connectionState;
  }

  subscribe(listener: (msg: ServerMsg) => void): () => void {
    this.listeners.add(listener);
    this.replay(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  onConnection(listener: (state: ConnectionState) => void): () => void {
    this.connectionListeners.add(listener);
    return () => {
      this.connectionListeners.delete(listener);
    };
  }

  send(msg: ClientMsg): void {
    if (this.closed || this.crashed) return;
    if (msg.t === 'ping') return;
    if (this.role === 'host' && this.controller) {
      this.controller.message(this.loopbackId, msg);
      return;
    }
    if (this.role === 'guest') {
      if (msg.t === 'take_seat') {
        this.pendingSeat = msg.index;
        this.pendingCharacter = null;
      } else if (msg.t === 'pick_character') {
        this.pendingCharacter = msg.characterId;
      } else if (msg.t === 'action') {
        this.pendingAction = { seq: msg.seq, action: msg.action, sentAt: Date.now() };
      } else if (msg.t === 'leave_seat' || msg.t === 'leave') {
        this.pendingSeat = null;
        this.pendingCharacter = null;
        this.pendingAction = null;
      }
    }
    this.deliverToHost(msg);
  }

  private deliverToHost(msg: ClientMsg): void {
    if (this.hostPeerId && this.transport?.status() === 'open') {
      void this.transport.send(this.hostPeerId, msg);
      return;
    }
    if (this.queue.length < 100) this.queue.push(msg);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopTimers();
    const transport = this.transport;
    const wasGuest = this.role === 'guest';
    const hostPeer = this.hostPeerId;
    this.transport = null;
    this.controller?.dispose();
    this.controller = null;
    this.setState('closed');
    storageRemove('local', GUEST_SAVE_KEY);
    storageRemove('session', HOST_SAVE_KEY);
    this.listeners.clear();
    this.connectionListeners.clear();
    if (transport) {
      void (async () => {
        try {
          if (wasGuest && hostPeer) await transport.send(hostPeer, { t: 'leave' });
          await transport.broadcast({ k: 'bye' });
        } catch {
          // best effort; the socket may already be gone
        }
        await transport.close();
      })();
    }
  }

  /** Test hook: simulate a killed tab / lost device without a graceful leave. */
  killForTests(): void {
    if (this.crashed) return;
    this.crashed = true;
    this.stopTimers();
    if (this.transport) void this.transport.close();
    this.transport = null;
    this.controller?.dispose();
    this.controller = null;
    this.setState('closed');
  }

  private fail(): void {
    this.stopTimers();
    if (this.transport) void this.transport.close();
    this.transport = null;
    this.setState('closed');
  }

  // ---------------------------------------------------------------- host startup

  private async beginHost(saved?: string, generation = 1): Promise<void> {
    this.role = 'host';
    try {
      this.identity = await loadIdentity(this.clientId);
    } catch (error) {
      this.log('P-256 identity setup failed', error);
      this.setState('closed');
      return;
    }
    this.generation = generation;
    this.hostPeerId = this.clientId;
    this.hostKeyFingerprint = this.identity.fingerprint;
    const deps = this.hostDeps();
    try {
      this.controller = saved
        ? RoomController.restore(saved, deps, { connections: false })
        : new RoomController(deps);
    } catch (error) {
      this.log('host restore failed; starting a new lobby', error);
      storageRemove('session', HOST_SAVE_KEY);
      this.controller = new RoomController(deps);
    }
    this.controller.connect(this.loopbackId);
    this.controller.message(this.loopbackId, {
      t: 'hello',
      v: PROTOCOL_VERSION,
      roomId: this.roomId,
      name: this.name,
      token: this.identity.fingerprint,
      pub: JSON.stringify(this.identity.publicJwk),
    });
    this.hostSeat = this.controller.publicSnapshot().hostSeat;

    const transport = this.createTransport();
    this.transport = transport;
    transport.onMessage((from, message, fingerprint) =>
      this.onTransportMessage(from, message, fingerprint),
    );
    transport.onStatus((status) => this.onTransportStatus(status));
    await transport.connect(this.roomId);
    this.setState('open');
    this.startTimers();
    this.sendHeartbeat();
    this.persistHostNow();
  }

  private hostDeps(): RoomDeps {
    return {
      roomId: this.roomId,
      now: () => Date.now(),
      setTimer: (ms, fn) => setTimeout(fn, ms),
      clearTimer: (handle) => clearTimeout(handle as number),
      randomInt: (n) => (n <= 0 ? 0 : crypto.getRandomValues(new Uint32Array(1))[0] % n),
      data,
      send: (connId, msg) => {
        const stamped = this.stampHostMessage(msg);
        if (connId === this.loopbackId) {
          this.onServerMsg(stamped);
          return;
        }
        void this.transport?.send(connId, stamped);
        this.afterHostMessage(stamped);
      },
      broadcast: (msg) => {
        const stamped = this.stampHostMessage(msg);
        this.onServerMsg(stamped);
        void this.transport?.broadcast(stamped);
      },
      log: (message, detail) => this.log(message, detail),
      report: (report) => {
        this.reports.push(report);
        if (this.reports.length > 100) this.reports.shift();
        storageSet('local', REPORTS_KEY, JSON.stringify(this.reports));
      },
      ...(networkConfig.graceMs !== undefined ? { graceMs: networkConfig.graceMs } : {}),
      ...(networkConfig.replaceMs !== undefined ? { replaceMs: networkConfig.replaceMs } : {}),
      ...(networkConfig.yearEndAckMs !== undefined ? { yearEndAckMs: networkConfig.yearEndAckMs } : {}),
      ...(networkConfig.cpuDelayMs !== undefined ? { cpuDelayMs: networkConfig.cpuDelayMs } : {}),
      ...(networkConfig.fxScale !== undefined ? { fxScale: networkConfig.fxScale } : {}),
    };
  }

  // ---------------------------------------------------------------- guest startup

  private async beginGuest(): Promise<void> {
    this.role = 'guest';
    try {
      this.identity = await loadIdentity(this.clientId);
    } catch (error) {
      this.log('P-256 identity setup failed', error);
      this.setState('closed');
      return;
    }
    this.generation = 0;
    this.setState('connecting');
    await this.connectGuestTransport();
  }

  /** Try the announced host broker first, then rotate on failed discovery (public brokers differ). */
  private async connectGuestTransport(): Promise<void> {
    while (!this.closed && !this.crashed) {
      const transport = this.createTransport();
      this.transport = transport;
      transport.onMessage((from, message, fingerprint) =>
        this.onTransportMessage(from, message, fingerprint),
      );
      transport.onStatus((status) => this.onTransportStatus(status));
      try {
        await transport.connect(this.roomId);
        if (!this.timersStarted) {
          this.timersStarted = true;
          this.startTimers();
        }
        this.startWelcomeWatchdog();
        return;
      } catch (error) {
        this.log(`guest broker connection failed (attempt ${this.brokerAttempt + 1})`, error);
        this.brokerAttempt += 1;
        await transport.close();
        this.setState('reconnecting');
        await new Promise<void>((resolve) => setTimeout(resolve, 2_000));
      }
    }
  }

  private startWelcomeWatchdog(): void {
    this.clearWelcomeWatchdog();
    this.welcomeTimer = setTimeout(() => {
      this.welcomeTimer = null;
      if (this.closed || this.crashed || this.connectionState === 'open') return;
      this.log('no host welcome on this broker; trying the next broker');
      this.brokerAttempt += 1;
      const old = this.transport;
      this.transport = null;
      if (old) void old.close();
      void this.connectGuestTransport();
    }, 5_000);
  }

  private clearWelcomeWatchdog(): void {
    if (this.welcomeTimer === null) return;
    clearTimeout(this.welcomeTimer as number);
    this.welcomeTimer = null;
  }

  private createTransport(): MqttTransport {
    if (!this.identity) throw new Error('identity not initialised');
    const base = networkConfig.brokers ?? DEFAULT_BROKERS;
    const rotated = base.length > 0
      ? base.map((_, index) => base[(index + this.brokerAttempt) % base.length])
      : base;
    const brokers = this.hostBroker
      ? [this.hostBroker, ...rotated.filter((broker) => broker !== this.hostBroker)]
      : rotated;
    const transport = new MqttTransport(this.clientId, {
      identity: this.identity,
      brokers,
      disableWebRtc: networkConfig.disableWebRtc,
      connectTimeoutMs: networkConfig.connectTimeoutMs,
      log: (message, detail) => this.log(message, detail),
    });
    transportRegistry.set(this, transport);
    return transport;
  }

  // ---------------------------------------------------------------- transport inbound

  private onTransportMessage(from: string, message: P2PMessage, fingerprint: string): void {
    if (this.crashed || this.closed) return;
    this.peerSeen.set(from, Date.now());
    const knownKey = this.peerKeys.get(from);
    if (knownKey !== undefined && knownKey !== fingerprint) return;
    if (knownKey === undefined) this.peerKeys.set(from, fingerprint);
    if (isP2PControl(message)) {
      this.handleControl(from, message, fingerprint);
      return;
    }
    if (this.role === 'host') {
      if (!this.controller || !isClientMsg(message)) return;
      const pinned = this.peerKeys.get(from);
      if (pinned !== undefined && pinned !== fingerprint) {
        this.log(`drop ClientMsg from ${from}: signing key does not match pinned key`);
        return;
      }
      if (message.t === 'hello') {
        if (message.token && message.token !== fingerprint) {
          this.log(`drop hello from ${from}: token is not the public-key fingerprint`);
          return;
        }
        this.peerKeys.set(from, fingerprint);
      } else if (pinned === undefined) {
        this.log(`drop ClientMsg from ${from}: hello (public key) missing`);
        return;
      }
      this.guestSeen.set(from, Date.now());
      this.controller.connect(from);
      this.controller.message(from, message);
      this.afterHostMessage(message);
      return;
    }
    if (!isServerMsg(message)) return;
    if (!this.acceptHostSender(from, fingerprint)) return;
    if (message.t === 'welcome') {
      this.lastHostHeartbeatAt = Date.now();
      this.brokerAttempt = 0;
      this.clearWelcomeWatchdog();
      this.setState('open');
      this.flushQueue();
    }
    if (!this.acceptServerMessage(message)) return;
    this.onServerMsg(message);
    if (message.t === 'welcome' || message.t === 'snapshot') this.broadcastPresence();
  }

  private acceptHostSender(from: string, fingerprint: string): boolean {
    if (this.hostPeerId && this.hostPeerId !== from) return false;
    if (this.hostKeyFingerprint && this.hostKeyFingerprint !== fingerprint) {
      this.log(`drop host message from ${from}: signing key changed without a generation bump`);
      return false;
    }
    if (!this.hostPeerId) this.hostPeerId = from;
    if (!this.hostKeyFingerprint) this.hostKeyFingerprint = fingerprint;
    return true;
  }

  /** Drop stale/duplicate host state before it reaches subscribers (generation, seq ordering). */
  private acceptServerMessage(message: ServerMsg): boolean {
    const gen = genOf(message) ?? this.generation;
    if (this.generation > 0 && gen < this.generation) {
      this.log(`drop ${message.t}: old generation ${gen} < ${this.generation}`);
      return false;
    }
    if (gen > this.generation) this.generation = gen;
    if (message.t === 'snapshot' || message.t === 'update') {
      if (isNewerStateOrder(this.generation, this.shadow.seq, gen, message.seq)) return true;
      const fill = message.t === 'snapshot' && !this.shadow.state && message.seq === this.shadow.seq;
      if (!fill) this.log(`drop ${message.t}: stale/duplicate seq ${message.seq} (have ${this.shadow.seq})`);
      return fill;
    }
    return true;
  }

  private handleControl(from: string, control: P2PControl, fingerprint: string): void {
    switch (control.k) {
      case 'probe':
        if (this.role === 'host') {
          void this.transport?.send(from, { k: 'probeAck', at: Date.now() });
        }
        return;
      case 'presence':
        if (this.role === 'host' && this.peerKeys.get(from) !== fingerprint) return;
        this.peerSeen.set(control.peerId, Date.now());
        if (this.role === 'host') this.guestSeen.set(from, Date.now());
        return;
      case 'hb':
      case 'host': {
        if (this.role === 'host') {
          if (control.gen > this.generation) this.stepDownToGuest(control, fingerprint);
          return;
        }
        if (control.k === 'hb') this.handleHostHeartbeat(control, fingerprint);
        else this.switchHost(control, fingerprint);
        return;
      }
      case 'bye':
        if (this.role === 'host') {
          this.guestSeen.delete(from);
          this.controller?.disconnect(from);
        } else if (from === this.hostPeerId) {
          this.lastHostHeartbeatAt = 0;
          this.setState('reconnecting');
          this.watchdog();
        }
        return;
      case 'probeAck':
        return;
      case 'resync':
        if (this.role === 'host' && this.peerKeys.get(from) === fingerprint) {
          this.controller?.resync(from);
        }
        return;
      default:
        return;
    }
  }

  private trustedSeatKey(seat: number): string | null {
    const fromController =
      this.role === 'host' && this.controller
        ? this.controller.publicSnapshot().seatKeys[String(seat)]
        : undefined;
    if (fromController) return fromController;
    return this.shadow.seatKeys[String(seat)] ?? null;
  }

  private handleHostHeartbeat(control: Extract<P2PControl, { k: 'hb' }>, fingerprint: string): void {
    if (control.hostPeerId === this.clientId) return;
    if (control.hostSeat === null) return;
    const expected = this.trustedSeatKey(control.hostSeat);
    const trusted = expected === null || expected === fingerprint;
    if (!trusted) {
      this.log(`drop heartbeat from ${control.hostPeerId}: host seat key mismatch`);
      return;
    }
    if (control.gen < this.generation) {
      this.log(`drop heartbeat from ${control.hostPeerId}: old generation ${control.gen}`);
      return;
    }
    const switching = this.hostPeerId !== control.hostPeerId;
    if (switching && control.gen === this.generation) {
      this.log(`drop heartbeat from ${control.hostPeerId}: same generation, different host`);
      return;
    }
    if (switching) {
      this.hostPeerId = control.hostPeerId;
      this.hostKeyFingerprint = fingerprint;
      this.generation = control.gen;
      this.setState('reconnecting');
      this.sendHello();
    } else if (this.hostKeyFingerprint === null) {
      this.hostKeyFingerprint = fingerprint;
    }
    this.lastHostHeartbeatAt = Date.now();
    this.hostSeat = control.hostSeat;
    this.shadow.hostSeat = control.hostSeat;
    this.shadow.seatKeys = { ...control.seatKeys };
    this.lastLobby = control.lobby;
    this.shadow.lobby = control.lobby;
    if (control.broker) this.hostBroker = control.broker;
    const ownSeat = Object.keys(control.seatKeys).find(
      (seatIndex) => control.seatKeys[seatIndex] === this.identity?.fingerprint,
    );
    if (ownSeat !== undefined) this.seat = Number(ownSeat);
    if (this.pendingAction && control.seq > this.pendingAction.seq) this.pendingAction = null;
    if (!this.lastWelcome || this.connectionState !== 'open') this.sendHello();
    this.maybeResync(control.hostPeerId, control.seq);
  }

  private switchHost(control: Extract<P2PControl, { k: 'host' }>, fingerprint: string): void {
    if (control.hostPeerId === this.clientId) return;
    if (control.hostSeat === null || control.gen < this.generation) return;
    const expected = this.trustedSeatKey(control.hostSeat);
    if (expected !== null && expected !== fingerprint) {
      this.log(`drop host announcement from ${control.hostPeerId}: seat key mismatch`);
      return;
    }
    if (control.hostPeerId === this.hostPeerId && control.gen === this.generation) {
      this.lastHostHeartbeatAt = Date.now();
      return;
    }
    this.hostPeerId = control.hostPeerId;
    this.hostSeat = control.hostSeat;
    this.hostKeyFingerprint = fingerprint;
    this.generation = control.gen;
    this.lastHostHeartbeatAt = Date.now();
    this.shadow.hostSeat = control.hostSeat;
    this.shadow.seatKeys = { ...control.seatKeys };
    this.lastLobby = control.lobby;
    this.shadow.lobby = control.lobby;
    if (control.broker) this.hostBroker = control.broker;
    this.setState('reconnecting');
    this.sendHello();
    setTimeout(() => this.maybeResync(control.hostPeerId, control.seq), 100);
  }

  private stepDownToGuest(control: Extract<P2PControl, { k: 'hb' | 'host' }>, fingerprint: string): void {
    if (control.hostSeat === null) return;
    const expected = this.trustedSeatKey(control.hostSeat);
    if (expected !== null && expected !== fingerprint) return;
    this.controller?.dispose();
    this.controller = null;
    this.role = 'guest';
    this.hostPeerId = control.hostPeerId;
    this.hostKeyFingerprint = fingerprint;
    this.generation = control.gen;
    this.hostSeat = control.hostSeat;
    this.shadow.seatKeys = { ...control.seatKeys };
    this.lastLobby = control.lobby;
    this.shadow.lobby = control.lobby;
    storageRemove('session', HOST_SAVE_KEY);
    this.setState('reconnecting');
    this.sendHello();
  }

  private stampHostMessage(message: ServerMsg): ServerMsg {
    if (
      message.t === 'welcome' ||
      message.t === 'lobby' ||
      message.t === 'snapshot' ||
      message.t === 'update'
    ) {
      return { ...message, gen: this.generation };
    }
    return message;
  }

  private maybeResync(hostPeerId: string, hostSeq: number): void {
    if (this.role !== 'guest' || !this.transport) return;
    const playing = this.shadow.lobby?.status === 'playing' || this.shadow.lobby?.status === 'finished';
    if (hostSeq <= this.shadow.seq && !(playing && !this.shadow.state)) return;
    const now = Date.now();
    if (now - this.lastResyncAt < 1_000) return;
    this.lastResyncAt = now;
    void this.transport.send(hostPeerId, { k: 'resync' });
  }

  private onTransportStatus(status: TransportStatus): void {
    if (this.closed || this.crashed) return;
    if (status === 'open') {
      if (this.role === 'host') {
        this.setState('open');
        this.sendHeartbeat();
      } else {
        this.sendHello();
        this.broadcastPresence();
      }
      this.flushQueue();
      return;
    }
    if (status === 'reconnecting' || status === 'closed') {
      this.setState(status === 'closed' ? 'closed' : 'reconnecting');
    }
  }

  // ---------------------------------------------------------------- host/guest outbound helpers

  private sendHello(): void {
    if (this.role !== 'guest' || !this.transport || this.transport.status() !== 'open') return;
    const hello: ClientMsg = {
      t: 'hello',
      v: PROTOCOL_VERSION,
      roomId: this.roomId,
      name: this.name,
      token: this.identity?.fingerprint ?? this.clientId,
      pub: this.identity ? JSON.stringify(this.identity.publicJwk) : undefined,
    };
    if (this.hostPeerId) void this.transport.send(this.hostPeerId, hello);
    else void this.transport.broadcast(hello);
  }

  private flushQueue(): void {
    if (!this.hostPeerId || !this.transport || this.transport.status() !== 'open') return;
    const queued = this.queue;
    this.queue = [];
    for (const message of queued) void this.transport.send(this.hostPeerId, message);
  }

  private sendHeartbeat(): void {
    if (this.role !== 'host' || !this.controller || !this.transport) return;
    if (this.transport.status() !== 'open') return;
    const snapshot = this.controller.publicSnapshot();
    const heartbeat: P2PControl = {
      k: 'hb',
      hostPeerId: this.clientId,
      seat: this.seat,
      hostSeat: snapshot.hostSeat,
      seatKeys: snapshot.seatKeys,
      lobby: snapshot.lobby,
      seq: snapshot.seq,
      gen: this.generation,
      broker: this.transport.broker(),
      at: Date.now(),
    };
    void this.transport.broadcast(heartbeat);
  }

  private broadcastPresence(): void {
    if (this.role !== 'guest' || !this.transport || this.transport.status() !== 'open') return;
    void this.transport.broadcast({
      k: 'presence',
      peerId: this.clientId,
      seat: this.seat,
      at: Date.now(),
    });
  }

  private announceHost(): void {
    if (this.role !== 'host' || !this.controller || !this.transport) return;
    const snapshot = this.controller.publicSnapshot();
    void this.transport.broadcast({
      k: 'host',
      hostPeerId: this.clientId,
      seat: this.seat,
      hostSeat: snapshot.hostSeat,
      seatKeys: snapshot.seatKeys,
      lobby: snapshot.lobby,
      seq: snapshot.seq,
      gen: this.generation,
      broker: this.transport.broker(),
      at: Date.now(),
    });
  }

  private afterHostMessage(message: ClientMsg | ServerMsg): void {
    if (this.role !== 'host') return;
    if ('t' in message && (message.t === 'welcome' || message.t === 'lobby' || message.t === 'snapshot')) {
      this.sendHeartbeat();
    }
    if ('t' in message && (message.t === 'update' || message.t === 'snapshot' || message.t === 'lobby')) {
      this.scheduleHostSave();
    }
  }

  // ---------------------------------------------------------------- timers / migration

  private startTimers(): void {
    this.stopTimers();
    const heartbeatMs = networkConfig.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.heartbeatTimer = setInterval(() => {
      if (this.role === 'host') {
        this.sendHeartbeat();
      } else {
        this.broadcastPresence();
      }
    }, heartbeatMs);
    this.watchdogTimer = setInterval(
      () => this.watchdog(),
      Math.max(150, Math.min(heartbeatMs, networkConfig.hostSilenceMs ?? DEFAULT_HOST_SILENCE_MS) / 3),
    );
  }

  private stopTimers(): void {
    clearHandle(this.heartbeatTimer);
    clearHandle(this.watchdogTimer);
    clearHandle(this.saveTimer);
    this.clearWelcomeWatchdog();
    this.heartbeatTimer = null;
    this.watchdogTimer = null;
    this.saveTimer = null;
  }

  private watchdog(): void {
    if (this.closed || this.crashed) return;
    const now = Date.now();
    if (this.role === 'host') {
      const peerSilence = networkConfig.peerSilenceMs ?? DEFAULT_PEER_SILENCE_MS;
      for (const [peerId, seen] of [...this.guestSeen]) {
        if (now - seen <= peerSilence) continue;
        this.guestSeen.delete(peerId);
        this.controller?.disconnect(peerId);
      }
      return;
    }
    this.retryPendingGuestOps(now);
    const hostSilence = networkConfig.hostSilenceMs ?? DEFAULT_HOST_SILENCE_MS;
    if (!this.hostPeerId || !this.shadow.lobby) return;
    if (now - this.lastHostHeartbeatAt <= hostSilence) return;
    this.setState('reconnecting');
    if (this.promoting) return;
    if (this.isLowestAliveHuman(now)) this.promoteToHost();
  }

  /**
   * MQTT is QoS1, but public brokers still occasionally lose a packet. Lobby requests and the
   * current action are idempotent at the protocol level (repeat take_seat re-sends welcome, repeat
   * action on the same seq is applied once and then stale), so retry until observed.
   */
  private retryPendingGuestOps(now: number): void {
    if (this.role !== 'guest' || this.closed || this.crashed) return;
    if (now - this.lastLobbyRetryAt >= 800) {
      this.lastLobbyRetryAt = now;
      if (this.pendingSeat !== null) {
        this.deliverToHost({ t: 'take_seat', index: this.pendingSeat });
      }
      if (this.pendingCharacter !== null && this.seat !== null) {
        const own = this.shadow.lobby?.seats[this.seat];
        if (own?.characterId !== this.pendingCharacter) {
          this.deliverToHost({ t: 'pick_character', characterId: this.pendingCharacter });
        }
      }
    }
    if (
      this.pendingAction &&
      this.shadow.seq === this.pendingAction.seq &&
      now - this.pendingAction.sentAt >= 1_000
    ) {
      this.pendingAction.sentAt = now;
      this.deliverToHost({ t: 'action', seq: this.pendingAction.seq, action: this.pendingAction.action });
    }
  }

  private isLowestAliveHuman(now: number): boolean {
    if (this.seat === null || !this.shadow.lobby) return false;
    const peerSilence = networkConfig.peerSilenceMs ?? DEFAULT_PEER_SILENCE_MS;
    const alive = new Set<string>();
    if (this.identity) alive.add(this.identity.fingerprint);
    for (const [peerId, seen] of this.peerSeen) {
      if (now - seen > peerSilence) continue;
      const fingerprint = this.peerKeys.get(peerId);
      if (fingerprint) alive.add(fingerprint);
    }
    const candidates = this.shadow.lobby.seats
      .filter((seat) => seat.kind === 'human')
      .filter((seat) => {
        const token = this.shadow.seatKeys[String(seat.index)];
        return !!token && alive.has(token);
      })
      .map((seat) => seat.index)
      .sort((a, b) => a - b);
    return candidates.length > 0 && candidates[0] === this.seat;
  }

  private promoteToHost(): void {
    if (this.role !== 'guest' || this.promoting || !this.shadow.lobby || this.seat === null) return;
    this.promoting = true;
    try {
      const snapshot: RoomPublicSnapshot = {
        roomId: this.roomId,
        lobby: this.shadow.lobby,
        state: this.shadow.state,
        seq: this.shadow.seq,
        chat: this.shadow.chat,
        hostSeat: this.seat,
        seatKeys: this.shadow.seatKeys,
        lastFx: this.shadow.lastFx,
        deadline: this.shadow.deadline,
      };
      const deps = this.hostDeps();
      this.controller = RoomController.adopt(snapshot, deps);
      this.role = 'host';
      this.generation = Math.max(1, this.generation) + 1;
      this.hostPeerId = this.clientId;
      this.hostKeyFingerprint = this.identity?.fingerprint ?? null;
      this.hostSeat = this.seat;
      for (const peerId of this.peerSeen.keys()) {
        if (peerId !== this.clientId) this.guestSeen.set(peerId, Date.now());
      }
      this.controller.connect(this.loopbackId);
      this.controller.message(this.loopbackId, {
        t: 'hello',
        v: PROTOCOL_VERSION,
        roomId: this.roomId,
        name: this.name,
        token: this.identity?.fingerprint ?? this.clientId,
        pub: this.identity ? JSON.stringify(this.identity.publicJwk) : undefined,
      });
      this.setState('open');
      this.announceHost();
      this.sendHeartbeat();
      this.persistHostNow();
      // Old guests re-hello; also actively ping everyone we know about.
      for (const peerId of this.peerSeen.keys()) {
        if (peerId !== this.clientId) void this.transport?.send(peerId, { k: 'presence', peerId: this.clientId, seat: this.seat, at: Date.now() });
      }
    } catch (error) {
      this.log('host migration failed', error);
    } finally {
      this.promoting = false;
    }
  }

  // ---------------------------------------------------------------- server messages / replay

  private onServerMsg(message: ServerMsg): void {
    this.record(message);
    for (const listener of this.listeners) listener(message);
    if (this.role === 'host') {
      this.afterHostMessage(message);
    }
  }

  private record(message: ServerMsg): void {
    const gen = genOf(message);
    if (gen !== undefined && gen > this.generation) this.generation = gen;
    switch (message.t) {
      case 'welcome':
        this.lastWelcome = message;
        this.lastLobby = message.lobby;
        this.seat = message.seat;
        if (this.pendingSeat !== null && message.seat === this.pendingSeat) this.pendingSeat = null;
        if (message.seat !== null) {
          const own = message.lobby.seats[message.seat];
          if (this.pendingCharacter && own?.characterId === this.pendingCharacter) {
            this.pendingCharacter = null;
          }
        }
        this.shadow.lobby = message.lobby;
        this.shadow.chat = [...message.chat].slice(-COMM.historySize);
        if (this.role === 'guest') this.hostSeat = message.lobby.seats.find((seat) => seat.isHost)?.index ?? this.hostSeat;
        break;
      case 'lobby':
        this.lastLobby = message.lobby;
        this.shadow.lobby = message.lobby;
        if (this.pendingCharacter && this.seat !== null) {
          const own = message.lobby.seats[this.seat];
          if (own?.characterId === this.pendingCharacter) this.pendingCharacter = null;
        }
        if (this.role === 'guest') this.hostSeat = message.lobby.seats.find((seat) => seat.isHost)?.index ?? this.hostSeat;
        break;
      case 'snapshot':
        this.lastSnapshot = message;
        this.lastLobby = message.lobby;
        this.seat = message.lobby.seats.find((seat) => seat.index === this.seat)?.index ?? this.seat;
        this.shadow.lobby = message.lobby;
        this.shadow.state = message.state;
        this.shadow.seq = message.seq;
        this.shadow.deadline = message.deadline;
        if (this.pendingAction && message.seq > this.pendingAction.seq) this.pendingAction = null;
        break;
      case 'update':
        this.lastUpdate = message;
        this.shadow.state = message.state;
        this.shadow.seq = message.seq;
        this.shadow.deadline = message.deadline;
        this.shadow.lastFx = message.fx;
        if (this.pendingAction && message.seq > this.pendingAction.seq) this.pendingAction = null;
        break;
      case 'error':
        if (
          message.code === 'illegal' ||
          message.code === 'stale' ||
          message.code === 'not_your_turn'
        ) {
          this.pendingAction = null;
        }
        if (message.code === 'room_full' || message.code === 'already_started') {
          this.pendingSeat = null;
        }
        if (message.code === 'character_taken' || message.code === 'already_started') {
          this.pendingCharacter = null;
        }
        break;
      case 'chat':
        this.shadow.chat.push(message.line);
        if (this.shadow.chat.length > COMM.historySize) {
          this.shadow.chat.splice(0, this.shadow.chat.length - COMM.historySize);
        }
        break;
      default:
        break;
    }
    if (this.role === 'host' && (message.t === 'update' || message.t === 'snapshot' || message.t === 'lobby')) {
      this.scheduleHostSave();
    }
  }

  private replay(listener: (msg: ServerMsg) => void): void {
    if (this.lastWelcome) listener(this.lastWelcome);
    if (!this.lastSnapshot && !this.lastUpdate && this.lastLobby) {
      listener({ t: 'lobby', lobby: this.lastLobby });
      return;
    }
    if (this.lastSnapshot) listener(this.lastSnapshot);
    if (this.lastUpdate && (!this.lastSnapshot || this.lastUpdate.seq > this.lastSnapshot.seq)) {
      listener(this.lastUpdate);
    }
  }

  // ---------------------------------------------------------------- persistence

  private scheduleHostSave(): void {
    if (this.role !== 'host' || this.closed || this.crashed) return;
    if (this.saveTimer !== null) return;
    const delay = networkConfig.saveThrottleMs ?? 150;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.persistHostNow();
    }, delay);
  }

  private persistHostNow(): void {
    if (this.role !== 'host' || !this.controller || this.closed || this.crashed) return;
    try {
      const save: HostSave = {
        roomId: this.roomId,
        name: this.name,
        snapshot: this.controller.serialize(),
        generation: this.generation,
        savedAt: Date.now(),
      };
      storageSet('session', HOST_SAVE_KEY, JSON.stringify(save));
    } catch (error) {
      this.log('host save failed', error);
    }
  }

  private setState(next: ConnectionState): void {
    if (this.connectionState === next) return;
    this.connectionState = next;
    for (const listener of this.connectionListeners) listener(next);
  }

  private log(message: string, detail?: unknown): void {
    if (detail === undefined) console.warn(`[online ${this.roomId}] ${message}`);
    else console.warn(`[online ${this.roomId}] ${message}`, detail);
  }
}

// ---------------------------------------------------------------- public factories

export async function createOnlineRoom(name: string): Promise<Session> {
  return OnlineSession.host(name);
}

export function joinOnlineRoom(roomId: string, name: string): Session {
  const normalized = normalizeRoomId(roomId);
  if (!isValidRoomId(normalized)) throw new Error('ルーム ID は 6 文字＋4 文字の合言葉です');
  return OnlineSession.guest(normalized, name);
}

export async function roomExists(roomId: string): Promise<boolean> {
  const normalized = normalizeRoomId(roomId);
  if (!isValidRoomId(normalized)) return false;
  const peerId = `probe_${randomToken(10)}`;
  // Load (or create once) the persistent identity. Generating a fresh one here
  // overwrote `fable.identity`, so the subsequent real join/rejoin used a new
  // fingerprint and could not reclaim its seat.
  const identity = await loadIdentity('room-probe');
  const transport = new MqttTransport(peerId, {
    identity,
    brokers: networkConfig.brokers ?? DEFAULT_BROKERS,
    disableWebRtc: true,
    connectTimeoutMs: networkConfig.connectTimeoutMs,
    log: () => {},
  });
  const found = Promise.withResolvers<boolean>();
  const timer = setTimeout(() => found.resolve(false), networkConfig.probeTimeoutMs ?? PROBE_TIMEOUT_MS);
  const unsubscribe = transport.onMessage((_from, message) => {
    if (isP2PControl(message) && message.k === 'probeAck') found.resolve(true);
  });
  const probeWork = (async (): Promise<boolean> => {
    try {
      await transport.connect(normalized);
      await transport.broadcast({ k: 'probe', at: Date.now() });
      return await found.promise;
    } catch {
      return false;
    }
  })();
  try {
    return await Promise.race([probeWork, found.promise]);
  } finally {
    clearTimeout(timer);
    unsubscribe();
    await transport.close();
  }
}

export function resumeOnline(): Session | null {
  try {
    const hostSave = parseHostSave(storageGet('session', HOST_SAVE_KEY));
    if (hostSave && isValidRoomId(normalizeRoomId(hostSave.roomId))) {
      return OnlineSession.resumeHost(hostSave);
    }
  } catch {
    // fall through to guest resume
  }
  try {
    const guestSave = parseGuestSave(storageGet('local', GUEST_SAVE_KEY));
    if (guestSave && isValidRoomId(normalizeRoomId(guestSave.roomId))) {
      return joinOnlineRoom(guestSave.roomId, guestSave.name);
    }
  } catch {
    // ignore corrupt save
  }
  return null;
}

/** Test hook: current full host state for a migration/old-host-return scenario. */
export function checkpointHostForTests(session: Session): HostCheckpoint | null {
  return session instanceof OnlineSession ? session.hostCheckpoint() : null;
}

export function resumeHostForTests(checkpoint: HostCheckpoint): Session {
  return OnlineSession.resumeFromCheckpoint(checkpoint);
}

/** Test hook used by the in-process broker e2e: kill a session's transport without a leave. */
export function killSessionForTests(session: Session): void {
  if (session instanceof OnlineSession) session.killForTests();
}

/** Reports persisted by the host device (settings screen export). */
export function exportReports(): string {
  return storageGet('local', REPORTS_KEY) ?? '[]';
}