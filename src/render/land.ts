// Ocean backdrop and a windowed, zoom-bucketed land raster cache.
//
// The land can be re-rasterised at exactly zoom*dpr device pixels because the cache only
// covers the viewport plus a margin, never the whole world at high zoom. Panning inside
// the margin reuses the layer; leaving it (or changing zoom bucket) rebuilds it.

import { MAP_H, MAP_W, project, wrapDx } from '../core/geo';
import type { Camera } from './camera';
import type { LandJson } from './map';
import { detectCanvasBudget, fitCanvasSize, fitRaster, noteCanvasAllocation, releaseCanvas, type CanvasBudget } from './canvasBudget';

interface PolyBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  rings: number[][];
}

interface TreeStamp {
  x: number;
  y: number;
  size: number;
  tint: number;
  rank: number;
  lat?: number;
  lon?: number;
}

// Extra world margin on each side of the viewport. Left as-is: changing it rescales the
// raster, which shifts every coastline by a fraction of a pixel, and the rebuild it feeds
// now only runs on a pan past the margin.
const CACHE_PAD = 0.85;

export type Season = 'spring' | 'summer' | 'autumn' | 'winter';

export function seasonForMonth(month: number): Season {
  if (month >= 3 && month <= 5) return 'spring';
  if (month >= 6 && month <= 8) return 'summer';
  if (month >= 9 && month <= 11) return 'autumn';
  return 'winter';
}

export function oppositeSeason(s: Season): Season {
  return s === 'spring' ? 'autumn' : s === 'autumn' ? 'spring' : s === 'summer' ? 'winter' : 'summer';
}

const SEASON_LAND: Record<Season, { top: string; mid: string; bottom: string; outline: string }> = {
  spring: { top: '#c9ef91', mid: '#a8e06d', bottom: '#81cd57', outline: '#407c2c' },
  summer: { top: '#aae66d', mid: '#7bd14a', bottom: '#51ae37', outline: '#2f6d22' },
  autumn: { top: '#d9df7b', mid: '#bfcc60', bottom: '#95ac49', outline: '#697b2c' },
  winter: { top: '#d6e8c2', mid: '#b7d3a6', bottom: '#93b88b', outline: '#5d7b5b' },
};

const SEASON_TREES: Record<Season, [string, string, string]> = {
  spring: ['#f2a6c6', '#f8bed8', '#e98cae'],
  summer: ['#3e9d35', '#4fb83f', '#62c94b'],
  autumn: ['#d9772c', '#e8a33a', '#c85a2e'],
  winter: ['#2f6b3f', '#3d7a4a', '#6f9b72'],
};

export interface LayerTransform {
  ctx: CanvasRenderingContext2D;
  toCanvas: (x: number, y: number) => [number, number];
  /** Device px per map unit. */
  scale: number;
  /** Device pixels per CSS pixel (visual sizes are authored in CSS px). */
  dpr: number;
  ox: number;
  oy: number;
  wWorld: number;
  hWorld: number;
}

export type LayerPainter = (layer: LayerTransform) => void;

/** Small deterministic PRNG used only for decoration. */
function hash01(n: number): number {
  let x = n | 0;
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

function pointInPolygons(boxes: PolyBox[], x: number, y: number): boolean {
  let inside = false;
  for (const box of boxes) {
    if (x < box.minX || x > box.maxX || y < box.minY || y > box.maxY) continue;
    for (const ring of box.rings) {
      const n = ring.length;
      for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
        const xi = ring[i];
        const yi = ring[i + 1];
        const xj = ring[j];
        const yj = ring[j + 1];
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
          inside = !inside;
        }
      }
    }
  }
  return inside;
}

function isDesertBox(lat: number, lon: number): boolean {
  return (
    (lon > -18 && lon < 36 && lat > 12 && lat < 32) ||
    (lon > 35 && lon < 60 && lat > 12 && lat < 33) ||
    (lon > 114 && lon < 146 && lat > -33 && lat < -19) ||
    (lon > 84 && lon < 116 && lat > 37 && lat < 51)
  );
}

