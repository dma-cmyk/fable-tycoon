// Opt-in network diagnostics (`?debug=net`) and read-only snapshots for tests.
// Silent by default: `console.debug` is emitted only when `?debug=net` is set (or forced in tests).

import type { Action } from '../core/types';
import type { ConnectionState } from './session-types';

export type RoomTaskKind = 'turn' | 'cpu' | 'ack' | 'catchup' | 'grace' | 'replace' | 'other';

export interface RoomTaskSnapshot {
  key: string;
  kind: RoomTaskKind;
  at: number;
  inMs: number;
}

export interface RoomDebugSnapshot {
  roomId: string;
  status: 'lobby' | 'playing' | 'finished';
  seq: number;
  frozen: boolean;
  actorSeat: number | null;
  phase: string | null;
  deadline: number | null;
  tasks: RoomTaskSnapshot[];
}

export interface PendingActionSnapshot {
  gen: number;
  seq: number;
  actionType: Action['t'];
  firstSentAt: number;
  sentAt: number;
  retries: number;
  resyncs: number;
}

export interface NetDebugSnapshot {
  roomId: string;
  clientId: string;
  role: 'host' | 'guest';
  seat: number | null;
  connection: ConnectionState;
  generation: number;
  highestGenerationSeen: number;
  lastReceived: { gen: number; seq: number } | null;
  applied: { gen: number; seq: number } | null;
  pendingAction: PendingActionSnapshot | null;
  deferredAction: { gen: number; seq: number; actionType: Action['t']; at: number } | null;
  switchingAuthority: boolean;
  authority: {
    ready: boolean;
    promotionConfirmed: boolean;
    quorumOk: boolean;
    requiredAcks: number;
    acks: number;
    frozen: boolean;
  };
  controller: RoomDebugSnapshot | null;
  broker: string | null;
  mirrors: string[];
}

let forcedDebugNet: boolean | null = null;

/** Test seam: override `?debug=net` detection in Node/browser tests. */
export function setNetDebugForTests(enabled: boolean | null): void {
  forcedDebugNet = enabled;
}

/** True when `?debug=net` (or `?debug=all`) is active in the URL. Disabled by default. */
export function isNetDebugEnabled(): boolean {
  if (forcedDebugNet !== null) return forcedDebugNet;
  try {
    if (typeof location === 'undefined' || !location.search) return false;
    const raw = new URLSearchParams(location.search).get('debug');
    if (!raw) return false;
    return raw
      .split(',')
      .map((token) => token.trim().toLowerCase())
      .some((token) => token === 'net' || token === 'all' || token === '1' || token === 'true');
  } catch {
    return false;
  }
}

/** Emit a structured `console.debug` entry only when `?debug=net` is enabled. */
export function netDebug(tag: string, message: string, detail?: unknown): void {
  if (!isNetDebugEnabled()) return;
  if (detail === undefined) console.debug(`[debug:net ${tag}] ${message}`);
  else console.debug(`[debug:net ${tag}] ${message}`, detail);
}

export function classifyRoomTask(key: string): RoomTaskKind {
  if (key === 'turn') return 'turn';
  if (key === 'cpu') return 'cpu';
  if (key === 'ack') return 'ack';
  if (key === 'catchup') return 'catchup';
  if (key.startsWith('grace:')) return 'grace';
  if (key.startsWith('replace:')) return 'replace';
  return 'other';
}
