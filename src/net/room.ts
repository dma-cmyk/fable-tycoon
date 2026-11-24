// Authoritative per-room controller. Pure TypeScript: clock, timers and randomness are injected,
// so the same code runs inside the browser (LocalSession), Node and a Cloudflare Durable Object.
//
// Responsibilities (DESIGN §1.1, §4, §8):
//  - seats, seat tokens and reconnect
//  - lobby validation and host migration
//  - serial action processing, seq/stale checks, engine error translation
//  - timer-driven CPU / autoplay / year-end acknowledgement
//  - chat, emotes and reports with the COMM limits
//
// A GameState that has been broadcast is never mutated: engine `step` returns a fresh state and all
// serialization reads it without changing it.

import type { Action, EmoteDef, Fx, GameData, GameState, StepResult } from '../core/types';
import {
  actorOf,
  cpuDecide,
  createGame,
  EngineError,
  netWorth,
  sanitizeState,
  step,
  withSeed,
  ALLOWED_YEARS,
} from '../core/engine';
import { COMM, MAX_SEATS, PROTOCOL_VERSION } from './protocol';
import type {
  AllowedYears,
  ChatLine,
  ClientMsg,
  EmoteEvent,
  ErrorCode,
  LobbyView,
  PublicState,
  Report,
  RoomSettings,
  SeatInfo,
  SeatKind,
  ServerMsg,
} from './protocol';
import { FX_MS } from './session-types';
import { normalizeForMatch, sanitizeChat } from './filter';

export type TimerHandle = unknown;

export interface RoomDeps {
  /** Room id (6-character id on the server, a fixed id locally). */
  roomId: string;
  now(): number;
  setTimer(ms: number, fn: () => void): TimerHandle;
  clearTimer(handle: TimerHandle): void;
  /** Uniform integer in [0, n). Backed by crypto on the server, Math/crypto locally, a stub in tests. */
  randomInt(n: number): number;
  data: GameData;
  send(connId: string, msg: ServerMsg): void;
  broadcast(msg: ServerMsg): void;
  log?(message: string, detail?: unknown): void;
  /** Persist a report. `recentChat` is the last 10 lines sent by the reported seat. */
  report?(report: Report & { room: string; recentChat: ChatLine[] }): void;
  /** Called only when the report passed validation (used to replicate the vote). */
  reportAccepted?(target: number, reporter: number): void;
  /** Optional timing overrides (tests). Production keeps the DESIGN defaults below. */
  graceMs?: number;
  replaceMs?: number;
  yearEndAckMs?: number;
  cpuDelayMs?: number | (() => number);
  /** Multiplies standard fx playback durations (tests set a small value; LocalSession binds live fxSpeed). */
  fxScale?: number | (() => number);
}

/** CPU / autoplay pacing (DESIGN §4). */
export const CPU_MOVE_DELAY_MS = 400;
export const DISCONNECT_GRACE_MS = 15_000;
export const DISCONNECT_REPLACE_MS = 120_000;
export const YEAR_END_AUTO_ACK_MS = 6_000;
export const IDLE_ROOM_MS = 30 * 60_000;

/** Standard playback duration of one fx at 1x speed. Server uses the sum to pace autoplay. */
export function fxDuration(fx: Fx): number {
  switch (fx.t) {
    case 'turn':
      return FX_MS.turn;
    case 'dice':
      return FX_MS.dice;
    case 'move':
      return FX_MS.moveStep * Math.max(1, fx.path.length);
    case 'warp':
      return FX_MS.warp;
    case 'cash':
      return FX_MS.cash;
    case 'buy':
      return FX_MS.buy;
    case 'sell':
      return FX_MS.sell;
    case 'card_get':
      return FX_MS.card_get;
    case 'card_use':
      return FX_MS.card_use;
    case 'say':
      return FX_MS.sayBase + FX_MS.sayPerChar * Array.from(fx.text).length;
    case 'event_open':
      return FX_MS.event_open;
    case 'event_close':
      return FX_MS.event_close;
    case 'goal':
      return FX_MS.goal;
    case 'destination':
      return FX_MS.destination;
    case 'piper':
      return FX_MS.piper;
    case 'industry':
      return FX_MS.industry;
    case 'skip':
      return FX_MS.skip;
    case 'month':
      return FX_MS.month;
    case 'year_end':
      return FX_MS.year_end;
    case 'game_over':
      return FX_MS.game_over;
    case 'toast':
      return FX_MS.toast;
    default: {
      const never: never = fx;
      void never;
      return 0;
    }
  }
}

export function sumFxDuration(fx: readonly Fx[]): number {
  return fx.reduce((sum, item) => sum + fxDuration(item), 0);
}

// ---------------------------------------------------------------- internal state

type RoomStatus = 'lobby' | 'playing' | 'finished';

interface TokenBucket {
  tokens: number;
  at: number;
}

interface Seat {
  index: number;
  kind: SeatKind;
  name: string;
  characterId: string | null;
  cpuLevel: 1 | 2 | 3;
  connId: string | null;
  token: string | null;
  /** Key that may reclaim this seat after a disconnect -> CPU replacement (assets are kept). */
  reclaimToken: string | null;
  autoplay: boolean;
  disconnectedAt: number | null;
  chatBucket: TokenBucket;
  emoteBucket: TokenBucket;
  lastEmoteAt: Record<string, number>;
  recentChat: { text: string; at: number }[];
  flagged: boolean;
}

interface Conn {
  id: string;
  name: string;
  token: string;
  seat: number | null;
  helloSent: boolean;
}

interface SerializedRoom {
  v: 1;
  roomId: string;
  status: RoomStatus;
  settings: RoomSettings;
  hostSeat: number | null;
  seq: number;
  state: GameState | null;
  seats: Seat[];
  connections: Conn[];
  chat: ChatLine[];
  nextChatId: number;
  nextEmoteId: number;
  lastFx: Fx[];
  lastBy: number | null;
  deadline: number | null;
  deadlineSeq: number;
  deadlineActor: number | null;
  turnStartedAt: number;
  turnFxMs: number;
  playerIdBySeat: number[];
  seatByPlayerId: number[];
  reporters: Record<string, number[]>;
  tasks: { key: string; at: number; token?: number }[];
  savedAt: number;
}

interface RestoreOptions {
  /**
   * Keep serialized connections (Durable Object hibernation keeps its WebSockets alive).
   * false (default) is crash recovery: every human becomes disconnected and timers are re-armed.
   */
  connections?: boolean;
}

/**
 * Everything a guest needs to take over as host after a host crash (DESIGN online §4).
 * The state is sanitized (rng = 0); adopt() injects a fresh crypto-random rng.
 * `seatKeys` maps seat index -> public-key fingerprint so reconnect identities survive migration.
 */
export interface RoomPublicSnapshot {
  roomId: string;
  lobby: LobbyView;
  state: PublicState | null;
  seq: number;
  chat: ChatLine[];
  hostSeat: number | null;
  /** seat index -> public-key fingerprint (never a secret). */
  seatKeys: Record<string, string>;
  /** Per target seat -> fingerprints of seats that reported it (carried across migration). */
  reportVotes: Record<string, string[]>;
  /** Additive: seat index -> key allowed to reclaim a timeout-replaced CPU seat. */
  reclaimKeys?: Record<string, string>;
  lastFx: Fx[];
  deadline: number | null;
}

const DEFAULT_SETTINGS: RoomSettings = { years: 3, turnSeconds: 30, visibility: 'private' };
const VALID_YEARS: ReadonlySet<number> = new Set(ALLOWED_YEARS);
const VALID_TURN_SECONDS = new Set([0, 20, 30, 60]);
const REASONS = new Set<Report['reason']>(['spam', 'abuse', 'cheat', 'other']);
const TOKEN_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

function initialBucket(now: number, burst: number): TokenBucket {
  return { tokens: burst, at: now };
}

function takeToken(bucket: TokenBucket, burst: number, intervalMs: number, now: number): boolean {
  const elapsed = Math.max(0, now - bucket.at);
  bucket.tokens = Math.min(burst, bucket.tokens + elapsed / intervalMs);
  bucket.at = now;
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

function isSeatIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < MAX_SEATS;
}

function characterLabel(seat: Seat): string {
  return seat.name || `席 ${seat.index + 1}`;
}

function seatConnected(seat: Seat): boolean {
  return seat.connId !== null;
}

// ---------------------------------------------------------------- controller

export class RoomController {
  private readonly deps: RoomDeps;
  readonly roomId: string;

  private get graceMs(): number {
    return this.deps.graceMs ?? DISCONNECT_GRACE_MS;
  }

