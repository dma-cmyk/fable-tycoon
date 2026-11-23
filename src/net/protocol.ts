// Wire protocol between clients and the authoritative RoomController (server or in-browser LocalSession).
import type { Action, Fx } from '../core/types';
import { ALLOWED_YEARS } from '../core/engine';
import type { PublicState } from '../core/engine';

export { ALLOWED_YEARS };
export type { PublicState };

export const PROTOCOL_VERSION = 1;
export const MAX_SEATS = 4;

export type AllowedYears = (typeof ALLOWED_YEARS)[number];

export type SeatKind = 'human' | 'cpu' | 'open';

export interface SeatInfo {
  index: number; // 0..3
  kind: SeatKind;
  name: string;
  characterId: string | null;
  cpuLevel: 1 | 2 | 3;
  connected: boolean; // human only
  isHost: boolean;
  autoplay: boolean; // CPU is currently acting for this human (timeout / disconnected)
  /** Set by the auto-mute rule (≥2 reporters). Additive field: clients may render it as muted. */
  flagged?: boolean;
}

export interface RoomSettings {
  years: AllowedYears;
  turnSeconds: number; // 20 | 30 | 60 | 0 (= 無制限; local mode)
  visibility: 'private' | 'public';
}

export interface LobbyView {
  roomId: string;
  status: 'lobby' | 'playing' | 'finished';
  seats: SeatInfo[];
  settings: RoomSettings;
}



/** Communication limits (enforced by the server/RoomController; mirrored in the UI to grey out buttons). */
export const COMM = {
  chatMaxChars: 80,
  chatMinIntervalMs: 1500, // per seat
  chatBurst: 3, // token bucket size
  emoteMinIntervalMs: 2500, // per seat, any emote
  emoteBurst: 2,
  duplicateWindowMs: 10000, // identical chat text from the same seat is dropped within this window
  historySize: 60, // chat lines kept for snapshot / reconnect
} as const;

export interface ChatLine {
  id: number; // room-unique, increasing
  seat: number; // -1 = system
  text: string; // already filtered (NG words masked)
  at: number; // server epoch ms
}

/** A cosmetic emote/action broadcast. NEVER changes GameState (gameplay-affecting interference only via cards). */
export interface EmoteEvent {
  id: number;
  seat: number;
  emoteId: string; // EmoteDef.id (src/data/emotes.json)
  target: number | null; // targeted seat for 'poke' style actions
  at: number;
}

export interface Report {
  reporter: number;
  seat: number;
  reason: 'spam' | 'abuse' | 'cheat' | 'other';
  at: number;
}

// ---------------------------------------------------------------- client -> server

export type ClientMsg =
  | { t: 'hello'; v: number; roomId: string; name: string; token?: string; pub?: string } // token = public-key fingerprint; pub = public JWK
  | { t: 'take_seat'; index: number }
  | { t: 'leave_seat' }
  // `seat` is an additive extension: the host may pick a character for a CPU seat in the lobby.
  | { t: 'pick_character'; characterId: string; seat?: number }
  | { t: 'set_seat'; index: number; kind: 'cpu' | 'open'; cpuLevel?: 1 | 2 | 3 } // host only
  | { t: 'settings'; settings: Partial<RoomSettings> } // host only
  | { t: 'start' } // host only
  | { t: 'action'; seq: number; action: Action }
  | { t: 'chat'; text: string }
  | { t: 'emote'; emoteId: string; target?: number } // usable any time during lobby/game, by own seat
  | { t: 'report'; seat: number; reason: Report['reason'] } // stored server-side with last chat lines
  | { t: 'leave' } // leave room permanently (seat becomes CPU in game)
  | { t: 'ping'; at: number };

// ---------------------------------------------------------------- server -> client

export type ServerMsg =
  | { t: 'welcome'; roomId: string; token: string; seat: number | null; lobby: LobbyView; chat: ChatLine[]; gen?: number }
  | { t: 'lobby'; lobby: LobbyView; gen?: number }
  // full state, sent on game start / reconnect; client renders it without animation
  | { t: 'snapshot'; seq: number; state: PublicState; deadline: number | null; lobby: LobbyView; gen?: number }
  // incremental: apply fx animations then adopt state
  | { t: 'update'; seq: number; by: number; fx: Fx[]; state: PublicState; deadline: number | null; gen?: number }
  | { t: 'chat'; line: ChatLine }
  | { t: 'emote'; emote: EmoteEvent } // fire-and-forget; clients may drop if their overlay is busy
  | { t: 'system'; text: string } // 例: "赤ずきん が切断しました（CPU が代行中）"
  // Additive: auto-mute rule fired. Clients should mute/hide chat+emotes from this seat.
  | { t: 'flag'; seat: number }
  | { t: 'error'; code: ErrorCode; message: string }
  | { t: 'pong'; at: number; serverNow: number };

export type ErrorCode =
  | 'bad_version' | 'no_room' | 'room_full' | 'not_host' | 'not_your_turn' | 'stale' | 'illegal'
  | 'bad_request' | 'rate_limited' | 'already_started' | 'character_taken';
