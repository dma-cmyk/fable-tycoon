// Deterministic, JSON-serialisable RNG (mulberry32).
// The engine never uses Math.random / Date.now: the only entropy is `state.rng`.

export interface RngHolder {
  rng: number;
}

/** Advances the mulberry32 state in place and returns a float in [0, 1). */
export function nextRandom(holder: RngHolder): number {
  let a = holder.rng >>> 0;
  a = (a + 0x6d2b79f5) >>> 0;
  holder.rng = a;
  let t = a;
  t = Math.imul(t ^ (t >>> 15), 1 | t);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Inclusive integer range. */
export function randInt(holder: RngHolder, min: number, max: number): number {
  if (max < min) throw new Error(`randInt: empty range ${min}..${max}`);
  return min + Math.floor(nextRandom(holder) * (max - min + 1));
}

export function pickOne<T>(holder: RngHolder, items: readonly T[]): T {
  if (items.length === 0) throw new Error('pickOne: empty array');
  return items[Math.floor(nextRandom(holder) * items.length)];
}

/** Weighted pick; zero/negative weights are ignored. Returns null when nothing is pickable. */
export function weightedPick<T>(
  holder: RngHolder,
  items: readonly T[],
  weightOf: (item: T) => number,
): T | null {
  let total = 0;
  for (const item of items) {
    const w = weightOf(item);
    if (w > 0) total += w;
  }
  if (total <= 0) return null;
  let r = nextRandom(holder) * total;
  for (const item of items) {
    const w = weightOf(item);
    if (w <= 0) continue;
    r -= w;
    if (r < 0) return item;
  }
  // Floating-point tail: return the last positively weighted item.
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (weightOf(items[i]) > 0) return items[i];
  }
  return null;
}

/** Fisher-Yates on a copy. */
export function shuffled<T>(holder: RngHolder, items: readonly T[]): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(nextRandom(holder) * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}