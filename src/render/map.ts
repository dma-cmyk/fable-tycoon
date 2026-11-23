// Canvas world-map renderer. See docs/UI.md §5 for the public API.
//
// Coordinate model: world units are the Miller projection units from core/geo. The camera
// stores its centre in map units and its zoom in CSS px per map unit. Horizontal wrap is
// handled by always projecting through wrapDx(), so no drawing code needs seam special cases.

import { MAP_H, MAP_W, wrapDx, wrapX } from '../core/geo';
import { REALMS, REALM_H, REALM_W } from '../core/realm';
import type {
  BoardNode,
  Character,
  City,
  EmoteDef,
  GameData,
  RealmId,
  GameState,
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
import { AmbientWorld } from './ambient';
import { RectGrid } from './grid';
import { drawVehicle, vehicleMetrics, type VehicleKind } from './vehicles';

export interface LandJson {
  w: number;
  h: number;
  /** polygons → rings → flat [x,y,...]; holes are represented by extra rings. */
  polygons: number[][][];
}

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
}

export interface FrameStats {
  avgMs: number;
  p95Ms: number;
  maxMs: number;
  fps: number;
  frames: number;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
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
  sea: boolean;
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

function rectsHit(a: Rect, b: Rect, pad = 0): boolean {
  return (
    a.x < b.x + b.w + pad &&
    a.x + a.w + pad > b.x &&
    a.y < b.y + b.h + pad &&
    a.y + a.h + pad > b.y
  );
}

function insideRect(x: number, y: number, r: Rect): boolean {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
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
  private readonly cityNodeId = new Map<string, string>();
  private readonly characterById = new Map<string, Character>();
  private readonly edges: DrawEdge[] = [];
  private readonly edgeModes = new Map<string, 'rail' | 'sea'>();
  private readonly warpNodes: BoardNode[] = [];
  private readonly ambient: AmbientWorld;

  private state: GameState | null = null;
  private tokens: TokenRuntime[] = [];
  private playerColors: string[] = [];
  private ownership = new Map<string, { counts: number[]; total: number; monopoly: number }>();
  private destinationNodeId: string | null = null;
  private staticRevision = 0;
  private month = 4;
  private season: Season = seasonForMonth(4);
  private seasonTransitionStart = 0;
  private initialCameraDone = false;
  private manualViewUntil = 0;
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
  private hoveredOption: string | null = null;
  private selectedOption: string | null = null;
  private lastPickAt = 0;
  private badgeRect: Rect | null = null;
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

  private readonly measureCache = new Map<string, number>();
  private resizeObserver: ResizeObserver;

  constructor(canvas: HTMLCanvasElement, data: GameData, assets: MapAssets) {
    this.canvas = canvas;
    this.assets = assets;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('2D canvas unavailable');
    this.ctx = ctx;
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.imageSmoothingQuality = 'high';

    this.landLayer = new LandLayer(assets.land);

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
    for (const city of data.cities) {
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
      this.edgeModes.set(edgeKey(e.a, e.b), e.mode);
      const realm = a.realm;
      if (realm !== b.realm) continue;
      const draw: DrawEdge = {
        ax: a.x,
        ay: a.y,
        dx: wrapDx(a.x, b.x),
        dy: b.y - a.y,
        sea: e.mode === 'sea',
      };
      if (realm) {
        const list = this.realmEdges.get(realm) ?? [];
        list.push(draw);
        this.realmEdges.set(realm, list);
      } else {
        this.edges.push(draw);
      }
    }
    for (const node of data.board.nodes) {
      if (node.kind === 'warp') this.warpNodes.push(node);
    }
    this.ambient = new AmbientWorld(data, assets.vehicles);

    canvas.style.touchAction = 'none';
    canvas.style.display = 'block';

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);

    document.addEventListener('visibilitychange', this.onVisibility);
    this.resize();
    this.attachInput();
    this.requestRender();
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

  setState(state: GameState): void {
    this.state = state;
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
        const fitH = this.cssH / MAP_H;
        const playZoom = this.camera.clampZoom(fitH * (this.cssW >= 900 ? 5 : 3.6));
        this.camera.startTween(node.x, node.y, playZoom, 0);
      }
    }

