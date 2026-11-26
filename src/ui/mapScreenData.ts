// Pure data shaping for the separate world map screen: ownership grouping and city search.
// The screen component owns DOM/MapView; everything stringly-testable lives here.

import type { CityModState } from '../core/types';

export interface CityOwnerGroup {
  cityId: string;
  /** Owners of properties in this city, largest holding first, ties by player id. */
  owners: Array<{ playerId: number; count: number }>;
}

/** Group the authoritative property ownership map by city. */
export function groupCityOwners(
  owner: Readonly<Record<string, number>>,
  cityByProperty: ReadonlyMap<string, string>,
): CityOwnerGroup[] {
  const groups = new Map<string, Map<number, number>>();
  for (const [propertyId, playerId] of Object.entries(owner)) {
    if (!Number.isInteger(playerId) || playerId < 0) continue;
    const cityId = cityByProperty.get(propertyId);
    if (!cityId) continue;
    const counts = groups.get(cityId) ?? new Map<number, number>();
    counts.set(playerId, (counts.get(playerId) ?? 0) + 1);
    groups.set(cityId, counts);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([cityId, counts]) => ({
      cityId,
      owners: [...counts.entries()]
        .map(([playerId, count]) => ({ playerId, count }))
        .sort((a, b) => b.count - a.count || a.playerId - b.playerId),
    }));
}

export interface CitySearchEntry {
  id: string;
  nameJa: string;
  nameKana?: string;
  nameEn: string;
  countryJa: string;
}

function normalizeQuery(query: string): string {
  return query.trim().toLowerCase().replace(/[\s　]+/g, '');
}

/** Case/kana-insensitive city filter for the map screen search box. Empty query matches nothing. */
export function filterCities<T extends CitySearchEntry>(cities: readonly T[], query: string, limit = 8): T[] {
  const needle = normalizeQuery(query);
  if (!needle) return [];
  const hits: T[] = [];
  for (const city of cities) {
    const haystack = normalizeQuery(
      `${city.nameJa}${city.nameKana ?? ''}${city.nameEn}${city.countryJa}${city.id}`,
    );
    if (!haystack.includes(needle)) continue;
    hits.push(city);
    if (hits.length >= limit) break;
  }
  return hits;
}

export interface CityModSummary {
  cityId: string;
  count: number;
  mult: number;
  kind: CityModState['kind'];
  labels: string[];
}

/** Collapse several active effects on one city into one map marker. */
export function summarizeCityMods(mods: readonly CityModState[]): CityModSummary[] {
  const byCity = new Map<string, CityModSummary>();
  for (const mod of mods) {
    if (mod.yearsLeft <= 0) continue;
    const existing = byCity.get(mod.cityId);
    if (!existing) {
      byCity.set(mod.cityId, {
        cityId: mod.cityId,
        count: 1,
        mult: mod.mult,
        kind: mod.kind,
        labels: [mod.label],
      });
      continue;
    }
    existing.count += 1;
    existing.mult *= mod.mult;
    if (mod.kind === 'damage' || mod.kind === 'blockade') existing.kind = mod.kind;
    existing.labels.push(mod.label);
  }
  return [...byCity.values()].sort((a, b) => (a.cityId < b.cityId ? -1 : a.cityId > b.cityId ? 1 : 0));
}