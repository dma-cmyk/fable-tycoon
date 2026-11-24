import { describe, expect, it } from 'vitest';
import {
  LabelFade,
  pickFreeSlot,
  placeLabels,
  rectsOverlap,
  spotlightHoles,
  spreadBadges,
  zoomBucket,
  bucketZoom,
  type LabelItem,
  type PlacementScene,
} from './labels';

const emptyScene = (over: Partial<PlacementScene> = {}): PlacementScene => ({
  worldW: 8192,
  wrap: true,
  occupied: [],
  discs: [],
  segments: [],
  clearance: 2,
  reach: 640,
  ...over,
});

const slotsRightLeft = [
  { dx: 60, dy: 0 },
  { dx: -60, dy: 0 },
  { dx: 0, dy: -46 },
];

const item = (over: Partial<LabelItem> = {}): LabelItem => ({
  id: 'a',
  x: 1000,
  y: 1000,
  w: 40,
  h: 20,
  slots: slotsRightLeft,
  disc: 12,
  ...over,
});

describe('zoomBucket', () => {
  it('keeps one bucket across a small pan/zoom wobble', () => {
    const ref = bucketZoom(zoomBucket(2));
    expect(zoomBucket(ref * 1.04)).toBe(zoomBucket(ref * 0.96));
  });

  it('maps every zoom close to its bucket reference zoom', () => {
    for (const zoom of [0.12, 0.5, 0.92, 1.5, 2.4]) {
      const ratio = bucketZoom(zoomBucket(zoom)) / zoom;
      expect(ratio).toBeGreaterThan(0.92);
      expect(ratio).toBeLessThan(1.09);
    }
    expect(zoomBucket(1.0)).not.toBe(zoomBucket(1.5));
  });
});

describe('LabelFade', () => {
  it('does not blink for an occlusion shorter than the hold window', () => {
    const fade = new LabelFade(300, 160);
    expect(fade.update('x', true, 1000)).toBe(1);
    // A token sweeps across for 240ms, then clears.
    expect(fade.update('x', false, 1100)).toBe(1);
    expect(fade.update('x', false, 1240)).toBe(1);
    expect(fade.update('x', true, 1260)).toBe(1);
    expect(fade.update('x', true, 1500)).toBe(1);
  });

  it('hides after the hold window and fades back in', () => {
    const fade = new LabelFade(300, 160);
    expect(fade.update('x', true, 0)).toBe(1);
    expect(fade.update('x', false, 100)).toBe(1);
    expect(fade.update('x', false, 350)).toBe(1); // hold not elapsed yet
    expect(fade.update('x', false, 410)).toBeLessThan(1); // committed at 400
    expect(fade.update('x', false, 700)).toBe(0);
    expect(fade.update('x', true, 720)).toBe(0);
    expect(fade.update('x', true, 1100)).toBeGreaterThan(0);
    expect(fade.update('x', true, 1400)).toBe(1);
  });

  it('starts hidden labels hidden without a fade-in flash', () => {
    const fade = new LabelFade(300, 160);
    expect(fade.update('offstage', false, 0)).toBe(0);
    expect(fade.update('offstage', false, 100)).toBe(0);
  });

  it('prunes stale latches', () => {
    const fade = new LabelFade(300, 160);
    fade.update('a', true, 0);
    fade.update('b', true, 0);
    fade.pruneAlive(new Set(['a']));
    expect(fade.update('b', false, 10)).toBe(0);
  });
});

