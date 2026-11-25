// Client-side session abstraction. The UI talks only to this interface, never to the engine directly,
// so CPU/local hot-seat (LocalSession: RoomController inside the browser) and online play
// (OnlineSession: WebSocket to the authoritative server) share one UI code path.
import type { ClientMsg, LobbyView, ServerMsg } from './protocol';
import type { NetDebugSnapshot } from './debug';

export type ConnectionState = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface Session {
  readonly mode: 'local' | 'online';
  readonly roomId: string;
  /** Seats this client may act for. local: every human seat; online: [own seat] or [] (spectator). */
  mySeats(): number[];
  /** Latest lobby view received (null before welcome). */
  lobby(): LobbyView | null;
  connection(): ConnectionState;
  /** Lobby seat index -> GameState player id (null if the seat is not in the game). Seats with gaps map densely. */
  seatToPlayer(seat: number): number | null;
  /** GameState player id -> lobby seat index. */
  playerToSeat(playerId: number): number | null;
  send(msg: ClientMsg): void;
  /** Receives every ServerMsg in order. Returns unsubscribe. */
  subscribe(listener: (msg: ServerMsg) => void): () => void;
  onConnection(listener: (s: ConnectionState) => void): () => void;
  /** The (gen, seq) of the last state actually delivered to subscribers (null before the first). */
  appliedOrder?(): { gen: number; seq: number } | null;
  /** Ask the authoritative host for a fresh snapshot (online only). */
  requestResync?(): void;
  /** Read-only network/controller state snapshot for `?debug=net` and tests. */
  debugSnapshot?(): NetDebugSnapshot;
  /** Leave permanently (online: sends 'leave' then closes). */
  close(): void;
}

/** Standard presentation durations (ms) at 1x speed. Server uses them to delay CPU/autoplay moves
 * and to extend turn deadlines; the client uses them as the default playback pacing. */
export const FX_MS = {
  turn: 340,
  dice: 820,
  moveStep: 150,
  warp: 700,
  cash: 380,
  buy: 440,
  sell: 380,
  card_get: 480,
  card_use: 480,
  sayBase: 450,
  sayPerChar: 75,
  event_open: 600,
  event_close: 200,
  goal: 1600,
  destination: 1300,
  piper: 900,
  industry: 650,
  skip: 550,
  month: 380,
  year_end: 950,
  game_over: 1300,
  toast: 450,
  piper_roulette: 2600,
  piper_disaster: 2400,
  piper_gift: 1600,
  buyout: 900,
  city_mod: 1500,
  skill: 2200,
  final_year: 3000,
} as const;
