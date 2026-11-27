// Ocean backdrop and a tiled, world-anchored land raster cache.
//
// The land and the static board used to live in one camera-sized raster that had to be
// repainted whenever the viewport left its margin (~330 ms at 1920×1080, report 85). They
// now live in 512-device-pixel tiles laid out on a lattice anchored at the world origin, so
// a tile depends only on its world rect, its quantised scale, the dpr and the content. That
// makes a pan (and the horizontal wrap) reuse tiles, and it makes a rendered frame a pure
// function of camera + content — which is what tests/e2e/map-raster-parity.mjs compares
// against a monolithic paint of the same rect.
//
// Geometry per zoom bucket:
//   S  = device px per world unit, snapped so MAP_W / TILE_DEV * S is an integer (nx)
//   nx = whole tiles around the world, so the MAP_W seam always falls on a tile edge
//   ny = ceil(MAP_H * S / TILE_DEV)
// Tile (i, j) covers device rect [i*TILE_DEV, (i+1)*TILE_DEV) × [j*TILE_DEV, ...) in the
// world-anchored frame; column i is normalised modulo nx when the world wraps.

import { MAP_H, MAP_W, project, wrapDx } from '../core/geo';
import type { Camera } from './camera';
import type { LandJson } from './map';
import { detectCanvasBudget, fitCanvasSize, noteCanvasAllocation, releaseCanvas, type CanvasBudget } from './canvasBudget';

interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface PolyBox extends Box {
  rings: number[][];
  /** Bounding box of each ring: a ring that misses a tile cannot paint into it. */
  ringBoxes: Box[];
  /** Closed path per ring, so a single ring can be added without copying the polygon. */
  ringPaths: Path2D[];
  /** World-unit path (all rings of this polygon), built once. */
  path: Path2D;
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

/** Tile edge in device pixels. */
const TILE_DEV = 512;
/** Tile cache size as a fraction of the canvas-area budget. */
const TILE_AREA_RATIO = 0.5;
/** How much rasterisation one background fill task may spend (see `fillStep`). */
const FILL_TASK_MS = 16;
/** Fan-out budget for the first synchronous composition of a session. */
const DEFAULT_FRAME_BUDGET_MS = 8;
/**
 * Device pixels painted beyond every tile / frame edge and then discarded. Chromium's clip
 * at a canvas edge perturbs the outermost ~5 px of what is drawn into it, so a tile painted
 * edge-to-edge is *not* byte-identical to the same rect of a larger paint. Keeping the used
 * pixels this far from the canvas edge makes tiles exactly equal to a full paint.
 */
const EDGE_BLEED = 8;
/** Device width of the whole-world placeholder raster built once per season. */
const THUMB_DEV = 1024;

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
  /** World point → device pixel inside the painted region (fractional). */
  toCanvas: (x: number, y: number) => [number, number];
  /** Device px per world unit of this region. */
  scale: number;
  /** Device px per CSS pixel (visual sizes are authored in CSS px). */
  dpr: number;
  /** World origin of the painted region. */
  ox: number;
  oy: number;
  wWorld: number;
  hWorld: number;
  /**
   * Quantised zoom (scale / dpr) the content is painted for. Everything zoom-derived in a
   * baked layer must use this instead of `camera.zoom`: a tile is shared between frames
   * whose live zoom differs slightly, so a cached tile must not depend on the camera.
   */
  zoom: number;
  /** Overview is part of the baked content (it switches the board dots on/off). */
  overview: boolean;
}

export type LayerPainter = (layer: LayerTransform) => void;

export interface LandFrameStats {
  /** Visible tiles drawn from the exact bucket. */
  exact: number;
  /** Visible tiles drawn from another bucket (or the previous frame) while painting. */
  placeholder: number;
  /** Visible tiles still missing after this frame's paint pass. */
  pending: number;
  /** Tiles rasterised this frame. */
  painted: number;
  /** Milliseconds spent rasterising tiles this frame. */
  paintMs: number;
  /** False when the previous composition was reused untouched. */
  recomposed: boolean;
  /** Device px per world unit of the active bucket. */
  scale: number;
  width: number;
  height: number;
}

export interface LandContentOptions {
  /** Whole-world overview view (board dots, single circumference). */
  overview?: boolean;
  /** Repeat the world horizontally (true in play, false for the overview). */
  wrap?: boolean;
  /** Override the per-frame rasterisation budget in ms (tests). */
  budgetMs?: number;
}

interface Tile {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  ix: number;
  iy: number;
  devW: number;
  devH: number;
  used: number;
}

interface TileGroup {
  key: string;
  bucket: number;
  dpr: number;
  scale: number;
  /** Tile columns around the world. */
  nx: number;
  /** Tile rows from pole to pole. */
  ny: number;
  /** Everything that is baked into the pixels except the revision. */
  family: string;
  tiles: Map<string, Tile>;
  used: number;
}

interface TileRect {
  /** Column in the frame's (un-normalised) lattice. */
  ux: number;
  /** Column normalised modulo nx. */
  ix: number;
  iy: number;
  /** Device offset inside the composed frame. */
  devX: number;
  devY: number;
  devW: number;
  devH: number;
  dist: number;
  /** Inside the viewport (the one-tile margin ring is not). */
  visible: boolean;
}

interface PaintContent {
  season: Season;
  overview: boolean;
  withTrees: boolean;
  paintStatic?: LayerPainter;
  treeAvoid?: (x: number, y: number) => boolean;
  geoAt?: (x: number, y: number) => { lat: number; lon: number };
}

