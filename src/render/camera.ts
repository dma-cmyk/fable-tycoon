// Camera math shared by the wrapping world map and the non-wrapping realm boards.
// Zoom is CSS pixels per coordinate unit. Limits adapt to the active world size.

import { MAP_H, MAP_W, wrapDx, wrapX } from '../core/geo';

const FIT_MARGIN = 0.97;

/** 全体地図とみなすズーム（最小ズーム比）。 */
export const OVERVIEW_ZOOM_RATIO = 1.18;
/** プレイ画面のズーム下限。全体地図のしきい値より必ず上に置き、通常プレイで全体表示に落ちない。 */
export const PLAY_MIN_ZOOM_FACTOR = 1.24;

export function minZoomFor(vw: number, vh: number, worldW: number, worldH: number): number {
  const fit = Math.min(vw / worldW, vh / worldH);
  return Math.max(0.02, fit * FIT_MARGIN);
}

export function maxZoomFor(worldW: number): number {
  return Math.max(3, worldW / 1200);
}

export interface CameraTween {
  start: number;
  ms: number;
  fromX: number;
  fromY: number;
  fromZoom: number;
  toX: number;
  toY: number;
  toZoom: number;
  resolve: () => void;
}

export interface CameraSnapshot {
  x: number;
  y: number;
  zoom: number;
}

/** Freeze the camera (cancelling any tween) and record its exact centre and zoom. */
export function captureCamera(cam: Camera): CameraSnapshot {
  cam.stopTween();
  return { x: cam.x, y: cam.y, zoom: cam.zoom };
}

/** Restore a captured centre/zoom exactly, clamped only by the camera's own limits. */
export function restoreCamera(cam: Camera, snapshot: CameraSnapshot): void {
  cam.stopTween();
  cam.zoom = cam.clampZoom(snapshot.zoom);
  cam.x = cam.clampCenterX(snapshot.x, cam.zoom);
  cam.y = cam.clampCenterY(snapshot.y, cam.zoom);
}

export class Camera {
  x: number;
  y: number;
  zoom = 1;
  vw = 1;
  vh = 1;
  tween: CameraTween | null = null;
  /** 最小ズームに掛ける係数。プレイ画面は 1 より大きくして全体表示へ落ちないようにする。 */
  minZoomFactor = 1;

  constructor(
    readonly worldW: number = MAP_W,
    readonly worldH: number = MAP_H,
    readonly wraps = true,
  ) {
    this.x = worldW / 2;
    this.y = worldH / 2;
  }

  setViewport(vw: number, vh: number): void {
    this.vw = Math.max(1, vw);
    this.vh = Math.max(1, vh);
    this.zoom = this.clampZoom(this.zoom);
    this.x = this.clampCenterX(this.x, this.zoom);
    this.y = this.clampCenterY(this.y, this.zoom);
  }

  minZoom(): number {
    return minZoomFor(this.vw, this.vh, this.worldW, this.worldH) * this.minZoomFactor;
  }

  maxZoom(): number {
    return maxZoomFor(this.worldW);
  }

  clampZoom(zoom: number): number {
    return Math.min(this.maxZoom(), Math.max(this.minZoom(), zoom));
  }

  clampCenterY(y: number, zoom = this.zoom): number {
    const half = this.vh / 2 / zoom;
    if (half * 2 >= this.worldH) return this.worldH / 2;
    return Math.min(this.worldH - half, Math.max(half, y));
  }

  clampCenterX(x: number, zoom = this.zoom): number {
    if (this.wraps) return wrapX(x);
    const half = this.vw / 2 / zoom;
    if (half * 2 >= this.worldW) return this.worldW / 2;
    return Math.min(this.worldW - half, Math.max(half, x));
  }

  fitHeightZoom(): number {
    return this.clampZoom(this.vh / this.worldH);
  }

  left(): number {
    return this.x - this.vw / 2 / this.zoom;
  }

  top(): number {
    return this.y - this.vh / 2 / this.zoom;
  }

  worldWidth(): number {
    return this.vw / this.zoom;
  }

  worldHeight(): number {
    return this.vh / this.zoom;
  }

  screenX(worldX: number): number {
    const dx = this.wraps ? wrapDx(this.x, worldX) : worldX - this.x;
    return this.vw / 2 + dx * this.zoom;
  }

  screenY(worldY: number): number {
    return this.vh / 2 + (worldY - this.y) * this.zoom;
  }

