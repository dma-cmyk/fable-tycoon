// Canvas world-map renderer. See docs/UI.md §5 for the public API.
//
// Coordinate model: world units are the Miller projection units from core/geo. The camera
// stores its centre in map units and its zoom in CSS px per map unit. Horizontal wrap is
// handled by always projecting through wrapDx(), so no drawing code needs seam special cases.

import { MAP_H, MAP_W, project, wrapDx, wrapX } from '../core/geo';
import { REALMS, REALM_H, REALM_W } from '../core/realm';
import realmCitiesData from '../data/realms.json';
import type {
  BoardNode,
  Character,
  City,
  EmoteDef,
  GameData,
  RealmId,
  MoveOption,
  SquareKind,
} from '../core/types';
import { Camera, easeInOutCubic } from './camera';
import {
  HIT_DURATION_MS,
  drawEmoteFx,
  drawEmoteIcon,
  drawEmoteBackdrop,
  drawHitFlash,
  drawProjectile,
  emoteDuration,
  tokenEmoteTransform,
} from './emotes';
import { LandLayer, OceanBackdrop, oppositeSeason, seasonForMonth } from './land';
import type { LayerTransform, Season } from './land';
import type { PublicState } from '../core/engine';
import { AmbientWorld } from './ambient';
import { RectGrid } from './grid';
import {
  airLaneControl,
  chooseRecommended,
  hopDistances,
  lanePointAt,
  routeModeOf,
  vehicleForStep,
  type GraphEdge,
  type RouteMode,
} from './routes';
import {
  LabelFade,
  bucketZoom,
  placeLabels,
  rectsOverlap,
  zoomBucket,
  type LabelItem,
  type Rect,
  type SceneDisc,
  type SceneSegment,
} from './labels';
import { drawVehicle, vehicleMetrics, type VehicleKind } from './vehicles';
import { resolveCancelledToken, shouldCancelForSnapshot } from './mapState';
import {
  detectCanvasBudget,
  fitBackingStore,
  fitCanvasSize,
  getLargestCanvasAllocation,
  noteCanvasAllocation,
  releaseCanvas,
  type CanvasAllocation,
  type CanvasBudget,
} from './canvasBudget';

export interface LandJson {
  w: number;
  h: number;
  /** polygons → rings → flat [x,y,...]; holes are represented by extra rings. */
  polygons: number[][][];
}

export interface RiverData { w: number; h: number; rivers: Array<{ rank?: number; w?: number; pts: number[]; name?: string; nameJa?: string }> }
export interface LakeData { w: number; h: number; lakes: Array<{ rank?: number; name?: string; nameJa?: string; rings: number[][] }> }
export interface BorderData { w: number; h: number; lines: number[][] }
export interface MapArtLabel {
  text?: string;
  nameJa?: string;
  /** Hiragana reading of `text`, present only when the name contains kanji. */
  kana?: string;
  x: number;
  y: number;
  kind?: 'ocean' | 'continent' | 'country' | 'river' | 'lake' | 'sea' | string;
  size?: number;
  minZoom?: number;
  maxZoom?: number;
  rotate?: number;
  angle?: number;
}
export type LabelData = MapArtLabel[];
export interface MapArtData { rivers?: RiverData; lakes?: LakeData; borders?: BorderData; labels?: LabelData }

export interface MapAssets {
  land: LandJson;
  chars: Map<string, HTMLImageElement>;
  landmarks: Map<string, HTMLImageElement>;
  /** piper1..3 etc. Optional so callers may construct the three documented maps only. */
  npcs?: Map<string, HTMLImageElement>;
  /** train/express/bullet_train/ferry/plane/rocket/carpet/sailboat, side view facing right. */
  vehicles?: Map<string, HTMLImageElement>;
  /** Optional expression variants; base sprite is used when missing. */
  joy?: Map<string, HTMLImageElement>;
  sad?: Map<string, HTMLImageElement>;
  /** Realm background images (heaven/hell/space). */
  realms?: Map<RealmId, HTMLImageElement>;
  /** Terrain and town stamps. */
  stamps?: Map<string, HTMLImageElement>;
  /** MapArt terrain texture (full/lo). */
  terrain?: HTMLImageElement;
  terrainLo?: HTMLImageElement;
  mapArt?: MapArtData;
}

export interface FrameStats {
  avgMs: number;
  p95Ms: number;
  maxMs: number;
  fps: number;
  frames: number;
}

export interface SafeArea {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** CSS-pixel rectangle relative to the canvas top-left. */
export interface MapLabelObstacle {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface MoveOptionHooks {
  /** Selection only. `null` means the map was tapped empty. Never confirms. */
  onSelect?: (nodeId: string | null) => void;
  onConfirm?: (nodeId: string) => void;
  /** Optional numbers matching the UI list; defaults to 1..n. */
  numbers?: number[];
}

/** Shared square-kind chip styling for map pins and UI option lists. */
export interface MoveKindChip {
  color: string;
  symbol: string;
  label: string;
}

/** Lightweight movement state for the HUD's remaining-steps chip. */
export interface MoveProgress {
  playerId: number;
  path: string[];
  stepIndex: number;
  remaining: number;
  vehicle: string | null;
  nextNodeId: string | null;
}

interface CityEntry {
  city: City;
  node: BoardNode;
}

interface DrawEdge {
  ax: number;
  ay: number;
  dx: number;
  dy: number;
  mode: RouteMode;
}

interface TokenRuntime {
  playerId: number;
  nodeId: string;
}

interface ActiveEmote {
  playerId: number;
  def: EmoteDef;
  targetId: number | null;
  start: number;
  duration: number;
  hitTriggered: boolean;
  resolve: () => void;
}

interface QueuedEmote {
  def: EmoteDef;
  targetId: number | null;
  resolve: () => void;
}

interface MoveAnim {
  playerId: number;
  startNode: string;
  path: string[];
  msPerStep: number;
  start: number;
  dice: number;
  resolve: () => void;
}

export type WarpVia = 'plane' | 'rocket' | 'carpet' | 'event' | 'tornado' | 'realm';

interface WarpAnim {
  playerId: number;
  fromNode: string;
  toNode: string;
  start: number;
  duration: number;
  via: WarpVia;
  landed: boolean;
  resolve: () => void;
}

interface FloatText {
  nodeId: string;
  text: string;
  color: string;
  start: number;
}

interface BubbleState {
  text: string;
  until: number;
}

interface TokenLayout {
  playerId: number;
  x: number;
  y: number;
  worldX: number;
  worldY: number;
  fanX: number;
  hopPx: number;
  idle: boolean;
  height: number;
  facing: number;
  moving: boolean;
  vehicle: VehicleKind | null;
  stepFrac: number;
  stepIndex: number;
  switchPoof: boolean;
  warping: WarpVia | null;
  tilt: number;
  badge: boolean;
  badgeIndex: number;
  badgeCount: number;
  anchorX: number;
  anchorY: number;
  nodeId: string | null;
  switchAt: number;
}

export type Mood = 'joy' | 'sad' | 'neutral';
export type CelebrateKind = 'buy' | 'monopoly' | 'goal' | 'bad';

interface Celebration {
  nodeId: string;
  kind: CelebrateKind;
  start: number;
  duration: number;
}

interface MoodState {
  mood: 'joy' | 'sad';
  until: number;
}

interface CityVis {
  entry: CityEntry;
  x: number;
  y: number;
}

/** Map-art name resolved for the active zoom bucket (stable, cached). */
interface ArtLabelPlan {
  id: string;
  /** Anchor in world units. */
  ax: number;
  ay: number;
  /** Box offset from the anchor, CSS px at the bucket zoom. */
  dx: number;
  dy: number;
  w: number;
  h: number;
  fs: number;
  text: string;
  kana: string | null;
  kanaFs: number;
  water: boolean;
  rotate: number;
  /** Character layout for water names, resolved once per bucket. */
  chars: Array<{ ch: string; x: number }> | null;
  strokeWidth: number;
  fill: string;
}

/** City name box resolved for the active zoom bucket (stable, cached). */
interface CityLabelPlan {
  dx: number;
  dy: number;
  w: number;
  h: number;
  fs: number;
  kana: string | null;
  kanaFs: number;
  text: string;
  /** Chosen slot for this bucket; -1 = crowded, drawn only when it is a priority label. */
  slot: number;
}

/** A label box drawn this frame, with the anchor it hangs off (QA sampling). */
interface DrawnLabel {
  id: string;
  rect: Rect;
  ax: number;
  ay: number;
}

const SEAT_COLORS = ['#e63946', '#2089c8', '#e08a1e', '#7c5cff'];
const TAU = Math.PI * 2;
const LABEL_FONT = '"M PLUS Rounded 1c", "Hiragino Maru Gothic ProN", "Noto Sans JP", sans-serif';

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function edgeKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function insideRect(x: number, y: number, r: Rect): boolean {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

/** Hiragana reading stored next to a kanji city name (shared data contract). */
function cityKana(city: City): string | null {
  const kana = city.nameKana?.trim();
  if (!kana || kana === city.nameJa) return null;
  return kana;
}

function labelKana(label: MapArtLabel, text: string): string | null {
  const kana = label.kana?.trim();
  if (!kana || kana === text) return null;
  return kana;
}

function splitLines(text: string, maxChars: number): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const chars = Array.from(raw);
    if (chars.length === 0) {
      out.push('');
      continue;
    }
    for (let i = 0; i < chars.length; i += maxChars) {
      out.push(chars.slice(i, i + maxChars).join(''));
    }
  }
  return out.slice(0, 6);
}

export class MapView {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly assets: MapAssets;
  private readonly worldCamera = new Camera(MAP_W, MAP_H, true);
  private readonly realmCameras = new Map<RealmId, Camera>();
  private view: RealmId | 'world' = 'world';
  private get camera(): Camera {
    if (this.view === 'world') return this.worldCamera;
    return this.realmCamera(this.view);
  }
  private readonly ocean = new OceanBackdrop();
  private readonly landLayer: LandLayer;

  private readonly nodeById = new Map<string, BoardNode>();
  private readonly cityEntries: CityEntry[] = [];
  private readonly allCityEntries: CityEntry[] = [];
  private readonly realmCityEntries = new Map<RealmId, CityEntry[]>();
  private readonly worldNodes: BoardNode[] = [];
  private readonly realmNodes = new Map<RealmId, BoardNode[]>();
  private readonly realmEdges = new Map<RealmId, DrawEdge[]>();
  private readonly terrain: Array<{ x: number; y: number; kind: string; size: number }> = [];
  private readonly avoidGrid = new RectGrid<true>(64);
  private readonly geoGrid = new RectGrid<{ lat: number; lon: number }>(128);
  private readonly cityNodeId = new Map<string, string>();
  private readonly characterById = new Map<string, Character>();
  private readonly edges: DrawEdge[] = [];
  private readonly edgeModes = new Map<string, RouteMode>();
  private readonly airNodes = new Set<string>();
  private readonly graphEdges: GraphEdge[] = [];
  private destinationNodeIdCache: { nodeId: string; distances: Map<string, number> } | null = null;
  private readonly warpNodes: BoardNode[] = [];
  private readonly ambient: AmbientWorld;

  private state: PublicState | null = null;
  private tokens: TokenRuntime[] = [];
  private playerColors: string[] = [];
  private ownership = new Map<string, { counts: number[]; total: number; monopoly: number }>();
  private destinationNodeId: string | null = null;
  private staticRevision = 0;
  private month = 4;
  private season: Season = seasonForMonth(4);
  private seasonTransitionStart = 0;
  private initialCameraDone = false;
  private lastCurrent = -1;
  private manualViewUntil = 0;
  private safeArea: SafeArea = { top: 0, right: 0, bottom: 0, left: 0 };
  private reducedMotion = false;
  private ambientTimer: number | null = null;
  private lastDrawAt = 0;
  private readonly cityHitGrid = new RectGrid<{ cityId: string; x: number; y: number; r: number }>(64);
  private readonly cityLabelGrid = new RectGrid<{ cityId: string; rect: Rect }>(64);
  private readonly moods = new Map<number, MoodState>();
  private celebrations: Celebration[] = [];
  private shakeState: { start: number; intensity: number } | null = null;
  private readonly arrivalBounces = new Map<number, number>();

  private dpr = 1;
  private cssW = 1;
  private cssH = 1;
  private initialized = false;

  private raf = 0;
  private lastFrameTime = 0;
  private frameTimes: number[] = [];
  private destroyed = false;

  private moveAnim: MoveAnim | null = null;
  private warpAnim: WarpAnim | null = null;

  private readonly emoteActive = new Map<number, ActiveEmote>();
  private readonly emoteQueue = new Map<number, QueuedEmote[]>();
  private readonly hitOverlays = new Map<number, number>();
  private floatTexts: FloatText[] = [];
  private readonly bubbles = new Map<number, BubbleState>();
  private readonly bubbleTimers = new Map<number, number>();

  private moveOptions: MoveOption[] | null = null;
  private movePick: ((nodeId: string) => void) | null = null;
  private moveHooks: MoveOptionHooks | null = null;
  private optionPinHits: Array<{ nodeId: string; x: number; y: number; r: number }> = [];
  private edgePinHits: Array<{ nodeId: string; x: number; y: number; r: number }> = [];
  private hoveredOption: string | null = null;
  private selectedOption: string | null = null;
  private lastPickAt = 0;
  private labelObstacles: MapLabelObstacle[] = [];
  private labelObstacleSignature = '';
  /** Cached static label layout for the current view + zoom bucket. */
  private labelLayoutKey = '';
  private labelLayoutRefZoom = 1;
  private labelLayoutMs = { art: 0, city: 0, total: 0 };
  private cityLabelPlan = new Map<string, CityLabelPlan>();
  private artLabelPlan: ArtLabelPlan[] = [];
  private cityLabelDrawn: DrawnLabel[] = [];
  private artLabelDrawn: DrawnLabel[] = [];
  private readonly labelFade = new LabelFade();
  private overviewMode = false;
  private cityTap: ((cityId: string) => void) | null = null;

  private cityHits: Array<{ cityId: string; x: number; y: number; r: number }> = [];
  private cityLabelHits: Array<{ cityId: string; rect: Rect }> = [];

  private followId: number | null = null;
  private followPausedUntil = 0;

  private readonly pointers = new Map<number, { x: number; y: number }>();
  private primaryPointerId: number | null = null;
  private dragStartX = 0;
  private dragStartY = 0;
  private dragMoved = 0;
  private dragging = false;
  private pinchPrev: { dist: number; midX: number; midY: number } | null = null;
  private velocityX = 0;
  private velocityY = 0;
  private velocitySampleAt = 0;
  private lastTap: { at: number; x: number; y: number } | null = null;
  private suppressTapUntil = 0;

  private miniMapEl: HTMLCanvasElement | null = null;
  private miniLand: HTMLCanvasElement | null = null;
  private miniLandSize = '';
  private readonly miniPointer = (e: PointerEvent): void => this.handleMiniTap(e);
  private readonly measureCache = new Map<string, number>();
  private resizeObserver: ResizeObserver;
  private budget: CanvasBudget;

  constructor(canvas: HTMLCanvasElement, data: GameData, assets: MapAssets) {
    this.canvas = canvas;
    this.assets = assets;
    this.budget = detectCanvasBudget();
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('2D canvas unavailable');
    this.ctx = ctx;
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.imageSmoothingQuality = 'high';

    this.landLayer = new LandLayer(assets.land);
    this.landLayer.setBudget(this.budget);
    this.landLayer.setTerrain(assets.terrain, assets.terrainLo);

    for (const node of data.board.nodes) {
      this.nodeById.set(node.id, node);
      if (node.realm) {
        const list = this.realmNodes.get(node.realm) ?? [];
        list.push(node);
        this.realmNodes.set(node.realm, list);
      } else {
        this.worldNodes.push(node);
      }
    }
    const allCities = [...data.cities, ...(realmCitiesData as unknown as City[])];
    const seenCityIds = new Set<string>();
    for (const city of allCities) {
      if (seenCityIds.has(city.id)) continue;
      seenCityIds.add(city.id);
      const node = data.board.nodes.find((n) => n.kind === 'city' && n.cityId === city.id);
      if (node) {
        const entry = { city, node };
        this.allCityEntries.push(entry);
        this.cityNodeId.set(city.id, node.id);
        if (node.realm) {
          const list = this.realmCityEntries.get(node.realm) ?? [];
          list.push(entry);
          this.realmCityEntries.set(node.realm, list);
        } else {
          this.cityEntries.push(entry);
        }
      }
    }
    for (const ch of data.characters) this.characterById.set(ch.id, ch);
    for (const e of data.board.edges) {
      const a = this.nodeById.get(e.a);
      const b = this.nodeById.get(e.b);
      if (!a || !b) continue;
      const mode = routeModeOf(e.mode);
      this.edgeModes.set(edgeKey(e.a, e.b), mode);
      if (mode === 'air') {
        this.airNodes.add(a.id);
        this.airNodes.add(b.id);
      }
      const realm = a.realm;
      if (realm !== b.realm) continue;
      const draw: DrawEdge = {
        ax: a.x,
        ay: a.y,
        dx: wrapDx(a.x, b.x),
        dy: b.y - a.y,
        mode,
      };
      if (realm) {
        const list = this.realmEdges.get(realm) ?? [];
        list.push(draw);
        this.realmEdges.set(realm, list);
      } else {
        this.edges.push(draw);
      }
    }
    for (const edge of data.board.edges) this.graphEdges.push({ a: edge.a, b: edge.b });
    for (const node of data.board.nodes) {
      if (node.kind === 'warp') this.warpNodes.push(node);
    }
    this.ambient = new AmbientWorld(data, assets.vehicles);
    this.buildGeoGrid();
    this.buildTerrain();

    canvas.style.touchAction = 'none';
    canvas.style.display = 'block';
    // QA hook: automated screenshots reach the view through the canvas node.
    Object.defineProperty(canvas, '__fableMapView', { value: this, configurable: true });

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);

    document.addEventListener('visibilitychange', this.onVisibility);
    this.resize();
    this.attachInput();
    this.requestRender();
  }

  private buildGeoGrid(): void {
    for (let lat = -58; lat <= 82; lat += 2) {
      for (let lon = -180; lon <= 180; lon += 2) {
        const [x, y] = project(lon, lat);
        const item = { lat, lon };
        for (const shift of [-MAP_W, 0, MAP_W]) {
          this.geoGrid.add({ x: x + shift - 2, y: y - 2, w: 4, h: 4 }, item);
        }
      }
    }
  }

  private geoAt(x: number, y: number): { lat: number; lon: number } {
    let best: { lat: number; lon: number } | null = null;
    let bestD = Infinity;
    for (const item of this.geoGrid.queryRect({ x: x - 170, y: y - 170, w: 340, h: 340 })) {
      const [px, py] = project(item.lon, item.lat);
      const d = Math.min(
        Math.abs(px - x),
        Math.abs(px + MAP_W - x),
        Math.abs(px - MAP_W - x),
      ) ** 2 + (py - y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = item;
      }
    }
    return best ?? { lat: 0, lon: 0 };
  }

