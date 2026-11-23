import { describe, expect, it } from 'vitest';
import { GAME_DATA } from '../data/index';
import type { CharacterFilterState } from './charFilter';
import { filterCharacters, hasActiveFilters, perkGroupOf, regionGroupOf } from './charFilter';

const ALL: CharacterFilterState = {
  query: '',
  region: 'all',
  role: 'all',
  perkGroup: 'all',
  availableOnly: false,
};

const chars = GAME_DATA.characters;

describe('character filter', () => {
  it('maps 日本 to japan and counts 11', () => {
    expect(chars.filter((character) => regionGroupOf(character.originRegion) === 'japan')).toHaveLength(11);
    expect(filterCharacters(chars, { ...ALL, region: 'japan' })).toHaveLength(11);
  });

  it('filters 日本 + animal to 4', () => {
    expect(filterCharacters(chars, { ...ALL, region: 'japan', role: 'animal' })).toHaveLength(4);
  });

  it('maps every character to exactly one region group', () => {
    for (const character of chars) {
      const matches = (['japan', 'europe', 'asia_me_africa'] as const).filter(
        (group) => regionGroupOf(character.originRegion) === group,
      );
      expect(matches).toHaveLength(1);
    }
  });

  it('maps every non-none perk to a group', () => {
    for (const character of chars) {
      if (character.perk === 'none') continue;
      expect(perkGroupOf(character.perk)).not.toBeNull();
    }
  });

  it('availableOnly drops taken characters', () => {
    const taken = new Set([chars[0].id]);
    expect(filterCharacters(chars, { ...ALL, availableOnly: true }, taken)).toHaveLength(chars.length - 1);
    expect(filterCharacters(chars, { ...ALL, availableOnly: true }).find((c) => c.id === chars[0].id)).toBeDefined();
  });

  it('reports active filters', () => {
    expect(hasActiveFilters(ALL)).toBe(false);
    expect(hasActiveFilters({ ...ALL, query: '桃' })).toBe(true);
    expect(hasActiveFilters({ ...ALL, availableOnly: true })).toBe(true);
  });
});
