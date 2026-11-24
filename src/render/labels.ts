// Camera-independent label placement and flicker-free visibility.
//
// Placement runs on static board geometry only (marker discs, rail/sea tracks,
// already-claimed boxes) in world units, so a label keeps the same offset from
// its anchor while the camera pans, tokens walk, or HUD panels open. Dynamic
// occlusion never relocates a label; it only fades it out through `LabelFade`.
//
// DOM-free on purpose: vitest pins the stability invariants here.

import { RectGrid } from './grid';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LabelSlot {
  /** Offset of the label box centre from the anchor, world units. */
  dx: number;
  dy: number;
}

export interface LabelItem {
  id: string;
  /** Anchor in world coordinates. */
  x: number;
  y: number;
  /** Box size in world units (px size divided by the bucket zoom). */
  w: number;
  h: number;
  /** Candidate offsets, in preference order. */
  slots: ReadonlyArray<LabelSlot>;
  /** Radius of the marker the label hangs off; kept clear by every slot. */
  disc: number;
}

export interface SceneDisc {
  x: number;
  y: number;
  r: number;
}

export interface SceneSegment {
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

export interface PlacementScene {
  worldW: number;
  wrap: boolean;
  /** Boxes claimed by an earlier pass (map-art terrain names). */
  occupied: ReadonlyArray<Rect>;
  /** Static marker discs: city pedestals, every non-city square, landmark towns. */
  discs: ReadonlyArray<SceneDisc>;
  /** Static rail/sea segments. */
  segments: ReadonlyArray<SceneSegment>;
  /** Padding kept around every blocker, world units. */
  clearance: number;
  /** Only blockers this close to an anchor are considered for it, world units. */
  reach?: number;
}

/** Chosen slot per item id; `-1` means no collision-free slot at this zoom bucket. */
export type SlotChoice = Map<string, number>;

export function rectsOverlap(a: Rect, b: Rect, pad = 0): boolean {
  return a.x - pad < b.x + b.w && a.x + a.w + pad > b.x && a.y - pad < b.y + b.h && a.y + a.h + pad > b.y;
}

export function rectHitsDisc(rect: Rect, cx: number, cy: number, r: number): boolean {
  const nx = Math.max(rect.x, Math.min(cx, rect.x + rect.w));
  const ny = Math.max(rect.y, Math.min(cy, rect.y + rect.h));
  return Math.hypot(nx - cx, ny - cy) < r;
}

function orient(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

function segmentsCross(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): boolean {
  const o1 = orient(ax, ay, bx, by, cx, cy);
  const o2 = orient(ax, ay, bx, by, dx, dy);
  const o3 = orient(cx, cy, dx, dy, ax, ay);
  const o4 = orient(cx, cy, dx, dy, bx, by);
  return (o1 > 0) !== (o2 > 0) && (o3 > 0) !== (o4 > 0);
}

/**
 * Exact segment/rect overlap: a straight lane touches the box only if an
 * endpoint is inside or it crosses one of the four edges. O(1) per test, which
 * matters because every label slot is checked against many lanes.
 */
export function segmentHitsRect(seg: SceneSegment, rect: Rect, pad = 0): boolean {
  const minX = rect.x - pad;
  const maxX = rect.x + rect.w + pad;
  const minY = rect.y - pad;
  const maxY = rect.y + rect.h + pad;
  const x1 = seg.ax;
  const y1 = seg.ay;
  const x2 = seg.bx;
  const y2 = seg.by;
  if (Math.max(x1, x2) < minX || Math.min(x1, x2) > maxX) return false;
  if (Math.max(y1, y2) < minY || Math.min(y1, y2) > maxY) return false;
  if ((x1 >= minX && x1 <= maxX && y1 >= minY && y1 <= maxY)
    || (x2 >= minX && x2 <= maxX && y2 >= minY && y2 <= maxY)) return true;
  return segmentsCross(x1, y1, x2, y2, minX, minY, maxX, minY)
    || segmentsCross(x1, y1, x2, y2, maxX, minY, maxX, maxY)
    || segmentsCross(x1, y1, x2, y2, maxX, maxY, minX, maxY)
    || segmentsCross(x1, y1, x2, y2, minX, maxY, minX, minY);
}

/** Nearest wrapped copy of `x` to `around` on the torus. */
export function wrapNear(around: number, x: number, worldW: number): number {
  if (worldW <= 0) return x;
  return x + Math.round((around - x) / worldW) * worldW;
}

/**
 * Greedy, order-stable placement in world space.
 *
 * The same items + scene always produce the same slots, no matter where the
 * camera is or which tokens are walking. Items are placed in the order given;
 * callers pass them sorted by static priority (tier, then id). Every blocker
 * lookup goes through a coarse grid so a bucket rebuild stays in the low
 * milliseconds even with hundreds of labels.
 */
export function placeLabels(scene: PlacementScene, items: readonly LabelItem[]): SlotChoice {
  const out: SlotChoice = new Map();
  const maxReach = scene.reach ?? 640;
  const pad = scene.clearance;
  const cell = Math.max(64, Math.min(256, maxReach / 3));
  const discGrid = new RectGrid<SceneDisc>(cell);
  const segmentGrid = new RectGrid<SceneSegment>(cell);
  const shifts = scene.wrap ? [-scene.worldW, 0, scene.worldW] : [0];

  // Placed boxes live in a plain cell map: checking a slot must not allocate,
  // and duplicates across cells are harmless for an overlap test.
  const placedCells = new Map<number, Rect[]>();
  const cellKey = (cx: number, cy: number): number => (cx + 4096) * 16384 + (cy + 4096);
  const cellSpan = (r: Rect): [number, number, number, number] => [
    Math.floor(r.x / cell),
    Math.floor((r.x + r.w) / cell),
    Math.floor(r.y / cell),
    Math.floor((r.y + r.h) / cell),
  ];
  const addPlaced = (r: Rect): void => {
    const [x0, x1, y0, y1] = cellSpan(r);
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        const key = cellKey(cx, cy);
        const bucket = placedCells.get(key);
        if (bucket) bucket.push(r);
        else placedCells.set(key, [r]);
      }
    }
  };
  const hitsPlaced = (r: Rect): boolean => {
    const [x0, x1, y0, y1] = cellSpan(r);
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        const bucket = placedCells.get(cellKey(cx, cy));
        if (!bucket) continue;
        for (const p of bucket) {
          if (rectsOverlap(r, p, pad)) return true;
        }
      }
    }
    return false;
  };

  for (const d of scene.discs) {
    discGrid.add({ x: d.x - d.r, y: d.y - d.r, w: d.r * 2, h: d.r * 2 }, d);
  }
  // Segments are indexed by their midpoint; long hops are rare enough that
  // the reach window still catches every lane a label box can touch.
  for (const s of scene.segments) {
    const mx = (s.ax + s.bx) / 2;
    const my = (s.ay + s.by) / 2;
    segmentGrid.add({ x: mx, y: my, w: 0.5, h: 0.5 }, s);
  }

  for (const item of items) {
    // Blockers farther than the farthest slot plus half the box diagonal can
    // never touch this label; a tight window keeps the search cheap.
    let maxSlot = 0;
    for (const slot of item.slots) maxSlot = Math.max(maxSlot, Math.hypot(slot.dx, slot.dy));
    const reach = Math.min(maxReach, (Math.hypot(item.w, item.h)) / 2 + maxSlot + pad + 24);
    const region = { x: item.x - reach, y: item.y - reach, w: reach * 2, h: reach * 2 };
    const nearDiscs: SceneDisc[] = [];
    const seenDiscs = new Set<SceneDisc>();
    for (const shift of shifts) {
      for (const d of discGrid.queryRect(shift === 0 ? region : { ...region, x: region.x + shift })) {
        if (seenDiscs.has(d)) continue;
        seenDiscs.add(d);
        const dx = wrapNear(item.x, d.x, scene.worldW) - item.x;
        if (Math.abs(dx) > reach) continue;
        nearDiscs.push({ x: item.x + dx, y: d.y, r: d.r + pad });
      }
    }
    const nearSegments: SceneSegment[] = [];
    const seenSegments = new Set<SceneSegment>();
    for (const shift of shifts) {
      for (const s of segmentGrid.queryRect(shift === 0 ? region : { ...region, x: region.x + shift })) {
        if (seenSegments.has(s)) continue;
        seenSegments.add(s);
        const ax = wrapNear(item.x, s.ax, scene.worldW);
        const bx = ax + (s.bx - s.ax);
        if (Math.abs((ax + bx) / 2 - item.x) > reach) continue;
        nearSegments.push({ ax, ay: s.ay, bx, by: s.by });
      }
    }
    const nearOccupied: Rect[] = [];
    for (const o of scene.occupied) {
      const x = wrapNear(item.x, o.x + o.w / 2, scene.worldW) - o.w / 2;
      if (Math.abs(x + o.w / 2 - item.x) > reach) continue;
      nearOccupied.push({ x, y: o.y, w: o.w, h: o.h });
    }

    let chosen = -1;
    for (let i = 0; i < item.slots.length && chosen < 0; i++) {
      const slot = item.slots[i];
      const cx = item.x + slot.dx;
      const cy = item.y + slot.dy;
      const rect: Rect = { x: cx - item.w / 2, y: cy - item.h / 2, w: item.w, h: item.h };
      // The anchor itself is only an obstacle when the item owns a marker disc.
      if (item.disc > 0 && rectHitsDisc(rect, item.x, item.y, item.disc + pad)) continue;
      let blocked = false;
      for (const o of nearOccupied) {
        if (rectsOverlap(rect, o, pad)) {
          blocked = true;
          break;
        }
      }
      if (!blocked) {
        for (const d of nearDiscs) {
          if (rectHitsDisc(rect, d.x, d.y, d.r)) {
            blocked = true;
            break;
          }
        }
      }
      if (!blocked) {
        for (const s of nearSegments) {
          if (segmentHitsRect(s, rect, pad)) {
            blocked = true;
            break;
          }
        }
      }
      if (!blocked) {
        for (const shift of shifts) {
          const probe: Rect = shift === 0 ? rect : { x: rect.x + shift, y: rect.y, w: rect.w, h: rect.h };
          if (hitsPlaced(probe)) {
            blocked = true;
            break;
          }
        }
      }
      if (blocked) continue;
      chosen = i;
      addPlaced(rect);
    }
    out.set(item.id, chosen);
  }
  return out;
}

