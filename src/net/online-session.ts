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
  ServerMsg,
} from './protocol';
import { COMM, PROTOCOL_VERSION } from './protocol';
import type { ConnectionState, Session } from './session-types';
import { GAME_DATA } from '../data/index';
import { BOARD_VERSION } from './board-version';
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
const HOST_PROBE_MS = 3_000;
const HOST_GONE_MS = 15_000;
const SELF_HOST_GRACE_MS = 10_000;
const REAUTH_SILENCE_MS = 10_000;

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
  /** How long a guest probes before takeover, and how old the host must look. */
  probeMs?: number;
  hostGoneMs?: number;
  selfHostGraceMs?: number;
}

let networkConfig: NetworkConfig = {};

/** Test seam: point sessions at an in-process broker and shorten heartbeat timers. */
export function configureNetworkForTests(config: NetworkConfig = {}): void {
  networkConfig = { ...config };
}

const transportRegistry = new WeakMap<Session, MqttTransport>();
const discoveredBroker = new Map<string, string>();

/** Current pinned/own host public-key fingerprint (full SHA-256 hex). */
export function hostKeyFingerprintForSession(session: Session): string | null {
  return session instanceof OnlineSession ? session.hostKeyForInvite() : null;
}

/** Invite URL carrying the host fingerprint prefix so guests can pin it before joining. */
export function inviteUrl(session: Session): string | null {
  if (!(session instanceof OnlineSession) || session.mode !== 'online') return null;
  const fingerprint = hostKeyFingerprintForSession(session);
  if (!fingerprint || typeof location === 'undefined') return null;
  const base = new URL(location.href);
  base.search = '';
  base.hash = '';
  base.searchParams.set('room', session.roomId);
  base.searchParams.set('k', fingerprint.slice(0, 16));
  return base.toString();
}

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

type HostClaim = Extract<P2PControl, { k: 'hb' | 'host' }>;

function connectedHumans(lobby: LobbyView | null): number {
  return lobby?.seats.filter((seat) => seat.kind === 'human' && seat.connected).length ?? 0;
}

