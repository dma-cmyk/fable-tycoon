// Shared canvas allocation limits for the map renderer.
//
// Mobile WebKit caps canvas backing stores well below the nominal HTML maximum.
// Keep every renderer-owned canvas inside a conservative side/area budget, and
// record the largest allocation in development so regressions are visible.

export interface CanvasBudget {
  profile: 'mobile' | 'desktop';
  /** Maximum CSS-pixel scale used for the main canvas. */
  maxDpr: number;
  maxSide: number;
  maxArea: number;
  webkit: boolean;
}

export interface BackingStoreFit {
  width: number;
  height: number;
  /** Actual CSS-pixel scale after side/area clamping. */
  scale: number;
  clamped: boolean;
}

export interface RasterFit {
  width: number;
  height: number;
  /** Actual map-units-to-device-pixel scale after clamping. */
  scale: number;
  clamped: boolean;
}

export interface CanvasAllocation {
  label: string;
  width: number;
  height: number;
  area: number;
  requestedWidth: number;
  requestedHeight: number;
  budgetArea: number;
  clamped: boolean;
}

const WEBKIT_MAX_SIDE = 4096;
const DEFAULT_MAX_SIDE = 8192;
const MOBILE_MAX_AREA = 16_000_000;
const DESKTOP_MAX_AREA = 32_000_000;

export interface BudgetFlags {
  mobile: boolean;
  webkit: boolean;
  lowMemory?: boolean;
}

export function canvasBudgetFor(flags: BudgetFlags): CanvasBudget {
  const phone = flags.mobile || !!flags.lowMemory;
  return {
    profile: phone ? 'mobile' : 'desktop',
    maxDpr: phone ? 1.5 : 2,
    maxSide: flags.webkit ? WEBKIT_MAX_SIDE : DEFAULT_MAX_SIDE,
    maxArea: phone || flags.webkit ? MOBILE_MAX_AREA : DESKTOP_MAX_AREA,
    webkit: flags.webkit,
  };
}

export function detectCanvasBudget(): CanvasBudget {
  if (typeof navigator === 'undefined') {
    return canvasBudgetFor({ mobile: false, webkit: false });
  }
  const nav = navigator as Navigator & { deviceMemory?: number };
  const ua = nav.userAgent || '';
  const touch = (nav.maxTouchPoints ?? 0) > 0;
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua) || (touch && coarse);
  const webkit = /AppleWebKit/i.test(ua) && !/Chrome|Chromium|Edg|OPR/i.test(ua);
  const lowMemory = typeof nav.deviceMemory === 'number' && nav.deviceMemory <= 4;
  return canvasBudgetFor({ mobile, webkit, lowMemory });
}

export function clampDpr(dpr: number, budget: CanvasBudget): number {
  return Math.max(1, Math.min(Math.max(1, dpr), budget.maxDpr));
}

/** Fit an arbitrary requested canvas size into the side/area budget. */
export function fitCanvasSize(
  requestedWidth: number,
  requestedHeight: number,
  budget: CanvasBudget,
): BackingStoreFit {
  const width = Math.max(1, Math.ceil(Number.isFinite(requestedWidth) ? requestedWidth : 1));
  const height = Math.max(1, Math.ceil(Number.isFinite(requestedHeight) ? requestedHeight : 1));
  const sideScale = Math.min(1, budget.maxSide / width, budget.maxSide / height);
  const areaScale = Math.min(1, Math.sqrt(budget.maxArea / (width * height)));
  const factor = Math.min(sideScale, areaScale);
  const outW = Math.max(1, Math.floor(width * factor));
  const outH = Math.max(1, Math.floor(height * factor));
  return {
    width: outW,
    height: outH,
    scale: Math.min(outW / width, outH / height),
    clamped: factor < 0.999999,
  };
}