const BUCKET_STEP = Math.log(1.16);

/** Integer zoom bucket; label layouts are cached per bucket. */
export function zoomBucket(zoom: number): number {
  if (!Number.isFinite(zoom) || zoom <= 0) return 0;
  return Math.round(Math.log(zoom) / BUCKET_STEP);
}

/** Reference zoom used to size boxes while placing for `bucket`. */
export function bucketZoom(bucket: number): number {
  return Math.exp(bucket * BUCKET_STEP);
}

interface FadeState {
  on: boolean;
  alpha: number;
  /** Timestamp when the desired state first differed, or null when settled. */
  pendingSince: number | null;
  last: number;
}

/**
 * Fade + hold latch per label.
 *
 * A state flip only takes effect once the new desired state has persisted for
 * `holdMs`, so a token sweeping past a label cannot make it blink: the label
 * keeps its current visibility (and position) until the occlusion is settled.
 * The committed flip then fades over `fadeMs`.
 */
export class LabelFade {
  private readonly state = new Map<string, FadeState>();

  constructor(
    private readonly holdMs = 300,
    private readonly fadeMs = 160,
  ) {}

  update(id: string, show: boolean, now: number): number {
    const stamp = Number.isFinite(now) ? now : 0;
    let s = this.state.get(id);
    if (!s) {
      s = { on: show, alpha: show ? 1 : 0, pendingSince: null, last: stamp };
      this.state.set(id, s);
      return s.alpha;
    }
    if (show === s.on) {
      s.pendingSince = null;
    } else if (s.pendingSince === null) {
      s.pendingSince = stamp;
    } else if (stamp - s.pendingSince >= this.holdMs) {
      s.on = show;
      s.pendingSince = null;
    }
    const target = s.on ? 1 : 0;
    if (s.alpha !== target) {
      const step = this.fadeMs <= 0 ? 1 : Math.min(1, Math.max(0, stamp - s.last) / this.fadeMs);
      s.alpha = s.alpha < target ? Math.min(target, s.alpha + step) : Math.max(target, s.alpha - step);
    }
    s.last = stamp;
    return s.alpha;
  }