  screenDeltaX(fromX: number, toX: number): number {
    return (this.wraps ? wrapDx(fromX, toX) : toX - fromX) * this.zoom;
  }

  worldAt(sx: number, sy: number): { x: number; y: number } {
    return {
      x: this.clampCenterX(this.x + (sx - this.vw / 2) / this.zoom),
      y: this.y + (sy - this.vh / 2) / this.zoom,
    };
  }

  panByScreen(dx: number, dy: number): void {
    this.stopTween();
    this.x = this.clampCenterX(this.x - dx / this.zoom);
    this.y = this.clampCenterY(this.y - dy / this.zoom);
  }

  zoomAround(sx: number, sy: number, nextZoom: number): void {
    const z = this.clampZoom(nextZoom);
    if (Math.abs(z - this.zoom) < 1e-6) return;
    const wx = this.x + (sx - this.vw / 2) / this.zoom;
    const wy = this.y + (sy - this.vh / 2) / this.zoom;
    this.zoom = z;
    this.x = this.clampCenterX(wx - (sx - this.vw / 2) / z);
    this.y = this.clampCenterY(wy - (sy - this.vh / 2) / z);
  }

  centerOn(worldX: number, worldY: number): void {
    this.x = this.clampCenterX(worldX);
    this.y = this.clampCenterY(worldY);
  }

  isTweening(): boolean {
    return this.tween !== null;
  }

  stopTween(): void {
    const t = this.tween;
    this.tween = null;
    if (t) t.resolve();
  }

  focus(worldX: number, worldY: number, zoom?: number, ms = 550): Promise<void> {
    const targetZoom = this.clampZoom(zoom ?? this.zoom);
    const targetX = this.wraps ? this.x + wrapDx(this.x, worldX) : worldX;
    const targetY = this.clampCenterY(worldY, targetZoom);
    return this.startTween(targetX, targetY, targetZoom, ms);
  }

  fitWorld(ms = 650): Promise<void> {
    const zoom = this.clampZoom(Math.min(this.vw / this.worldW, this.vh / this.worldH));
    return this.startTween(this.worldW / 2, this.worldH / 2, zoom, ms);
  }

  startTween(toX: number, toY: number, toZoom: number, ms: number, minZoomOverride?: number): Promise<void> {
    this.stopTween();
    const min = Math.max(0.02, minZoomOverride ?? this.minZoom());
    const zoom = Math.min(this.maxZoom(), Math.max(min, toZoom));
    if (ms <= 0) {
      this.x = this.clampCenterX(toX, zoom);
      this.y = this.clampCenterY(toY, zoom);
      this.zoom = zoom;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.tween = {
        start: performance.now(),
        ms,
        fromX: this.x,
        fromY: this.y,
        fromZoom: this.zoom,
        toX,
        toY,
        toZoom: zoom,
        resolve,
      };
    });
  }

  update(now: number): boolean {
    const t = this.tween;
    if (!t) return false;
    const p = Math.min(1, Math.max(0, (now - t.start) / t.ms));
    const e = easeInOutCubic(p);
    const dx = this.wraps ? wrapDx(t.fromX, t.toX) : t.toX - t.fromX;
    this.x = this.clampCenterX(t.fromX + dx * e, t.toZoom);
    this.y = this.clampCenterY(t.fromY + (t.toY - t.fromY) * e, t.toZoom);
    this.zoom = t.fromZoom + (t.toZoom - t.fromZoom) * e;
    if (p >= 1) {
      this.x = this.clampCenterX(t.toX, t.toZoom);
      this.y = this.clampCenterY(t.toY, t.toZoom);
      this.zoom = t.toZoom;
      this.tween = null;
      t.resolve();
      return false;
    }
    return true;
  }

  nudgeToward(worldX: number, worldY: number, marginPx: number): boolean {
    const sx = this.screenX(worldX);
    const sy = this.screenY(worldY);
    const m = marginPx;
    let dx = 0;
    let dy = 0;
    if (sx < m) dx = sx - m;
    else if (sx > this.vw - m) dx = sx - (this.vw - m);
    if (sy < m) dy = sy - m;
    else if (sy > this.vh - m) dy = sy - (this.vh - m);
    if (dx === 0 && dy === 0) return false;
    this.x = this.clampCenterX(this.x + dx / this.zoom);
    this.y = this.clampCenterY(this.y + dy / this.zoom);
    return true;
  }
}

export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function nearX(origin: number, x: number): number {
  return origin + wrapDx(origin, x);
}
