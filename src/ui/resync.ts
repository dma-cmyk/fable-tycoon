/**
 * Snapshot re-adoption policy.
 *
 * A resync snapshot carries the same (gen, seq) as the state the screen already shows.
 * Re-adopting an identical state must not interrupt a running cutscene (voice, dice,
 * move animation); only a diverged state or a new generation may cancel playback.
 */

export interface ResyncWatermark {
  gen: number;
  seq: number;
  state: unknown;
}

/** Deterministic JSON with sorted keys, so equal states compare equal regardless of key order. */
export function canonicalState(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) out[key] = canonicalize(record[key]);
    return out;
  }
  return value;
}

/** True when adopting `next` must cancel in-flight fx (new generation, new seq, or diverged state). */
export function shouldInterruptForResync(previous: ResyncWatermark | null, next: ResyncWatermark): boolean {
  if (!previous) return false; // first adoption: nothing is playing yet
  if (next.gen !== previous.gen) return true;
  if (next.seq !== previous.seq) return true;
  return canonicalState(previous.state) !== canonicalState(next.state);
}

/** True when the resync snapshot is exactly what the screen already shows. */
export function isIdenticalResync(previous: ResyncWatermark | null, next: ResyncWatermark): boolean {
  return previous !== null && !shouldInterruptForResync(previous, next);
}
