import { describe, expect, it } from 'vitest';
import type { CityModState } from '../core/types';
import {
  filterCities,
  groupCityOwners,
  summarizeCityMods,
  type CitySearchEntry,
} from './mapScreenData';

describe('groupCityOwners', () => {
  const cityByProperty = new Map([
    ['tokyo_a', 'tokyo'],
    ['tokyo_b', 'tokyo'],
    ['tokyo_c', 'tokyo'],
    ['paris_a', 'paris'],
    ['lima_a', 'lima'],
  ]);

  it('groups holdings by city and sorts owners by count', () => {
    const groups = groupCityOwners(
      { tokyo_a: 1, tokyo_b: 2, tokyo_c: 2, paris_a: 0, lima_a: 2 },
      cityByProperty,
    );
    expect(groups.map((group) => group.cityId)).toEqual(['lima', 'paris', 'tokyo']);
    expect(groups.find((group) => group.cityId === 'tokyo')!.owners).toEqual([
      { playerId: 2, count: 2 },
      { playerId: 1, count: 1 },
    ]);
  });

  it('ignores unknown properties and invalid owners', () => {
    const groups = groupCityOwners(
      { missing: 0, tokyo_a: -1, tokyo_b: 3, tokyo_c: Number.NaN },
      cityByProperty,
    );
    expect(groups).toEqual([{ cityId: 'tokyo', owners: [{ playerId: 3, count: 1 }] }]);
  });

  it('returns an empty list with no ownership', () => {
    expect(groupCityOwners({}, cityByProperty)).toEqual([]);
  });
});

describe('filterCities', () => {
  const cities: CitySearchEntry[] = [
    { id: 'tokyo', nameJa: '東京', nameKana: 'とうきょう', nameEn: 'Tokyo', countryJa: '日本' },
    { id: 'kyoto', nameJa: '京都', nameKana: 'きょうと', nameEn: 'Kyoto', countryJa: '日本' },
    { id: 'paris', nameJa: 'パリ', nameEn: 'Paris', countryJa: 'フランス' },
  ];

  it('matches Japanese names, kana, English names, countries and ids', () => {
    expect(filterCities(cities, '東京').map((city) => city.id)).toEqual(['tokyo']);
    expect(filterCities(cities, 'きょうと').map((city) => city.id)).toEqual(['kyoto']);
    expect(filterCities(cities, 'PARIS').map((city) => city.id)).toEqual(['paris']);
    expect(filterCities(cities, '日本').map((city) => city.id)).toEqual(['tokyo', 'kyoto']);
    expect(filterCities(cities, 'kyo').map((city) => city.id)).toEqual(['tokyo', 'kyoto']);
  });

  it('ignores surrounding and inner whitespace in the query', () => {
    expect(filterCities(cities, ' と う き ょ う ').map((city) => city.id)).toEqual(['tokyo']);
  });

  it('returns nothing for an empty query and caps the result count', () => {
    expect(filterCities(cities, '   ')).toEqual([]);
    expect(filterCities(cities, 'o', 1).map((city) => city.id)).toEqual(['tokyo']);
  });
});

describe('summarizeCityMods', () => {
  function mod(cityId: string, mult: number, kind: CityModState['kind'], yearsLeft = 1): CityModState {
    return { cityId, mult, kind, yearsLeft, label: `${kind}` };
  }

  it('multiplies stacked effects and keeps a disaster kind', () => {
    const summary = summarizeCityMods([
      mod('tokyo', 1.2, 'boom'),
      mod('tokyo', 0.5, 'damage'),
      mod('paris', 1.4, 'bubble'),
    ]);
    expect(summary.map((entry) => entry.cityId)).toEqual(['paris', 'tokyo']);
    const tokyo = summary.find((entry) => entry.cityId === 'tokyo')!;
    expect(tokyo.count).toBe(2);
    expect(tokyo.mult).toBeCloseTo(0.6, 6);
    expect(tokyo.kind).toBe('damage');
    expect(tokyo.labels).toEqual(['boom', 'damage']);
  });

  it('drops expired effects', () => {
    expect(summarizeCityMods([mod('tokyo', 2, 'boom', 0)])).toEqual([]);
  });
});