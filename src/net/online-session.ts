// Serverless online play.
//
// There is no game server: the HOST'S BROWSER runs the authoritative RoomController. Guests talk to
// it over encrypted public MQTT and, when possible, an automatic WebRTC DataChannel. Every client
// keeps a public snapshot; if the host disappears for 10 seconds the lowest-index connected human
// seat adopts the room and continues with a fresh crypto-random rng seed.

import type { Action, GameData, GameState } from '../core/types';
import type { RoomDeps } from './room';
import { RoomController } from './room';
import type { RoomPublicSnapshot } from './room';
import type {
  ChatLine,
  ClientMsg,
  LobbyView,
  Report,
  ServerMsg,
} from './protocol';
import { COMM, PROTOCOL_VERSION } from './protocol';
import type { ConnectionState, Session } from './session-types';
import { GAME_DATA } from '../data/index';
import { MqttTransport, DEFAULT_BROKERS, isP2PControl } from './p2p/transport';
import type { P2PControl, P2PMessage, TransportStatus } from './p2p/transport';

const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
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
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  let id = '';
  for (let i = 0; i < 6; i += 1) id += ROOM_ALPHABET[bytes[i] % ROOM_ALPHABET.length];
  return id;
}

function normalizeRoomId(raw: string): string {
  return raw.trim().toUpperCase();
}

function isValidRoomId(roomId: string): boolean {
  return /^[A-Z0-9]{6}$/.test(roomId);
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
  savedAt: number;
}

interface GuestSave {
  roomId: string;
  name: string;
}

interface Shadow {
  lobby: LobbyView | null;
  state: GameState | null;
  seq: number;
  chat: ChatLine[];
  seatTokens: Record<string, string>;
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
    seatTokens: {},
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
  private seat: number | null = null;
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
    void session.beginHost(save.snapshot).catch(() => {
      session.fail();
    });
    return session;
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

