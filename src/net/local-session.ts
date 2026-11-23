// Browser-side Session that runs the authoritative RoomController in-process.
//
// CPU games and local hot-seat share the online code path: the UI still sends ClientMsg / receives
// ServerMsg, and the RoomController enforces turn ownership, seq, timers and communication limits.
// All human seats are owned by this client; actions are routed to the currently acting seat.

import type { PlayerSetup } from '../core/types';
import { GAME_DATA } from '../data/index';
import type { ChatLine, ClientMsg, LobbyView, ServerMsg } from './protocol';
import { PROTOCOL_VERSION } from './protocol';
import type { ConnectionState, Session } from './session-types';
import { CPU_MOVE_DELAY_MS, RoomController } from './room';
import type { RoomDeps, TimerHandle } from './room';

export const LOCAL_SAVE_KEY = 'fable.local';
const LOCAL_ROOM_ID = 'LOCAL';

export interface LocalSetup {
  players: PlayerSetup[];
  years: number;
  seed?: number;
  /** Presentation and CPU pacing multiplier (1..16). Used by ?speed= automated playtests. */
  speed?: number;
}

function randomIntFromCrypto(n: number): number {
  if (n <= 0) return 0;
  const buffer = new Uint32Array(1);
  crypto.getRandomValues(buffer);
  return buffer[0] % n;
}

/** Small deterministic PRNG so a seeded local game gets a reproducible room seed. */
function seededRandom(seed: number): (n: number) => number {
  let state = seed >>> 0;
  return (n: number) => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    return n <= 0 ? 0 : Math.floor(value * n);
  };
}

function readLocal(key: string): string | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocal(key: string, value: string): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(key, value);
  } catch {
    // quota / privacy mode: local saves are best-effort
  }
}

function removeLocal(key: string): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

function localTimers(): Pick<RoomDeps, 'setTimer' | 'clearTimer'> {
  return {
    setTimer: (ms, fn) => setTimeout(fn, ms),
    // setTimeout returns number in browsers and a Timeout object in Node; clearTimeout accepts both.
    clearTimer: (handle: TimerHandle) => clearTimeout(handle as number),
  };
}

interface ParsedSave {
  roomId?: string;
  chat?: ChatLine[];
}

/** Narrow the persisted JSON just enough to rebuild the synthetic welcome; RoomController.restore validates the rest. */
function parseSave(raw: string): ParsedSave | null {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object') return null;
  const roomId = 'roomId' in parsed && typeof parsed.roomId === 'string' ? parsed.roomId : undefined;
  let chat: ChatLine[] | undefined;
  if ('chat' in parsed && Array.isArray(parsed.chat)) {
    chat = parsed.chat.filter(
      (line): line is ChatLine =>
        !!line &&
        typeof line === 'object' &&
        'id' in line &&
        typeof line.id === 'number' &&
        'text' in line &&
        typeof line.text === 'string' &&
        'seat' in line &&
        typeof line.seat === 'number' &&
        'at' in line &&
        typeof line.at === 'number',
    );
  }
  return { roomId, chat };
}

export class LocalSession implements Session {
  readonly mode = 'local' as const;
  readonly roomId: string;

  private readonly controller: RoomController;
  private readonly connBySeat = new Map<number, string>();
  private readonly humanSeatList: number[];
  private readonly listeners = new Set<(msg: ServerMsg) => void>();
  private readonly connectionListeners = new Set<(state: ConnectionState) => void>();
  private state: ConnectionState = 'open';
  private disposed = false;
  private ready = false;

  private lastWelcome: Extract<ServerMsg, { t: 'welcome' }> | null = null;
  private lastLobby: LobbyView | null = null;
  private lastSnapshot: Extract<ServerMsg, { t: 'snapshot' }> | null = null;
  private lastUpdate: Extract<ServerMsg, { t: 'update' }> | null = null;

