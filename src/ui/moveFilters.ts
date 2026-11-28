// Quick filters and errand pinning for the destination list (2026-11-26 Sol playtest).
//
// Express rolls offer 113–233 candidates. Sol asked to pin the reachable errand city to the top
// and to narrow the list with 「買える駅」「青・カード」「依頼」. Pure predicates so the tray
// rendering stays testable without a DOM.

import type { SquareKind } from '../core/types';

export type MoveQuickFilter = 'all' | 'affordable' | 'blue-card' | 'errand';

export interface MoveFilterOption {
  id: Exclude<MoveQuickFilter, 'all'>;
  label: string;
}

export const MOVE_QUICK_FILTERS: readonly MoveFilterOption[] = [
  { id: 'affordable', label: '買える駅' },
  { id: 'blue-card', label: '青・カード' },
  { id: 'errand', label: '依頼' },
];

export interface MoveFilterEntry {
  nodeId: string;
  kind: SquareKind;
  /** City id when the square is a station, else null. */
  cityId: string | null;
  /** A city has an unowned property the acting player can pay for right now. */
  affordable: boolean;
}

/** Card-giving squares: the blue money square and both card squares (yellow / shop). */
const CARD_KINDS: Partial<Record<SquareKind, true>> = { blue: true, yellow: true, shop: true };

export function matchesMoveFilter(
  filter: MoveQuickFilter,
  entry: MoveFilterEntry,
  errandCityId: string | null,
): boolean {
  switch (filter) {
    case 'affordable':
      return entry.kind === 'city' && entry.affordable;
    case 'blue-card':
      return CARD_KINDS[entry.kind] === true;
    case 'errand':
      return entry.cityId !== null && entry.cityId === errandCityId;
    default:
      return true;
  }
}

/** Move the reachable errand city to the front without disturbing the rest of the order. */
export function pinErrandFirst<T>(options: readonly T[], isErrand: (option: T) => boolean): T[] {
  const index = options.findIndex(isErrand);
  if (index <= 0) return [...options];
  const copy = [...options];
  const [errand] = copy.splice(index, 1);
  copy.unshift(errand);
  return copy;
}

/**
 * The chip that carries the 「おすすめ」 tag.
 *
 * A quick filter (駅のみ / 買える駅 / 青・カード / 依頼) may hide the recommended chip. The
 * recommendation must stay visible whenever the tray is open, so the tag moves to the first
 * visible chip instead of disappearing. Returns null only when nothing is visible at all.
 */
export function pickShownRecommendation(recommendedId: string | null, visibleNodeIds: readonly string[]): string | null {
  if (recommendedId !== null && visibleNodeIds.includes(recommendedId)) return recommendedId;
  return visibleNodeIds[0] ?? recommendedId;
}

export function countMoveFilters(
  entries: readonly MoveFilterEntry[],
  errandCityId: string | null,
): Record<Exclude<MoveQuickFilter, 'all'>, number> {
  const counts = { affordable: 0, 'blue-card': 0, errand: 0 };
  for (const entry of entries) {
    for (const filter of MOVE_QUICK_FILTERS) {
      if (matchesMoveFilter(filter.id, entry, errandCityId)) counts[filter.id] += 1;
    }
  }
  return counts;
}