  private async beginHost(saved?: string): Promise<void> {
    this.role = 'host';
    this.hostPeerId = this.clientId;
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
      token: this.clientId,
    });
    this.hostSeat = this.controller.publicSnapshot().hostSeat;

    const transport = this.createTransport();
    this.transport = transport;
    transport.onMessage((from, message) => this.onTransportMessage(from, message));
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
        if (connId === this.loopbackId) {
          this.onServerMsg(msg);
          return;
        }
        void this.transport?.send(connId, msg);
        this.afterHostMessage(msg);
      },
      broadcast: (msg) => {
        this.onServerMsg(msg);
        void this.transport?.broadcast(msg);
      },
      log: (message, detail) => this.log(message, detail),
      report: (report) => {
        this.reports.push(report);
        if (this.reports.length > 100) this.reports.shift();
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
    this.setState('connecting');
    const transport = this.createTransport();
    this.transport = transport;
    transport.onMessage((from, message) => this.onTransportMessage(from, message));
    transport.onStatus((status) => this.onTransportStatus(status));
    try {
      await transport.connect(this.roomId);
      this.startTimers();
    } catch (error) {
      this.log('guest broker connection failed', error);
      this.setState('reconnecting');
    }
  }

  private createTransport(): MqttTransport {
    const transport = new MqttTransport(this.clientId, {
      brokers: networkConfig.brokers ?? DEFAULT_BROKERS,
      disableWebRtc: networkConfig.disableWebRtc,
      connectTimeoutMs: networkConfig.connectTimeoutMs,
      log: (message, detail) => this.log(message, detail),
    });
    transportRegistry.set(this, transport);
    return transport;
  }

  // ---------------------------------------------------------------- transport inbound

  private onTransportMessage(from: string, message: P2PMessage): void {
    if (this.crashed || this.closed) return;
    this.peerSeen.set(from, Date.now());
    if (isP2PControl(message)) {
      this.handleControl(from, message);
      return;
    }
    if (this.role === 'host') {
      if (!this.controller || !isClientMsg(message)) return;
      this.guestSeen.set(from, Date.now());
      this.controller.connect(from);
      this.controller.message(from, message);
      this.afterHostMessage(message);
      return;
    }
    if (!isServerMsg(message)) return;
    if (this.hostPeerId && from !== this.hostPeerId) return;
    if (!this.hostPeerId) this.hostPeerId = from;
    if (message.t === 'welcome') {
      this.hostPeerId = from;
      this.lastHostHeartbeatAt = Date.now();
      this.setState('open');
      this.flushQueue();
    }
    this.onServerMsg(message);
    if (message.t === 'welcome' || message.t === 'snapshot') this.broadcastPresence();
  }

  private handleControl(from: string, control: P2PControl): void {
    switch (control.k) {
      case 'probe':
        if (this.role === 'host') {
          void this.transport?.send(from, { k: 'probeAck', at: Date.now() });
        }
        return;
      case 'presence':
        this.peerSeen.set(control.peerId, Date.now());
        if (this.role === 'host') this.guestSeen.set(from, Date.now());
        return;
      case 'hb':
        if (this.role !== 'guest') return;
        this.handleHostHeartbeat(control);
        return;
      case 'host':
        if (this.role !== 'guest') return;
        this.switchHost(control);
        return;
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
        if (this.role === 'host') this.controller?.resync(from);
        return;
      default:
        return;
    }
  }

  private handleHostHeartbeat(control: Extract<P2PControl, { k: 'hb' }>): void {
    if (control.hostPeerId === this.clientId) return;
    const now = Date.now();
    const knownHost = this.hostPeerId !== null;
    const stale = now - this.lastHostHeartbeatAt > (networkConfig.hostSilenceMs ?? DEFAULT_HOST_SILENCE_MS);
    if (knownHost && this.hostPeerId !== control.hostPeerId && !stale) return; // ignore a returning old host
    if (!knownHost || this.hostPeerId !== control.hostPeerId) {
      this.hostPeerId = control.hostPeerId;
      this.setState('reconnecting');
      this.sendHello();
    }
    this.lastHostHeartbeatAt = now;
    this.hostSeat = control.hostSeat;
    this.shadow.hostSeat = control.hostSeat;
    this.shadow.seatTokens = { ...control.seatTokens };
    this.lastLobby = control.lobby;
    this.shadow.lobby = control.lobby;
    const ownSeat = Object.keys(control.seatTokens).find(
      (seatIndex) => control.seatTokens[seatIndex] === this.clientId,
    );
    if (ownSeat !== undefined) this.seat = Number(ownSeat);
    if (this.pendingAction && control.seq > this.pendingAction.seq) this.pendingAction = null;
    if (!this.lastWelcome || this.connectionState !== 'open') this.sendHello();
    this.maybeResync(control.hostPeerId, control.seq);
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

  private switchHost(control: Extract<P2PControl, { k: 'host' }>): void {
    if (control.hostPeerId === this.clientId) return;
    const changed = this.hostPeerId !== control.hostPeerId;
    this.hostPeerId = control.hostPeerId;
    this.hostSeat = control.hostSeat;
    this.lastHostHeartbeatAt = Date.now();
    this.shadow.hostSeat = control.hostSeat;
    this.shadow.seatTokens = { ...control.seatTokens };
    this.lastLobby = control.lobby;
    this.shadow.lobby = control.lobby;
    if (changed) {
      this.setState('reconnecting');
      this.sendHello();
      // If the new host is already ahead, ask for a snapshot once the hello is processed.
      setTimeout(() => this.maybeResync(control.hostPeerId, control.seq), 100);
    }
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
      token: this.clientId,
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
      seatTokens: snapshot.seatTokens,
      lobby: snapshot.lobby,
      seq: snapshot.seq,
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
      seatTokens: snapshot.seatTokens,
      lobby: snapshot.lobby,
      seq: snapshot.seq,
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
    for (const [peerId, seen] of this.peerSeen) {
      if (peerId === this.clientId || now - seen <= peerSilence) alive.add(peerId);
    }
    const candidates = this.shadow.lobby.seats
      .filter((seat) => seat.kind === 'human')
      .filter((seat) => {
        const token = this.shadow.seatTokens[String(seat.index)];
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
        seatTokens: this.shadow.seatTokens,
        lastFx: this.shadow.lastFx,
        deadline: this.shadow.deadline,
      };
      const deps = this.hostDeps();
      this.controller = RoomController.adopt(snapshot, deps);
      this.role = 'host';
      this.hostPeerId = this.clientId;
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
        token: this.clientId,
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
  if (!isValidRoomId(normalized)) throw new Error('ルーム ID は 6 文字の英数字です');
  return OnlineSession.guest(normalized, name);
}

export async function roomExists(roomId: string): Promise<boolean> {
  const normalized = normalizeRoomId(roomId);
  if (!isValidRoomId(normalized)) return false;
  const peerId = `probe_${randomToken(10)}`;
  const transport = new MqttTransport(peerId, {
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

/** Test hook used by the in-process broker e2e: kill a session's transport without a leave. */
export function killSessionForTests(session: Session): void {
  if (session instanceof OnlineSession) session.killForTests();
}