  private constructor(controller: RoomController, humanSeats: number[]) {
    this.controller = controller;
    this.roomId = controller.roomId;
    this.humanSeatList = [...humanSeats];
    for (const seat of humanSeats) {
      const conn = controller.connectionIds().find((entry) => entry.seat === seat)?.connId;
      if (conn) this.connBySeat.set(seat, conn);
    }
    queueMicrotask(() => {
      if (this.disposed) return;
      this.ready = true;
      for (const listener of this.listeners) this.replay(listener);
    });
  }

  // ---------------------------------------------------------------- factories

  static create(setup: LocalSetup): LocalSession {
    if (!Array.isArray(setup.players) || setup.players.length < 2 || setup.players.length > 4) {
      throw new Error('ローカル対戦は 2〜4 人で開始してください');
    }
    if (!setup.players.some((player) => !player.isCpu)) {
      throw new Error('人間のプレイヤーが 1 人以上必要です');
    }
    if (!Number.isInteger(setup.years) || setup.years < 1 || setup.years > 10) {
      throw new Error('年数が不正です');
    }
    if (new Set(setup.players.map((player) => player.characterId)).size !== setup.players.length) {
      throw new Error('キャラクターが重複しています');
    }

    let sessionSink: ((msg: ServerMsg, connId: string | null) => void) | null = null;
    const speed = Math.max(1, Math.min(16, Number(setup.speed) || 1));
    const deps: RoomDeps = {
      roomId: LOCAL_ROOM_ID,
      now: () => Date.now(),
      fxScale: 1 / speed,
      cpuDelayMs: Math.round(CPU_MOVE_DELAY_MS / speed),
      ...localTimers(),
      randomInt: setup.seed === undefined ? randomIntFromCrypto : seededRandom(setup.seed),
      data: GAME_DATA,
      send: (connId, msg) => sessionSink?.(msg, connId),
      broadcast: (msg) => sessionSink?.(msg, null),
    };
    const controller = new RoomController(deps);

    const humanSeats: number[] = [];
    setup.players.forEach((player, index) => {
      if (!player.isCpu) humanSeats.push(index);
    });
    const session = new LocalSession(controller, humanSeats);
    sessionSink = (msg, connId) => {
      if (msg.t === 'welcome' && connId !== session.connBySeat.get(humanSeats[0] ?? 0)) return;
      session.onMessage(msg);
    };

    const hostSeat = humanSeats[0];
    const hostConn = `local-${hostSeat}`;

    // 1. Human seats claim themselves.
    for (const seat of humanSeats) {
      const connId = `local-${seat}`;
      session.connBySeat.set(seat, connId);
      controller.connect(connId);
      controller.message(connId, {
        t: 'hello',
        v: PROTOCOL_VERSION,
        roomId: LOCAL_ROOM_ID,
        name: setup.players[seat].name,
      });
      controller.message(connId, { t: 'take_seat', index: seat });
      controller.message(connId, {
        t: 'pick_character',
        characterId: setup.players[seat].characterId,
      });
    }

    // 2. CPU seats and their characters are configured by the host.
    setup.players.forEach((player, index) => {
      if (!player.isCpu) return;
      controller.message(hostConn, {
        t: 'set_seat',
        index,
        kind: 'cpu',
        cpuLevel: player.cpuLevel ?? 2,
      });
      controller.message(hostConn, {
        t: 'pick_character',
        characterId: player.characterId,
        seat: index,
      });
    });

    controller.message(hostConn, {
      t: 'settings',
      settings: { years: setup.years, turnSeconds: 0, visibility: 'private' },
    });
    controller.message(hostConn, { t: 'start' });
    return session;
  }

