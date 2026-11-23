// Wire protocol between clients and the authoritative RoomController (server or in-browser LocalSession).
import type { Action, Fx, GameState } from '../core/types';

export const PROTOCOL_VERSION = 1;
export const MAX_SEATS = 4;

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
}

export interface RoomSettings {
  years: number; // 1 | 3 | 5 | 10
  turnSeconds: number; // 20 | 30 | 60 | 0 (= 無制限; local mode)
  visibility: 'private' | 'public';
}

export interface LobbyView {
  roomId: string;
  status: 'lobby' | 'playing' | 'finished';
  seats: SeatInfo[];
  settings: RoomSettings;
}

/** state with rng removed (see sanitizeState) */
export type PublicState = GameState;

export const STAMPS = ['👍', '😂', '😱', '💸', '🙏', '😡', '🎉', '🤔'] as const;
export const PHRASES = [
  'よろしく！', 'ナイス！', 'やられた〜', 'お先に失礼！', 'それはズルい！', '待って待って', '大富豪は私だ', 'GG！',
] as const;

// ---------------------------------------------------------------- client -> server

export type ClientMsg =
  | { t: 'hello'; v: number; roomId: string; name: string; token?: string } // token = seatToken for reconnect
  | { t: 'take_seat'; index: number }
  | { t: 'leave_seat' }
  | { t: 'pick_character'; characterId: string }
  | { t: 'set_seat'; index: number; kind: 'cpu' | 'open'; cpuLevel?: 1 | 2 | 3 } // host only
  | { t: 'settings'; settings: Partial<RoomSettings> } // host only
  | { t: 'start' } // host only
  | { t: 'action'; seq: number; action: Action }
  | { t: 'stamp'; stamp: number } // index into STAMPS
  | { t: 'phrase'; phrase: number } // index into PHRASES
  | { t: 'leave' } // leave room permanently (seat becomes CPU in game)
  | { t: 'ping'; at: number };

// ---------------------------------------------------------------- server -> client

export type ServerMsg =
  | { t: 'welcome'; roomId: string; token: string; seat: number | null; lobby: LobbyView }
  | { t: 'lobby'; lobby: LobbyView }
  // full state, sent on game start / reconnect; client renders it without animation
  | { t: 'snapshot'; seq: number; state: PublicState; deadline: number | null; lobby: LobbyView }
  // incremental: apply fx animations then adopt state
  | { t: 'update'; seq: number; by: number; fx: Fx[]; state: PublicState; deadline: number | null }
  | { t: 'react'; seat: number; stamp?: number; phrase?: number }
  | { t: 'system'; text: string } // 例: "赤ずきん が切断しました（CPU が代行中）"
  | { t: 'error'; code: ErrorCode; message: string }
  | { t: 'pong'; at: number; serverNow: number };

export type ErrorCode =
  | 'bad_version' | 'no_room' | 'room_full' | 'not_host' | 'not_your_turn' | 'stale' | 'illegal'
  | 'bad_request' | 'rate_limited' | 'already_started' | 'character_taken';
