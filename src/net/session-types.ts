// Client-side session abstraction. The UI talks only to this interface, never to the engine directly,
// so CPU/local hot-seat (LocalSession: RoomController inside the browser) and online play
// (OnlineSession: WebSocket to the authoritative server) share one UI code path.
import type { ClientMsg, LobbyView, ServerMsg } from './protocol';

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
  /** Leave permanently (online: sends 'leave' then closes). */
  close(): void;
}

/** Standard presentation durations (ms) at 1x speed. Server uses them to delay CPU/autoplay moves
 * and to extend turn deadlines; the client uses them as the default playback pacing. */
export const FX_MS = {
  turn: 900,
  dice: 1300,
  moveStep: 230,
  warp: 900,
  cash: 700,
  buy: 900,
  sell: 600,
  card_get: 900,
  card_use: 900,
  sayBase: 700,
  sayPerChar: 95,
  event_open: 1200,
  event_close: 300,
  goal: 2600,
  destination: 2000,
  piper: 1800,
  industry: 1200,
  skip: 900,
  month: 500,
  year_end: 1500,
  game_over: 2000,
  toast: 800,
} as const;