  private get replaceMs(): number {
    return this.deps.replaceMs ?? DISCONNECT_REPLACE_MS;
  }

  private get yearEndAckMs(): number {
    return this.deps.yearEndAckMs ?? YEAR_END_AUTO_ACK_MS;
  }

  private get cpuDelayMs(): number {
    const value = this.deps.cpuDelayMs;
    return typeof value === 'function' ? value() : (value ?? CPU_MOVE_DELAY_MS);
  }

  private get fxScale(): number {
    const value = this.deps.fxScale;
    return typeof value === 'function' ? value() : (value ?? 1);
  }

  private status: RoomStatus = 'lobby';
  private settings: RoomSettings = { ...DEFAULT_SETTINGS };
  private hostSeat: number | null = null;
  private seq = 0;
  private state: GameState | null = null;

  private seats: Seat[];
  private connections = new Map<string, Conn>();
  private chat: ChatLine[] = [];
  private nextChatId = 1;
  private nextEmoteId = 1;

  private lastFx: Fx[] = [];
  private lastBy: number | null = null;
  private deadline: number | null = null;
  private deadlineSeq = -1;
  private deadlineActor: number | null = null;
  private turnStartedAt = 0;
  private turnFxMs = 0;

  /** Seat index <-> engine player id. Equal when all seats are occupied contiguously. */
  private playerIdBySeat: number[] = [];
  private seatByPlayerId: number[] = [];

  private reporters = new Map<number, Set<number>>();
  private tokenCounter = 0;

  private tasks = new Map<string, { at: number; token: number }>();
  private taskSeq = 0;
  private alarm: { at: number; handle: TimerHandle } | null = null;
  private ticking = false;
  private disposed = false;
  private frozen = false;

  constructor(deps: RoomDeps) {
    this.deps = deps;
    this.roomId = deps.roomId;
    const now = deps.now();
    this.seats = Array.from({ length: MAX_SEATS }, (_, index) => this.emptySeat(index, now));
  }

  // ---------------------------------------------------------------- public queries

  lobbyView(): LobbyView {
    return {
      roomId: this.roomId,
      status: this.status,
      seats: this.seats.map((seat) => this.seatInfo(seat)),
      settings: { ...this.settings },
    };
  }

  /** Current sanitized state (for HTTP room listings / debugging). */
  publicState(): PublicState | null {
    return this.state ? sanitizeState(this.state) : null;
  }

  /** Re-send welcome + snapshot to an existing connection (client detected a lost update). */
  resync(connId: string): void {
    const conn = this.connections.get(connId);
    if (!conn) return;
    this.sendWelcome(conn, true);
  }

  get currentSeq(): number {
    return this.seq;
  }

  get roomStatus(): RoomStatus {
    return this.status;
  }

  get currentDeadline(): number | null {
    return this.deadline;
  }

  chatHistory(): ChatLine[] {
    return [...this.chat];
  }

  /** Sanitized snapshot safe to replicate to every guest / use for host migration. */
  publicSnapshot(): RoomPublicSnapshot {
    const seatKeys: Record<string, string> = {};
    const reclaimKeys: Record<string, string> = {};
    for (const seat of this.seats) {
      if (seat.kind === 'human' && seat.token) seatKeys[String(seat.index)] = seat.token;
      if (seat.kind === 'cpu' && seat.reclaimToken) reclaimKeys[String(seat.index)] = seat.reclaimToken;
    }
    return {
      roomId: this.roomId,
      reclaimKeys,
      lobby: this.lobbyView(),
      state: this.state ? sanitizeState(this.state) : null,
      seq: this.seq,
      chat: this.chatHistory(),
      hostSeat: this.hostSeat,
      seatKeys,
      reportVotes: Object.fromEntries(
        [...this.reporters].map(([seat, votes]) => [
          String(seat),
          [...votes].map((voteSeat) => this.seats[voteSeat]?.token ?? String(voteSeat)),
        ]),
      ),
      lastFx: this.lastFx,
      deadline: this.deadline,
    };
  }

  /** Verified connection -> seat mapping (host authentication uses this on every action). */
  seatToPlayer(seat: number): number | null {
    const playerId = this.playerIdBySeat[seat];
    return playerId === undefined ? null : playerId;
  }

  playerToSeat(playerId: number): number | null {
    const seat = this.seatByPlayerId[playerId];
    return seat === undefined ? null : seat;
  }

  seatForConn(connId: string): number | null {
    const conn = this.connections.get(connId);
    if (!conn || conn.seat === null) return null;
    const seat = this.seats[conn.seat];
    if (!seat || seat.kind !== 'human' || seat.connId !== connId) return null;
    return seat.index;
  }

  seatKey(seatIndex: number): string | null {
    const seat = this.seats[seatIndex];
    return seat && seat.kind === 'human' ? seat.token : null;
  }

  /** Seat/connection pairs (LocalSession uses this to route hot-seat messages). */
  connectionIds(): { seat: number; connId: string }[] {
    return this.seats
      .filter((seat) => seat.kind === 'human' && seat.connId !== null)
      .map((seat) => ({ seat: seat.index, connId: seat.connId as string }));
  }

  /** Seat index currently acting, or null. LocalSession uses this for hot-seat attribution. */
  actorSeat(): number | null {
    if (!this.state) return null;
    const actor = actorOf(this.state);
    return actor === null ? null : (this.seatByPlayerId[actor] ?? null);
  }

  /** True when the given connection owns a seat. */
  hasSeat(connId: string): boolean {
    return this.connections.get(connId)?.seat != null;
  }

  // ---------------------------------------------------------------- connections

  connect(connId: string): void {
    if (this.disposed || this.connections.has(connId)) return;
    this.connections.set(connId, {
      id: connId,
      name: '',
      token: this.newToken(),
      seat: null,
      helloSent: false,
    });
  }

  disconnect(connId: string): void {
    const conn = this.connections.get(connId);
    if (!conn) return;
    this.connections.delete(connId);
    const seat = conn.seat === null ? null : this.seats[conn.seat];
    if (!seat || seat.connId !== connId) return;

    seat.connId = null;
    seat.disconnectedAt = this.deps.now();
    if (this.status === 'playing' || this.status === 'finished') {
      this.system(`${characterLabel(seat)} が切断しました（CPU が代行します）`);
    }
    if (this.hostSeat === seat.index) this.migrateHost();
    this.broadcastLobby();
    this.armTurn(this.lastFx);
  }

  /**
   * Freeze autonomous progress until a migrated host has majority acknowledgement.
   *
   * The disconnect -> CPU replacement timer intentionally keeps running while frozen: replacing an
   * absent human is not game progress, and it is what lets a lone remaining human continue a
   * 2-player game after the other tab closed. Freezing therefore only stops turn/CPU/ack/grace.
   */
  setFrozen(frozen: boolean): void {
    if (this.frozen === frozen) return;
    this.frozen = frozen;
    this.armTurn(this.lastFx);
  }

  /** Durable Object alarm entry point; also exposed for hosts that manage their own scheduler. */
  onAlarm(): void {
    this.alarm = null;
    this.tick();
  }

  dispose(): void {
    this.disposed = true;
    this.tasks.clear();
    if (this.alarm) {
      this.deps.clearTimer(this.alarm.handle);
      this.alarm = null;
    }
  }

  // ---------------------------------------------------------------- messages

  message(connId: string, msg: ClientMsg): void {
    if (this.disposed) return;
    if (!this.connections.has(connId)) this.connect(connId);
    const conn = this.connections.get(connId);
    if (!conn) return;

    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') {
      this.sendError(connId, 'bad_request', 'メッセージの形式が不正です');
      return;
    }

