import type { Character } from '../core/types';
import { filterCharacters, type CharacterFilterState } from './charFilter';

/** Injectable randomness so tests can pin every draw. */
export type Rng = () => number;

/** Random index in [0, length), or -1 for an empty range. */
export function randomIndex(length: number, rng: Rng = Math.random): number {
  if (length <= 0) return -1;
  const value = rng();
  const clamped = Number.isFinite(value) ? Math.min(0.999999999, Math.max(0, value)) : 0;
  return Math.floor(clamped * length);
}

export function pickRandom<T>(pool: readonly T[], rng: Rng = Math.random): T | null {
  const index = randomIndex(pool.length, rng);
  return index >= 0 ? pool[index] ?? null : null;
}

/** Random character that satisfies the current filters and avoids the taken ids. */
export function randomCharacter(
  characters: readonly Character[],
  filters: CharacterFilterState,
  taken: ReadonlySet<string> = new Set<string>(),
  rng: Rng = Math.random,
): Character | null {
  // `taken` only drives the 「空いているキャラだけ」 chip inside filterCharacters,
  // so exclusions must be applied here unconditionally.
  const pool = filterCharacters(characters, filters).filter((character) => !taken.has(character.id));
  return pickRandom(pool, rng);
}

/**
 * Picks `count` distinct ids out of `pool`, never reusing an id in `excluded`.
 * Returns fewer ids only when the pool is too small. Order is the drawn order.
 */
export function assignDistinctIds(
  pool: readonly string[],
  count: number,
  excluded: ReadonlySet<string> = new Set<string>(),
  rng: Rng = Math.random,
): string[] {
  const available = [...new Set(pool)].filter((id) => !excluded.has(id));
  const picked: string[] = [];
  const want = Math.max(0, Math.min(count, available.length));
  for (let slot = 0; slot < want; slot += 1) {
    const index = slot + randomIndex(available.length - slot, rng);
    const swap = available[slot];
    available[slot] = available[index];
    available[index] = swap;
    picked.push(available[slot]);
  }
  return picked;
}