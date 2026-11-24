import { describe, expect, it } from 'vitest';
import { placeDestinationArrow, type ArrowRect } from './destArrow';

const BOX: ArrowRect = { left: 10, top: 60, right: 1270, bottom: 500 };
const PORTRAIT: ArrowRect = { left: 6, top: 420, right: 100, bottom: 700 };
const MINIMAP: ArrowRect = { left: 1090, top: 380, right: 1270, bottom: 500 };
const MONEY: ArrowRect = { left: 1000, top: 470, right: 1270, bottom: 700 };

function overlaps(a: ArrowRect, b: ArrowRect): boolean {
  return !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);
}

function rectAt(x: number, y: number, mx = 30, my = 26): ArrowRect {
  return { left: x - mx, right: x + mx, top: y - my, bottom: y + my };
}

describe('placeDestinationArrow', () => {
  it('places the arrow inside the free board box', () => {
    const placed = placeDestinationArrow({
      width: 1280,
      height: 720,
      box: BOX,
      blockers: [],
      dx: -1,
      dy: 0,
    });
    expect(placed).not.toBeNull();
    if (!placed) return;
    expect(placed.x).toBeGreaterThan(BOX.left);
    expect(placed.x).toBeLessThan(BOX.right);
    expect(placed.y).toBeGreaterThan(BOX.top);
    expect(placed.y).toBeLessThan(BOX.bottom);
    expect(placed.angle).toBeCloseTo(Math.PI, 5);
  });

  it('never overlaps the HUD blockers', () => {
    const blockers = [PORTRAIT, MINIMAP, MONEY];
    for (const [dx, dy] of [[1, 0], [-1, 0], [1, 1], [-1, 1], [0, 1], [-1, -1], [1, -1]]) {
      const placed = placeDestinationArrow({ width: 1280, height: 720, box: BOX, blockers, dx, dy });
      expect(placed).not.toBeNull();
      if (!placed) continue;
      const rect = rectAt(placed.x, placed.y);
      for (const blocker of blockers) expect(overlaps(rect, blocker)).toBe(false);
    }
  });

  it('returns null when the free area is missing or too small', () => {
    expect(placeDestinationArrow({ width: 1280, height: 720, box: null, blockers: [], dx: 1, dy: 0 })).toBeNull();
    expect(
      placeDestinationArrow({ width: 1280, height: 720, box: { left: 0, top: 0, right: 60, bottom: 60 }, blockers: [], dx: 1, dy: 0 }),
    ).toBeNull();
  });

  it('ignores a zero direction vector', () => {
    expect(placeDestinationArrow({ width: 1280, height: 720, box: BOX, blockers: [], dx: 0, dy: 0 })).toBeNull();
  });

  it('keeps the angle pointing at the target', () => {
    const down = placeDestinationArrow({ width: 1280, height: 720, box: BOX, blockers: [], dx: 0, dy: 1 });
    expect(down?.angle).toBeCloseTo(Math.PI / 2, 5);
    const upRight = placeDestinationArrow({ width: 1280, height: 720, box: BOX, blockers: [], dx: 1, dy: -1 });
    expect(upRight?.angle).toBeCloseTo(-Math.PI / 4, 5);
  });
});