    switch (msg.t) {
      case 'hello':
        this.onHello(conn, msg);
        return;
      case 'take_seat':
        this.onTakeSeat(conn, msg);
        return;
      case 'leave_seat':
        this.onLeaveSeat(conn);
        return;
      case 'pick_character':
        this.onPickCharacter(conn, msg);
        return;
      case 'set_seat':
        this.onSetSeat(conn, msg);
        return;
      case 'settings':
        this.onSettings(conn, msg);
        return;
      case 'start':
        this.onStart(conn);
        return;
      case 'action':
        this.onAction(conn, msg);
        return;
      case 'chat':
        this.onChat(conn, msg);
        return;
      case 'emote':
        this.onEmote(conn, msg);
        return;
      case 'report':
        this.onReport(conn, msg);
        return;
      case 'leave':
        this.onLeave(conn);
        return;
      case 'ping':
        this.deps.send(connId, {
          t: 'pong',
          at: typeof msg.at === 'number' ? msg.at : 0,
          serverNow: this.deps.now(),
        });
        return;
      default:
        this.sendError(connId, 'bad_request', '不明なメッセージです');
    }
  }

  // ---------------------------------------------------------------- hello / seats

  private onHello(conn: Conn, msg: Extract<ClientMsg, { t: 'hello' }>): void {
    if (msg.v !== PROTOCOL_VERSION) {
      this.sendError(conn.id, 'bad_version', 'クライアントのバージョンが古いです');
      return;
    }
    if (typeof msg.roomId !== 'string' || msg.roomId.toUpperCase() !== this.roomId.toUpperCase()) {
      this.sendError(conn.id, 'no_room', 'ルームが見つかりません');
      return;
    }

    const name = this.cleanName(msg.name);
    conn.name = name;
    conn.helloSent = true;
    if (
      typeof msg.token === 'string' &&
      msg.token.length > 0 &&
      msg.token.length <= 128 &&
      !this.seats.some((seat) => seat.token === msg.token) &&
      ![...this.connections.values()].some((other) => other !== conn && other.token === msg.token)
    ) {
      // P2P guests use their persistent clientId as the seat token. Adopting it here keeps
      // reconnect identity stable across host migration.
      conn.token = msg.token;
    }

    if (typeof msg.token === 'string' && msg.token.length > 0) {
      const seat = this.seats.find(
        (candidate) => candidate.kind === 'human' && candidate.token === msg.token,
      );
      if (seat) {
        if (seat.connId === conn.id && seatConnected(seat)) {
          // Same connection re-authenticating: idempotent. No 「戻りました」, no autoplay reset
          // and no snapshot (which could cancel in-flight fx). Explicit resync requests snapshots.
          // The lobby is still re-sent to that connection so a client that just recovered from a
          // partition sees the current seat/connection state immediately.
          this.sendWelcome(conn, false, false);
          this.deps.send(conn.id, { t: 'lobby', lobby: this.lobbyView() });
          return;
        }
        this.bindReconnect(conn, seat);
        return;
      }
      // A timed-out human seat was replaced by CPU but keeps its key: the owner can take it back
      // (assets and position intact) instead of being locked out for the rest of the game.
      const reclaimable =
        this.status !== 'lobby'
          ? this.seats.find((candidate) => candidate.kind === 'cpu' && candidate.reclaimToken === msg.token)
          : undefined;
      if (reclaimable) {
        this.bindReclaim(conn, reclaimable, msg.token);
        return;
      }
      // Never reclaim a seat by display name: the pinned public-key fingerprint is the only
      // credential. A keyless seat stays CPU-autoplayed until its owner proves the key.
      // Unknown / expired token: fall through as a fresh connection.
    }
    if (conn.seat !== null) {
      // Duplicate hello: just re-send the current welcome.
      this.sendWelcome(conn);
      return;
    }
    this.sendWelcome(conn);
  }

  private bindReclaim(conn: Conn, seat: Seat, token: string): void {
    seat.kind = 'human';
    seat.token = token;
    seat.reclaimToken = null;
    seat.name = conn.name;
    seat.connId = conn.id;
    seat.disconnectedAt = null;
    seat.autoplay = false;
    seat.chatBucket = initialBucket(this.deps.now(), COMM.chatBurst);
    seat.emoteBucket = initialBucket(this.deps.now(), COMM.emoteBurst);
    conn.seat = seat.index;
    conn.token = token;
    this.clearTask(`replace:${seat.index}`);
    this.clearTask(`grace:${seat.index}`);
    this.system(`${characterLabel(seat)} が席に戻りました`);
    this.sendWelcome(conn);
    this.broadcastLobby();
    this.armTurn(this.lastFx);
  }

  private bindReconnect(conn: Conn, seat: Seat): void {
    const previous = seat.connId;
    if (previous && previous !== conn.id) {
      const old = this.connections.get(previous);
      if (old) old.seat = null;
    }
    const oldSeat = conn.seat === null ? null : this.seats[conn.seat];
    if (oldSeat && oldSeat !== seat) oldSeat.connId = null;

    seat.connId = conn.id;
    seat.disconnectedAt = null;
    seat.autoplay = false;
    conn.seat = seat.index;
    conn.token = seat.token ?? conn.token;
    this.clearTask(`grace:${seat.index}`);
    this.clearTask(`replace:${seat.index}`);
    this.system(`${characterLabel(seat)} が戻ってきました`);
    this.sendWelcome(conn);
    this.broadcastLobby();
    if (!this.frozen && (this.status === 'playing' || this.status === 'finished')) {
      if (this.actorSeat() === seat.index) {
        this.clearTask('cpu');
        if (this.deadline !== null) this.setTask('turn', this.deadline);
      }
    }
  }

  private sendWelcome(conn: Conn, resync = false, includeSnapshot = true): void {
    const seatKeys: Record<string, string> = {};
    for (const seat of this.seats) {
      if (seat.kind === 'human' && seat.token) seatKeys[String(seat.index)] = seat.token;
    }
    this.deps.send(conn.id, {
      t: 'welcome',
      roomId: this.roomId,
      token: conn.token,
      seat: conn.seat,
      lobby: this.lobbyView(),
      chat: [...this.chat],
      seatKeys,
    });
    if (includeSnapshot && this.state && (this.status === 'playing' || this.status === 'finished')) {
      this.deps.send(conn.id, {
        t: 'snapshot',
        seq: this.seq,
        state: sanitizeState(this.state),
        deadline: this.deadline,
        lobby: this.lobbyView(),
        ...(resync ? { resync: true } : {}),
      });
    }
  }

  private onTakeSeat(conn: Conn, msg: Extract<ClientMsg, { t: 'take_seat' }>): void {
    if (!conn.helloSent) {
      this.sendError(conn.id, 'bad_request', '先に hello を送ってください');
      return;
    }
    if (!isSeatIndex(msg.index)) {
      this.sendError(conn.id, 'bad_request', '席番号が不正です');
      return;
    }
    const seat = this.seats[msg.index];
    if (!seat) {
      this.sendError(conn.id, 'bad_request', '席番号が不正です');
      return;
    }
    if (conn.seat !== null) {
      if (conn.seat === msg.index && seat.kind === 'human' && seat.connId === conn.id) {
        // Retry after a lost welcome: resend welcome (+ snapshot if the game already started).
        this.sendWelcome(conn);
        return;
      }
      this.sendError(conn.id, 'bad_request', 'すでに席に座っています');
      return;
    }
    if (this.status !== 'lobby') {
      this.sendError(conn.id, 'already_started', 'ゲームはすでに始まっています');
      return;
    }
    if (seat.kind === 'human') {
      this.sendError(conn.id, 'room_full', 'その席は使用中です');
      return;
    }
    if (seat.kind === 'cpu') {
      this.sendError(conn.id, 'room_full', 'その席は CPU が使用中です');
      return;
    }

    seat.kind = 'human';
    seat.connId = conn.id;
    seat.token = conn.token;
    seat.name = conn.name || `プレイヤー${msg.index + 1}`;
    seat.disconnectedAt = null;
    seat.autoplay = false;
    conn.seat = msg.index;
    if (this.hostSeat === null) this.hostSeat = msg.index;
    this.deps.send(conn.id, {
      t: 'welcome',
      roomId: this.roomId,
      token: conn.token,
      seat: conn.seat,
      lobby: this.lobbyView(),
      chat: [...this.chat],
    });
    this.broadcastLobby();
  }

  private onLeaveSeat(conn: Conn): void {
    if (this.status !== 'lobby') {
      this.sendError(conn.id, 'already_started', 'ゲーム中は退出（leave）してください');
      return;
    }
    const seat = this.seatOfConn(conn);
    if (!seat) {
      this.sendError(conn.id, 'bad_request', '席に座っていません');
      return;
    }
    const wasHost = this.hostSeat === seat.index;
    this.resetSeat(seat);
    conn.seat = null;
    if (wasHost) this.migrateHost();
    this.broadcastLobby();
  }

  private onPickCharacter(conn: Conn, msg: Extract<ClientMsg, { t: 'pick_character' }>): void {
    if (this.status !== 'lobby') {
      this.sendError(conn.id, 'already_started', 'ゲーム中はキャラクターを変更できません');
      return;
    }
    let seat: Seat | null | undefined;
    if (typeof msg.seat === 'number') {
      if (!isSeatIndex(msg.seat)) {
        this.sendError(conn.id, 'bad_request', '席番号が不正です');
        return;
      }
      seat = this.seats[msg.seat];
      const own = this.seatOfConn(conn);
      if (!own || own.index !== seat.index) {
        if (this.hostSeat !== conn.seat) {
          this.sendError(conn.id, 'not_host', 'ホストだけが他の席を設定できます');
          return;
        }
        if (seat.kind !== 'cpu') {
          this.sendError(conn.id, 'bad_request', 'CPU 席以外は本人が選んでください');
          return;
        }
      }
    } else {
      seat = this.seatOfConn(conn);
    }
    if (!seat) {
      this.sendError(conn.id, 'bad_request', '席に座っていません');
      return;
    }
    if (typeof msg.characterId !== 'string' || !this.deps.data.characters.some((c) => c.id === msg.characterId)) {
      this.sendError(conn.id, 'bad_request', '存在しないキャラクターです');
      return;
    }
    if (this.seats.some((other) => other.index !== seat.index && other.characterId === msg.characterId)) {
      this.sendError(conn.id, 'character_taken', 'そのキャラクターは選ばれています');
      return;
    }
    seat.characterId = msg.characterId;
    this.broadcastLobby();
  }

  private onSetSeat(conn: Conn, msg: Extract<ClientMsg, { t: 'set_seat' }>): void {
    if (!this.isHostConn(conn)) {
      this.sendError(conn.id, 'not_host', 'ホストのみ操作できます');
      return;
    }
    if (this.status !== 'lobby') {
      this.sendError(conn.id, 'already_started', 'ゲームはすでに始まっています');
      return;
    }
    if (!isSeatIndex(msg.index)) {
      this.sendError(conn.id, 'bad_request', '席番号が不正です');
      return;
    }
    const seat = this.seats[msg.index];
    if (seat.kind === 'human') {
      this.sendError(conn.id, 'bad_request', '人間の席は変更できません');
      return;
    }
    if (msg.kind === 'cpu') {
      const level = msg.cpuLevel ?? 1;
      if (level !== 1 && level !== 2 && level !== 3) {
        this.sendError(conn.id, 'bad_request', 'CPU レベルが不正です');
        return;
      }
      seat.kind = 'cpu';
      seat.cpuLevel = level;
      seat.name = `CPU ${msg.index + 1}`;
      seat.connId = null;
      seat.token = null;
      seat.characterId = null;
      seat.disconnectedAt = null;
      seat.autoplay = false;
    } else {
      this.resetSeat(seat);
    }
    this.broadcastLobby();
  }

  private onSettings(conn: Conn, msg: Extract<ClientMsg, { t: 'settings' }>): void {
    if (!this.isHostConn(conn)) {
      this.sendError(conn.id, 'not_host', 'ホストのみ操作できます');
      return;
    }
    if (this.status !== 'lobby') {
      this.sendError(conn.id, 'already_started', 'ゲームはすでに始まっています');
      return;
    }
    if (!msg.settings || typeof msg.settings !== 'object') {
      this.sendError(conn.id, 'bad_request', '設定が不正です');
      return;
    }
    const next: RoomSettings = { ...this.settings };
    if (msg.settings.years !== undefined) {
      if (!VALID_YEARS.has(msg.settings.years)) {
        this.sendError(conn.id, 'bad_request', '年数は 1/3/5/10 年から選んでください');
        return;
      }
      next.years = msg.settings.years as AllowedYears;
    }
    if (msg.settings.turnSeconds !== undefined) {
      if (!VALID_TURN_SECONDS.has(msg.settings.turnSeconds)) {
        this.sendError(conn.id, 'bad_request', '制限時間は 0/20/30/60 秒から選んでください');
        return;
      }
      next.turnSeconds = msg.settings.turnSeconds;
    }
    if (msg.settings.visibility !== undefined) {
      if (msg.settings.visibility !== 'private' && msg.settings.visibility !== 'public') {
        this.sendError(conn.id, 'bad_request', '公開設定が不正です');
        return;
      }
      next.visibility = msg.settings.visibility;
    }
    this.settings = next;
    this.broadcastLobby();
  }

  private onStart(conn: Conn): void {
    if (!this.isHostConn(conn)) {
      this.sendError(conn.id, 'not_host', 'ホストのみ開始できます');
      return;
    }
    if (this.status !== 'lobby') {
      this.sendError(conn.id, 'already_started', 'ゲームはすでに始まっています');
      return;
    }

    const occupied = this.seats.filter((seat) => seat.kind !== 'open');
    const humans = occupied.filter((seat) => seat.kind === 'human');
    if (humans.length < 1) {
      this.sendError(conn.id, 'bad_request', '人間が 1 人以上必要です');
      return;
    }
    if (occupied.length < 2) {
      this.sendError(conn.id, 'bad_request', '合計 2 人以上必要です');
      return;
    }

    const used = new Set<string>();
    for (const seat of occupied) {
      if (seat.characterId) used.add(seat.characterId);
    }
    for (const seat of occupied) {
      if (!seat.characterId) {
        const free = this.deps.data.characters.find((character) => !used.has(character.id));
        if (!free) {
          this.sendError(conn.id, 'bad_request', 'キャラクターを選べませんでした');
          return;
        }
        seat.characterId = free.id;
        used.add(free.id);
      }
    }
    if (new Set(occupied.map((seat) => seat.characterId)).size !== occupied.length) {
      this.sendError(conn.id, 'character_taken', 'キャラクターが重複しています');
      return;
    }

    const seed =
      ((this.deps.randomInt(0x7fffffff) ^ Math.imul(this.deps.randomInt(0x7fffffff), 0x9e3779b1)) >>>
        0) || 1;

    this.playerIdBySeat = [];
    this.seatByPlayerId = [];
    occupied.forEach((seat, playerId) => {
      this.playerIdBySeat[seat.index] = playerId;
      this.seatByPlayerId[playerId] = seat.index;
    });

    try {
      const created = createGame(this.deps.data, {
        years: this.settings.years,
        seed,
        players: occupied.map((seat) => ({
          name: seat.name || `プレイヤー${seat.index + 1}`,
          characterId: seat.characterId as string,
          isCpu: seat.kind === 'cpu',
          cpuLevel: seat.cpuLevel,
        })),
      });
      this.state = created.state;
      this.lastFx = created.fx;
      this.lastBy = 0;
      this.status = 'playing';
      this.seq = 1;
    } catch (error) {
      this.log('start failed', error);
      this.sendError(
        conn.id,
        'illegal',
        error instanceof EngineError ? error.message : 'ゲームを開始できませんでした',
      );
      return;
    }

    this.armTurn(this.lastFx);
    const snapshot: ServerMsg = {
      t: 'snapshot',
      seq: this.seq,
      state: sanitizeState(this.state),
      deadline: this.deadline,
      lobby: this.lobbyView(),
    };
    this.deps.broadcast(snapshot);
    // The initial createGame fx (destination announcement, first monthly event) needs an update
    // after the snapshot. Bump seq so the same state is adopted once with animation; reconnecting
    // clients only receive the current snapshot.
    this.seq += 1;
    this.deadlineSeq = this.seq;
    this.deps.broadcast({
      t: 'update',
      seq: this.seq,
      by: 0,
      fx: this.lastFx,
      state: sanitizeState(this.state as GameState),
      deadline: this.deadline,
    });
    this.system('ゲーム開始！ 世界を巡って一番儲けた者の勝ちです。');
  }

  // ---------------------------------------------------------------- game actions

  private onAction(conn: Conn, msg: Extract<ClientMsg, { t: 'action' }>): void {
    if (this.status !== 'playing' || !this.state) {
      this.sendError(conn.id, 'not_your_turn', 'ゲーム中ではありません');
      return;
    }
    const seat = this.seatOfConn(conn);
    if (!seat) {
      this.sendError(conn.id, 'not_your_turn', '席に座っていません');
      return;
    }
    if (this.frozen) {
      this.sendError(conn.id, 'bad_request', 'ホスト権限の確認待ちです');
      return;
    }
    const actor = actorOf(this.state);
    const actorSeat = actor === null ? null : (this.seatByPlayerId[actor] ?? null);
    if (actorSeat === null || actorSeat !== seat.index) {
      this.sendError(conn.id, 'not_your_turn', 'あなたの手番ではありません');
      return;
    }
    if (typeof msg.seq !== 'number' || msg.seq !== this.seq) {
      this.sendError(conn.id, 'stale', '状態が更新されました。最新の状態から操作してください');
      return;
    }
    if (!msg.action || typeof msg.action !== 'object') {
      this.sendError(conn.id, 'bad_request', '行動が不正です');
      return;
    }

    const resumed = seat.autoplay;
    seat.autoplay = false;
    this.clearTask(`grace:${seat.index}`);
    try {
      if (actor === null) throw new Error('active actor disappeared');
      const action: Action = msg.action;
      const result = step(this.deps.data, this.state, actor, action);
      this.commit(result, actor);
      if (resumed) this.broadcastLobby();
    } catch (error) {
      seat.autoplay = resumed;
      if (error instanceof EngineError) {
        this.sendError(conn.id, 'illegal', error.message);
      } else {
        this.log('step failed', error);
        this.sendError(conn.id, 'illegal', 'その行動は実行できません');
      }
      // Rejected actions never change state, so the existing deadline/timer stays untouched.
    }
  }

  private onChat(conn: Conn, msg: Extract<ClientMsg, { t: 'chat' }>): void {
    const seat = this.seatOfConn(conn);
    if (!seat) {
      this.sendError(conn.id, 'bad_request', '席に座ってから発言してください');
      return;
    }
    if (typeof msg.text !== 'string') {
      this.sendError(conn.id, 'bad_request', 'メッセージが不正です');
      return;
    }
    const now = this.deps.now();
    const text = sanitizeChat(msg.text, COMM.chatMaxChars);
    if (!text) {
      this.sendError(conn.id, 'bad_request', '空のメッセージは送れません');
      return;
    }
    const normalized = normalizeForMatch(text);
    seat.recentChat = seat.recentChat.filter((entry) => now - entry.at < COMM.duplicateWindowMs);
    if (seat.recentChat.some((entry) => entry.text === normalized)) {
      return; // silently drop a normalized duplicate from the last 10 seconds
    }
    if (!takeToken(seat.chatBucket, COMM.chatBurst, COMM.chatMinIntervalMs, now)) {
      this.sendError(conn.id, 'rate_limited', 'チャットが速すぎます。少し待ってください');
      return;
    }
    seat.recentChat.push({ text: normalized, at: now });
    if (seat.recentChat.length > 20) seat.recentChat.shift();
    const line: ChatLine = { id: this.nextChatId++, seat: seat.index, text, at: now };
    this.chat.push(line);
    if (this.chat.length > COMM.historySize) this.chat.splice(0, this.chat.length - COMM.historySize);
    this.deps.broadcast({ t: 'chat', line });
  }

  private onEmote(conn: Conn, msg: Extract<ClientMsg, { t: 'emote' }>): void {
    const seat = this.seatOfConn(conn);
    if (!seat) {
      this.sendError(conn.id, 'bad_request', '席に座ってから使ってください');
      return;
    }
    if (typeof msg.emoteId !== 'string') {
      this.sendError(conn.id, 'bad_request', 'エモートが不正です');
      return;
    }
    const error = this.validateEmote(seat, msg.emoteId, msg.target);
    if (error) {
      this.sendError(conn.id, 'bad_request', error);
      return;
    }
    const def = this.deps.data.emotes.find((candidate) => candidate.id === msg.emoteId) as EmoteDef;
    const target = def.targeted && typeof msg.target === 'number' ? msg.target : null;
    if (!this.consumeEmoteLimits(seat, def)) {
      this.sendError(conn.id, 'rate_limited', 'エモートが速すぎます');
      return;
    }
    const emote: EmoteEvent = {
      id: this.nextEmoteId++,
      seat: seat.index,
      emoteId: def.id,
      target,
      at: this.deps.now(),
    };
    this.deps.broadcast({ t: 'emote', emote });
  }

  private onReport(conn: Conn, msg: Extract<ClientMsg, { t: 'report' }>): void {
    const seat = this.seatOfConn(conn);
    if (!seat) {
      this.sendError(conn.id, 'bad_request', '席に座ってから通報してください');
      return;
    }
    if (!isSeatIndex(msg.seat) || !REASONS.has(msg.reason)) {
      this.sendError(conn.id, 'bad_request', '通報内容が不正です');
      return;
    }
    if (msg.seat === seat.index) {
      this.sendError(conn.id, 'bad_request', '自分自身は通報できません');
      return;
    }
    const target = this.seats[msg.seat];
    if (!target || target.kind === 'open') {
      this.sendError(conn.id, 'bad_request', '通報対象の席がありません');
      return;
    }

    const now = this.deps.now();
    const report: Report = { reporter: seat.index, seat: msg.seat, reason: msg.reason, at: now };
    const recentChat = this.chat.filter((line) => line.seat === msg.seat).slice(-10);
    if (this.deps.report) {
      try {
        this.deps.report({ ...report, room: this.roomId, recentChat });
      } catch (error) {
        this.log('report sink failed', error);
      }
    }

    this.deps.reportAccepted?.(msg.seat, seat.index);

    let set = this.reporters.get(msg.seat);
    if (!set) {
      set = new Set();
      this.reporters.set(msg.seat, set);
    }
    set.add(seat.index);
    if (set.size >= 2 && !target.flagged) {
      target.flagged = true;
      this.system(`${characterLabel(target)} は複数の通報によりミュートされました`);
      this.deps.broadcast({ t: 'flag', seat: target.index });
      this.broadcastLobby();
    }
  }

  private onLeave(conn: Conn): void {
    const seat = this.seatOfConn(conn);
    if (!seat) {
      conn.seat = null;
      return;
    }
    const wasHost = this.hostSeat === seat.index;
    if (this.status === 'lobby') {
      this.resetSeat(seat);
      conn.seat = null;
    } else {
      this.convertSeatToCpu(seat, 'leave');
      conn.seat = null;
    }
    if (wasHost) this.migrateHost();
    this.broadcastLobby();
    if (this.status === 'playing') this.armTurn(this.lastFx);
  }

  // ---------------------------------------------------------------- engine commit

  private commit(result: StepResult, actor: number): void {
    this.state = result.state;
    this.seq += 1;
    this.lastFx = result.fx;
    this.lastBy = actor;

    if (result.state.phase.t === 'game_over') {
      this.status = 'finished';
    }
    this.armTurn(result.fx);

    const update: ServerMsg = {
      t: 'update',
      seq: this.seq,
      by: actor,
      fx: result.fx,
      state: sanitizeState(result.state),
      deadline: this.deadline,
    };
    this.deps.broadcast(update);
    if (this.status === 'finished') this.broadcastLobby();
    this.maybeCpuReactions(result.fx, actor);
  }

  // ---------------------------------------------------------------- timers

  private armTurn(fx: readonly Fx[]): void {
    this.clearTask('turn');
    this.clearTask('ack');
    this.clearTask('cpu');
    for (const seat of this.seats) this.clearTask(`grace:${seat.index}`);
    const actorNow = this.state ? actorOf(this.state) : null;
    const sameDecision = this.deadlineSeq === this.seq && this.deadlineActor === actorNow;
    if (!sameDecision) {
      this.deadline = null;
      this.deadlineSeq = this.seq;
      this.deadlineActor = actorNow;
    }
    this.turnStartedAt = sameDecision ? this.turnStartedAt : this.deps.now();
    this.turnFxMs = sumFxDuration(fx) * this.fxScale;

    if (this.status !== 'playing' || !this.state || this.state.phase.t === 'game_over') {
      return;
    }
    const now = this.deps.now();
    // Replacement is independent of whose turn it is, and keeps running while frozen.
    for (const human of this.seats) {
      if (human.kind === 'human' && !seatConnected(human)) {
        const since = human.disconnectedAt ?? now;
        this.setTask(`replace:${human.index}`, Math.max(now, since + this.replaceMs));
      } else {
        this.clearTask(`replace:${human.index}`);
      }
    }
    if (this.frozen) return;
    const actor = actorOf(this.state);
    if (actor === null) return;
    const seat = this.seats[this.seatByPlayerId[actor]];
    if (!seat) return;

    if (seat.kind === 'cpu') {
      this.setTask('cpu', now + this.turnFxMs + this.cpuDelayMs);
      return;
    }
    if (seat.kind !== 'human') return;

    if (seat.token === null && !seat.autoplay) {
      // No pinned key after migration: CPU-autoplay until the owner proves key ownership.
      seat.autoplay = true;
    }
    if (this.settings.turnSeconds > 0 && this.deadline === null) {
      this.deadline = this.turnStartedAt + this.turnFxMs + this.settings.turnSeconds * 1000;
    }

    if (this.state.phase.t === 'year_end') {
      this.setTask('ack', now + this.turnFxMs + this.yearEndAckMs);
    }
    if (seat.autoplay) {
      this.clearTask(`grace:${seat.index}`);
      if (this.deadline !== null && this.deadline <= now) {
        this.setTask('cpu', now);
        return;
      }
      this.setTask('cpu', Math.min(now + this.turnFxMs + this.cpuDelayMs, this.deadline ?? Number.POSITIVE_INFINITY));
      return;
    }
    if (!seatConnected(seat)) {
      if (this.settings.turnSeconds > 0 && this.deadline === null) {
        this.deadline = this.turnStartedAt + this.turnFxMs + this.settings.turnSeconds * 1000;
      }
      if (this.deadline !== null) this.setTask('turn', this.deadline);
      this.setTask(`grace:${seat.index}`, now + this.graceMs);
      return;
    }

    if (this.settings.turnSeconds > 0) {
      if (this.deadline === null) {
        this.deadline = this.turnStartedAt + this.turnFxMs + this.settings.turnSeconds * 1000;
      }
      this.setTask('turn', this.deadline);
    }
  }

  private tick(): void {
    if (this.disposed || this.ticking) return;
    this.ticking = true;
    try {
      let rounds = 0;
      while (rounds < 1000) {
        const now = this.deps.now();
        const due = [...this.tasks.entries()]
          .filter(([, task]) => task.at <= now)
          .sort((a, b) => a[1].at - b[1].at || a[0].localeCompare(b[0]));
        if (due.length === 0) break;
        rounds += 1;
        for (const [key, task] of due) {
          // Validate the registration token: a task may have been re-armed for the next phase
          // while this due list was being processed.
          if (this.tasks.get(key)?.token !== task.token) continue;
          this.tasks.delete(key);
          try {
            this.runTask(key);
          } catch (error) {
            this.log(`timer ${key} failed`, error);
          }
        }
      }
    } finally {
      this.ticking = false;
      this.reschedule();
    }
  }

  private runTask(key: string): void {
    // Only disconnect -> CPU replacement may run while the authority is frozen.
    if (this.frozen && !key.startsWith('replace:')) return;
    if (key === 'turn') {
      this.onTurnTimeout();
      return;
    }
    if (key === 'ack') {
      this.onYearEndAck();
      return;
    }
    if (key === 'cpu') {
      this.onCpuMove();
      return;
    }
    if (key.startsWith('grace:')) {
      const index = Number(key.slice('grace:'.length));
      this.onGraceTimeout(index);
      return;
    }
    if (key.startsWith('replace:')) {
      const index = Number(key.slice('replace:'.length));
      this.onReplaceTimeout(index);
      return;
    }
  }

  private onTurnTimeout(): void {
    if (this.frozen || this.status !== 'playing' || !this.state) return;
    const seat = this.actorSeatData();
    if (!seat || seat.kind !== 'human') return;
    if (this.state.phase.t === 'year_end') {
      this.onYearEndAck();
      return;
    }
    if (!seat.autoplay) {
      seat.autoplay = true;
      this.system(`時間切れです。${characterLabel(seat)} は CPU が代行します`);
      this.broadcastLobby();
    }
    this.autoAct(seat, false);
  }

  private onGraceTimeout(index: number): void {
    if (this.frozen || this.status !== 'playing' || !this.state) return;
    const seat = this.seats[index];
    if (!seat || seat.kind !== 'human') return;
    const actor = this.actorSeatData();
    if (!actor || actor.index !== seat.index) return;
    if (seatConnected(seat)) return; // reconnected but autoplay has not been armed yet
    if (!seat.autoplay) {
      seat.autoplay = true;
      this.system(`${characterLabel(seat)} は応答がないため CPU が代行します`);
      this.broadcastLobby();
    }
    this.autoAct(seat, true);
  }

  private onYearEndAck(): void {
    if (this.frozen || this.status !== 'playing' || !this.state || this.state.phase.t !== 'year_end') return;
    const seat = this.actorSeatData();
    if (!seat || seat.kind !== 'human') return;
    this.tryAutoAction(seat, { t: 'ack' });
  }

  private onCpuMove(): void {
    if (this.frozen || this.status !== 'playing' || !this.state || this.state.phase.t === 'game_over') return;
    const seat = this.actorSeatData();
    if (!seat) return;
    if (seat.kind === 'human' && !seat.autoplay) return;
    this.autoAct(seat, false);
  }

  private onReplaceTimeout(index: number): void {
    if (this.status !== 'playing') return;
    const seat = this.seats[index];
    if (!seat || seat.kind !== 'human' || seatConnected(seat)) return;
    const since = seat.disconnectedAt ?? this.deps.now();
    if (this.deps.now() < since + this.replaceMs) {
      this.setTask(`replace:${index}`, since + this.replaceMs);
      return;
    }
    this.convertSeatToCpu(seat, 'timeout');
    this.broadcastLobby();
    this.armTurn(this.lastFx);
  }

  private autoAct(seat: Seat, grace: boolean): void {
    if (this.frozen || !this.state) return;
    const actor = actorOf(this.state);
    if (actor === null || this.seatByPlayerId[actor] !== seat.index) return;
    let action: Action;
    try {
      action = cpuDecide(this.deps.data, this.state);
    } catch (error) {
      this.log('cpuDecide failed', error);
      action = this.fallbackAction();
    }
    if (this.tryAutoAction(seat, action)) return;
    // One conservative fallback keeps an autoplay seat from stalling the room.
    this.tryAutoAction(seat, this.fallbackAction());
    this.log(`autoplay fallback used (grace=${String(grace)})`);
  }

  private tryAutoAction(seat: Seat, action: Action): boolean {
    if (!this.state) return false;
    const actor = actorOf(this.state);
    if (actor === null || this.seatByPlayerId[actor] !== seat.index) return false;
    try {
      const result = step(this.deps.data, this.state, actor, action);
      this.commit(result, actor);
      return true;
    } catch (error) {
      this.log('auto action failed', error);
      return false;
    }
  }

  private fallbackAction(): Action {
    const state = this.state;
    if (!state) return { t: 'ack' };
    switch (state.phase.t) {
      case 'turn_start':
        return { t: 'roll' };
      case 'choose_dest':
        return { t: 'move', nodeId: state.phase.options[0]?.nodeId ?? '' };
      case 'buy':
        return { t: 'end_buy' };
      case 'shop':
        return { t: 'end_shop' };
      case 'event':
        return { t: 'choose', index: 0 };
      case 'card_target':
        return { t: 'cancel' };
      case 'discard':
        return { t: 'discard', cardId: state.players[state.current]?.cards[0] ?? '' };
      case 'sell': {
        const player = state.players[state.current];
        const owned = player
          ? Object.entries(state.owner).find(([, owner]) => owner === player.id)?.[0]
          : undefined;
        return owned ? { t: 'sell', propertyId: owned } : { t: 'ack' };
      }
      case 'year_end':
        return { t: 'ack' };
      case 'game_over':
        return { t: 'ack' };
      default:
        return { t: 'ack' };
    }
  }

  private setTask(key: string, at: number): void {
    this.taskSeq += 1;
    this.tasks.set(key, { at, token: this.taskSeq });
    this.reschedule();
  }

  private clearTask(key: string): void {
    if (this.tasks.delete(key)) this.reschedule();
  }

  private reschedule(): void {
    if (this.ticking || this.disposed) return;
    if (this.alarm) {
      this.deps.clearTimer(this.alarm.handle);
      this.alarm = null;
    }
    if (this.tasks.size === 0) return;
    let next: { at: number } | null = null;
    for (const task of this.tasks.values()) {
      if (!next || task.at < next.at) next = task;
    }
    if (!next) return;
    const delay = Math.max(0, next.at - this.deps.now());
    const at = next.at;
    const handle = this.deps.setTimer(delay, () => {
      if (this.alarm && this.alarm.at === at) this.alarm = null;
      this.tick();
    });
    this.alarm = { at, handle };
  }

  private actorSeatData(): Seat | null {
    if (!this.state) return null;
    const actor = actorOf(this.state);
    if (actor === null) return null;
    return this.seats[this.seatByPlayerId[actor]] ?? null;
  }

  // ---------------------------------------------------------------- seats / host

  private emptySeat(index: number, now: number): Seat {
    return {
      index,
      kind: 'open',
      name: '',
      characterId: null,
      cpuLevel: 1,
      connId: null,
      token: null,
      reclaimToken: null,
      autoplay: false,
      disconnectedAt: null,
      chatBucket: initialBucket(now, COMM.chatBurst),
      emoteBucket: initialBucket(now, COMM.emoteBurst),
      lastEmoteAt: {},
      recentChat: [],
      flagged: false,
    };
  }

  private resetSeat(seat: Seat): void {
    const now = this.deps.now();
    seat.kind = 'open';
    seat.name = '';
    seat.characterId = null;
    seat.cpuLevel = 1;
    seat.connId = null;
    seat.token = null;
    seat.reclaimToken = null;
    seat.autoplay = false;
    seat.disconnectedAt = null;
    seat.chatBucket = initialBucket(now, COMM.chatBurst);
    seat.emoteBucket = initialBucket(now, COMM.emoteBurst);
    seat.lastEmoteAt = {};
    seat.recentChat = [];
    seat.flagged = false;
    this.reporters.delete(seat.index);
    this.clearTask(`grace:${seat.index}`);
    this.clearTask(`replace:${seat.index}`);
  }

  private convertSeatToCpu(seat: Seat, why: 'leave' | 'timeout'): void {
    const oldName = characterLabel(seat);
    seat.kind = 'cpu';
    seat.connId = null;
    // A timeout replacement keeps the key so the owner can reclaim the seat (资产 kept). An explicit
    // leave is final: the player is gone and the CPU owns the seat.
    seat.reclaimToken = why === 'timeout' ? seat.token : null;
    seat.token = null;
    seat.disconnectedAt = null;
    seat.autoplay = false;
    this.clearTask(`grace:${seat.index}`);
    this.clearTask(`replace:${seat.index}`);
    const conn = [...this.connections.values()].find((candidate) => candidate.seat === seat.index);
    if (conn) conn.seat = null;
    this.system(
      why === 'leave'
        ? `${oldName} が退出しました。CPU が引き継ぎます（資産はそのまま）`
        : `${oldName} が 120 秒戻らなかったため CPU になりました（資産はそのまま）`,
    );
  }

  private seatOfConn(conn: Conn): Seat | null {
    if (conn.seat === null) return null;
    const seat = this.seats[conn.seat];
    if (!seat || seat.kind !== 'human' || seat.connId !== conn.id) return null;
    return seat;
  }

  private isHostConn(conn: Conn): boolean {
    return this.hostSeat !== null && conn.seat === this.hostSeat;
  }

  private migrateHost(): void {
    if (this.hostSeat === null) return;
    const current = this.seats[this.hostSeat];
    const candidates = this.seats.filter(
      (seat) => seat.index !== this.hostSeat && seat.kind === 'human' && seatConnected(seat),
    );
    const fallback = this.seats.filter(
      (seat) => seat.index !== this.hostSeat && seat.kind === 'human',
    );
    const next = candidates[0] ?? fallback[0];
    if (!next) {
      if (this.status === 'lobby' && current?.kind === 'open') this.hostSeat = null;
      return;
    }
    this.hostSeat = next.index;
    this.system(`新しいホストは ${characterLabel(next)} です`);
    this.broadcastLobby();
  }

  private seatInfo(seat: Seat): SeatInfo {
    const info: SeatInfo = {
      index: seat.index,
      kind: seat.kind,
      name: seat.name,
      characterId: seat.characterId,
      cpuLevel: seat.cpuLevel,
      connected: seat.kind === 'human' && seat.connId !== null,
      isHost: this.hostSeat === seat.index,
      autoplay: seat.kind === 'human' && seat.autoplay,
    };
    if (seat.flagged) info.flagged = true;
    return info;
  }

  private cleanName(name: unknown): string {
    if (typeof name !== 'string') return '';
    return Array.from(name.replace(/[\u0000-\u001f\u007f]/g, '').trim()).slice(0, 16).join('');
  }

  private newToken(): string {
    let token = '';
    for (let i = 0; i < 32; i += 1) {
      token += TOKEN_ALPHABET[this.deps.randomInt(TOKEN_ALPHABET.length)] ?? 'A';
    }
    // A deterministic randomInt (tests) must not create collisions between seats.
    this.tokenCounter += 1;
    return `${token}${this.tokenCounter.toString(36)}`;
  }

  private broadcastLobby(): void {
    this.deps.broadcast({ t: 'lobby', lobby: this.lobbyView() });
  }

  private system(text: string): void {
    this.deps.broadcast({ t: 'system', text });
  }

  private sendError(connId: string, code: ErrorCode, message: string): void {
    this.deps.send(connId, { t: 'error', code, message });
  }

  private log(message: string, detail?: unknown): void {
    this.deps.log?.(`[room ${this.roomId}] ${message}`, detail);
  }

  // ---------------------------------------------------------------- emotes

  private validateEmote(seat: Seat, emoteId: string, target: unknown): string | null {
    const def = this.deps.data.emotes.find((candidate) => candidate.id === emoteId);
    if (!def) return 'そのエモートはありません';
    if (def.category === 'unique' || def.characterId) {
      if (!def.characterId || def.characterId !== seat.characterId) {
        return 'そのキャラクター固有のエモートは使えません';
      }
    }
    if (def.targeted) {
      if (typeof target !== 'number' || !isSeatIndex(target)) return '相手を選んでください';
      if (target === seat.index) return '自分には使えません';
      const other = this.seats[target];
      if (!other || other.kind === 'open') return '相手の席がありません';
    } else if (target !== undefined && target !== null) {
      return 'このエモートに相手は指定できません';
    }
    return null;
  }

  private consumeEmoteLimits(seat: Seat, def: EmoteDef): boolean {
    const now = this.deps.now();
    const last = seat.lastEmoteAt[def.id];
    if (last !== undefined && now - last < def.cooldownMs) return false;
    if (!takeToken(seat.emoteBucket, COMM.emoteBurst, COMM.emoteMinIntervalMs, now)) return false;
    seat.lastEmoteAt[def.id] = now;
    return true;
  }

  private tryEmoteFromSeat(seat: Seat, emoteId: string, target: number | null): boolean {
    const def = this.deps.data.emotes.find((candidate) => candidate.id === emoteId);
    if (!def) return false;
    if (this.validateEmote(seat, emoteId, def.targeted ? target : undefined) !== null) return false;
    if (!this.consumeEmoteLimits(seat, def)) return false;
    const emote: EmoteEvent = {
      id: this.nextEmoteId++,
      seat: seat.index,
      emoteId: def.id,
      target: def.targeted ? target : null,
      at: this.deps.now(),
    };
    this.deps.broadcast({ t: 'emote', emote });
    return true;
  }

  private maybeCpuReactions(fx: readonly Fx[], actorPlayerId: number): void {
    if (this.deps.randomInt(100) >= 35) return;

    interface Reaction {
      kind: 'negative' | 'positive' | 'goal' | 'piper' | 'monopoly' | 'year_end';
      playerId: number | null;
    }
    let reaction: Reaction | null = null;
    for (const item of fx) {
      if (item.t === 'cash' && item.delta < 0) {
        reaction = { kind: 'negative', playerId: item.playerId };
      } else if (item.t === 'goal') {
        reaction = { kind: 'goal', playerId: item.playerId };
      } else if (item.t === 'piper') {
        reaction = { kind: 'piper', playerId: item.holder };
      } else if (item.t === 'buy' && item.monopoly) {
        reaction = { kind: 'monopoly', playerId: item.playerId };
      } else if (item.t === 'year_end') {
        reaction = { kind: 'year_end', playerId: null };
      }
    }
    if (!reaction) return;

    const cpuSeats = this.seats.filter((seat) => seat.kind === 'cpu');
    if (cpuSeats.length === 0) return;
    let seat: Seat | null | undefined;
    if (reaction.playerId !== null) {
      const mapped = this.seats[this.seatByPlayerId[reaction.playerId]];
      if (mapped && mapped.kind === 'cpu') seat = mapped;
    }
    if (!seat) seat = cpuSeats[this.deps.randomInt(cpuSeats.length)];
    if (!seat) return;

    const generic = (ids: string[]): string | null =>
      ids.find((id) => this.deps.data.emotes.some((e) => e.id === id)) ?? null;

    if (reaction.kind === 'negative' || reaction.kind === 'piper') {
      const leader = this.leaderSeat();
      if (leader !== null && leader !== seat.index && this.deps.randomInt(2) === 0) {
        const poke = generic(['throw_tomato', 'throw_pie', 'bill_slap']);
        if (poke) {
          if (this.tryEmoteFromSeat(seat, poke, leader)) return;
        }
      }
      const emote = generic(['angry', 'sad', 'laugh']);
      if (emote) this.tryEmoteFromSeat(seat, emote, null);
      return;
    }
    if (reaction.kind === 'goal') {
      const emote = generic(['joy', 'laugh', 'dance']);
      if (emote) this.tryEmoteFromSeat(seat, emote, null);
      return;
    }
    if (reaction.kind === 'monopoly') {
      const emote = generic(['flex', 'money_rain']);
      if (emote) this.tryEmoteFromSeat(seat, emote, null);
      return;
    }
    if (reaction.kind === 'year_end') {
      const emote = generic(['money_rain', 'joy', 'flex']);
      if (emote) this.tryEmoteFromSeat(seat, emote, null);
    }
    void actorPlayerId;
  }

  private leaderSeat(): number | null {
    if (!this.state) return null;
    let best: { playerId: number; worth: number } | null = null;
    for (const player of this.state.players) {
      const worth = netWorth(this.deps.data, this.state, player.id);
      if (!best || worth > best.worth) best = { playerId: player.id, worth };
    }
    if (!best) return null;
    return this.seatByPlayerId[best.playerId] ?? null;
  }

  // ---------------------------------------------------------------- persistence

  serialize(): string {
    const room: SerializedRoom = {
      v: 1,
      roomId: this.roomId,
      status: this.status,
      settings: { ...this.settings },
      hostSeat: this.hostSeat,
      seq: this.seq,
      state: this.state,
      seats: this.seats,
      connections: [...this.connections.values()],
      chat: this.chat,
      nextChatId: this.nextChatId,
      nextEmoteId: this.nextEmoteId,
      lastFx: this.lastFx,
      lastBy: this.lastBy,
      deadline: this.deadline,
      deadlineSeq: this.deadlineSeq,
      deadlineActor: this.deadlineActor,
      turnStartedAt: this.turnStartedAt,
      turnFxMs: this.turnFxMs,
      playerIdBySeat: this.playerIdBySeat,
      seatByPlayerId: this.seatByPlayerId,
      reporters: Object.fromEntries([...this.reporters].map(([seat, set]) => [String(seat), [...set]])),
      tasks: [...this.tasks.entries()].map(([key, task]) => ({ key, at: task.at, token: task.token })),
      savedAt: this.deps.now(),
    };
    return JSON.stringify(room);
  }

  /**
   * Take over an orphaned room from a replicated public snapshot (host migration).
   * The sanitized state is cloned and given a brand-new crypto-random rng seed. Old host and all
   * other humans start disconnected so the normal grace -> autoplay -> CPU rules apply until they
   * re-hello.
   */
  static adopt(snapshot: RoomPublicSnapshot, deps: RoomDeps): RoomController {
    const room = new RoomController(deps);
    const now = deps.now();
    room.status = snapshot.lobby.status;
    if (room.status === 'playing' && !snapshot.state) room.status = 'lobby';
    room.settings = { ...DEFAULT_SETTINGS, ...snapshot.lobby.settings };
    room.hostSeat =
      snapshot.hostSeat !== null && snapshot.hostSeat !== undefined
        ? snapshot.hostSeat
        : (snapshot.lobby.seats.find((seat) => seat.isHost)?.index ?? null);
    room.seq = snapshot.seq;
    room.chat = [...snapshot.chat];
    room.nextChatId = room.chat.reduce((max, line) => Math.max(max, line.id + 1), 1);
    room.lastFx = [...snapshot.lastFx];
    room.lastBy = null;
    room.deadline = snapshot.deadline;
    room.deadlineSeq = room.seq;
    room.deadlineActor = null;
    room.turnStartedAt = now;
    const scale = typeof deps.fxScale === 'function' ? deps.fxScale() : (deps.fxScale ?? 1);
    room.turnFxMs = sumFxDuration(snapshot.lastFx) * scale;
    room.nextEmoteId = 1;

    room.seats = snapshot.lobby.seats.map((info) => {
      const seat = room.emptySeat(info.index, now);
      seat.kind = info.kind;
      seat.name = info.name;
      seat.characterId = info.characterId;
      seat.cpuLevel = info.cpuLevel;
      seat.flagged = info.flagged ?? false;
      seat.token =
        info.kind === 'human' ? (snapshot.seatKeys?.[String(info.index)] ?? null) : null;
      seat.reclaimToken =
        info.kind === 'cpu' ? (snapshot.reclaimKeys?.[String(info.index)] ?? null) : null;
      seat.connId = null;
      seat.disconnectedAt =
        info.kind === 'human' && room.status !== 'lobby' ? now : null;
      // A seat whose public key is missing cannot be authenticated; drive it by CPU until the
      // owner proves the key with a signed hello.
      seat.autoplay = info.kind === 'human' && seat.token === null;
      return seat;
    });
    while (room.seats.length < MAX_SEATS) {
      room.seats.push(room.emptySeat(room.seats.length, now));
    }

    if (snapshot.state) {
      room.state = withSeed({ ...snapshot.state, rng: 0 }, deps.randomInt(0x7fffffff) || 1);
      room.deadlineActor = actorOf(room.state);
    }

    for (const [target, votes] of Object.entries(snapshot.reportVotes ?? {})) {
      const targetSeat = Number(target);
      const reporterSeats = votes
        .map((fingerprint) => room.seats.find((seat) => seat.token === fingerprint)?.index)
        .filter((index): index is number => index !== undefined);
      if (reporterSeats.length > 0) room.reporters.set(targetSeat, new Set(reporterSeats));
    }

    room.playerIdBySeat = [];
    room.seatByPlayerId = [];
    const occupied = room.seats.filter((seat) => seat.kind !== 'open');
    occupied.forEach((seat, playerId) => {
      room.playerIdBySeat[seat.index] = playerId;
      room.seatByPlayerId[playerId] = seat.index;
    });

    if (room.status === 'playing') room.armTurn(room.lastFx);
    return room;
  }

  static restore(json: string, deps: RoomDeps, options: RestoreOptions = {}): RoomController {
    const parsed = JSON.parse(json) as SerializedRoom;
    if (!parsed || parsed.v !== 1 || !Array.isArray(parsed.seats)) {
      throw new Error('invalid room snapshot');
    }
    const room = new RoomController({ ...deps, roomId: deps.roomId || parsed.roomId });
    room.status = parsed.status;
    room.settings = { ...DEFAULT_SETTINGS, ...parsed.settings };
    room.hostSeat = parsed.hostSeat;
    room.seq = parsed.seq;
    room.state = parsed.state;
    room.lastFx = parsed.lastFx ?? [];
    room.lastBy = parsed.lastBy;
    room.deadline = parsed.deadline;
    room.deadlineSeq = parsed.deadlineSeq ?? -1;
    room.deadlineActor = parsed.deadlineActor ?? null;
    room.turnStartedAt = parsed.turnStartedAt ?? deps.now();
    room.turnFxMs = parsed.turnFxMs ?? 0;
    room.playerIdBySeat = parsed.playerIdBySeat ?? [];
    room.seatByPlayerId = parsed.seatByPlayerId ?? [];
    room.chat = parsed.chat ?? [];
    room.nextChatId = parsed.nextChatId ?? 1;
    room.nextEmoteId = parsed.nextEmoteId ?? 1;
    room.reporters = new Map(
      Object.entries(parsed.reporters ?? {}).map(([seat, values]) => [Number(seat), new Set(values)]),
    );

    const now = deps.now();
    room.seats = parsed.seats.map((seat, index) => {
      const base = room.emptySeat(index, now);
      return {
        ...base,
        ...seat,
        index,
        chatBucket: seat.chatBucket ?? base.chatBucket,
        emoteBucket: seat.emoteBucket ?? base.emoteBucket,
        lastEmoteAt: seat.lastEmoteAt ?? {},
        flagged: seat.flagged ?? false,
      };
    });

    room.connections = new Map(
      options.connections
        ? (parsed.connections ?? []).map((conn) => [conn.id, { ...conn }])
        : [],
    );
    if (!options.connections) {
      const at = now;
      for (const seat of room.seats) {
        if (seat.kind === 'human') {
          seat.connId = null;
          if (room.status === 'playing' || room.status === 'finished') {
            seat.disconnectedAt = seat.disconnectedAt ?? at;
          }
        }
      }
    }

    for (const task of parsed.tasks ?? []) {
      room.taskSeq += 1;
      room.tasks.set(task.key, { at: task.at, token: task.token ?? room.taskSeq });
    }

    // Crash recovery: re-arm replacement timers that could not have been serialized.
    if (!options.connections && room.status === 'playing') {
      for (const seat of room.seats) {
        if (seat.kind === 'human' && !seatConnected(seat)) {
          const since = seat.disconnectedAt ?? now;
          room.taskSeq += 1;
          room.tasks.set(`replace:${seat.index}`, {
            at: Math.max(now, since + room.replaceMs),
            token: room.taskSeq,
          });
        }
      }
      const actorSeat = room.actorSeatData();
      if (actorSeat && actorSeat.kind === 'human' && !seatConnected(actorSeat) && !actorSeat.autoplay) {
        room.taskSeq += 1;
        room.tasks.set(`grace:${actorSeat.index}`, { at: now + room.graceMs, token: room.taskSeq });
      }
    }
    room.reschedule();
    return room;
  }
}