  forget(id: string): void {
    this.state.delete(id);
  }

  /** Drop latches for labels that no longer exist in this view. */
  pruneAlive(alive: ReadonlySet<string>): void {
    for (const id of [...this.state.keys()]) {
      if (!alive.has(id)) this.state.delete(id);
    }
  }
}
export interface SlotOffset {
  dx: number;
  dy: number;
}

/**
 * First slot whose box is inside the board and clear of every blocker.
 *
 * Priority city labels use this to step aside from chrome, token stacks and
 * candidate discs without inventing new positions: the candidate list stays
 * the same static set, only the order changes.
 */
export function pickFreeSlot(
  anchorX: number,
  anchorY: number,
  w: number,
  h: number,
  slots: readonly SlotOffset[],
  blocked: readonly Rect[],
  inside: (rect: Rect) => boolean = () => true,
  pad = 2,
): SlotOffset | null {
  for (const slot of slots) {
    const rect: Rect = { x: anchorX + slot.dx - w / 2, y: anchorY + slot.dy - h / 2, w, h };
    if (!inside(rect)) continue;
    let hit = false;
    for (const b of blocked) {
      if (rectsOverlap(rect, b, pad)) {
        hit = true;
        break;
      }
    }
    if (!hit) return slot;
  }
  return null;
}