export class LandLayer {
  private readonly boxes: PolyBox[];
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private key = '';
  private ox = 0;
  private oy = 0;
  private wWorld = 0;
  private hWorld = 0;
  private scale = 0;
  private centerX = 0;
  private centerY = 0;
  private trees: TreeStamp[] | null = null;
  private fadeCanvas: HTMLCanvasElement | null = null;
  private fadeStart = 0;
  private fadeMeta: { ox: number; oy: number; wWorld: number; hWorld: number; scale: number } | null = null;
  private terrain: HTMLImageElement | undefined;
  private terrainLo: HTMLImageElement | undefined;
  private biomeMask: Uint8ClampedArray | null = null;
  private biomeW = 512;
  private biomeH = 238;
  private budget: CanvasBudget = detectCanvasBudget();

  constructor(land: LandJson) {
    this.boxes = land.polygons.map((rings) => {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const ring of rings) {
        for (let i = 0; i < ring.length; i += 2) {
          minX = Math.min(minX, ring[i]);
          maxX = Math.max(maxX, ring[i]);
          minY = Math.min(minY, ring[i + 1]);
          maxY = Math.max(maxY, ring[i + 1]);
        }
      }
      return { minX, minY, maxX, maxY, rings };
    });
    this.canvas = document.createElement('canvas');
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas is unavailable');
    this.ctx = ctx;
    // Building the deterministic tree field takes a moment; do it behind the
    // loading screen instead of on the first mid/near zoom.
    this.trees = this.buildTrees();
  }

  invalidate(): void {
    this.key = '';
  }

  setBudget(budget: CanvasBudget): void {
    const same = budget.profile === this.budget.profile
      && budget.maxDpr === this.budget.maxDpr
      && budget.maxSide === this.budget.maxSide
      && budget.maxArea === this.budget.maxArea
      && budget.webkit === this.budget.webkit;
    if (same) return;
    this.budget = budget;
    this.key = '';
    // A different device profile means the previous backing stores may be
    // oversized. Drop them now; the next frame rebuilds within the new budget.
    if (this.canvas.width || this.canvas.height) releaseCanvas(this.canvas);
    if (this.fadeCanvas) {
      releaseCanvas(this.fadeCanvas);
      this.fadeCanvas = null;
      this.fadeMeta = null;
    }
  }

  /** Release all offscreen canvases. */
  destroy(): void {
    releaseCanvas(this.canvas);
    if (this.fadeCanvas) releaseCanvas(this.fadeCanvas);
    this.fadeCanvas = null;
    this.fadeMeta = null;
    this.key = '';
  }

  setTerrain(full?: HTMLImageElement, lo?: HTMLImageElement): void {
    this.terrain = full;
    this.terrainLo = lo;
    this.key = '';
    const img = full ?? lo;
    if (img && img.naturalWidth > 0) {
      const c = document.createElement('canvas');
      this.biomeW = 512;
      this.biomeH = Math.max(8, Math.round((512 * MAP_H) / MAP_W));
      c.width = this.biomeW;
      c.height = this.biomeH;
      const g = c.getContext('2d');
      if (g) {
        g.drawImage(img, 0, 0, this.biomeW, this.biomeH);
        this.biomeMask = g.getImageData(0, 0, this.biomeW, this.biomeH).data;
      }
    }
  }

  /** True for desert/sand/ice according to the terrain texture. */
  isBarrenAt(x: number, y: number): boolean {
    const data = this.biomeMask;
    if (!data) return false;
    const px = Math.min(this.biomeW - 1, Math.max(0, Math.floor((((x % MAP_W) + MAP_W) % MAP_W / MAP_W) * this.biomeW)));
    const py = Math.min(this.biomeH - 1, Math.max(0, Math.floor((y / MAP_H) * this.biomeH)));
    const i = (py * this.biomeW + px) * 4;
    if (data[i + 3] < 40) return false;
    const r = data[i], gg = data[i + 1], b = data[i + 2];
    const ice = r > 205 && gg > 212 && b > 210;
    const sand = r > 140 && r - b > 48 && gg - b > 18 && r >= gg - 12;
    return ice || sand;
  }

  /** True when a world point lies on land (used to place terrain stamps). */
  isLand(x: number, y: number): boolean {
    return pointInPolygons(this.boxes, x, y);
  }

  /** Draw the cached land + static board into a DPR-transformed screen context. */
  draw(
    target: CanvasRenderingContext2D,
    cam: Camera,
    dpr: number,
    revision: number,
    season: Season,
    paintStatic?: LayerPainter,
    treeAvoid?: (x: number, y: number) => boolean,
    geoAt?: (x: number, y: number) => { lat: number; lon: number },
    tileWorld = true,
  ): void {
    // Quantise zoom on a log2 grid (~7% steps). The cached raster is reused and
    // scaled a few percent while zooming, so wheel/pinch do not rebuild every frame.
    const bucket = Math.round(Math.log2(cam.zoom) * 10) / 10;
    const bucketZoom = Math.pow(2, bucket);
    const withTrees = cam.zoom >= 0.62;
    const visW = cam.vw / bucketZoom;
    const visH = cam.vh / bucketZoom;
    const wWorld = Math.min(MAP_W, visW * (1 + 2 * CACHE_PAD));
    const hWorld = Math.min(MAP_H, visH * (1 + 2 * CACHE_PAD));
    // Never allocate the full requested raster. On phones/WebKit a 3× DPR
    // whole-view cache exceeds the backing-store limit; the same viewport
    // area at a coarser raster scale is visually identical once drawn.
    const requestedScale = bucketZoom * dpr;
    const raster = fitRaster(wWorld, hWorld, requestedScale, this.budget);
    const scale = raster.scale;
    const key = `${bucket}:${dpr.toFixed(3)}:${scale.toFixed(4)}:${withTrees ? 1 : 0}:${wWorld.toFixed(1)}:${hWorld.toFixed(1)}:${revision}:${season}`;

    const marginX = wWorld >= MAP_W - 0.5 ? Infinity : (wWorld - visW) / 2;
    const marginY = hWorld >= MAP_H - 0.5 ? Infinity : (hWorld - visH) / 2;
    const dx = Math.abs(wrapDx(this.centerX, cam.x));
    const dy = Math.abs(cam.y - this.centerY);
    const needs =
      key !== this.key ||
      dx > marginX * 0.8 ||
      dy > marginY * 0.8;

    if (needs) {
      this.rebuild(cam, scale, wWorld, hWorld, withTrees, bucket, dpr, revision, season, paintStatic, treeAvoid, geoAt, key, requestedScale);
    }

    const screenX = cam.vw / 2 + wrapDx(cam.x, this.ox + this.wWorld / 2) * cam.zoom - (this.wWorld * cam.zoom) / 2;
    const screenY = cam.vh / 2 + (this.oy + this.hWorld / 2 - cam.y) * cam.zoom - (this.hWorld * cam.zoom) / 2;
    const drawW = this.wWorld * cam.zoom;
    const drawH = this.hWorld * cam.zoom;

    if (this.wWorld >= MAP_W - 0.5) {
      // Overview intentionally shows exactly one circumference: repeating it
      // would make phone overviews look like the same continents twice.
      if (!tileWorld) {
        target.drawImage(this.canvas, screenX, screenY, drawW, drawH);
        return;
      }
      // Whole-world cache: tile horizontally so views that straddle the seam
      // always show the wrapped part of the world on both sides.
      const first = Math.floor((0 - screenX) / drawW);
      const last = Math.floor((cam.vw - screenX) / drawW);
      for (let k = first; k <= last; k++) {
        target.drawImage(this.canvas, screenX + k * drawW, screenY, drawW, drawH);
      }
      return;
    }
    // Clip instead of cropping the source rect: the sampling map stays identical to a
    // whole-raster blit (so pixels are unchanged), while the rasteriser can skip the
    // off-screen part of the cache instead of resampling ~7 viewports per frame.
    target.save();
    target.beginPath();
    target.rect(0, 0, cam.vw, cam.vh);
    target.clip();
    target.drawImage(this.canvas, screenX, screenY, drawW, drawH);
    target.restore();
  }

  private rebuild(
    cam: Camera,
    scale: number,
    wWorld: number,
    hWorld: number,
    withTrees: boolean,
    bucket: number,
    dpr: number,
    revision: number,
    season: Season,
    paintStatic?: LayerPainter,
    treeAvoid?: (x: number, y: number) => boolean,
    geoAt?: (x: number, y: number) => { lat: number; lon: number },
    key = '',
    requestedScale = scale,
  ): void {
    const fit = fitRaster(wWorld, hWorld, requestedScale, this.budget);
    const wPx = fit.width;
    const hPx = fit.height;
    this.scale = fit.scale;
    if (this.canvas.width !== wPx || this.canvas.height !== hPx) {
      // Release the previous backing store first; switching zoom buckets must
      // not keep two large layers resident on a phone.
      releaseCanvas(this.canvas);
      this.canvas.width = wPx;
      this.canvas.height = hPx;
    } else {
      this.ctx.setTransform(1, 0, 0, 1, 0, 0);
      this.ctx.clearRect(0, 0, wPx, hPx);
    }
    noteCanvasAllocation('land', wPx, hPx, Math.ceil(wWorld * requestedScale), Math.ceil(hWorld * requestedScale), this.budget);
    this.wWorld = wWorld;
    this.hWorld = hWorld;
    this.centerX = cam.x;
    this.key = key || `${bucket}:${dpr.toFixed(3)}:${fit.scale.toFixed(4)}:${withTrees ? 1 : 0}:${wWorld.toFixed(1)}:${hWorld.toFixed(1)}:${revision}:${season}`;

    if (wWorld >= MAP_W - 0.5) {
      this.ox = 0;
    } else {
      this.ox = cam.x - wWorld / 2;
    }
    if (hWorld >= MAP_H - 0.5) {
      this.oy = 0;
      this.centerY = MAP_H / 2;
    } else {
      this.oy = Math.min(MAP_H - hWorld, Math.max(0, cam.y - hWorld / 2));
      this.centerY = this.oy + hWorld / 2;
    }

    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const toCanvas = (wx: number, wy: number): [number, number] => [
      (wx - this.ox) * this.scale,
      (wy - this.oy) * this.scale,
    ];

    // Horizontal wrap copies needed to cover this layer's world x range.
    const x0 = this.ox;
    const x1 = this.ox + wWorld;
    const kMin = Math.floor((x0 - MAP_W) / MAP_W);
    const kMax = Math.ceil(x1 / MAP_W);

    const path = new Path2D();
    let visiblePolys = 0;
    for (let k = kMin; k <= kMax; k++) {
      const shift = k * MAP_W;
      for (const box of this.boxes) {
        if (box.maxX + shift < x0 || box.minX + shift > x1) continue;
        if (box.maxY < this.oy || box.minY > this.oy + hWorld) continue;
        visiblePolys += 1;
        for (const ring of box.rings) {
          for (let i = 0; i < ring.length; i += 2) {
            const [px, py] = toCanvas(ring[i] + shift, ring[i + 1]);
            if (i === 0) path.moveTo(px, py);
            else path.lineTo(px, py);
          }
          path.closePath();
        }
      }
    }

    if (visiblePolys > 0) {
      const palette = SEASON_LAND[season];
      const grad = ctx.createLinearGradient(0, 0, 0, hPx);
      grad.addColorStop(0, palette.top);
      grad.addColorStop(0.45, palette.mid);
      grad.addColorStop(1, palette.bottom);
      // shallow-water halo just outside the coastline
      ctx.save();
      ctx.strokeStyle = 'rgba(146, 236, 255, 0.5)';
      ctx.lineWidth = Math.max(4, Math.min(12, 4 * cam.zoom)) * dpr;
      ctx.lineJoin = 'round';
      ctx.stroke(path);
      ctx.restore();

      // A flat offset silhouette is much cheaper than a blurred canvas shadow
      // and reads as a soft coastal drop shadow at every zoom.
      ctx.save();
      ctx.translate(Math.max(1, 3.2 * this.scale), Math.max(1, 4.2 * this.scale));
      ctx.fillStyle = 'rgba(3, 48, 72, 0.28)';
      ctx.fill(path, 'evenodd');
      ctx.restore();

      ctx.fillStyle = grad;
      ctx.fill(path, 'evenodd');

      const tex = cam.zoom <= 0.22 ? this.terrainLo ?? this.terrain : this.terrain ?? this.terrainLo;
      if (tex && tex.naturalWidth > 0) {
        ctx.save();
        ctx.clip(path, 'evenodd');
        for (let k = kMin; k <= kMax; k++) {
          const shift = k * MAP_W;
          ctx.drawImage(tex, (shift - this.ox) * this.scale, -this.oy * this.scale, MAP_W * this.scale, MAP_H * this.scale);
        }
        // Keep the concept-art saturation on top of the pale topographic texture.
        ctx.globalCompositeOperation = 'soft-light';
        ctx.globalAlpha = 0.5;
        ctx.fillStyle = SEASON_LAND[season].mid;
        ctx.fillRect(0, 0, wPx, hPx);
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
        ctx.restore();
      }

      ctx.save();
      ctx.strokeStyle = SEASON_LAND[season].outline;
      ctx.lineWidth = Math.max(2, Math.min(8, 2.1 * this.scale));
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.stroke(path);
      ctx.restore();
    }

    if (withTrees) {
      if (!this.trees) this.trees = this.buildTrees();
      this.drawTrees(ctx, toCanvas, cam.zoom >= 1.45 ? 0.25 : 0.6, season, treeAvoid, geoAt);
    }
    if (visiblePolys > 0 && (season === 'winter' || season === 'summer')) {
      this.drawSnow(ctx, path, season);
    }

    if (paintStatic) {
      paintStatic({
        ctx,
        toCanvas,
        scale: this.scale,
        dpr,
        ox: this.ox,
        oy: this.oy,
        wWorld: this.wWorld,
        hWorld: this.hWorld,
      });
    }
  }

  private drawSnow(ctx: CanvasRenderingContext2D, path: Path2D, season: Season): void {
    const north = season === 'winter';
    const snowY = (project(0, north ? 35 : -35)[1] - this.oy) * this.scale;
    const hPx = this.canvas.height;
    ctx.save();
    ctx.clip(path, 'evenodd');
    if (north) {
      const g = ctx.createLinearGradient(0, 0, 0, Math.max(1, snowY));
      g.addColorStop(0, 'rgba(255,255,255,0.72)');
      g.addColorStop(0.7, 'rgba(255,255,255,0.5)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, this.canvas.width, Math.max(0, snowY));
    } else {
      const g = ctx.createLinearGradient(0, hPx, 0, Math.min(hPx, snowY));
      g.addColorStop(0, 'rgba(255,255,255,0.72)');
      g.addColorStop(0.7, 'rgba(255,255,255,0.5)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, Math.max(0, snowY), this.canvas.width, hPx - Math.max(0, snowY));
    }
    ctx.restore();
  }

  /** Snapshot the current season layer so MapView can crossfade it out. */
  beginSeasonTransition(now: number): void {
    if (this.canvas.width <= 1 || this.wWorld <= 0) return;
    const c = this.fadeCanvas ?? document.createElement('canvas');
    const fit = fitCanvasSize(this.canvas.width, this.canvas.height, this.budget);
    if (c.width !== fit.width || c.height !== fit.height) {
      releaseCanvas(c);
      c.width = fit.width;
      c.height = fit.height;
    } else {
      const old = c.getContext('2d');
      if (!old) return;
      old.setTransform(1, 0, 0, 1, 0, 0);
      old.clearRect(0, 0, c.width, c.height);
    }
    noteCanvasAllocation('land-fade', c.width, c.height, this.canvas.width, this.canvas.height, this.budget);
    const g = c.getContext('2d');
    if (!g) return;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, c.width, c.height);
    g.drawImage(this.canvas, 0, 0, c.width, c.height);
    this.fadeCanvas = c;
    this.fadeMeta = {
      ox: this.ox,
      oy: this.oy,
      wWorld: this.wWorld,
      hWorld: this.hWorld,
      scale: this.scale,
    };
    this.fadeStart = now;
  }

  drawSeasonFade(target: CanvasRenderingContext2D, cam: Camera, now: number): void {
    const meta = this.fadeMeta;
    const canvas = this.fadeCanvas;
    if (!meta || !canvas) return;
    const p = (now - this.fadeStart) / 1000;
    if (p >= 1) {
      releaseCanvas(canvas);
      this.fadeCanvas = null;
      this.fadeMeta = null;
      return;
    }
    const alpha = 1 - p;
    const drawW = meta.wWorld * cam.zoom;
    const drawH = meta.hWorld * cam.zoom;
    const screenX =
      cam.vw / 2 + wrapDx(cam.x, meta.ox + meta.wWorld / 2) * cam.zoom - drawW / 2;
    const screenY =
      cam.vh / 2 + (meta.oy + meta.hWorld / 2 - cam.y) * cam.zoom - drawH / 2;
    target.save();
    target.globalAlpha = Math.max(0, alpha);
    if (meta.wWorld >= MAP_W - 0.5) {
      const first = Math.floor((0 - screenX) / drawW);
      const last = Math.floor((cam.vw - screenX) / drawW);
      for (let k = first; k <= last; k++) {
        target.drawImage(canvas, screenX + k * drawW, screenY, drawW, drawH);
      }
    } else {
      target.drawImage(canvas, screenX, screenY, drawW, drawH);
    }
    target.restore();
  }

  private drawTrees(
    ctx: CanvasRenderingContext2D,
    toCanvas: (x: number, y: number) => [number, number],
    minRank: number,
    season: Season,
    treeAvoid?: (x: number, y: number) => boolean,
    geoAt?: (x: number, y: number) => { lat: number; lon: number },
  ): void {
    const trees = this.trees;
    if (!trees) return;
    const margin = 20 / Math.max(0.2, this.scale);
    const x0 = this.ox - margin;
    const x1 = this.ox + this.wWorld + margin;
    const y0 = this.oy - margin;
    const y1 = this.oy + this.hWorld + margin;
    for (let k = -1; k <= 1; k++) {
      const shift = k * MAP_W;
      for (const t of trees) {
        if (t.rank < minRank) continue;
        if (treeAvoid?.(t.x, t.y)) continue;
        const tx = t.x + shift;
        if (tx < x0 || tx > x1 || t.y < y0 || t.y > y1) continue;
        if (t.lat === undefined) {
          const geo = geoAt?.(t.x, t.y) ?? { lat: 0, lon: 0 };
          t.lat = geo.lat;
          t.lon = geo.lon;
        }
        const lat = t.lat;
        const lon = t.lon ?? 0;
        // Barren ground (ice sheet, desert) must hide the whole tree, trunk
        // included: drawing the trunk first left brown sticks on Greenland.
        if (isDesertBox(lat, lon) || this.isBarrenAt(t.x, t.y)) continue;
        const [cx, cy] = toCanvas(tx, t.y);
        const s = t.size * this.scale;
        // trunk
        ctx.fillStyle = '#7a4c2b';
        ctx.beginPath();
        ctx.roundRect(cx - s * 0.16, cy - s * 0.1, s * 0.32, s * 0.75, s * 0.12);
        ctx.fill();
        // crown: two overlapping circles plus a highlight
        const crown = s * (0.72 + t.tint * 0.16);
        const eq = project(0, 0)[1];
        const tropical = Math.abs(lat) < 23;
        const hemi = tropical ? 'summer' : t.y < eq ? season : oppositeSeason(season);
        const colors = SEASON_TREES[hemi];
        const base = t.tint > 0.66 ? colors[0] : t.tint > 0.33 ? colors[1] : colors[2];
        ctx.fillStyle = !tropical && season === 'winter' && Math.abs(lat) > 35 ? '#eaf2e6' : base;
        ctx.beginPath();
        ctx.arc(cx, cy - s * 0.75, crown, 0, Math.PI * 2);
        ctx.arc(cx - crown * 0.65, cy - s * 0.45, crown * 0.7, 0, Math.PI * 2);
        ctx.arc(cx + crown * 0.63, cy - s * 0.43, crown * 0.68, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = season === 'autumn' ? 'rgba(255, 230, 150, 0.6)' : 'rgba(235, 255, 210, 0.55)';
        ctx.beginPath();
        ctx.arc(cx - crown * 0.3, cy - s * 0.98, crown * 0.34, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  private buildTrees(): TreeStamp[] {
    const out: TreeStamp[] = [];
    // Keep the same visual tree density for any world size: spacing and stamp
    // size are fractions of MAP_W rather than fixed map units.
    const step = MAP_W / 292;
    const baseSize = MAP_W / 1412;
    let n = 0;
    for (let gy = step * 2; gy < MAP_H - step * 0.7; gy += step) {
      for (let gx = step; gx < MAP_W - step; gx += step) {
        n += 1;
        const jitterX = (hash01(n * 3 + 1) - 0.5) * step * 0.95;
        const jitterY = (hash01(n * 3 + 2) - 0.5) * step * 0.95;
        const x = gx + jitterX;
        const y = gy + jitterY;
        if (hash01(n * 5 + 4) > 0.62) continue;
        if (!pointInPolygons(this.boxes, x, y)) continue;
        out.push({
          x,
          y,
          size: baseSize * (1 + hash01(n * 7 + 6) * 1.24),
          tint: hash01(n * 11 + 9),
          rank: hash01(n * 13 + 12),
        });
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------- ocean

export class OceanBackdrop {
  private background: HTMLCanvasElement | null = null;
  private bgW = 0;
  private bgH = 0;
  private bgDpr = 0;
  private readonly tile: HTMLCanvasElement;
  private readonly tileSize = 192;
  private budget: CanvasBudget = detectCanvasBudget();

  constructor() {
    this.tile = makeWaveTile();
  }

  setBudget(budget: CanvasBudget): void {
    if (budget.profile === this.budget.profile && budget.maxArea === this.budget.maxArea && budget.maxSide === this.budget.maxSide) return;
    this.budget = budget;
    if (this.background) {
      releaseCanvas(this.background);
      this.background = null;
      this.bgW = 0;
      this.bgH = 0;
      this.bgDpr = 0;
    }
  }

  destroy(): void {
    if (this.background) releaseCanvas(this.background);
    this.background = null;
    releaseCanvas(this.tile);
  }

  draw(ctx: CanvasRenderingContext2D, cam: Camera, dpr: number, now = 0): void {
    const w = cam.vw;
    const h = cam.vh;
    const tile = this.tileSize;
    const fit = fitCanvasSize(Math.ceil((w + tile) * dpr), Math.ceil(h * dpr), this.budget);
    const bgDpr = Math.min(dpr, fit.width / (w + tile), fit.height / h);
    const cw = Math.max(1, Math.floor((w + tile) * bgDpr));
    const ch = Math.max(1, Math.floor(h * bgDpr));
    if (!this.background || this.bgW !== w || this.bgH !== h || this.bgDpr !== bgDpr) {
      const c = this.background ?? document.createElement('canvas');
      if (c.width !== cw || c.height !== ch) {
        releaseCanvas(c);
        c.width = cw;
        c.height = ch;
      }
      noteCanvasAllocation('ocean-bg', cw, ch, Math.ceil((w + tile) * dpr), Math.ceil(h * dpr), this.budget);
      const g = c.getContext('2d');
      if (g) {
        const grad = g.createLinearGradient(0, 0, 0, ch);
        grad.addColorStop(0, '#7fe0ff');
        grad.addColorStop(0.35, '#59c8f4');
        grad.addColorStop(0.72, '#2fa5e6');
        grad.addColorStop(1, '#2289ce');
        g.fillStyle = grad;
        g.fillRect(0, 0, cw, ch);
        const tilePx = Math.max(2, Math.round(tile * bgDpr));
        for (let y = 0; y < ch + tilePx; y += tilePx) {
          for (let x = 0; x < cw + tilePx; x += tilePx) {
            g.drawImage(this.tile, 0, 0, tile, tile, x, y, tilePx, tilePx);
          }
        }
      }
      this.background = c;
      this.bgW = w;
      this.bgH = h;
      this.bgDpr = bgDpr;
    }
    // One opaque blit: wave marks slide horizontally as the camera pans.
    const shift = ((((cam.x * cam.zoom * 0.22 + now * 0.006) % tile) + tile) % tile) * bgDpr;
    ctx.drawImage(this.background, shift, 0, w * bgDpr, h * bgDpr, 0, 0, w, h);
  }
}

function makeWaveTile(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 192;
  c.height = 192;
  const ctx = c.getContext('2d');
  if (!ctx) return c;
  const waves: Array<[number, number, number]> = [
    [22, 30, 15],
    [108, 52, 11],
    [58, 96, 17],
    [150, 120, 13],
    [30, 165, 9],
    [118, 176, 15],
    [178, 24, 8],
    [82, 10, 10],
  ];
  for (const [x, y, r] of waves) {
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.26)';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x - r, y);
    ctx.quadraticCurveTo(x - r * 0.45, y - 5, x, y);
    ctx.quadraticCurveTo(x + r * 0.45, y + 5, x + r, y);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(9, 91, 148, 0.13)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(x - r * 0.75, y + 4);
    ctx.quadraticCurveTo(x, y + 1, x + r * 0.7, y + 4);
    ctx.stroke();
  }
  return c;
}