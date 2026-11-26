import { describe, expect, it } from 'vitest';
import { GAME_DATA } from '../data/index';
import type { CharacterFilterState } from './charFilter';
import { filterCharacters } from './charFilter';
import { assignDistinctIds, pickRandom, randomCharacter, randomIndex } from './randomPick';

const ALL: CharacterFilterState = {
  query: '',
  region: 'all',
  role: 'all',
  perkGroup: 'all',
  availableOnly: false,
};

/** Deterministic LCG so every case is reproducible. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

describe('random pick', () => {
  it('clamps rng output into the requested range', () => {
    expect(randomIndex(0)).toBe(-1);
    expect(randomIndex(4, () => 0)).toBe(0);
    expect(randomIndex(4, () => 0.999999)).toBe(3);
    expect(randomIndex(4, () => 1)).toBe(3);
    expect(randomIndex(4, () => -2)).toBe(0);
    expect(randomIndex(4, () => Number.NaN)).toBe(0);
  });

  it('returns null on an empty pool', () => {
    expect(pickRandom([])).toBeNull();
  });

  it('respects filters and exclusions over many draws', () => {
    const rng = seeded(424242);
    const filters: CharacterFilterState = { ...ALL, region: 'japan', role: 'animal' };
    const filtered = filterCharacters(GAME_DATA.characters, filters);
    const excluded = new Set([filtered[0].id]);
    const allowed = filtered.filter((character) => !excluded.has(character.id)).map((character) => character.id);
    expect(allowed).toHaveLength(filtered.length - 1);
    for (let i = 0; i < 200; i += 1) {
      const picked = randomCharacter(GAME_DATA.characters, filters, excluded, rng);
      expect(picked).not.toBeNull();
      expect(allowed).toContain(picked?.id);
      expect(excluded.has(picked?.id ?? '')).toBe(false);
    }
  });

  it('returns null when the filter leaves nothing', () => {
    const filters: CharacterFilterState = { ...ALL, query: '存在しない名前' };
    expect(randomCharacter(GAME_DATA.characters, filters, new Set(), seeded(1))).toBeNull();
  });

  it('assigns distinct ids and never reuses excluded ones', () => {
    const rng = seeded(777);
    const pool = GAME_DATA.characters.map((character) => character.id);
    const excluded = new Set(pool.slice(0, 3));
    for (let run = 0; run < 50; run += 1) {
      const picked = assignDistinctIds(pool, 3, excluded, rng);
      expect(picked).toHaveLength(3);
      expect(new Set(picked).size).toBe(3);
      for (const id of picked) {
        expect(id).toBeTruthy();
        expect(excluded.has(id)).toBe(false);
      }
    }
  });

  it('caps the assignment at the free pool size', () => {
    const picked = assignDistinctIds(['a', 'b', 'c'], 5, new Set(['b']), seeded(9));
    expect(picked).toHaveLength(2);
    expect(picked).not.toContain('b');
    expect(assignDistinctIds(['a'], 0, new Set(), seeded(9))).toEqual([]);
  });
});