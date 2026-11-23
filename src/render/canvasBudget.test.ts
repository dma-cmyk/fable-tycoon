import { describe, expect, it } from 'vitest';
import {
  canvasBudgetFor,
  clampDpr,
  fitBackingStore,
  fitCanvasSize,
  fitRaster,
  type CanvasBudget,
} from './canvasBudget';

const desktop: CanvasBudget = canvasBudgetFor({ mobile: false, webkit: false });
const iphone: CanvasBudget = canvasBudgetFor({ mobile: true, webkit: true });
const pixel: CanvasBudget = canvasBudgetFor({ mobile: true, webkit: false });

describe('canvas budget', () => {
  it('uses conservative DPR and area limits on phones', () => {
    expect(iphone.maxDpr).toBe(1.5);
    expect(iphone.maxArea).toBe(16_000_000);
    expect(iphone.maxSide).toBe(4096);
    expect(pixel.maxDpr).toBe(1.5);
    expect(pixel.maxArea).toBe(16_000_000);
    expect(clampDpr(3, iphone)).toBe(1.5);
    expect(clampDpr(2.625, pixel)).toBe(1.5);
    expect(clampDpr(3, desktop)).toBe(2);
  });

  it('fits a phone backing store below its area budget', () => {
    const fit = fitBackingStore(390, 664, 3, iphone);
    expect(fit.scale).toBeCloseTo(1.5, 5);
    expect(fit.width).toBe(585);
    expect(fit.height).toBe(996);
    expect(fit.width * fit.height).toBeLessThanOrEqual(iphone.maxArea);
    expect(fit.width).toBeLessThanOrEqual(iphone.maxSide);
  });

  it('shrinks oversized canvases by both side and area', () => {
    const fit = fitCanvasSize(20_000, 20_000, desktop);
    expect(fit.width * fit.height).toBeLessThanOrEqual(desktop.maxArea);
    expect(fit.width).toBeLessThanOrEqual(desktop.maxSide);
    expect(fit.height).toBeLessThanOrEqual(desktop.maxSide);
    expect(fit.clamped).toBe(true);
  });

  it('never lets the land raster exceed the phone/WebKit budget', () => {
    const fit = fitRaster(8192, 3817, 3, iphone);
    expect(fit.width).toBeLessThanOrEqual(iphone.maxSide);
    expect(fit.height).toBeLessThanOrEqual(iphone.maxSide);
    expect(fit.width * fit.height).toBeLessThanOrEqual(iphone.maxArea);
    expect(fit.scale).toBeLessThan(3);
    expect(fit.clamped).toBe(true);
  });

  it('keeps desktop whole-world caches within 32MP', () => {
    const fit = fitRaster(8192, 3817, 3, desktop);
    expect(fit.width * fit.height).toBeLessThanOrEqual(desktop.maxArea);
    expect(fit.width).toBeLessThanOrEqual(desktop.maxSide);
  });
});