    if (this.moveAnim) {
      const player = state.players[this.moveAnim.playerId];
      const last = this.moveAnim.path[this.moveAnim.path.length - 1];
      if (!player || last !== player.nodeId) this.cancelMove();
    }
    if (this.warpAnim) {
      const player = state.players[this.warpAnim.playerId];
      if (!player || player.nodeId !== this.warpAnim.toNode) this.cancelWarp();
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

  setMoveOptions(options: MoveOption[] | null, onPick: (nodeId: string) => void): void {
    this.moveOptions = options ? options.map((o) => ({ nodeId: o.nodeId, path: [...o.path] })) : null;
    this.movePick = onPick;
    this.hoveredOption = null;
    if (!options || !this.selectedOption || !options.some((o) => o.nodeId === this.selectedOption)) {
      this.selectedOption = null;
    }
    this.badgeRect = null;
    this.requestRender();
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
    const promise = this.camera.focus(node.x, node.y, opts?.zoom, opts?.ms ?? 550);
    this.requestRender();
    return promise;
  }

  fitWorld(ms = 650): Promise<void> {
    this.followId = null;
    const promise = this.camera.fitWorld(ms);
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
    if (!existed) cam.fitWorld(0);
    this.hoveredOption = null;
    this.selectedOption = null;
    this.badgeRect = null;
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

  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const cssW = Math.max(1, rect.width || this.canvas.clientWidth || 640);
    const cssH = Math.max(1, rect.height || this.canvas.clientHeight || 480);
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    this.cssW = cssW;
    this.cssH = cssH;
    this.dpr = dpr;
    const pxW = Math.round(cssW * dpr);
    const pxH = Math.round(cssH * dpr);
    if (this.canvas.width !== pxW) this.canvas.width = pxW;
    if (this.canvas.height !== pxH) this.canvas.height = pxH;
    this.worldCamera.setViewport(cssW, cssH);
    for (const cam of this.realmCameras.values()) cam.setViewport(cssW, cssH);
    this.camera.setViewport(cssW, cssH);
    if (!this.initialized) {
      this.initialized = true;
      void this.camera.fitWorld(0);
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

  resetFrameStats(): void {
    this.frameTimes = [];
    this.lastFrameTime = 0;
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

  private detailLevel(): number {
    if (this.view !== 'world') return this.camera.zoom < 0.8 ? 1 : 2;
    const z = this.camera.zoom;
    return z < 0.6 ? 0 : z < 1.45 ? 1 : 2;
  }

  private tileRadius(): number {
    return Math.min(20, Math.max(5, 4 + this.camera.zoom * 6));
  }

  private cityRadius(): number {
    return Math.min(15, Math.max(5.5, 4.5 + this.camera.zoom * 4.2));
  }

  private tokenHeight(): number {
    return Math.min(104, Math.max(44, 44 + this.camera.zoom * 18));
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

  private cancelMove(): void {
    const anim = this.moveAnim;
    if (!anim) return;
    this.moveAnim = null;
    const token = this.tokens[anim.playerId];
    if (token && anim.path.length > 0) token.nodeId = anim.path[anim.path.length - 1];
    anim.resolve();
  }

  private cancelWarp(): void {
    const anim = this.warpAnim;
    if (!anim) return;
    this.warpAnim = null;
    const token = this.tokens[anim.playerId];
    if (token) token.nodeId = anim.toNode;
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

    // Follow the active token, but never fight a user pan or a camera tween.
    if (!this.dragging && !this.camera.isTweening() && now > this.followPausedUntil) {
      let followId = this.followId;
      if (followId === null && this.moveAnim) followId = this.moveAnim.playerId;
      if (followId === null && this.warpAnim) followId = this.warpAnim.playerId;
      if (followId !== null) {
        const target = this.tokenWorldPosition(followId, now);
        if (target) {
          const dx = wrapDx(this.camera.x, target.x);
          const dy = target.y - this.camera.y;
          if (Math.abs(dx) > 0.35 || Math.abs(dy) > 0.35) {
            const k = this.moveAnim || this.warpAnim ? 0.14 : 0.1;
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
      );
      this.landLayer.drawSeasonFade(ctx, cam, now);
      this.ambient.draw(ctx, cam, now, this.detailLevel());
      this.drawWorldWarpTiles(ctx, now);
      this.drawSeasonParticles(ctx, now);
    } else {
      this.drawRealmBoard(ctx, now);
      this.drawRealmAmbient(ctx, now);
    }
    const layouts = this.computeLayouts(now);
    this.drawCities(ctx, now, layouts);
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
    ctx.restore();
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
    for (const e of edges) {
      const x1 = toX(e.ax);
      const y1 = toY(e.ay);
      const x2 = x1 + e.dx * cam.zoom;
      const y2 = y1 + e.dy * cam.zoom;
      if (Math.max(x1, x2) < -margin || Math.min(x1, x2) > cam.vw + margin) continue;
      if (Math.max(y1, y2) < -margin || Math.min(y1, y2) > cam.vh + margin) continue;
      path.moveTo(x1, y1);
      path.lineTo(x2, y2);
    }
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = accent.glow;
    ctx.lineWidth = 13;
    ctx.stroke(path);
    ctx.strokeStyle = accent.edge;
    ctx.lineWidth = 8;
    ctx.stroke(path);
    ctx.strokeStyle = accent.core;
    ctx.lineWidth = 3;
    ctx.stroke(path);
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
    for (const entry of this.cityEntriesForView()) {
      const x = cam.screenX(entry.node.x);
      const y = cam.screenY(entry.node.y);
      if (x < -180 || x > cam.vw + 180 || y < -180 || y > cam.vh + 180) continue;
      this.drawCityPedestalAt(ctx, x, y, radius, this.ownership.get(entry.city.id));
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

    // --- sea routes + rails ---------------------------------------------------
    const railPath = new Path2D();
    const seaPath = new Path2D();
    for (const e of this.edges) {
      const ax = centerX + wrapDx(centerX, e.ax);
      const bx = ax + e.dx;
      const ay = e.ay;
      const by = ay + e.dy;
      const [x1, y1] = toCanvas(ax, ay);
      const [x2, y2] = toCanvas(bx, by);
      if (Math.max(x1, x2) < -margin || Math.min(x1, x2) > wPx + margin) continue;
      if (Math.max(y1, y2) < -margin || Math.min(y1, y2) > hPx + margin) continue;
      const path = e.sea ? seaPath : railPath;
      path.moveTo(x1, y1);
      path.lineTo(x2, y2);
    }
    const zoom = this.camera.zoom;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(255,255,255,0.92)';
    ctx.lineWidth = Math.min(3.4, Math.max(1.4, 1 + zoom * 0.8)) * dpr;
    ctx.setLineDash([Math.max(2, zoom * 2.4) * dpr, Math.max(5, zoom * 5.2) * dpr]);
    ctx.stroke(seaPath);
    ctx.setLineDash([]);
    const railW = Math.min(7, Math.max(1.8, 1.4 + zoom * 1.7));
    ctx.strokeStyle = '#7591a8';
    ctx.lineWidth = (railW + 2.8) * dpr;
    ctx.stroke(railPath);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = railW * dpr;
    ctx.stroke(railPath);
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

    // --- city pedestals (owner stripes are part of the static cache) --------
    for (const entry of this.cityEntries) {
      const wx = centerX + wrapDx(centerX, entry.node.x);
      const [px, py] = toCanvas(wx, entry.node.y);
      if (px < -cityPad || px > wPx + cityPad || py < -cityPad || py > hPx + cityPad) continue;
      this.drawCityPedestalAt(ctx, px, py, radius, this.ownership.get(entry.city.id));
    }
  }

  private drawCities(ctx: CanvasRenderingContext2D, now: number, layouts: TokenLayout[]): void {
    const cam = this.camera;
    const radius = this.cityRadius();
    const detail = this.detailLevel();
    this.cityHits = [];
    this.cityLabelHits = [];
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

    // Landmarks are drawn behind labels; labels do not treat them as obstacles.
    const reserved: Rect[] = [];

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

    if (destination) {
      const flagRect = this.drawDestinationFlag(ctx, destination, radius, now);
      if (flagRect) reserved.push(flagRect);
    }
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

    // Do not bury city names under character sprites; labels that cannot find a
    // free slot are hidden (the pedestal remains visible).
    for (const layout of layouts) {
      if (layout.x < -100 || layout.x > cam.vw + 100 || layout.y < -100 || layout.y > cam.vh + 100) continue;
      const big = layout.height * (this.state?.current === layout.playerId ? 1.12 : 1);
      const tw = big * 0.8;
      reserved.push({ x: layout.x - tw / 2, y: layout.y - big - 4, w: tw, h: big + 10 });
    }

    this.drawCityLabels(ctx, visible, radius, detail, reserved);
  }

  private landmarkSize(tier: number): number {
    if (this.detailLevel() === 0) return tier === 1 ? 40 : 0;
    return Math.min(76, Math.max(54, 40 + this.camera.zoom * 18));
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
    ctx.save();
    ctx.fillStyle = 'rgba(7, 35, 57, 0.36)';
    ctx.beginPath();
    ctx.roundRect(left + 1.5, top + 3, w, h, h * 0.3);
    ctx.fill();

    ctx.beginPath();
    ctx.roundRect(left, top, w, h, h * 0.3);
    ctx.fillStyle = '#fbfeff';
    ctx.fill();
    ctx.lineWidth = Math.max(1.5, radius * 0.12);
    ctx.strokeStyle = '#23385c';
    ctx.stroke();

    ctx.beginPath();
    ctx.roundRect(left + 2, top + 2, w - 4, h * 0.3, h * 0.15);
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.fill();

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
    ctx.fillStyle = 'rgba(6, 40, 70, 0.26)';
    ctx.beginPath();
    ctx.ellipse(0.8, r * 0.56 + 2, r * 1.03, r * 0.44, 0, 0, TAU);
    ctx.fill();
    const grad = ctx.createLinearGradient(0, -r, 0, r);
    grad.addColorStop(0, palette.light);
    grad.addColorStop(0.55, palette.main);
    grad.addColorStop(1, palette.dark);
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, TAU);
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.lineWidth = Math.max(1.3, r * 0.17);
    ctx.strokeStyle = palette.edge;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.72, 0, TAU);
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

  private drawCityLabels(
    ctx: CanvasRenderingContext2D,
    visible: CityVis[],
    radius: number,
    detail: number,
    reserved: Rect[],
  ): void {
    const cam = this.camera;
    const currentCityId = this.state ? this.cityNodeIdOfPlayer(this.state.current) : null;
    const tokenNodeIds = new Set(this.tokens.map((t) => t.nodeId));
    const fs = Math.min(14, Math.max(9.5, 9.5 + cam.zoom * 1.25));
    const font = `800 ${fs.toFixed(1)}px ${LABEL_FONT}`;
    ctx.font = font;
    const tokenCityAt = (v: CityVis): boolean => tokenNodeIds.has(v.entry.node.id);
    const candidates = visible
      .filter((v) => {
        if (detail > 0) return true;
        if (v.entry.node.id === this.destinationNodeId) return true;
        if (v.entry.node.id === currentCityId) return true;
        if (tokenCityAt(v)) return true;
        return v.entry.city.tier === 1;
      })
      .slice()
      .sort((a, b) => {
        const pa = this.cityPriority(a, currentCityId, tokenCityAt(a));
        const pb = this.cityPriority(b, currentCityId, tokenCityAt(b));
        if (pa !== pb) return pb - pa;
        return a.entry.city.id < b.entry.city.id ? -1 : 1;
      });

    for (const v of candidates) {
      const text = v.entry.city.nameJa;
      const tw = this.measureText(ctx, text, font);
      const w = tw + 13;
      const h = fs + 8;
      const placements: Array<[number, number]> = [
        [v.x + radius + 6 + w / 2, v.y - h * 0.12],
        [v.x - radius - 6 - w / 2, v.y - h * 0.12],
        [v.x, v.y - radius - 5 - h / 2],
        [v.x, v.y + radius + 5 + h / 2],
      ];
      let chosen: Rect | null = null;
      for (const [cx, cy] of placements) {
        const rect = { x: cx - w / 2, y: cy - h / 2, w, h };
        if (rect.x < 3 || rect.y < 3 || rect.x + rect.w > this.camera.vw - 3 || rect.y + rect.h > this.camera.vh - 3) {
          continue;
        }
        if (reserved.some((r) => rectsHit(rect, r, 3))) continue;
        chosen = rect;
        break;
      }
      if (!chosen) continue;
      reserved.push(chosen);
      const labelHit = { cityId: v.entry.city.id, rect: chosen };
      this.cityLabelHits.push(labelHit);
      this.cityLabelGrid.add(chosen, labelHit);
      this.drawLabelBubble(ctx, v.x, v.y, chosen, text, fs, v.entry.node.id === this.destinationNodeId, this.ownership.get(v.entry.city.id));
    }
  }

  private cityPriority(v: CityVis, currentCityId: string | null, hasToken: boolean): number {
    let p = 0;
    if (v.entry.node.id === this.destinationNodeId) p += 100000;
    if (hasToken) p += 50000;
    if (v.entry.node.id === currentCityId) p += 20000;
    if (v.entry.city.tier === 1) p += 3000;
    else if (v.entry.city.tier === 2) p += 600;
    else p += 100;
    if (v.entry.city.landmark) p += 60;
    const owner = this.ownership.get(v.entry.city.id);
    if (owner && owner.monopoly >= 0) p += 80;
    return p;
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
    text: string,
    fs: number,
    isDestination: boolean,
    owner: { counts: number[]; total: number; monopoly: number } | undefined,
  ): void {
    ctx.save();
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
    ctx.font = `800 ${fs.toFixed(1)}px ${LABEL_FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, rect.x + rect.w / 2 + (owner && owner.total > 0 ? 2 : 0), rect.y + rect.h / 2 + 0.5);
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
    if (this.measureCache.size > 3000) this.measureCache.clear();
    this.measureCache.set(key, width);
    return width;
  }

  // ---------------------------------------------------------------- move selection

  private drawMoveUi(ctx: CanvasRenderingContext2D, now: number): void {
    if (!this.moveOptions || this.moveOptions.length === 0) return;
    const cam = this.camera;
    const r = this.tileRadius();
    this.moveOptions.forEach((option, index) => {
      const node = this.nodeById.get(option.nodeId);
      if (!node) return;
      const x = cam.screenX(node.x);
      const y = cam.screenY(node.y);
      if (x < -80 || x > cam.vw + 80 || y < -80 || y > cam.vh + 80) return;
      const pulse = (Math.sin(now / 260 + index * 1.7) + 1) / 2;
      const selected = this.selectedOption === option.nodeId;
      const hovered = this.hoveredOption === option.nodeId;
      ctx.save();
      ctx.globalAlpha = selected ? 0.95 : 0.7;
      const halo = r + 5 + pulse * 5 + (selected ? 3 : 0);
      const grad = ctx.createRadialGradient(x, y, r * 0.4, x, y, halo);
      grad.addColorStop(0, selected ? 'rgba(255, 238, 120, 0.5)' : 'rgba(255,255,255,0.28)');
      grad.addColorStop(1, 'rgba(255, 240, 130, 0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(x, y, halo, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = selected ? '#ffd83d' : hovered ? '#ffffff' : 'rgba(255, 246, 180, 0.95)';
      ctx.lineWidth = selected ? 3 : 2;
      ctx.beginPath();
      ctx.ellipse(x, y + 1, (r + 4 + pulse * 2.5) * 1.12, (r + 4 + pulse * 2.5) * 0.82, 0, 0, TAU);
      ctx.stroke();
      if (selected) {
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(x, y, (r + 11 + pulse * 3) * 1.1, 0, TAU);
        ctx.stroke();
      }
      ctx.restore();
    });

    const shown = this.selectedOption ?? this.hoveredOption;
    if (shown) {
      const option = this.moveOptions.find((o) => o.nodeId === shown);
      if (option) this.drawPathPreview(ctx, option, this.selectedOption === shown);
    }
  }

  private drawSelectedPathOverlay(ctx: CanvasRenderingContext2D): void {
    if (!this.selectedOption || !this.moveOptions) return;
    const option = this.moveOptions.find((o) => o.nodeId === this.selectedOption);
    if (!option) return;
    ctx.save();
    ctx.globalAlpha = 0.9;
    this.drawPathPreview(ctx, option, true);
    ctx.restore();
  }

  private drawOptionMarkers(ctx: CanvasRenderingContext2D, now: number): void {
    if (!this.moveOptions) return;
    const cam = this.camera;
    const r = this.tileRadius();
    this.moveOptions.forEach((option, index) => {
      const node = this.nodeById.get(option.nodeId);
      if (!node) return;
      const x = cam.screenX(node.x);
      const y = cam.screenY(node.y);
      if (x < -40 || x > cam.vw + 40 || y < -60 || y > cam.vh + 40) return;
      const selected = this.selectedOption === option.nodeId;
      const bob = Math.sin(now / 280 + index * 1.8) * 3;
      const my = y - r - 14 - bob;
      const size = selected ? 11 : 8;
      ctx.save();
      ctx.translate(x, my);
      ctx.fillStyle = 'rgba(22, 38, 64, 0.3)';
      ctx.beginPath();
      ctx.moveTo(0, size + 6);
      ctx.lineTo(size * 0.9, 4);
      ctx.lineTo(-size * 0.9, 4);
      ctx.closePath();
      ctx.fill();
      const grad = ctx.createLinearGradient(0, -size, 0, size);
      grad.addColorStop(0, '#fff8a8');
      grad.addColorStop(1, selected ? '#ffb703' : '#ffd83d');
      ctx.beginPath();
      ctx.moveTo(size * 1.15, -size * 0.45);
      ctx.lineTo(size * 0.25, -size * 0.9);
      ctx.lineTo(-size * 0.9, -size * 0.15);
      ctx.lineTo(0, size * 0.95);
      ctx.lineTo(size * 0.9, -size * 0.15);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.strokeStyle = '#26385f';
      ctx.lineWidth = 1.8;
      ctx.stroke();
      // pointer triangle
      ctx.beginPath();
      ctx.moveTo(-4, size * 0.7);
      ctx.lineTo(4, size * 0.7);
      ctx.lineTo(0, size + 7);
      ctx.closePath();
      ctx.fillStyle = selected ? '#ffb703' : '#ffd83d';
      ctx.fill();
      ctx.strokeStyle = '#26385f';
      ctx.lineWidth = 1.4;
      ctx.stroke();
      ctx.restore();
    });
  }

  private drawPathPreview(ctx: CanvasRenderingContext2D, option: MoveOption, selected: boolean): void {
    const currentId = this.state?.players[this.state.current]?.nodeId;
    const ids = currentId && option.path[0] !== currentId ? [currentId, ...option.path] : option.path;
    if (ids.length < 2) return;
    const cam = this.camera;
    const first = this.nodeById.get(ids[0]);
    if (!first) return;
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
    if (points.length < 2) return;
    const trace = (): void => {
      ctx.beginPath();
      ctx.moveTo(points[0][0], points[0][1]);
      for (let i = 1; i < points.length; i++) ctx.lineTo(points[i][0], points[i][1]);
    };
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    trace();
    ctx.strokeStyle = 'rgba(12, 34, 62, 0.55)';
    ctx.lineWidth = selected ? 10 : 8;
    ctx.stroke();
    trace();
    ctx.strokeStyle = selected ? 'rgba(255, 216, 61, 0.95)' : 'rgba(255, 255, 255, 0.85)';
    ctx.lineWidth = selected ? 6 : 4;
    ctx.stroke();
    if (selected) {
      trace();
      ctx.setLineDash([7, 8]);
      ctx.lineDashOffset = -performance.now() / 45;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.setLineDash([]);
    }
    const end = points[points.length - 1];
    ctx.fillStyle = selected ? '#ffd83d' : 'rgba(255,255,255,0.92)';
    ctx.beginPath();
    ctx.arc(end[0], end[1], selected ? 7 : 5, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = '#23385c';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();
  }

  private drawBadge(ctx: CanvasRenderingContext2D): void {
    this.badgeRect = null;
    if (!this.selectedOption) return;
    const node = this.nodeById.get(this.selectedOption);
    if (!node) return;
    const cam = this.camera;
    const x = cam.screenX(node.x);
    const y = cam.screenY(node.y);
    if (x < -80 || x > cam.vw + 80 || y < -80 || y > cam.vh + 80) return;
    const fs = 12;
    const font = `800 ${fs}px ${LABEL_FONT}`;
    const text = 'ここへ移動';
    const w = this.measureText(ctx, text, font) + 20;
    const h = 24;
    let bx = x - w / 2;
    let by = y - this.tokenHeight() - 14;
    if (by < 5) by = y + this.tileRadius() + 16;
    bx = Math.max(5, Math.min(cam.vw - w - 5, bx));
    const rect = { x: bx, y: by, w, h };
    this.badgeRect = rect;
    ctx.save();
    ctx.fillStyle = 'rgba(8, 28, 52, 0.32)';
    ctx.beginPath();
    ctx.roundRect(rect.x + 1, rect.y + 2.5, w, h, h / 2);
    ctx.fill();
    const grad = ctx.createLinearGradient(0, by, 0, by + h);
    grad.addColorStop(0, '#fff27a');
    grad.addColorStop(1, '#ffc21f');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.roundRect(rect.x, rect.y, w, h, h / 2);
    ctx.fill();
    ctx.strokeStyle = '#2a3b62';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#20315a';
    ctx.font = font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, rect.x + w / 2, rect.y + h / 2 + 0.5);
    ctx.restore();
  }

  // ---------------------------------------------------------------- tokens & emotes

  private computeLayouts(now: number): TokenLayout[] {
    const h = this.tokenHeight();
    const entries: TokenLayout[] = [];
    const idleEntries: TokenLayout[] = [];
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
    });

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
        if (!a || !b) continue;
        const dx = wrapDx(a.x, b.x);
        const mode = this.edgeModes.get(edgeKey(a.id, b.id)) ?? 'rail';
        const vehicle: VehicleKind =
          mode === 'sea' ? 'ferry' : move.dice >= 3 ? 'bullet_train' : move.dice === 2 ? 'express' : 'train';
        const prevNode = idx > 0 ? this.nodeById.get(full[idx - 1]) : null;
        const prevMode = prevNode ? this.edgeModes.get(edgeKey(prevNode.id, a.id)) ?? 'rail' : null;
        entries.push({
          ...base(token.playerId),
          x: this.camera.screenX(a.x + dx * frac),
          y: this.camera.screenY(a.y + (b.y - a.y) * frac),
          worldX: a.x + dx * frac,
          worldY: a.y + (b.y - a.y) * frac,
          idle: false,
          facing: Math.abs(dx) > 0.01 ? Math.sign(dx) : 1,
          moving: true,
          vehicle,
          stepFrac: frac,
          stepIndex: idx,
          switchPoof: prevMode !== null && prevMode !== mode && frac < 0.22,
          tilt: Math.max(-0.12, Math.min(0.12, Math.atan2(b.y - a.y, Math.abs(dx) < 0.01 ? 0.01 : dx) * 0.28)),
        });
        continue;
      }

      const warp = this.warpAnim;
      if (warp && warp.playerId === token.playerId) {
        const world = this.tokenWorldPosition(token.playerId, now);
        if (!world) continue;
        const from = this.nodeById.get(warp.fromNode);
        const to = this.nodeById.get(warp.toNode);
        const dx = from && to ? wrapDx(from.x, to.x) : 1;
        const vehicle: VehicleKind | null =
          warp.via === 'plane' ? 'plane' : warp.via === 'rocket' ? 'rocket' : warp.via === 'carpet' ? 'carpet' : null;
        entries.push({
          ...base(token.playerId),
          x: this.camera.screenX(world.x),
          y: this.camera.screenY(world.y),
          worldX: world.x,
          worldY: world.y,
          idle: false,
          facing: Math.abs(dx) > 0.01 ? Math.sign(dx) : 1,
          vehicle,
          warping: warp.via,
        });
        continue;
      }

      const node = this.nodeById.get(token.nodeId);
      if (!node) continue;
      const emote = this.emoteActive.get(token.playerId);
      const bob = !emote && this.state?.current === token.playerId ? Math.sin(now / 360) * 2.2 : 0;
      idleEntries.push({
        ...base(token.playerId),
        x: this.camera.screenX(node.x),
        y: this.camera.screenY(node.y) + bob,
        worldX: node.x,
        worldY: node.y,
        idle: true,
      });
    }

    // Fan out tokens that stand close together, not only exact same-node stacks,
    // so metro clusters (Tokyo/Yokohama etc.) stay readable.
    const used = new Set<number>();
    const clusterRadius = h * 0.56;
    for (let i = 0; i < idleEntries.length; i++) {
      if (used.has(i)) continue;
      const cluster = [i];
      used.add(i);
      for (let j = i + 1; j < idleEntries.length; j++) {
        if (used.has(j)) continue;
        const close = cluster.some((k) => {
          const a = idleEntries[k];
          const b = idleEntries[j];
          return Math.hypot(a.x - b.x, a.y - b.y) < clusterRadius;
        });
        if (close) {
          cluster.push(j);
          used.add(j);
        }
      }
      if (cluster.length <= 1) continue;
      cluster.sort((a, b) => idleEntries[a].x - idleEntries[b].x);
      const spacing = Math.min(64, Math.max(20, h * 0.72));
      for (let k = 0; k < cluster.length; k++) {
        const entry = idleEntries[cluster[k]];
        entry.fanX = (k - (cluster.length - 1) / 2) * spacing;
        entry.x += entry.fanX;
      }
    }
    entries.push(...idleEntries);
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
    if (this.reducedMotion || this.view !== 'world') return;
    const cam = this.camera;
    const eq = MAP_H * 0.52;
    const north = cam.y < eq;
    const season = north ? this.season : oppositeSeason(this.season);
    const fade = this.seasonTransitionStart > 0 ? Math.min(1, (now - this.seasonTransitionStart) / 1000) : 1;
    ctx.save();
    ctx.globalAlpha = Math.max(0.2, fade);
    for (let i = 0; i < 26; i++) {
      const seed = hashString(`${this.month}-${i}`);
      const x = ((seed % 1000) / 1000) * cam.vw + Math.sin(now / 2400 + i) * 16;
      const y = ((now / (season === 'winter' ? 90 : 140) + (seed % 700)) % (cam.vh + 80)) - 40;
      if (season === 'spring') {
        ctx.fillStyle = i % 3 === 0 ? '#ffd1e4' : '#ff9fc4';
        ctx.beginPath();
        ctx.ellipse(x, y, 4, 2.2, Math.sin(now / 600 + i), 0, TAU);
        ctx.fill();
      } else if (season === 'autumn') {
        ctx.fillStyle = i % 2 === 0 ? '#e08a2e' : '#d05a2b';
        ctx.beginPath();
        ctx.ellipse(x, y, 4.5, 2.4, Math.sin(now / 500 + i), 0, TAU);
        ctx.fill();
      } else if (season === 'summer') {
        ctx.globalAlpha = fade * (0.35 + 0.35 * Math.abs(Math.sin(now / 500 + i)));
        ctx.fillStyle = '#fff3a0';
        ctx.beginPath();
        ctx.arc(x, y, 1.8, 0, TAU);
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
    const badge = this.badgeRect;
    const city = option ? null : this.hitCity(x, y);
    this.canvas.style.cursor = option || (badge && insideRect(x, y, badge)) ? 'pointer' : city ? 'pointer' : 'grab';
  }

  private handleTap(x: number, y: number): void {
    const now = performance.now();
    if (now < this.suppressTapUntil) {
      this.lastTap = null;
      return;
    }
    if (this.badgeRect && insideRect(x, y, this.badgeRect) && this.selectedOption) {
      this.confirmOption(this.selectedOption);
      this.lastTap = null;
      return;
    }
    const option = this.hitOption(x, y);
    if (option) {
      if (this.selectedOption === option.nodeId) this.confirmOption(option.nodeId);
      else {
        this.selectedOption = option.nodeId;
        this.hoveredOption = option.nodeId;
        this.requestRender();
      }
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
      this.requestRender();
    }
    // Double-tap zooms around the tapped world point. Single taps only clear selection.
    if (this.lastTap && now - this.lastTap.at < 330 && Math.hypot(x - this.lastTap.x, y - this.lastTap.y) < 28) {
      this.lastTap = null;
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
    const radius = Math.max(18, this.tileRadius() + 10);
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
    this.movePick?.(nodeId);
  }
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
