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
import { loadIdentity, publicJwkFromString, signData } from './p2p/identity';
import type { ClientIdentity } from './p2p/identity';
import type { P2PControl, P2PMessage, TransportStatus } from './p2p/transport';
import {
  claimRanksAbove,
  countFollowers,
  isStaleGeneration,
  isVerifiedTransfer,
  nextGeneration,
  reportVoteAckTargets,
  rosterCertPayload,
  rotateBrokers,
  stateHashOf,
  transferApprovalPayload,
  verifySeatRosterCert,
  verifyTransferProof,
} from './authority';
import type { FollowRecord, KeyLink, SeatRosterCert, TransferApproval, TransferProof } from './authority';
import { netDebug } from './debug';
import type { NetDebugSnapshot, PendingActionSnapshot } from './debug';

const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const REPORTS_KEY = 'fable.reports';
const CLIENT_KEY = 'fable.client';
const GUEST_SAVE_KEY = 'fable.online.guest';
const HOST_SAVE_KEY = 'fable.online.host';
const DEFAULT_HEARTBEAT_MS = 3_000;
const DEFAULT_HOST_SILENCE_MS = 10_000;
const DEFAULT_PEER_SILENCE_MS = 15_000;
const PROBE_TIMEOUT_MS = 5_000;
const HOST_PROBE_MS = 3_000;
const HOST_GONE_MS = 15_000;
const SELF_HOST_GRACE_MS = 10_000;
const REAUTH_SILENCE_MS = 10_000;
const HOST_REPLY_SILENCE_MS = 12_000;
const BROKER_RETRY_MS = 5_000;
const DEFAULT_WELCOME_TIMEOUT_MS = 5_000;
const DEFAULT_ACTION_RETRY_MS = 6_000;
const DEFAULT_ACTION_RESYNC_MS = 4_000;
const DEFAULT_MAX_ACTION_RETRIES = 2;
const DEFAULT_MAX_ACTION_RESYNCS = 2;
const DEFAULT_HOST_STALL_EXTRA_MS = 10_000;
const DEFAULT_MAX_HOST_STALL_REARMS = 3;

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
  /** No authenticated host reply for this long => re-discover the broker (not a resync trigger). */
  hostReplySilenceMs?: number;
  brokerRetryMs?: number;
  /** Guest initial-welcome timeout before rotating off an unresponsive broker. */
  welcomeTimeoutMs?: number;
  /** Extra broker connections per client (hosts/guests both use mirrors when configured). */
  redundantBrokers?: number;
  /** Client safety net: resend same (gen, seq) after this delay, then escalate to resync. */
  actionRetryMs?: number;
  actionResyncMs?: number;
  maxActionRetries?: number;
  maxActionResyncs?: number;
  /** Host safety net: extra grace on top of fx/turn budget before re-arming stalled room tasks. */
  hostStallExtraMs?: number;
  maxHostStallRearms?: number;
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
  boardVersion: string;
  savedAt: number;
}

let onlineSaveIssueText: string | null = null;
export function onlineSaveIssue(): string | null {
  return onlineSaveIssueText;
}

const HOST_KEY_CHAIN_PREFIX = 'fable.keychain.';
const TRANSFER_PROOF_PREFIX = 'fable.transfer.';
const hostKeyChainMemory = new Map<string, HostKeyLink[]>();
const transferProofMemory = new Map<string, TransferProof>();

function readTransferProof(roomId: string): TransferProof | null {
  const key = normalizeRoomId(roomId);
  const memory = transferProofMemory.get(key);
  if (memory) return memory;
  const raw = storageGet('local', `${TRANSFER_PROOF_PREFIX}${key}`);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === 'object' &&
      'roomId' in parsed &&
      'roster' in parsed &&
      'newHostFp' in parsed &&
      'approvals' in parsed
    ) {
      const proof = parsed as TransferProof;
      transferProofMemory.set(key, proof);
      return proof;
    }
  } catch {
    // ignore corrupt stored proof
  }
  return null;
}

function saveTransferProof(roomId: string, proof: TransferProof): void {
  const key = normalizeRoomId(roomId);
  transferProofMemory.set(key, proof);
  storageSet('local', `${TRANSFER_PROOF_PREFIX}${key}`, JSON.stringify(proof));
}

interface HostKeyLink extends KeyLink {
  at: number;
}

function readHostKeyChain(roomId: string): HostKeyLink[] {
  const memory = hostKeyChainMemory.get(roomId);
  if (memory) return memory;
  const raw = storageGet('local', `${HOST_KEY_CHAIN_PREFIX}${roomId}`);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const links = parsed
      .filter(
        (link): link is { fp: string; gen: number; approvedBy?: unknown; needed?: unknown; at?: unknown } =>
          !!link &&
          typeof link === 'object' &&
          'fp' in link &&
          typeof link.fp === 'string' &&
          'gen' in link &&
          typeof link.gen === 'number',
      )
      .map((link) => ({
        fp: link.fp,
        gen: link.gen,
        approvedBy: Array.isArray(link.approvedBy)
          ? link.approvedBy.filter((value): value is string => typeof value === 'string')
          : [],
        needed: typeof link.needed === 'number' ? link.needed : 1,
        at: typeof link.at === 'number' ? link.at : 0,
      }));
    hostKeyChainMemory.set(roomId, links);
    return links;
  } catch {
    return [];
  }
}

/**
 * Record a host key. `approvedBy` holds the seat fingerprints whose signed ack approved this
 * authority; only an approved link may replace the invite URL's initial pin on reload.
 */
function appendHostKeyChain(
  roomId: string,
  fp: string,
  gen: number,
  approvedBy: string[] = [],
  needed = 1,
): void {
  const links = readHostKeyChain(roomId);
  const last = links[links.length - 1];
  if (last?.fp === fp) {
    last.gen = Math.max(last.gen, gen);
    last.approvedBy = [...new Set([...last.approvedBy, ...approvedBy])];
    last.needed = Math.max(last.needed, needed);
  } else {
    links.push({ fp, gen, approvedBy: [...new Set(approvedBy)], needed, at: Date.now() });
    if (links.length > 12) links.splice(0, links.length - 12);
  }
  hostKeyChainMemory.set(roomId, links);
  storageSet('local', `${HOST_KEY_CHAIN_PREFIX}${roomId}`, JSON.stringify(links));
}

/** Verified successor for a room, or null when only the invite pin is known. */
export function verifiedSuccessorForRoom(
  roomId: string,
  agreedSeatKeys: readonly string[],
): { fp: string; gen: number } | null {
  const links = readHostKeyChain(normalizeRoomId(roomId));
  for (let index = links.length - 1; index >= 0; index -= 1) {
    const link = links[index];
    if (link.approvedBy.length === 0) continue;
    if (isVerifiedTransfer(link, agreedSeatKeys, link.needed)) return { fp: link.fp, gen: link.gen };
  }
  return null;
}

interface GuestSave {
  roomId: string;
  name: string;
}

type HostClaim = Extract<P2PControl, { k: 'hb' | 'host' }>;

type StatefulMsg =
  | Extract<ServerMsg, { t: 'snapshot' }>
  | Extract<ServerMsg, { t: 'update' }>;

/** Whichever state message carries the newest (gen, seq); ties prefer the snapshot. */
function pickNewestState(
  snapshot: Extract<ServerMsg, { t: 'snapshot' }> | null,
  update: Extract<ServerMsg, { t: 'update' }> | null,
): StatefulMsg | null {
  if (!snapshot) return update;
  if (!update) return snapshot;
  return isNewerStateOrder(snapshot.gen ?? 0, snapshot.seq, update.gen ?? 0, update.seq)
    ? update
    : snapshot;
}

function connectedHumans(lobby: LobbyView | null): number {
  return lobby?.seats.filter((seat) => seat.kind === 'human' && seat.connected).length ?? 0;
}

/**
 * Conflict resolution: a strictly newer authority generation always wins (generations are monotonic
 * across authority changes), then higher seq, then more connected humans, then lower peer id.
 */
function claimBeats(incoming: HostClaim, current: HostClaim): boolean {
  return claimRanksAbove(
    { gen: incoming.gen, seq: incoming.seq, connectedHumans: incoming.connectedHumans ?? connectedHumans(incoming.lobby), hostPeerId: incoming.hostPeerId },
    { gen: current.gen, seq: current.seq, connectedHumans: current.connectedHumans ?? connectedHumans(current.lobby), hostPeerId: current.hostPeerId },
  );
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
  reclaimKeys: Record<string, string>;
  hostSeat: number | null;
  lastFx: RoomPublicSnapshot['lastFx'];
  deadline: number | null;
  turnElapsedMs: number;
  turnElapsedAt: number;
}

function emptyShadow(): Shadow {
  return {
    lobby: null,
    state: null,
    seq: 0,
    chat: [],
    seatKeys: {},
    reportVotes: {},
    reclaimKeys: {},
    hostSeat: null,
    lastFx: [],
    deadline: null,
    turnElapsedMs: 0,
    turnElapsedAt: 0,
  };
}

function parseHostSave(raw: string | null): HostSave | null {
  if (!raw) return null;
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object') return null;
  if (!('roomId' in parsed) || typeof parsed.roomId !== 'string') return null;
  if (!('name' in parsed) || typeof parsed.name !== 'string') return null;
  if (!('snapshot' in parsed) || typeof parsed.snapshot !== 'string') return null;
  const boardVersion =
    'boardVersion' in parsed && typeof parsed.boardVersion === 'string' ? parsed.boardVersion : null;
  return {
    roomId: parsed.roomId,
    name: parsed.name,
    snapshot: parsed.snapshot,
    generation: 'generation' in parsed && typeof parsed.generation === 'number' ? parsed.generation : 1,
    boardVersion: boardVersion ?? '',
    savedAt: 'savedAt' in parsed && typeof parsed.savedAt === 'number' ? parsed.savedAt : 0,
  };
}

/** Human-readable reason a stored online host save was rejected (null when there is none). */
function rejectHostSave(reason: string): null {
  onlineSaveIssueText = reason;
  return null;
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
  // A verified authority chain outranks the invite URL: the URL only carries the *initial* pin, so
  // a guest that was offline during a host transfer would otherwise pin the old key forever.
  const chain = readHostKeyChain(roomId);
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const link = chain[index];
    if (link.approvedBy.length > 0 && link.approvedBy.length >= link.needed) return link.fp;
  }
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

