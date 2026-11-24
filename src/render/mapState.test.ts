import { describe, expect, it } from 'vitest';
import {
  computeFreeBoardBox,
  isCandidateRingVisible,
  resolveCancelledToken,
  shouldCancelForSnapshot,
} from './mapState';

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

describe('computeFreeBoardBox and candidate ring visibility (#6)', () => {
  it('excludes both top ranking strip and bottom move-options tray on 844x390 landscape', () => {
    const safeArea = { top: 90, right: 0, bottom: 138, left: 0 };
    const obstacles = [
      { x: 0, y: 0, w: 844, h: 44 },
      { x: 6, y: 46, w: 185, h: 38 },
      { x: 6, y: 258, w: 832, h: 72 },
      { x: 6, y: 335, w: 832, h: 51 },
    ];
    const box = computeFreeBoardBox(844, 390, safeArea, obstacles);
    expect(box.y).toBeGreaterThanOrEqual(86);
    expect(box.y + box.h).toBeLessThanOrEqual(256);
    expect(box.h).toBeGreaterThanOrEqual(120);

    // Candidate behind move-options tray is rejected so it renders as an edge badge instead.
    expect(isCandidateRingVisible(420, 275, box, 25)).toBe(false);
    // Candidate half-overlapping the top edge of move-options is also rejected.
    expect(isCandidateRingVisible(420, 245, box, 25)).toBe(false);
    // Candidate behind the top ranking strip is rejected.
    expect(isCandidateRingVisible(100, 75, box, 25)).toBe(false);
    // Candidate centered in the unobstructed band is visible.
    expect(isCandidateRingVisible(420, 170, box, 25)).toBe(true);
  });

  it('keeps the full unobstructed viewport on 390x844 portrait with move-options open', () => {
    const safeArea = { top: 136, right: 0, bottom: 235, left: 0 };
    const obstacles = [
      { x: 0, y: 0, w: 390, h: 82 },
      { x: 6, y: 84, w: 378, h: 46 },
      { x: 6, y: 615, w: 378, h: 108 },
      { x: 6, y: 728, w: 378, h: 112 },
    ];
    const box = computeFreeBoardBox(390, 844, safeArea, obstacles);
    expect(box.y).toBeGreaterThanOrEqual(132);
    expect(box.y + box.h).toBeLessThanOrEqual(613);
    expect(isCandidateRingVisible(195, 630, box, 25)).toBe(false);
    expect(isCandidateRingVisible(195, 360, box, 25)).toBe(true);
  });
});