/**
 * Push badges apart along one edge so none of them overlap.
 *
 * Input positions are clamped into `[min, max]`, sorted ascending, then pushed
 * forward monotonically with at least `gap` between neighbours. The sweep runs
 * both ways so the last badge also respects the upper bound.
 */
export function spreadBadges(positions: readonly number[], gap: number, min: number, max: number): number[] {
  if (positions.length === 0) return [];
  const sorted = positions.map((p) => Math.min(max, Math.max(min, p))).sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - sorted[i - 1] < gap) sorted[i] = sorted[i - 1] + gap;
  }
  if (sorted[sorted.length - 1] > max) {
    sorted[sorted.length - 1] = Math.max(min, max);
    for (let i = sorted.length - 2; i >= 0; i--) {
      if (sorted[i + 1] - sorted[i] < gap) sorted[i] = sorted[i + 1] - gap;
    }
  }
  // Not enough room for the requested gap: distribute evenly instead, so the
  // badges stay ordered and distinct rather than piling up at the origin.
  if (sorted[0] < min) {
    const span = Math.max(0, max - min);
    for (let i = 0; i < sorted.length; i += 1) {
      sorted[i] = min + (sorted.length === 1 ? 0 : (span * i) / (sorted.length - 1));
    }
  }
  return sorted;
}

export interface SpotlightHole {
  x: number;
  y: number;
  r: number;
}

/**
 * Circles that must stay lit: the actor plus every candidate square. They are
 * punched into a mask with `destination-out`, so overlaps are a harmless union
 * (a winding-count path would re-darken the intersection).
 */
export function spotlightHoles(
  current: { x: number; y: number } | null,
  candidates: ReadonlyArray<{ x: number; y: number }>,
  actorRadius: number,
  candidateRadius: number,
): SpotlightHole[] {
  const holes: SpotlightHole[] = [];
  if (current) holes.push({ x: current.x, y: current.y, r: actorRadius });
  for (const candidate of candidates) holes.push({ x: candidate.x, y: candidate.y, r: candidateRadius });
  return holes;
}
