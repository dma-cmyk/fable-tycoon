import { describe, expect, it } from 'vitest';
import {
  LabelFade,
  placeLabels,
  rectsOverlap,
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