  static resume(raw: string): LocalSession | null {
    const parsed = parseSave(raw);
    if (!parsed) return null;

    let session: LocalSession | null = null;
    let controller: RoomController;
    try {
      controller = RoomController.restore(
        raw,
        {
          roomId: parsed.roomId ?? LOCAL_ROOM_ID,
          now: () => Date.now(),
          ...localTimers(),
          randomInt: randomIntFromCrypto,
          data: GAME_DATA,
          send: (connId, msg) => session?.onOut(msg, connId),
          broadcast: (msg) => session?.onOut(msg, null),
        },
        { connections: true },
      );
    } catch {
      return null;
    }

    const lobby = controller.lobbyView();
    const humans = lobby.seats.filter((seat) => seat.kind === 'human').map((seat) => seat.index);
    if (humans.length === 0) return null;
    session = new LocalSession(controller, humans);

    session.record({
      t: 'welcome',
      roomId: controller.roomId,
      token: '',
      seat: humans[0],
      lobby,
      chat: controller.chatHistory(),
    });
    const state = controller.publicState();
    if (state) {
      session.record({
        t: 'snapshot',
        seq: controller.currentSeq,
        state,
        deadline: controller.currentDeadline,
        lobby,
      });
    }
    return session;
  }

  // ---------------------------------------------------------------- Session

  mySeats(): number[] {
    return [...this.humanSeatList];
  }

  lobby(): LobbyView | null {
    return this.lastLobby ?? this.lastWelcome?.lobby ?? this.controller.lobbyView();
  }

  connection(): ConnectionState {
    return this.state;
  }

  subscribe(listener: (msg: ServerMsg) => void): () => void {
    this.listeners.add(listener);
    if (this.ready) this.replay(listener);
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
    if (this.disposed) return;
    if (msg.t === 'ping') return;
    const conn = this.routeConn(msg);
    if (!conn) return;
    this.controller.message(conn, msg);
  }

  close(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.controller.dispose();
    this.state = 'closed';
    for (const listener of this.connectionListeners) listener('closed');
  }

  // ---------------------------------------------------------------- internals

  private routeConn(msg: ClientMsg): string | null {
    const actor = this.controller.actorSeat();
    const actorConn = actor === null ? null : this.connBySeat.get(actor);
    const first = this.humanSeatList
      .map((seat) => this.connBySeat.get(seat))
      .find((conn): conn is string => !!conn);
    if (msg.t === 'action' || msg.t === 'chat' || msg.t === 'emote' || msg.t === 'report') {
      return actorConn ?? first ?? null;
    }
    return first ?? null;
  }

  private onMessage(msg: ServerMsg): void {
    this.record(msg);
    if (!this.ready) return;
    for (const listener of this.listeners) listener(msg);
  }

  private onOut(msg: ServerMsg, connId: string | null): void {
    const primary = this.connBySeat.get(this.humanSeatList[0] ?? 0);
    if (msg.t === 'welcome' && connId !== primary) return;
    this.onMessage(msg);
  }

  private record(msg: ServerMsg): void {
    switch (msg.t) {
      case 'welcome':
        this.lastWelcome = msg;
        this.lastLobby = msg.lobby;
        break;
      case 'lobby':
        this.lastLobby = msg.lobby;
        break;
      case 'snapshot':
        this.lastSnapshot = msg;
        this.lastLobby = msg.lobby;
        break;
      case 'update':
        this.lastUpdate = msg;
        break;
      default:
        break;
    }
    if (msg.t === 'update' || msg.t === 'snapshot' || msg.t === 'lobby') this.persist();
  }

  private persist(): void {
    if (this.disposed) return;
    writeLocal(LOCAL_SAVE_KEY, this.controller.serialize());
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
}

export function createLocal(setup: LocalSetup): LocalSession {
  return LocalSession.create(setup);
}

export function hasLocalSave(): boolean {
  return readLocal(LOCAL_SAVE_KEY) !== null;
}

export function resumeLocal(): LocalSession | null {
  const raw = readLocal(LOCAL_SAVE_KEY);
  return raw ? LocalSession.resume(raw) : null;
}

export function clearLocalSave(): void {
  removeLocal(LOCAL_SAVE_KEY);
}