describe('placeLabels', () => {
  it('is deterministic for the same static scene', () => {
    const scene = emptyScene({
      discs: [{ x: 1060, y: 1000, r: 18 }],
      segments: [{ ax: 900, ay: 1030, bx: 1200, by: 1030 }],
    });
    const items = [item(), item({ id: 'b', x: 1400 })];
    const a = placeLabels(scene, items);
    const b = placeLabels(scene, items);
    expect([...a.entries()]).toEqual([...b.entries()]);
  });

  it('moves a later label to another slot instead of stacking', () => {
    const scene = emptyScene();
    const items = [item(), item({ id: 'b' })];
    const out = placeLabels(scene, items);
    expect(out.get('a')).toBe(0);
    // Both candidates sit on the same anchor: b cannot reuse a's box.
    expect(out.get('b')).toBeGreaterThan(0);
    expect(out.get('b')).toBeLessThan(item().slots.length);
  });

  it('treats obstacles across the wrap seam as adjacent', () => {
    const scene = emptyScene({
      discs: [{ x: 30, y: 1000, r: 40 }],
      reach: 200,
    });
    const seam = item({ x: 8192 - 30, slots: [{ dx: 30, dy: 0 }] });
    const out = placeLabels(scene, [seam]);
    expect(out.get('seam-missing')).toBeUndefined();
    expect(out.get('a')).toBe(-1);

    const clear = placeLabels(scene, [item({ x: 8192 - 30, slots: [{ dx: -60, dy: 0 }] })]);
    expect(clear.get('a')).toBe(0);
  });

  it('allows a label centred on its anchor when it owns no marker disc', () => {
    const scene = emptyScene();
    const out = placeLabels(scene, [item({ slots: [{ dx: 0, dy: 0 }], disc: 0 })]);
    expect(out.get('a')).toBe(0);
  });

  it('reports -1 when no slot is collision free', () => {
    const scene = emptyScene({ segments: [{ ax: 0, ay: 1000, bx: 2000, by: 1000 }] });
    const out = placeLabels(scene, [item({ slots: [{ dx: 0, dy: 0 }] })]);
    expect(out.get('a')).toBe(-1);
  });

  it('keeps boxes off the given marker discs', () => {
    const scene = emptyScene({ discs: [{ x: 1060, y: 1000, r: 18 }] });
    const out = placeLabels(scene, [item()]);
    expect(out.get('a')).toBe(1);
    const chosen = slotsRightLeft[1];
    const rect = { x: 1000 + chosen.dx - 20, y: 1000 + chosen.dy - 10, w: 40, h: 20 };
    expect(rectsOverlap(rect, { x: 1060 - 18, y: 1000 - 18, w: 36, h: 36 }, 2)).toBe(false);
  });
});
describe('pickFreeSlot', () => {
  const slots = [
    { dx: 0, dy: 0 },
    { dx: 40, dy: 0 },
    { dx: 0, dy: 40 },
  ];

  it('keeps the first slot when nothing blocks it', () => {
    expect(pickFreeSlot(100, 100, 20, 20, slots, [])).toEqual(slots[0]);
  });

  it('steps to the next slot when a blocker covers the first', () => {
    const blocker = { x: 90, y: 90, w: 20, h: 20 };
    expect(pickFreeSlot(100, 100, 20, 20, slots, [blocker])).toEqual(slots[1]);
  });

  it('returns null when every slot is blocked or outside the board', () => {
    const blocker = { x: 0, y: 0, w: 400, h: 400 };
    expect(pickFreeSlot(100, 100, 20, 20, slots, [blocker])).toBeNull();
  });

  it('skips slots that leave the board', () => {
    const inside = (r: { x: number; y: number; w: number; h: number }): boolean => r.x >= 0 && r.y >= 0 && r.x + r.w <= 120;
    expect(pickFreeSlot(100, 100, 20, 20, slots, [], inside)).toEqual(slots[0]);
    // Only the slot shifted right clears x = 100 on a narrow board.
    const tight = (r: { x: number; y: number; w: number; h: number }): boolean => r.x >= 100;
    expect(pickFreeSlot(100, 100, 20, 20, slots, [], tight)).toEqual(slots[1]);
  });

  it('moves city label off the selected move route polyline (#7)', () => {
    // Horizontal selected gold route running across y = 100 through x = 50..200.
    const route = [{ ax: 50, ay: 100, bx: 200, by: 100 }];
    const candidateSlots = [
      { dx: 0, dy: 0 }, // sits directly on the route
      { dx: 40, dy: 0 }, // also on the horizontal route
      { dx: 0, dy: 40 }, // safely below the route
    ];
    expect(pickFreeSlot(100, 100, 36, 18, candidateSlots, [], undefined, 2, route, 10)).toEqual(candidateSlots[2]);
  });
});