/** Conflict resolution ignores generation: higher seq, then more connected humans, then lower peer id. */
function claimBeats(incoming: HostClaim, current: HostClaim): boolean {
  if (incoming.seq !== current.seq) return incoming.seq > current.seq;
  const incomingConnected = incoming.connectedHumans ?? connectedHumans(incoming.lobby);
  const currentConnected = current.connectedHumans ?? connectedHumans(current.lobby);
  if (incomingConnected !== currentConnected) return incomingConnected > currentConnected;
  return incoming.hostPeerId < current.hostPeerId;
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
  reportVotes: Record<string, string[]>;
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
    reportVotes: {},
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

function readHostKeyHint(roomId: string): string | null {
  try {
    if (typeof location !== 'undefined') {
      const url = new URL(location.href);
      const query = url.searchParams.get('k');
      const hash = new URLSearchParams(url.hash.replace(/^#/, '')).get('k');
      const hint = query ?? hash;
      if (hint && /^[0-9a-f]{8,64}$/i.test(hint)) return hint.toLowerCase();
    }
  } catch {
    // ignore malformed URL
  }
  return storageGet('local', `fable.hostkey.${roomId}`);
}

function rememberHostKey(roomId: string, fingerprint: string): void {
  storageSet('local', `fable.hostkey.${roomId}`, fingerprint);
}

function readReports(): unknown[] {
  const raw = storageGet('local', REPORTS_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
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
  private shadowGeneration = 0;
  private hostKeyFingerprint: string | null = null;
  private expectedHostFingerprint: string | null = null;
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
  private probeStartedAt = 0;
  private promotedAt = 0;
  private hostFollowers = new Set<string>();
  private lastCompeting: { control: HostClaim; fingerprint: string; at: number } | null = null;
  private inboundBlockedForTests = false;
  private authorityReady = true;
  private requiredAcks = 0;
  private ackKeys = new Set<string>();
  private frozenActions: { from: string; message: ClientMsg }[] = [];
  private frozenLocalActions: ClientMsg[] = [];
  private lastAckGen = -1;
  private lastAckAt = 0;
  private quorumOk = true;
  private quorumMessageShown = false;
  private reportVoteSeq = 0;
  private pendingVotes = new Map<string, { control: Extract<P2PControl, { k: 'report_vote' }>; sentAt: number; attempts: number }>();
  private lastServerAt = Date.now();
  private lastLivenessAt = Date.now();
  private lastReauthAt = 0;
  private visibilityHandler: (() => void) | null = null;
  private lastResyncAt = 0;
  private pendingSeat: number | null = null;
  private pendingCharacter: string | null = null;
  private pendingAction: { gen: number; seq: number; action: Action; sentAt: number } | null = null;
  private lastLobbyRetryAt = 0;

  private lastWelcome: Extract<ServerMsg, { t: 'welcome' }> | null = null;
  private lastLobby: LobbyView | null = null;
  private lastSnapshot: Extract<ServerMsg, { t: 'snapshot' }> | null = null;
  private lastUpdate: Extract<ServerMsg, { t: 'update' }> | null = null;

  private constructor(roomId: string, name: string, role: 'host' | 'guest') {
    this.roomId = normalizeRoomId(roomId);
    this.name = name.trim().slice(0, 16) || 'プレイヤー';
    this.role = role;
    this.clientId = clientIdFor(this.name);
    this.hostBroker = discoveredBroker.get(this.roomId) ?? null;
    this.expectedHostFingerprint = readHostKeyHint(this.roomId);
    this.peerSeen.set(this.clientId, Date.now());
    if (typeof document !== 'undefined') {
      this.visibilityHandler = () => {
        if (document.visibilityState !== 'visible' || this.closed || this.crashed) return;
        this.reauthenticate('visible', true);
      };
      document.addEventListener('visibilitychange', this.visibilityHandler);
    }
  }

  /**
   * Liveness and state sync are separate: heartbeats already prove the host is alive, so only a
   * genuine silence (no heartbeat/state for REAUTH_SILENCE_MS) re-hellos. A hello on the same
   * connection must not be sent just because the board has not changed for a while.
   */
  private reauthenticate(reason: string, force = false): void {
    const now = Date.now();
    if (!force && now - this.lastLivenessAt < REAUTH_SILENCE_MS) return;
    if (now - this.lastReauthAt < 3_000) return;
    this.lastReauthAt = now;
    this.lastLivenessAt = now;
    this.lastServerAt = now;
    this.log(`re-authenticating (${reason})`);
    if (this.role === 'guest') {
      this.sendHello();
    } else {
      this.sendHeartbeat();
      if (this.controller) this.controller.resync(this.loopbackId);
    }
  }

  /** Ask the host for a fresh snapshot without a new hello (does not disturb presence). */
  requestResync(): void {
    if (this.role === 'guest' && this.hostPeerId) {
      void this.transport?.send(this.hostPeerId, { k: 'resync' });
    }
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

  resyncPeerForTests(connId: string): void {
    this.controller?.resync(connId);
  }

  setInboundBlockedForTests(blocked: boolean): void {
    this.inboundBlockedForTests = blocked;
  }

  setBlockedPeersForTests(peerIds: readonly string[]): void {
    this.transport?.setBlockedPeersForTests(peerIds);
  }

  reportVotes(): Record<string, string[]> {
    return { ...this.shadow.reportVotes };
  }

  authorityInfo(): { ready: boolean; requiredAcks: number; acks: number; frozen: boolean } {
    return {
      ready: this.authorityReady,
      requiredAcks: this.requiredAcks,
      acks: this.ackKeys.size,
      frozen: !this.authorityReady && this.role === 'host',
    };
  }

  hostKeyForInvite(): string | null {
    return this.hostKeyFingerprint ?? this.identity?.fingerprint ?? null;
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
    if (msg.t === 'action') msg = { ...msg, gen: this.generation };
    if (this.role === 'host' && this.controller) {
      if (msg.t === 'action' && !this.authorityReady) {
        if (this.frozenLocalActions.length < 50) this.frozenLocalActions.push(msg);
        return;
      }
      this.controller.message(this.loopbackId, msg);
      if (msg.t === 'report') {
        this.replicateReport(msg.seat, this.identity?.fingerprint ?? this.clientId);
      }
      return;
    }
    if (this.role === 'guest') {
      if (msg.t === 'take_seat') {
        this.pendingSeat = msg.index;
        this.pendingCharacter = null;
      } else if (msg.t === 'pick_character') {
        this.pendingCharacter = msg.characterId;
      } else if (msg.t === 'action') {
        this.pendingAction = {
          gen: this.generation,
          seq: msg.seq,
          action: msg.action,
          sentAt: Date.now(),
        };
      } else if (msg.t === 'leave_seat' || msg.t === 'leave') {
        this.pendingSeat = null;
        this.pendingCharacter = null;
        this.pendingAction = null;
      }
    }
    this.deliverToHost(msg);
  }

  private deliverToHost(msg: ClientMsg): void {
    const transport = this.transport;
    if (
      this.hostPeerId &&
      transport &&
      (transport.status() === 'open' || transport.p2pPeers() > 0)
    ) {
      void transport.send(this.hostPeerId, msg);
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
    if (this.visibilityHandler && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.visibilityHandler = null;
    }
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
    if (this.visibilityHandler && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.visibilityHandler = null;
    }
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
    this.promotedAt = 0;
    this.hostFollowers.clear();
    this.lastCompeting = null;
    this.probeStartedAt = 0;
    this.authorityReady = true;
    this.requiredAcks = 0;
    this.ackKeys.clear();
    this.quorumOk = true;
    this.quorumMessageShown = false;
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
      boardVersion: BOARD_VERSION,
    });
    this.hostSeat = this.controller.publicSnapshot().hostSeat;

    const transport = this.createTransport();
    this.transport = transport;
    transport.onMessage((from, message, fingerprint) =>
      this.onTransportMessage(from, message, fingerprint),
    );
    transport.onStatus((status) => this.onTransportStatus(status));
    await transport.connect(this.roomId);
    if (transport.broker()) {
      this.hostBroker = transport.broker();
      discoveredBroker.set(this.roomId, transport.broker() as string);
    }
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
      report: (report) => appendReportEvidence(report),
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
    if (this.crashed || this.closed || this.inboundBlockedForTests) return;
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
      if (message.t === 'hello' && message.boardVersion !== BOARD_VERSION) {
        void this.transport?.send(from, {
          t: 'error',
          code: 'bad_version',
          message: 'ゲームのバージョンが違います。ページを再読み込みしてください',
        });
        return;
      }
      if (message.t === 'action' && message.gen !== this.generation) {
        void this.transport?.send(from, {
          t: 'error',
          code: 'stale',
          message: 'ホスト世代が変わりました。最新の状態から操作してください',
        });
        return;
      }
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
      const seated = Object.values(this.controller.publicSnapshot().seatKeys).includes(fingerprint);
      if (seated) this.hostFollowers.add(from);
      // A signed hello/chat/action from a seated peer proves it accepted this generation's host.
      if (seated && this.promotedAt > 0 && !this.authorityReady) {
        this.ackKeys.add(fingerprint);
        if (this.ackKeys.size >= this.requiredAcks) this.becomeAuthorityReady();
      }
      if (message.t === 'action' && !this.authorityReady) {
        if (this.frozenActions.length < 200) this.frozenActions.push({ from, message });
        return;
      }
      this.controller.connect(from);
      this.controller.message(from, message);
      if (message.t === 'report') this.replicateReport(message.seat, fingerprint);
      this.afterHostMessage(message);
      return;
    }
    if (!isServerMsg(message)) return;
    if (
      (message.t === 'welcome' || message.t === 'snapshot') &&
      message.boardVersion !== BOARD_VERSION
    ) {
      this.onServerMsg({
        t: 'error',
        code: 'bad_version',
        message: 'ゲームのバージョンが違います。ページを再読み込みしてください',
      });
      this.setState('closed');
      void this.transport?.close();
      return;
    }
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
    if (!this.hostPeerId) {
      const hint = this.expectedHostFingerprint;
      if (hint && !fingerprint.startsWith(hint)) {
        this.log('drop host welcome: invite/keychain fingerprint mismatch');
        return false;
      }
    }
    if (this.hostPeerId && this.hostPeerId !== from) return false;
    if (this.hostKeyFingerprint && this.hostKeyFingerprint !== fingerprint) {
      this.log(`drop host message from ${from}: signing key changed without a generation bump`);
      return false;
    }
    if (!this.hostPeerId) this.hostPeerId = from;
    if (!this.hostKeyFingerprint) {
      this.hostKeyFingerprint = fingerprint;
      this.expectedHostFingerprint = fingerprint;
      rememberHostKey(this.roomId, fingerprint);
    }
    return true;
  }

  /** Drop stale/duplicate host state before it reaches subscribers (generation, seq ordering). */
  private acceptServerMessage(message: ServerMsg): boolean {
    const gen = genOf(message) ?? this.generation;
    if (this.shadowGeneration > 0 && gen < this.shadowGeneration) {
      this.log(`drop ${message.t}: old generation ${gen} < ${this.shadowGeneration}`);
      return false;
    }
    if (gen > this.generation) this.generation = gen;
    if (message.t === 'snapshot' || message.t === 'update') {
      if (gen > this.shadowGeneration) return true; // a new host may legitimately be behind on seq
      if (isNewerStateOrder(this.shadowGeneration, this.shadow.seq, gen, message.seq)) return true;
      const fill =
        message.t === 'snapshot' &&
        message.seq === this.shadow.seq &&
        (message.resync === true || !this.shadow.state);
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
      case 'host_probe':
        if (this.role === 'host') this.sendHeartbeat();
        else this.broadcastPresence();
        return;
      case 'report_vote': {
        if (this.role === 'guest') {
          this.updateShadowVote(control.target, control.voter);
          if (this.hostPeerId) {
            void this.transport?.send(this.hostPeerId, {
              k: 'report_vote_ack',
              voteId: control.voteId,
              gen: control.gen,
            });
          }
        }
        return;
      }
      case 'report_vote_ack':
        if (this.role === 'host') this.pendingVotes.delete(control.voteId);
        return;
      case 'host_ack': {
        if (this.role !== 'host' || control.hostPeerId !== this.clientId) {
          this.log(`drop host_ack: role/host mismatch (${this.role}/${control.hostPeerId})`);
          return;
        }
        if (control.gen !== this.generation) {
          this.log(`drop host_ack: gen ${control.gen} != ${this.generation}`);
          return;
        }
        const keys = this.controller?.publicSnapshot().seatKeys ?? {};
        if (!Object.values(keys).includes(fingerprint)) {
          this.log('drop host_ack: signing key is not pinned to a seat');
          return;
        }
        this.ackKeys.add(fingerprint);
        if (this.ackKeys.size >= this.requiredAcks) this.becomeAuthorityReady();
        return;
      }
      case 'presence':
        if (this.role === 'host' && this.peerKeys.get(from) !== fingerprint) return;
        this.peerSeen.set(control.peerId, Date.now());
        if (this.role === 'host') this.guestSeen.set(from, Date.now());
        return;
      case 'hb':
      case 'host': {
        if (this.role === 'host') {
          this.considerCompetingHost(control, fingerprint);
          return;
        }
        if (control.k === 'hb') this.handleHostHeartbeat(control, fingerprint);
        else this.switchHost(control, fingerprint);
        return;
      }
      case 'bye':
        if (this.role === 'host') {
          this.guestSeen.delete(from);
          this.hostFollowers.delete(from);
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

  /**
   * Resolve the pinned key for a claimed host seat. Falls back to trust-on-first-use only when the
   * claim itself pins the signing key to that seat and the agreed lobby has a human there; the
   * fingerprint is then adopted so later claims must match it.
   */
  private claimSeatKey(control: HostClaim, fingerprint: string): string | null {
    if (control.hostSeat === null) return null;
    const agreed = this.trustedSeatKey(control.hostSeat);
    if (agreed === null) return null;
    return agreed === fingerprint ? agreed : null;
  }

  private trustedSeatKey(seat: number): string | null {
    const fromController =
      this.role === 'host' && this.controller
        ? this.controller.publicSnapshot().seatKeys[String(seat)]
        : undefined;
    if (fromController) return fromController;
    return this.shadow.seatKeys[String(seat)] ?? null;
  }

  private hostHumanSeatCount(): number {
    const lobby = this.controller?.lobbyView() ?? this.shadow.lobby;
    return lobby?.seats.filter((seat) => seat.kind === 'human').length ?? 0;
  }

  private strictMajority(totalHumans: number): number {
    if (totalHumans <= 1) return 1;
    return Math.floor(totalHumans / 2) + 1;
  }

  /** Self plus pinned human peers seen recently; CPU/open seats do not count. */
  private visibleHumanConfirmations(): number {
    const keys = this.controller?.publicSnapshot().seatKeys ?? this.shadow.seatKeys;
    const peerSilence = networkConfig.peerSilenceMs ?? DEFAULT_PEER_SILENCE_MS;
    const now = Date.now();
    const alive = new Set<string>();
    for (const [peerId, seen] of this.peerSeen) {
      if (now - seen > peerSilence) continue;
      const fingerprint = this.peerKeys.get(peerId);
      if (fingerprint) alive.add(fingerprint);
    }
    let count = 1; // the host itself
    for (const key of Object.values(keys)) {
      if (alive.has(key)) count += 1;
    }
    return count;
  }

  private requiredAckCount(): number {
    const total = this.hostHumanSeatCount();
    if (total <= 1) return 0;
    // Acks exclude the host, so a strict majority of seats means floor(total/2) acks.
    return Math.floor(total / 2);
  }

  private updateHostQuorum(): void {
    if (this.role !== 'host') return;
    const total = this.hostHumanSeatCount();
    if (total <= 1) {
      if (!this.quorumOk) {
        this.quorumOk = true;
        this.authorityReady = true;
        this.controller?.setFrozen(false);
      }
      return;
    }
    const needed = this.strictMajority(total);
    const visible = this.visibleHumanConfirmations();
    const ok = visible >= needed;
    if (ok === this.quorumOk) return;
    this.quorumOk = ok;
    if (!ok) {
      this.authorityReady = false;
      this.controller?.setFrozen(true);
      if (!this.quorumMessageShown) {
        this.quorumMessageShown = true;
        const text = `通信待ち：${needed} 人中 ${visible} 人しか接続できていません。再接続を待っています`;
        this.onServerMsg({ t: 'system', text });
        void this.transport?.broadcast({ t: 'system', text });
      }
      this.log(`host quorum lost (${visible}/${needed})`);
      return;
    }
    this.quorumMessageShown = false;
    if (this.promotedAt > 0 && this.ackKeys.size < this.requiredAcks) {
      // Wait for explicit acks on a promoted host; heartbeat re-announcement solicits them.
      return;
    }
    this.authorityReady = true;
    this.controller?.setFrozen(false);
    this.log(`host quorum restored (${visible}/${needed})`);
    const text = '通信が回復しました';
    this.onServerMsg({ t: 'system', text });
    void this.transport?.broadcast({ t: 'system', text });
  }

  private becomeAuthorityReady(): void {
    if (this.authorityReady || !this.quorumOk) return;
    this.authorityReady = true;
    this.controller?.setFrozen(false);
    this.log(`host authority confirmed (${this.ackKeys.size}/${this.requiredAcks} acks)`);
    const queued = this.frozenActions;
    this.frozenActions = [];
    for (const { from, message } of queued) {
      this.controller?.connect(from);
      this.controller?.message(from, message);
    }
    const local = this.frozenLocalActions;
    this.frozenLocalActions = [];
    for (const message of local) this.controller?.message(this.loopbackId, message);
    this.sendHeartbeat();
  }

  private ownHostClaim(): HostClaim | null {
    if (!this.controller) return null;
    const snapshot = this.controller.publicSnapshot();
    return {
      k: 'hb',
      hostPeerId: this.clientId,
      seat: this.seat,
      hostSeat: snapshot.hostSeat,
      seatKeys: snapshot.seatKeys,
      reportVotes: snapshot.reportVotes,
      lobby: snapshot.lobby,
      seq: snapshot.seq,
      gen: this.generation,
      connectedHumans: connectedHumans(snapshot.lobby),
      broker: this.transport?.broker() ?? null,
      at: Date.now(),
    };
  }

  private shadowHostClaim(): HostClaim | null {
    if (!this.hostPeerId || !this.shadow.lobby) return null;
    return {
      k: 'hb',
      hostPeerId: this.hostPeerId,
      seat: null,
      hostSeat: this.shadow.hostSeat,
      seatKeys: this.shadow.seatKeys,
      reportVotes: this.shadow.reportVotes,
      lobby: this.shadow.lobby,
      seq: this.shadow.seq,
      gen: this.generation,
      connectedHumans: connectedHumans(this.shadow.lobby),
      broker: this.hostBroker,
      at: this.lastHostHeartbeatAt,
    };
  }

  private considerCompetingHost(control: HostClaim, fingerprint: string): void {
    if (control.hostPeerId === this.clientId || control.hostSeat === null) return;
    const expected = this.claimSeatKey(control, fingerprint);
    if (expected === null) {
      this.log(`drop competing host ${control.hostPeerId}: seat key not pinned`);
      return;
    }
    this.lastCompeting = { control, fingerprint, at: Date.now() };
    const own = this.ownHostClaim();
    if (own && claimBeats(control, own)) {
      this.authorityReady = false; // freeze immediately; a higher-ranked claim wins
      this.log(`yielding host role to ${control.hostPeerId} (seq ${control.seq} > ${own.seq})`);
      this.stepDownToGuest(control, fingerprint);
      return;
    }
    const grace = networkConfig.selfHostGraceMs ?? SELF_HOST_GRACE_MS;
    if (
      this.promotedAt > 0 &&
      Date.now() - this.promotedAt > grace &&
      this.hostFollowers.size === 0
    ) {
      this.log(`self-promoted host has no followers; yielding to ${control.hostPeerId}`);
      this.stepDownToGuest(control, fingerprint);
    }
  }

  private handleHostHeartbeat(control: Extract<P2PControl, { k: 'hb' }>, fingerprint: string): void {
    if (control.hostPeerId === this.clientId) return;
    if (control.hostSeat === null) return;
    const switching = this.hostPeerId !== control.hostPeerId;
    const expected = switching ? this.claimSeatKey(control, fingerprint) : this.trustedSeatKey(control.hostSeat);
    if (switching && expected === null) {
      // Before welcome there is no agreed lobby yet; ignore silently and let welcome pin keys.
      if (this.lastWelcome) {
        this.log(`drop heartbeat from ${control.hostPeerId}: host seat key not pinned`);
      }
      return;
    }
    if (!switching && expected !== null && expected !== fingerprint) {
      this.log(`drop heartbeat from ${control.hostPeerId}: host seat key mismatch`);
      return;
    }
    if (switching) {
      const current = this.shadowHostClaim();
      const currentFresh =
        current !== null &&
        Date.now() - this.lastHostHeartbeatAt <= (networkConfig.hostSilenceMs ?? DEFAULT_HOST_SILENCE_MS);
      if (currentFresh && !claimBeats(control, current)) {
        this.log(`drop competing heartbeat ${control.hostPeerId}: current host ranks higher`);
        return;
      }
      this.adoptHostClaim(control, fingerprint, false);
      return;
    }
    if (this.hostKeyFingerprint === null) this.hostKeyFingerprint = fingerprint;
    if (control.gen !== this.generation) {
      this.generation = control.gen;
      if (control.gen < this.shadowGeneration) {
        this.shadowGeneration = control.gen;
        this.shadow.seq = 0;
        this.shadow.state = null;
      }
    }
    this.lastHostHeartbeatAt = Date.now();
    this.lastLivenessAt = Date.now();
    this.probeStartedAt = 0;
    this.sendHostAck(control.hostPeerId, control.gen);
    this.hostSeat = control.hostSeat;
    this.shadow.hostSeat = control.hostSeat;
    this.shadow.seatKeys = { ...control.seatKeys };
    this.shadow.reportVotes = { ...control.reportVotes };
    this.lastLobby = control.lobby;
    this.shadow.lobby = control.lobby;
    if (control.broker) {
      this.hostBroker = control.broker;
      discoveredBroker.set(this.roomId, control.broker);
    }
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
    if (control.hostSeat === null) return;
    const expected = this.claimSeatKey(control, fingerprint);
    if (expected === null) {
      this.log(`drop host announcement from ${control.hostPeerId}: seat key not pinned`);
      return;
    }
    if (control.hostPeerId === this.hostPeerId && control.gen === this.generation) {
      this.lastHostHeartbeatAt = Date.now();
      this.probeStartedAt = 0;
      return;
    }
    const current = this.shadowHostClaim();
    const currentFresh =
      current !== null &&
      Date.now() - this.lastHostHeartbeatAt <= (networkConfig.hostSilenceMs ?? DEFAULT_HOST_SILENCE_MS);
    if (currentFresh && !claimBeats(control, current)) {
      this.log(`drop competing host announcement ${control.hostPeerId}: current host ranks higher`);
      return;
    }
    this.adoptHostClaim(control, fingerprint, false);
  }

  private adoptHostClaim(control: HostClaim, fingerprint: string, forceReset: boolean): void {
    this.hostPeerId = control.hostPeerId;
    this.hostSeat = control.hostSeat;
    this.hostKeyFingerprint = fingerprint;
    this.expectedHostFingerprint = fingerprint;
    rememberHostKey(this.roomId, fingerprint);
    this.lastLivenessAt = Date.now();
    this.pendingAction = null;
    this.generation = control.gen;
    this.lastHostHeartbeatAt = Date.now();
    this.probeStartedAt = 0;
    this.shadow.hostSeat = control.hostSeat;
    this.shadow.seatKeys = { ...control.seatKeys };
    this.shadow.reportVotes = { ...control.reportVotes };
    this.lastLobby = control.lobby;
    this.shadow.lobby = control.lobby;
    if (control.broker) {
      this.hostBroker = control.broker;
      discoveredBroker.set(this.roomId, control.broker);
    }
    if (
      forceReset ||
      control.gen < this.shadowGeneration ||
      (control.seq < this.shadow.seq && control.gen <= this.shadowGeneration)
    ) {
      this.shadowGeneration = control.gen;
      this.shadow.seq = 0;
      this.shadow.state = null;
      this.lastSnapshot = null;
      this.lastUpdate = null;
    }
    this.setState('reconnecting');
    this.sendHello();
    this.sendHostAck(control.hostPeerId, control.gen);
    setTimeout(() => this.maybeResync(control.hostPeerId, control.seq), 100);
  }

  private sendHostAck(hostPeerId: string, gen: number): void {
    const now = Date.now();
    if (this.lastAckGen === gen && now - this.lastAckAt < 2_000) return;
    this.lastAckGen = gen;
    this.lastAckAt = now;
    void this.transport?.send(hostPeerId, { k: 'host_ack', hostPeerId, gen, seat: this.seat, at: now });
  }

  private stepDownToGuest(control: HostClaim, fingerprint: string): void {
    if (control.hostSeat === null) return;
    const expected = this.claimSeatKey(control, fingerprint);
    if (expected === null) return;
    this.controller?.dispose();
    this.controller = null;
    this.role = 'guest';
    this.authorityReady = false;
    this.frozenActions = [];
    this.frozenLocalActions = [];
    this.promotedAt = 0;
    this.hostFollowers.clear();
    this.lastCompeting = null;
    this.adoptHostClaim(control, fingerprint, true);
    storageRemove('session', HOST_SAVE_KEY);
  }

  private stampHostMessage(message: ServerMsg): ServerMsg {
    if (
      message.t === 'welcome' ||
      message.t === 'lobby' ||
      message.t === 'snapshot' ||
      message.t === 'update'
    ) {
      if (message.t === 'welcome' || message.t === 'snapshot') {
        return { ...message, gen: this.generation, boardVersion: BOARD_VERSION };
      }
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
        if (this.hostPeerId) void this.transport?.send(this.hostPeerId, { k: 'resync' });
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
    const transport = this.transport;
    if (this.role !== 'guest' || !transport) return;
    if (transport.status() !== 'open' && transport.p2pPeers() === 0) return;
    const hello: ClientMsg = {
      t: 'hello',
      v: PROTOCOL_VERSION,
      roomId: this.roomId,
      name: this.name,
      token: this.identity?.fingerprint ?? this.clientId,
      pub: this.identity ? JSON.stringify(this.identity.publicJwk) : undefined,
      boardVersion: BOARD_VERSION,
    };
    if (this.hostPeerId) void transport.send(this.hostPeerId, hello);
    else void transport.broadcast(hello);
  }

  private flushQueue(): void {
    const transport = this.transport;
    if (!this.hostPeerId || !transport) return;
    if (transport.status() !== 'open' && transport.p2pPeers() === 0) return;
    const queued = this.queue;
    this.queue = [];
    for (const message of queued) void transport.send(this.hostPeerId, message);
  }

  private updateShadowVote(target: number, voter: string): void {
    const key = String(target);
    const votes = this.shadow.reportVotes[key] ?? [];
    if (!votes.includes(voter)) votes.push(voter);
    this.shadow.reportVotes[key] = votes;
  }

  private replicateReport(target: number, voter: string): void {
    if (this.role !== 'host') return;
    const lobby = this.controller?.lobbyView();
    const seat = lobby?.seats[target];
    if (!seat || seat.kind === 'open') return;
    const seatKeys = this.controller?.publicSnapshot().seatKeys ?? {};
    const voterSeat = Object.entries(seatKeys).find(([, key]) => key === voter)?.[0];
    if (voterSeat !== undefined && Number(voterSeat) === target) return;
    this.updateShadowVote(target, voter);
    this.reportVoteSeq += 1;
    const control: Extract<P2PControl, { k: 'report_vote' }> = {
      k: 'report_vote',
      voteId: `${this.clientId.slice(0, 6)}-${Date.now().toString(36)}-${this.reportVoteSeq}`,
      target,
      voter,
      gen: this.generation,
      at: Date.now(),
    };
    this.pendingVotes.set(control.voteId, { control, sentAt: Date.now(), attempts: 1 });
    void this.transport?.broadcast(control);
  }

  private sendHeartbeat(): void {
    if (this.role !== 'host' || !this.controller || !this.transport) return;
    const snapshot = this.controller.publicSnapshot();
    const heartbeat: P2PControl = {
      k: 'hb',
      hostPeerId: this.clientId,
      seat: this.seat,
      hostSeat: snapshot.hostSeat,
      seatKeys: snapshot.seatKeys,
      reportVotes: snapshot.reportVotes,
      lobby: snapshot.lobby,
      seq: snapshot.seq,
      gen: this.generation,
      connectedHumans: connectedHumans(snapshot.lobby),
      broker: this.transport.broker(),
      at: Date.now(),
    };
    void this.transport.broadcast(heartbeat);
    const now = Date.now();
    for (const [voteId, pending] of this.pendingVotes) {
      if (now - pending.sentAt < 2_000) continue;
      if (pending.attempts >= 3) {
        this.pendingVotes.delete(voteId);
        continue;
      }
      pending.sentAt = now;
      pending.attempts += 1;
      void this.transport?.broadcast(pending.control);
    }
  }

  private broadcastPresence(): void {
    if (this.role !== 'guest' || !this.transport) return;
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
      reportVotes: snapshot.reportVotes,
      lobby: snapshot.lobby,
      seq: snapshot.seq,
      gen: this.generation,
      connectedHumans: connectedHumans(snapshot.lobby),
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
      this.updateHostQuorum();
      if (!this.authorityReady && this.promotedAt > 0) {
        if (this.ackKeys.size >= this.requiredAcks) this.becomeAuthorityReady();
        if (!this.authorityReady && now - this.promotedAt > 1_500) this.sendHeartbeat();
      }
      const peerSilence = networkConfig.peerSilenceMs ?? DEFAULT_PEER_SILENCE_MS;
      for (const [peerId, seen] of [...this.guestSeen]) {
        if (now - seen <= peerSilence) continue;
        this.guestSeen.delete(peerId);
        this.hostFollowers.delete(peerId);
        this.controller?.disconnect(peerId);
      }
      const grace = networkConfig.selfHostGraceMs ?? SELF_HOST_GRACE_MS;
      if (
        this.promotedAt > 0 &&
        now - this.promotedAt > grace &&
        this.hostFollowers.size === 0 &&
        this.lastCompeting &&
        now - this.lastCompeting.at < 5_000
      ) {
        this.log('self-promoted host has no followers; yielding to the visible host');
        this.stepDownToGuest(this.lastCompeting.control, this.lastCompeting.fingerprint);
      }
      return;
    }
    this.retryPendingGuestOps(now);
    if (typeof document === 'undefined' || document.visibilityState === 'visible') {
      if (now - this.lastLivenessAt > REAUTH_SILENCE_MS) {
        this.reauthenticate('no server activity while visible');
      } else if (now - this.lastServerAt > 15_000) {
        // Host is alive but state has not moved (CPU thinking, long fx): resync only.
        this.requestResync();
      }
    }
    const hostSilence = networkConfig.hostSilenceMs ?? DEFAULT_HOST_SILENCE_MS;
    if (!this.hostPeerId || !this.shadow.lobby) return;
    const hostPeerId = this.hostPeerId;
    // Stagger takeover by seat index so a higher seat cannot split-brain the room while the
    // lowest connected seat is still broadcasting its generation announcement.
    const stagger = this.seat === null ? 0 : Math.max(0, this.seat - 1) * 600;
    const lastHostSeen = Math.max(
      this.lastHostHeartbeatAt,
      this.peerSeen.get(hostPeerId) ?? 0,
    );
    if (now - lastHostSeen <= hostSilence + stagger) return;
    this.setState('reconnecting');
    if (this.promoting) return;

    // Probe before takeover: a momentary inbound gap must not create a second host.
    const probeMs = networkConfig.probeMs ?? HOST_PROBE_MS;
    const hostGoneMs = networkConfig.hostGoneMs ?? HOST_GONE_MS;
    if (this.probeStartedAt === 0) {
      this.probeStartedAt = now;
      void this.transport?.broadcast({ k: 'host_probe', from: this.clientId, at: now });
      return;
    }
    if (now - this.probeStartedAt < probeMs) return;

    const probeStartedAt = this.probeStartedAt;
    const otherLive = [...this.peerSeen.entries()].some(([peerId, seen]) => {
      if (peerId === this.clientId || peerId === hostPeerId) return false;
      // Must be fresh *during* the probe, not merely seen before the partition began.
      return seen >= probeStartedAt && now - seen <= (networkConfig.peerSilenceMs ?? DEFAULT_PEER_SILENCE_MS);
    });
    const hostGap = now - lastHostSeen;
    if (!otherLive && hostGap <= hostGoneMs) {
      this.probeStartedAt = 0;
      return;
    }
    this.probeStartedAt = 0;
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
      this.pendingAction.gen === this.generation &&
      this.shadow.seq === this.pendingAction.seq &&
      now - this.pendingAction.sentAt >= 1_000
    ) {
      this.pendingAction.sentAt = now;
      this.deliverToHost({
        t: 'action',
        gen: this.pendingAction.gen,
        seq: this.pendingAction.seq,
        action: this.pendingAction.action,
      });
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
        reportVotes: this.shadow.reportVotes,
        lastFx: this.shadow.lastFx,
        deadline: this.shadow.deadline,
      };
      const deps = this.hostDeps();
      this.controller = RoomController.adopt(snapshot, deps);
      this.role = 'host';
      this.generation = Math.max(1, this.generation) + 1;
      this.promotedAt = Date.now();
      this.hostFollowers.clear();
      this.lastCompeting = null;
      this.probeStartedAt = 0;
      this.ackKeys.clear();
      this.quorumOk = true;
      this.quorumMessageShown = false;
      this.requiredAcks = this.requiredAckCount();
      this.authorityReady = this.requiredAcks === 0;
      this.controller.setFrozen(!this.authorityReady);
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
        boardVersion: BOARD_VERSION,
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
    this.lastServerAt = Date.now();
    this.lastLivenessAt = Date.now();
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
        if (message.seatKeys) this.shadow.seatKeys = { ...message.seatKeys };
        this.shadow.chat = [...message.chat].slice(-COMM.historySize);
        if (this.role === 'guest') this.hostSeat = message.lobby.seats.find((seat) => seat.isHost)?.index ?? this.hostSeat;
        break;
      case 'lobby':
        this.lastLobby = message.lobby;
        this.shadow.lobby = message.lobby;
        if (
          this.role === 'guest' &&
          this.seat !== null &&
          message.lobby.seats[this.seat]?.kind === 'human' &&
          message.lobby.seats[this.seat]?.connected === false
        ) {
          this.reauthenticate('own seat marked disconnected', true);
        }
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
        this.shadowGeneration = genOf(message) ?? this.generation;
        this.shadow.deadline = message.deadline;
        if (this.pendingAction && message.seq > this.pendingAction.seq) this.pendingAction = null;
        break;
      case 'update':
        this.lastUpdate = message;
        this.shadow.state = message.state;
        this.shadow.seq = message.seq;
        this.shadowGeneration = genOf(message) ?? this.generation;
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
    const snapshot = this.lastSnapshot;
    const update = this.lastUpdate;
    if (!snapshot && !update && this.lastLobby) {
      listener({ t: 'lobby', lobby: this.lastLobby });
      return;
    }
    if (update && snapshot) {
      const newer =
        update.gen !== undefined &&
        snapshot.gen !== undefined &&
        isNewerStateOrder(snapshot.gen, snapshot.seq, update.gen, update.seq);
      if (newer) {
        listener(update);
        return;
      }
      listener(snapshot);
      if (update.seq > snapshot.seq && update.gen === snapshot.gen) listener(update);
      return;
    }
    if (snapshot) listener(snapshot);
    if (update) listener(update);
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
  const identity = await loadIdentity('room-probe');
  const brokers = networkConfig.brokers ?? DEFAULT_BROKERS;
  const transports: MqttTransport[] = [];
  const found = Promise.withResolvers<string | null>();
  let pending = brokers.length;
  const timer = setTimeout(
    () => found.resolve(null),
    networkConfig.probeTimeoutMs ?? PROBE_TIMEOUT_MS,
  );
  for (const broker of brokers) {
    const peerId = `probe_${randomToken(10)}`;
    const transport = new MqttTransport(peerId, {
      identity,
      brokers: [broker],
      disableWebRtc: true,
      connectTimeoutMs: networkConfig.connectTimeoutMs,
      log: () => {},
    });
    transports.push(transport);
    void (async () => {
      const ack = Promise.withResolvers<boolean>();
      const unsubscribe = transport.onMessage((_from, message) => {
        if (isP2PControl(message) && message.k === 'probeAck') ack.resolve(true);
      });
      try {
        await transport.connect(normalized);
        await transport.broadcast({ k: 'probe', at: Date.now() });
        const received = await Promise.race([
          ack.promise,
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 4_000)),
        ]);
        if (received) found.resolve(broker);
      } catch {
        // broker unavailable
      } finally {
        unsubscribe();
        pending -= 1;
        if (pending === 0) found.resolve(null);
      }
    })();
  }
  try {
    const broker = await found.promise;
    if (broker) discoveredBroker.set(normalized, broker);
    return broker !== null;
  } finally {
    clearTimeout(timer);
    await Promise.all(transports.map((transport) => transport.close()));
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
export function reportVotesForTests(session: Session): Record<string, string[]> | null {
  return session instanceof OnlineSession ? session.reportVotes() : null;
}

export function authorityInfoForTests(session: Session): {
  ready: boolean;
  requiredAcks: number;
  acks: number;
  frozen: boolean;
} | null {
  return session instanceof OnlineSession ? session.authorityInfo() : null;
}

export function checkpointHostForTests(session: Session): HostCheckpoint | null {
  return session instanceof OnlineSession ? session.hostCheckpoint() : null;
}

export function resumeHostForTests(checkpoint: HostCheckpoint): Session {
  return OnlineSession.resumeFromCheckpoint(checkpoint);
}

/** Test hook: partition a peer's inbound traffic while leaving its outbound traffic intact. */
/** Test hook: make the host resend welcome + snapshot to a guest connection id. */
export function resyncPeerForTests(session: Session, connId: string): void {
  if (session instanceof OnlineSession) session.resyncPeerForTests(connId);
}

export function setBlockedPeersForTests(session: Session, peerIds: readonly string[]): void {
  if (session instanceof OnlineSession) session.setBlockedPeersForTests(peerIds);
}

export function setNetworkPartitionForTests(session: Session, blocked: boolean): void {
  if (session instanceof OnlineSession) session.setInboundBlockedForTests(blocked);
}

/** Test hook used by the in-process broker e2e: kill a session's transport without a leave. */
export function killSessionForTests(session: Session): void {
  if (session instanceof OnlineSession) session.killForTests();
}

/** Reports persisted by the host device (settings screen export). */
export function appendReportEvidence(report: unknown): void {
  const stored = readReports();
  storageSet('local', REPORTS_KEY, JSON.stringify([...stored, report]));
}

export function exportReports(): string {
  return storageGet('local', REPORTS_KEY) ?? '[]';
}