function rememberHostKey(
  roomId: string,
  fingerprint: string,
  gen = 0,
  approvedBy: string[] = [],
  needed = 1,
): void {
  storageSet('local', `fable.hostkey.${roomId}`, fingerprint);
  appendHostKeyChain(roomId, fingerprint, gen, approvedBy, needed);
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
  private seatJwks = new Map<string, JsonWebKey>();
  /** Seat index -> fingerprint agreed before any timeout CPU replacement (used on partition heal). */
  private agreedSeatKeys: Record<string, string> = {};
  private rosterCert: SeatRosterCert | null = null;
  private rosterCertSigKey = '';
  private transferProof: TransferProof | null = null;
  private transferApprovals = new Map<string, TransferApproval>();
  private prevHostFpForTransfer: string | null = null;
  private verifyingProofKey: string | null = null;
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
  /** Peers that have received an authoritative hello/snapshot under the current host generation. */
  private peerWelcomedInGen = new Set<string>();
  /** fingerprint -> the single host (fp + gen) that peer's latest liveness says it follows. */
  private followers = new Map<string, FollowRecord>();
  private lastBoardGen = -1;
  private lastBoardSeq = -1;
  private lastBoardAdvanceAt = 0;
  private hostStallRearms = 0;
  private lastHostStallRearmAt = 0;
  private highestGenerationSeen = 0;
  private brokerMisses = new Set<string>();
  /** Agreed-lobby human seat count; quorum for an UNCONFIRMED promotion must use this. */
  private agreedHumanSeats = 0;
  private promotionConfirmed = false;
  private rotationsSinceHostReply = 0;
  private lastCompeting: { control: HostClaim; fingerprint: string; at: number } | null = null;
  private inboundBlockedForTests = false;
  private authorityReady = true;
  private requiredAcks = 0;
  private ackKeys = new Set<string>();
  private lastAckGen = -1;
  private lastAckAt = 0;
  private quorumOk = true;
  private quorumMessageShown = false;
  private reportVoteSeq = 0;
  private pendingVotes = new Map<
    string,
    {
      control: Extract<P2PControl, { k: 'report_vote' }>;
      sentAt: number;
      firstSentAt: number;
      attempts: number;
      /** fingerprints that acknowledged this vote (all current human seats + would-be successor). */
      acked: Set<string>;
    }
  >();
  private lastHostReplyAt = 0;
  private lastBrokerRotateAt = 0;
  private appliedGen = 0;
  private appliedSeq = -1;
  private lastReceivedGen = 0;
  private lastReceivedSeq = -1;
  /** seq -> generation of the state that carried it (actions are stamped from what the UI applied). */
  private deliveredOrders = new Map<number, number>();
  private switchingAuthority = false;
  private lastLivenessAt = Date.now();
  private lastReauthAt = 0;
  private visibilityHandler: (() => void) | null = null;
  private lastResyncAt = 0;
  private pendingSeat: number | null = null;
  private pendingCharacter: string | null = null;
  private pendingAction: {
    gen: number;
    seq: number;
    action: Action;
    firstSentAt: number;
    sentAt: number;
    retries: number;
    resyncs: number;
    lastResyncAt: number;
  } | null = null;
  /**
   * An action dropped only because the authority was being confirmed/switched. It was derived from
   * the applied state, so it is re-sent once that same (gen, seq) is usable again instead of making
   * the player tap twice.
   */
  private deferredAction: { gen: number; seq: number; action: Action; at: number } | null = null;
  private lastLobbyRetryAt = 0;

  private lastWelcome: Extract<ServerMsg, { t: 'welcome' }> | null = null;
  private lastLobby: LobbyView | null = null;
  private lastSnapshot: Extract<ServerMsg, { t: 'snapshot' }> | null = null;
  private lastUpdate: Extract<ServerMsg, { t: 'update' }> | null = null;

  private constructor(roomId: string, name: string, role: 'host' | 'guest', hostKeyHint?: string | null) {
    this.roomId = normalizeRoomId(roomId);
    this.name = name.trim().slice(0, 16) || 'プレイヤー';
    this.role = role;
    this.clientId = clientIdFor(this.name);
    this.hostBroker = discoveredBroker.get(this.roomId) ?? null;
    this.expectedHostFingerprint =
      hostKeyHint !== undefined
        ? (hostKeyHint ? hostKeyHint.toLowerCase() : null)
        : readHostKeyHint(this.roomId);
    this.transferProof = hostKeyHint !== undefined ? null : readTransferProof(this.roomId);
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

  requestGenerationBumpForTests(): boolean {
    const transport = this.transport;
    if (this.role !== 'guest' || !this.hostPeerId || !transport) return false;
    void transport.send(this.hostPeerId, {
      k: 'gen_bump',
      hostPeerId: this.hostPeerId,
      from: this.clientId,
      gen: Math.max(this.generation, this.highestGenerationSeen) + 1,
      at: Date.now(),
    });
    return true;
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

  clearRoomTasksForTests(): void {
    this.controller?.clearProgressTasksForTests();
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

  debugSnapshot(): NetDebugSnapshot {
    const pending: PendingActionSnapshot | null = this.pendingAction
      ? {
          gen: this.pendingAction.gen,
          seq: this.pendingAction.seq,
          actionType: this.pendingAction.action.t,
          firstSentAt: this.pendingAction.firstSentAt,
          sentAt: this.pendingAction.sentAt,
          retries: this.pendingAction.retries,
          resyncs: this.pendingAction.resyncs,
        }
      : null;
    return {
      roomId: this.roomId,
      clientId: this.clientId,
      role: this.role,
      seat: this.seat,
      connection: this.connectionState,
      generation: this.generation,
      highestGenerationSeen: this.highestGenerationSeen,
      lastReceived:
        this.lastReceivedSeq >= 0
          ? { gen: this.lastReceivedGen, seq: this.lastReceivedSeq }
          : null,
      applied: this.appliedOrder(),
      pendingAction: pending,
      deferredAction: this.deferredAction
        ? {
            gen: this.deferredAction.gen,
            seq: this.deferredAction.seq,
            actionType: this.deferredAction.action.t,
            at: this.deferredAction.at,
          }
        : null,
      switchingAuthority: this.switchingAuthority,
      authority: {
        ready: this.authorityReady,
        promotionConfirmed: this.promotionConfirmed,
        quorumOk: this.quorumOk,
        requiredAcks: this.requiredAcks,
        acks: this.ackKeys.size,
        frozen: this.controller?.isFrozen ?? (!this.authorityReady && this.role === 'host'),
      },
      controller: this.controller?.debugSnapshot() ?? null,
      broker: this.transport?.broker() ?? null,
      mirrors: this.transport?.mirrorBrokers() ?? [],
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

  static guest(roomId: string, name: string, hostKeyHint?: string | null): OnlineSession {
    const session = new OnlineSession(roomId, name, 'guest', hostKeyHint);
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

  private noteDeliveredOrder(seq: number, gen: number): void {
    this.deliveredOrders.set(seq, gen);
    if (this.deliveredOrders.size > 64) {
      const oldest = this.deliveredOrders.keys().next();
      if (!oldest.done) this.deliveredOrders.delete(oldest.value);
    }
  }

  /** The (gen, seq) of the last state delivered to subscribers (what the UI has applied). */
  appliedOrder(): { gen: number; seq: number } | null {
    if (this.appliedSeq < 0) return null;
    return { gen: this.appliedGen, seq: this.appliedSeq };
  }

  send(msg: ClientMsg): void {
    if (this.closed || this.crashed) return;
    if (msg.t === 'ping') return;
    if (msg.t === 'action') {
      const gen = this.deliveredOrders.get(msg.seq);
      if (gen === undefined || !this.appliedOrder()) {
        this.softReject('送信した操作の盤面が古くなりました。もう一度お試しください');
        return;
      }
      // Stamp the (gen, seq) of the state the UI actually applied. An action built from an old
      // screen can therefore never be promoted into the new authority's generation.
      if (gen !== this.generation || this.switchingAuthority) {
        this.deferAction(gen, msg.seq, msg.action);
        this.softReject('ホストを切り替えています。少し待ってから操作してください');
        return;
      }
      msg = { ...msg, gen };
    }
    if (this.role === 'host' && this.controller) {
      if (msg.t === 'action' && (!this.authorityReady || !this.quorumOk || this.controller.isFrozen)) {
        this.deferAction(msg.gen ?? this.generation, msg.seq, msg.action);
        this.softReject('通信待ちのため操作できません。再接続を待っています');
        return;
      }
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
        const now = Date.now();
        this.pendingAction = {
          gen: msg.gen ?? this.generation,
          seq: msg.seq,
          action: msg.action,
          firstSentAt: now,
          sentAt: now,
          retries: 0,
          resyncs: 0,
          lastResyncAt: 0,
        };
        this.debug('action queued', { gen: this.pendingAction.gen, seq: this.pendingAction.seq, t: msg.action.t });
      } else if (msg.t === 'leave_seat' || msg.t === 'leave') {
        this.pendingSeat = null;
        this.pendingCharacter = null;
        this.pendingAction = null;
      }
    }
    this.deliverToHost(msg);
  }

  private deferAction(gen: number, seq: number, action: Action): void {
    this.deferredAction = { gen, seq, action, at: Date.now() };
  }

  private flushDeferredAction(): void {
    const deferred = this.deferredAction;
    if (!deferred) return;
    // Authority switches take seconds on a slow device: allow a generous window, but never
    // resurrect an action once the board has moved past its seq (the seq check below).
    if (Date.now() - deferred.at > 20_000) {
      this.deferredAction = null;
      return;
    }
    const applied = this.appliedOrder();
    if (!applied || applied.seq !== deferred.seq) {
      this.deferredAction = null;
      return;
    }
    if (this.switchingAuthority) return; // still mid-switch; a later state re-tries
    if (this.role === 'host' && (!this.authorityReady || !this.quorumOk || this.controller?.isFrozen)) return;
    if (applied.gen !== this.generation) {
      // Wait for the new generation's snapshot instead of looping softReject on every watchdog tick.
      if (this.role === 'guest' && this.hostPeerId) {
        this.maybeResync(this.hostPeerId, applied.seq, this.generation);
      }
      return;
    }
    // `send` re-derives the generation for this seq from what was actually delivered, so an action
    // held across a generation bump is resubmitted under the NEW generation, not the old one.
    this.deferredAction = null;
    this.send({ t: 'action', seq: deferred.seq, action: deferred.action });
  }

  /** UI-facing rejection that never reaches the authority (used during authority switches). */
  private softReject(message: string): void {
    this.onServerMsg({ t: 'error', code: 'stale', message });
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
    this.peerWelcomedInGen.clear();
    this.lastCompeting = null;
    this.probeStartedAt = 0;
    this.authorityReady = true;
    this.requiredAcks = 0;
    this.ackKeys.clear();
    this.quorumOk = true;
    this.quorumMessageShown = false;
    this.hostPeerId = this.clientId;
    this.hostKeyFingerprint = this.identity.fingerprint;
    this.seatJwks.set(this.identity.fingerprint, this.identity.publicJwk);
    this.promotionConfirmed = true;
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
    this.resetHostStallWatch(this.controller.currentSeq);
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
      reportAccepted: (target, reporterSeat) => {
        const voter = this.controller?.publicSnapshot().seatKeys[String(reporterSeat)];
        if (!voter) return; // CPU/autoplay seats have no key to replicate
        this.replicateReport(target, voter);
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
    while (!this.closed && !this.crashed && this.role === 'guest') {
      const transport = this.createTransport();
      this.transport = transport;
      transport.onMessage((from, message, fingerprint) =>
        this.onTransportMessage(from, message, fingerprint),
      );
      transport.onStatus((status) => this.onTransportStatus(status));
      try {
        await transport.connect(this.roomId);
        if (this.closed || this.crashed || this.role !== 'guest') return;
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
    const timeoutMs = networkConfig.welcomeTimeoutMs ?? DEFAULT_WELCOME_TIMEOUT_MS;
    this.welcomeTimer = setTimeout(() => {
      this.welcomeTimer = null;
      if (this.closed || this.crashed || this.role !== 'guest' || this.connectionState === 'open') {
        return;
      }
      this.log('no host welcome on this broker; trying the next broker');
      const old = this.transport;
      const currentBroker = old?.broker();
      if (currentBroker) this.brokerMisses.add(currentBroker);
      this.rotationsSinceHostReply += 1;
      this.brokerAttempt += 1;
      this.transport = null;
      if (old) void old.close();
      void this.connectGuestTransport();
    }, timeoutMs);
  }

  private clearWelcomeWatchdog(): void {
    if (this.welcomeTimer === null) return;
    clearTimeout(this.welcomeTimer as number);
    this.welcomeTimer = null;
  }

  private createTransport(): MqttTransport {
    if (!this.identity) throw new Error('identity not initialised');
    // Respect brokerMisses from brokerCandidates() for primary ordering, while keeping the rest
    // of the base brokers at the tail so mirrors and failover never collapse to a single broker.
    const base = networkConfig.brokers ?? DEFAULT_BROKERS;
    const candidates = this.brokerCandidates();
    const preferred =
      this.hostBroker && !this.brokerMisses.has(this.hostBroker) && candidates.includes(this.hostBroker)
        ? this.hostBroker
        : null;
    const ordered = preferred
      ? [preferred, ...candidates.filter((broker) => broker !== preferred)]
      : candidates;
    const brokers = [...new Set([...ordered, ...base])];
    const defaultMirrors = this.role === 'host' ? Math.max(0, brokers.length - 1) : Math.min(1, Math.max(0, brokers.length - 1));
    const transport = new MqttTransport(this.clientId, {
      identity: this.identity,
      brokers,
      disableWebRtc: networkConfig.disableWebRtc,
      connectTimeoutMs: networkConfig.connectTimeoutMs,
      redundantBrokers: networkConfig.redundantBrokers ?? defaultMirrors,
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
        this.guestSeen.set(from, Date.now());
        void this.transport?.send(from, {
          t: 'error',
          code: 'stale',
          message: 'ホスト世代が変わりました。最新の状態から操作してください',
        });
        if (this.isKnownSeatKey(fingerprint)) {
          this.reviveSeatFromPeer(from, fingerprint);
          this.controller.connect(from);
          this.controller.resync(from);
        }
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
        if (message.pub) {
          void publicJwkFromString(message.pub).then((jwk) => {
            if (!jwk) return;
            this.seatJwks.set(fingerprint, jwk);
            void this.maybeRefreshRosterCert();
          });
        }
        // Immediately deliver transferProof (if any) to a guest rejoining from an older invite URL.
        if (this.transferProof) this.sendHeartbeatTo(from);
      } else if (pinned === undefined) {
        this.log(`drop ClientMsg from ${from}: hello (public key) missing`);
        return;
      }
      this.guestSeen.set(from, Date.now());
      if (message.t !== 'hello') this.reviveSeatFromPeer(from, fingerprint);
      const snapNow = this.controller.publicSnapshot();
      const seated =
        Object.values(snapNow.seatKeys).includes(fingerprint) ||
        Object.values(snapNow.reclaimKeys ?? {}).includes(fingerprint);
      if (seated) {
        this.hostFollowers.add(from);
        const hostFp = this.ownHostFingerprint();
        const record = this.followers.get(fingerprint);
        // A peer that addresses this host directly is following it unless it already declared a
        // newer/equal generation for another host; overwrite stale pre-migration records.
        if (!record || record.hostFp === hostFp || record.gen < this.generation) {
          this.recordFollowing(fingerprint, { hostFp, gen: this.generation });
        }
      }
      const wasConnectedBefore =
        message.t === 'hello' && seated && this.controller.seatForConn(from) !== null;
      if (message.t === 'action') {
        if (seated && this.promotedAt > 0 && (!this.authorityReady || !this.promotionConfirmed)) {
          this.ackKeys.add(fingerprint);
          this.updateHostQuorum();
          if (this.ackKeys.size >= this.requiredAcks) this.becomeAuthorityReady();
        }
        if (!this.authorityReady || !this.quorumOk || this.controller.isFrozen) {
          void this.transport?.send(from, {
            t: 'error',
            code: 'stale',
            message: 'ホストを切り替えています。少し待ってから操作してください',
          });
          return;
        }
      }
      // Process hello/reconnect BEFORE becoming authority ready so the guest is marked connected
      // in the confirmation snapshot and turn/grace timers reflect the reconnected seat.
      this.controller.connect(from);
      this.controller.message(from, message);
      if (message.t === 'hello' && !this.peerWelcomedInGen.has(from)) {
        this.peerWelcomedInGen.add(from);
        // If presence previously triggered reviveSeatFromPeer before the guest switched hostPeerId,
        // onHello saw the seat already connected and skipped the snapshot. Guarantee one resync
        // snapshot on the guest's first hello in this generation so appliedGen catches up.
        if (wasConnectedBefore) this.controller.resync(from);
      }
      if (seated && this.promotedAt > 0 && (!this.authorityReady || !this.promotionConfirmed)) {
        this.ackKeys.add(fingerprint);
        this.updateHostQuorum();
        if (this.ackKeys.size >= this.requiredAcks) this.becomeAuthorityReady();
      }
      this.afterHostMessage(message);
      return;
    }
    if (!isServerMsg(message)) return;
    // Authenticate the sender BEFORE acting on any content: an unsigned/hostile peer must not be
    // able to force this client to close the room by claiming a version mismatch.
    if (!this.acceptHostSender(from, fingerprint)) return;
    // Check generation BEFORE board-version mismatch so a stale-generation message from a catching-up
    // authority cannot tear down the session.
    const incomingGen = genOf(message);
    if (incomingGen !== undefined && this.shadowGeneration > 0 && incomingGen < this.shadowGeneration) {
      this.log(`drop ${message.t}: old generation ${incomingGen} < ${this.shadowGeneration}`);
      return;
    }
    this.lastHostReplyAt = Date.now(); // authenticated host reply: this broker is working
    this.rotationsSinceHostReply = 0;
    if (
      (message.t === 'welcome' || message.t === 'snapshot') &&
      message.boardVersion !== BOARD_VERSION
    ) {
      this.log(`peer ${from} reported a different board version`);
      this.onServerMsg({
        t: 'error',
        code: 'bad_version',
        message: 'ゲームのバージョンが違います。ページを再読み込みしてください',
      });
      this.setState('closed');
      void this.transport?.close();
      return;
    }
    if (message.t === 'welcome') {
      this.lastHostHeartbeatAt = Date.now();
      this.brokerAttempt = 0;
      this.brokerMisses.clear();
      this.clearWelcomeWatchdog();
      this.ensureGuestMirrors();
      this.setState('open');
      this.flushQueue();
    }
    if (!this.acceptServerMessage(message)) return;
    if (message.t === 'snapshot' || message.t === 'update') {
      this.lastReceivedGen = genOf(message) ?? this.generation;
      this.lastReceivedSeq = message.seq;
      this.debug(`recv ${message.t}`, {
        gen: this.lastReceivedGen,
        seq: this.lastReceivedSeq,
        resync: message.t === 'snapshot' ? message.resync === true : undefined,
        pendingAction: this.pendingAction
          ? { gen: this.pendingAction.gen, seq: this.pendingAction.seq, t: this.pendingAction.action.t }
          : null,
      });
    }
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
        if (this.role !== 'guest') return;
        if (from !== this.hostPeerId) {
          this.log('drop report_vote: not from the followed host');
          return;
        }
        if (control.hostFp !== this.hostKeyFingerprint) {
          this.log('drop report_vote: host key mismatch');
          return;
        }
        if (control.gen !== this.generation) {
          this.log(`drop report_vote: gen ${control.gen} != ${this.generation}`);
          return;
        }
        const seatKeys = this.shadow.seatKeys;
        if (!Object.values(seatKeys).includes(control.voter)) {
          this.log('drop report_vote: voter is not a pinned seat');
          return;
        }
        this.updateShadowVote(control.target, control.voter);
        if (this.hostPeerId) {
          void this.transport?.send(this.hostPeerId, {
            k: 'report_vote_ack',
            voteId: control.voteId,
            gen: control.gen,
            voter: this.identity?.fingerprint ?? this.clientId,
          });
        }
        return;
      }
      case 'report_vote_ack': {
        if (this.role !== 'host') return;
        const pending = this.pendingVotes.get(control.voteId);
        if (!pending) return;
        if (control.gen !== this.generation) return;
        const keys = this.controller?.publicSnapshot().seatKeys ?? {};
        if (!Object.values(keys).includes(fingerprint)) return;
        this.guestSeen.set(from, Date.now());
        this.refreshFollowerFromDirectMessage(fingerprint);
        pending.acked.add(fingerprint);
        const needed = this.voteAckTargets(pending.control.target, pending.control.voter);
        if ([...needed].every((key) => key === this.ownHostFingerprint() || pending.acked.has(key))) {
          this.pendingVotes.delete(control.voteId);
        }
        return;
      }
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
        if (control.hostFp && control.hostFp !== (this.identity?.fingerprint ?? this.clientId)) {
          this.log('drop host_ack: ack names a different host key');
          return;
        }
        this.guestSeen.set(from, Date.now());
        this.recordFollowing(
          fingerprint,
          {
            hostFp: this.identity?.fingerprint ?? this.clientId,
            gen: this.generation,
          },
          control.at,
        );
        this.ackKeys.add(fingerprint);
        if (control.transferSig && control.pub) {
          this.transferApprovals.set(fingerprint, {
            fp: fingerprint,
            jwk: control.pub,
            sig: control.transferSig,
          });
          this.rebuildTransferProof();
        }
        this.updateHostQuorum();
        if (this.ackKeys.size >= this.requiredAcks) this.becomeAuthorityReady();
        return;
      }
      case 'presence':
        if (this.role === 'host' && this.peerKeys.get(from) !== fingerprint) return;
        this.peerSeen.set(control.peerId, Date.now());
        if (this.role === 'host') {
          this.guestSeen.set(from, Date.now());
          if (control.following?.hostFp === this.ownHostFingerprint()) {
            this.reviveSeatFromPeer(from, fingerprint);
          }
        }
        this.recordFollowing(fingerprint, control.following, control.at);
        return;
      case 'hb':
      case 'host': {
        // NOTE: never record control.gen before the claim is authenticated; an unauthenticated peer
        // could otherwise inflate the generation and hijack a future promotion.
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
      case 'gen_bump': {
        if (this.role !== 'host' || control.hostPeerId !== this.clientId) return;
        if (!this.isKnownSeatKey(fingerprint)) return;
        if (control.gen <= this.generation) return;
        this.highestGenerationSeen = Math.max(this.highestGenerationSeen, control.gen);
        this.generation = control.gen + 1;
        this.peerWelcomedInGen.clear();
        this.persistHostNow();
        this.announceHost();
        this.sendHeartbeat();
        this.broadcastGenerationSnapshot();
        this.controller?.rearmTurn();
        this.log(`generation bumped to ${this.generation} by request`);
        return;
      }
      case 'probeAck':
        return;
      case 'resync':
        if (this.role === 'host' && this.controller && this.peerKeys.get(from) === fingerprint) {
          this.guestSeen.set(from, Date.now());
          this.refreshFollowerFromDirectMessage(fingerprint);
          this.reviveSeatFromPeer(from, fingerprint);
          if (!this.controller.hasSeat(from)) {
            this.controller.connect(from);
          }
          this.controller.resync(from);
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

  private mergeAgreedSeatKeys(
    seatKeys?: Readonly<Record<string, string>>,
    reclaimKeys?: Readonly<Record<string, string>>,
  ): void {
    if (seatKeys) {
      for (const [seat, fp] of Object.entries(seatKeys)) {
        if (fp) this.agreedSeatKeys[seat] = fp;
      }
    }
    if (reclaimKeys) {
      for (const [seat, fp] of Object.entries(reclaimKeys)) {
        if (fp) this.agreedSeatKeys[seat] = fp;
      }
    }
  }

  private isKnownSeatKey(fingerprint: string): boolean {
    const snap = this.role === 'host' && this.controller ? this.controller.publicSnapshot() : null;
    if (snap) {
      if (Object.values(snap.seatKeys).includes(fingerprint)) return true;
      if (snap.reclaimKeys && Object.values(snap.reclaimKeys).includes(fingerprint)) return true;
    }
    if (Object.values(this.shadow.seatKeys).includes(fingerprint)) return true;
    if (Object.values(this.shadow.reclaimKeys).includes(fingerprint)) return true;
    return Object.values(this.agreedSeatKeys).includes(fingerprint);
  }

  private trustedSeatKey(seat: number): string | null {
    const key = String(seat);
    const snap = this.role === 'host' && this.controller ? this.controller.publicSnapshot() : null;
    if (snap?.seatKeys[key]) return snap.seatKeys[key];
    if (snap?.reclaimKeys?.[key]) return snap.reclaimKeys[key];
    if (this.shadow.seatKeys[key]) return this.shadow.seatKeys[key];
    if (this.shadow.reclaimKeys[key]) return this.shadow.reclaimKeys[key];
    return this.agreedSeatKeys[key] ?? null;
  }

  private hostHumanSeatCount(): number {
    const lobby = this.controller?.lobbyView() ?? this.shadow.lobby;
    return lobby?.seats.filter((seat) => seat.kind === 'human').length ?? 0;
  }

  private strictMajority(totalHumans: number): number {
    if (totalHumans <= 1) return 1;
    return Math.floor(totalHumans / 2) + 1;
  }

  /**
   * Self plus human seats whose LATEST liveness says they follow THIS host at THIS generation.
   * A peer that has switched to another host stops counting immediately, which is what freezes
   * the old host after a transfer.
   */
  private visibleHumanConfirmations(): number {
    const keys = this.controller?.publicSnapshot().seatKeys ?? this.shadow.seatKeys;
    const hostFp = this.identity?.fingerprint ?? this.clientId;
    const peerSilence = networkConfig.peerSilenceMs ?? DEFAULT_PEER_SILENCE_MS;
    return countFollowers(keys, this.followers, hostFp, Date.now(), peerSilence);
  }

  /**
   * A signed message from a peer whose fingerprint is pinned to a seat is proof that the owner is
   * back. After a partition the controller may have marked the seat disconnected (its conn was
   * dropped), so re-authenticate it as if the client had re-sent hello — otherwise the seat would
   * stay disconnected forever while the client keeps receiving updates and never re-hellos.
   */
  private reviveSeatFromPeer(from: string, fingerprint: string): void {
    if (this.role !== 'host' || !this.controller) return;
    const snap = this.controller.publicSnapshot();
    const seatIndex =
      Object.entries(snap.seatKeys).find(([, key]) => key === fingerprint)?.[0] ??
      Object.entries(snap.reclaimKeys ?? {}).find(([, key]) => key === fingerprint)?.[0];
    if (seatIndex === undefined) return;
    const info = this.controller.lobbyView().seats[Number(seatIndex)];
    if (!info || info.connected) return;
    if (info.kind !== 'human' && info.kind !== 'cpu') return;
    this.controller.connect(from);
    this.controller.message(from, {
      t: 'hello',
      v: PROTOCOL_VERSION,
      roomId: this.roomId,
      name: info.name || this.name,
      token: fingerprint,
      boardVersion: BOARD_VERSION,
    });
  }

  private ensureGuestMirrors(): void {
    if (this.role !== 'guest' || !this.transport) return;
    const baseBrokers = networkConfig.brokers ?? DEFAULT_BROKERS;
    const defaultGuestMirrors = Math.min(1, Math.max(0, baseBrokers.length - 1));
    const wantedMirrors = networkConfig.redundantBrokers ?? defaultGuestMirrors;
    if (wantedMirrors > 0) this.transport.setRedundantBrokers(wantedMirrors, baseBrokers);
  }

  private refreshFollowerFromDirectMessage(fingerprint: string): void {
    if (this.role !== 'host' || !this.controller) return;
    const snapNow = this.controller.publicSnapshot();
    const seated =
      Object.values(snapNow.seatKeys).includes(fingerprint) ||
      Object.values(snapNow.reclaimKeys ?? {}).includes(fingerprint);
    if (!seated) return;
    const hostFp = this.ownHostFingerprint();
    const record = this.followers.get(fingerprint);
    if (!record || record.hostFp === hostFp || record.gen < this.generation) {
      this.recordFollowing(fingerprint, { hostFp, gen: this.generation });
    }
  }

  private recordFollowing(
    fingerprint: string,
    following: { hostFp: string; gen: number } | null,
    senderAt?: number,
  ): void {
    const existing = this.followers.get(fingerprint);
    if (!following) {
      // Ignore stale out-of-order `following: null` presence arriving after a newer record.
      if (
        existing &&
        senderAt !== undefined &&
        existing.senderAt !== undefined &&
        senderAt <= existing.senderAt
      ) {
        return;
      }
      this.followers.delete(fingerprint);
      return;
    }
    if (existing) {
      // Never let a delayed packet from an older generation clobber a newer generation's follower!
      if (following.gen < existing.gen) return;
      if (
        following.gen === existing.gen &&
        following.hostFp !== existing.hostFp &&
        senderAt !== undefined &&
        existing.senderAt !== undefined &&
        senderAt < existing.senderAt
      ) {
        return;
      }
    }
    const nextSenderAt =
      senderAt !== undefined
        ? Math.max(senderAt, existing?.senderAt ?? senderAt)
        : existing?.senderAt;
    this.followers.set(fingerprint, {
      hostFp: following.hostFp,
      gen: following.gen,
      at: Date.now(),
      ...(nextSenderAt !== undefined ? { senderAt: nextSenderAt } : {}),
    });
  }

  private ownHostFingerprint(): string {
    return this.identity?.fingerprint ?? this.clientId;
  }

  private requiredAckCount(): number {
    const total = this.hostHumanSeatCount();
    if (total <= 1) return 0;
    // Acks exclude the host, so a strict majority of seats means floor(total/2) acks.
    return Math.floor(total / 2);
  }

  private updateHostQuorum(): void {
    if (this.role !== 'host') return;
    // A self-promoted (not yet confirmed) host must keep counting the AGREED lobby's human seats.
    // The controller would otherwise CPU-replace everyone it cannot hear after 120 s and let the
    // isolated branch "continue alone", forking the room on a public-broker partition.
    const currentHumans = this.hostHumanSeatCount();
    const total = this.promotionConfirmed
      ? currentHumans
      : Math.max(currentHumans, this.agreedHumanSeats);
    if (total <= 1) {
      if (!this.promotionConfirmed) {
        this.abandonUnconfirmedPromotion('no majority in the agreed lobby');
        return;
      }
      // A lone human (or a host whose absent partner was just CPU-replaced) is a majority of one.
      this.quorumMessageShown = false;
      if (!this.quorumOk) {
        this.quorumOk = true;
        this.authorityReady = true;
        this.controller?.setFrozen(false);
        this.controller?.rearmTurn();
        this.flushDeferredAction();
        this.log('host continues alone (no other human seats)');
      }
      return;
    }
    const needed = this.strictMajority(total);
    const visible = this.visibleHumanConfirmations();
    const ok = visible >= needed;
    if (!ok) {
      const graceMs = Math.max(2_000, (networkConfig.heartbeatMs ?? DEFAULT_HEARTBEAT_MS) * 2);
      const inInitialPromotionWindow =
        this.promotedAt > 0 && !this.promotionConfirmed && Date.now() - this.promotedAt < graceMs;
      if (ok === this.quorumOk) {
        // Still without quorum past the initial promotion grace: notify the UI once.
        if (!inInitialPromotionWindow && !this.quorumMessageShown) {
          this.quorumMessageShown = true;
          const text = `通信待ち：${needed} 人中 ${visible} 人しか接続できていません。再接続を待っています`;
          this.onServerMsg({ t: 'system', text });
          void this.transport?.broadcast({ t: 'system', text });
          this.log(`host quorum lost (${visible}/${needed})`);
        }
        return;
      }
      this.quorumOk = false;
      this.authorityReady = false;
      this.controller?.setFrozen(true);
      if (!inInitialPromotionWindow && !this.quorumMessageShown) {
        this.quorumMessageShown = true;
        const text = `通信待ち：${needed} 人中 ${visible} 人しか接続できていません。再接続を待っています`;
        this.onServerMsg({ t: 'system', text });
        void this.transport?.broadcast({ t: 'system', text });
        this.log(`host quorum lost (${visible}/${needed})`);
      }
      return;
    }
    if (ok === this.quorumOk) return;
    this.quorumOk = true;
    const hadShownLoss = this.quorumMessageShown;
    this.quorumMessageShown = false;
    if (this.promotedAt > 0 && !this.promotionConfirmed) {
      if (this.ackKeys.size < this.requiredAcks) {
        // Wait for explicit acks on a promoted host; heartbeat re-announcement solicits them.
        return;
      }
      // Quorum returned with required acks already gathered: run the full authority confirmation
      // path so promotionConfirmed flips to true, tasks re-arm, and the generation snapshot goes out.
      this.becomeAuthorityReady();
      if (hadShownLoss) {
        this.log(`host quorum restored (${visible}/${needed})`);
        const text = '通信が回復しました';
        this.onServerMsg({ t: 'system', text });
        void this.transport?.broadcast({ t: 'system', text });
      }
      return;
    }
    this.authorityReady = true;
    this.controller?.setFrozen(false);
    this.controller?.rearmTurn();
    this.flushDeferredAction();
    if (hadShownLoss) {
      this.log(`host quorum restored (${visible}/${needed})`);
      const text = '通信が回復しました';
      this.onServerMsg({ t: 'system', text });
      void this.transport?.broadcast({ t: 'system', text });
    }
  }

  private becomeAuthorityReady(): void {
    if ((this.authorityReady && this.promotionConfirmed) || !this.quorumOk) return;
    this.authorityReady = true;
    this.promotionConfirmed = true;
    this.rotationsSinceHostReply = 0;
    rememberHostKey(
      this.roomId,
      this.ownHostFingerprint(),
      this.generation,
      [...this.ackKeys],
      this.requiredAcks,
    );
    const seq = this.controller?.currentSeq ?? this.shadow.seq;
    if (seq !== this.lastBoardSeq || this.generation !== this.lastBoardGen) {
      this.resetHostStallWatch(seq);
    }
    this.log(`host authority confirmed (${this.ackKeys.size}/${this.requiredAcks} acks)`);
    this.debug('authority ready', this.debugSnapshot());
    this.sendHeartbeat();
    // Deliver the gen-confirmed snapshot BEFORE unfreezing/running overdue tasks so guests adopt
    // the new generation before any immediate turn timeout update arrives.
    this.broadcastGenerationSnapshot();
    this.controller?.setFrozen(false);
    this.controller?.rearmTurn();
    this.flushDeferredAction();
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
      reclaimKeys: snapshot.reclaimKeys,
      reportVotes: snapshot.reportVotes,
      lobby: snapshot.lobby,
      seq: snapshot.seq,
      gen: this.generation,
      connectedHumans: connectedHumans(snapshot.lobby),
      stateHash: stateHashOf(snapshot.state, snapshot.seq),
      broker: this.transport?.broker() ?? null,
      turnElapsedMs: snapshot.turnElapsedMs,
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
      reclaimKeys: this.shadow.reclaimKeys,
      reportVotes: this.shadow.reportVotes,
      lobby: this.shadow.lobby,
      seq: this.shadow.seq,
      gen: this.generation,
      connectedHumans: connectedHumans(this.shadow.lobby),
      stateHash: stateHashOf(this.shadow.state, this.shadow.seq),
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
    const own = this.ownHostClaim();
    if (!own) return;
    if (isStaleGeneration(control.gen, this.highestGenerationSeen)) {
      // Never ask a *behind* stale host to bump its generation — doing so would let a returning
      // old host announce a higher generation carrying stale state and roll back guests. Only
      // request a bump when the stale-gen peer actually has more progress (healed partition).
      if (control.seq > own.seq) {
        this.authorityReady = false;
        this.controller?.setFrozen(true);
        this.requestGenerationBump(control.hostPeerId, this.highestGenerationSeen);
        this.log(`winner ${control.hostPeerId} is ahead but announces stale gen ${control.gen}`);
        return;
      }
      if (control.seq === own.seq && claimBeats(control, own)) {
        this.requestGenerationBump(control.hostPeerId, this.highestGenerationSeen);
        this.log(`competing host ${control.hostPeerId} tied with stale gen ${control.gen}; requested bump`);
        return;
      }
      this.log(`drop competing host ${control.hostPeerId}: stale gen ${control.gen}`);
      this.announceHost();
      this.sendHeartbeat();
      return;
    }
    this.highestGenerationSeen = Math.max(this.highestGenerationSeen, control.gen);
    this.lastCompeting = { control, fingerprint, at: Date.now() };
    // Cross-generation ranking for a HEALED partition: the side with more real progress wins;
    // equal progress falls back to generation, then seq/connected/peer id. The winner's generation
    // is afterwards strictly greater than everything both sides saw, so one order survives.
    if (control.seq > own.seq) {
      this.authorityReady = false; // freeze immediately; the side with progress wins
      this.log(`yielding host role to ${control.hostPeerId} (seq ${control.seq} > ${own.seq})`);
      this.stepDownToGuest(control, fingerprint);
      return;
    }
    if (control.seq === own.seq && claimBeats(control, own)) {
      this.authorityReady = false;
      this.log(`yielding host role to ${control.hostPeerId} (same seq, higher rank)`);
      this.stepDownToGuest(control, fingerprint);
      return;
    }
    // This side has more (or equal, lower-ranked) progress: keep authority, but move the generation
    // above every generation either side has seen so the returning side cannot re-win on gen alone.
    if (control.gen >= this.generation) {
      this.generation = nextGeneration([this.highestGenerationSeen, control.gen, this.generation]);
      this.highestGenerationSeen = this.generation;
      this.peerWelcomedInGen.clear();
      this.persistHostNow();
      this.announceHost();
      this.sendHeartbeat();
      this.broadcastGenerationSnapshot();
      this.controller?.rearmTurn();
      this.log(`kept authority over ${control.hostPeerId} with generation ${this.generation}`);
    }
  }

  /**
   * A guest that promoted itself is a provisional authority. If it cannot confirm a majority (or
   * the agreed lobby says more humans exist than it can ever hear), it must give the role up and
   * keep searching for the real room instead of forking it.
   */
  private abandonUnconfirmedPromotion(reason: string): void {
    if (this.role !== 'host' || this.promotionConfirmed) return;
    this.log(`abandoning unconfirmed promotion: ${reason}`);
    this.controller?.dispose();
    this.controller = null;
    this.role = 'guest';
    this.promotedAt = 0;
    this.authorityReady = false;
    this.quorumOk = false;
    this.switchingAuthority = false;
    this.hostPeerId = null;
    this.hostKeyFingerprint = null;
    this.hostSeat = null;
    this.pendingAction = null;
    this.deferredAction = null;
    this.setState('reconnecting');
    this.broadcastPresence();
    this.sendHello();
    this.maybeRotateBrokerForMissingHost(Date.now(), true);
  }

  /**
   * Only promote where a majority of the AGREED lobby's human seats is actually reachable. A guest
   * that sees nobody must keep rotating brokers instead of forking the room with a new authority.
   * Duels (<=2 humans) keep the old behaviour so a killed host can still be replaced.
   */
  private mayPromote(now: number): boolean {
    const lobby = this.shadow.lobby;
    if (!lobby) return false;
    const humans = lobby.seats.filter((seat) => seat.kind === 'human');
    if (humans.length <= 2) return true;
    const needed = Math.floor(humans.length / 2) + 1;
    const peerSilence = networkConfig.peerSilenceMs ?? DEFAULT_PEER_SILENCE_MS;
    const alive = new Set<string>();
    for (const [peerId, seen] of this.peerSeen) {
      if (now - seen > peerSilence) continue;
      const fingerprint = this.peerKeys.get(peerId);
      if (fingerprint) alive.add(fingerprint);
    }
    let visible = 0;
    for (const seat of humans) {
      if (seat.index === this.seat) {
        visible += 1;
        continue;
      }
      const key = this.shadow.seatKeys[String(seat.index)];
      if (key && alive.has(key)) visible += 1;
    }
    return visible >= needed;
  }

  private requestGenerationBump(hostPeerId: string, gen: number): void {
    void this.transport?.send(hostPeerId, {
      k: 'gen_bump',
      hostPeerId,
      from: this.clientId,
      gen: Math.max(gen, this.highestGenerationSeen),
      at: Date.now(),
    });
  }

  private handleHostHeartbeat(control: Extract<P2PControl, { k: 'hb' }>, fingerprint: string): void {
    if (control.hostPeerId === this.clientId) return;
    if (control.hostSeat === null) return;
    // Offline/rejoining guest carrying an older invite URL (?k=<initial host>): verify the
    // host's transfer proof anchored to that invite pin before pinning the successor key.
    if (
      !this.hostPeerId &&
      this.expectedHostFingerprint &&
      !fingerprint.startsWith(this.expectedHostFingerprint) &&
      control.transferProof
    ) {
      void this.tryAdoptTransferProof(control, fingerprint);
      return;
    }
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
      if (isStaleGeneration(control.gen, this.highestGenerationSeen)) {
        // Only ask a different peer to bump when it actually has newer state than our shadow;
        // otherwise a returning old host would mint a higher generation with stale state.
        if (control.seq > this.shadow.seq) {
          this.requestGenerationBump(control.hostPeerId, this.highestGenerationSeen);
        }
        this.log(`drop stale heartbeat gen ${control.gen} from ${control.hostPeerId}`);
        return;
      }
      this.highestGenerationSeen = Math.max(this.highestGenerationSeen, control.gen);
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
    this.lastHostReplyAt = Date.now();
    this.rotationsSinceHostReply = 0;
    this.brokerMisses.clear();
    this.ensureGuestMirrors();
    if (this.hostKeyFingerprint === null) this.hostKeyFingerprint = fingerprint;
    if (control.rosterCert) void this.ingestRosterCert(control.rosterCert);
    if (control.transferProof) {
      this.transferProof = control.transferProof;
      saveTransferProof(this.roomId, control.transferProof);
    }
    if (control.gen < this.highestGenerationSeen) {
      // Never move the session/UI order backwards: ask the authority to bump above what we saw.
      this.requestGenerationBump(control.hostPeerId, this.highestGenerationSeen);
      this.log(`host gen ${control.gen} is behind seen ${this.highestGenerationSeen}; requested a bump`);
      return;
    }
    this.highestGenerationSeen = Math.max(this.highestGenerationSeen, control.gen);
    if (control.gen > this.generation) this.generation = control.gen;
    this.lastHostHeartbeatAt = Date.now();
    this.lastLivenessAt = Date.now();
    this.probeStartedAt = 0;
    if (control.gen === this.generation && this.switchingAuthority) {
      // The acknowledged host is alive at the new generation; the board may be identical, so no
      // state message would arrive to clear this. Without clearing it every action would be
      // deferred forever after a partition heal.
      this.switchingAuthority = false;
      this.flushDeferredAction();
    }
    this.sendHostAck(control.hostPeerId, control.gen);
    this.hostSeat = control.hostSeat;
    this.shadow.hostSeat = control.hostSeat;
    this.shadow.seatKeys = { ...control.seatKeys };
    this.shadow.reclaimKeys = { ...(control.reclaimKeys ?? {}) };
    this.mergeAgreedSeatKeys(control.seatKeys, control.reclaimKeys);
    this.shadow.reportVotes = { ...control.reportVotes };
    this.lastLobby = control.lobby;
    this.shadow.lobby = control.lobby;
    if (
      control.seq === this.shadow.seq &&
      typeof control.turnElapsedMs === 'number' &&
      Number.isFinite(control.turnElapsedMs)
    ) {
      this.updateShadowTurnElapsed(control.turnElapsedMs);
    }
    if (control.broker) {
      this.hostBroker = control.broker;
      discoveredBroker.set(this.roomId, control.broker);
    }
    const ownSeat = Object.keys(control.seatKeys).find(
      (seatIndex) => control.seatKeys[seatIndex] === this.identity?.fingerprint,
    );
    if (ownSeat !== undefined) this.seat = Number(ownSeat);
    if (
      this.pendingAction &&
      isNewerStateOrder(this.pendingAction.gen, this.pendingAction.seq, control.gen, control.seq)
    ) {
      this.pendingAction = null;
    }
    if (!this.lastWelcome || this.connectionState !== 'open') this.sendHello();
    const ownHash = stateHashOf(this.shadow.state, this.shadow.seq);
    const playing = this.shadow.lobby?.status === 'playing' || this.shadow.lobby?.status === 'finished';
    if (
      playing &&
      this.shadow.state !== null &&
      control.gen === this.shadowGeneration &&
      control.seq === this.shadow.seq &&
      control.stateHash !== ownHash
    ) {
      this.maybeResync(control.hostPeerId, control.seq + 1);
      return;
    }
    this.maybeResync(control.hostPeerId, control.seq, control.gen);
  }

  private switchHost(control: Extract<P2PControl, { k: 'host' }>, fingerprint: string): void {
    if (control.hostPeerId === this.clientId) return;
    if (control.hostSeat === null) return;
    if (
      !this.hostPeerId &&
      this.expectedHostFingerprint &&
      !fingerprint.startsWith(this.expectedHostFingerprint) &&
      control.transferProof
    ) {
      void this.tryAdoptTransferProof(control, fingerprint);
      return;
    }
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
    if (isStaleGeneration(control.gen, this.highestGenerationSeen)) {
      if (control.hostPeerId === this.hostPeerId || control.seq > this.shadow.seq) {
        this.requestGenerationBump(control.hostPeerId, this.highestGenerationSeen);
        this.log(`host announcement gen ${control.gen} is behind seen ${this.highestGenerationSeen}; requested a bump`);
      } else {
        this.log(`drop stale host announcement gen ${control.gen} from ${control.hostPeerId} (seq ${control.seq} <= ${this.shadow.seq})`);
      }
      return;
    }
    this.highestGenerationSeen = Math.max(this.highestGenerationSeen, control.gen);
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
    this.lastHostReplyAt = Date.now();
    if (isStaleGeneration(control.gen, this.highestGenerationSeen) && !forceReset) {
      this.log(`ignore host claim ${control.hostPeerId}: gen ${control.gen} < seen ${this.highestGenerationSeen}`);
      return;
    }
    // A side that was itself running a branch (authority or self-promoted) loses that branch when
    // it adopts another authority. A frozen/catching-up client needs no scary message.
    const hadOwnProgress = this.shadow.state !== null && (this.promotedAt > 0 || this.role === 'host');
    // Generation regression is impossible across a real transfer (both sides bump above their
    // maxima), so if we have seen a HIGHER generation than the winner announces, the winner must
    // move up before this side can fully trust it - otherwise the two sides would keep yielding
    // to each other's old generations and the room would never advance.
    const seenAbove = this.highestGenerationSeen > control.gen;
    this.highestGenerationSeen = Math.max(this.highestGenerationSeen, control.gen);
    const previousHostPeerId = this.hostPeerId;
    const previousHostFp = this.hostKeyFingerprint;
    if (previousHostFp && previousHostFp !== fingerprint) {
      this.prevHostFpForTransfer = previousHostFp;
    }
    this.hostPeerId = control.hostPeerId;
    this.hostSeat = control.hostSeat;
    this.hostKeyFingerprint = fingerprint;
    this.expectedHostFingerprint = fingerprint;
    if (control.rosterCert) void this.ingestRosterCert(control.rosterCert);
    if (control.transferProof) {
      this.transferProof = control.transferProof;
      saveTransferProof(this.roomId, control.transferProof);
    }
    // The claim key is pinned to an agreed lobby seat (claimSeatKey) and every envelope is signed,
    // so this is an agreed-seat approval. Record it as the room's verified successor.
    rememberHostKey(this.roomId, fingerprint, control.gen, [fingerprint], 1);
    // The following-record on the ack is what counts this peer toward the new host's quorum.
    this.lastLivenessAt = Date.now();
    this.pendingAction = null;
    this.switchingAuthority = true;
    this.generation = control.gen;
    this.lastHostHeartbeatAt = Date.now();
    this.probeStartedAt = 0;
    this.shadow.hostSeat = control.hostSeat;
    this.shadow.seatKeys = { ...control.seatKeys };
    this.shadow.reclaimKeys = { ...(control.reclaimKeys ?? {}) };
    this.mergeAgreedSeatKeys(control.seatKeys, control.reclaimKeys);
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
      this.shadow.turnElapsedMs = 0;
      this.shadow.turnElapsedAt = 0;
      this.lastSnapshot = null;
      this.lastUpdate = null;
    } else if (
      control.seq === this.shadow.seq &&
      typeof control.turnElapsedMs === 'number' &&
      Number.isFinite(control.turnElapsedMs)
    ) {
      this.updateShadowTurnElapsed(control.turnElapsedMs);
    }
    if (previousHostPeerId && previousHostPeerId !== control.hostPeerId && previousHostFp) {
      // Tell the old host immediately that this seat now follows the new authority; it must stop
      // counting this seat toward its quorum right away (not after a silence timeout).
      void this.transport?.send(previousHostPeerId, {
        k: 'presence',
        peerId: this.clientId,
        seat: this.seat,
        following: { hostFp: fingerprint, gen: control.gen },
        at: Date.now(),
      });
    }
    this.setState('reconnecting');
    this.sendHello();
    this.sendHostAck(control.hostPeerId, control.gen);
    this.broadcastPresence();
    if (seenAbove) this.requestGenerationBump(control.hostPeerId, this.highestGenerationSeen);
    setTimeout(() => this.maybeResync(control.hostPeerId, control.seq, control.gen), 100);
    if (hadOwnProgress) {
      // A strictly newer authority wins; whatever this side advanced during the partition is void.
      this.onServerMsg({
        t: 'system',
        text: '通信が分断されていた間の進行は取り消されました',
      });
    }
  }

  private sendHostAck(hostPeerId: string, gen: number): void {
    if (this.seat === null) return;
    const now = Date.now();
    if (this.lastAckGen === gen && now - this.lastAckAt < 2_000) return;
    this.lastAckGen = gen;
    this.lastAckAt = now;
    const hostFp = this.hostKeyFingerprint ?? '';
    const baseAck = {
      k: 'host_ack' as const,
      hostPeerId,
      gen,
      seat: this.seat,
      hostFp,
      at: now,
    };
    const identity = this.identity;
    const prevHostFp = this.rosterCert?.hostFp ?? this.prevHostFpForTransfer ?? '';
    if (identity && hostFp && prevHostFp && gen >= 2) {
      const payload = transferApprovalPayload(this.roomId, gen, hostFp, prevHostFp);
      void signData(identity, payload)
        .then((transferSig) => {
          if (this.closed || this.crashed) return;
          void this.transport?.send(hostPeerId, {
            ...baseAck,
            transferSig,
            pub: identity.publicJwk,
          });
        })
        .catch(() => {
          void this.transport?.send(hostPeerId, baseAck);
        });
      return;
    }
    void this.transport?.send(hostPeerId, baseAck);
  }

  private async ingestRosterCert(cert: SeatRosterCert): Promise<void> {
    if (this.rosterCert && this.rosterCert.sig === cert.sig) return;
    const expectedHint = this.rosterCert?.hostFp ?? this.expectedHostFingerprint;
    const verified = await verifySeatRosterCert(cert, this.roomId, expectedHint);
    if (!verified) return;
    this.rosterCert = cert;
  }

  private async maybeRefreshRosterCert(): Promise<void> {
    if (this.role !== 'host' || !this.controller || !this.identity) return;
    // Only the initial authority signs the seat roster (subsequent hosts carry it forward).
    if (this.rosterCert && this.rosterCert.hostFp !== this.identity.fingerprint) return;
    const snap = this.controller.publicSnapshot();
    const seats: Record<string, JsonWebKey> = {};
    const keys = Object.entries(snap.seatKeys).sort((a, b) => Number(a[0]) - Number(b[0]));
    if (keys.length === 0) return;
    for (const [seatIndex, fp] of keys) {
      const jwk = this.seatJwks.get(fp);
      if (!jwk) return; // wait until every seated human's JWK is known
      seats[seatIndex] = jwk;
    }
    const sigKey = keys.map(([seat, fp]) => `${seat}=${fp}`).join(',');
    if (sigKey === this.rosterCertSigKey) return;
    this.rosterCertSigKey = sigKey;
    const payload = rosterCertPayload(this.roomId, this.identity.fingerprint, seats);
    try {
      const sig = await signData(this.identity, payload);
      if (this.closed || this.crashed || this.role !== 'host') return;
      this.rosterCert = {
        roomId: this.roomId,
        hostFp: this.identity.fingerprint,
        hostJwk: this.identity.publicJwk,
        seats,
        at: Date.now(),
        sig,
      };
    } catch {
      this.rosterCertSigKey = '';
    }
  }

  private rebuildTransferProof(): void {
    if (this.role !== 'host' || !this.rosterCert || !this.identity) return;
    const prevHostFp = this.rosterCert.hostFp;
    if (!prevHostFp || this.generation < 2) return;
    const proof: TransferProof = {
      roomId: this.roomId,
      roster: this.rosterCert,
      gen: this.generation,
      newHostFp: this.identity.fingerprint,
      prevHostFp,
      approvals: [...this.transferApprovals.values()],
    };
    this.transferProof = proof;
    saveTransferProof(this.roomId, proof);
  }

  private async tryAdoptTransferProof(control: HostClaim, fingerprint: string): Promise<void> {
    const proof = control.transferProof;
    const hint = this.expectedHostFingerprint;
    if (!proof || !hint) return;
    if (proof.newHostFp !== fingerprint) return;
    const key = `${fingerprint}:${proof.gen}:${proof.approvals.length}`;
    if (this.verifyingProofKey === key) return;
    this.verifyingProofKey = key;
    try {
      const valid = await verifyTransferProof(proof, this.roomId, hint);
      if (!valid || this.closed || this.crashed || this.role !== 'guest') return;
      if (this.hostPeerId === control.hostPeerId && this.hostKeyFingerprint === fingerprint) return;
      this.rosterCert = proof.roster;
      this.transferProof = proof;
      saveTransferProof(this.roomId, proof);
      this.expectedHostFingerprint = fingerprint;
      rememberHostKey(
        this.roomId,
        fingerprint,
        proof.gen,
        proof.approvals.map((approval) => approval.fp),
        1,
      );
      this.mergeAgreedSeatKeys(control.seatKeys, control.reclaimKeys);
      this.adoptHostClaim(control, fingerprint, false);
    } finally {
      if (this.verifyingProofKey === key) this.verifyingProofKey = null;
    }
  }

  private stepDownToGuest(control: HostClaim, fingerprint: string): void {
    if (control.hostSeat === null) return;
    const expected = this.claimSeatKey(control, fingerprint);
    if (expected === null) return;
    const hadProgress = this.shadow.state !== null && this.shadow.seq > 0;
    this.controller?.dispose();
    this.controller = null;
    this.role = 'guest';
    this.authorityReady = false;
    this.promotedAt = 0;
    this.hostFollowers.clear();
    this.lastCompeting = null;
    this.adoptHostClaim(control, fingerprint, true);
    storageRemove('session', HOST_SAVE_KEY);
    if (hadProgress) {
      this.onServerMsg({ t: 'system', text: '通信が分断されていた間の進行は取り消されました' });
    }
  }

  /**
   * A generation-only change (promotion, gen_bump, authority confirmation) must re-deliver the
   * board. Actions carry the generation of the state the UI actually APPLIED; after a bump nobody
   * has applied anything at the new generation, and no other message would ever carry it — a human
   * turn with no time limit would stall forever. The snapshot is fx-less (state adopt, no replay).
   */
  private broadcastGenerationSnapshot(): void {
    if (this.role !== 'host' || !this.controller) return;
    const snapshot = this.controller.publicSnapshot();
    if (!snapshot.state) return;
    if (snapshot.lobby.status !== 'playing' && snapshot.lobby.status !== 'finished') return;
    const message: ServerMsg = {
      t: 'snapshot',
      seq: snapshot.seq,
      state: snapshot.state,
      deadline: snapshot.deadline,
      lobby: snapshot.lobby,
      gen: this.generation,
      resync: true,
      turnElapsedMs: snapshot.turnElapsedMs,
      boardVersion: BOARD_VERSION,
    };
    // Own UI first: it is the one that has to re-arm its action buttons for the new generation.
    this.onServerMsg(message);
    void this.transport?.broadcast(message);
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

  private maybeResync(hostPeerId: string, hostSeq: number, hostGen?: number): void {
    if (this.role !== 'guest' || !this.transport) return;
    // Resync is decided by the (gen, seq) PAIR: the same seq under a new generation is a different
    // board state (actions are bound to their generation) and must be re-fetched.
    const genAhead = hostGen !== undefined && hostGen > this.shadowGeneration;
    const playing = this.shadow.lobby?.status === 'playing' || this.shadow.lobby?.status === 'finished';
    if (!genAhead && hostSeq <= this.shadow.seq && !(playing && !this.shadow.state)) return;
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

  /** Vote receivers whose ack is required: every current human seat (including the voter, who may inherit host). */
  private voteAckTargets(_target: number, _voter: string): Set<string> {
    const keys = this.controller?.publicSnapshot().seatKeys ?? {};
    return reportVoteAckTargets(keys, this.ownHostFingerprint());
  }

  /**
   * Replicate a report vote that RoomController has ACCEPTED (called from deps.reportAccepted).
   * Receivers verify the host fingerprint, generation and voter before applying; resends continue
   * until every current human seat (and thus the would-be successor) has acked.
   */
  private replicateReport(target: number, voter: string): void {
    if (this.role !== 'host') return;
    const seatKeys = this.controller?.publicSnapshot().seatKeys ?? {};
    if (!Object.values(seatKeys).includes(voter)) return;
    const voterSeat = Object.entries(seatKeys).find(([, key]) => key === voter)?.[0];
    if (voterSeat !== undefined && Number(voterSeat) === target) return;
    this.updateShadowVote(target, voter);
    this.reportVoteSeq += 1;
    const hostFp = this.ownHostFingerprint();
    const control: Extract<P2PControl, { k: 'report_vote' }> = {
      k: 'report_vote',
      voteId: `${this.clientId.slice(0, 6)}-${Date.now().toString(36)}-${this.reportVoteSeq}`,
      target,
      voter,
      gen: this.generation,
      hostFp,
      at: Date.now(),
    };
    const needed = this.voteAckTargets(target, voter);
    if (needed.size === 0) return; // nobody else to inform
    this.pendingVotes.set(control.voteId, {
      control,
      sentAt: Date.now(),
      firstSentAt: Date.now(),
      attempts: 1,
      acked: new Set(),
    });
    void this.transport?.broadcast(control);
  }

  private buildHeartbeat(): Extract<P2PControl, { k: 'hb' }> | null {
    if (this.role !== 'host' || !this.controller || !this.transport) return null;
    const snapshot = this.controller.publicSnapshot();
    this.mergeAgreedSeatKeys(snapshot.seatKeys, snapshot.reclaimKeys);
    return {
      k: 'hb',
      hostPeerId: this.clientId,
      seat: this.seat,
      hostSeat: snapshot.hostSeat,
      seatKeys: snapshot.seatKeys,
      reclaimKeys: snapshot.reclaimKeys,
      reportVotes: snapshot.reportVotes,
      lobby: snapshot.lobby,
      seq: snapshot.seq,
      gen: this.generation,
      connectedHumans: connectedHumans(snapshot.lobby),
      stateHash: stateHashOf(snapshot.state, snapshot.seq),
      broker: this.transport.broker(),
      turnElapsedMs: snapshot.turnElapsedMs,
      ...(this.rosterCert ? { rosterCert: this.rosterCert } : {}),
      ...(this.transferProof ? { transferProof: this.transferProof } : {}),
      at: Date.now(),
    };
  }

  private sendHeartbeatTo(peerId: string): void {
    const heartbeat = this.buildHeartbeat();
    if (!heartbeat) return;
    void this.transport?.send(peerId, heartbeat);
  }

  private sendHeartbeat(): void {
    void this.maybeRefreshRosterCert();
    const heartbeat = this.buildHeartbeat();
    if (!heartbeat || !this.transport) return;
    void this.transport.broadcast(heartbeat);
    const now = Date.now();
    for (const [voteId, pending] of this.pendingVotes) {
      if (now - pending.sentAt < 2_000) continue;
      // Keep re-sending until every human seat (and thus the would-be successor) has acked. The
      // only give-up condition is time: a seat that never returns cannot be waited on forever.
      if (now - pending.firstSentAt > 30_000) {
        this.pendingVotes.delete(voteId);
        this.log(`report vote ${voteId} expired without all acks`, { acked: [...pending.acked] });
        continue;
      }
      pending.sentAt = now;
      pending.attempts += 1;
      void this.transport?.broadcast(pending.control);
    }
  }

  /**
   * Liveness is broadcast so every peer can tell who is still reachable (the takeover probe needs
   * that), but it always names the ONE host this client follows and its generation. A host counts
   * a peer toward its quorum only while that peer's latest liveness names this host, so a peer that
   * switched to a new authority immediately stops propping up the old one.
   */
  private broadcastPresence(): void {
    if (this.role !== 'guest' || !this.transport) return;
    const presence: P2PControl = {
      k: 'presence',
      peerId: this.clientId,
      seat: this.seat,
      following:
        this.hostKeyFingerprint && this.hostPeerId
          ? { hostFp: this.hostKeyFingerprint, gen: this.generation }
          : null,
      at: Date.now(),
    };
    void this.transport.broadcast(presence);
  }

  private announceHost(): void {
    if (this.role !== 'host' || !this.controller || !this.transport) return;
    const snapshot = this.controller.publicSnapshot();
    this.mergeAgreedSeatKeys(snapshot.seatKeys, snapshot.reclaimKeys);
    void this.transport.broadcast({
      k: 'host',
      hostPeerId: this.clientId,
      seat: this.seat,
      hostSeat: snapshot.hostSeat,
      seatKeys: snapshot.seatKeys,
      reclaimKeys: snapshot.reclaimKeys,
      reportVotes: snapshot.reportVotes,
      lobby: snapshot.lobby,
      seq: snapshot.seq,
      gen: this.generation,
      connectedHumans: connectedHumans(snapshot.lobby),
      stateHash: stateHashOf(snapshot.state, snapshot.seq),
      broker: this.transport.broker(),
      turnElapsedMs: snapshot.turnElapsedMs,
      ...(this.rosterCert ? { rosterCert: this.rosterCert } : {}),
      ...(this.transferProof ? { transferProof: this.transferProof } : {}),
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
      if ((!this.authorityReady || !this.promotionConfirmed) && this.promotedAt > 0) {
        if (this.ackKeys.size >= this.requiredAcks) this.becomeAuthorityReady();
        if (!this.authorityReady && now - this.promotedAt > 1_500) this.sendHeartbeat();
      }
      this.checkHostProgressStall(now);
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
    this.flushDeferredAction();
    if (
      this.hostPeerId &&
      this.generation > this.shadowGeneration &&
      (this.shadow.lobby?.status === 'playing' || this.shadow.lobby?.status === 'finished')
    ) {
      this.maybeResync(this.hostPeerId, this.shadow.seq, this.generation);
    }
    if (typeof document === 'undefined' || document.visibilityState === 'visible') {
      if (now - this.lastLivenessAt > REAUTH_SILENCE_MS) {
        this.reauthenticate('no server activity while visible');
      }
    }
    this.maybeRotateBrokerForMissingHost(now);
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
    if (!this.mayPromote(now)) {
      // No majority visible: never fork the room; keep looking for the real authority.
      this.log('not promoting: no majority of the agreed lobby is reachable');
      this.maybeRotateBrokerForMissingHost(now, true);
      return;
    }
    if (this.isLowestAliveHuman(now)) this.promoteToHost();
  }

  private resetHostStallWatch(seq: number): void {
    this.lastBoardGen = this.generation;
    this.lastBoardSeq = seq;
    this.lastBoardAdvanceAt = Date.now();
    this.hostStallRearms = 0;
    this.lastHostStallRearmAt = 0;
  }

  /**
   * Bounded host-side safety net: if an active, confirmed, unfrozen host fails to advance an
   * autonomous or timed turn (CPU, autoplay, disconnected grace, year_end ack, or timed human turn)
   * past its fx+timer budget + extra grace (default 10s), or if its expected scheduler task went
   * missing, re-arm the room tasks and log a warning. Capped per (gen, seq) so it never loops.
   */
  private checkHostProgressStall(now: number): void {
    if (
      this.role !== 'host' ||
      !this.controller ||
      !this.authorityReady ||
      !this.quorumOk ||
      this.controller.isFrozen
    ) {
      return;
    }
    if (this.controller.roomStatus !== 'playing') {
      this.lastBoardAdvanceAt = now;
      this.hostStallRearms = 0;
      return;
    }
    const seq = this.controller.currentSeq;
    if (seq !== this.lastBoardSeq || this.generation !== this.lastBoardGen) {
      this.resetHostStallWatch(seq);
      return;
    }
    const maxRearms = networkConfig.maxHostStallRearms ?? DEFAULT_MAX_HOST_STALL_REARMS;
    if (this.hostStallRearms >= maxRearms) return;
    const expectedWait = this.controller.expectedProgressWaitMs();
    if (expectedWait === null) return;
    const extraMs = networkConfig.hostStallExtraMs ?? DEFAULT_HOST_STALL_EXTRA_MS;
    const since = Math.max(this.lastBoardAdvanceAt, this.lastHostStallRearmAt);
    const taskMissing = !this.controller.hasExpectedProgressTask();
    const threshold = taskMissing ? Math.min(2_000, extraMs) : expectedWait + extraMs;
    if (now - since < threshold) return;

    this.hostStallRearms += 1;
    this.lastHostStallRearmAt = now;
    const snap = this.controller.debugSnapshot();
    if (this.hostStallRearms >= maxRearms) {
      console.warn(
        `[online ${this.roomId}] [STALL-FORCE] host board stalled at gen=${this.generation} seq=${seq} ` +
          `for ${now - this.lastBoardAdvanceAt}ms (taskMissing=${String(taskMissing)}, rearm ${this.hostStallRearms}/${maxRearms}); ` +
          'forcing deadline to now',
        { actorSeat: snap.actorSeat, phase: snap.phase, tasks: snap.tasks },
      );
      if (!this.controller.forceExpireTurnNow()) {
        this.controller.rearmTurn();
      }
      this.debug('host stall forced expiry complete', this.debugSnapshot());
      return;
    }
    this.log(
      `host board stalled at gen=${this.generation} seq=${seq} for ${now - this.lastBoardAdvanceAt}ms ` +
        `(taskMissing=${String(taskMissing)}, rearm ${this.hostStallRearms}/${maxRearms}); re-arming room tasks`,
      { actorSeat: snap.actorSeat, phase: snap.phase, tasks: snap.tasks },
    );
    this.controller.rearmTurn();
    this.debug('host stall rearm complete', this.debugSnapshot());
  }

  /**
   * MQTT is QoS1, but public brokers still occasionally lose a packet. Lobby requests and the
   * current action are idempotent at the protocol level (repeat take_seat re-sends welcome; repeat
   * action with the same (gen, seq) is replayed idempotently by the host without double-applying).
   * Safety net is strictly bounded: resend up to maxActionRetries after actionRetryMs (default 6s),
   * then request resync up to maxActionResyncs, then clear & soft-reject so UI never wedges.
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
    const pending = this.pendingAction;
    if (!pending) return;
    if (isNewerStateOrder(pending.gen, pending.seq, this.shadowGeneration, this.shadow.seq)) {
      this.pendingAction = null;
      return;
    }
    const retryMs = networkConfig.actionRetryMs ?? DEFAULT_ACTION_RETRY_MS;
    const resyncMs = networkConfig.actionResyncMs ?? DEFAULT_ACTION_RESYNC_MS;
    const maxRetries = networkConfig.maxActionRetries ?? DEFAULT_MAX_ACTION_RETRIES;
    const maxResyncs = networkConfig.maxActionResyncs ?? DEFAULT_MAX_ACTION_RESYNCS;

    // If the host generation moved on while our action was pending, never resend under the old
    // generation; immediately escalate to resync (bounded) so we adopt the new board cleanly.
    const sameGen = pending.gen === this.generation;
    if (sameGen && pending.retries < maxRetries) {
      if (now - pending.sentAt >= retryMs) {
        pending.sentAt = now;
        pending.retries += 1;
        this.debug('resend pending action', {
          gen: pending.gen,
          seq: pending.seq,
          t: pending.action.t,
          retry: pending.retries,
          maxRetries,
        });
        this.deliverToHost({
          t: 'action',
          gen: pending.gen,
          seq: pending.seq,
          action: pending.action,
        });
      }
      return;
    }
    const sinceLast = pending.lastResyncAt > 0 ? now - pending.lastResyncAt : now - pending.sentAt;
    if (sinceLast < resyncMs) return;
    if (pending.resyncs < maxResyncs) {
      pending.resyncs += 1;
      pending.lastResyncAt = now;
      this.debug('escalate pending action to resync', {
        gen: pending.gen,
        seq: pending.seq,
        t: pending.action.t,
        resync: pending.resyncs,
        maxResyncs,
      });
      this.requestResync();
      return;
    }
    // Bounded upper limit reached: release UI lock and stop retrying.
    this.log(
      `pending action timed out at gen=${pending.gen} seq=${pending.seq} after ${pending.retries} retries and ${pending.resyncs} resyncs`,
    );
    this.pendingAction = null;
    this.softReject('操作の応答がありませんでした。最新の状態を確認してもう一度お試しください');
  }

  /**
   * The MQTT connection can stay healthy while the host is not on this broker (it moved). MQTT
   * status alone therefore cannot decide the broker: rotate when authenticated host replies stop,
   * remembering brokers that did not answer and skipping them on the next attempt.
   */
  private maybeRotateBrokerForMissingHost(now: number, force = false): void {
    if (this.role !== 'guest' || !this.transport) return;
    if (!force) {
      if (!this.hostPeerId) return;
      if (this.transport.status() !== 'open') return;
      if (this.lastHostReplyAt === 0) return;
      const silence = networkConfig.hostReplySilenceMs ?? HOST_REPLY_SILENCE_MS;
      if (now - this.lastHostReplyAt <= silence) return;
    }
    const retry = networkConfig.brokerRetryMs ?? BROKER_RETRY_MS;
    // Retry a broker with no host reply on a bounded backoff instead of settling on it forever.
    const backoff = retry * Math.min(4, Math.max(1, this.rotationsSinceHostReply + 1));
    if (!force && now - this.lastBrokerRotateAt < backoff) return;
    const base = this.brokerCandidates();
    if (base.length < 2) return;
    this.lastBrokerRotateAt = now;
    this.rotationsSinceHostReply += 1;
    const current = this.transport.broker();
    if (current) this.brokerMisses.add(current);
    this.brokerAttempt += 1;
    this.log(
      force
        ? 'searching for the host on the next broker'
        : `no authenticated host reply for ${networkConfig.hostReplySilenceMs ?? HOST_REPLY_SILENCE_MS}ms; trying the next broker`,
    );
    const old = this.transport;
    this.transport = null;
    if (old) void old.close();
    this.connectGuestTransport();
  }

  private brokerCandidates(): string[] {
    const base = networkConfig.brokers ?? DEFAULT_BROKERS;
    // Brokers that once missed the host come back into rotation after a full pass, because a host
    // can migrate onto them (public brokers are flaky; nobody stays excluded for good).
    const misses = this.rotationsSinceHostReply > base.length ? new Set<string>() : this.brokerMisses;
    if (this.rotationsSinceHostReply > base.length) this.brokerMisses.clear();
    return rotateBrokers(base, this.brokerAttempt, misses);
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

  private currentShadowTurnElapsedMs(now = Date.now()): number {
    return (
      this.shadow.turnElapsedMs +
      (this.shadow.turnElapsedAt > 0 ? Math.max(0, now - this.shadow.turnElapsedAt) : 0)
    );
  }

  private updateShadowTurnElapsed(elapsedMs: number): void {
    const now = Date.now();
    const next = Math.max(0, elapsedMs);
    // Keep elapsed time monotonic within the same (gen, seq) so a delayed heartbeat from a
    // secondary mirror broker can never roll the estimated elapsed time backwards.
    if (next >= this.currentShadowTurnElapsedMs(now)) {
      this.shadow.turnElapsedMs = next;
      this.shadow.turnElapsedAt = now;
    }
  }

  private promoteToHost(): void {
    if (this.role !== 'guest' || this.promoting || !this.shadow.lobby || this.seat === null) return;
    this.promoting = true;
    try {
      const turnElapsedMs = this.currentShadowTurnElapsedMs();
      const snapshot: RoomPublicSnapshot = {
        roomId: this.roomId,
        lobby: this.shadow.lobby,
        state: this.shadow.state,
        seq: this.shadow.seq,
        chat: this.shadow.chat,
        hostSeat: this.seat,
        seatKeys: this.shadow.seatKeys,
        reclaimKeys: this.shadow.reclaimKeys,
        reportVotes: this.shadow.reportVotes,
        lastFx: this.shadow.lastFx,
        deadline: this.shadow.deadline,
        turnElapsedMs,
      };
      const deps = this.hostDeps();
      this.clearWelcomeWatchdog();
      this.controller = RoomController.adopt(snapshot, deps, { frozen: true });
      this.role = 'host';
      this.promotionConfirmed = false;
      this.agreedHumanSeats = snapshot.lobby.seats.filter((seat) => seat.kind === 'human').length;
      this.highestGenerationSeen = Math.max(this.highestGenerationSeen, this.generation);
      this.generation = nextGeneration([this.highestGenerationSeen, this.shadowGeneration]);
      this.highestGenerationSeen = this.generation;
      this.promotedAt = Date.now();
      this.hostFollowers.clear();
      this.peerWelcomedInGen.clear();
      this.pendingAction = null;
      this.lastCompeting = null;
      this.probeStartedAt = 0;
      this.ackKeys.clear();
      this.requiredAcks = this.requiredAckCount();
      this.quorumOk = this.requiredAcks === 0;
      this.quorumMessageShown = false;
      this.authorityReady = false;
      this.hostPeerId = this.clientId;
      this.prevHostFpForTransfer = this.rosterCert?.hostFp ?? this.hostKeyFingerprint ?? '';
      this.hostKeyFingerprint = this.identity?.fingerprint ?? null;
      this.hostSeat = this.seat;
      this.transferApprovals.clear();
      this.mergeAgreedSeatKeys(snapshot.seatKeys, snapshot.reclaimKeys);
      // Guests only mirror 1 extra broker; a promoted host must cover every candidate broker so
      // guests stranded on a 3rd broker can reach the new authority and confirm quorum.
      const baseBrokers = networkConfig.brokers ?? DEFAULT_BROKERS;
      const wantedMirrors = networkConfig.redundantBrokers ?? Math.max(0, baseBrokers.length - 1);
      this.transport?.setRedundantBrokers(wantedMirrors, baseBrokers);
      if (this.identity && this.rosterCert) {
        const ownIdentity = this.identity;
        const gen = this.generation;
        const newHostFp = ownIdentity.fingerprint;
        const prevHostFp = this.rosterCert.hostFp;
        void signData(ownIdentity, transferApprovalPayload(this.roomId, gen, newHostFp, prevHostFp))
          .then((sig) => {
            if (this.closed || this.crashed || this.role !== 'host' || this.generation !== gen) return;
            this.transferApprovals.set(newHostFp, { fp: newHostFp, jwk: ownIdentity.publicJwk, sig });
            this.rebuildTransferProof();
            this.sendHeartbeat();
          })
          .catch(() => undefined);
      }
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
      this.resetHostStallWatch(snapshot.seq);
      if (this.requiredAcks === 0) {
        this.becomeAuthorityReady();
      }
      this.debug('promoted to host', this.debugSnapshot());
      this.announceHost();
      this.sendHeartbeat();
      this.broadcastGenerationSnapshot();
      this.persistHostNow();
      // Old guests re-hello; also actively ping everyone we know about.
      for (const peerId of this.peerSeen.keys()) {
        if (peerId !== this.clientId) {
          void this.transport?.send(peerId, {
            k: 'presence',
            peerId: this.clientId,
            seat: this.seat,
            following: { hostFp: this.identity?.fingerprint ?? this.clientId, gen: this.generation },
            at: Date.now(),
          });
        }
      }
    } catch (error) {
      this.log('host migration failed', error);
    } finally {
      this.promoting = false;
    }
  }

  // ---------------------------------------------------------------- server messages / replay

  private onServerMsg(message: ServerMsg): void {
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
    if (gen !== undefined && gen > this.highestGenerationSeen) this.highestGenerationSeen = gen;
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
        if (message.seatKeys) {
          this.shadow.seatKeys = { ...message.seatKeys };
          this.mergeAgreedSeatKeys(message.seatKeys);
        }
        this.shadow.chat = [...message.chat].slice(-COMM.historySize);
        if (this.role === 'guest') this.hostSeat = message.lobby.seats.find((seat) => seat.isHost)?.index ?? this.hostSeat;
        break;
      case 'lobby':
        this.lastLobby = message.lobby;
        this.shadow.lobby = message.lobby;
        if ((message.gen ?? this.generation) === this.generation && this.switchingAuthority) {
          this.switchingAuthority = false;
          this.flushDeferredAction();
        }
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
      case 'snapshot': {
        const prevSeq = this.shadow.seq;
        const prevGen = this.shadowGeneration;
        this.lastSnapshot = message;
        this.appliedGen = message.gen ?? this.generation;
        this.appliedSeq = message.seq;
        this.lastReceivedGen = this.appliedGen;
        this.lastReceivedSeq = message.seq;
        this.noteDeliveredOrder(message.seq, this.appliedGen);
        this.lastLobby = message.lobby;
        this.seat = message.lobby.seats.find((seat) => seat.index === this.seat)?.index ?? this.seat;
        this.shadow.lobby = message.lobby;
        this.shadow.state = message.state;
        this.shadow.seq = message.seq;
        this.shadowGeneration = genOf(message) ?? this.generation;
        this.shadow.deadline = message.deadline;
        const isNewDecision = message.seq !== prevSeq || this.shadowGeneration !== prevGen;
        if (typeof message.turnElapsedMs === 'number' && Number.isFinite(message.turnElapsedMs)) {
          if (isNewDecision) {
            this.shadow.turnElapsedMs = Math.max(0, message.turnElapsedMs);
            this.shadow.turnElapsedAt = Date.now();
          } else {
            this.updateShadowTurnElapsed(message.turnElapsedMs);
          }
        } else if (isNewDecision) {
          this.shadow.turnElapsedMs = 0;
          this.shadow.turnElapsedAt = Date.now();
        }
        if (
          this.pendingAction &&
          isNewerStateOrder(this.pendingAction.gen, this.pendingAction.seq, this.appliedGen, message.seq)
        ) {
          this.pendingAction = null;
        }
        break;
      }
      case 'update':
        this.lastUpdate = message;
        this.appliedGen = message.gen ?? this.generation;
        this.appliedSeq = message.seq;
        this.lastReceivedGen = this.appliedGen;
        this.lastReceivedSeq = message.seq;
        this.noteDeliveredOrder(message.seq, this.appliedGen);
        this.shadow.state = message.state;
        this.shadow.seq = message.seq;
        this.shadowGeneration = genOf(message) ?? this.generation;
        this.shadow.deadline = message.deadline;
        this.shadow.turnElapsedMs = 0;
        this.shadow.turnElapsedAt = Date.now();
        this.shadow.lastFx = message.fx;
        if (
          this.pendingAction &&
          isNewerStateOrder(this.pendingAction.gen, this.pendingAction.seq, this.appliedGen, message.seq)
        ) {
          this.pendingAction = null;
        }
        if (this.role === 'host') this.resetHostStallWatch(message.seq);
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
    if (
      (message.t === 'snapshot' || message.t === 'update') &&
      (genOf(message) ?? this.generation) === this.generation
    ) {
      this.switchingAuthority = false;
    }
    if (this.role === 'host' && (message.t === 'update' || message.t === 'snapshot' || message.t === 'lobby')) {
      this.scheduleHostSave();
    }
    if (message.t === 'snapshot' || message.t === 'update') this.flushDeferredAction();
  }

  /**
   * Late subscribers (a newly opened GameScreen) must receive a complete board BEFORE any fx, so a
   * stateful, fx-less snapshot of the newest (gen, seq) is delivered first. Nothing older follows
   * it; incremental updates continue from that point.
   */
  private replay(listener: (msg: ServerMsg) => void): void {
    if (this.lastWelcome) listener(this.lastWelcome);
    const snapshot = this.lastSnapshot;
    const update = this.lastUpdate;
    if (!snapshot && !update) {
      if (this.lastLobby) listener({ t: 'lobby', lobby: this.lastLobby });
      return;
    }
    const newest = pickNewestState(snapshot, update);
    if (!newest) {
      if (this.lastLobby) listener({ t: 'lobby', lobby: this.lastLobby });
      return;
    }
    const lobby = this.lastLobby ?? this.lastWelcome?.lobby ?? snapshot?.lobby;
    if (!lobby) return;
    if (snapshot && newest === snapshot && snapshot.resync === true) {
      listener(snapshot);
      return;
    }
    listener({
      t: 'snapshot',
      seq: newest.seq,
      state: newest.state,
      deadline: newest.deadline,
      lobby,
      gen: newest.gen ?? this.generation,
      resync: true,
      boardVersion: BOARD_VERSION,
    });
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
        boardVersion: BOARD_VERSION,
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

  private debug(message: string, detail?: unknown): void {
    netDebug(`${this.roomId}/${this.role}:${this.seat ?? '-'}`, message, detail);
  }
}

// ---------------------------------------------------------------- public factories

export async function createOnlineRoom(name: string): Promise<Session> {
  return OnlineSession.host(name);
}

export function joinOnlineRoom(
  roomId: string,
  name: string,
  opts?: { hostKeyHint?: string | null },
): Session {
  const normalized = normalizeRoomId(roomId);
  if (!isValidRoomId(normalized)) throw new Error('ルーム ID は 6 文字＋4 文字の合言葉です');
  return OnlineSession.guest(normalized, name, opts?.hostKeyHint);
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
  onlineSaveIssueText = null;
  try {
    const hostSave = parseHostSave(storageGet('session', HOST_SAVE_KEY));
    if (hostSave) {
      if (!hostSave.boardVersion) {
        storageRemove('session', HOST_SAVE_KEY);
        return rejectHostSave('古い形式のオンラインセーブは復元できません。新しいゲームを始めてください。');
      }
      if (hostSave.boardVersion !== BOARD_VERSION) {
        storageRemove('session', HOST_SAVE_KEY);
        return rejectHostSave('ゲームの盤面が更新されました。古いオンラインセーブは復元できません。新しいゲームを始めてください。');
      }
      if (isValidRoomId(normalizeRoomId(hostSave.roomId))) {
        return OnlineSession.resumeHost(hostSave);
      }
    }
  } catch {
    onlineSaveIssueText = 'オンラインセーブを読み込めませんでした。新しいゲームを始めてください。';
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

export function netDebugSnapshotForTests(session: Session): NetDebugSnapshot | null {
  return session instanceof OnlineSession ? session.debugSnapshot() : null;
}

export function checkpointHostForTests(session: Session): HostCheckpoint | null {
  return session instanceof OnlineSession ? session.hostCheckpoint() : null;
}

export function resumeHostForTests(checkpoint: HostCheckpoint): Session {
  return OnlineSession.resumeFromCheckpoint(checkpoint);
}

/** Test hook: partition a peer's inbound traffic while leaving its outbound traffic intact. */
/** Test hook: ask the host to raise its generation without changing the board. */
export function bumpGenerationForTests(session: Session): boolean {
  return session instanceof OnlineSession ? session.requestGenerationBumpForTests() : false;
}

/** Test hook: make the host resend welcome + snapshot to a guest connection id. */
export function resyncPeerForTests(session: Session, connId: string): void {
  if (session instanceof OnlineSession) session.resyncPeerForTests(connId);
}

export function setBlockedPeersForTests(session: Session, peerIds: readonly string[]): void {
  if (session instanceof OnlineSession) session.setBlockedPeersForTests(peerIds);
}

export function clearRoomTasksForTests(session: Session): void {
  if (session instanceof OnlineSession) session.clearRoomTasksForTests();
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