interface FrameGeometry {
  bucket: number;
  zoom: number;
  scale: number;
  nx: number;
  ny: number;
  family: string;
  revision: number;
  wrap: boolean;
  withTrees: boolean;
  /** Viewport top-left in the world-anchored device lattice. */
  originX: number;
  originY: number;
  /** Composed frame size in device px. */
  devW: number;
  devH: number;
  /** Integer device offset of the composed frame's pixel 0 inside the viewport. */
  blitX: number;
  blitY: number;
}

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
  private trees: TreeStamp[] | null = null;
  private terrain: HTMLImageElement | undefined;
  private terrainLo: HTMLImageElement | undefined;
  private biomeMask: Uint8ClampedArray | null = null;
  private biomeW = 512;
  private biomeH = 238;
  private budget: CanvasBudget = detectCanvasBudget();

  /** Composed frame for the last draw (viewport size in device px). */
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  /** Whole-world low-resolution land raster, the last-resort placeholder. */
  private thumbCanvas: HTMLCanvasElement | null = null;
  private thumbFamily = '';
  private lastSeason: Season = 'spring';

  private groups = new Map<string, TileGroup>();
  private cachedArea = 0;
  private seq = 0;
  private frameBudgetMs = DEFAULT_FRAME_BUDGET_MS;
  /** Pending `fillStep` task, if any. */
  private fillTimer: number | null = null;
  /** Frame/content the pending fill task paints for. */
  private fillJob: { frame: FrameGeometry; content: PaintContent; group: TileGroup; dpr: number; withRing: boolean } | null = null;
  /** Scratch canvas that receives a freshly painted tile so its raster runs now. */
  private flushCanvas: HTMLCanvasElement | null = null;
  /** Evicted tile canvases waiting for their backing store to be freed off-frame. */
  private readonly releaseQueue: HTMLCanvasElement[] = [];
  private releaseTimer: number | null = null;
  private composeKey = '';
  private currentGroupKey = '';
  private lastFrame: FrameGeometry | null = null;
  private lastGroup: TileGroup | null = null;
  private everComposed = false;
  private lastStats: LandFrameStats = {
    exact: 0,
    placeholder: 0,
    pending: 0,
    painted: 0,
    paintMs: 0,
    recomposed: false,
    scale: 0,
    width: 0,
    height: 0,
  };
  /** Scratch canvas for `renderFullReference` (parity harness). */
  private referenceCanvas: HTMLCanvasElement | null = null;
  private fadeCanvas: HTMLCanvasElement | null = null;
  private fadeStart = 0;
  private fadeMeta: { ox: number; oy: number; wWorld: number; hWorld: number; scale: number } | null = null;

  /** Group key of the last composed frame; read by the dev harnesses for diagnostics. */
  key = '';
  private ox = 0;
  private oy = 0;
  private scale = 0;
  private wWorld = 0;
  private hWorld = 0;

  constructor(land: LandJson) {
    this.boxes = land.polygons.map((rings) => {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      const path = new Path2D();
      const ringBoxes: Box[] = [];
      const ringPaths: Path2D[] = [];
      for (const ring of rings) {
        let rMinX = Infinity;
        let rMinY = Infinity;
        let rMaxX = -Infinity;
        let rMaxY = -Infinity;
        const ringPath = new Path2D();
        for (let i = 0; i < ring.length; i += 2) {
          const x = ring[i];
          const y = ring[i + 1];
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
          if (x < rMinX) rMinX = x;
          if (x > rMaxX) rMaxX = x;
          if (y < rMinY) rMinY = y;
          if (y > rMaxY) rMaxY = y;
          if (i === 0) {
            ringPath.moveTo(x, y);
            path.moveTo(x, y);
          } else {
            ringPath.lineTo(x, y);
            path.lineTo(x, y);
          }
        }
        ringPath.closePath();
        path.closePath();
        ringBoxes.push({ minX: rMinX, minY: rMinY, maxX: rMaxX, maxY: rMaxY });
        ringPaths.push(ringPath);
      }
      return { minX, minY, maxX, maxY, rings, ringBoxes, ringPaths, path };
    });
    this.canvas = document.createElement('canvas');
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas is unavailable');
    this.ctx = ctx;
    // Building the deterministic tree field takes a moment; do it behind the
    // loading screen instead of on the first mid/near zoom.
    this.trees = this.buildTrees();
    // Same for the whole-world placeholder: build it now so a later camera jump never has
    // to wait for it.
    this.ensureThumb(this.lastSeason);
  }

  /** Drop the composed frame; tiles stay cached (they are keyed by content). */
  invalidate(): void {
    this.composeKey = '';
  }

  /** Drop every cached tile; the next draw rebuilds the whole visible set. */
  dropTiles(): void {
    this.clearTiles();
    this.composeKey = '';
  }

  /** Test hook: cap the per-frame rasterisation budget in ms (negative = paint nothing). */
  setFrameBudget(ms: number): void {
    this.frameBudgetMs = Math.max(-1, ms);
  }

  getFrameStats(): LandFrameStats {
    return this.lastStats;
  }

  setBudget(budget: CanvasBudget): void {
    const same = budget.profile === this.budget.profile
      && budget.maxDpr === this.budget.maxDpr
      && budget.maxSide === this.budget.maxSide
      && budget.maxArea === this.budget.maxArea
      && budget.webkit === this.budget.webkit;
    if (same) return;
    this.budget = budget;
    this.clearTiles();
    if (this.canvas.width || this.canvas.height) releaseCanvas(this.canvas);
    if (this.referenceCanvas) {
      releaseCanvas(this.referenceCanvas);
      this.referenceCanvas = null;
    }
    if (this.fadeCanvas) {
      releaseCanvas(this.fadeCanvas);
      this.fadeCanvas = null;
      this.fadeMeta = null;
    }
    this.composeKey = '';
  }

  /** Release all offscreen canvases. */
  destroy(): void {
    if (this.fillTimer !== null) {
      window.clearTimeout(this.fillTimer);
      this.fillTimer = null;
    }
    if (this.releaseTimer !== null) {
      window.clearTimeout(this.releaseTimer);
      this.releaseTimer = null;
    }
    for (const item of this.releaseQueue) releaseCanvas(item);
    this.releaseQueue.length = 0;
    this.fillJob = null;
    if (this.flushCanvas) releaseCanvas(this.flushCanvas);
    this.flushCanvas = null;
    this.clearTiles();
    releaseCanvas(this.canvas);
    if (this.referenceCanvas) releaseCanvas(this.referenceCanvas);
    if (this.fadeCanvas) releaseCanvas(this.fadeCanvas);
    if (this.thumbCanvas) releaseCanvas(this.thumbCanvas);
    this.thumbCanvas = null;
    this.thumbFamily = '';
    this.referenceCanvas = null;
    this.fadeCanvas = null;
    this.fadeMeta = null;
    this.composeKey = '';
  }

  setTerrain(full?: HTMLImageElement, lo?: HTMLImageElement): void {
    this.terrain = full;
    this.terrainLo = lo;
    this.clearTiles();
    this.composeKey = '';
    // The thumbnail bakes the texture, so it has to be rebuilt with the new one.
    this.thumbFamily = '';
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

  // ---------------------------------------------------------------- frame assembly

  /**
   * Compose the land layer for this frame and blit it onto `target`, a DPR-transformed
   * screen context. Visible tiles are reused; the rest are rasterised within
   * `frameBudgetMs` and shown from the nearest other bucket (scaled) until they arrive.
   */
  draw(
    target: CanvasRenderingContext2D,
    cam: Camera,
    dpr: number,
    revision: number,
    season: Season,
    paintStatic?: LayerPainter,
    treeAvoid?: (x: number, y: number) => boolean,
    geoAt?: (x: number, y: number) => { lat: number; lon: number },
    options: LandContentOptions = {},
  ): void {
    const overview = options.overview ?? false;
    const wrap = options.wrap ?? !overview;
    if (options.budgetMs !== undefined) this.frameBudgetMs = Math.max(0, options.budgetMs);
    const frame = this.frameGeometry(cam, dpr, revision, season, overview, wrap);
    const content: PaintContent = { season, overview, withTrees: frame.withTrees, paintStatic, treeAvoid, geoAt };
    if (season !== this.lastSeason) {
      this.lastSeason = season;
      this.ensureThumb(season);
    }
    const groupKey = `${frame.bucket}:${dpr.toFixed(3)}:${frame.scale}:${frame.family}:${revision}`;
    const group = this.ensureGroup(groupKey, frame, dpr);
    this.currentGroupKey = groupKey;
    this.evict();
    const visible = this.listTiles(frame, 0);
    const paintList = this.listTiles(frame, 1);

    // Rasterise missing tiles. A 512 px tile costs 11-34 ms of rasterisation, which cannot
    // fit in a 16 ms frame, so the work runs in its own task (`fillStep`) instead of inside
    // this draw: the frame then only composes cached tiles, and the browser gets the thread
    // back between tiles. `frameBudgetMs === 0` is the test hook that paints synchronously
    // (the parity harness renders a whole frame in one call that way).
    const cold = !this.everComposed;
    let painted = 0;
    let paintMs = 0;
    if (cold || this.frameBudgetMs === 0) {
      const started = performance.now();
      for (const entry of paintList) {
        if (this.tileFor(group, entry.ix, entry.iy) !== undefined) continue;
        this.paintTile(group, frame, content, entry, dpr);
        painted += 1;
        this.rasteriseTile(entry, group);
      }
      paintMs = performance.now() - started;
    } else if (this.frameBudgetMs > 0) {
      this.scheduleFill(frame, content, group, dpr);
    }

    const exact = this.countExact(group, visible);
    const pending = visible.length - exact;

    // Tiles go straight to the screen at integer device positions: no intermediate
    // full-viewport canvas is built or copied on a normal frame.
    const key = `${groupKey}|${frame.originX}|${frame.originY}|${frame.devW}:${frame.devH}`;
    const recomposed = painted > 0 || cold || key !== this.composeKey;
    this.composeKey = key;
    this.everComposed = true;
    this.lastFrame = frame;
    this.lastGroup = group;

    const m = target.getTransform();
    target.save();
    target.setTransform(1, 0, 0, 1, Math.round(m.e), Math.round(m.f));
    this.drawTiles(target, frame, group, visible);
    target.restore();

    this.key = groupKey;
    this.ox = frame.originX / frame.scale;
    this.oy = frame.originY / frame.scale;
    this.scale = frame.scale;
    this.wWorld = frame.devW / frame.scale;
    this.hWorld = frame.devH / frame.scale;
    this.lastStats = {
      exact,
      placeholder: pending,
      pending,
      painted,
      paintMs: Math.round(paintMs * 100) / 100,
      recomposed,
      scale: frame.scale,
      width: frame.devW,
      height: frame.devH,
    };
  }

  /**
   * Paint the same viewport in one pass, without the tile cache or the tile split.
   *
   * The parity harness uses this as the *seam* reference. It cannot be bit-identical to the
   * tiled frame: Chromium evaluates device-space shaders (the terrain texture, the land
   * gradient) in the canvas' own coordinate system, so the same world pixel samples a
   * fraction of a texel differently in two differently-translated canvases. Measured with a
   * tile-free probe: <= 2 of 255 levels on ~1% of pixels, no hard edges (a real seam would
   * show as a one-pixel line with deltas of tens). The bit-exact gate is vs
   * `dropTiles()` + a full re-render through the shipping path.
   */
  renderFullReference(
    cam: Camera,
    dpr: number,
    revision: number,
    season: Season,
    paintStatic?: LayerPainter,
    treeAvoid?: (x: number, y: number) => boolean,
    geoAt?: (x: number, y: number) => { lat: number; lon: number },
    options: LandContentOptions = {},
  ): HTMLCanvasElement {
    const overview = options.overview ?? false;
    const wrap = options.wrap ?? !overview;
    const frame = this.frameGeometry(cam, dpr, revision, season, overview, wrap);
    const content: PaintContent = { season, overview, withTrees: frame.withTrees, paintStatic, treeAvoid, geoAt };
    const canvas = this.referenceCanvas ?? document.createElement('canvas');
    const frameW = frame.devW + EDGE_BLEED * 2;
    const frameH = frame.devH + EDGE_BLEED * 2;
    if (canvas.width !== frameW || canvas.height !== frameH) {
      releaseCanvas(canvas);
      canvas.width = frameW;
      canvas.height = frameH;
    }
    this.referenceCanvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) return canvas;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    this.paintRegion(
      ctx,
      frame.originX - EDGE_BLEED,
      frame.originY - EDGE_BLEED,
      frameW,
      frameH,
      frame.scale,
      frame.zoom,
      dpr,
      content,
    );
    return canvas;
  }

  /**
   * Quantised geometry for a frame. `scale` is snapped so that the world circumference is a
   * whole number of tiles (the MAP_W seam therefore falls on a tile edge), and so that the
   * viewport origin lands on a whole device pixel (tiles blit without resampling).
   */
  private frameGeometry(
    cam: Camera,
    dpr: number,
    revision: number,
    season: Season,
    overview: boolean,
    wrap: boolean,
  ): FrameGeometry {
    const dprKey = Math.max(0.5, dpr);
    const bucket = Math.round(Math.log2(Math.max(1e-4, cam.zoom)) * 10);
    const desired = Math.pow(2, bucket / 10) * dprKey;
    const nx = Math.max(1, Math.round((MAP_W * desired) / TILE_DEV));
    const scale = (nx * TILE_DEV) / MAP_W;
    const ny = Math.max(1, Math.ceil((MAP_H * scale) / TILE_DEV));
    const zoom = scale / dprKey;
    const withTrees = zoom >= 0.62;
    const devW = Math.max(1, Math.round(cam.vw * dprKey));
    const devH = Math.max(1, Math.round(cam.vh * dprKey));
    const originX = Math.round((cam.x - devW / 2 / scale) * scale);
    const originY = Math.round((cam.y - devH / 2 / scale) * scale);
    const family = `${season}:${overview ? 1 : 0}:${withTrees ? 1 : 0}:${wrap ? 1 : 0}`;
    return {
      bucket,
      zoom,
      scale,
      nx,
      ny,
      family,
      revision,
      wrap,
      withTrees,
      originX,
      originY,
      devW,
      devH,
      blitX: 0,
      blitY: 0,
    };
  }

  /** Tiles intersecting the viewport (margin 0) or its one-tile halo (margin 1). */
  private listTiles(frame: FrameGeometry, margin: number): TileRect[] {
    const { originX, originY, devW, devH, nx, ny, scale, wrap } = frame;
    const out: TileRect[] = [];
    const ix0 = Math.floor(originX / TILE_DEV) - margin;
    const ix1 = Math.floor((originX + devW - 1) / TILE_DEV) + margin;
    const iy0 = Math.max(0, Math.floor(originY / TILE_DEV) - margin);
    const iy1 = Math.min(ny - 1, Math.floor((originY + devH - 1) / TILE_DEV) + margin);
    const cx = originX + devW / 2;
    const cy = originY + devH / 2;
    for (let iy = iy0; iy <= iy1; iy += 1) {
      const th = Math.max(1, Math.round(Math.min(TILE_DEV, MAP_H * scale - iy * TILE_DEV)));
      const devY = iy * TILE_DEV - originY;
      for (let ux = ix0; ux <= ix1; ux += 1) {
        if (!wrap && (ux < 0 || ux >= nx)) continue;
        const ix = ((ux % nx) + nx) % nx;
        const devX = ux * TILE_DEV - originX;
        const visible = margin === 0 || (devX + TILE_DEV > 0 && devX < devW && devY + th > 0 && devY < devH);
        out.push({
          ux,
          ix,
          iy,
          devX,
          devY,
          devW: TILE_DEV,
          devH: th,
          dist: Math.hypot(devX + TILE_DEV / 2 - cx, devY + th / 2 - cy),
          visible,
        });
      }
    }
    // On-screen first, then centre-out: after a jump the player must see the viewport
    // resolve before the prefetch ring, and the middle of the screen before its corners.
    out.sort((a, b) => (a.visible === b.visible ? a.dist - b.dist : a.visible ? -1 : 1));
    return out;
  }

  private ensureGroup(key: string, frame: FrameGeometry, dpr: number): TileGroup {
    let group = this.groups.get(key);
    if (!group) {
      group = {
        key,
        bucket: frame.bucket,
        dpr,
        scale: frame.scale,
        nx: frame.nx,
        ny: frame.ny,
        family: frame.family,
        tiles: new Map(),
        used: ++this.seq,
      };
      this.groups.set(key, group);
    }
    group.used = ++this.seq;
    return group;
  }

  private countExact(group: TileGroup, visible: TileRect[]): number {
    let exact = 0;
    for (const entry of visible) if (this.tileFor(group, entry.ix, entry.iy) !== undefined) exact += 1;
    return exact;
  }

  private tileFor(group: TileGroup, ix: number, iy: number): Tile | undefined {
    return group.tiles.get(`${ix}:${iy}`);
  }

  /** Rasterise one tile. Pixels are a pure function of the tile rect and the group. */
  private paintTile(
    group: TileGroup,
    frame: FrameGeometry,
    content: PaintContent,
    entry: TileRect,
    dpr: number,
  ): void {
    const id = `${entry.ix}:${entry.iy}`;
    let tile = group.tiles.get(id);
    const padW = entry.devW + EDGE_BLEED * 2;
    const padH = entry.devH + EDGE_BLEED * 2;
    if (!tile) {
      const canvas = document.createElement('canvas');
      canvas.width = padW;
      canvas.height = padH;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      tile = { canvas, ctx, ix: entry.ix, iy: entry.iy, devW: padW, devH: padH, used: 0 };
      group.tiles.set(id, tile);
      this.cachedArea += padW * padH;
      noteCanvasAllocation('land-tile', padW, padH, padW, padH, this.budget);
    }
    tile.used = ++this.seq;
    group.used = this.seq;
    const ctx = tile.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, tile.devW, tile.devH);
    this.paintRegion(
      ctx,
      entry.ux * TILE_DEV - EDGE_BLEED,
      entry.iy * TILE_DEV - EDGE_BLEED,
      tile.devW,
      tile.devH,
      frame.scale,
      frame.zoom,
      dpr,
      content,
    );
  }

  /** LRU trim down to the tile budget, then drop empty and long-unused groups. */
  /**
   * Keep the cache inside its budget. Whole stale buckets go first, then the least recently
   * used tiles. The group being drawn is never touched: dropping one of its tiles mid-frame
   * would leave a placeholder on screen for a tile that was just rasterised (and on a long
   * camera ride that turned into a repaint loop).
   */
  private evict(): void {
    const cap = Math.max(TILE_DEV * TILE_DEV * 4, this.budget.maxArea * TILE_AREA_RATIO);
    const stale = [...this.groups.values()]
      .filter((group) => group.key !== this.currentGroupKey)
      .sort((a, b) => a.used - b.used);
    for (const group of stale) {
      if (this.cachedArea <= cap * 0.8 && this.groups.size <= 4) break;
      this.dropGroup(group);
    }
    if (this.cachedArea <= cap) return;
    const current = this.groups.get(this.currentGroupKey);
    const all: Array<{ group: TileGroup; id: string; tile: Tile }> = [];
    for (const group of this.groups.values()) {
      if (group === current) continue;
      for (const [id, tile] of group.tiles) all.push({ group, id, tile });
    }
    all.sort((a, b) => a.tile.used - b.tile.used);
    for (const entry of all) {
      if (this.cachedArea <= cap) break;
      entry.group.tiles.delete(entry.id);
      this.cachedArea -= entry.tile.devW * entry.tile.devH;
      this.queueRelease(entry.tile.canvas);
    }
  }

  private dropGroup(group: TileGroup): void {
    for (const tile of group.tiles.values()) {
      this.cachedArea -= tile.devW * tile.devH;
      this.queueRelease(tile.canvas);
    }
    group.tiles.clear();
    this.groups.delete(group.key);
  }

  /**
   * Free an evicted tile's backing store off the frame.
   *
   * `canvas.width = 0` hands the allocation back immediately, and a camera ride evicts a
   * dozen tiles at once: measured 18-25 ms of `draw()` inside one bucket change. Nothing
   * reads an evicted tile again, so the free is deferred to its own task.
   */
  private queueRelease(canvas: HTMLCanvasElement): void {
    this.releaseQueue.push(canvas);
    if (this.releaseTimer !== null) return;
    this.releaseTimer = window.setTimeout(() => {
      this.releaseTimer = null;
      for (const item of this.releaseQueue) releaseCanvas(item);
      this.releaseQueue.length = 0;
    }, 0);
  }

  private clearTiles(): void {
    for (const group of [...this.groups.values()]) this.dropGroup(group);
    this.cachedArea = 0;
  }

  // ---------------------------------------------------------------- composition

  /**
   * Blit visible tiles into a device-space context. A tile that is missing is covered by the
   * same world rect from the closest other bucket (scaled), or by the last snapshot, so a
   * frame is never blank and never shows the wrong area. `off` is the context's device
   * origin inside the lattice (EDGE_BLEED for a snapshot canvas, 0 for the screen).
   */
  private composeInto(
    ctx: CanvasRenderingContext2D,
    frame: FrameGeometry,
    group: TileGroup,
    visible: TileRect[],
    off: number,
  ): void {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';

    const missing: TileRect[] = [];
    for (const entry of visible) {
      if (this.tileFor(group, entry.ix, entry.iy) === undefined) missing.push(entry);
    }
    // A placeholder must never leave a hole: the whole viewport is flooded with the same
    // vertical sea gradient the ocean backdrop uses, then covered by the (rough) world
    // thumbnail and the closest bucket's tiles, and only then are the exact tiles drawn on
    // top. Doing it once per frame rather than once per missing tile matters: 12 missing
    // tiles × 6 source buckets × ~60 tiles each was 86 ms of blits per frame on a bucket
    // change (report 86 §5), and the exact tiles cover whatever the wash got wrong.
    if (missing.length > 0) {
      // One clip for the whole frame. Doing the wash per missing tile cost 86 ms; doing it
      // unclipped repaints the full viewport on every frame that has a single tile missing,
      // which measured worse than the mask itself. Clipped, the cost follows the missing area.
      const holes = new Path2D();
      for (const entry of missing) holes.rect(entry.devX + off, entry.devY + off, entry.devW, entry.devH);
      ctx.save();
      ctx.clip(holes);
      const sea = ctx.createLinearGradient(0, off, 0, off + frame.devH);
      sea.addColorStop(0, '#7fe0ff');
      sea.addColorStop(0.35, '#59c8f4');
      sea.addColorStop(0.72, '#2fa5e6');
      sea.addColorStop(1, '#2289ce');
      ctx.fillStyle = sea;
      ctx.fillRect(off, off, frame.devW, frame.devH);
      const thumb = this.ensureThumb();
      if (thumb) this.blitThumb(ctx, thumb, frame, off);
      // Only the closest other bucket is worth washing with: the thumbnail already covers
      // everything, and stacking every cached bucket put 180 scaled blits in a frame.
      let source: TileGroup | null = null;
      let bestCost = Infinity;
      for (const g of this.groups.values()) {
        if (g.key === group.key || g.tiles.size === 0) continue;
        const cost = (g.family === group.family ? 0 : 1000) + Math.abs(g.bucket - frame.bucket);
        if (cost < bestCost) {
          bestCost = cost;
          source = g;
        }
      }
      if (source) {
        const worldDevW = MAP_W * frame.scale;
        for (const tile of source.tiles.values()) {
          const baseX = (tile.ix * TILE_DEV) / source.scale * frame.scale - frame.originX;
          const devY = (tile.iy * TILE_DEV) / source.scale * frame.scale - frame.originY;
          const devW = (tile.devW / source.scale) * frame.scale;
          const devH = (tile.devH / source.scale) * frame.scale;
          if (devY + devH <= 0 || devY >= frame.devH) continue;
          // A world-anchored tile may have to appear one world copy either side.
          for (let k = frame.wrap ? -1 : 0; k <= (frame.wrap ? 1 : 0); k += 1) {
            const devX = baseX + k * worldDevW;
            if (devX + devW <= 0 || devX >= frame.devW) continue;
            ctx.drawImage(
              tile.canvas,
              EDGE_BLEED,
              EDGE_BLEED,
              tile.devW - EDGE_BLEED * 2,
              tile.devH - EDGE_BLEED * 2,
              devX + off,
              devY + off,
              devW,
              devH,
            );
          }
        }
      }
      ctx.restore();
    }

    for (const entry of visible) {
      const tile = this.tileFor(group, entry.ix, entry.iy);
      if (tile) this.blitTile(ctx, entry, tile, off);
    }
  }

  /**
   * Copy a tile's inner rect (its own canvas edge never affects the destination).
   */
  private blitTile(ctx: CanvasRenderingContext2D, entry: TileRect, tile: Tile, off: number): void {
    ctx.drawImage(
      tile.canvas,
      EDGE_BLEED,
      EDGE_BLEED,
      entry.devW,
      entry.devH,
      entry.devX + off,
      entry.devY + off,
      entry.devW,
      entry.devH,
    );
  }

  /**
   * Queue a background tile fill for this frame. Coalesced: at most one task is pending,
   * and it always paints for the most recent frame.
   */
  private scheduleFill(frame: FrameGeometry, content: PaintContent, group: TileGroup, dpr: number): void {
    this.fillJob = { frame, content, group, dpr, withRing: true };
    if (this.fillTimer !== null) return;
    this.fillTimer = window.setTimeout(() => {
      this.fillTimer = null;
      this.fillStep();
    }, 0);
  }

  /**
   * Paint the next slice of missing tiles in its own task, then hand the thread back.
   *
   * Only reached from `scheduleFill`, never from `draw`: the point is that a frame never
   * pays for a tile's rasterisation, so `map.draw` stays at the compose cost (measured
   * 2.5 ms for 15 tiles) and the 11-34 ms tile raster lands in short separate tasks the
   * browser can schedule around input, layout and style.
   */
  private fillStep(): void {
    const job = this.fillJob;
    this.fillJob = null;
    if (!job) return;
    const { frame, content, group, dpr, withRing } = job;
    if (this.groups.get(this.currentGroupKey) !== group) return; // camera moved on
    const started = performance.now();
    let painted = 0;
    let remaining = 0;
    for (const entry of this.listTiles(frame, withRing ? 1 : 0)) {
      if (this.tileFor(group, entry.ix, entry.iy) !== undefined) continue;
      if (painted > 0 && performance.now() - started >= FILL_TASK_MS) {
        remaining += 1;
        continue;
      }
      this.paintTile(group, frame, content, entry, dpr);
      painted += 1;
      this.rasteriseTile(entry, group);
    }
    // The render loop only keeps asking for frames while a *visible* tile is missing, so
    // keep going from here for the prefetch ring and for the next visible slice.
    if (remaining > 0) this.scheduleFill(frame, content, group, dpr);
  }

  /**
   * Force a tile's raster now, off the frame that will use it.
   *
   * A 2D canvas keeps a display list: `paintRegion` only records commands, and the ~10 ms
   * of rasterisation lands on the first frame that *uses* the tile. Left until the compose
   * step, a bucket change therefore rasterised 12 tiles inside one 130 ms task. Blitting
   * into a scratch canvas pays the same raster but inside this task's budget instead.
   */
  private rasteriseTile(entry: TileRect, group: TileGroup): void {
    const tile = this.tileFor(group, entry.ix, entry.iy);
    if (!tile) return;
    let scratch = this.flushCanvas;
    if (!scratch) {
      scratch = document.createElement('canvas');
      this.flushCanvas = scratch;
    }
    if (scratch.width !== tile.devW || scratch.height !== tile.devH) {
      scratch.width = tile.devW;
      scratch.height = tile.devH;
    }
    const ctx = scratch.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(tile.canvas, 0, 0);
  }

  private drawTiles(
    target: CanvasRenderingContext2D,
    frame: FrameGeometry,
    group: TileGroup,
    visible: TileRect[],
  ): void {
    this.composeInto(target, frame, group, visible, 0);
  }

  /**
   * Compose the frame into `this.canvas` (device size + bleed ring) and return it. Used by
   * the parity harness and the season crossfade; normal frames draw tiles directly.
   */
  snapshotFrame(): HTMLCanvasElement {
    if (!this.lastFrame || !this.lastGroup) return this.canvas;
    const frame = this.lastFrame;
    const frameW = frame.devW + EDGE_BLEED * 2;
    const frameH = frame.devH + EDGE_BLEED * 2;
    if (this.canvas.width !== frameW || this.canvas.height !== frameH) {
      releaseCanvas(this.canvas);
      this.canvas.width = frameW;
      this.canvas.height = frameH;
      noteCanvasAllocation('land', frameW, frameH, frameW, frameH, this.budget);
    }
    this.ctx.clearRect(0, 0, frameW, frameH);
    this.composeInto(this.ctx, frame, this.lastGroup, this.listTiles(frame, 0), EDGE_BLEED);
    return this.canvas;
  }

  /**
   * One low-resolution land raster for the whole world, built once per season. It is the
   * last-resort placeholder: after a warp or a big follow jump there may be no cached tile
   * of any bucket for the new area, and a coarse world map beats a hole.
   */
  private ensureThumb(season: Season = this.lastSeason): HTMLCanvasElement | null {
    if (this.thumbCanvas && this.thumbFamily === season) return this.thumbCanvas;
    const scale = THUMB_DEV / MAP_W;
    const w = THUMB_DEV;
    const h = Math.max(1, Math.round(MAP_H * scale));
    const canvas = this.thumbCanvas ?? document.createElement('canvas');
    if (canvas.width !== w || canvas.height !== h) {
      releaseCanvas(canvas);
      canvas.width = w;
      canvas.height = h;
      noteCanvasAllocation('land-thumb', w, h, w, h, this.budget);
    }
    this.thumbCanvas = canvas;
    this.thumbFamily = season;
    const ctx = canvas.getContext('2d');
    if (!ctx) return canvas;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const palette = SEASON_LAND[season] ?? SEASON_LAND.spring;
    const path = new Path2D();
    for (const box of this.boxes) path.addPath(box.path);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    const grad = ctx.createLinearGradient(0, 0, 0, MAP_H);
    grad.addColorStop(0, palette.top);
    grad.addColorStop(0.45, palette.mid);
    grad.addColorStop(1, palette.bottom);
    ctx.fillStyle = grad;
    ctx.fill(path, 'evenodd');
    const tex = this.terrainLo ?? this.terrain;
    if (tex && tex.naturalWidth > 0) {
      ctx.save();
      ctx.clip(path, 'evenodd');
      ctx.drawImage(tex, 0, 0, MAP_W, MAP_H);
      ctx.globalCompositeOperation = 'soft-light';
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = palette.mid;
      ctx.fillRect(0, 0, MAP_W, MAP_H);
      ctx.restore();
    }
    ctx.strokeStyle = palette.outline;
    ctx.lineWidth = Math.max(1, 1.2 / scale);
    ctx.stroke(path);
    return canvas;
  }

  /** Blit the world thumbnail over the whole viewport, once per wrap copy it touches. */
  private blitThumb(
    ctx: CanvasRenderingContext2D,
    thumb: HTMLCanvasElement,
    frame: FrameGeometry,
    off: number,
  ): void {
    const wx0 = frame.originX / frame.scale;
    const wx1 = (frame.originX + frame.devW) / frame.scale;
    const first = frame.wrap ? Math.floor(wx0 / MAP_W) : 0;
    const last = frame.wrap ? Math.floor(wx1 / MAP_W) : 0;
    const devW = MAP_W * frame.scale;
    const devH = MAP_H * frame.scale;
    const y0 = -frame.originY + off;
    for (let k = first; k <= last; k += 1) {
      ctx.drawImage(thumb, k * devW - frame.originX + off, y0, devW, devH);
    }
  }

  // ---------------------------------------------------------------- painting

  /**
   * Fill and stroke geometry for one region.
   *
   * `fill` holds every polygon ring that can change a pixel inside the region, closed, so
   * its even-odd fill equals what a whole-world path would paint there. `stroke` holds only
   * the boundary runs that reach the region: stroking the world-spanning coastline for a
   * 512 px tile made Chromium walk the entire path (measured ~7 ms of the ~18 ms tile,
   * report 86 §5-1). A run is cut where a segment misses the region by `pad`, and the cut
   * is extended by that segment, so the caps the cutter introduces land outside every pixel
   * the tile keeps (`pad` is wider than the widest stroke) and the tile stays identical.
   */
  private regionPaths(
    ox: number,
    oy: number,
    wWorld: number,
    hWorld: number,
    pad: number,
    kMin: number,
    kMax: number,
  ): { fill: Path2D | null; stroke: Path2D | null } {
    const x0 = ox - pad;
    const y0 = oy - pad;
    const x1 = ox + wWorld + pad;
    const y1 = oy + hWorld + pad;
    let fill: Path2D | null = null;
    let stroke: Path2D | null = null;
    for (let k = kMin; k <= kMax; k += 1) {
      const shift = k * MAP_W;
      const move = shift === 0 ? undefined : { a: 1, b: 0, c: 0, d: 1, e: shift, f: 0 };
      for (const box of this.boxes) {
        if (box.maxX + shift < x0 || box.minX + shift > x1) continue;
        if (box.maxY < y0 || box.minY > y1) continue;
        for (let r = 0; r < box.rings.length; r += 1) {
          const rb = box.ringBoxes[r];
          if (rb.maxX + shift < x0 || rb.minX + shift > x1) continue;
          if (rb.maxY < y0 || rb.minY > y1) continue;
          if (!fill) fill = new Path2D();
          fill.addPath(box.ringPaths[r], move);
          stroke = this.addStrokeRuns(stroke, box.rings[r], shift, x0, y0, x1, y1);
        }
      }
    }
    return { fill, stroke };
  }

  /**
   * Append the open runs of one ring that come within `x0..x1 × y0..y1`, where the box is
   * the region already widened by `pad`. Returns the path (allocated on the first run).
   */
  private addStrokeRuns(
    path: Path2D | null,
    ring: number[],
    shift: number,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
  ): Path2D | null {
    const count = ring.length >> 1;
    if (count < 3) return path;
    // The segment from vertex `s` to `s + 1`, both wrapped, expanded by nothing: a
    // segment that misses this box cannot paint inside it.
    const touches = (s: number): boolean => {
      const i = (s % count) * 2;
      const j = ((s + 1) % count) * 2;
      const ax = ring[i] + shift;
      const ay = ring[i + 1];
      const bx = ring[j] + shift;
      const by = ring[j + 1];
      return (ax >= x0 || bx >= x0) && (ax <= x1 || bx <= x1) && (ay >= y0 || by >= y0) && (ay <= y1 || by <= y1);
    };
    // Start on a segment that misses, so a run never wraps past the ring's first vertex.
    let start = -1;
    for (let s = 0; s < count; s += 1) {
      if (!touches(s)) {
        start = s;
        break;
      }
    }
    let out = path;
    if (start < 0) {
      // The whole ring is near: keep the closed contour (joins stay as they were).
      if (!out) out = new Path2D();
      out.moveTo(ring[0] + shift, ring[1]);
      for (let i = 1; i < count; i += 1) out.lineTo(ring[i * 2] + shift, ring[i * 2 + 1]);
      out.closePath();
      return out;
    }
    let open = false;
    for (let c = 0; c < count; c += 1) {
      const s = (start + c) % count;
      if (!touches(s)) {
        open = false;
        continue;
      }
      if (!out) out = new Path2D();
      const next = ((s + 1) % count) * 2;
      if (!open) {
        // One segment of slack on both ends puts the butt cap outside the kept pixels.
        const prior = ((s - 1 + count) % count) * 2;
        out.moveTo(ring[prior] + shift, ring[prior + 1]);
        out.lineTo(ring[s * 2] + shift, ring[s * 2 + 1]);
        open = true;
      }
      out.lineTo(ring[next] + shift, ring[next + 1]);
    }
    return out;
  }

  /**
   * Paint one device rect of the world. `devX/devY` are its top-left in the world-anchored
   * device lattice (integers), so a tile and a full-region paint of the same rect issue the
   * same draw commands up to an integer translation and therefore land on the same pixels.
   */
  private paintRegion(
    ctx: CanvasRenderingContext2D,
    devX: number,
    devY: number,
    devW: number,
    devH: number,
    scale: number,
    zoom: number,
    dpr: number,
    content: PaintContent,
  ): void {
    const wWorld = devW / scale;
    const hWorld = devH / scale;
    const ox = devX / scale;
    const oy = devY / scale;
    const x1 = ox + wWorld;
    const palette = SEASON_LAND[content.season];
    const haloDev = Math.max(4, Math.min(12, 4 * zoom)) * dpr;
    const outlineDev = Math.max(2, Math.min(8, 2.1 * scale));
    const shadowDev = Math.max(1, 3.2 * scale);
    const pad = (haloDev + shadowDev + outlineDev + 6) / scale;
    const kMin = Math.floor((ox - MAP_W) / MAP_W);
    const kMax = Math.ceil(x1 / MAP_W);
    const geometry = this.regionPaths(ox, oy, wWorld, hWorld, pad, kMin, kMax);
    const path = geometry.fill;
    const strokePath = geometry.stroke;

    ctx.save();
    ctx.setTransform(scale, 0, 0, scale, -devX, -devY);
    if (path) {
      const grad = ctx.createLinearGradient(0, 0, 0, MAP_H);
      grad.addColorStop(0, palette.top);
      grad.addColorStop(0.45, palette.mid);
      grad.addColorStop(1, palette.bottom);
      if (strokePath) {
        // shallow-water halo just outside the coastline
        ctx.save();
        ctx.strokeStyle = 'rgba(146, 236, 255, 0.5)';
        ctx.lineWidth = haloDev / scale;
        ctx.lineJoin = 'round';
        ctx.stroke(strokePath);
        ctx.restore();
      }
      // A flat offset silhouette is much cheaper than a blurred canvas shadow
      // and reads as a soft coastal drop shadow at every zoom.
      ctx.save();
      ctx.translate(shadowDev / scale, shadowDev / scale);
      ctx.fillStyle = 'rgba(3, 48, 72, 0.28)';
      ctx.fill(path, 'evenodd');
      ctx.restore();
      ctx.fillStyle = grad;
      ctx.fill(path, 'evenodd');
      const tex = zoom <= 0.22 ? this.terrainLo ?? this.terrain : this.terrain ?? this.terrainLo;
      if (tex && tex.naturalWidth > 0) {
        ctx.save();
        ctx.clip(path, 'evenodd');
        ctx.drawImage(tex, 0, 0, MAP_W, MAP_H);
        // Keep the concept-art saturation on top of the pale topographic texture.
        ctx.globalCompositeOperation = 'soft-light';
        ctx.globalAlpha = 0.5;
        ctx.fillStyle = palette.mid;
        ctx.fillRect(ox - 2, oy - 2, wWorld + 4, hWorld + 4);
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
        ctx.restore();
      }
      if (strokePath) {
        ctx.save();
        ctx.strokeStyle = palette.outline;
        ctx.lineWidth = outlineDev / scale;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.stroke(strokePath);
        ctx.restore();
      }
    }
    if (content.withTrees) {
      if (!this.trees) this.trees = this.buildTrees();
      this.drawTrees(ctx, devX, devY, devW, devH, scale, zoom >= 1.45 ? 0.25 : 0.6, content);
    }
    if (path && (content.season === 'winter' || content.season === 'summer')) {
      this.drawSnow(ctx, path, content.season);
    }
    ctx.restore();

    if (content.paintStatic) {
      const toCanvas = (wx: number, wy: number): [number, number] => [wx * scale - devX, wy * scale - devY];
      content.paintStatic({
        ctx,
        toCanvas,
        scale,
        dpr,
        ox,
        oy,
        wWorld,
        hWorld,
        zoom,
        overview: content.overview,
      });
    }
  }
  private drawSnow(ctx: CanvasRenderingContext2D, path: Path2D, season: Season): void {
    const north = season === 'winter';
    const snowY = project(0, north ? 35 : -35)[1];
    const fade = 900;
    ctx.save();
    ctx.clip(path, 'evenodd');
    if (north) {
      const g = ctx.createLinearGradient(0, snowY - fade, 0, snowY);
      g.addColorStop(0, 'rgba(255,255,255,0.72)');
      g.addColorStop(0.7, 'rgba(255,255,255,0.5)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(-MAP_W, -MAP_H, MAP_W * 3, snowY + MAP_H);
    } else {
      const g = ctx.createLinearGradient(0, MAP_H, 0, snowY);
      g.addColorStop(0, 'rgba(255,255,255,0.72)');
      g.addColorStop(0.7, 'rgba(255,255,255,0.5)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(-MAP_W, snowY, MAP_W * 3, MAP_H * 2 - snowY);
    }
    ctx.restore();
  }

  private drawTrees(
    ctx: CanvasRenderingContext2D,
    devX: number,
    devY: number,
    devW: number,
    devH: number,
    scale: number,
    minRank: number,
    content: PaintContent,
  ): void {
    const trees = this.trees;
    if (!trees) return;
    const eq = project(0, 0)[1];
    const margin = 56;
    const x0 = (devX - margin) / scale;
    const x1 = (devX + devW + margin) / scale;
    const y0 = (devY - margin) / scale;
    const y1 = (devY + devH + margin) / scale;
    for (let k = -1; k <= 1; k += 1) {
      const shift = k * MAP_W;
      for (const t of trees) {
        if (t.rank < minRank) continue;
        const tx = t.x + shift;
        if (tx < x0 || tx > x1 || t.y < y0 || t.y > y1) continue;
        if (content.treeAvoid && content.treeAvoid(t.x, t.y)) continue;
        if (t.lat === undefined) {
          const geo = (content.geoAt && content.geoAt(t.x, t.y)) || { lat: 0, lon: 0 };
          t.lat = geo.lat;
          t.lon = geo.lon;
        }
        const lat = t.lat;
        const lon = t.lon ?? 0;
        // Barren ground (ice sheet, desert) must hide the whole tree, trunk
        // included: drawing the trunk first left brown sticks on Greenland.
        if (isDesertBox(lat, lon) || this.isBarrenAt(t.x, t.y)) continue;
        const cx = tx * scale - devX;
        const cy = t.y * scale - devY;
        const s = t.size * scale;
        // trunk
        ctx.fillStyle = '#7a4c2b';
        ctx.beginPath();
        ctx.roundRect(cx - s * 0.16, cy - s * 0.1, s * 0.32, s * 0.75, s * 0.12);
        ctx.fill();
        // crown: two overlapping circles plus a highlight
        const crown = s * (0.72 + t.tint * 0.16);
        const tropical = Math.abs(lat) < 23;
        const hemi = tropical ? 'summer' : t.y < eq ? content.season : oppositeSeason(content.season);
        const colors = SEASON_TREES[hemi];
        const base = t.tint > 0.66 ? colors[0] : t.tint > 0.33 ? colors[1] : colors[2];
        ctx.fillStyle = !tropical && content.season === 'winter' && Math.abs(lat) > 35 ? '#eaf2e6' : base;
        ctx.beginPath();
        ctx.arc(cx, cy - s * 0.75, crown, 0, Math.PI * 2);
        ctx.arc(cx - crown * 0.65, cy - s * 0.45, crown * 0.7, 0, Math.PI * 2);
        ctx.arc(cx + crown * 0.63, cy - s * 0.43, crown * 0.68, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = content.season === 'autumn' ? 'rgba(255, 230, 150, 0.6)' : 'rgba(235, 255, 210, 0.55)';
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

  // ---------------------------------------------------------------- season crossfade

  /** Snapshot the current land look so MapView can crossfade it out. */
  beginSeasonTransition(now: number): void {
    if (this.scale <= 0 || !this.everComposed) return;
    const snapshot = this.snapshotFrame();
    if (snapshot.width <= 1) return;
    const innerW = Math.max(1, snapshot.width - EDGE_BLEED * 2);
    const innerH = Math.max(1, snapshot.height - EDGE_BLEED * 2);
    const c = this.fadeCanvas ?? document.createElement('canvas');
    if (c.width !== innerW || c.height !== innerH) {
      releaseCanvas(c);
      c.width = innerW;
      c.height = innerH;
    } else {
      const old = c.getContext('2d');
      if (!old) return;
      old.setTransform(1, 0, 0, 1, 0, 0);
      old.clearRect(0, 0, c.width, c.height);
    }
    noteCanvasAllocation('land-fade', c.width, c.height, innerW, innerH, this.budget);
    const g = c.getContext('2d');
    if (!g) return;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.drawImage(snapshot, EDGE_BLEED, EDGE_BLEED, innerW, innerH, 0, 0, innerW, innerH);
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
    const screenX = cam.vw / 2 + wrapDx(cam.x, meta.ox + meta.wWorld / 2) * cam.zoom - drawW / 2;
    const screenY = cam.vh / 2 + (meta.oy + meta.hWorld / 2 - cam.y) * cam.zoom - drawH / 2;
    target.save();
    target.globalAlpha = Math.max(0, alpha);
    if (meta.wWorld >= MAP_W - 0.5) {
      const first = Math.floor((0 - screenX) / drawW);
      const last = Math.floor((cam.vw - screenX) / drawW);
      for (let k = first; k <= last; k += 1) {
        target.drawImage(canvas, screenX + k * drawW, screenY, drawW, drawH);
      }
    } else {
      target.drawImage(canvas, screenX, screenY, drawW, drawH);
    }
    target.restore();
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
