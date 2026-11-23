import { describe, expect, it } from 'vitest';
import { resolveCancelledToken, shouldCancelForSnapshot } from './mapState';

describe('setState animation reconciliation', () => {
  it('keeps the authoritative snapshot node when a mismatched animation is cancelled', () => {
    const snapshot = 'c:tokyo';
    const staleEnd = 'c:osaka';
    expect(shouldCancelForSnapshot(staleEnd, snapshot)).toBe(true);
    expect(resolveCancelledToken(snapshot, staleEnd, false)).toBe(snapshot);
  });

  it('uses the animation end only when cancellation explicitly applies it', () => {
    expect(resolveCancelledToken('c:tokyo', 'c:osaka', true)).toBe('c:osaka');
  });

  it('does not cancel when the snapshot already equals the animation end', () => {
    expect(shouldCancelForSnapshot('c:osaka', 'c:osaka')).toBe(false);
  });

  it('cancels and preserves an empty snapshot when the player disappeared', () => {
    expect(shouldCancelForSnapshot('c:osaka', undefined)).toBe(true);
    expect(resolveCancelledToken(undefined, 'c:osaka', false)).toBeUndefined();
  });
});
