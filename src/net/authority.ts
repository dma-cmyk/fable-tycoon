// Pure authority rules shared by the online session and its tests.
//
// Two invariants keep a partitioned room from advancing on both sides:
//  1. every guest follows exactly ONE host (fingerprint + generation), and a host counts a peer
//     toward its quorum only while that peer's latest liveness says it follows this host;
//  2. generations are strictly increasing across authority changes, so a returning old host
//     (lower generation) can never displace the authority that replaced it.

import type { PublicState } from './protocol';

/** A peer's liveness statement: which host it currently follows. */
export interface FollowState {
  hostFp: string;
  gen: number;
}

export interface FollowRecord extends FollowState {
  at: number;
}

/** New authority generation: always strictly greater than every generation seen so far. */
export function nextGeneration(seen: Iterable<number>): number {
  let highest = 0;
  for (const gen of seen) {
    if (Number.isFinite(gen) && gen > highest) highest = gen;
  }
  return highest + 1;
}

/** True when a claim is older than an authority generation this client has already seen. */
export function isStaleGeneration(claimGen: number, highestSeen: number): boolean {
  return !Number.isFinite(claimGen) || claimGen < highestSeen;
}

/**
 * Count human seats whose LATEST liveness follows `hostFp`, including the host's own seat.
 * The host identity (public-key fingerprint) is what decides followership: a peer that names this
 * host's key is following it even while it is a generation behind (catch-up after a bump). A peer
 * that names a different key has switched and must not prop up the old host.
 * `seatKeys` maps seat index -> public-key fingerprint; CPU/open seats have no key.
 */
export function countFollowers(
  seatKeys: Readonly<Record<string, string>>,
  followers: ReadonlyMap<string, FollowRecord>,
  hostFp: string,
  now: number,
  silenceMs: number,
): number {
  // The host counts only while it actually holds a human seat (a spectator host has no seat and
  // must not manufacture a majority of one).
  let count = Object.values(seatKeys).includes(hostFp) ? 1 : 0;
  for (const key of Object.values(seatKeys)) {
    if (!key || key === hostFp) continue;
    const record = followers.get(key);
    if (!record) continue;
    if (record.hostFp !== hostFp) continue; // follows someone else (or nobody): not a confirmation
    if (now - record.at > silenceMs) continue;
    count += 1;
  }
  return count;
}

/**
 * A new authority generation beats an older one no matter how much state the older side has; two
 * claims of the SAME generation are compared by seq, then connected humans, then peer id.
 */
export function claimRanksAbove(
  incoming: { gen: number; seq: number; connectedHumans: number; hostPeerId: string },
  current: { gen: number; seq: number; connectedHumans: number; hostPeerId: string },
): boolean {
  if (incoming.gen !== current.gen) return incoming.gen > current.gen;
  if (incoming.seq !== current.seq) return incoming.seq > current.seq;
  if (incoming.connectedHumans !== current.connectedHumans) {
    return incoming.connectedHumans > current.connectedHumans;
  }
  return incoming.hostPeerId < current.hostPeerId;
}

/** Broker candidates rotated by `attempt`, skipping brokers that never answered. */
export function rotateBrokers(
  brokers: readonly string[],
  attempt: number,
  exclude: ReadonlySet<string> = new Set(),
): string[] {
  const usable = brokers.filter((broker) => !exclude.has(broker));
  if (usable.length === 0) return [...brokers];
  const start = ((attempt % usable.length) + usable.length) % usable.length;
  return usable.map((_, index) => usable[(start + index) % usable.length]);
}

/** One link of a room's approved host-key chain: the key, its generation, and who approved it. */
export interface KeyLink {
  fp: string;
  gen: number;
  /** Seat fingerprints whose signed ack approved this authority (inherently envelope-signed). */
  approvedBy: string[];
  /** Acks that were required when the link was written (strict-majority-minus-host). */
  needed: number;
}

/**
 * True when a stored successor may replace the invite URL's initial pin: every approver must be an
 * agreed human seat of this room, and they must form a strict majority of those seats.
 */
export function isVerifiedTransfer(
  link: Pick<KeyLink, 'approvedBy' | 'needed'>,
  agreedSeatKeys: readonly string[],
  strictMajorityNeeded: number,
): boolean {
  const needed = Math.max(link.needed, strictMajorityNeeded);
  const unique = new Set(link.approvedBy);
  if (unique.size < needed) return false;
  const agreed = new Set(agreedSeatKeys);
  for (const fingerprint of unique) {
    if (!agreed.has(fingerprint)) return false;
  }
  return true;
}

const STATE_HASH_SEED = 'fable-state-v1';

/** Cheap stable digest of the visible game state, used to detect divergence (not security). */
export function stateHashOf(state: PublicState | null, seq: number): string {
  if (!state) return `e:${seq}`;
  const parts: string[] = [
    STATE_HASH_SEED,
    String(seq),
    String(state.current),
    state.phase.t,
    `${state.year}-${state.month}`,
  ];
  for (const player of state.players) {
    parts.push(`${player.id}:${player.cash}:${player.nodeId}:${player.cards.join('|')}:${player.skipTurns}`);
  }
  const owners = Object.entries(state.owner)
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([propertyId, owner]) => `${propertyId}=${owner}`);
  parts.push(owners.join(','));
  let hash = 0x811c9dc5;
  const text = parts.join('\u0001');
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