  private buildTerrain(): void {
    for (const node of this.worldNodes) {
      this.avoidGrid.add({ x: node.x - 15, y: node.y - 15, w: 30, h: 30 }, true);
    }
    for (const e of this.edges) {
      const len = Math.hypot(e.dx, e.dy);
      const steps = Math.max(1, Math.ceil(len / 55));
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        this.avoidGrid.add({ x: e.ax + e.dx * t - 13, y: e.ay + e.dy * t - 13, w: 26, h: 26 }, true);
      }
    }
    const step = MAP_W / 70;
    let n = 0;
    for (let gy = step; gy < MAP_H - step; gy += step) {
      for (let gx = step; gx < MAP_W - step; gx += step) {
        n += 1;
        const x = gx + (hashString(`t${n}`) % 1000) / 1000 * step * 0.9 - step * 0.45;
        const y = gy + (hashString(`u${n}`) % 1000) / 1000 * step * 0.9 - step * 0.45;
        const geo = this.geoAt(x, y);
        const kind = classifyTerrain(geo.lat, geo.lon, n);
        if (!kind) continue;
        if (!this.landLayer.isLand(((x % MAP_W) + MAP_W) % MAP_W, y)) continue;
        if (this.avoidGrid.queryRect({ x: x - 38, y: y - 38, w: 76, h: 76 }).length) continue;
        const size = terrainSize(kind) * (MAP_W / 8192);
        this.terrain.push({ x, y, kind, size });
      }
    }
  }

  private drawMapArt(ctx: CanvasRenderingContext2D, layer: LayerTransform, detail: number): void {
    const art = this.assets.mapArt;
    if (!art) return;
    const { toCanvas, scale, dpr } = layer;
    const centerX = layer.ox + layer.wWorld / 2;
    const wPx = layer.wWorld * scale;
    const hPx = layer.hWorld * scale;
    const visible = (px: number, py: number, m: number): boolean => px > -m && px < wPx + m && py > -m && py < hPx + m;
    const shiftNear = (x: number): number => Math.round((centerX - x) / MAP_W) * MAP_W;
    if (art.borders && detail >= 1) {
      const path = new Path2D();
      for (const line of art.borders.lines) {
        if (line.length < 4) continue;
        const shift = shiftNear(line[0]);
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (let i = 0; i < line.length; i += 2) { minX = Math.min(minX, line[i]); maxX = Math.max(maxX, line[i]); minY = Math.min(minY, line[i+1]); maxY = Math.max(maxY, line[i+1]); }
        const [cx, cy] = toCanvas(minX + shift, minY);
        if (!visible(cx, cy, Math.max(maxX - minX, maxY - minY) * scale + 30)) continue;
        for (let i = 0; i < line.length; i += 2) {
          const [px, py] = toCanvas(line[i] + shift, line[i+1]);
          if (i === 0) path.moveTo(px, py); else path.lineTo(px, py);
        }
      }
      ctx.save();
      ctx.strokeStyle = 'rgba(86, 100, 78, 0.45)';
      ctx.lineWidth = Math.max(1, dpr);
      ctx.setLineDash([6 * dpr, 5 * dpr]);
      ctx.stroke(path);
      ctx.restore();
    }
    if (art.rivers) {
      for (const r of art.rivers.rivers) {
        const pts = r.pts;
        if (pts.length < 4) continue;
        const shift = shiftNear(pts[0]);
        const [sx, sy] = toCanvas(pts[0] + shift, pts[1]);
        if (!visible(sx, sy, 120)) continue;
        const path = new Path2D();
        for (let i = 0; i < pts.length; i += 2) {
          const [px, py] = toCanvas(pts[i] + shift, pts[i+1]);
          if (i === 0) path.moveTo(px, py); else path.lineTo(px, py);
        }
        const width = Math.max(1 * dpr, (r.w ?? 2.2) * this.camera.zoom * dpr);
        ctx.save();
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.strokeStyle = '#2a6e96';
        ctx.lineWidth = width + 1.6 * dpr;
        ctx.stroke(path);
        ctx.strokeStyle = '#4eaed6';
        ctx.lineWidth = width;
        ctx.stroke(path);
        ctx.restore();
      }
    }
    if (art.lakes && detail >= 1) {
      for (const lake of art.lakes.lakes) {
        const ring = lake.rings[0];
        if (!ring || ring.length < 6) continue;
        const shift = shiftNear(ring[0]);
        const [sx, sy] = toCanvas(ring[0] + shift, ring[1]);
        if (!visible(sx, sy, 120)) continue;
        const path = new Path2D();
        for (const r of lake.rings) {
          for (let i = 0; i < r.length; i += 2) {
            const [px, py] = toCanvas(r[i] + shift, r[i+1]);
            if (i === 0) path.moveTo(px, py); else path.lineTo(px, py);
          }
          path.closePath();
        }
        ctx.save();
        ctx.fillStyle = '#4eaed6';
        ctx.fill(path, 'evenodd');
        ctx.strokeStyle = '#2a6e96';
        ctx.lineWidth = Math.max(1, 1 * dpr);
        ctx.stroke(path);
        ctx.restore();
      }
    }
  }

  private drawTerrain(ctx: CanvasRenderingContext2D, layer: LayerTransform, detail: number): void {
    if (detail < 1) return;
    const { toCanvas, scale, dpr } = layer;
    const cam = this.camera;
    const centerX = layer.ox + layer.wWorld / 2;
    const wPx = layer.wWorld * scale;
    const hPx = layer.hWorld * scale;
    for (const t of this.terrain) {
      const wx = centerX + wrapDx(centerX, t.x);
      const [px, py] = toCanvas(wx, t.y);
      const sz = t.size * scale;
      if (px < -sz || px > wPx + sz || py < -sz || py > hPx + sz) continue;
      const img = this.assets.stamps?.get(t.kind);
      const aspect = img && img.naturalWidth > 0 && img.naturalHeight > 0 ? img.naturalWidth / img.naturalHeight : 1.25;
      const w = sz * aspect;
      const h = sz;
      ctx.globalAlpha = 0.93;
      if (img) ctx.drawImage(img, px - w / 2, py - h * 0.7, w, h);
      else drawStampFallback(ctx, t.kind, px, py, sz);
      ctx.globalAlpha = 1;
    }
    void cam;
    void dpr;
  }

  private drawCityClusters(ctx: CanvasRenderingContext2D, layer: LayerTransform, detail: number): void {
    if (detail < 1) return;
    const { toCanvas, scale } = layer;
    const centerX = layer.ox + layer.wWorld / 2;
    const wPx = layer.wWorld * scale;
    const hPx = layer.hWorld * scale;
    const radiusPx = this.cityRadius() * layer.dpr;
    const placed: Array<{ x: number; y: number }> = [];
    const sorted = [...this.cityEntries]
      .filter((entry) => !!entry.city.landmark)
      .sort((a, b) => a.city.tier - b.city.tier);
    for (const entry of sorted) {
      if (placed.some((p) => Math.hypot(wrapDx(p.x, entry.node.x), p.y - entry.node.y) < 250)) continue;
      placed.push({ x: entry.node.x, y: entry.node.y });
      const kind = entry.city.tier === 1 ? 'metropolis' : entry.city.tier === 2 && entry.city.port ? 'port_town' : 'town';
      const img = this.assets.stamps?.get(kind);
      const worldSize = (kind === 'metropolis' ? 34 : kind === 'port_town' ? 26 : 22) * (MAP_W / 8192);
      const sz = worldSize * scale;
      const wx = centerX + wrapDx(centerX, entry.node.x);
      const [px, py] = toCanvas(wx, entry.node.y);
      if (px < -sz || px > wPx + sz || py < -sz || py > hPx + sz) continue;
      // One compact block below the station, leaving the plate, label and all
      // route edges clear. Landmarks remain drawn above this cluster.
      const dir = hashString(entry.city.id) % 2 === 0 ? 1 : -1;
      const cx = px + dir * (radiusPx + sz * 0.85);
      const cy = py + radiusPx * 1.35 + sz * 0.55;
      if (img) ctx.drawImage(img, cx - sz / 2, cy - sz * 0.62, sz, sz);
      else drawStampFallback(ctx, kind, cx, cy, sz);
    }
  }

  private realmCamera(realm: RealmId): Camera {
    let cam = this.realmCameras.get(realm);
    if (!cam) {
      cam = new Camera(REALM_W, REALM_H, false);
      cam.setViewport(this.cssW, this.cssH);
      this.realmCameras.set(realm, cam);
    }
    return cam;
  }

  private cityEntriesForView(): CityEntry[] {
    return this.view === 'world' ? this.cityEntries : this.realmCityEntries.get(this.view) ?? [];
  }

  private nodesForView(): BoardNode[] {
    return this.view === 'world' ? this.worldNodes : this.realmNodes.get(this.view) ?? [];
  }

  private warpNodesForView(): BoardNode[] {
    return this.warpNodes.filter((n) => (n.realm ?? 'world') === this.view);
  }

  private tokenRealm(playerId: number): RealmId | 'world' {
    const token = this.tokens[playerId];
    const node = token ? this.nodeById.get(token.nodeId) : null;
    return node?.realm ?? 'world';
  }

  /** Players grouped by board view; includes 'world'. */
  get realmCounts(): Record<RealmId | 'world', number> {
    const counts: Record<RealmId | 'world', number> = { world: 0, heaven: 0, hell: 0, space: 0 };
    for (const token of this.tokens) {
      const node = this.nodeById.get(token.nodeId);
      counts[node?.realm ?? 'world'] += 1;
    }
    return counts;
  }

  // ---------------------------------------------------------------- public API

  setState(state: PublicState): void {
    this.state = state;
    if (this.followId !== null && (this.followId === this.lastCurrent || this.lastCurrent < 0)) {
      this.followId = state.current;
    }
    this.lastCurrent = state.current;
    const previousCount = this.tokens.length;
    this.tokens = state.players.map((p) => ({ playerId: p.id, nodeId: p.nodeId }));
    this.playerColors = state.players.map(
      (p, i) => this.characterById.get(p.characterId)?.color ?? SEAT_COLORS[i % SEAT_COLORS.length],
    );
    this.destinationNodeId = this.cityNodeId.get(state.destination) ?? null;
    this.staticRevision += 1;
    this.landLayer.invalidate();
    this.setMonth(state.month);

    if (!this.initialCameraDone && state.players.length > 0) {
      const actor = state.players[state.current] ?? state.players[0];
      const node = this.nodeById.get(actor.nodeId);
      if (node) {
        this.initialCameraDone = true;
        // Momotetsu-like default: a regional close view centred on the actor.
        void this.focusWorldPoint(node.x, node.y, this.playZoomNear(actor.nodeId), 0);
        this.followId = state.current;
      }
    }

    if (this.moveAnim) {
      const player = state.players[this.moveAnim.playerId];
      const last = this.moveAnim.path[this.moveAnim.path.length - 1];
      // Authoritative snapshot wins. Cancel without writing the old animation
      // endpoint back over the node that setState just adopted.
      if (shouldCancelForSnapshot(last, player?.nodeId)) this.cancelMove(false);
    }
    if (this.warpAnim) {
      const player = state.players[this.warpAnim.playerId];
      if (shouldCancelForSnapshot(this.warpAnim.toNode, player?.nodeId)) this.cancelWarp(false);
    }
    for (const [playerId, active] of [...this.emoteActive]) {
      if (playerId >= state.players.length) {
        this.emoteActive.delete(playerId);
        active.resolve();
      }
    }
    for (const [playerId, queue] of [...this.emoteQueue]) {
      if (playerId >= state.players.length) {
        for (const job of queue) job.resolve();
        this.emoteQueue.delete(playerId);
      }
    }
    if (previousCount > this.tokens.length) {
      for (let i = this.tokens.length; i < previousCount; i++) {
        this.bubbles.delete(i);
        const timer = this.bubbleTimers.get(i);
        if (timer !== undefined) window.clearTimeout(timer);
        this.bubbleTimers.delete(i);
      }
    }
    this.rebuildOwnership();

    if (performance.now() > this.manualViewUntil) {
      const focusPlayer = this.followId ?? state.current;
      const focusNode = state.players[focusPlayer]?.nodeId;
      const realm = (focusNode ? this.nodeById.get(focusNode)?.realm : undefined) ?? 'world';
      if (realm !== this.view) this.switchView(realm);
    }
    this.requestRender();
  }

  setMoveOptions(options: MoveOption[] | null, onPickOrHooks: ((nodeId: string) => void) | MoveOptionHooks | null): void {
    this.moveOptions = options ? options.map((o) => ({ nodeId: o.nodeId, path: [...o.path] })) : null;
    if (typeof onPickOrHooks === 'function') {
      this.movePick = onPickOrHooks;
      this.moveHooks = null;
    } else {
      this.movePick = null;
      this.moveHooks = onPickOrHooks;
    }
    this.hoveredOption = null;
    if (!options || !this.selectedOption || !options.some((o) => o.nodeId === this.selectedOption)) {
      this.selectedOption = null;
    }
    if (this.moveOptions && this.moveOptions.length > 0) this.frameMoveOptions();
    this.requestRender();
  }

  /** List-driven selection: highlight and frame the same route a map pin tap would. */
  selectMoveOption(nodeId: string): void {
    if (!this.moveOptions?.some((o) => o.nodeId === nodeId)) return;
    this.selectedOption = nodeId;
    this.hoveredOption = nodeId;
    this.overviewMode = false;
    this.frameSelectedPath(nodeId);
    this.moveHooks?.onSelect?.(nodeId);
    this.requestRender();
  }

  /** Explicit confirmation from the UI's confirm button (or the map's badge button). */
  confirmMoveOption(nodeId?: string): void {
    const target = nodeId ?? this.selectedOption;
    if (!target) return;
    this.confirmOption(target);
  }

  animateMove(
    playerId: number,
    path: string[],
    msPerStep: number,
    opts?: { dice?: number },
  ): Promise<void> {
    const token = this.tokens[playerId];
    if (!token || path.length === 0) return Promise.resolve();
    const clean = path[0] === token.nodeId ? path.slice(1) : [...path];
    if (clean.length === 0 || !clean.every((id) => this.nodeById.has(id))) return Promise.resolve();
    this.cancelMove();
    this.cancelWarp();
    return new Promise((resolve) => {
      this.moveAnim = {
        playerId,
        startNode: token.nodeId,
        path: clean,
        msPerStep: Math.max(40, msPerStep),
        start: performance.now(),
        dice: Math.max(1, Math.min(3, Math.round(opts?.dice ?? 1))),
        resolve,
      };
      this.requestRender();
    });
  }

  warp(playerId: number, nodeId: string, via: WarpVia = 'event'): Promise<void> {
    const token = this.tokens[playerId];
    if (!token || !this.nodeById.has(nodeId)) return Promise.resolve();
    this.cancelWarp();
    this.cancelMove();
    if (via === 'rocket') this.shake(0.7);
    const duration = via === 'rocket' ? 1900 : via === 'plane' || via === 'carpet' || via === 'tornado' ? 1550 : 780;
    return new Promise((resolve) => {
      this.warpAnim = {
        playerId,
        fromNode: token.nodeId,
        toNode: nodeId,
        start: performance.now(),
        duration,
        via,
        landed: false,
        resolve,
      };
      this.requestRender();
    });
  }

  focusNode(nodeId: string, opts?: { zoom?: number; ms?: number }): Promise<void> {
    const node = this.nodeById.get(nodeId);
    if (!node) return Promise.resolve();
    const realm = node.realm ?? 'world';
    if (realm !== this.view) this.switchView(realm);
    this.followId = null;
    const promise = this.focusWorldPoint(node.x, node.y, opts?.zoom ?? this.camera.zoom, opts?.ms ?? 550);
    this.requestRender();
    return promise;
  }

  fitWorld(ms = 650): Promise<void> {
    this.followId = null;
    this.overviewMode = true;
    const cam = this.camera;
    const box = this.boardBox();
    const targetZoom = Math.min(box.w / cam.worldW, box.h / cam.worldH);
    const zoom = Math.min(cam.maxZoom(), Math.max(0.02, targetZoom));
    const offsetX = (this.safeArea.left - this.safeArea.right) / 2;
    const offsetY = (this.safeArea.top - this.safeArea.bottom) / 2;
    const promise = cam.startTween(
      cam.worldW / 2 - offsetX / zoom,
      cam.worldH / 2 - offsetY / zoom,
      zoom,
      ms,
      Math.min(cam.minZoom(), zoom),
    );
    this.requestRender();
    return promise;
  }

  follow(playerId: number | null): void {
    this.followId = playerId !== null && this.tokens[playerId] ? playerId : null;
    if (this.followId !== null) {
      const realm = this.tokenRealm(this.followId);
      if (realm !== this.view) this.switchView(realm);
    }
    this.requestRender();
  }

  floatText(nodeId: string, text: string, color: string): void {
    const target = this.nodeById.get(nodeId);
    if (!target || (target.realm ?? 'world') !== this.view) return;
    this.floatTexts.push({ nodeId, text, color, start: performance.now() });
    if (this.floatTexts.length > 12) this.floatTexts.shift();
    this.requestRender();
  }

  onCityTap(cb: (cityId: string) => void): void {
    this.cityTap = cb;
  }

  bubble(playerId: number, text: string, ms = 4000): void {
    if (!this.tokens[playerId]) return;
    const until = performance.now() + Math.max(400, ms);
    this.bubbles.set(playerId, { text, until });
    const old = this.bubbleTimers.get(playerId);
    if (old !== undefined) window.clearTimeout(old);
    const timer = window.setTimeout(() => {
      this.bubbleTimers.delete(playerId);
      const b = this.bubbles.get(playerId);
      if (b && b.until <= performance.now() + 30) this.bubbles.delete(playerId);
      this.requestRender();
    }, Math.max(400, ms));
    this.bubbleTimers.set(playerId, timer);
    this.requestRender();
  }

  playEmote(playerId: number, def: EmoteDef, targetPlayerId: number | null): Promise<void> {
    if (!this.tokens[playerId]) return Promise.resolve();
    const targetId = this.resolveEmoteTarget(playerId, def, targetPlayerId);
    return new Promise((resolve) => {
      const job: QueuedEmote = { def, targetId, resolve };
      if (this.emoteActive.has(playerId)) {
        const queue = this.emoteQueue.get(playerId) ?? [];
        if (queue.length >= 2) {
          // Drop the oldest queued emote instead of building a long backlog.
          queue.shift()?.resolve();
        }
        queue.push(job);
        this.emoteQueue.set(playerId, queue);
      } else {
        this.startEmote(playerId, job);
      }
      this.requestRender();
    });
  }

  /** Swap the token expression temporarily. neutral/null clears it. */
  setMood(playerId: number, mood: Mood | null, ms?: number): void {
    if (!this.tokens[playerId]) return;
    if (!mood || mood === 'neutral' || (ms !== undefined && ms <= 0)) {
      this.moods.delete(playerId);
    } else {
      const duration = ms ?? 6000;
      this.moods.set(playerId, { mood, until: performance.now() + duration });
    }
    this.requestRender();
  }

  /** Event moment at a board node (or convenience overload for a player token). */
  celebrate(nodeId: string, kind: CelebrateKind): void;
  celebrate(playerId: number, kind?: CelebrateKind): void;
  celebrate(target: string | number, kind: CelebrateKind = 'goal'): void {
    let nodeId: string | null = null;
    if (typeof target === 'number') {
      nodeId = this.state?.players[target]?.nodeId ?? this.tokens[target]?.nodeId ?? null;
    } else {
      nodeId = target;
    }
    if (!nodeId || !this.nodeById.has(nodeId)) return;
    const duration = kind === 'goal' ? 2400 : kind === 'monopoly' ? 2200 : kind === 'bad' ? 2000 : 1800;
    this.celebrations.push({ nodeId, kind, start: performance.now(), duration });
    if (this.celebrations.length > 10) this.celebrations.shift();
    this.requestRender();
  }

  /** Screen shake for a big loss. */
  shake(intensity = 0.5): void {
    this.shakeState = {
      start: performance.now(),
      intensity: Math.max(0.1, Math.min(2, intensity)) * (this.reducedMotion ? 0.35 : 1),
    };
    this.requestRender();
  }

  /** Disable ambient motion (and the 30fps loop); functional animations still run. */
  setReducedMotion(on: boolean): void {
    if (this.reducedMotion === on) return;
    this.reducedMotion = on;
    if (on && this.ambientTimer !== null) {
      window.clearTimeout(this.ambientTimer);
      this.ambientTimer = null;
    }
    this.requestRender();
  }

  /** Switch between the world and heaven/hell/space. */
  setView(realm: RealmId | 'world'): void {
    this.manualViewUntil = performance.now() + 5000;
    this.switchView(realm);
  }

  private switchView(realm: RealmId | 'world'): void {
    if (realm !== 'world' && !REALMS[realm]) return;
    if (this.view === realm) return;
    const existed = realm === 'world' || this.realmCameras.has(realm);
    this.view = realm;
    const cam = this.camera;
    cam.setViewport(this.cssW, this.cssH);
    if (!existed) void this.fitWorld(0);
    this.hoveredOption = null;
    this.selectedOption = null;
    this.followPausedUntil = 0;
    this.requestRender();
  }

  /** Node position in CSS canvas px; null when the node is in another view. */
  screenPositionOfNode(nodeId: string): { x: number; y: number; visible?: boolean } | null {
    const node = this.nodeById.get(nodeId);
    if (!node) return null;
    if ((node.realm ?? 'world') !== this.view) return null;
    const x = this.camera.screenX(node.x);
    const y = this.camera.screenY(node.y);
    const visible = x >= 0 && x <= this.camera.vw && y >= 0 && y <= this.camera.vh;
    return { x, y, visible };
  }

  isNodeVisible(nodeId: string): boolean {
    const node = this.nodeById.get(nodeId);
    if (!node || (node.realm ?? 'world') !== this.view) return false;
    const x = this.camera.screenX(node.x);
    const y = this.camera.screenY(node.y);
    return x >= 0 && x <= this.camera.vw && y >= 0 && y <= this.camera.vh;
  }

  /** CSS-pixel position of a player's token, for token→wallet UI effects. */
  screenPositionOf(playerId: number): { x: number; y: number } | null {
    if (this.tokenRealm(playerId) !== this.view) return null;
    const p = this.tokenWorldPosition(playerId, performance.now());
    if (!p) return null;
    return { x: this.camera.screenX(p.x), y: this.camera.screenY(p.y) };
  }

  /** Change the map month; seasons crossfade for 1s. */
  setMonth(month: number): void {
    const m = Math.max(1, Math.min(12, Math.round(month)));
    const next = seasonForMonth(m);
    if (next !== this.season) {
      this.landLayer.beginSeasonTransition(performance.now());
      this.seasonTransitionStart = performance.now();
      this.season = next;
      this.landLayer.invalidate();
    }
    this.month = m;
    this.requestRender();
  }

  /** Render a compact world overview into an external canvas; click/tap jumps there. */
  setMiniMap(el: HTMLCanvasElement | null): void {
    if (this.miniMapEl) this.miniMapEl.removeEventListener('pointerdown', this.miniPointer);
    this.miniMapEl = el;
    if (this.miniLand) releaseCanvas(this.miniLand);
    this.miniLand = null;
    this.miniLandSize = '';
    if (el) el.addEventListener('pointerdown', this.miniPointer);
    this.drawMiniMap();
  }

  private handleMiniTap(e: PointerEvent): void {
    const el = this.miniMapEl;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const x = ((e.clientX - r.left) / Math.max(1, r.width)) * MAP_W;
    const y = ((e.clientY - r.top) / Math.max(1, r.height)) * MAP_H;
    if (this.view !== 'world') this.switchView('world');
    this.followId = null;
    void this.camera.focus(x, y, this.playZoom(), 350);
    this.requestRender();
  }

  private drawMiniMap(): void {
    const el = this.miniMapEl;
    if (!el) return;
    // Use CSS layout size, never the backing-store width/height: reading
    // el.width here would feed the previous allocation back in and grow the
    // canvas on every hidden/hidden->shown resize.
    const rect = el.getBoundingClientRect();
    const cssW = Math.round(rect.width || el.clientWidth);
    const cssH = Math.round(rect.height || el.clientHeight);
    if (cssW < 2 || cssH < 2) return;
    const dpr = Math.min(2, Math.max(1, this.dpr || window.devicePixelRatio || 1));
    const fit = fitCanvasSize(Math.round(cssW * dpr), Math.round(cssH * dpr), this.budget);
    const sx = fit.width / cssW;
    const sy = fit.height / cssH;
    if (el.width !== fit.width || el.height !== fit.height) {
      releaseCanvas(el);
      el.width = fit.width;
      el.height = fit.height;
    }
    noteCanvasAllocation('minimap', fit.width, fit.height, Math.round(cssW * dpr), Math.round(cssH * dpr), this.budget);
    const ctx = el.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(sx, 0, 0, sy, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    if (!this.miniLand || this.miniLandSize !== `${cssW}x${cssH}:${fit.width}x${fit.height}`) {
      const c = this.miniLand ?? document.createElement('canvas');
      if (c.width !== fit.width || c.height !== fit.height) releaseCanvas(c);
      c.width = fit.width;
      c.height = fit.height;
      noteCanvasAllocation('mini-land', fit.width, fit.height, Math.round(cssW * dpr), Math.round(cssH * dpr), this.budget);
      const g = c.getContext('2d');
      if (g) {
        g.setTransform(sx, 0, 0, sy, 0, 0);
        const grad = g.createLinearGradient(0, 0, 0, cssH);
        grad.addColorStop(0, '#7fdfff');
        grad.addColorStop(1, '#2a9bdb');
        g.fillStyle = grad;
        g.fillRect(0, 0, cssW, cssH);
        const path = new Path2D();
        for (const rings of this.assets.land.polygons) {
          for (const ring of rings) {
            for (let i = 0; i < ring.length; i += 2) {
              const px = (ring[i] / MAP_W) * cssW;
              const py = (ring[i + 1] / MAP_H) * cssH;
              if (i === 0) path.moveTo(px, py);
              else path.lineTo(px, py);
            }
            path.closePath();
          }
        }
        g.fillStyle = '#82cd55';
        g.fill(path, 'evenodd');
        g.strokeStyle = '#3f7d2e';
        g.lineWidth = 0.8;
        g.stroke(path);
      }
      this.miniLand = c;
      this.miniLandSize = `${cssW}x${cssH}:${fit.width}x${fit.height}`;
    }
    ctx.drawImage(this.miniLand, 0, 0, cssW, cssH);
    const toX = (x: number): number => (x / MAP_W) * cssW;
    const toY = (y: number): number => (y / MAP_H) * cssH;
    const cam = this.camera;
    if (this.view === 'world') {
      const vx = toX(cam.x - cam.worldWidth() / 2);
      const vy = toY(cam.y - cam.worldHeight() / 2);
      const vw = (cam.worldWidth() / MAP_W) * cssW;
      const vh = (cam.worldHeight() / MAP_H) * cssH;
      ctx.strokeStyle = 'rgba(255,255,255,0.95)';
      ctx.lineWidth = 1;
      ctx.strokeRect(vx, vy, Math.min(cssW - vx, vw), Math.min(cssH - vy, vh));
    }
    const dest = this.destinationNodeId ? this.nodeById.get(this.destinationNodeId) : null;
    if (dest) {
      const dx = toX(dest.x);
      const dy = toY(dest.y);
      ctx.save();
      ctx.translate(dx, dy);
      ctx.fillStyle = '#ffe04a';
      ctx.strokeStyle = '#20315a';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, -4);
      ctx.lineTo(4, 0);
      ctx.lineTo(0, 4);
      ctx.lineTo(-4, 0);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
    for (const token of this.tokens) {
      const node = this.nodeById.get(token.nodeId);
      if (!node || node.realm) continue;
      const cur = this.state?.current === token.playerId;
      ctx.fillStyle = this.playerColor(token.playerId);
      ctx.strokeStyle = cur ? '#ffe066' : '#ffffff';
      ctx.lineWidth = cur ? 1.6 : 1;
      ctx.beginPath();
      ctx.arc(toX(node.x), toY(node.y), cur ? 3.4 : 2.4, 0, TAU);
      ctx.fill();
      ctx.stroke();
    }
  }

  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const cssW = Math.max(1, rect.width || this.canvas.clientWidth || 640);
    const cssH = Math.max(1, rect.height || this.canvas.clientHeight || 480);
    const prevW = this.cssW;
    const prevH = this.cssH;
    const rawDpr = Math.max(1, window.devicePixelRatio || 1);
    this.budget = detectCanvasBudget();
    const fit = fitBackingStore(cssW, cssH, rawDpr, this.budget);
    this.cssW = cssW;
    this.cssH = cssH;
    this.dpr = fit.scale;
    if (this.canvas.width !== fit.width || this.canvas.height !== fit.height) {
      // Release the old backing store before allocating the replacement.
      releaseCanvas(this.canvas);
    }
    if (this.canvas.width !== fit.width) this.canvas.width = fit.width;
    if (this.canvas.height !== fit.height) this.canvas.height = fit.height;
    noteCanvasAllocation('main', fit.width, fit.height, Math.ceil(cssW * rawDpr), Math.ceil(cssH * rawDpr), this.budget);
    this.landLayer.setBudget(this.budget);
    this.ocean.setBudget(this.budget);
    this.worldCamera.setViewport(cssW, cssH);
    for (const cam of this.realmCameras.values()) cam.setViewport(cssW, cssH);
    this.camera.setViewport(cssW, cssH);
    if (!this.initialized) {
      this.initialized = true;
      void this.camera.fitWorld(0);
    } else if (Math.abs(cssW - prevW) > 1 || Math.abs(cssH - prevH) > 1) {
      // A resize changes the HUD-free area; keep the candidates framed.
      if (this.moveOptions && this.moveOptions.length > 0) this.frameMoveOptions();
    }
    this.landLayer.invalidate();
    this.requestRender();
  }

  destroy(): void {
    this.destroyed = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.resizeObserver.disconnect();
    document.removeEventListener('visibilitychange', this.onVisibility);
    if (this.ambientTimer !== null) window.clearTimeout(this.ambientTimer);
    this.ambientTimer = null;
    this.detachInput();
    this.landLayer.destroy();
    this.ocean.destroy();
    if (this.miniLand) releaseCanvas(this.miniLand);
    this.miniLand = null;
    for (const t of this.bubbleTimers.values()) window.clearTimeout(t);
    this.bubbleTimers.clear();
    this.bubbles.clear();
    this.floatTexts = [];
    this.cancelMove();
    this.cancelWarp();
    this.camera.stopTween();
    for (const active of this.emoteActive.values()) active.resolve();
    this.emoteActive.clear();
    for (const [id, queue] of this.emoteQueue) {
      for (const job of queue) job.resolve();
      this.emoteQueue.delete(id);
    }
  }

  getFrameStats(): FrameStats {
    const values = this.frameTimes;
    if (values.length === 0) return { avgMs: 0, p95Ms: 0, maxMs: 0, fps: 0, frames: 0 };
    let sum = 0;
    let max = 0;
    for (const v of values) {
      sum += v;
      if (v > max) max = v;
    }
    const sorted = [...values].sort((a, b) => a - b);
    const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
    const avg = sum / values.length;
    return { avgMs: avg, p95Ms: p95, maxMs: max, fps: avg > 0 ? 1000 / avg : 0, frames: values.length };
  }

  /**
   * Remaining board hops from `nodeId` to the current destination.
   * Works before `setMoveOptions`; returns null for unknown or unreachable nodes.
   */
  getMoveOptionDistance(nodeId: string): number | null {
    if (!this.nodeById.has(nodeId)) return null;
    const distances = this.destinationDistances();
    if (!distances) return null;
    return distances.get(nodeId) ?? null;
  }

  /** Candidate closest to the destination (ties: stations first), or null. */
  getRecommendedMoveOption(): string | null {
    if (!this.moveOptions || this.moveOptions.length === 0) return null;
    const distances = this.destinationDistances();
    if (!distances) return null;
    const candidates = this.moveOptions.map((option) => ({
      id: option.nodeId,
      kind: this.nodeById.get(option.nodeId)?.kind ?? 'blue',
    }));
    return chooseRecommended(candidates, distances)?.id ?? null;
  }

  private destinationDistances(): Map<string, number> | null {
    const destination = this.destinationNodeId;
    if (!destination) return null;
    if (this.destinationNodeIdCache?.nodeId === destination) return this.destinationNodeIdCache.distances;
    const distances = hopDistances(destination, this.graphEdges);
    this.destinationNodeIdCache = { nodeId: destination, distances };
    return distances;
  }

  getMoveProgress(): MoveProgress | null {
    const move = this.moveAnim;
    if (!move) return null;
    const full = [move.startNode, ...move.path];
    const raw = Math.max(0, (performance.now() - move.start) / move.msPerStep);
    const idx = Math.min(full.length - 2, Math.floor(raw));
    const a = this.nodeById.get(full[idx]);
    const b = this.nodeById.get(full[idx + 1]);
    const mode = a && b ? this.edgeModes.get(edgeKey(a.id, b.id)) ?? 'rail' : 'rail';
    const vehicle = vehicleForStep(mode, move.dice);
    return {
      playerId: move.playerId,
      path: full,
      stepIndex: idx,
      remaining: Math.max(0, full.length - 1 - idx),
      vehicle,
      nextNodeId: full[idx + 1] ?? null,
    };
  }

  resetFrameStats(): void {
    this.frameTimes = [];
    this.lastFrameTime = 0;
  }

  /** Debug/QA view of the effective DPR and the largest renderer-owned canvas. */
  getCanvasBudgetInfo(): { dpr: number; budget: CanvasBudget; largest: CanvasAllocation | null } {
    return { dpr: this.dpr, budget: { ...this.budget }, largest: getLargestCanvasAllocation() };
  }

  /**
   * QA hook: label boxes drawn in the last frame plus the anchor each hangs
   * off. Sampling consecutive frames proves a label never drifts relative to
   * its anchor while tokens move or the camera pans.
   */
  getLabelLayoutSnapshot(): {
    zoom: number;
    layoutMs: { art: number; city: number; total: number };
    city: Array<{ id: string; rect: Rect; anchor: { x: number; y: number } }>;
    art: Array<{ id: string; rect: Rect; anchor: { x: number; y: number } }>;
  } {
    return {
      zoom: this.camera.zoom,
      layoutMs: { ...this.labelLayoutMs },
      city: this.cityLabelDrawn.map((label) => ({
        id: label.id,
        rect: { ...label.rect },
        anchor: { x: label.ax, y: label.ay },
      })),
      art: this.artLabelDrawn.map((label) => ({
        id: label.id,
        rect: { ...label.rect },
        anchor: { x: label.ax, y: label.ay },
      })),
    };
  }

  /** Screen-space position of a board node (useful for HUD badges and tests). */
  getNodeScreenPosition(nodeId: string): { x: number; y: number } | null {
    const node = this.nodeById.get(nodeId);
    if (!node) return null;
    return { x: this.camera.screenX(node.x), y: this.camera.screenY(node.y) };
  }

  // ---------------------------------------------------------------- setup helpers

  private rebuildOwnership(): void {
    this.ownership.clear();
    if (!this.state) return;
    const playerCount = this.state.players.length;
    for (const { city } of this.cityEntries) {
      const counts = new Array<number>(playerCount).fill(0);
      let total = 0;
      for (const prop of city.properties) {
        total += 1;
        const owner = this.state.owner[prop.id];
        if (owner !== undefined && owner >= 0 && owner < playerCount) counts[owner] += 1;
      }
      let monopoly = -1;
      if (total > 0) {
        for (let i = 0; i < counts.length; i++) {
          if (counts[i] === total) {
            monopoly = i;
            break;
          }
        }
      }
      this.ownership.set(city.id, { counts, total, monopoly });
    }
  }

  setSafeArea(area: Partial<SafeArea>): void {
    this.safeArea = {
      top: Math.max(0, area.top ?? this.safeArea.top),
      right: Math.max(0, area.right ?? this.safeArea.right),
      bottom: Math.max(0, area.bottom ?? this.safeArea.bottom),
      left: Math.max(0, area.left ?? this.safeArea.left),
    };
    const cam = this.camera;
    cam.vw = Math.max(1, this.cssW);
    cam.vh = Math.max(1, this.cssH);
    cam.x = cam.clampCenterX(cam.x, cam.zoom);
    cam.y = cam.clampCenterY(cam.y, cam.zoom);
    this.requestRender();
  }

  /**
   * Screen-space rectangles (CSS px, relative to the canvas) that labels must avoid:
   * HUD panels, modal edges, and any other chrome the page draws over the map.
   */
  setLabelObstacles(rects: ReadonlyArray<MapLabelObstacle>): void {
    const next = rects.map((r) => ({ x: r.x, y: r.y, w: Math.max(0, r.w), h: Math.max(0, r.h) }));
    const signature = next
      .map((r) => `${Math.round(r.x)}:${Math.round(r.y)}:${Math.round(r.w)}:${Math.round(r.h)}`)
      .join('|');
    const changed = signature !== this.labelObstacleSignature;
    this.labelObstacles = next;
    this.labelObstacleSignature = signature;
    // HUD panels decide the free board area, so a real change re-frames the
    // candidates that are being chosen.
    if (changed && this.moveOptions && this.moveOptions.length > 0) this.frameMoveOptions();
    this.requestRender();
  }

  private boardBox(): { x: number; y: number; w: number; h: number } {
    const x = Math.min(this.cssW - 1, Math.max(0, this.safeArea.left));
    const y = Math.min(this.cssH - 1, Math.max(0, this.safeArea.top));
    return {
      x,
      y,
      w: Math.max(1, this.cssW - x - Math.max(0, this.safeArea.right)),
      h: Math.max(1, this.cssH - y - Math.max(0, this.safeArea.bottom)),
    };
  }

  /**
   * Board area that the HUD panels leave free. Each overlapping obstacle cuts
   * the cheapest of its four edges, so a top bar or a bottom action panel
   * shrinks the frame without making camera framing ignore it.
   */
  private freeBoardBox(inset = 0): { x: number; y: number; w: number; h: number } {
    const board = this.boardBox();
    let x0 = board.x + inset;
    let y0 = board.y + inset;
    let x1 = board.x + board.w - inset;
    let y1 = board.y + board.h - inset;
    for (let pass = 0; pass < 3; pass++) {
      let changed = false;
      for (const o of this.labelObstacles) {
        const overlapW = Math.min(x1, o.x + o.w) - Math.max(x0, o.x);
        const overlapH = Math.min(y1, o.y + o.h) - Math.max(y0, o.y);
        if (overlapW <= 0 || overlapH <= 0) continue;
        const cutLeft = o.x + o.w - x0;
        const cutRight = x1 - o.x;
        const cutTop = o.y + o.h - y0;
        const cutBottom = y1 - o.y;
        const cut = Math.min(cutLeft, cutRight, cutTop, cutBottom);
        if (cut <= 0) continue;
        if (cut === cutLeft) x0 = Math.min(x1 - 60, o.x + o.w + 2);
        else if (cut === cutRight) x1 = Math.max(x0 + 60, o.x - 2);
        else if (cut === cutTop) y0 = Math.min(y1 - 60, o.y + o.h + 2);
        else y1 = Math.max(y0 + 60, o.y - 2);
        changed = true;
      }
      if (!changed) break;
    }
    return { x: x0, y: y0, w: Math.max(60, x1 - x0), h: Math.max(60, y1 - y0) };
  }

  private focusWorldPoint(x: number, y: number, zoom: number, ms: number): Promise<void> {
    this.overviewMode = false;
    const z = this.camera.clampZoom(zoom);
    const offsetX = (this.safeArea.left - this.safeArea.right) / 2;
    const offsetY = (this.safeArea.top - this.safeArea.bottom) / 2;
    const targetX = this.camera.x + (this.camera.wraps ? wrapDx(this.camera.x, x) : x - this.camera.x) - offsetX / z;
    const targetY = this.camera.clampCenterY(y - offsetY / z, z);
    return this.camera.startTween(targetX, targetY, z, ms);
  }

  private frameMoveOptions(): void {
    const id = this.state?.players[this.state.current]?.nodeId;
    if (!id || !this.moveOptions || this.moveOptions.length === 0) return;
    const start = this.nodeById.get(id);
    if (!start) return;
    const entries: Array<{ dx: number; dy: number; steps: number }> = [];
    for (const option of this.moveOptions) {
      const node = this.nodeById.get(option.nodeId);
      if (!node) continue;
      entries.push({ dx: wrapDx(start.x, node.x), dy: node.y - start.y, steps: option.path.length });
    }
    if (entries.length === 0) return;
    const free = this.freeBoardBox();
    const margin = Math.min(80, Math.max(30, Math.min(free.w, free.h) * 0.08));
    // Phones cannot show 40 candidates at play zoom; allow the frame to pull
    // back further (never below the world fit) so every lit square is visible.
    const floor = Math.max(this.camera.minZoom(), this.playZoom() * 0.42);
    const fitZoom = (list: ReadonlyArray<{ dx: number; dy: number }>): number => {
      let minX = 0;
      let maxX = 0;
      let minY = 0;
      let maxY = 0;
      for (const entry of list) {
        minX = Math.min(minX, entry.dx);
        maxX = Math.max(maxX, entry.dx);
        minY = Math.min(minY, entry.dy);
        maxY = Math.max(maxY, entry.dy);
      }
      const spanX = Math.max(60, maxX - minX);
      const spanY = Math.max(60, maxY - minY);
      // Same reserves as the final fit, so a candidate kept here really fits.
      return Math.min((free.w - margin * 2 - 68) / spanX, (free.h - margin * 2 - 86) / spanY);
    };
    let kept = entries;
    if (fitZoom(entries) < floor * 0.98) {
      // Too far apart to show every candidate: keep the actor and the nearest
      // ones, and let the edge badges point at the rest.
      kept = [];
      for (const entry of [...entries].sort((a, b) => a.steps - b.steps)) {
        const trial = [...kept, entry];
        if (kept.length > 0 && fitZoom(trial) < floor) continue;
        kept.push(entry);
      }
    }
    let minX = 0;
    let maxX = 0;
    let minY = 0;
    let maxY = 0;
    for (const entry of kept) {
      minX = Math.min(minX, entry.dx);
      maxX = Math.max(maxX, entry.dx);
      minY = Math.min(minY, entry.dy);
      maxY = Math.max(maxY, entry.dy);
    }
    // Reserved screen space for pins and pulse rings is handled below by
    // shrinking the free area and nudging the target down.
    const spanX = Math.max(60, maxX - minX);
    const spanY = Math.max(60, maxY - minY);
    // 68px for ring/label sides, 86px for the pin above and the ring below.
    const computed = Math.min(
      (free.w - margin * 2 - 68) / spanX,
      (free.h - margin * 2 - 86) / spanY,
    );
    const cap = Math.max(this.playZoom(), Math.min(this.camera.zoom, this.playZoom() * 1.6));
    const zoom = Math.max(floor, Math.min(computed, cap));
    const cam = this.camera;
    const centerX = start.x + (minX + maxX) / 2;
    const centerY = start.y + (minY + maxY) / 2;
    const offsetX = free.x + free.w / 2 - cam.vw / 2;
    const offsetY = free.y + free.h / 2 - cam.vh / 2 - 13;
    const targetX = cam.x + wrapDx(cam.x, centerX) - offsetX / zoom;
    const targetY = cam.clampCenterY(centerY - offsetY / zoom, zoom);
    this.overviewMode = false;
    void cam.startTween(targetX, targetY, cam.clampZoom(zoom), 420, Math.min(cam.minZoom(), zoom));
  }

  /** Fit the selected option's whole path, including both endpoints, inside the HUD-free board box. */
  private frameSelectedPath(nodeId: string): void {
    const option = this.moveOptions?.find((o) => o.nodeId === nodeId);
    const startId = this.state?.players[this.state.current]?.nodeId;
    const start = startId ? this.nodeById.get(startId) : null;
    if (!option || !start) return;
    const ids = option.path[0] === start.id ? option.path : [start.id, ...option.path];
    let minX = 0, maxX = 0, minY = 0, maxY = 0;
    let cursorX = 0;
    let cursorY = 0;
    let prev = start;
    for (let i = 1; i < ids.length; i++) {
      const node = this.nodeById.get(ids[i]);
      if (!node) continue;
      cursorX += wrapDx(prev.x, node.x);
      cursorY += node.y - prev.y;
      minX = Math.min(minX, cursorX);
      maxX = Math.max(maxX, cursorX);
      minY = Math.min(minY, cursorY);
      maxY = Math.max(maxY, cursorY);
      prev = node;
    }
    const cam = this.camera;
    const box = this.boardBox();
    const pad = 52;
    const spanX = Math.max(1, maxX - minX);
    const spanY = Math.max(1, maxY - minY);
    const computed = Math.min((box.w - pad * 2) / spanX, (box.h - pad * 2) / spanY);
    const zoom = Math.max(0.02, Math.min(cam.maxZoom(), this.playZoom() * 1.8, Math.max(computed, 0.02)));
    const centerX = start.x + (minX + maxX) / 2;
    const centerY = start.y + (minY + maxY) / 2;
    const offsetX = (this.safeArea.left - this.safeArea.right) / 2;
    const offsetY = (this.safeArea.top - this.safeArea.bottom) / 2;
    const targetX = cam.x + wrapDx(cam.x, centerX) - offsetX / zoom;
    const targetY = cam.clampCenterY(centerY - offsetY / zoom, zoom);
    void cam.startTween(targetX, targetY, zoom, 360, Math.min(cam.minZoom(), zoom));
  }

  private playZoom(): number {
    return this.camera.clampZoom(MAP_W / 5460);
  }

  private playZoomNear(nodeId: string | null): number {
    const base = this.playZoom();
    if (!nodeId) return base;
    const node = this.nodeById.get(nodeId);
    if (!node) return base;
    const lens: number[] = [];
    for (const e of this.edges) {
      const near = Math.hypot(wrapDx(node.x, e.ax), node.y - e.ay) < 420;
      if (!near) continue;
      lens.push(Math.hypot(e.dx, e.dy));
    }
    if (lens.length < 3) return base;
    lens.sort((a, b) => a - b);
    const median = lens[Math.floor(lens.length / 2)];
    const fit = median > 30 ? 20 / (median - 30) : 2.4;
    return this.camera.clampZoom(Math.min(2.4, Math.max(base, fit)));
  }

  private viewScale(): number {
    return this.view === 'world' ? 1 : 2.5;
  }

  private isOverview(): boolean {
    return this.view === 'world' && !this.moveAnim && !this.warpAnim && !this.selectedOption
      && (this.overviewMode || this.camera.zoom <= this.camera.minZoom() * 1.18);
  }

  private detailLevel(zoom = this.camera.zoom): number {
    if (this.view !== 'world') return zoom < 0.8 ? 1 : 2;
    return zoom < 0.6 ? 0 : zoom < 1.45 ? 1 : 2;
  }

  private tileRadius(zoom = this.camera.zoom): number {
    return Math.min(this.view === 'world' ? 11 : 50, Math.max(5, (5.2 + zoom * 6.4) * this.viewScale()));
  }

  private cityRadius(zoom = this.camera.zoom): number {
    return Math.min(38, Math.max(5.5, (4.5 + zoom * 4.2) * this.viewScale()));
  }

  private tokenHeight(): number {
    return Math.min(this.view === 'world' ? 104 : 108, Math.max(44, (44 + this.camera.zoom * 18) * this.viewScale()));
  }

  private playerColor(playerId: number): string {
    return this.playerColors[playerId] ?? SEAT_COLORS[playerId % SEAT_COLORS.length];
  }

  private resolveEmoteTarget(playerId: number, def: EmoteDef, target: number | null): number | null {
    if (!def.targeted && def.anim !== 'throw') return target;
    if (target !== null && target !== playerId && this.tokens[target]) return target;
    for (let i = 0; i < this.tokens.length; i++) {
      if (i !== playerId) return i;
    }
    return null;
  }

  // ---------------------------------------------------------------- animation state

  private startEmote(playerId: number, job: QueuedEmote): void {
    this.emoteActive.set(playerId, {
      playerId,
      def: job.def,
      targetId: job.targetId,
      start: performance.now(),
      duration: emoteDuration(job.def.anim),
      hitTriggered: false,
      resolve: job.resolve,
    });
  }

  private startNextEmote(playerId: number): void {
    const queue = this.emoteQueue.get(playerId);
    if (!queue || queue.length === 0) {
      this.emoteQueue.delete(playerId);
      return;
    }
    const next = queue.shift();
    if (!next) return;
    if (queue.length === 0) this.emoteQueue.delete(playerId);
    this.startEmote(playerId, next);
  }

  private cancelMove(applyEnd = true): void {
    const anim = this.moveAnim;
    if (!anim) return;
    this.moveAnim = null;
    const token = this.tokens[anim.playerId];
    const end = anim.path[anim.path.length - 1];
    if (token && end !== undefined) {
      const nodeId = resolveCancelledToken(token.nodeId, end, applyEnd);
      if (nodeId !== undefined) token.nodeId = nodeId;
    }
    anim.resolve();
  }

  private cancelWarp(applyEnd = true): void {
    const anim = this.warpAnim;
    if (!anim) return;
    this.warpAnim = null;
    const token = this.tokens[anim.playerId];
    if (token) {
      const nodeId = resolveCancelledToken(token.nodeId, anim.toNode, applyEnd);
      if (nodeId !== undefined) token.nodeId = nodeId;
    }
    anim.resolve();
  }

  private updateAnimations(now: number): boolean {
    let animating = this.camera.update(now);

    const move = this.moveAnim;
    if (move) {
      const total = move.path.length * move.msPerStep;
      if (now - move.start >= total) {
        const token = this.tokens[move.playerId];
        if (token) token.nodeId = move.path[move.path.length - 1];
        this.moveAnim = null;
        this.arrivalBounces.set(move.playerId, now);
        move.resolve();
      } else {
        animating = true;
      }
    }

    const warp = this.warpAnim;
    if (warp) {
      const p = Math.min(1, (now - warp.start) / warp.duration);
      if (!warp.landed && p >= 0.9) {
        warp.landed = true;
        this.arrivalBounces.set(warp.playerId, now);
        if (warp.via === 'rocket' || warp.via === 'tornado') this.shake(0.55);
      }
      if (now - warp.start >= warp.duration) {
        const token = this.tokens[warp.playerId];
        if (token) token.nodeId = warp.toNode;
        const targetNode = this.nodeById.get(warp.toNode);
        const targetRealm = targetNode?.realm ?? 'world';
        this.warpAnim = null;
        if (targetRealm !== this.view) this.switchView(targetRealm);
        warp.resolve();
      } else {
        animating = true;
      }
    }

    for (const [playerId, active] of [...this.emoteActive]) {
      const elapsed = now - active.start;
      const t = elapsed / active.duration;
      if (active.def.anim === 'throw' && !active.hitTriggered && t >= 0.66 && active.targetId !== null) {
        active.hitTriggered = true;
        this.hitOverlays.set(active.targetId, now);
      }
      if (elapsed >= active.duration) {
        this.emoteActive.delete(playerId);
        active.resolve();
        this.startNextEmote(playerId);
        animating = true;
      } else {
        animating = true;
      }
    }

    for (const [targetId, start] of [...this.hitOverlays]) {
      if (now - start >= HIT_DURATION_MS) this.hitOverlays.delete(targetId);
      else animating = true;
    }

    this.floatTexts = this.floatTexts.filter((f) => now - f.start < 1500);
    if (this.floatTexts.length > 0) animating = true;

    for (const [playerId, bubble] of this.bubbles) {
      if (now >= bubble.until + 20) this.bubbles.delete(playerId);
    }

    this.celebrations = this.celebrations.filter((c) => now - c.start < c.duration);
    if (this.celebrations.length > 0) animating = true;
    if (this.shakeState && now - this.shakeState.start >= 520) this.shakeState = null;
    if (this.shakeState) animating = true;
    for (const [playerId, start] of [...this.arrivalBounces]) {
      if (now - start >= 450) this.arrivalBounces.delete(playerId);
      else animating = true;
    }
    for (const [playerId, mood] of [...this.moods]) {
      if (now >= mood.until) this.moods.delete(playerId);
    }

    // Drag inertia.
    if (!this.dragging && (Math.abs(this.velocityX) > 0.015 || Math.abs(this.velocityY) > 0.015)) {
      const dt = Math.min(48, now - (this.lastFrameTime || now));
      if (dt > 0) {
        this.camera.panByScreen(this.velocityX * dt, this.velocityY * dt);
        const friction = Math.exp(-dt / 190);
        this.velocityX *= friction;
        this.velocityY *= friction;
        animating = true;
      }
    }

    // Follow the active token, but never fight a user pan, a camera tween, or
    // an active move selection (the selected route must stay in frame).
    if (!this.dragging && !this.selectedOption && !this.camera.isTweening() && now > this.followPausedUntil) {
      let followId = this.followId;
      if (followId === null && this.moveAnim) followId = this.moveAnim.playerId;
      if (followId === null && this.warpAnim) followId = this.warpAnim.playerId;
      if (followId !== null) {
        const target = this.tokenWorldPosition(followId, now);
        if (target) {
          let lookX = 0;
          let lookY = 0;
          if (this.moveAnim) {
            const move = this.moveAnim;
            const full = [move.startNode, ...move.path];
            const raw = Math.max(0, (now - move.start) / move.msPerStep);
            const i = Math.min(full.length - 2, Math.floor(raw));
            const a = this.nodeById.get(full[i]);
            const b = this.nodeById.get(full[i + 1]);
            if (a && b) {
              const dx = wrapDx(a.x, b.x);
              const dy = b.y - a.y;
              const len = Math.hypot(dx, dy) || 1;
              lookX = (dx / len) * (52 / this.camera.zoom);
              lookY = (dy / len) * (52 / this.camera.zoom);
            }
          }
          const offsetX = (this.safeArea.left - this.safeArea.right) / 2;
          const offsetY = (this.safeArea.top - this.safeArea.bottom) / 2;
          const desiredX = target.x + lookX - offsetX / this.camera.zoom;
          const desiredY = target.y + lookY - offsetY / this.camera.zoom;
          const dx = wrapDx(this.camera.x, desiredX);
          const dy = desiredY - this.camera.y;
          if (Math.abs(dx) > 0.35 || Math.abs(dy) > 0.35) {
            const k = this.warpAnim ? 0.5 : this.moveAnim ? 0.14 : 0.1;
            this.camera.x = wrapX(this.camera.x + dx * k);
            this.camera.y = this.camera.clampCenterY(this.camera.y + dy * k, this.camera.zoom);
            animating = true;
          }
        }
      }
    }

    return animating;
  }

  private tokenWorldPosition(playerId: number, now: number): { x: number; y: number } | null {
    const token = this.tokens[playerId];
    if (!token) return null;
    const warp = this.warpAnim;
    if (warp && warp.playerId === playerId) {
      const p = Math.min(1, Math.max(0, (now - warp.start) / warp.duration));
      const a = this.nodeById.get(warp.fromNode);
      const b = this.nodeById.get(warp.toNode);
      if (!a || !b) return null;
      if (warp.via === 'event') {
        const n = p < 0.46 ? a : b;
        return { x: n.x, y: n.y };
      }
      const e = easeInOutCubic(p);
      return { x: a.x + wrapDx(a.x, b.x) * e, y: a.y + (b.y - a.y) * e };
    }
    const move = this.moveAnim;
    if (move && move.playerId === playerId) {
      const full = [move.startNode, ...move.path];
      const raw = (now - move.start) / move.msPerStep;
      const idx = Math.min(full.length - 2, Math.max(0, Math.floor(raw)));
      const frac = Math.min(1, Math.max(0, raw - idx));
      const a = this.nodeById.get(full[idx]);
      const b = this.nodeById.get(full[idx + 1]);
      if (a && b) {
        return { x: a.x + wrapDx(a.x, b.x) * frac, y: a.y + (b.y - a.y) * frac };
      }
    }
    const node = this.nodeById.get(token.nodeId);
    return node ? { x: node.x, y: node.y } : null;
  }

  // ---------------------------------------------------------------- frame loop

  private requestRender(): void {
    if (this.destroyed) return;
    if (this.ambientTimer !== null) {
      window.clearTimeout(this.ambientTimer);
      this.ambientTimer = null;
    }
    if (this.raf) return;
    if (document.hidden) return;
    this.raf = requestAnimationFrame(this.onFrame);
  }

  private scheduleAmbient(): void {
    if (this.destroyed || this.reducedMotion || !this.state || document.hidden) return;
    if (this.ambientTimer !== null) window.clearTimeout(this.ambientTimer);
    const elapsed = performance.now() - this.lastDrawAt;
    const wait = Math.max(0, 1000 / 30 - elapsed);
    this.ambientTimer = window.setTimeout(() => {
      this.ambientTimer = null;
      if (!document.hidden) this.requestRender();
    }, wait);
  }

  private readonly onVisibility = (): void => {
    if (document.hidden) {
      if (this.raf) cancelAnimationFrame(this.raf);
      this.raf = 0;
      if (this.ambientTimer !== null) {
        window.clearTimeout(this.ambientTimer);
        this.ambientTimer = null;
      }
    } else {
      this.requestRender();
    }
  };

  private readonly onFrame = (now: number): void => {
    this.raf = 0;
    if (this.destroyed) return;
    if (this.lastFrameTime > 0) {
      const dt = now - this.lastFrameTime;
      if (dt > 0 && dt < 150) {
        this.frameTimes.push(dt);
        if (this.frameTimes.length > 900) this.frameTimes.shift();
      }
    }
    this.lastFrameTime = now;
    if (document.hidden) return;
    const animating = this.updateAnimations(now);
    this.draw(now);
    this.lastDrawAt = now;
    if (animating || this.dragging) this.requestRender();
    else this.scheduleAmbient();
  };

  // ---------------------------------------------------------------- drawing

  private draw(now: number): void {
    const ctx = this.ctx;
    const cam = this.camera;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.cssW, this.cssH);
    if (this.view === 'world') {
      this.ocean.draw(ctx, cam, this.dpr, now);
    } else {
      this.drawRealmBackdrop(ctx, now);
    }
    const shake = this.shakeOffset(now);
    ctx.save();
    ctx.translate(shake.x, shake.y);
    if (this.view === 'world') {
      this.landLayer.draw(
        ctx,
        cam,
        this.dpr,
        this.staticRevision,
        this.season,
        (layer) => this.paintStaticBoard(layer),
        (x, y) => this.avoidGrid.queryRect({ x: x - 42, y: y - 42, w: 84, h: 84 }).length > 0,
        (x, y) => this.geoAt(x, y),
        !this.isOverview(),
      );
      this.landLayer.drawSeasonFade(ctx, cam, now);
      this.ambient.draw(ctx, cam, now, this.detailLevel(), (x, y) => this.landLayer.isLand(x, y));
      this.drawWorldWarpTiles(ctx, now);
      this.drawSeasonParticles(ctx, now);
      this.drawCompass(ctx);
      this.drawMapArtLabels(ctx);
    } else {
      this.drawRealmBoard(ctx, now);
      this.drawRealmAmbient(ctx, now);
    }
    if (this.isOverview()) {
      this.drawOverviewMarkers(ctx);
    } else {
      const layouts = this.computeLayouts(now);
      this.drawMoveSpotlight(ctx);
      this.drawCities(ctx, now);
      this.drawMoveUi(ctx, now);
      this.drawTokens(ctx, layouts, now);
      this.drawSelectedPathOverlay(ctx);
      this.drawOptionMarkers(ctx, now);
      this.drawCelebrations(ctx, now);
      this.drawProjectiles(ctx, layouts, now);
      this.drawWarpOverlay(ctx, now);
      this.drawFloatTexts(ctx, now);
      this.drawBubbles(ctx, layouts, now);
      this.drawBadge(ctx);
    }
    ctx.restore();
    this.drawMiniMap();
  }

  private shakeOffset(now: number): { x: number; y: number } {
    const s = this.shakeState;
    if (!s) return { x: 0, y: 0 };
    const p = (now - s.start) / 520;
    if (p >= 1) return { x: 0, y: 0 };
    const decay = 1 - p;
    return {
      x: Math.sin(now * 0.075) * s.intensity * 11 * decay,
      y: Math.cos(now * 0.092) * s.intensity * 7 * decay,
    };
  }

  private drawCompass(ctx: CanvasRenderingContext2D): void {
    if (this.view !== 'world' || this.detailLevel() > 0) return;
    const cam = this.camera;
    const cx = cam.vw - 70;
    const cy = cam.vh - 70;
    if (cx < 40 || cy < 40) return;
    const r = 30;
    ctx.save();
    ctx.globalAlpha = 0.72;
    ctx.translate(cx, cy);
    ctx.fillStyle = 'rgba(255,255,255,0.22)';
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, TAU);
    ctx.fill();
    ctx.stroke();
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * TAU;
      const long = i % 2 === 0;
      ctx.fillStyle = long ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.55)';
      ctx.beginPath();
      ctx.moveTo(Math.cos(a - 0.12) * (long ? r * 0.82 : r * 0.5), Math.sin(a - 0.12) * (long ? r * 0.82 : r * 0.5));
      ctx.lineTo(Math.cos(a) * (r * 0.98), Math.sin(a) * (r * 0.98));
      ctx.lineTo(Math.cos(a + 0.12) * (long ? r * 0.82 : r * 0.5), Math.sin(a + 0.12) * (long ? r * 0.82 : r * 0.5));
      ctx.lineTo(0, 0);
      ctx.closePath();
      ctx.fill();
    }
    ctx.fillStyle = '#ffffff';
    ctx.font = `800 12px ${LABEL_FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('N', 0, -r * 0.35);
    ctx.restore();
  }

  /**
   * Resolve every label box from static board data for the active zoom bucket.
   *
   * This runs only when the zoom bucket or the view changes, never per frame:
   * a label's slot (and therefore its offset from its anchor) cannot drift
   * while tokens walk, HUD panels open, or the camera pans.
   */
  private ensureLabelLayout(): void {
    const bucket = zoomBucket(this.camera.zoom);
    const key = `${this.view}|${bucket}`;
    if (key === this.labelLayoutKey) return;
    this.labelLayoutKey = key;
    const started = performance.now();
    const refZoom = bucketZoom(bucket);
    const invZoom = 1 / refZoom;
    this.labelLayoutRefZoom = refZoom;
    const detail = this.detailLevel(refZoom);
    const playZoom = this.playZoom();
    const ctx = this.ctx;

    // ---- map-art terrain names -------------------------------------------
    const source = this.assets.mapArt?.labels;
    const labels = Array.isArray(source) ? [...source] : [];
    const rank = (kind: string): number =>
      kind === 'ocean' ? 0 : kind === 'sea' ? 1 : kind === 'continent' ? 2 : kind === 'country' ? 3 : kind === 'lake' ? 4 : 5;
    labels.sort((a, b) => rank(a.kind ?? 'country') - rank(b.kind ?? 'country'));
    const artItems: LabelItem[] = [];
    const artPlans: ArtLabelPlan[] = [];
    for (let i = 0; i < labels.length; i++) {
      const label = labels[i];
      const text = label.text ?? label.nameJa;
      if (!text) continue;
      if (refZoom < (label.minZoom ?? 0) || refZoom > (label.maxZoom ?? 99)) continue;
      const kind = label.kind ?? 'country';
      if (kind === 'country' && (detail >= 2 || refZoom >= 0.9)) continue;
      const base = label.size ?? 24;
      const zoomedIn = refZoom >= playZoom * 0.95;
      const cap = kind === 'ocean' || kind === 'continent'
        ? (zoomedIn ? 20 : 80)
        : kind === 'sea'
          ? (zoomedIn ? 20 : 40)
          : kind === 'country'
            ? (zoomedIn ? 20 : 24)
            : (refZoom >= 0.9 ? 12 : 18);
      const fs = Math.min(cap, Math.max(6, base * refZoom));
      const water = kind === 'ocean' || kind === 'continent' || kind === 'sea';
      const font = `${water ? 'italic ' : ''}800 ${fs.toFixed(1)}px ${LABEL_FONT}`;
      let width = this.measureText(ctx, text, font);
      const gap = water ? fs * 0.12 : 0;
      if (water) width += Math.max(0, Array.from(text).length - 1) * gap;
      // Furigana only once the terrain name is big enough to keep it legible.
      const kana = fs >= 14 ? labelKana(label, text) : null;
      const kanaFs = kana ? Math.max(8, fs * 0.5) : 0;
      const kanaWidth = kana ? this.measureText(ctx, kana, `800 ${kanaFs.toFixed(1)}px ${LABEL_FONT}`) : 0;
      const boxW = Math.max(width, kanaWidth);
      const boxH = fs * 1.15 + (kana ? kanaFs * 1.15 : 0);
      let chars: Array<{ ch: string; x: number }> | null = null;
      if (water) {
        chars = [];
        let cx = -width / 2;
        for (const ch of Array.from(text)) {
          const cw = this.measureText(ctx, ch, font);
          chars.push({ ch, x: cx + cw / 2 });
          cx += cw + gap;
        }
      }
      const id = `art:${i}`;
      artPlans.push({
        id,
        ax: label.x,
        ay: label.y,
        dx: 0,
        dy: 0,
        w: boxW,
        h: boxH,
        fs,
        text,
        kana,
        kanaFs,
        water,
        rotate: label.rotate ?? label.angle ?? 0,
        chars,
        strokeWidth: water ? (zoomedIn ? 1.05 : Math.max(2, fs * 0.08)) : (zoomedIn ? 1.05 : Math.max(2, fs * 0.1)),
        fill: water
          ? 'rgba(255, 255, 255, 0.78)'
          : kind === 'country'
            ? 'rgba(100, 66, 32, 0.8)'
            : 'rgba(34, 98, 136, 0.9)',
      });
      artItems.push({
        id,
        x: label.x,
        y: label.y,
        w: (boxW + 6) * invZoom,
        h: (boxH + 4) * invZoom,
        slots: [{ dx: 0, dy: 0 }],
        disc: 0,
      });
    }
    const artStarted = performance.now();
    const artChoice = placeLabels({
      worldW: MAP_W,
      wrap: true,
      occupied: [],
      discs: [],
      segments: [],
      clearance: 3 * invZoom,
      reach: 900 * invZoom,
    }, artItems);
    this.artLabelPlan = artPlans.filter((plan) => (artChoice.get(plan.id) ?? -1) >= 0);
    this.labelLayoutMs.art = performance.now() - artStarted;

    // ---- city names -------------------------------------------------------
    const entries = this.cityEntriesForView();
    const sorted = [...entries].sort((a, b) => {
      const pa = this.staticCityPriority(a);
      const pb = this.staticCityPriority(b);
      if (pa !== pb) return pb - pa;
      return a.city.id < b.city.id ? -1 : 1;
    });
    const tileR = this.tileRadius(refZoom);
    const cityR = this.cityRadius(refZoom);
    const discs: SceneDisc[] = [];
    for (const node of this.nodesForView()) {
      if (node.kind === 'city') continue;
      discs.push({ x: node.x, y: node.y, r: tileR * 1.25 * invZoom });
    }
    for (const entry of entries) {
      discs.push({ x: entry.node.x, y: entry.node.y, r: cityR * 1.05 * invZoom });
      if (!entry.city.landmark) continue;
      if (detail === 0 && entry.city.tier !== 1) continue;
      if (!this.assets.landmarks.has(entry.city.landmark)) continue;
      const kind = entry.city.tier === 1 ? 'metropolis' : entry.city.tier === 2 && entry.city.port ? 'port_town' : 'town';
      // Label reservation used a square of this screen size; as world units the
      // zoom cancels out, which keeps the landmark disc stable across buckets.
      const sz = (kind === 'metropolis' ? 34 : kind === 'port_town' ? 26 : 22) * (MAP_W / 8192);
      const dir = hashString(entry.city.id) % 2 === 0 ? 1 : -1;
      discs.push({
        x: entry.node.x + dir * (cityR * invZoom + sz * 0.85),
        y: entry.node.y + cityR * invZoom * 1.35 + sz * 0.55,
        r: sz * 0.55,
      });
    }
    const segments: SceneSegment[] = (this.view === 'world' ? this.edges : this.realmEdges.get(this.view) ?? [])
      .map((e) => ({ ax: e.ax, ay: e.ay, bx: e.ax + e.dx, by: e.ay + e.dy }));
    const cityItems: LabelItem[] = [];
    const plans = new Map<string, CityLabelPlan>();
    const showKana = detail >= 1;
    for (const entry of sorted) {
      const text = entry.city.nameJa;
      const fs = this.view === 'world'
        ? Math.min(14, Math.max(12, 10.5 + refZoom * 1.3))
        : Math.min(28, 12 * this.viewScale());
      const kana = showKana ? cityKana(entry.city) : null;
      const kanaFs = kana ? Math.max(8, fs * 0.5) : 0;
      const nameWidth = this.measureText(this.ctx, text, `800 ${fs.toFixed(1)}px ${LABEL_FONT}`);
      const kanaWidth = kana ? this.measureText(this.ctx, kana, `800 ${kanaFs.toFixed(1)}px ${LABEL_FONT}`) : 0;
      const w = Math.max(nameWidth, kanaWidth) + 13;
      const h = fs + 8 + (kana ? kanaFs + 2 : 0);
      const slotPx: Array<{ dx: number; dy: number }> = [
        { dx: cityR + 6 + w / 2, dy: -h * 0.12 },
        { dx: -(cityR + 6 + w / 2), dy: -h * 0.12 },
        { dx: 0, dy: -(cityR + 5 + h / 2) },
        { dx: 0, dy: cityR + 5 + h / 2 },
      ];
      for (const rr of [cityR + 14, cityR + 30]) {
        for (let a = 0; a < 12; a++) {
          const ang = (a / 12) * TAU;
          slotPx.push({ dx: Math.cos(ang) * (rr + w / 2), dy: Math.sin(ang) * (rr * 0.85 + h / 2) });
        }
      }
      plans.set(entry.city.id, { dx: slotPx[0].dx, dy: slotPx[0].dy, w, h, fs, kana, kanaFs, text, slot: -1 });
      // At overview zoom only tier-1 names can be drawn, so skip the costly
      // slot search for the rest; priority labels still fall back to slot 0.
      if (detail === 0 && entry.city.tier !== 1) continue;
      cityItems.push({
        id: entry.city.id,
        x: entry.node.x,
        y: entry.node.y,
        w: (w + 2) * invZoom,
        h: (h + 2) * invZoom,
        slots: slotPx.map((s) => ({ dx: s.dx * invZoom, dy: s.dy * invZoom })),
        disc: cityR * invZoom,
      });
    }
    const occupied: Rect[] = this.artLabelPlan.map((plan) => ({
      x: plan.ax - (plan.w + 6) / 2 * invZoom,
      y: plan.ay - (plan.h + 4) / 2 * invZoom,
      w: (plan.w + 6) * invZoom,
      h: (plan.h + 4) * invZoom,
    }));
    const choice = placeLabels({
      worldW: MAP_W,
      wrap: true,
      occupied,
      discs,
      segments,
      clearance: 3 * invZoom,
      reach: 900,
    }, cityItems);
    for (const item of cityItems) {
      const plan = plans.get(item.id);
      if (!plan) continue;
      const idx = choice.get(item.id) ?? -1;
      plan.slot = idx;
      if (idx >= 0) {
        plan.dx = item.slots[idx].dx * refZoom;
        plan.dy = item.slots[idx].dy * refZoom;
      }
    }
    this.cityLabelPlan = plans;
    this.labelLayoutMs.city = performance.now() - artStarted - this.labelLayoutMs.art;
    this.labelLayoutMs.total = performance.now() - started;
    this.labelFade.pruneAlive(new Set([...this.artLabelPlan.map((plan) => plan.id), ...plans.keys()]));
  }

  /** Placement order score; only static city data, so slots never follow game state. */
  private staticCityPriority(entry: CityEntry): number {
    return (entry.city.tier === 1 ? 3000 : entry.city.tier === 2 ? 600 : 100) + (entry.city.landmark ? 60 : 0);
  }

  /** Screen boxes that may temporarily cover a label. They only fade it, never move it. */
  private dynamicLabelBlockers(now: number): Rect[] {
    const cam = this.camera;
    const out: Rect[] = [...this.labelObstacles];
    const th = this.tokenHeight();
    for (const token of this.tokens) {
      const world = this.tokenWorldPosition(token.playerId, now);
      if (!world) continue;
      const sx = cam.screenX(world.x);
      const sy = cam.screenY(world.y);
      out.push({ x: sx - 30, y: sy - th - 16, w: 60, h: th + 24 });
    }
    const r = this.tileRadius();
    for (const option of this.moveOptions ?? []) {
      const node = this.nodeById.get(option.nodeId);
      if (!node) continue;
      out.push({
        x: cam.screenX(node.x) - 28,
        y: cam.screenY(node.y) - r - 62,
        w: 56,
        h: 62 + r,
      });
    }
    return out;
  }

  private drawMapArtLabels(ctx: CanvasRenderingContext2D): void {
    this.ensureLabelLayout();
    this.artLabelDrawn = [];
    const cam = this.camera;
    const board = this.boardBox();
    const now = performance.now();
    const blockers = this.dynamicLabelBlockers(now);
    const ratio = cam.zoom / this.labelLayoutRefZoom;
    for (const plan of this.artLabelPlan) {
      const sx = cam.screenX(plan.ax);
      const sy = cam.screenY(plan.ay);
      if (sx < -320 || sx > cam.vw + 320 || sy < -160 || sy > cam.vh + 160) continue;
      const w = plan.w * ratio;
      const h = plan.h * ratio;
      const fs = plan.fs * ratio;
      const kanaFs = plan.kanaFs * ratio;
      const rect = { x: sx + plan.dx * ratio - w / 2, y: sy + plan.dy * ratio - h / 2, w, h };
      if (rect.x < board.x + 2 || rect.y < board.y + 2
        || rect.x + rect.w > board.x + board.w - 2 || rect.y + rect.h > board.y + board.h - 2) continue;
      const occluded = blockers.some((o) => rectsOverlap(rect, o, 2));
      const alpha = this.labelFade.update(plan.id, !occluded, now);
      if (alpha <= 0.02) continue;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(sx, sy);
      ctx.rotate((-plan.rotate * Math.PI) / 180);
      ctx.font = `${plan.water ? 'italic ' : ''}800 ${fs.toFixed(1)}px ${LABEL_FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';
      ctx.lineWidth = plan.strokeWidth;
      ctx.strokeStyle = plan.water ? 'rgba(24, 72, 104, 0.22)' : 'rgba(255, 255, 245, 0.72)';
      ctx.fillStyle = plan.fill;
      const blockH = fs * 1.15 + (plan.kana ? kanaFs * 1.15 : 0);
      const nameY = plan.kana ? blockH / 2 - fs * 0.575 : 0;
      if (plan.chars) {
        for (const glyph of plan.chars) {
          ctx.strokeText(glyph.ch, glyph.x * ratio, nameY);
          ctx.fillText(glyph.ch, glyph.x * ratio, nameY);
        }
      } else {
        ctx.strokeText(plan.text, 0, nameY);
        ctx.fillText(plan.text, 0, nameY);
      }
      if (plan.kana) {
        ctx.font = `800 ${kanaFs.toFixed(1)}px ${LABEL_FONT}`;
        ctx.lineWidth = Math.max(1, plan.strokeWidth * 0.8);
        const kanaY = -blockH / 2 + kanaFs * 0.575;
        ctx.strokeText(plan.kana, 0, kanaY);
        ctx.fillText(plan.kana, 0, kanaY);
      }
      ctx.restore();
      this.artLabelDrawn.push({ id: plan.id, rect, ax: sx, ay: sy });
    }
  }

  private drawRealmBackdrop(ctx: CanvasRenderingContext2D, now: number): void {
    if (this.view === 'world') return;
    const realm = this.view;
    const cam = this.camera;
    const base =
      realm === 'heaven' ? ['#b9ecff', '#eaf9ff'] : realm === 'hell' ? ['#2a0808', '#6e1610'] : ['#030614', '#091536'];
    const bg = ctx.createLinearGradient(0, 0, 0, cam.vh);
    bg.addColorStop(0, base[0]);
    bg.addColorStop(1, base[1]);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, cam.vw, cam.vh);

    const img = this.assets.realms?.get(realm);
    if (img) {
      const cover = Math.max(cam.vw / REALM_W, cam.vh / REALM_H);
      const w = REALM_W * cover;
      const h = REALM_H * cover;
      const px = (cam.x / REALM_W - 0.5) * 24;
      const py = (cam.y / REALM_H - 0.5) * 16;
      ctx.save();
      ctx.globalAlpha = 0.98;
      ctx.drawImage(img, (cam.vw - w) / 2 - px, (cam.vh - h) / 2 - py, w, h);
      ctx.restore();
    } else {
      this.drawRealmFallbackBackdrop(ctx, now, realm);
    }
  }

  private drawRealmFallbackBackdrop(
    ctx: CanvasRenderingContext2D,
    now: number,
    realm: RealmId,
  ): void {
    const cam = this.camera;
    if (realm === 'heaven') {
      ctx.save();
      for (let i = 0; i < 14; i++) {
        const x = ((i * 317 + now * 0.008) % (cam.vw + 240)) - 120;
        const y = 60 + ((i * 173) % Math.max(120, cam.vh - 120)) + Math.sin(now / 3000 + i) * 12;
        const g = ctx.createRadialGradient(x, y, 4, x, y, 70);
        g.addColorStop(0, 'rgba(255,255,255,0.7)');
        g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.ellipse(x, y, 70, 26, 0, 0, TAU);
        ctx.fill();
      }
      ctx.restore();
    } else if (realm === 'hell') {
      ctx.save();
      ctx.strokeStyle = 'rgba(255,110,40,0.45)';
      ctx.lineWidth = 3;
      for (let i = 0; i < 7; i++) {
        const x = (i * 223) % cam.vw;
        ctx.beginPath();
        ctx.moveTo(x, cam.vh);
        ctx.quadraticCurveTo(x + Math.sin(i + now / 900) * 40, cam.vh * 0.72, x + 80, cam.vh * 0.45);
        ctx.stroke();
      }
      ctx.restore();
    } else {
      ctx.save();
      for (let i = 0; i < 90; i++) {
        const x = (i * 149) % cam.vw;
        const y = (i * 271) % cam.vh;
        const tw = 0.35 + 0.65 * Math.abs(Math.sin(now / 700 + i));
        ctx.globalAlpha = tw;
        ctx.fillStyle = i % 11 === 0 ? '#9ad8ff' : '#ffffff';
        ctx.beginPath();
        ctx.arc(x, y, i % 17 === 0 ? 1.8 : 0.9, 0, TAU);
        ctx.fill();
      }
      ctx.restore();
    }
  }

  private drawRealmBoard(ctx: CanvasRenderingContext2D, now: number): void {
    if (this.view === 'world') return;
    const realm = this.view;
    const cam = this.camera;
    const detail = this.detailLevel();
    const accent =
      realm === 'heaven' ? { edge: '#c89a2a', core: '#fff5c8', glow: 'rgba(255,224,120,0.35)' }
        : realm === 'hell' ? { edge: '#6e1a12', core: '#ffb08a', glow: 'rgba(255,90,40,0.3)' }
          : { edge: '#1b6e94', core: '#a9f4ff', glow: 'rgba(90,220,255,0.32)' };
    const margin = 90;
    const toX = (x: number): number => cam.screenX(x);
    const toY = (y: number): number => cam.screenY(y);
    const edges = this.realmEdges.get(realm) ?? [];
    const path = new Path2D();
    const airPath = new Path2D();
    for (const e of edges) {
      const x1 = toX(e.ax);
      const y1 = toY(e.ay);
      const x2 = x1 + e.dx * cam.zoom;
      const y2 = y1 + e.dy * cam.zoom;
      if (Math.max(x1, x2) < -margin || Math.min(x1, x2) > cam.vw + margin) continue;
      if (Math.max(y1, y2) < -margin || Math.min(y1, y2) > cam.vh + margin) continue;
      if (e.mode === 'air') {
        const { qx, qy } = airLaneControl(x1, y1, x2, y2);
        airPath.moveTo(x1, y1);
        airPath.quadraticCurveTo(qx, qy, x2, y2);
        continue;
      }
      path.moveTo(x1, y1);
      path.lineTo(x2, y2);
    }
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const rs = this.viewScale();
    ctx.strokeStyle = accent.glow;
    ctx.lineWidth = 13 * rs;
    ctx.stroke(path);
    ctx.strokeStyle = accent.edge;
    ctx.lineWidth = 8 * rs;
    ctx.stroke(path);
    ctx.strokeStyle = accent.core;
    ctx.lineWidth = 3 * rs;
    ctx.stroke(path);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
    ctx.lineWidth = 2 * rs;
    ctx.setLineDash([5 * rs, 11 * rs]);
    ctx.stroke(airPath);
    ctx.setLineDash([]);
    ctx.restore();

    if (detail >= 1) {
      for (const node of this.nodesForView()) {
        if (node.kind === 'city') continue;
        const x = toX(node.x);
        const y = toY(node.y);
        if (x < -60 || x > cam.vw + 60 || y < -60 || y > cam.vh + 60) continue;
        const r = this.tileRadius();
        if (node.kind === 'portal') {
          this.drawPortal(ctx, node, x, y, r, now);
        } else if (node.kind === 'warp') {
          this.drawWarpTile(ctx, x, y, r, now, node.id);
        } else {
          this.drawGem(ctx, node, x, y, r, detail);
        }
      }
    }

    const radius = this.cityRadius();
    const entries = this.cityEntriesForView();
    const known = new Set(entries.map((e) => e.node.id));
    for (const entry of entries) {
      const x = cam.screenX(entry.node.x);
      const y = cam.screenY(entry.node.y);
      if (x < -180 || x > cam.vw + 180 || y < -180 || y > cam.vh + 180) continue;
      this.drawCityPedestalAt(ctx, x, y, radius, this.ownership.get(entry.city.id));
    }
    // Realm station rows can land before cities.json; keep them visible with a
    // generic station plate/label until the data catches up.
    for (const node of this.nodesForView()) {
      if (node.kind !== 'city' || known.has(node.id)) continue;
      const x = cam.screenX(node.x);
      const y = cam.screenY(node.y);
      if (x < -180 || x > cam.vw + 180 || y < -180 || y > cam.vh + 180) continue;
      this.drawCityPedestalAt(ctx, x, y, radius, undefined);
      const label = (node.cityId ?? node.id).replace(/-/g, ' ');
      ctx.save();
      ctx.font = `800 ${Math.max(10, 9.5 + cam.zoom * 1.25).toFixed(1)}px ${LABEL_FONT}`;
      const tw = ctx.measureText(label).width + 13;
      const bx = x - tw / 2;
      const by = y - radius - 27;
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#23385c';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.roundRect(bx, by, tw, 19, 10);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#1a2b4c';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, x, by + 10);
      ctx.restore();
    }
  }

  private drawPortal(
    ctx: CanvasRenderingContext2D,
    node: BoardNode,
    x: number,
    y: number,
    r: number,
    now: number,
  ): void {
    const realm = node.realm ?? 'world';
    const gold = realm === 'heaven';
    ctx.save();
    ctx.translate(x, y);
    const glow = ctx.createRadialGradient(0, 0, r * 0.2, 0, 0, r * 2.6);
    glow.addColorStop(0, gold ? 'rgba(255,240,150,0.85)' : 'rgba(160,230,255,0.8)');
    glow.addColorStop(1, 'rgba(255,240,150,0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(0, 0, r * 2.6, 0, TAU);
    ctx.fill();
    ctx.fillStyle = gold ? '#ffd75a' : realm === 'hell' ? '#ff6b4a' : '#5ad8ff';
    ctx.strokeStyle = '#24365c';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 0, r * 1.15, 0, TAU);
    ctx.fill();
    ctx.stroke();
    ctx.rotate(now / 380);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = Math.max(1.5, r * 0.2);
    for (let i = 0; i < 3; i++) {
      ctx.beginPath();
      const a = (i / 3) * TAU;
      ctx.arc(0, 0, r * 0.7, a, a + 1.4);
      ctx.stroke();
    }
    ctx.restore();
    if (realm === 'hell') {
      // 蜘蛛の糸: a thread from above the viewport to the portal.
      ctx.save();
      ctx.strokeStyle = 'rgba(235, 245, 255, 0.78)';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(x + 3, y - r * 1.2);
      ctx.quadraticCurveTo(x - 5, y - 80, x + 2, y - this.camera.vh);
      ctx.stroke();
      ctx.restore();
    }
  }

  private drawWarpTile(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, now: number, seed: string): void {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(Math.sin(hashString(seed) % 100) * 0.2);
    const grad = ctx.createLinearGradient(0, -r, 0, r);
    grad.addColorStop(0, '#d9fbff');
    grad.addColorStop(0.55, '#55c9e8');
    grad.addColorStop(1, '#2b6fbd');
    ctx.fillStyle = 'rgba(6,40,70,0.24)';
    ctx.beginPath();
    ctx.ellipse(0.8, r * 0.5 + 2, r * 0.95, r * 0.42, 0, 0, TAU);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, TAU);
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.lineWidth = Math.max(1.2, r * 0.16);
    ctx.strokeStyle = '#1d4e7c';
    ctx.stroke();
    ctx.rotate(now / 300);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = Math.max(1.4, r * 0.16);
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * TAU;
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.62, a, a + 1.1);
      ctx.stroke();
    }
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(0, 0, Math.max(1.2, r * 0.11), 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  /** Land + trees are already painted; this callback adds the static board geometry. */
  private paintStaticBoard(layer: LayerTransform): void {
    const { ctx, toCanvas, scale, dpr, ox, wWorld, hWorld } = layer;
    const centerX = ox + wWorld / 2;
    const wPx = wWorld * scale;
    const hPx = hWorld * scale;
    const margin = 80 * dpr;
    const detail0 = this.detailLevel();
    const overview = this.isOverview();
    this.drawMapArt(ctx, layer, detail0);
    this.drawTerrain(ctx, layer, detail0);
    this.drawCityClusters(ctx, layer, detail0);

    // --- sea routes + rails + sky lanes --------------------------------------
    const railPath = new Path2D();
    const seaPath = new Path2D();
    const sleeperPath = new Path2D();
    const chevronPath = new Path2D();
    const airPath = new Path2D();
    const airGlyphPath = new Path2D();
    const zoomForTrack = this.camera.zoom;
    const detailForTrack = this.detailLevel();
    for (const e of this.edges) {
      const ax = centerX + wrapDx(centerX, e.ax);
      const bx = ax + e.dx;
      const ay = e.ay;
      const by = ay + e.dy;
      const [x1, y1] = toCanvas(ax, ay);
      const [x2, y2] = toCanvas(bx, by);
      if (Math.max(x1, x2) < -margin || Math.min(x1, x2) > wPx + margin) continue;
      if (Math.max(y1, y2) < -margin || Math.min(y1, y2) > hPx + margin) continue;
      const lx = x2 - x1;
      const ly = y2 - y1;
      const len = Math.hypot(lx, ly);
      if (len < 4) continue;
      const ux = lx / len;
      const uy = ly / len;
      const nx = -uy;
      const ny = ux;
      if (e.mode === 'air') {
        // Sky lanes bow away from the straight line so flights read as arcs.
        const { qx, qy } = airLaneControl(x1, y1, x2, y2, 0.16, 66 * dpr);
        airPath.moveTo(x1, y1);
        airPath.quadraticCurveTo(qx, qy, x2, y2);
        if (!overview) {
          const sc = Math.max(2.6, 3.2 * dpr);
          for (let t = 0.28; t < 0.95; t += 0.32) {
            const p = lanePointAt(t, x1, y1, qx, qy, x2, y2);
            // small swept-wing plane glyph pointing along the lane
            airGlyphPath.moveTo(p.x + p.hx * sc, p.y + p.hy * sc);
            airGlyphPath.lineTo(p.x - p.hx * sc * 0.5 - p.hy * sc, p.y - p.hy * sc * 0.5 + p.hx * sc);
            airGlyphPath.lineTo(p.x - p.hx * sc * 0.15, p.y - p.hy * sc * 0.15);
            airGlyphPath.lineTo(p.x - p.hx * sc * 0.5 + p.hy * sc, p.y - p.hy * sc * 0.5 - p.hx * sc);
            airGlyphPath.closePath();
          }
        }
        continue;
      }
      const path = e.mode === 'sea' ? seaPath : railPath;
      path.moveTo(x1, y1);
      path.lineTo(x2, y2);
      if (e.mode === 'sea' && zoomForTrack >= 0.5 && !overview) {
        const interval = 34 * dpr;
        for (let d = interval; d < len; d += interval) {
          const t = d / len;
          const px = x1 + lx * t;
          const py = y1 + ly * t;
          chevronPath.moveTo(px - ux * 3 * dpr + nx * 2 * dpr, py - uy * 3 * dpr + ny * 2 * dpr);
          chevronPath.lineTo(px + nx * 2 * dpr, py + ny * 2 * dpr);
          chevronPath.lineTo(px - ux * 3 * dpr - nx * 2 * dpr, py - uy * 3 * dpr - ny * 2 * dpr);
        }
      } else if (e.mode === 'rail' && detailForTrack >= 1 && zoomForTrack >= 0.75 && !overview) {
        const interval = 15 * dpr;
        const half = Math.max(2 * dpr, zoomForTrack * 1.5 * dpr);
        for (let d = interval * 0.5; d < len; d += interval) {
          const t = d / len;
          const px = x1 + lx * t;
          const py = y1 + ly * t;
          sleeperPath.moveTo(px - nx * half, py - ny * half);
          sleeperPath.lineTo(px + nx * half, py + ny * half);
        }
      }
    }
    const zoom = this.camera.zoom;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = overview ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.92)';
    ctx.lineWidth = (overview ? 1.1 : Math.min(3.4, Math.max(1.4, 1 + zoom * 0.8))) * dpr;
    ctx.setLineDash([Math.max(2, zoom * 2.4) * dpr, Math.max(5, zoom * 5.2) * dpr]);
    ctx.stroke(seaPath);
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(232,255,255,0.85)';
    ctx.lineWidth = Math.max(1, 1.2 * dpr);
    ctx.stroke(chevronPath);
    const railW = overview ? 1.15 : Math.min(7, Math.max(1.8, 1.4 + zoom * 0.7));
    const dimTracks = !overview && zoom >= 0.65;
    if (dimTracks && detailForTrack >= 1 && zoom >= 0.75) {
      // Less grey mass at play zoom: a faint ballast shadow, sparse sleepers,
      // then a 1–1.5px bright core so the squares and landmarks win attention.
      ctx.strokeStyle = 'rgba(80, 94, 108, 0.28)';
      ctx.lineWidth = 3.4 * dpr;
      ctx.stroke(railPath);
      ctx.strokeStyle = 'rgba(122, 108, 86, 0.28)';
      ctx.lineWidth = Math.max(0.8, 0.65 * dpr);
      ctx.stroke(sleeperPath);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.96)';
      ctx.lineWidth = Math.max(1, 1.3 * dpr);
      ctx.stroke(railPath);
    } else if (detailForTrack >= 1 && zoom >= 0.75 && !overview) {
      ctx.strokeStyle = '#7d8790';
      ctx.lineWidth = (railW + 7) * dpr;
      ctx.stroke(railPath);
      ctx.strokeStyle = '#e9e2cf';
      ctx.lineWidth = (railW + 4) * dpr;
      ctx.stroke(railPath);
      ctx.strokeStyle = '#8b7658';
      ctx.lineWidth = Math.max(1.1, 1.2 * dpr);
      ctx.stroke(sleeperPath);
      ctx.strokeStyle = '#6f7a86';
      ctx.lineWidth = Math.max(1.2, railW * 0.7 * dpr);
      ctx.stroke(railPath);
    } else {
      ctx.strokeStyle = overview ? 'rgba(90,105,120,0.5)' : 'rgba(117,145,168,0.85)';
      ctx.lineWidth = (railW + (overview ? 1.4 : 2.8)) * dpr;
      ctx.stroke(railPath);
      ctx.strokeStyle = overview ? 'rgba(255,255,255,0.82)' : '#ffffff';
      ctx.lineWidth = railW * dpr;
      ctx.stroke(railPath);
    }
    // Sky lanes: a soft white underlay, a dotted blue line and plane glyphs.
    // Kept faint at play zoom so the lanes never compete with the squares.
    if (!overview) {
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.34)';
      ctx.lineWidth = 3.4 * dpr;
      ctx.stroke(airPath);
      ctx.strokeStyle = zoom >= 0.8 ? 'rgba(104, 190, 255, 0.38)' : 'rgba(104, 190, 255, 0.62)';
      ctx.lineWidth = Math.max(1, 1.25 * dpr);
      ctx.setLineDash([Math.max(1.5, 1.2 * dpr), Math.max(5, 6.5 * dpr)]);
      ctx.stroke(airPath);
      ctx.setLineDash([]);
      ctx.fillStyle = zoom >= 0.8 ? 'rgba(255, 255, 255, 0.72)' : 'rgba(255, 255, 255, 0.92)';
      ctx.fill(airGlyphPath);
      ctx.strokeStyle = 'rgba(40, 110, 160, 0.32)';
      ctx.lineWidth = 0.8 * dpr;
      ctx.stroke(airGlyphPath);
    }
    ctx.restore();

    const detail = this.detailLevel();
    const tileR = this.tileRadius() * dpr;
    const radius = this.cityRadius() * dpr;
    const cityPad = 90 * dpr;

    // --- gems ----------------------------------------------------------------
    if (detail >= 1) {
      for (const node of this.worldNodes) {
        if (node.kind === 'city' || node.kind === 'warp') continue;
        const wx = centerX + wrapDx(centerX, node.x);
        const [px, py] = toCanvas(wx, node.y);
        if (px < -tileR - 10 * dpr || px > wPx + tileR + 10 * dpr) continue;
        if (py < -tileR - 10 * dpr || py > hPx + tileR + 10 * dpr) continue;
        this.drawGem(ctx, node, px, py, tileR, detail);
      }
    }

    // --- city pedestals / overview dots ------------------------------------
    for (const entry of this.cityEntries) {
      const wx = centerX + wrapDx(centerX, entry.node.x);
      const [px, py] = toCanvas(wx, entry.node.y);
      if (px < -cityPad || px > wPx + cityPad || py < -cityPad || py > hPx + cityPad) continue;
      if (overview) {
        if (entry.city.tier !== 1) continue;
        const rr = (entry.city.id === this.state?.destination ? 5.6 : 4.6) * dpr;
        ctx.beginPath();
        ctx.arc(px, py, rr, 0, TAU);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.strokeStyle = '#23385c';
        ctx.lineWidth = 1.4 * dpr;
        ctx.stroke();
      } else {
        this.drawCityPedestalAt(ctx, px, py, radius, this.ownership.get(entry.city.id));
      }
    }
  }

  private drawCities(ctx: CanvasRenderingContext2D, now: number): void {
    const cam = this.camera;
    const radius = this.cityRadius();
    const detail = this.detailLevel();
    this.cityHits = [];
    this.cityLabelHits = [];
    this.cityLabelDrawn = [];
    this.cityHitGrid.clear();
    this.cityLabelGrid.clear();
    const visible: CityVis[] = [];
    for (const entry of this.cityEntriesForView()) {
      const x = cam.screenX(entry.node.x);
      if (x < -150 || x > cam.vw + 150) continue;
      const y = cam.screenY(entry.node.y);
      if (y < -150 || y > cam.vh + 150) continue;
      visible.push({ entry, x, y });
    }

    const destination = this.view === 'world' ? visible.find((v) => v.entry.node.id === this.destinationNodeId) ?? null : null;
    if (destination) this.drawDestinationPulse(ctx, destination, radius, now);

    for (const v of visible) {
      const hit = {
        cityId: v.entry.city.id,
        x: v.x,
        y: v.y,
        r: Math.max(16, radius + 9),
      };
      this.cityHits.push(hit);
      this.cityHitGrid.add({ x: hit.x - hit.r, y: hit.y - hit.r, w: hit.r * 2, h: hit.r * 2 }, hit);
    }

    if (destination) this.drawDestinationFlag(ctx, destination, radius, now);
    for (const v of visible) {
      if (!v.entry.city.landmark) continue;
      if (detail === 0 && v.entry.city.tier !== 1) continue;
      const img = this.assets.landmarks.get(v.entry.city.landmark);
      if (!img) continue;
      const box = this.landmarkBox(v.x, v.y, radius, img, 1, v.entry.city.tier);
      const bob = this.reducedMotion ? 0 : Math.sin(now / 800 + (hashString(v.entry.city.id) % 100)) * 2;
      ctx.save();
      ctx.globalAlpha = 0.18;
      ctx.fillStyle = '#06314a';
      ctx.beginPath();
      ctx.ellipse(box.cx, box.cy + box.h * 0.46, box.w * 0.36, Math.max(2, box.w * 0.1), 0, 0, TAU);
      ctx.fill();
      ctx.restore();
      ctx.drawImage(img, box.cx - box.w / 2, box.cy - box.h / 2 + bob, box.w, box.h);
    }
    for (const v of visible) {
      const owner = this.ownership.get(v.entry.city.id);
      if (!owner || owner.total <= 0) continue;
      let top = -1; let best = 0;
      for (let i = 0; i < owner.counts.length; i++) if (owner.counts[i] > best) { best = owner.counts[i]; top = i; }
      if (top < 0) continue;
      const fx = v.x + radius * 0.75;
      const fy = v.y - radius * 0.95;
      ctx.save();
      ctx.strokeStyle = '#23385c';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(fx, fy + 12); ctx.lineTo(fx, fy - 8); ctx.stroke();
      ctx.fillStyle = this.playerColor(top);
      const wave = Math.sin(now / 220 + v.x) * 2;
      ctx.beginPath(); ctx.moveTo(fx, fy - 8); ctx.quadraticCurveTo(fx + 9, fy - 6 + wave, fx + 16, fy - 2); ctx.lineTo(fx, fy + 2); ctx.closePath(); ctx.fill();
      ctx.restore();
    }

    // Labels are placed statically; sprites over them only fade the name out.
    this.drawCityLabels(ctx, visible, detail);
  }

  private landmarkSize(tier: number): number {
    if (this.detailLevel() === 0) return tier === 1 ? 40 : 0;
    return Math.min(58, Math.max(42, 34 + this.camera.zoom * 12));
  }

  private landmarkBox(
    x: number,
    y: number,
    radius: number,
    img: HTMLImageElement,
    unit: number,
    tier: number,
  ): { cx: number; cy: number; w: number; h: number } {
    const size = this.landmarkSize(tier) * unit;
    const aspect = img.naturalWidth > 0 ? img.naturalWidth / img.naturalHeight : 0.9;
    let w = size;
    let h = size;
    if (aspect > 1) h = size / aspect;
    else w = size * aspect;
    const dir = hashString(img.src) % 2 === 0 ? 1 : -1;
    const cx = x + dir * (radius + w * 0.6);
    const cy = y - h * 0.55 - radius * 0.2;
    return { cx, cy, w, h };
  }

  private drawCityPedestalAt(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    radius: number,
    owner: { counts: number[]; total: number; monopoly: number } | undefined,
  ): void {
    const w = radius * 2.25;
    const h = radius * 1.5;
    const left = x - w / 2;
    const top = y - h * 0.62;
    let topPlayer = -1;
    let best = 0;
    if (owner) {
      for (let i = 0; i < owner.counts.length; i++) {
        if (owner.counts[i] > best) { best = owner.counts[i]; topPlayer = i; }
      }
    }
    const plateColor = topPlayer >= 0 ? this.playerColor(topPlayer) : '#f7fcff';
    const roofColor = topPlayer >= 0 ? this.playerColor(topPlayer) : '#8ecdf2';
    ctx.save();
    ctx.fillStyle = 'rgba(7, 35, 57, 0.36)';
    ctx.beginPath();
    ctx.roundRect(left + 1.5, top + 3, w, h, h * 0.3);
    ctx.fill();

    // roof / station plate
    ctx.beginPath();
    ctx.moveTo(left - radius * 0.16, top + 1);
    ctx.lineTo(left + w * 0.14, top - h * 0.42);
    ctx.lineTo(left + w * 0.86, top - h * 0.42);
    ctx.lineTo(left + w + radius * 0.16, top + 1);
    ctx.closePath();
    ctx.fillStyle = roofColor;
    ctx.fill();
    ctx.lineWidth = Math.max(1.4, radius * 0.11);
    ctx.strokeStyle = '#23385c';
    ctx.stroke();

    ctx.beginPath();
    ctx.roundRect(left, top, w, h, h * 0.3);
    ctx.fillStyle = plateColor;
    ctx.fill();
    ctx.lineWidth = Math.max(1.5, radius * 0.12);
    ctx.strokeStyle = '#23385c';
    ctx.stroke();

    ctx.beginPath();
    ctx.roundRect(left + w * 0.13, top + h * 0.18, w * 0.74, h * 0.42, h * 0.14);
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(35,56,92,0.7)';
    ctx.lineWidth = Math.max(1, radius * 0.05);
    ctx.stroke();
    ctx.fillStyle = '#4d5c73';
    ctx.fillRect(left + w * 0.21, top + h * 0.3, w * 0.22, h * 0.16);
    ctx.fillRect(left + w * 0.5, top + h * 0.3, w * 0.22, h * 0.16);
    // small station mark so an unlabelled plate never reads as a blank label
    ctx.fillStyle = '#23385c';
    ctx.beginPath();
    ctx.roundRect(left + w * 0.43, top + h * 0.58, w * 0.14, h * 0.24, h * 0.06);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(left + w * 0.46, top + h * 0.63, w * 0.035, h * 0.07);
    ctx.fillRect(left + w * 0.515, top + h * 0.63, w * 0.035, h * 0.07);

    if (owner && owner.total > 0) {
      let owned = 0;
      for (const c of owner.counts) owned += c;
      if (owned > 0) {
        const bx = left + 3;
        const by = top + h - 6.5;
        const bw = w - 6;
        const bh = 4.2;
        ctx.save();
        ctx.beginPath();
        ctx.roundRect(bx, by, bw, bh, 2);
        ctx.clip();
        let cursor = bx;
        for (let i = 0; i < owner.counts.length; i++) {
          const count = owner.counts[i];
          if (count <= 0) continue;
          const sw = (count / owner.total) * bw;
          ctx.fillStyle = this.playerColor(i);
          ctx.fillRect(cursor, by, sw, bh);
          cursor += sw;
        }
        ctx.restore();
      }
    }

    if (owner && owner.monopoly >= 0) {
      ctx.beginPath();
      ctx.roundRect(left - 1.6, top - 1.6, w + 3.2, h + 3.2, h * 0.34);
      ctx.strokeStyle = '#ffc928';
      ctx.lineWidth = Math.max(2, radius * 0.16);
      ctx.shadowColor = 'rgba(255, 200, 40, 0.8)';
      ctx.shadowBlur = radius * 0.55;
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawGem(
    ctx: CanvasRenderingContext2D,
    node: BoardNode,
    x: number,
    y: number,
    r: number,
    detail: number,
  ): void {
    const palette = gemColors(node.kind);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(((hashString(node.id) % 100) / 100 - 0.5) * 0.1);
    if (this.airNodes.has(node.id) && detail >= 1) {
      // cloud base: sky squares float on a small cloud instead of bare ground
      ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
      ctx.beginPath();
      ctx.ellipse(-r * 0.5, r * 0.5, r * 0.62, r * 0.3, 0, 0, TAU);
      ctx.ellipse(r * 0.5, r * 0.48, r * 0.58, r * 0.28, 0, 0, TAU);
      ctx.ellipse(0, r * 0.38, r * 0.82, r * 0.36, 0, 0, TAU);
      ctx.fill();
    }
    ctx.fillStyle = 'rgba(6, 40, 70, 0.26)';
    ctx.beginPath();
    ctx.ellipse(0.8, r * 0.56 + 2, r * 1.03, r * 0.44, 0, 0, TAU);
    ctx.fill();
    const shape = (dy: number, scale = 1): void => {
      const rr = r * scale;
      ctx.beginPath();
      if (node.kind === 'red' || node.kind === 'shop') {
        ctx.roundRect(-rr, -rr + dy, rr * 2, rr * 2, node.kind === 'shop' ? rr * 0.44 : rr * 0.24);
      } else if (node.kind === 'yellow') {
        ctx.moveTo(0, -rr + dy);
        ctx.lineTo(rr, dy);
        ctx.lineTo(0, rr + dy);
        ctx.lineTo(-rr, dy);
        ctx.closePath();
      } else if (node.kind === 'news') {
        for (let i = 0; i < 8; i++) {
          const a = -Math.PI / 2 + (i / 8) * TAU;
          const px = Math.cos(a) * rr;
          const py = Math.sin(a) * rr + dy;
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.closePath();
      } else {
        ctx.arc(0, dy, rr, 0, TAU);
      }
    };
    // 2–3 px side / thickness under the top face
    shape(3.2);
    ctx.fillStyle = palette.edge;
    ctx.fill();
    shape(2.2, 0.96);
    ctx.fillStyle = palette.dark;
    ctx.fill();
    const grad = ctx.createLinearGradient(0, -r, 0, r);
    grad.addColorStop(0, palette.light);
    grad.addColorStop(0.55, palette.main);
    grad.addColorStop(1, palette.dark);
    shape(0);
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.lineWidth = Math.max(1.3, r * 0.17);
    ctx.strokeStyle = palette.edge;
    ctx.stroke();
    shape(0, 0.72);
    ctx.strokeStyle = 'rgba(255,255,255,0.4)';
    ctx.lineWidth = Math.max(1, r * 0.1);
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(-r * 0.28, -r * 0.42, r * 0.46, r * 0.2, -0.45, 0, TAU);
    ctx.fillStyle = 'rgba(255,255,255,0.48)';
    ctx.fill();
    if (node.kind === 'shop' && r >= 7) {
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = 'rgba(80,40,0,0.55)';
      ctx.lineWidth = 1;
      for (let i = 0; i < 2; i++) {
        ctx.beginPath();
        ctx.roundRect(-r * 0.36 + i * r * 0.25, -r * 0.34 + i * r * 0.1, r * 0.44, r * 0.58, r * 0.08);
        ctx.fill();
        ctx.stroke();
      }
      ctx.fillStyle = '#ffb020';
      ctx.beginPath();
      ctx.arc(r * 0.12, 0, r * 0.13, 0, TAU);
      ctx.fill();
    } else {
      const sym = node.kind === 'blue' ? '＋' : node.kind === 'red' ? '−' : node.kind === 'yellow' ? '？' : node.kind === 'news' ? '！' : '';
      if (sym && r >= 6) {
        ctx.font = `bold ${r * 1.3}px ${LABEL_FONT}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.strokeStyle = 'rgba(20,40,70,0.45)';
        ctx.lineWidth = Math.max(1.1, r * 0.08);
        ctx.strokeText(sym, 0, r * 0.04);
        ctx.fillStyle = '#ffffff';
        ctx.fillText(sym, 0, r * 0.04);
      } else if (detail >= 2 && r >= 8) {
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        ctx.beginPath();
        ctx.arc(-r * 0.25, -r * 0.22, Math.max(1.3, r * 0.11), 0, TAU);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  private drawDestinationPulse(
    ctx: CanvasRenderingContext2D,
    dest: CityVis,
    radius: number,
    now: number,
  ): void {
    ctx.save();
    for (let i = 0; i < 3; i++) {
      const p = ((now / 1800 + i / 3) % 1);
      const rr = radius * (1.05 + p * 1.85);
      ctx.globalAlpha = (1 - p) * 0.55;
      ctx.strokeStyle = '#ffe45c';
      ctx.lineWidth = Math.max(1.5, 3.6 * (1 - p));
      ctx.beginPath();
      ctx.ellipse(dest.x, dest.y, rr * 1.1, rr * 0.72, 0, 0, TAU);
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawDestinationFlag(ctx: CanvasRenderingContext2D, dest: CityVis, radius: number, now: number): Rect {
    const s = Math.min(24, Math.max(11, 9 + this.camera.zoom * 6));
    const poleX = dest.x + radius * 0.68;
    const baseY = dest.y - radius * 0.5;
    const topY = baseY - s * 2.25;
    const wave = Math.sin(now / 170) * 2.2;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(15, 36, 60, 0.9)';
    ctx.lineWidth = 3.6;
    ctx.beginPath();
    ctx.moveTo(poleX, baseY);
    ctx.lineTo(poleX, topY);
    ctx.stroke();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.moveTo(poleX, baseY);
    ctx.lineTo(poleX, topY);
    ctx.stroke();

    const fw = s * 1.45;
    const fh = s * 0.95;
    const cols = 4;
    const rows = 3;
    ctx.save();
    ctx.translate(poleX + 1, topY + 1);
    ctx.rotate(wave * 0.012);
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        ctx.fillStyle = (row + col) % 2 === 0 ? '#1b2b47' : '#ffffff';
        ctx.fillRect((col * fw) / cols, (row * fh) / rows + Math.sin(col * 0.7 + now / 220) * 1.2, fw / cols + 0.4, fh / rows + 0.4);
      }
    }
    ctx.strokeStyle = 'rgba(18, 32, 54, 0.85)';
    ctx.lineWidth = 1.2;
    ctx.strokeRect(0, 0, fw, fh);
    ctx.restore();
    ctx.restore();
    return { x: poleX - 3, y: topY - 4, w: fw + 8, h: baseY - topY + 8 };
  }

  private drawCityLabels(ctx: CanvasRenderingContext2D, visible: CityVis[], detail: number): void {
    this.ensureLabelLayout();
    const board = this.boardBox();
    const now = performance.now();
    const currentCityId = this.state ? this.cityNodeIdOfPlayer(this.state.current) : null;
    const tokenNodeIds = new Set(this.tokens.map((t) => t.nodeId));
    const optionCities = new Set(
      (this.moveOptions ?? []).filter((o) => this.nodeById.get(o.nodeId)?.kind === 'city').map((o) => o.nodeId),
    );
    // Labels that must never fade out, and whose slot never changes with game state.
    const priority = (v: CityVis): boolean =>
      v.entry.node.id === this.destinationNodeId
      || v.entry.node.id === currentCityId
      || tokenNodeIds.has(v.entry.node.id)
      || optionCities.has(v.entry.node.id);
    const blockers = this.dynamicLabelBlockers(now);
    const ratio = this.camera.zoom / this.labelLayoutRefZoom;
    for (const v of visible) {
      const city = v.entry.city;
      const plan = this.cityLabelPlan.get(city.id);
      if (!plan) continue;
      const isPriority = priority(v);
      if (detail === 0 && !isPriority && city.tier !== 1) continue;
      // A crowded bucket hides the label; it is never pushed to another slot.
      if (plan.slot < 0 && !isPriority) continue;
      const w = plan.w * ratio;
      const h = plan.h * ratio;
      const rect = {
        x: v.x + plan.dx * ratio - w / 2,
        y: v.y + plan.dy * ratio - h / 2,
        w,
        h,
      };
      if (rect.x < board.x + 3 || rect.y < board.y + 3
        || rect.x + rect.w > board.x + board.w - 3 || rect.y + rect.h > board.y + board.h - 3) continue;
      let alpha = 1;
      if (!isPriority) {
        alpha = this.labelFade.update(
          `city:${city.id}`,
          !blockers.some((b) => rectsOverlap(rect, b, 2)),
          now,
        );
        if (alpha <= 0.02) continue;
      }
      const labelHit = { cityId: city.id, rect };
      this.cityLabelHits.push(labelHit);
      this.cityLabelGrid.add(rect, labelHit);
      this.cityLabelDrawn.push({ id: city.id, rect, ax: v.x, ay: v.y });
      this.drawLabelBubble(
        ctx,
        v.x,
        v.y,
        rect,
        plan,
        ratio,
        v.entry.node.id === this.destinationNodeId,
        this.ownership.get(city.id),
        alpha,
      );
    }
  }

  private cityNodeIdOfPlayer(playerId: number): string | null {
    if (!this.state) return null;
    const player = this.state.players[playerId];
    if (!player) return null;
    const city = this.cityEntries.find((c) => c.node.id === player.nodeId);
    return city?.node.id ?? null;
  }

  private drawLabelBubble(
    ctx: CanvasRenderingContext2D,
    nodeX: number,
    nodeY: number,
    rect: Rect,
    plan: CityLabelPlan,
    ratio: number,
    isDestination: boolean,
    owner: { counts: number[]; total: number; monopoly: number } | undefined,
    alpha: number,
  ): void {
    const fs = plan.fs * ratio;
    const kanaFs = plan.kanaFs * ratio;
    ctx.save();
    if (alpha < 1) ctx.globalAlpha = alpha;
    // leader/tail
    const nx = Math.max(rect.x, Math.min(nodeX, rect.x + rect.w));
    const ny = Math.max(rect.y, Math.min(nodeY, rect.y + rect.h));
    const dist = Math.hypot(nx - nodeX, ny - nodeY);
    if (dist > 2) {
      ctx.strokeStyle = 'rgba(18, 44, 78, 0.4)';
      ctx.lineWidth = 3.2;
      ctx.beginPath();
      ctx.moveTo(nodeX, nodeY);
      ctx.lineTo(nx, ny);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.95)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    ctx.fillStyle = 'rgba(9, 30, 58, 0.28)';
    ctx.beginPath();
    ctx.roundRect(rect.x + 0.5, rect.y + 2.2, rect.w, rect.h, (rect.h + 2) / 2);
    ctx.fill();

    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.roundRect(rect.x, rect.y, rect.w, rect.h, (rect.h + 2) / 2);
    ctx.fill();
    ctx.lineWidth = isDestination ? 2.2 : 1.55;
    ctx.strokeStyle = isDestination ? '#f0a900' : '#23385c';
    ctx.stroke();

    if (owner && owner.monopoly >= 0) {
      ctx.strokeStyle = 'rgba(255, 200, 40, 0.9)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    if (owner && owner.total > 0) {
      let topPlayer = -1;
      let best = 0;
      for (let i = 0; i < owner.counts.length; i++) {
        if (owner.counts[i] > best) {
          best = owner.counts[i];
          topPlayer = i;
        }
      }
      if (topPlayer >= 0) {
        ctx.fillStyle = this.playerColor(topPlayer);
        ctx.beginPath();
        ctx.arc(rect.x + 6.2, rect.y + rect.h / 2, 2.4, 0, TAU);
        ctx.fill();
      }
    }

    ctx.fillStyle = '#1a2b4c';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const centerX = rect.x + rect.w / 2 + (owner && owner.total > 0 ? 2 : 0);
    if (plan.kana) {
      // Furigana sits above the name inside the same bubble, centred on it.
      const nameY = rect.y + rect.h - 4 - fs / 2;
      ctx.font = `800 ${fs.toFixed(1)}px ${LABEL_FONT}`;
      ctx.fillText(plan.text, centerX, nameY);
      ctx.font = `800 ${kanaFs.toFixed(1)}px ${LABEL_FONT}`;
      ctx.fillStyle = '#44557a';
      ctx.fillText(plan.kana, centerX, rect.y + 3 + kanaFs / 2);
    } else {
      ctx.font = `800 ${fs.toFixed(1)}px ${LABEL_FONT}`;
      ctx.fillText(plan.text, centerX, rect.y + rect.h / 2 + 0.5);
    }
    ctx.restore();
  }

  private measureText(ctx: CanvasRenderingContext2D, text: string, font: string): number {
    const key = `${font}|${text}`;
    const cached = this.measureCache.get(key);
    if (cached !== undefined) return cached;
    ctx.save();
    ctx.font = font;
    const width = ctx.measureText(text).width;
    ctx.restore();
    // Label layouts measure the same names at every zoom bucket; a larger cap
    // avoids clearing the cache (and re-measuring every name) mid-session.
    if (this.measureCache.size > 12000) this.measureCache.clear();
    this.measureCache.set(key, width);
    return width;
  }

  // ---------------------------------------------------------------- move selection

  private drawMoveUi(ctx: CanvasRenderingContext2D, now: number): void {
    if (!this.moveOptions || this.moveOptions.length === 0) return;
    this.drawMoveRoutes(ctx, now);
  }

  /** Screen polyline for an option, starting at the actor's current square. */
  private optionScreenPath(option: MoveOption): Array<[number, number]> | null {
    const currentId = this.state?.players[this.state.current]?.nodeId;
    const ids = currentId && option.path[0] !== currentId ? [currentId, ...option.path] : option.path;
    if (ids.length < 2) return null;
    const cam = this.camera;
    const first = this.nodeById.get(ids[0]);
    if (!first) return null;
    let sx = cam.screenX(first.x);
    let sy = cam.screenY(first.y);
    const points: Array<[number, number]> = [[sx, sy]];
    let prev = first;
    for (let i = 1; i < ids.length; i++) {
      const node = this.nodeById.get(ids[i]);
      if (!node) break;
      sx += wrapDx(prev.x, node.x) * cam.zoom;
      sy += (node.y - prev.y) * cam.zoom;
      points.push([sx, sy]);
      prev = node;
    }
    return points.length >= 2 ? points : null;
  }

  /**
   * Dim everything except the actor, the candidate squares and their corridors.
   *
   * One path: a board-sized rect wound one way plus reverse-wound holes. With
   * the non-zero fill rule overlapping holes stay open, unlike even-odd.
   */
  private drawMoveSpotlight(ctx: CanvasRenderingContext2D): void {
    if (!this.moveOptions || this.moveOptions.length === 0) return;
    const cam = this.camera;
    const r = this.tileRadius();
    const currentId = this.state?.players[this.state.current]?.nodeId ?? null;
    const current = currentId ? this.nodeById.get(currentId) : null;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, cam.vw, cam.vh);
    const hole = (x: number, y: number, radius: number): void => {
      ctx.moveTo(x + radius, y);
      ctx.arc(x, y, radius, 0, TAU, true);
    };
    if (current) hole(cam.screenX(current.x), cam.screenY(current.y), r + 44);
    for (const option of this.moveOptions) {
      const points = this.optionScreenPath(option);
      if (!points) continue;
      for (let i = 1; i < points.length; i++) {
        const [x1, y1] = points[i - 1];
        const [x2, y2] = points[i];
        const steps = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / 12));
        for (let s = 0; s <= steps; s++) {
          const t = s / steps;
          hole(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, 15);
        }
      }
    }
    for (const option of this.moveOptions) {
      const node = this.nodeById.get(option.nodeId);
      if (!node) continue;
      hole(cam.screenX(node.x), cam.screenY(node.y), r + 32);
    }
    ctx.fillStyle = 'rgba(4, 12, 26, 0.57)';
    ctx.fill();
    ctx.restore();
  }

  /** Gold route for every candidate; the current pick is thicker, the rest fade back. */
  private drawMoveRoutes(ctx: CanvasRenderingContext2D, now: number): void {
    if (!this.moveOptions || this.moveOptions.length === 0) return;
    const shown = this.selectedOption ?? this.hoveredOption ?? this.getRecommendedMoveOption();
    for (const option of this.moveOptions) {
      if (option.nodeId === shown) continue;
      this.strokeOptionRoute(ctx, option, false, now);
    }
    const picked = shown ? this.moveOptions.find((o) => o.nodeId === shown) : null;
    if (picked) this.strokeOptionRoute(ctx, picked, true, now);
  }

  private strokeOptionRoute(
    ctx: CanvasRenderingContext2D,
    option: MoveOption,
    selected: boolean,
    now: number,
  ): void {
    const points = this.optionScreenPath(option);
    if (!points) return;
    const trace = (): void => {
      ctx.beginPath();
      ctx.moveTo(points[0][0], points[0][1]);
      for (let i = 1; i < points.length; i++) ctx.lineTo(points[i][0], points[i][1]);
    };
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    trace();
    ctx.strokeStyle = selected ? 'rgba(12, 34, 62, 0.85)' : 'rgba(12, 34, 62, 0.35)';
    ctx.lineWidth = selected ? 11 : 3.2;
    ctx.stroke();
    trace();
    ctx.strokeStyle = selected ? 'rgba(255, 214, 45, 0.98)' : 'rgba(255, 224, 120, 0.28)';
    ctx.lineWidth = selected ? 6.5 : 1.6;
    ctx.stroke();
    if (!selected) {
      ctx.restore();
      return;
    }
    this.drawRouteChevrons(ctx, points, true, now);
    const end = points[points.length - 1];
    ctx.fillStyle = selected ? '#ffd83d' : 'rgba(255, 216, 61, 0.9)';
    ctx.beginPath();
    ctx.arc(end[0], end[1], selected ? 7 : 5.5, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = '#23385c';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();
  }

  /** Direction arrows marching along a route; static when reduced motion is on. */
  private drawRouteChevrons(
    ctx: CanvasRenderingContext2D,
    points: Array<[number, number]>,
    strong: boolean,
    now: number,
  ): void {
    const step = strong ? 44 : 52;
    const drift = this.reducedMotion ? 0 : (now / 26) % step;
    const size = strong ? 6.5 : 5;
    ctx.save();
    ctx.beginPath();
    ctx.fillStyle = strong ? 'rgba(255, 253, 240, 0.98)' : 'rgba(255, 253, 240, 0.8)';
    ctx.strokeStyle = 'rgba(20, 40, 66, 0.6)';
    ctx.lineWidth = 1;
    let travelled = 0;
    for (let i = 1; i < points.length; i++) {
      const [x1, y1] = points[i - 1];
      const [x2, y2] = points[i];
      const len = Math.hypot(x2 - x1, y2 - y1);
      if (len < 1) continue;
      const ux = (x2 - x1) / len;
      const uy = (y2 - y1) / len;
      let d = (step - ((travelled + drift) % step)) % step;
      for (; d <= len; d += step) {
        const px = x1 + ux * d;
        const py = y1 + uy * d;
        const nx = -uy * size * 0.85;
        const ny = ux * size * 0.85;
        ctx.moveTo(px + ux * size, py + uy * size);
        ctx.lineTo(px - ux * size + nx, py - uy * size + ny);
        ctx.lineTo(px - ux * size - nx, py - uy * size - ny);
        ctx.closePath();
      }
      travelled += len;
    }
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  private drawSelectedPathOverlay(ctx: CanvasRenderingContext2D): void {
    if (!this.selectedOption || !this.moveOptions) return;
    const option = this.moveOptions.find((o) => o.nodeId === this.selectedOption);
    if (!option) return;
    this.strokeOptionRoute(ctx, option, true, performance.now());
  }

  private drawOptionMarkers(ctx: CanvasRenderingContext2D, now: number): void {
    this.optionPinHits = [];
    this.edgePinHits = [];
    if (!this.moveOptions || this.moveOptions.length === 0) return;
    const cam = this.camera;
    const r = this.tileRadius();
    const board = this.boardBox();
    const recommended = this.getRecommendedMoveOption();
    const pinEveryCandidate = this.moveOptions.length <= 8;
    const chipRadius = Math.min(12, Math.max(7, r * 0.72));
    const pinBoxes: Rect[] = [];
    const chips: Array<{ x: number; y: number; r: number }> = [];
    this.moveOptions.forEach((option, index) => {
      const node = this.nodeById.get(option.nodeId);
      if (!node) return;
      const x = cam.screenX(node.x);
      const y = cam.screenY(node.y);
      // Markers stay inside the HUD-free board; outside candidates get edge badges.
      if (x < board.x - 12 || x > board.x + board.w + 12 || y < board.y - 12 || y > board.y + board.h + 12) return;
      const selected = this.selectedOption === option.nodeId;
      const isRecommended = option.nodeId === recommended;
      const hovered = this.hoveredOption === option.nodeId;
      const chip = moveKindChip(node.kind);
      const number = this.moveHooks?.numbers?.[index] ?? index + 1;
      const pulse = this.reducedMotion ? 0.35 : (Math.sin(now / 320 + index * 1.4) + 1) / 2;
      const ring = r + 7 + pulse * 3 + (selected ? 4 : 0);
      // 光っているマス: kind-coloured glow + clean rings, no pin.
      ctx.save();
      const glow = ctx.createRadialGradient(x, y, r * 0.3, x, y, ring + 14);
      glow.addColorStop(0, chip.color);
      glow.addColorStop(0.5, chip.color);
      glow.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.globalAlpha = selected ? 0.52 : isRecommended ? 0.44 : 0.34;
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(x, y, ring + 14, 0, TAU);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.ellipse(x, y + 1, ring * 1.1 + 2, ring * 0.88 + 2, 0, 0, TAU);
      ctx.strokeStyle = 'rgba(8, 24, 44, 0.5)';
      ctx.lineWidth = selected ? 6 : 4;
      ctx.stroke();
      ctx.beginPath();
      ctx.ellipse(x, y + 1, ring * 1.1, ring * 0.88, 0, 0, TAU);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = selected ? 4.4 : 3;
      ctx.stroke();
      ctx.beginPath();
      ctx.ellipse(x, y + 1, ring * 0.88, ring * 0.68, 0, 0, TAU);
      ctx.strokeStyle = selected ? '#ffd83d' : isRecommended ? '#ffe46b' : hovered ? '#ffffff' : chip.color;
      ctx.lineWidth = selected || isRecommended ? 3.2 : 2.2;
      ctx.stroke();
      ctx.restore();

      // Big numbered pin only for the selected, the recommended, or few candidates.
      const wantsPin = selected || isRecommended || pinEveryCandidate;
      const pinBox = { x: x - 20, y: y - r - 50, w: 40, h: 50 + r };
      const pinFree = pinBox.y >= board.y + 2 && !pinBoxes.some((box) => rectsOverlap(pinBox, box, 2));
      if (wantsPin && (pinFree || ((selected || isRecommended) && pinBox.y >= board.y + 2))) {
        pinBoxes.push(pinBox);
        this.drawOptionPin(ctx, option.nodeId, x, y, r, node.kind, chip, number, selected, isRecommended, now, index);
        return;
      }
      if (r < 9) return;
      // Crowded case: small number chip inside the ring, never stacked.
      const cx = x;
      const cy = y - r * 0.1;
      const chipBox = { x: cx - chipRadius, y: cy - chipRadius, w: chipRadius * 2, h: chipRadius * 2 };
      if (pinBoxes.some((box) => rectsOverlap(chipBox, box, 1))) return;
      if (chips.some((c) => Math.hypot(cx - c.x, cy - c.y) < c.r + chipRadius + 3)) return;
      chips.push({ x: cx, y: cy, r: chipRadius });
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, chipRadius, 0, TAU);
      ctx.fillStyle = chip.color;
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.stroke();
      const darkText = node.kind === 'yellow' || node.kind === 'shop' || node.kind === 'portal';
      ctx.fillStyle = darkText ? '#20315a' : '#ffffff';
      ctx.font = `800 ${Math.max(8, chipRadius * 1.2).toFixed(0)}px ${LABEL_FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(number), cx, cy + 0.5);
      ctx.restore();
      this.optionPinHits.push({ nodeId: option.nodeId, x: cx, y: cy, r: Math.max(14, chipRadius + 6) });
    });

    // Edge badges only for candidates off the usable board, nearest first and
    // capped so a crowded turn never becomes a wall of badges. The remainder
    // collapses into one "+N" counter.
    const offBoard: Array<{ index: number; node: BoardNode; x: number; y: number }> = [];
    this.moveOptions.forEach((option, index) => {
      const node = this.nodeById.get(option.nodeId);
      if (!node) return;
      const x = cam.screenX(node.x);
      const y = cam.screenY(node.y);
      if (x >= board.x - 24 && x <= board.x + board.w + 24
        && y >= board.y - 24 && y <= board.y + board.h + 24) return;
      offBoard.push({ index, node, x, y });
    });
    offBoard.sort((a, b) => {
      const pinA = a.node.id === recommended || a.node.id === this.selectedOption ? 1 : 0;
      const pinB = b.node.id === recommended || b.node.id === this.selectedOption ? 1 : 0;
      if (pinA !== pinB) return pinB - pinA;
      return (this.moveOptions?.[a.index]?.path.length ?? 0) - (this.moveOptions?.[b.index]?.path.length ?? 0);
    });
    const MAX_EDGE_BADGES = 6;
    const hiddenOffBoard = Math.max(0, offBoard.length - MAX_EDGE_BADGES);
    const placedBadges: Array<{ x: number; y: number }> = [];
    offBoard.slice(0, MAX_EDGE_BADGES).forEach(({ index, node, x, y }) => {
      let bx = Math.max(board.x + 26, Math.min(board.x + board.w - 26, x));
      let by = Math.max(board.y + 26, Math.min(board.y + board.h - 26, y));
      for (let guard = 0; guard < 10; guard++) {
        const clash = placedBadges.some((p) => Math.hypot(p.x - bx, p.y - by) < 46);
        if (!clash) break;
        if (bx <= board.x + 30 || bx >= board.x + board.w - 30) {
          by += by < cam.vh / 2 ? 46 : -46;
        } else {
          bx += bx < cam.vw / 2 ? 46 : -46;
        }
        bx = Math.max(board.x + 26, Math.min(board.x + board.w - 26, bx));
        by = Math.max(board.y + 26, Math.min(board.y + board.h - 26, by));
      }
      placedBadges.push({ x: bx, y: by });
      const selected = this.selectedOption === node.id;
      const isRecommended = node.id === recommended;
      const chip = moveKindChip(node.kind);
      const number = this.moveHooks?.numbers?.[index] ?? index + 1;
      const ang = Math.atan2(y - by, x - bx);
      this.edgePinHits.push({ nodeId: node.id, x: bx, y: by, r: 22 });
      ctx.save();
      ctx.fillStyle = 'rgba(8, 26, 48, 0.4)';
      ctx.beginPath();
      ctx.arc(bx + 1, by + 2, 17, 0, TAU);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(bx, by, 17, 0, TAU);
      ctx.fillStyle = chip.color;
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2.6;
      ctx.stroke();
      ctx.strokeStyle = selected || isRecommended ? '#ffd83d' : 'rgba(255, 255, 255, 0.55)';
      ctx.lineWidth = selected || isRecommended ? 2.8 : 1.4;
      ctx.stroke();
      // small outward arrow: this candidate is off the usable board
      ctx.beginPath();
      ctx.moveTo(bx + Math.cos(ang) * 23, by + Math.sin(ang) * 23);
      ctx.lineTo(bx + Math.cos(ang + 2.5) * 14, by + Math.sin(ang + 2.5) * 14);
      ctx.lineTo(bx + Math.cos(ang - 2.5) * 14, by + Math.sin(ang - 2.5) * 14);
      ctx.closePath();
      ctx.fillStyle = '#ffd83d';
      ctx.fill();
      ctx.strokeStyle = '#23385c';
      ctx.lineWidth = 1.3;
      ctx.stroke();
      const darkText = node.kind === 'yellow' || node.kind === 'shop' || node.kind === 'portal';
      ctx.fillStyle = darkText ? '#20315a' : '#ffffff';
      ctx.font = `800 15px ${LABEL_FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(number), bx, by + 0.5);
      ctx.restore();
    });
    if (hiddenOffBoard > 0) this.drawHiddenCandidateCounter(ctx, board, hiddenOffBoard);
  }

  /** One compact "+N" chip standing in for off-board candidates past the cap. */
  private drawHiddenCandidateCounter(
    ctx: CanvasRenderingContext2D,
    board: { x: number; y: number; w: number; h: number },
    hidden: number,
  ): void {
    const w = 52;
    const h = 20;
    const x = board.x + board.w - w - 12;
    const y = board.y + board.h - h - 12;
    ctx.save();
    ctx.fillStyle = 'rgba(8, 26, 48, 0.72)';
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 10);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 216, 61, 0.8)';
    ctx.lineWidth = 1.6;
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.font = `800 11px ${LABEL_FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`ほか ${hidden}`, x + w / 2, y + h / 2 + 0.5);
    ctx.restore();
  }

  /** Big numbered pin for the selected / recommended / few-candidate cases. */
  private drawOptionPin(
    ctx: CanvasRenderingContext2D,
    nodeId: string,
    x: number,
    y: number,
    r: number,
    kind: SquareKind,
    chip: MoveKindChip,
    number: number,
    selected: boolean,
    isRecommended: boolean,
    now: number,
    index: number,
  ): void {
    const bob = this.reducedMotion ? 0 : Math.sin(now / 280 + index * 1.8) * 2;
    // Keep the badge (and its おすすめ flag) inside the HUD-free board.
    const board = this.boardBox();
    const pinY = Math.max(board.y + 22, y - r - 26 - bob);
    const pinX = Math.max(board.x + 34, Math.min(board.x + board.w - 34, x));
    this.optionPinHits.push({ nodeId, x: pinX, y: pinY, r: 24 });
    ctx.save();
    ctx.fillStyle = 'rgba(10, 30, 55, 0.28)';
    ctx.beginPath();
    ctx.ellipse(x + 1, y + 2, 10, 3.8, 0, 0, TAU);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(pinX, pinY + 14);
    ctx.lineTo(x, y - r - 2);
    ctx.strokeStyle = selected || isRecommended ? '#ffd83d' : '#f6efe0';
    ctx.lineWidth = 2.8;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(pinX, pinY, 16, 0, TAU);
    ctx.fillStyle = chip.color;
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.strokeStyle = selected || isRecommended ? '#ffd83d' : '#23385c';
    ctx.lineWidth = selected ? 3.2 : 1.6;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(pinX + 12, pinY + 10, 8.5, 0, TAU);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.strokeStyle = '#23385c';
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.fillStyle = chip.color;
    ctx.font = `900 10px ${LABEL_FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(chip.symbol, pinX + 12, pinY + 10.5);
    const darkText = kind === 'yellow' || kind === 'shop' || kind === 'portal';
    ctx.fillStyle = darkText ? '#20315a' : '#ffffff';
    ctx.font = `800 16px ${LABEL_FONT}`;
    ctx.fillText(String(number), pinX, pinY + 0.5);
    ctx.restore();
    if (isRecommended) this.drawRecommendedTag(ctx, pinX, pinY);
  }

  /** Gold 「おすすめ」 flag with a small arrow toward the destination. */
  private drawRecommendedTag(ctx: CanvasRenderingContext2D, x: number, pinY: number): void {
    const w = 58;
    const h = 18;
    const board = this.boardBox();
    const x0 = Math.max(board.x + 2, Math.min(board.x + board.w - w - 2, x - w / 2));
    const y0 = Math.max(board.y + 2, pinY - 16 - h - 6);
    const cx = x0 + w / 2;
    const dest = this.destinationNodeId ? this.nodeById.get(this.destinationNodeId) : null;
    const toward = dest
      ? Math.atan2(this.camera.screenY(dest.y) - (y0 + h / 2), this.camera.screenX(dest.x) - x)
      : -Math.PI / 4;
    ctx.save();
    ctx.font = `800 10px ${LABEL_FONT}`;
    ctx.fillStyle = 'rgba(8, 26, 48, 0.35)';
    ctx.beginPath();
    ctx.roundRect(x0 + 1, y0 + 2, w, h, 9);
    ctx.fill();
    ctx.fillStyle = '#ffd83d';
    ctx.beginPath();
    ctx.roundRect(x0, y0, w, h, 9);
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.strokeStyle = '#23385c';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx, y0 + h);
    ctx.lineTo(x, pinY - 16);
    ctx.strokeStyle = '#ffd83d';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#23385c';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('おすすめ', cx, y0 + h / 2 + 0.5);
    const ax = x0 + w + 9;
    const ay = y0 + h / 2;
    ctx.beginPath();
    ctx.moveTo(ax + Math.cos(toward) * 8, ay + Math.sin(toward) * 8);
    ctx.lineTo(ax + Math.cos(toward + 2.5) * 6, ay + Math.sin(toward + 2.5) * 6);
    ctx.lineTo(ax + Math.cos(toward - 2.5) * 6, ay + Math.sin(toward - 2.5) * 6);
    ctx.closePath();
    ctx.fillStyle = '#ffe46b';
    ctx.fill();
    ctx.strokeStyle = '#23385c';
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.restore();
  }

  private drawBadge(ctx: CanvasRenderingContext2D): void {
    // Next hop target, drawn above the vehicle for train -> ferry switches.
    const progress = this.getMoveProgress();
    if (!progress?.nextNodeId) return;
    const next = this.nodeById.get(progress.nextNodeId);
    if (!next) return;
    const x = this.camera.screenX(next.x);
    const y = this.camera.screenY(next.y);
    const pulse = (Math.sin(performance.now() / 240) + 1) / 2;
    const rr = this.tileRadius() + 7 + pulse * 4;
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 224, 74, 0.98)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(x, y, rr, 0, TAU);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(x, y, rr + 4, 0, TAU);
    ctx.stroke();
    ctx.restore();
  }

  // ---------------------------------------------------------------- tokens & emotes

  private computeLayouts(now: number): TokenLayout[] {
    const h = this.tokenHeight();
    const entries: TokenLayout[] = [];
    const base = (playerId: number): Omit<TokenLayout, 'x' | 'y' | 'worldX' | 'worldY' | 'idle'> => ({
      playerId,
      fanX: 0,
      hopPx: 0,
      height: h,
      facing: 1,
      moving: false,
      vehicle: null,
      stepFrac: 0,
      stepIndex: 0,
      switchPoof: false,
      warping: null,
      tilt: 0,
      badge: false,
      badgeIndex: 0,
      badgeCount: 0,
      anchorX: 0,
      anchorY: 0,
      nodeId: null,
      switchAt: 0,
    });
    const idleByNode = new Map<string, number[]>();
    for (const token of this.tokens) {
      if (this.tokenRealm(token.playerId) !== this.view) continue;
      const move = this.moveAnim;
      if (move && move.playerId === token.playerId) {
        const full = [move.startNode, ...move.path];
        const raw = Math.max(0, (now - move.start) / move.msPerStep);
        const idx = Math.min(full.length - 2, Math.floor(raw));
        const frac = Math.min(1, Math.max(0, raw - idx));
        const a = this.nodeById.get(full[idx]);
        const b = this.nodeById.get(full[idx + 1]);
        if (a && b) {
          const dx = wrapDx(a.x, b.x);
          const mode = this.edgeModes.get(edgeKey(a.id, b.id)) ?? 'rail';
          const vehicle = vehicleForStep(mode, move.dice);
          const prevNode = idx > 0 ? this.nodeById.get(full[idx - 1]) : null;
          const prevMode = prevNode ? this.edgeModes.get(edgeKey(prevNode.id, a.id)) ?? 'rail' : null;
          const wx = a.x + dx * frac;
          const wy = a.y + (b.y - a.y) * frac;
          const sx = this.camera.screenX(wx);
          const sy = this.camera.screenY(wy);
          entries.push({
            ...base(token.playerId),
            x: sx,
            y: sy,
            worldX: wx,
            worldY: wy,
            idle: false,
            facing: Math.abs(dx) > 0.01 ? Math.sign(dx) : 1,
            moving: true,
            vehicle,
            stepFrac: frac,
            stepIndex: idx,
            switchPoof: prevMode !== null && prevMode !== mode && frac < 0.22,
            switchAt: prevMode !== null && prevMode !== mode ? move.start + idx * move.msPerStep : 0,
            tilt: Math.max(-0.12, Math.min(0.12, Math.atan2(b.y - a.y, Math.abs(dx) < 0.01 ? 0.01 : dx) * 0.28)),
            anchorX: sx,
            anchorY: sy,
            nodeId: token.nodeId,
          });
          continue;
        }
      }
      const warp = this.warpAnim;
      if (warp && warp.playerId === token.playerId) {
        const world = this.tokenWorldPosition(token.playerId, now);
        if (world) {
          const from = this.nodeById.get(warp.fromNode);
          const to = this.nodeById.get(warp.toNode);
          const dx = from && to ? wrapDx(from.x, to.x) : 1;
          const vehicle: VehicleKind | null =
            warp.via === 'plane' ? 'plane' : warp.via === 'rocket' ? 'rocket' : warp.via === 'carpet' ? 'carpet' : null;
          const sx = this.camera.screenX(world.x);
          const sy = this.camera.screenY(world.y);
          entries.push({
            ...base(token.playerId),
            x: sx,
            y: sy,
            worldX: world.x,
            worldY: world.y,
            idle: false,
            facing: Math.abs(dx) > 0.01 ? Math.sign(dx) : 1,
            vehicle,
            warping: warp.via,
            anchorX: sx,
            anchorY: sy,
            nodeId: token.nodeId,
          });
          continue;
        }
      }
      const ids = idleByNode.get(token.nodeId) ?? [];
      ids.push(token.playerId);
      idleByNode.set(token.nodeId, ids);
    }
    for (const [nodeId, ids] of idleByNode) {
      const node = this.nodeById.get(nodeId);
      if (!node) continue;
      const baseX = this.camera.screenX(node.x);
      const baseY = this.camera.screenY(node.y);
      const currentId = this.state?.current;
      const hasCurrent = currentId !== undefined && ids.includes(currentId);
      let badgeIds = hasCurrent ? ids.filter((id) => id !== currentId) : ids;
      if (hasCurrent && currentId !== undefined) {
        const currentEmote = this.emoteActive.get(currentId);
        const bob = !currentEmote ? Math.sin(now / 360 + currentId) * 2.2 : 0;
        entries.push({
          ...base(currentId),
          playerId: currentId,
          x: baseX,
          y: baseY + bob,
          worldX: node.x,
          worldY: node.y,
          idle: true,
          anchorX: baseX,
          anchorY: baseY,
          nodeId,
        });
      }
      let hidden = 0;
      if (badgeIds.length > 3) {
        hidden = badgeIds.length - 3;
        badgeIds = badgeIds.slice(0, 3);
      }
      const offsets: Array<[number, number]> = [
        [-22, -20],
        [22, -20],
        [0, 22],
      ];
      badgeIds.forEach((playerId, index) => {
        const [ox, oy] = offsets[index] ?? [0, 22];
        entries.push({
          ...base(playerId),
          x: baseX + ox,
          y: baseY + oy,
          worldX: node.x,
          worldY: node.y,
          idle: true,
          height: 26,
          badge: true,
          badgeIndex: index,
          badgeCount: index === badgeIds.length - 1 ? hidden : 0,
          anchorX: baseX,
          anchorY: baseY,
          nodeId,
        });
      });
    }
    entries.sort((a, b) => a.y - b.y || a.playerId - b.playerId);
    const current = this.state?.current;
    if (current !== undefined) {
      const idx = entries.findIndex((e) => e.playerId === current);
      if (idx >= 0) {
        const [entry] = entries.splice(idx, 1);
        entries.push(entry);
      }
    }
    return entries;
  }

  private drawTokens(ctx: CanvasRenderingContext2D, layouts: TokenLayout[], now: number): void {
    const holder = this.state?.piper.holder ?? null;
    const holderLayout = holder !== null ? layouts.find((l) => l.playerId === holder) : undefined;
    if (holderLayout && this.state) {
      this.drawPiper(ctx, holderLayout, this.state.piper.level, now);
    }
    for (const layout of layouts) this.drawToken(ctx, layout, now);
  }

  private emoteMood(anim: EmoteDef['anim']): 'joy' | 'sad' | null {
    switch (anim) {
      case 'jump':
      case 'dance':
      case 'laugh':
      case 'flex':
      case 'heart':
      case 'money_rain':
        return 'joy';
      case 'cry':
      case 'dogeza':
      case 'hit':
        return 'sad';
      default:
        return null;
    }
  }

  private moodSprite(charId: string, mood: 'joy' | 'sad' | null): HTMLImageElement | undefined {
    if (mood === 'joy') return this.assets.joy?.get(charId) ?? this.assets.chars.get(charId);
    if (mood === 'sad') return this.assets.sad?.get(charId) ?? this.assets.chars.get(charId);
    return this.assets.chars.get(charId);
  }

  private vehicleLength(): number {
    return Math.min(112, Math.max(56, 52 + this.camera.zoom * 18));
  }

  private drawTokenBase(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    h: number,
    color: string,
    alpha: number,
    current: boolean,
  ): void {
    ctx.save();
    ctx.globalAlpha = 0.24 * alpha;
    ctx.fillStyle = '#06253d';
    ctx.beginPath();
    ctx.ellipse(x, y + 2, h * 0.34, h * 0.115, 0, 0, TAU);
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.ellipse(x, y + 1.5, h * 0.38, h * 0.145, 0, 0, TAU);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    ctx.lineWidth = Math.max(1.4, h * 0.035);
    ctx.stroke();
    if (current) {
      ctx.strokeStyle = '#ffe066';
      ctx.lineWidth = Math.max(1.2, h * 0.025);
      ctx.beginPath();
      ctx.ellipse(x, y + 1.5, h * 0.47, h * 0.19, 0, 0, TAU);
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawCharacter(
    ctx: CanvasRenderingContext2D,
    x: number,
    feetY: number,
    h: number,
    img: HTMLImageElement | undefined,
    char: Character | undefined,
    color: string,
    scaleX: number,
    scaleY: number,
    rotate: number,
    alpha: number,
    facing: number,
  ): void {
    const spriteW = h * (img && img.naturalWidth > 0 && img.naturalHeight > 0 ? img.naturalWidth / img.naturalHeight : 0.84);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x, feetY);
    ctx.rotate(rotate);
    ctx.scale(scaleX * (facing < 0 ? -1 : 1), scaleY);
    if (img) {
      ctx.drawImage(img, -spriteW / 2, -h, spriteW, h);
    } else {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(0, -h * 0.48, h * 0.3, 0, TAU);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.font = `800 ${Math.round(h * 0.34)}px ${LABEL_FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(char?.nameJa.slice(0, 1) ?? '?', 0, -h * 0.48);
    }
    ctx.restore();
  }

  private drawToken(ctx: CanvasRenderingContext2D, layout: TokenLayout, now: number): void {
    const player = this.state?.players[layout.playerId];
    if (!player) return;
    const h = layout.height;
    const char = this.characterById.get(player.characterId);
    const color = this.playerColor(layout.playerId);
    const active = this.emoteActive.get(layout.playerId);
    const hitStart = this.hitOverlays.get(layout.playerId);
    const hitT = hitStart !== undefined ? (now - hitStart) / HIT_DURATION_MS : -1;
    const current = this.state?.current === layout.playerId;
    const moodOverride = this.moods.get(layout.playerId);
    const mood =
      hitT >= 0 && hitT <= 1
        ? 'sad'
        : active
          ? this.emoteMood(active.def.anim)
          : moodOverride && now < moodOverride.until
            ? moodOverride.mood
            : null;
    const img = this.moodSprite(player.characterId, mood);

    if (layout.badge) {
      this.drawBadgeToken(ctx, layout, now, player, img, char, color);
      return;
    }
    if (layout.warping) {
      this.drawWarpFlight(ctx, layout, now, h, img, char, color, mood);
      return;
    }
    if (layout.vehicle) {
      this.drawRiding(ctx, layout, now, h, img, char, color, current);
      return;
    }

    const idle = layout.idle
      ? this.idlePose(layout.playerId, now)
      : { dx: 0, dy: 0, sx: 1, sy: 1, rot: 0, facing: 1 };
    let dx = idle.dx;
    let dy = idle.dy;
    let scaleX = idle.sx;
    let scaleY = idle.sy;
    let rotate = idle.rot;
    const facing = idle.facing;
    let alpha = 1;
    if (active) {
      const t = Math.min(1, (now - active.start) / active.duration);
      const tr = tokenEmoteTransform(active.def.anim, t, layout.playerId + 1);
      dx += tr.dx;
      dy += tr.dy;
      scaleX *= tr.scaleX;
      scaleY *= tr.scaleY;
      rotate += tr.rotate;
      alpha *= tr.alpha;
    }
    if (hitT >= 0 && hitT <= 1) {
      const tr = tokenEmoteTransform('hit', hitT, layout.playerId + 3);
      dx += tr.dx;
      scaleX *= tr.scaleX;
      scaleY *= tr.scaleY;
      rotate += tr.rotate;
    }
    if (current) {
      scaleX *= 1.08;
      scaleY *= 1.08;
    }
    const bounceStart = this.arrivalBounces.get(layout.playerId);
    if (bounceStart !== undefined) {
      const bp = Math.min(1, (now - bounceStart) / 450);
      const b = Math.sin(bp * Math.PI);
      scaleY *= 1 + b * 0.12;
      scaleX *= 1 - b * 0.06;
      if (bp < 0.6 && !this.reducedMotion) this.drawPoof(ctx, layout.x, layout.y, bp / 0.6, h * 0.8, layout.playerId);
    }

    const baseX = layout.x;
    const baseY = layout.y;
    if (active?.def.anim === 'spotlight') {
      const t = Math.min(1, (now - active.start) / active.duration);
      drawEmoteBackdrop(ctx, active.def.anim, {
        x: baseX, y: baseY, height: h, t, seed: layout.playerId + 1, def: active.def,
      });
    }
    this.drawTokenBase(ctx, baseX, baseY, h, color, alpha, current);
    if (hitT >= 0 && hitT <= 1) drawHitFlash(ctx, baseX, baseY, h, hitT);
    this.drawCharacter(ctx, baseX + dx, baseY + dy, h, img, char, color, scaleX, scaleY, rotate, alpha, facing);

    if (active) {
      const t = Math.min(1, (now - active.start) / active.duration);
      drawEmoteFx(ctx, active.def.anim, {
        x: baseX, y: baseY, height: h, t, seed: layout.playerId + 1, def: active.def,
      });
      drawEmoteIcon(ctx, active.def.icon, baseX, baseY - h - 16, t);
    }
    if (hitT >= 0 && hitT <= 1) {
      drawEmoteFx(ctx, 'hit', {
        x: baseX, y: baseY, height: h, t: hitT, seed: layout.playerId + 7,
      });
    }
  }

  private drawBadgeToken(
    ctx: CanvasRenderingContext2D,
    layout: TokenLayout,
    now: number,
    player: PublicState['players'][number],
    img: HTMLImageElement | undefined,
    char: Character | undefined,
    color: string,
  ): void {
    const r = 12;
    let scale = 1;
    const bounce = this.arrivalBounces.get(layout.playerId);
    if (bounce !== undefined) {
      const bp = Math.min(1, (now - bounce) / 450);
      scale *= 1 + Math.sin(bp * Math.PI) * 0.2;
    }
    const active = this.emoteActive.get(layout.playerId);
    let dx = 0;
    let dy = 0;
    if (active) {
      const t = Math.min(1, (now - active.start) / active.duration);
      const tr = tokenEmoteTransform(active.def.anim, t, layout.playerId + 1);
      dx = tr.dx * 0.4;
      dy = tr.dy * 0.4;
      scale *= 0.92 + Math.min(0.18, Math.abs(tr.dy) * 0.01);
    }
    const x = layout.x + dx;
    const y = layout.y + dy;
    // leader line to the actual board node
    if (Math.abs(layout.x - layout.anchorX) + Math.abs(layout.y - layout.anchorY) > 3) {
      ctx.save();
      ctx.strokeStyle = 'rgba(15, 35, 60, 0.35)';
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.moveTo(layout.anchorX, layout.anchorY);
      ctx.lineTo(x, y);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.8)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();
    }
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(scale, scale);
    ctx.fillStyle = 'rgba(7, 30, 50, 0.2)';
    ctx.beginPath();
    ctx.ellipse(0, 9, 10, 3, 0, 0, TAU);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(0, 0, r + 2, 0, TAU);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, TAU);
    ctx.save();
    ctx.clip();
    ctx.fillStyle = '#d9ecff';
    ctx.fillRect(-r, -r, r * 2, r * 2);
    if (img && img.naturalWidth > 0) {
      const headH = img.naturalHeight * 0.58;
      const scaleImg = Math.min((r * 2) / img.naturalWidth, (r * 2) / headH);
      const w = img.naturalWidth * scaleImg;
      const hh = headH * scaleImg;
      ctx.drawImage(img, 0, 0, img.naturalWidth, headH, -w / 2, -r, w, hh);
    } else {
      ctx.fillStyle = color;
      ctx.fillRect(-r, -r, r * 2, r * 2);
      ctx.fillStyle = '#fff';
      ctx.font = `800 12px ${LABEL_FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(char?.nameJa.slice(0, 1) ?? '?', 0, 0);
    }
    ctx.restore();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, TAU);
    ctx.stroke();
    ctx.strokeStyle = '#23385c';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(0, 0, r + 2, 0, TAU);
    ctx.stroke();
    if (layout.badgeCount > 0) {
      ctx.beginPath();
      ctx.arc(r - 1, -r + 1, 8, 0, TAU);
      ctx.fillStyle = '#ffe04a';
      ctx.fill();
      ctx.strokeStyle = '#23385c';
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.fillStyle = '#20315a';
      ctx.font = `800 9px ${LABEL_FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`+${layout.badgeCount}`, r - 1, -r + 1.5);
    }
    ctx.restore();
    if (active) {
      const t = Math.min(1, (now - active.start) / active.duration);
      drawEmoteIcon(ctx, active.def.icon, x, y - 28, t);
    }
    const hitStart = this.hitOverlays.get(layout.playerId);
    if (hitStart !== undefined) {
      const ht = (now - hitStart) / HIT_DURATION_MS;
      if (ht <= 1) drawHitFlash(ctx, x, y, 26, ht);
    }
    void player;
  }

  private idlePose(playerId: number, now: number): {
    dx: number; dy: number; sx: number; sy: number; rot: number; facing: number;
  } {
    if (this.reducedMotion) return { dx: 0, dy: 0, sx: 1, sy: 1, rot: 0, facing: 1 };
    const phase = playerId * 1.71;
    const breath = Math.sin(now / 700 + phase);
    const pose = {
      dx: 0,
      dy: 0,
      sx: 1 + breath * 0.022,
      sy: 1 - breath * 0.027,
      rot: 0,
      facing: 1,
    };
    const cycle = 7600 + playerId * 1300;
    const at = now + playerId * 2600;
    const local = ((at % cycle) + cycle) % cycle;
    if (local < 1000) {
      const action = Math.floor(at / cycle) % 3;
      const u = local / 1000;
      if (action === 0) {
        const hop = Math.sin(u * Math.PI);
        pose.dy -= hop * 9;
        pose.sx *= 1 + hop * 0.05;
        pose.sy *= 1 - hop * 0.06;
      } else if (action === 1) {
        pose.facing = Math.floor(local / 260) % 2 === 0 ? 1 : -1;
        pose.rot = Math.sin(local * 0.022) * 0.018;
      } else {
        pose.dx = Math.sin(local * 0.045) * 4;
        pose.rot = Math.sin(local * 0.055) * 0.035;
      }
    }
    return pose;
  }

  private drawRiding(
    ctx: CanvasRenderingContext2D,
    layout: TokenLayout,
    now: number,
    h: number,
    img: HTMLImageElement | undefined,
    char: Character | undefined,
    color: string,
    current: boolean,
  ): void {
    const kind = layout.vehicle;
    if (!kind) return;
    const vehicleImg = this.assets.vehicles?.get(kind);
    const length = this.vehicleLength();
    const metrics = vehicleMetrics(kind, length, vehicleImg);
    const facing = layout.facing;
    const rattle = this.reducedMotion ? 0 : kind === 'ferry' ? Math.sin(now / 520 + layout.playerId) * 1.6 : Math.sin(now / 85 + layout.playerId * 2) * 0.7;
    const baseX = layout.x;
    const baseY = layout.y;
    const active = this.emoteActive.get(layout.playerId);
    const hitStart = this.hitOverlays.get(layout.playerId);
    const hitT = hitStart !== undefined ? (now - hitStart) / HIT_DURATION_MS : -1;
    let scaleX = 1;
    let scaleY = 1;
    if (current) { scaleX *= 1.04; scaleY *= 1.04; }
    if (active) {
      const t = Math.min(1, (now - active.start) / active.duration);
      const tr = tokenEmoteTransform(active.def.anim, t, layout.playerId + 1);
      scaleX *= tr.scaleX;
      scaleY *= tr.scaleY;
    }
    if (hitT >= 0 && hitT <= 1) {
      const tr = tokenEmoteTransform('hit', hitT, layout.playerId + 3);
      scaleX *= tr.scaleX;
      scaleY *= tr.scaleY;
    }
    const vehY = baseY + rattle;
    const charH = h * 0.6;
    const charFeetY = vehY + metrics.rideY;
    const tilt = layout.tilt + Math.sin(now / 120 + layout.playerId) * 0.004;

    this.drawTokenBase(ctx, baseX, baseY, h * 0.8, color, 0.9, current);
    if (!this.reducedMotion) {
      // short ghost trail behind the vehicle
      ctx.save();
      ctx.globalAlpha = 0.1;
      for (let i = 1; i <= 2; i++) {
        drawVehicle(ctx, kind, baseX - facing * length * 0.32 * i, vehY, length * 0.94, facing, vehicleImg, tilt);
      }
      ctx.restore();
    }
    if (layout.switchPoof) {
      this.drawPoof(ctx, baseX, baseY, 0.35, h * 0.7, layout.playerId);
    }

    const drawChar = (): void => {
      this.drawCharacter(ctx, baseX, charFeetY, charH, img, char, color, scaleX, scaleY, 0, 1, facing);
    };
    const drawVeh = (): void => {
      drawVehicle(ctx, kind, baseX, vehY, length, facing, vehicleImg, tilt);
    };
    if (metrics.inFront) {
      drawChar();
      drawVeh();
    } else {
      drawVeh();
      drawChar();
    }

    if (!this.reducedMotion) {
      if (kind === 'train' || kind === 'express') {
        ctx.save();
        ctx.globalAlpha = 0.65;
        ctx.fillStyle = '#ffffff';
        for (let i = 0; i < 3; i++) {
          const p = ((now / 650 + i / 3) % 1);
          const px = baseX - facing * length * (0.1 + i * 0.16);
          const py = vehY - metrics.h - p * 12;
          ctx.globalAlpha = (1 - p) * 0.55;
          ctx.beginPath();
          ctx.arc(px, py, 2 + p * 3.5, 0, TAU);
          ctx.fill();
        }
        ctx.restore();
      } else if (kind === 'bullet_train') {
        ctx.save();
        ctx.strokeStyle = 'rgba(255,255,255,0.75)';
        ctx.lineWidth = 1.4;
        for (let i = 1; i <= 4; i++) {
          ctx.beginPath();
          ctx.moveTo(baseX - facing * length * (0.48 + i * 0.12), vehY - metrics.h * 0.35);
          ctx.lineTo(baseX - facing * length * (0.7 + i * 0.18), vehY - metrics.h * 0.35);
          ctx.stroke();
        }
        ctx.restore();
      } else if (kind === 'ferry' || kind === 'sailboat') {
        ctx.save();
        ctx.strokeStyle = 'rgba(255,255,255,0.6)';
        ctx.lineWidth = 1.3;
        for (let i = 1; i <= 3; i++) {
          ctx.beginPath();
          ctx.arc(baseX - facing * length * (0.35 + i * 0.12), vehY + 1, length * 0.07 * i, 0.15, Math.PI - 0.15);
          ctx.stroke();
        }
        ctx.restore();
      }
    }

    if (layout.switchAt > 0 && now - layout.switchAt < 170) {
      const g = 1 - (now - layout.switchAt) / 170;
      ctx.save();
      ctx.globalAlpha = g * 0.9;
      ctx.strokeStyle = '#fff4a8';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.ellipse(baseX, vehY - metrics.h * 0.5, length * 0.62, metrics.h * 0.9, 0, 0, TAU);
      ctx.stroke();
      ctx.globalAlpha = g;
      ctx.fillStyle = '#ffffff';
      for (let i = 0; i < 4; i++) {
        const a = now / 90 + (i / 4) * TAU;
        ctx.beginPath();
        ctx.arc(baseX + Math.cos(a) * length * 0.55, vehY - metrics.h * 0.5 + Math.sin(a) * metrics.h * 0.7, 3, 0, TAU);
        ctx.fill();
      }
      ctx.restore();
    }
    if (this.reducedMotion) {
      ctx.save();
      ctx.font = `800 ${Math.max(14, h * 0.2)}px ${LABEL_FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#23385c';
      ctx.lineWidth = 3;
      const icon = kind === 'ferry' || kind === 'sailboat' ? '⛴' : '🚆';
      ctx.strokeText(icon, baseX, vehY - metrics.h - 16);
      ctx.fillText(icon, baseX, vehY - metrics.h - 16);
      ctx.restore();
    }
    if (active) {
      const t = Math.min(1, (now - active.start) / active.duration);
      drawEmoteIcon(ctx, active.def.icon, baseX, vehY - metrics.h - charH - 14, t);
    }
    if (hitT >= 0 && hitT <= 1) {
      drawHitFlash(ctx, baseX, baseY, h, hitT);
      drawEmoteFx(ctx, 'hit', { x: baseX, y: baseY, height: h, t: hitT, seed: layout.playerId + 7 });
    }
  }

  private drawWarpFlight(
    ctx: CanvasRenderingContext2D,
    layout: TokenLayout,
    now: number,
    h: number,
    img: HTMLImageElement | undefined,
    char: Character | undefined,
    color: string,
    mood: 'joy' | 'sad' | null,
  ): void {
    const warp = this.warpAnim;
    if (!warp) return;
    const p = Math.min(1, Math.max(0, (now - warp.start) / warp.duration));
    const from = this.nodeById.get(warp.fromNode);
    const to = this.nodeById.get(warp.toNode);
    if (!from || !to) return;
    const groundX = layout.x;
    const groundY = layout.y;
    const facing = layout.facing;
    void mood;

    if (warp.via === 'event') {
      let baseX = this.camera.screenX(from.x);
      let baseY = this.camera.screenY(from.y);
      let scale = 1;
      let alpha = 1;
      let poofP = 0;
      let poofX = baseX;
      let poofY = baseY;
      if (p < 0.46) {
        scale = 1 - easeInOutCubic(Math.min(1, p / 0.46)) * 0.95;
        alpha = 1 - p / 0.46;
        poofP = p / 0.46;
      } else {
        baseX = this.camera.screenX(to.x);
        baseY = this.camera.screenY(to.y);
        const q = Math.min(1, (p - 0.46) / 0.54);
        scale = 0.08 + easeInOutCubic(q) * 0.92;
        alpha = q;
        poofP = 1 - q;
        poofX = baseX;
        poofY = baseY;
      }
      this.drawPoof(ctx, poofX, poofY, poofP, h, layout.playerId);
      this.drawCharacter(ctx, baseX, baseY, h, img, char, color, scale, scale, 0, alpha, facing);
      return;
    }

    const altitude =
      warp.via === 'rocket' ? 190 : warp.via === 'plane' ? 130 : warp.via === 'carpet' ? 90 : 120;
    const lift = Math.sin(p * Math.PI) * altitude;
    const flightY = groundY - lift;
    ctx.save();
    ctx.globalAlpha = 0.22;
    ctx.fillStyle = '#06314a';
    ctx.beginPath();
    ctx.ellipse(groundX, groundY + 2, h * 0.28 * (1 - p * 0.4), h * 0.09, 0, 0, TAU);
    ctx.fill();
    ctx.restore();

    if (warp.via === 'tornado') {
      // spinning funnel at the origin, then a tumbling arc
      if (p < 0.35) {
        const q = p / 0.35;
        ctx.save();
        ctx.globalAlpha = 0.75;
        for (let i = 0; i < 4; i++) {
          ctx.strokeStyle = i % 2 ? '#cdeaff' : '#8cc6ee';
          ctx.lineWidth = 2.2;
          ctx.beginPath();
          const rx = 14 + i * 7;
          ctx.ellipse(groundX, groundY - 40 - i * 12, rx, 5, 0, 0, TAU);
          ctx.stroke();
        }
        ctx.restore();
        this.drawCharacter(ctx, groundX + Math.sin(now / 70) * 6, groundY - q * 10, h, img, char, color, 0.7, 0.7, now / 60, 1, 1);
      }
      this.drawCharacter(ctx, groundX, flightY, h * 0.8, img, char, color, 0.8, 0.8, p * Math.PI * 6, 1, facing);
      for (let i = 0; i < 3; i++) {
        ctx.save();
        ctx.globalAlpha = 0.5;
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(groundX + Math.sin(now / 40 + i) * 16, groundY - 10 - i * 14, 3 + i, 0, TAU);
        ctx.fill();
        ctx.restore();
      }
      if (p > 0.86) this.drawPoof(ctx, groundX, groundY, (p - 0.86) / 0.14, h * 0.7, layout.playerId);
      return;
    }

    const vehicleImg = this.assets.vehicles?.get(warp.via === 'plane' ? 'plane' : warp.via === 'rocket' ? 'rocket' : 'carpet');
    const kind: VehicleKind = warp.via === 'plane' ? 'plane' : warp.via === 'rocket' ? 'rocket' : 'carpet';
    const length = this.vehicleLength() * 1.15;
    const metrics = vehicleMetrics(kind, length, vehicleImg);
    const charH = h * 0.62;
    const charFeetY = flightY + metrics.rideY;

    // contrail / sparkle trail
    if (!this.reducedMotion) {
      ctx.save();
      if (kind === 'carpet') {
        for (let i = 1; i <= 6; i++) {
          const q = Math.max(0, p - i * 0.035);
          const tx = this.camera.screenX(from.x + wrapDx(from.x, to.x) * easeInOutCubic(q));
          const ty = this.camera.screenY(from.y + (to.y - from.y) * easeInOutCubic(q)) - Math.sin(q * Math.PI) * altitude;
          ctx.globalAlpha = (1 - i / 7) * 0.8;
          ctx.fillStyle = i % 2 ? '#ffe57a' : '#ffffff';
          ctx.beginPath();
          ctx.arc(tx + Math.sin(i * 2) * 8, ty + Math.cos(i * 3) * 5, 2.4, 0, TAU);
          ctx.fill();
        }
      } else {
        ctx.strokeStyle = kind === 'plane' ? 'rgba(255,255,255,0.7)' : 'rgba(255,255,255,0.45)';
        ctx.lineWidth = kind === 'plane' ? 2 : 1.2;
        ctx.setLineDash(kind === 'plane' ? [3, 5] : [2, 4]);
        ctx.beginPath();
        for (let i = 1; i <= 8; i++) {
          const q = Math.max(0, p - i * 0.025);
          const tx = this.camera.screenX(from.x + wrapDx(from.x, to.x) * easeInOutCubic(q));
          const ty = this.camera.screenY(from.y + (to.y - from.y) * easeInOutCubic(q)) - Math.sin(q * Math.PI) * altitude;
          if (i === 1) ctx.moveTo(tx, ty);
          else ctx.lineTo(tx, ty);
        }
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.restore();
    }
    if (kind === 'rocket' && !this.reducedMotion) {
      const flame = 10 + Math.sin(now / 45) * 5;
      ctx.save();
      ctx.globalAlpha = p > 0.6 ? (1 - p) * 1.4 : 1;
      ctx.fillStyle = '#ff9d3d';
      ctx.beginPath();
      ctx.moveTo(groundX - facing * length * 0.52, flightY - metrics.h * 0.45);
      ctx.lineTo(groundX - facing * (length * 0.52 + flame), flightY - metrics.h * 0.45 + Math.sin(now / 60) * 4);
      ctx.lineTo(groundX - facing * length * 0.52, flightY - metrics.h * 0.45 + metrics.h * 0.3);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
    const drawChar = (): void => {
      this.drawCharacter(ctx, groundX, charFeetY, charH, img, char, color, 1, 1, p * 0.5 * (kind === 'carpet' ? 0 : 1), 1, facing);
    };
    const drawCraft = (): void => {
      drawVehicle(ctx, kind, groundX, flightY, length, facing, vehicleImg, Math.sin(p * Math.PI) * 0.05);
    };
    if (metrics.inFront) {
      drawChar();
      drawCraft();
    } else {
      drawCraft();
      drawChar();
    }
    if (p < 0.18) this.drawPoof(ctx, groundX, groundY, p / 0.18, h * 0.8, layout.playerId);
    if (p > 0.84) this.drawPoof(ctx, groundX, groundY, (p - 0.84) / 0.16, h * 0.7, layout.playerId);
  }

  private drawPiper(ctx: CanvasRenderingContext2D, holder: TokenLayout, level: number, now: number): void {
    const img = this.assets.npcs?.get(`piper${Math.min(3, Math.max(1, level))}`);
    if (!img) return;
    const h = holder.height * 0.64;
    const w = h * (img.naturalWidth > 0 && img.naturalHeight > 0 ? img.naturalWidth / img.naturalHeight : 0.88);
    const bob = Math.sin(now / 420) * 1.6;
    const x = holder.x - holder.height * 0.78;
    const y = holder.y + 6 + bob;
    ctx.save();
    ctx.globalAlpha = 0.22;
    ctx.fillStyle = '#06253d';
    ctx.beginPath();
    ctx.ellipse(x, holder.y + 4, h * 0.3, h * 0.1, 0, 0, TAU);
    ctx.fill();
    ctx.restore();
    ctx.save();
    ctx.globalAlpha = 0.92;
    ctx.drawImage(img, x - w / 2, y - h, w, h);
    ctx.restore();
    ctx.save();
    ctx.globalAlpha = 0.85;
    ctx.font = `800 11px ${LABEL_FONT}`;
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ff5b6e';
    ctx.fillText('♪', x + w * 0.45, y - h + 6 - Math.abs(Math.sin(now / 300)) * 4);
    ctx.restore();
  }

  private drawPoof(ctx: CanvasRenderingContext2D, x: number, y: number, p: number, h: number, seed: number): void {
    ctx.save();
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * TAU + seed;
      const r = h * (0.08 + p * 0.45);
      ctx.globalAlpha = Math.max(0, (1 - p) * 0.8);
      ctx.fillStyle = i % 2 === 0 ? '#ffffff' : '#bdeaff';
      ctx.beginPath();
      ctx.arc(x + Math.cos(a) * r, y - h * 0.4 + Math.sin(a) * r * 0.65, h * 0.11 * (1 + p), 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  private drawOverviewMarkers(ctx: CanvasRenderingContext2D): void {
    const cam = this.camera;
    const state = this.state;
    if (!state) return;
    const board = this.boardBox();
    const used: Rect[] = [];
    const markerName = (
      x: number,
      y: number,
      text: string,
      color: string,
      shape: 'current' | 'destination',
    ): void => {
      ctx.save();
      ctx.translate(x, y);
      ctx.fillStyle = 'rgba(8, 30, 52, 0.28)';
      ctx.beginPath();
      ctx.ellipse(0, 9, 10, 4, 0, 0, TAU);
      ctx.fill();
      if (shape === 'destination') {
        ctx.strokeStyle = '#23385c';
        ctx.lineWidth = 2.2;
        ctx.beginPath(); ctx.moveTo(0, 6); ctx.lineTo(0, -15); ctx.stroke();
        for (let r = 0; r < 2; r++) for (let c = 0; c < 2; c++) {
          ctx.fillStyle = (r + c) % 2 === 0 ? '#1b2b47' : '#ffffff';
          ctx.fillRect(1.5 + c * 7.5, -15 + r * 7.5, 7.5, 7.5);
        }
        ctx.strokeStyle = '#23385c'; ctx.lineWidth = 1.2; ctx.strokeRect(1.5, -15, 15, 15);
      } else {
        ctx.beginPath(); ctx.arc(0, 0, 8, 0, TAU);
        ctx.fillStyle = color; ctx.fill();
        ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2.6; ctx.stroke();
        ctx.strokeStyle = '#23385c'; ctx.lineWidth = 1.3; ctx.stroke();
      }
      ctx.restore();

      const fs = 13;
      ctx.save();
      ctx.font = `800 ${fs}px ${LABEL_FONT}`;
      const tw = Math.min(board.w - 10, ctx.measureText(text).width + 16);
      const th = 22;
      const raw: Rect[] = [
        { x: x - tw / 2, y: y - 39, w: tw, h: th },
        { x: x - tw / 2, y: y + 19, w: tw, h: th },
        { x: x + 20, y: y - th / 2, w: tw, h: th },
        { x: x - tw - 20, y: y - th / 2, w: tw, h: th },
      ];
      let bx = raw[0].x;
      let by = raw[0].y;
      for (const cand of raw) {
        const rx = Math.max(board.x + 3, Math.min(board.x + board.w - tw - 3, cand.x));
        const ry = Math.max(board.y + 3, Math.min(board.y + board.h - th - 3, cand.y));
        const rect = { x: rx, y: ry, w: tw, h: th };
        if (!used.some((r) => rectsOverlap(rect, r, 4))) {
          bx = rx;
          by = ry;
          break;
        }
      }
      const labelRect = {
        x: Math.max(board.x + 3, Math.min(board.x + board.w - tw - 3, bx)),
        y: Math.max(board.y + 3, Math.min(board.y + board.h - th - 3, by)),
        w: tw,
        h: th,
      };
      used.push(labelRect);
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = shape === 'destination' ? '#c98a00' : color;
      ctx.lineWidth = 2.2;
      ctx.beginPath(); ctx.roundRect(labelRect.x, labelRect.y, tw, th, 10); ctx.fill(); ctx.stroke();
      ctx.strokeStyle = '#23385c';
      ctx.lineWidth = 0.9;
      ctx.stroke();
      ctx.fillStyle = shape === 'destination' ? '#8a5c00' : '#1a2b4c';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(text, labelRect.x + tw / 2, labelRect.y + th / 2 + 0.5);
      ctx.restore();
    };
    for (const token of this.tokens) {
      if (this.tokenRealm(token.playerId) !== 'world') continue;
      const node = this.nodeById.get(token.nodeId);
      if (!node) continue;
      const x = cam.screenX(node.x);
      const y = cam.screenY(node.y);
      if (x < -50 || x > cam.vw + 50 || y < -50 || y > cam.vh + 50) continue;
      const isCurrent = token.playerId === state.current;
      if (!isCurrent) {
        ctx.fillStyle = this.playerColor(token.playerId);
        ctx.beginPath(); ctx.arc(x, y, 4, 0, TAU); ctx.fill();
        ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.2; ctx.stroke();
      }
    }
    const current = state.players[state.current];
    if (current) {
      const node = this.nodeById.get(current.nodeId);
      if (node && (node.realm ?? 'world') === 'world') {
        const player = state.players[state.current];
        const name = this.characterById.get(player.characterId)?.nameJa ?? player.name;
        markerName(cam.screenX(node.x), cam.screenY(node.y), name, this.playerColor(state.current), 'current');
      }
    }
    const destCity = this.cityEntries.find((e) => e.city.id === state.destination);
    if (destCity) {
      markerName(cam.screenX(destCity.node.x), cam.screenY(destCity.node.y), destCity.city.nameJa, '#ffd23f', 'destination');
    }
  }

  private drawWorldWarpTiles(ctx: CanvasRenderingContext2D, now: number): void {
    if (this.view !== 'world' || this.detailLevel() < 1) return;
    const cam = this.camera;
    const r = this.tileRadius();
    for (const node of this.warpNodesForView()) {
      const x = cam.screenX(node.x);
      const y = cam.screenY(node.y);
      if (x < -60 || x > cam.vw + 60 || y < -60 || y > cam.vh + 60) continue;
      this.drawWarpTile(ctx, x, y, r, now, node.id);
    }
  }

  private drawSeasonParticles(ctx: CanvasRenderingContext2D, now: number): void {
    if (this.reducedMotion || this.view !== 'world' || this.isOverview()) return;
    const cam = this.camera;
    if (Math.abs(this.geoAt(cam.x, cam.y).lat) < 23) return;
    const fade = this.seasonTransitionStart > 0 ? Math.min(1, (now - this.seasonTransitionStart) / 1000) : 1;
    ctx.save();
    ctx.globalAlpha = Math.max(0.2, fade);
    for (let i = 0; i < 26; i++) {
      const seed = hashString(`${this.month}-${i}`);
      const x = ((seed % 1000) / 1000) * cam.vw + Math.sin(now / 2400 + i) * 16;
      const y = ((now / 130 + (seed % 700)) % (cam.vh + 80)) - 40;
      const worldX = wrapX(cam.x + (x - cam.vw / 2) / cam.zoom);
      const worldY = cam.y + (y - cam.vh / 2) / cam.zoom;
      const geo = this.geoAt(worldX, worldY);
      const localSeason = Math.abs(geo.lat) < 23 ? 'summer' : geo.lat >= 0 ? this.season : oppositeSeason(this.season);
      if (classifyTerrain(geo.lat, geo.lon, i + 7) === 'desert' || this.landLayer.isBarrenAt(worldX, worldY)) continue;
      if (localSeason === 'spring') {
        ctx.fillStyle = i % 3 === 0 ? '#ffd1e4' : '#ff9fc4';
        ctx.beginPath();
        ctx.ellipse(x, y, 4, 2.2, Math.sin(now / 600 + i), 0, TAU);
        ctx.fill();
      } else if (localSeason === 'autumn') {
        ctx.fillStyle = i % 2 === 0 ? '#e08a2e' : '#d05a2b';
        ctx.beginPath();
        ctx.ellipse(x, y, 4.5, 2.4, Math.sin(now / 500 + i), 0, TAU);
        ctx.fill();
      } else if (localSeason === 'summer') {
        ctx.globalAlpha = fade * (0.3 + 0.35 * Math.abs(Math.sin(now / 500 + i)));
        ctx.fillStyle = '#d9f08a';
        ctx.beginPath();
        ctx.arc(x, y, 1.6, 0, TAU);
        ctx.fill();
        ctx.globalAlpha = fade;
      } else {
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(x, y, 1.5 + (seed % 3) * 0.6, 0, TAU);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  private drawRealmAmbient(ctx: CanvasRenderingContext2D, now: number): void {
    if (this.reducedMotion || this.view === 'world') return;
    const cam = this.camera;
    ctx.save();
    if (this.view === 'heaven') {
      for (let i = 0; i < 18; i++) {
        const x = ((i * 211 + now * 0.018) % (cam.vw + 80)) - 40;
        const y = ((i * 137 + now * 0.01) % (cam.vh + 80)) - 40;
        ctx.globalAlpha = 0.55 + 0.3 * Math.sin(now / 600 + i);
        ctx.fillStyle = i % 3 === 0 ? '#fff6c8' : '#ffffff';
        ctx.beginPath();
        ctx.ellipse(x, y, 5, 2, Math.sin(now / 700 + i), 0, TAU);
        ctx.fill();
      }
    } else if (this.view === 'hell') {
      for (let i = 0; i < 24; i++) {
        const x = ((i * 173 + Math.sin(now / 900 + i) * 30) % cam.vw);
        const y = cam.vh - ((now / 18 + i * 47) % (cam.vh + 80));
        ctx.globalAlpha = 0.45 + 0.4 * Math.sin(now / 300 + i);
        ctx.fillStyle = i % 3 === 0 ? '#ffd15a' : '#ff6a3d';
        ctx.beginPath();
        ctx.arc(x, y, 1.6 + (i % 3), 0, TAU);
        ctx.fill();
      }
    } else {
      for (let i = 0; i < 70; i++) {
        const x = (i * 149) % cam.vw;
        const y = (i * 271) % cam.vh;
        ctx.globalAlpha = 0.3 + 0.7 * Math.abs(Math.sin(now / 700 + i));
        ctx.fillStyle = i % 9 === 0 ? '#9ad8ff' : '#ffffff';
        ctx.beginPath();
        ctx.arc(x, y, i % 13 === 0 ? 1.8 : 0.8, 0, TAU);
        ctx.fill();
      }
      const sx = ((now / 34) % (cam.vw + 100)) - 50;
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = '#d7f4ff';
      ctx.fillRect(sx, cam.vh * 0.25, 18, 4);
      ctx.fillStyle = '#5c8db5';
      ctx.fillRect(sx, cam.vh * 0.25 + 4, 18, 2);
    }
    ctx.restore();
  }

  private drawCelebrations(ctx: CanvasRenderingContext2D, now: number): void {
    for (const c of this.celebrations) {
      const node = this.nodeById.get(c.nodeId);
      if (!node || (node.realm ?? 'world') !== this.view) continue;
      const x = this.camera.screenX(node.x);
      const y = this.camera.screenY(node.y);
      if (x < -120 || x > this.camera.vw + 120 || y < -120 || y > this.camera.vh + 120) continue;
      const p = Math.min(1, (now - c.start) / c.duration);
      const fade = 1 - Math.max(0, (p - 0.65) / 0.35);
      ctx.save();
      ctx.globalAlpha = fade;
      if (c.kind === 'buy') {
        const pop = p < 0.25 ? easeInOutCubic(p / 0.25) : 1;
        ctx.translate(x, y - 20);
        ctx.scale(0.4 + pop * 0.6, 0.4 + pop * 0.6);
        ctx.fillStyle = '#ffe9b0';
        ctx.strokeStyle = '#65441d';
        ctx.lineWidth = 3;
        ctx.beginPath(); ctx.roundRect(-18, -34, 36, 34, 4); ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#67b7ff';
        for (let i = 0; i < 3; i++) ctx.fillRect(-12 + i * 10, -26, 6, 8);
        ctx.fillStyle = '#c98535';
        ctx.beginPath(); ctx.moveTo(-24, -34); ctx.lineTo(0, -52); ctx.lineTo(24, -34); ctx.closePath(); ctx.fill(); ctx.stroke();
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * TAU + p * 2;
          ctx.fillStyle = '#ffd23f';
          ctx.beginPath(); ctx.arc(Math.cos(a) * (24 + p * 30), -10 + Math.sin(a) * (18 + p * 26), 3, 0, TAU); ctx.fill();
        }
      } else if (c.kind === 'monopoly' || c.kind === 'goal') {
        const rays = c.kind === 'goal';
        if (rays) {
          ctx.strokeStyle = '#ffe066'; ctx.lineWidth = 3;
          for (let i = 0; i < 12; i++) {
            const a = (i / 12) * TAU + p * 0.6;
            ctx.beginPath(); ctx.moveTo(x + Math.cos(a) * 18, y + Math.sin(a) * 12); ctx.lineTo(x + Math.cos(a) * (50 + p * 80), y + Math.sin(a) * (36 + p * 60)); ctx.stroke();
          }
        }
        for (let i = 0; i < 24; i++) {
          const a = (i / 24) * TAU + i;
          const rad = 20 + p * 110;
          ctx.fillStyle = ['#ffd23f', '#ff6b6b', '#57d5ff', '#8bff9a'][i % 4];
          ctx.beginPath(); ctx.arc(x + Math.cos(a) * rad, y - 20 + Math.sin(a) * rad * 0.7, 2.5, 0, TAU); ctx.fill();
        }
      } else {
        ctx.fillStyle = 'rgba(44, 28, 52, 0.55)';
        ctx.beginPath(); ctx.ellipse(x, y - 55, 26, 13, 0, 0, TAU); ctx.fill();
        ctx.strokeStyle = 'rgba(155, 195, 255, 0.7)'; ctx.lineWidth = 1.5;
        for (let i = 0; i < 7; i++) { ctx.beginPath(); ctx.moveTo(x - 20 + i * 7, y - 48); ctx.lineTo(x - 24 + i * 6, y + 4); ctx.stroke(); }
      }
      ctx.restore();
    }
  }

  private drawWarpOverlay(ctx: CanvasRenderingContext2D, now: number): void {
    const warp = this.warpAnim;
    if (!warp || warp.via !== 'realm') return;
    const target = this.nodeById.get(warp.toNode)?.realm ?? 'world';
    const p = Math.min(1, Math.max(0, (now - warp.start) / warp.duration));
    const flash = Math.sin(Math.min(1, p / 0.55) * Math.PI);
    ctx.save();
    if (target === 'heaven' || (!target && p > 0.5)) {
      ctx.fillStyle = `rgba(255,255,255,${0.75 * flash})`;
      ctx.fillRect(0, 0, this.camera.vw, this.camera.vh);
      for (let i = 0; i < 8; i++) {
        ctx.fillStyle = `rgba(255,255,255,${0.5 * flash})`;
        ctx.beginPath();
        ctx.arc((i * 191) % this.camera.vw, this.camera.vh - p * (120 + i * 25), 50 + i * 8, 0, TAU);
        ctx.fill();
      }
    } else if (target === 'hell') {
      ctx.fillStyle = `rgba(140,20,10,${0.7 * flash})`;
      ctx.fillRect(0, 0, this.camera.vw, this.camera.vh);
      ctx.fillStyle = 'rgba(0,0,0,0.8)';
      ctx.beginPath();
      ctx.ellipse(this.camera.vw / 2, this.camera.vh * 0.6, 20 + p * 90, 8 + p * 26, 0, 0, TAU);
      ctx.fill();
    } else {
      for (let i = 0; i < 80; i++) {
        const a = (i / 80) * TAU;
        const r = ((i * 37 + now * 0.4) % 400);
        ctx.fillStyle = 'rgba(255,255,255,0.8)';
        ctx.beginPath();
        ctx.arc(this.camera.vw / 2 + Math.cos(a) * r, this.camera.vh / 2 + Math.sin(a) * r, 1.4, 0, TAU);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  private drawProjectiles(ctx: CanvasRenderingContext2D, layouts: TokenLayout[], now: number): void {
    for (const active of this.emoteActive.values()) {
      if (active.def.anim !== 'throw') continue;
      const actor = layouts.find((l) => l.playerId === active.playerId);
      const target = active.targetId !== null ? layouts.find((l) => l.playerId === active.targetId) : undefined;
      if (!actor || !target) continue;
      const t = Math.min(1, (now - active.start) / active.duration);
      drawProjectile(
        ctx,
        actor.x,
        actor.y,
        actor.height,
        target.x,
        target.y,
        target.height,
        t,
        active.def.projectile ?? '🍅',
      );
    }
  }

  private drawFloatTexts(ctx: CanvasRenderingContext2D, now: number): void {
    for (const f of this.floatTexts) {
      const node = this.nodeById.get(f.nodeId);
      if (!node) continue;
      const p = Math.min(1, (now - f.start) / 1500);
      const x = this.camera.screenX(node.x);
      const y = this.camera.screenY(node.y) - 18 - p * 42;
      if (x < -100 || x > this.camera.vw + 100 || y < -60 || y > this.camera.vh + 60) continue;
      ctx.save();
      ctx.globalAlpha = 1 - Math.max(0, (p - 0.65) / 0.35);
      ctx.font = `800 15px ${LABEL_FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(255,255,255,0.95)';
      ctx.strokeText(f.text, x, y);
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, x, y);
      ctx.restore();
    }
  }

  private drawBubbles(ctx: CanvasRenderingContext2D, layouts: TokenLayout[], now: number): void {
    for (const [playerId, bubble] of this.bubbles) {
      if (now >= bubble.until) continue;
      const layout = layouts.find((l) => l.playerId === playerId);
      if (!layout) continue;
      if (layout.x < -100 || layout.x > this.camera.vw + 100 || layout.y < -100 || layout.y > this.camera.vh + 180) {
        continue;
      }
      const lines = splitLines(bubble.text, 14);
      const fs = 11;
      ctx.save();
      ctx.font = `700 ${fs}px ${LABEL_FONT}`;
      let maxW = 0;
      for (const line of lines) maxW = Math.max(maxW, ctx.measureText(line).width);
      const w = Math.min(this.camera.vw - 12, maxW + 18);
      const lh = 14;
      const h = lines.length * lh + 10;
      const active = this.emoteActive.get(playerId);
      const headY = layout.y - layout.height - (active ? 34 : 20);
      let x = Math.max(6, Math.min(this.camera.vw - w - 6, layout.x - w / 2));
      let y = headY - h;
      let below = false;
      if (y < 5) {
        y = layout.y + 12;
        below = true;
      }
      const tailX = Math.max(x + 10, Math.min(x + w - 10, layout.x));
      ctx.fillStyle = 'rgba(9, 30, 58, 0.26)';
      ctx.beginPath();
      ctx.roundRect(x + 1, y + 2.5, w, h, 9);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#23385c';
      ctx.lineWidth = 1.7;
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, 9);
      ctx.fill();
      ctx.stroke();
      // Tail triangle pointing at the token.
      ctx.beginPath();
      if (below) {
        ctx.moveTo(tailX - 5, y + 1);
        ctx.lineTo(tailX + 5, y + 1);
        ctx.lineTo(tailX + 1, y - 7);
      } else {
        ctx.moveTo(tailX - 5, y + h - 1);
        ctx.lineTo(tailX + 5, y + h - 1);
        ctx.lineTo(tailX + 1, y + h + 7);
      }
      ctx.closePath();
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.strokeStyle = '#23385c';
      ctx.lineWidth = 1.4;
      ctx.stroke();
      ctx.fillStyle = '#1a2b4c';
      ctx.font = `700 ${fs}px ${LABEL_FONT}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      for (let i = 0; i < lines.length; i++) {
        ctx.fillText(lines[i], x + 9, y + 6 + lh * i + lh / 2);
      }
      ctx.restore();
    }
  }

  // ---------------------------------------------------------------- input

  private readonly onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    e.preventDefault();
    const p = this.eventPoint(e);
    this.pointers.set(e.pointerId, p);
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      // Synthetic pointer events (tests) have no capture target.
    }
    this.camera.stopTween();
    this.velocityX = 0;
    this.velocityY = 0;
    if (this.pointers.size === 1) {
      this.primaryPointerId = e.pointerId;
      this.dragStartX = p.x;
      this.dragStartY = p.y;
          this.dragMoved = 0;
      this.dragging = false;
      this.followPausedUntil = performance.now() + 1600;
      this.canvas.style.cursor = 'grabbing';
    } else if (this.pointers.size === 2) {
      this.beginPinch();
    }
    this.requestRender();
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    const p = this.eventPoint(e);
    const previous = this.pointers.get(e.pointerId);
    if (!previous) {
      if (e.pointerType === 'mouse' && this.pointers.size === 0) this.updateHover(p.x, p.y);
      return;
    }
    this.pointers.set(e.pointerId, p);
    if (this.pointers.size >= 2) {
      this.applyPinch();
      return;
    }
    if (this.primaryPointerId !== e.pointerId) return;
    const dx = p.x - previous.x;
    const dy = p.y - previous.y;
    const total = Math.hypot(p.x - this.dragStartX, p.y - this.dragStartY);
    this.dragMoved = Math.max(this.dragMoved, total);
    if (!this.dragging && total > 8) {
      this.dragging = true;
      this.camera.panByScreen(p.x - this.dragStartX, p.y - this.dragStartY);
      this.velocityX = 0;
      this.velocityY = 0;
      this.velocitySampleAt = performance.now();
    } else if (this.dragging) {
      this.camera.panByScreen(dx, dy);
      const now = performance.now();
      const dt = Math.max(1, now - this.velocitySampleAt);
      this.velocityX = this.velocityX * 0.65 + (dx / dt) * 0.35;
      this.velocityY = this.velocityY * 0.65 + (dy / dt) * 0.35;
      this.velocitySampleAt = now;
    }
    this.requestRender();
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    const p = this.pointers.get(e.pointerId) ?? this.eventPoint(e);
    this.pointers.delete(e.pointerId);
    try {
      this.canvas.releasePointerCapture(e.pointerId);
    } catch {
      // ignore synthetic capture
    }
    const wasMulti = this.pointers.size > 0;
    if (this.pointers.size === 0) {
      this.pinchPrev = null;
      const wasDrag = this.dragging;
      this.dragging = false;
      this.primaryPointerId = null;
      this.canvas.style.cursor = 'grab';
      if (!wasDrag) this.handleTap(p.x, p.y);
      else {
        const speed = Math.hypot(this.velocityX, this.velocityY);
        if (speed > 0.35) {
          this.velocityX *= 0.85;
          this.velocityY *= 0.85;
        }
      }
      this.followPausedUntil = performance.now() + 900;
    } else {
      if (wasMulti) {
        // Keep one-finger panning alive after a pinch; never turn the gesture
        // into a tap when the last finger lifts.
        const remaining = [...this.pointers.entries()][0];
        if (remaining) {
          this.primaryPointerId = remaining[0];
          this.dragStartX = remaining[1].x;
          this.dragStartY = remaining[1].y;
          this.dragMoved = 0;
          this.dragging = false;
        }
        this.pinchPrev = null;
      }
    }
    this.requestRender();
  };

  private readonly onPointerCancel = (e: PointerEvent): void => {
    this.pointers.delete(e.pointerId);
    this.velocityX = 0;
    this.velocityY = 0;
    if (this.pointers.size === 0) {
      this.dragging = false;
      this.primaryPointerId = null;
      this.pinchPrev = null;
    }
    this.requestRender();
  };

  private readonly onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    this.overviewMode = false;
    const p = this.eventPoint(e);
    const scale = e.deltaMode === 1 ? 16 : 1;
    const factor = Math.exp(-e.deltaY * scale * 0.0014);
    this.camera.stopTween();
    this.camera.zoomAround(p.x, p.y, this.camera.zoom * factor);
    this.followId = null;
    this.followPausedUntil = performance.now() + 1200;
    this.requestRender();
  };

  private readonly onContextMenu = (e: Event): void => {
    e.preventDefault();
  };

  private attachInput(): void {
    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerup', this.onPointerUp);
    this.canvas.addEventListener('pointercancel', this.onPointerCancel);
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
    this.canvas.addEventListener('contextmenu', this.onContextMenu);
    this.canvas.style.cursor = 'grab';
    this.canvas.style.userSelect = 'none';
  }

  private detachInput(): void {
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointercancel', this.onPointerCancel);
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.canvas.removeEventListener('contextmenu', this.onContextMenu);
  }

  private eventPoint(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private beginPinch(): void {
    const pts = [...this.pointers.values()];
    if (pts.length < 2) {
      this.pinchPrev = null;
      return;
    }
    this.suppressTapUntil = performance.now() + 650;
    const [a, b] = pts;
    this.pinchPrev = {
      dist: Math.hypot(a.x - b.x, a.y - b.y),
      midX: (a.x + b.x) / 2,
      midY: (a.y + b.y) / 2,
    };
    this.dragging = false;
    this.followId = null;
  }

  private applyPinch(): void {
    this.overviewMode = false;
    const pts = [...this.pointers.values()];
    if (pts.length < 2) return;
    const [a, b] = pts;
    const dist = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
    const midX = (a.x + b.x) / 2;
    const midY = (a.y + b.y) / 2;
    const prev = this.pinchPrev ?? { dist, midX, midY };
    if (prev.dist > 0) {
      this.camera.zoomAround(prev.midX, prev.midY, this.camera.zoom * (dist / prev.dist));
      this.camera.panByScreen(midX - prev.midX, midY - prev.midY);
    }
    this.pinchPrev = { dist, midX, midY };
    this.followPausedUntil = performance.now() + 1600;
    this.requestRender();
  }

  private updateHover(x: number, y: number): void {
    const option = this.hitOption(x, y);
    const next = option?.nodeId ?? null;
    if (next !== this.hoveredOption) {
      this.hoveredOption = next;
      this.requestRender();
    }
    const city = option ? null : this.hitCity(x, y);
    this.canvas.style.cursor = option || city ? 'pointer' : 'grab';
  }

  private handleTap(x: number, y: number): void {
    const now = performance.now();
    if (now < this.suppressTapUntil) {
      this.lastTap = null;
      return;
    }
    if (this.isOverview()) {
      const world = this.camera.worldAt(x, y);
      const zoom = Math.max(this.playZoom(), this.camera.minZoom() * 3.2);
      void this.focusWorldPoint(world.x, world.y, zoom, 420);
      this.lastTap = null;
      return;
    }
    const option = this.hitOption(x, y);
    if (option) {
      // A pin tap only changes selection. Confirmation always comes from the
      // explicit UI button (or the map's numbered badge), so UI and map cannot
      // disagree about whether a move is committed.
      this.selectedOption = option.nodeId;
      this.hoveredOption = option.nodeId;
      this.overviewMode = false;
      this.frameSelectedPath(option.nodeId);
      this.moveHooks?.onSelect?.(option.nodeId);
      this.requestRender();
      this.lastTap = null;
      return;
    }
    const city = this.hitCity(x, y);
    if (city) {
      this.cityTap?.(city.cityId);
      this.lastTap = null;
      return;
    }
    if (this.selectedOption) {
      this.selectedOption = null;
      this.hoveredOption = null;
        this.moveHooks?.onSelect?.(null);
      this.requestRender();
    }
    // Double-tap zooms around the tapped world point.
    if (this.lastTap && now - this.lastTap.at < 330 && Math.hypot(x - this.lastTap.x, y - this.lastTap.y) < 28) {
      this.lastTap = null;
      this.overviewMode = false;
      const cam = this.camera;
      const wx = cam.x + (x - cam.vw / 2) / cam.zoom;
      const wy = cam.y + (y - cam.vh / 2) / cam.zoom;
      const z = cam.clampZoom(cam.zoom * 1.85);
      const tx = wx - (x - cam.vw / 2) / z;
      const ty = wy - (y - cam.vh / 2) / z;
      this.followId = null;
      void cam.startTween(tx, ty, z, 260);
      this.requestRender();
    } else {
      this.lastTap = { at: now, x, y };
    }
  }

  private hitOption(x: number, y: number): MoveOption | null {
    if (!this.moveOptions) return null;
    let best: MoveOption | null = null;
    let bestDist = Infinity;
    for (const pin of this.edgePinHits) {
      const d = Math.hypot(pin.x - x, pin.y - y);
      if (d <= pin.r && d < bestDist) {
        const option = this.moveOptions.find((o) => o.nodeId === pin.nodeId) ?? null;
        if (option) {
          best = option;
          bestDist = d;
        }
      }
    }
    if (best) return best;
    for (const pin of this.optionPinHits) {
      const d = Math.hypot(pin.x - x, pin.y - y);
      if (d <= pin.r && d < bestDist) {
        const option = this.moveOptions.find((o) => o.nodeId === pin.nodeId) ?? null;
        if (option) {
          best = option;
          bestDist = d;
        }
      }
    }
    if (best) return best;
    const radius = Math.max(22, this.tileRadius() + 12);
    for (const option of this.moveOptions) {
      const node = this.nodeById.get(option.nodeId);
      if (!node) continue;
      const sx = this.camera.screenX(node.x);
      const sy = this.camera.screenY(node.y);
      const d = Math.hypot(sx - x, sy - y);
      if (d < radius && d < bestDist) {
        best = option;
        bestDist = d;
      }
    }
    return best;
  }

  private hitCity(x: number, y: number): { cityId: string } | null {
    let best: { cityId: string } | null = null;
    let bestDist = Infinity;
    for (const hit of this.cityHitGrid.queryPoint(x, y)) {
      const d = Math.hypot(hit.x - x, hit.y - y);
      if (d <= hit.r && d < bestDist) {
        best = { cityId: hit.cityId };
        bestDist = d;
      }
    }
    if (best) return best;
    for (const hit of this.cityLabelGrid.queryPoint(x, y)) {
      if (insideRect(x, y, hit.rect)) return { cityId: hit.cityId };
    }
    return null;
  }

  private confirmOption(nodeId: string): void {
    const now = performance.now();
    if (now - this.lastPickAt < 400) return;
    this.lastPickAt = now;
    if (this.moveHooks?.onConfirm) this.moveHooks.onConfirm(nodeId);
    else this.movePick?.(nodeId);
  }
}

function classifyTerrain(lat: number, lon: number, n: number): string | null {
  const r = (hashString(`r${n}`) % 1000) / 1000;
  if (lat < -60) return r < 0.5 ? 'iceberg' : 'snow_mountain';
  if (lon > 65 && lon < 102 && lat > 25 && lat < 42) return r < 0.4 ? 'snow_mountain' : 'mountains';
  if (lon > 4 && lon < 19 && lat > 43 && lat < 49) return r < 0.35 ? 'snow_mountain' : 'mountains';
  if (lon > -132 && lon < -103 && lat > 35 && lat < 62) return r < 0.3 ? 'snow_mountain' : 'mountains';
  if (lon > -82 && lon < -63 && lat > -52 && lat < 12) return r < 0.35 ? 'snow_mountain' : 'mountains';
  if (lat > 62 && lon > -60 && lon < -20) return 'iceberg';
  if ((lon > -18 && lon < 35 && lat > 12 && lat < 32) ||
      (lon > 35 && lon < 60 && lat > 12 && lat < 32) ||
      (lon > 115 && lon < 146 && lat > -33 && lat < -19) ||
      (lon > 85 && lon < 116 && lat > 38 && lat < 51)) {
    return r < 0.15 ? 'oil_rig' : 'desert';
  }
  if (lon > 35 && lon < 60 && lat > 15 && lat < 36) return r < 0.25 ? 'oil_rig' : 'desert';
  if (lat > 49) return r < 0.65 ? 'conifer_forest' : 'snow_mountain';
  if (Math.abs(lat) < 23.5) return r < 0.58 ? 'palms' : 'forest';
  if (r < 0.3) return 'forest';
  if (r < 0.55) return 'fields';
  if (r < 0.68) return 'ranch';
  if (r < 0.74) return 'factory';
  if (r < 0.82) return 'mountains';
  return 'fields';
}

function terrainSize(kind: string): number {
  switch (kind) {
    case 'mountains': return 62;
    case 'snow_mountain': return 72;
    case 'volcano': return 58;
    case 'conifer_forest': return 42;
    case 'forest': return 36;
    case 'palms': return 34;
    case 'desert': return 32;
    case 'fields': return 40;
    case 'ranch': return 36;
    case 'oil_rig': return 32;
    case 'factory': return 36;
    case 'iceberg': return 44;
    default: return 55;
  }
}

function drawStampFallback(ctx: CanvasRenderingContext2D, kind: string, x: number, y: number, size: number): void {
  ctx.save();
  ctx.translate(x, y);
  if (kind === 'mountains' || kind === 'snow_mountain') {
    ctx.fillStyle = kind === 'snow_mountain' ? '#f0f5f2' : '#8a7a66';
    ctx.beginPath();
    ctx.moveTo(-size * 0.5, 0);
    ctx.lineTo(-size * 0.1, -size * 0.7);
    ctx.lineTo(size * 0.12, -size * 0.35);
    ctx.lineTo(size * 0.3, -size * 0.6);
    ctx.lineTo(size * 0.52, 0);
    ctx.closePath();
    ctx.fill();
  } else if (kind === 'desert') {
    ctx.fillStyle = '#e6c56a';
    ctx.beginPath();
    ctx.ellipse(0, 0, size * 0.5, size * 0.24, 0, 0, TAU);
    ctx.fill();
  } else {
    ctx.fillStyle = kind === 'factory' ? '#8d9aa8' : kind === 'oil_rig' ? '#5f6a75' : '#4f9b3b';
    ctx.beginPath();
    ctx.arc(0, -size * 0.2, size * 0.28, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
}

function gemColors(kind: SquareKind): { light: string; main: string; dark: string; edge: string } {
  switch (kind) {
    case 'blue': return { light: '#8fd4ff', main: '#2f9df0', dark: '#1265b5', edge: '#0d4a89' };
    case 'red': return { light: '#ff9fae', main: '#f0455e', dark: '#b91f3b', edge: '#88142b' };
    case 'yellow': return { light: '#ffe98a', main: '#ffc72f', dark: '#d88f06', edge: '#9a6403' };
    case 'news': return { light: '#d9b3ff', main: '#9b4de8', dark: '#6722ad', edge: '#48137c' };
    case 'shop': return { light: '#ffd9a3', main: '#ffa63d', dark: '#cf6b08', edge: '#934a03' };
    case 'warp': return { light: '#c8f7ff', main: '#3fc3e8', dark: '#1a6fb5', edge: '#124b80' };
    case 'portal': return { light: '#fff6b0', main: '#ffd84a', dark: '#d19100', edge: '#8f6100' };
    case 'city': return { light: '#ffffff', main: '#eef7ff', dark: '#cfe5f4', edge: '#23385c' };
  }
}

/**
 * Canonical square-kind chip. The map pins and the UI option-list chips both
 * import this so numbers, colours and kind symbols cannot drift apart.
 */
export function moveKindChip(kind: SquareKind): MoveKindChip {
  const colors = gemColors(kind);
  const symbol =
    kind === 'city' ? '駅' :
      kind === 'blue' ? '＋' :
        kind === 'red' ? '−' :
          kind === 'yellow' ? '？' :
            kind === 'news' ? '！' :
              kind === 'shop' ? '店' :
                kind === 'warp' ? '↻' : '↯';
  const label =
    kind === 'city' ? '都市' :
      kind === 'blue' ? '収入' :
        kind === 'red' ? '支出' :
          kind === 'yellow' ? 'カード' :
            kind === 'news' ? 'ニュース' :
              kind === 'shop' ? 'カード売り場' :
                kind === 'warp' ? 'ワープ' : '異世界出口';
  return { color: kind === 'city' ? '#2f6fa8' : colors.main, symbol, label };
}