/** Fit a CSS viewport + requested DPR into the backing-store budget. */
export function fitBackingStore(
  cssWidth: number,
  cssHeight: number,
  requestedDpr: number,
  budget: CanvasBudget,
): BackingStoreFit {
  const w = Math.max(1, cssWidth);
  const h = Math.max(1, cssHeight);
  const dpr = clampDpr(Number.isFinite(requestedDpr) ? requestedDpr : 1, budget);
  const fit = fitCanvasSize(Math.round(w * dpr), Math.round(h * dpr), budget);
  return {
    width: fit.width,
    height: fit.height,
    scale: Math.min(fit.width / w, fit.height / h),
    clamped: fit.clamped,
  };
}

/** Fit a world-space raster at `desiredScale`, preferring a lower resolution over a larger canvas. */
export function fitRaster(
  worldWidth: number,
  worldHeight: number,
  desiredScale: number,
  budget: CanvasBudget,
): RasterFit {
  const wWorld = Math.max(1, worldWidth);
  const hWorld = Math.max(1, worldHeight);
  const scale = Math.max(0.0001, Number.isFinite(desiredScale) ? desiredScale : 1);
  const fit = fitCanvasSize(Math.ceil(wWorld * scale), Math.ceil(hWorld * scale), budget);
  return {
    width: fit.width,
    height: fit.height,
    scale: Math.min(scale, fit.width / wWorld, fit.height / hWorld),
    clamped: fit.clamped,
  };
}

interface CanvasLike {
  width: number;
  height: number;
}

let largest: CanvasAllocation | null = null;
const warned = new Set<string>();

export function getLargestCanvasAllocation(): CanvasAllocation | null {
  return largest ? { ...largest } : null;
}

export function resetCanvasBudgetStats(): void {
  largest = null;
  warned.clear();
}

/**
 * Record an allocation and log the current largest canvas. When a caller asks
 * for an oversized canvas, warn once per label rather than allocating blindly.
 */
export function noteCanvasAllocation(
  label: string,
  width: number,
  height: number,
  requestedWidth = width,
  requestedHeight = height,
  budget: CanvasBudget = canvasBudgetFor({ mobile: false, webkit: false }),
): void {
  const area = Math.max(0, width) * Math.max(0, height);
  const requestedArea = Math.max(0, requestedWidth) * Math.max(0, requestedHeight);
  const over = requestedArea > budget.maxArea || requestedWidth > budget.maxSide || requestedHeight > budget.maxSide;
  if (over && !warned.has(label)) {
    warned.add(label);
    console.warn(
      `[canvas-budget] ${label} allocated ${width}×${height} (${(area / 1e6).toFixed(1)}MP), ` +
      `requested ${Math.ceil(requestedWidth)}×${Math.ceil(requestedHeight)}; ` +
      `budget ${budget.maxSide}px / ${(budget.maxArea / 1e6).toFixed(0)}MP`,
    );
  }
  if (!largest || area > largest.area) {
    largest = {
      label,
      width,
      height,
      area,
      requestedWidth: Math.ceil(requestedWidth),
      requestedHeight: Math.ceil(requestedHeight),
      budgetArea: budget.maxArea,
      clamped: width < requestedWidth || height < requestedHeight,
    };
    // Debug-only so production play does not spam the console.
    if (import.meta.env?.DEV) {
      console.debug(
        `[canvas-budget] largest canvas: ${label} ${width}×${height} ` +
        `(${(area / 1e6).toFixed(2)}MP, budget ${(budget.maxArea / 1e6).toFixed(0)}MP)`,
      );
    }
  }
}

export function releaseCanvas(canvas: CanvasLike): void {
  canvas.width = 0;
  canvas.height = 0;
}

export function allocateCanvas(
  canvas: CanvasLike,
  requestedWidth: number,
  requestedHeight: number,
  label: string,
  budget: CanvasBudget,
): BackingStoreFit {
  const fit = fitCanvasSize(requestedWidth, requestedHeight, budget);
  if (canvas.width !== fit.width || canvas.height !== fit.height) {
    releaseCanvas(canvas);
  }
  if (canvas.width !== fit.width) canvas.width = fit.width;
  if (canvas.height !== fit.height) canvas.height = fit.height;
  noteCanvasAllocation(label, fit.width, fit.height, requestedWidth, requestedHeight, budget);
  return fit;
}