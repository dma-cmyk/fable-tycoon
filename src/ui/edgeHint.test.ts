import { describe, expect, it } from 'vitest';
import { isPointOutsideBox, placeEdgeHint, type EdgeHintBox } from './edgeHint';

const box: EdgeHintBox = { left: 100, top: 50, right: 500, bottom: 450 };
const chip = { width: 56, height: 56 };

describe('placeEdgeHint', () => {
  it('pins a target to the right edge with a rightward arrow', () => {
    const hit = placeEdgeHint({ ...chip, box, dx: 400, dy: 0 });
    expect(hit).not.toBeNull();
    expect(hit!.edge).toBe('right');
    expect(hit!.x).toBe(500 - 8 - chip.width / 2);
    expect(hit!.y).toBe(250);
    expect(hit!.angle).toBeCloseTo(0, 5);
  });

  it('pins a target above the box to the top edge with an upward arrow', () => {
    const hit = placeEdgeHint({ ...chip, box, dx: 0, dy: -400 });
    expect(hit!.edge).toBe('top');
    expect(hit!.y).toBe(50 + 8 + chip.height / 2);
    expect(hit!.x).toBe(300);
    expect(hit!.angle).toBeCloseTo(-Math.PI / 2, 5);
  });

  it('keeps every chip centre inside the inset box and points at the target', () => {
    for (const [dx, dy] of [
      [400, 400],
      [-400, -400],
      [-400, 400],
      [400, -400],
      [10, 400],
      [-10, -400],
    ]) {
      const hit = placeEdgeHint({ ...chip, box, dx, dy });
      expect(hit).not.toBeNull();
      expect(hit!.x).toBeGreaterThanOrEqual(box.left + 8 + chip.width / 2 - 1e-6);
      expect(hit!.x).toBeLessThanOrEqual(box.right - 8 - chip.width / 2 + 1e-6);
      expect(hit!.y).toBeGreaterThanOrEqual(box.top + 8 + chip.height / 2 - 1e-6);
      expect(hit!.y).toBeLessThanOrEqual(box.bottom - 8 - chip.height / 2 + 1e-6);
      expect(Math.cos(hit!.angle) * dx + Math.sin(hit!.angle) * dy).toBeGreaterThan(0);
    }
  });

  it('honours the requested margin', () => {
    const hit = placeEdgeHint({ ...chip, box, dx: 400, dy: 0, margin: 24 });
    expect(hit!.x).toBe(500 - 24 - chip.width / 2);
  });

  it('returns null for a degenerate direction or a box smaller than the chip', () => {
    expect(placeEdgeHint({ ...chip, box, dx: 0, dy: 0 })).toBeNull();
    expect(placeEdgeHint({ ...chip, box, dx: 0.1, dy: 0 })).toBeNull();
    expect(placeEdgeHint({ ...chip, box: { left: 0, top: 0, right: 40, bottom: 40 }, dx: 100, dy: 0 })).toBeNull();
  });
});

describe('isPointOutsideBox', () => {
  it('detects points beyond any side and inside the inset', () => {
    expect(isPointOutsideBox(box, 300, 250)).toBe(false);
    expect(isPointOutsideBox(box, 99, 250)).toBe(true);
    expect(isPointOutsideBox(box, 501, 250)).toBe(true);
    expect(isPointOutsideBox(box, 300, 49)).toBe(true);
    expect(isPointOutsideBox(box, 300, 451)).toBe(true);
    expect(isPointOutsideBox(box, 110, 250, 20)).toBe(true);
    expect(isPointOutsideBox(box, 130, 250, 20)).toBe(false);
  });
});