describe('spreadBadges', () => {
  it('pushes neighbours to the minimum gap along one axis', () => {
    expect(spreadBadges([10, 12, 20], 42, 0, 400)).toEqual([10, 52, 94]);
  });

  it('keeps the upper bound by backing the group down', () => {
    const out = spreadBadges([100, 105, 108], 42, 0, 150);
    expect(out[out.length - 1]).toBeLessThanOrEqual(150);
    for (let i = 1; i < out.length; i += 1) expect(out[i] - out[i - 1]).toBeGreaterThanOrEqual(42 - 1e-9);
  });

  it('never leaves two badges on the same point', () => {
    const out = spreadBadges([50, 50, 50], 42, 0, 400);
    expect(new Set(out).size).toBe(3);
    expect(out).toEqual([50, 92, 134]);
  });

  it('clamps and passes through single values', () => {
    expect(spreadBadges([], 42, 0, 100)).toEqual([]);
    expect(spreadBadges([120], 42, 0, 100)).toEqual([100]);
  });
});

describe('spotlightHoles', () => {
  it('lists the actor first, then every candidate', () => {
    const holes = spotlightHoles({ x: 10, y: 20 }, [{ x: 30, y: 40 }, { x: 50, y: 60 }], 40, 30);
    expect(holes).toEqual([
      { x: 10, y: 20, r: 40 },
      { x: 30, y: 40, r: 30 },
      { x: 50, y: 60, r: 30 },
    ]);
  });

  it('handles a missing actor and overlapping candidates', () => {
    const holes = spotlightHoles(null, [{ x: 0, y: 0 }, { x: 1, y: 1 }], 40, 30);
    expect(holes).toHaveLength(2);
    expect(holes.every((h) => h.r === 30)).toBe(true);
  });
});

describe('badge spread across a shared edge', () => {
  it('keeps the minimum gap when three badges clamp to the same corner', () => {
    const out = spreadBadges([26, 26, 26], 42, 26, 694);
    expect(new Set(out).size).toBe(3);
    for (let i = 1; i < out.length; i += 1) expect(out[i] - out[i - 1]).toBeGreaterThanOrEqual(42 - 1e-9);
  });

  it('spreads evenly when the run cannot hold the requested gap', () => {
    const out = spreadBadges([10, 11, 12, 13, 14, 15], 42, 26, 200);
    expect(out[0]).toBeGreaterThanOrEqual(26 - 1e-9);
    expect(out[out.length - 1]).toBeLessThanOrEqual(200 + 1e-9);
    // Six badges need 210px but only 174px exist: fall back to even spacing,
    // still ordered and never coincident.
    for (let i = 1; i < out.length; i += 1) expect(out[i]).toBeGreaterThan(out[i - 1]);
    expect(out[1] - out[0]).toBeCloseTo((200 - 26) / 5, 5);
  });
});

describe('priority label freeze', () => {
  it('shows why the map caches slots while a token walks', () => {
    // First slot (right of the anchor) is free, so it is used.
    const slots = [{ dx: 30, dy: 0 }, { dx: -30, dy: 0 }];
    const first = pickFreeSlot(100, 100, 20, 20, slots, [{ x: 60, y: 90, w: 20, h: 20 }]);
    expect(first).toEqual(slots[0]);
    // Same blockers plus a token under the chosen slot: a fresh evaluation has
    // no free slot at all, which is exactly why the map must reuse `first`
    // instead of re-running this while an animation is in flight.
    const reEvaluated = pickFreeSlot(
      100, 100, 20, 20, slots,
      [{ x: 60, y: 90, w: 20, h: 20 }, { x: 120, y: 90, w: 20, h: 20 }],
    );
    expect(reEvaluated).toBeNull();
  });
});
