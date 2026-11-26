// Distance information for city-target cards (飛行機 / ロケット / じゅうたん / 出口).
//
// Sol's playtests complained that the carpet landing could only be judged by place name,
// and that the insider card gave no idea how far the new destination would be. Both are
// presentation problems: the board already knows every shortest path. This module turns the
// engine's target list into comparable rows (destination steps, errand steps, steps from the
// current position, and the distance gain versus standing still) and keeps that math testable
// away from the DOM.

import type { City } from '../core/types';

export type WarpSortMode = 'distance' | 'name';

export interface WarpCandidateSource {
  nodeId: string;
  city: City;
}

export interface WarpCandidate {
  nodeId: string;
  cityId: string;
  nameJa: string;
  nameEn: string;
  country: string;
  countryJa: string;
  /** Steps from this candidate to the current destination (null when unreachable). */
  toDestination: number | null;
  /** Steps from this candidate to the errand city (null when no errand / unreachable). */
  toErrand: number | null;
  /** Steps from the acting player's current node to this candidate. */
  fromHere: number | null;
  /** `toDestination - fromHere`. Negative means the jump ends closer than standing still. */
  gain: number | null;
}

export interface BuildWarpCandidatesInput {
  sources: readonly WarpCandidateSource[];
  /** Node the acting player stands on. */
  hereNodeId: string | null;
  /** Node of the current destination city. */
  destinationNodeId: string | null;
  /** Node of the errand city, when 寄り道依頼 is active. */
  errandNodeId?: string | null;
  distance: (fromNodeId: string, toNodeId: string) => number;
}

function stepsBetween(
  distance: (fromNodeId: string, toNodeId: string) => number,
  fromNodeId: string | null,
  toNodeId: string | null,
): number | null {
  if (!fromNodeId || !toNodeId) return null;
  const value = distance(fromNodeId, toNodeId);
  return Number.isFinite(value) ? value : null;
}

export function buildWarpCandidates(input: BuildWarpCandidatesInput): WarpCandidate[] {
  return input.sources.map((source) => {
    const toDestination = stepsBetween(input.distance, source.nodeId, input.destinationNodeId);
    const toErrand = input.errandNodeId
      ? stepsBetween(input.distance, source.nodeId, input.errandNodeId)
      : null;
    const fromHere = stepsBetween(input.distance, input.hereNodeId, source.nodeId);
    const gain = toDestination !== null && fromHere !== null ? toDestination - fromHere : null;
    return {
      nodeId: source.nodeId,
      cityId: source.city.id,
      nameJa: source.city.nameJa,
      nameEn: source.city.nameEn,
      country: source.city.country,
      countryJa: source.city.countryJa,
      toDestination,
      toErrand,
      fromHere,
      gain,
    };
  });
}

/** Missing distances always sort last, so "unknown" never crowds out a usable target. */
function compareNullable(a: number | null, b: number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}

const NAME_COLLATOR = new Intl.Collator('ja');

export function sortWarpCandidates(
  candidates: readonly WarpCandidate[],
  mode: WarpSortMode,
): WarpCandidate[] {
  const copy = [...candidates];
  if (mode === 'name') {
    copy.sort(
      (a, b) =>
        NAME_COLLATOR.compare(a.nameJa, b.nameJa) || a.cityId.localeCompare(b.cityId),
    );
    return copy;
  }
  copy.sort(
    (a, b) =>
      compareNullable(a.toDestination, b.toDestination) ||
      compareNullable(a.fromHere, b.fromHere) ||
      NAME_COLLATOR.compare(a.nameJa, b.nameJa) ||
      a.cityId.localeCompare(b.cityId),
  );
  return copy;
}

/** Min/max landing distance to the destination across the offered candidates. */
export function warpDestinationRange(
  candidates: readonly WarpCandidate[],
): { min: number; max: number } | null {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const candidate of candidates) {
    if (candidate.toDestination === null) continue;
    min = Math.min(min, candidate.toDestination);
    max = Math.max(max, candidate.toDestination);
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  return { min, max };
}

/** "5 マス近づく" / "3 マス遠のく" / null when the gain cannot be computed. */
export function warpGainText(gain: number | null): string | null {
  if (gain === null) return null;
  if (gain < 0) return `${-gain} マス近づく`;
  if (gain > 0) return `${gain} マス遠のく`;
  return '今と同じ';
}

export const INSIDER_RULE = '20 マス以上で、自分に近い都市に引き直す';
/** Below this distance the insider redraw is almost certainly a downgrade. */
export const INSIDER_NEAR_STEPS = 8;

export interface InsiderNotice {
  distanceText: string;
  /** Numeric distance for compact confirm rows (null when unreadable). */
  steps: number | null;
  ruleText: string;
  /** True when the current destination is already nearby (<= INSIDER_NEAR_STEPS). */
  warn: boolean;
  warnText: string | null;
}

export function insiderNotice(distanceToDestination: number | null): InsiderNotice {
  const warn =
    distanceToDestination !== null && distanceToDestination <= INSIDER_NEAR_STEPS;
  return {
    distanceText:
      distanceToDestination === null
        ? '目的地までの距離が読めません'
        : `いまの目的地まで ${distanceToDestination} マス`,
    steps: distanceToDestination,
    ruleText: INSIDER_RULE,
    warn,
    warnText: warn ? '今の方が近いかも' : null,
  };
}