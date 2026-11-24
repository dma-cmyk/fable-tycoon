// Edge-mode rules shared by the board renderer: how a lane is drawn and which
// vehicle carries a token along it. Pure, so vitest can pin them without a canvas.

export type RouteMode = 'rail' | 'sea' | 'air';

/** Vehicles a token can use while walking one edge. */
export type StepVehicle = 'train' | 'express' | 'bullet_train' | 'ferry' | 'plane';

/** Normalise a board edge mode; unknown modes fall back to rail. */
export function routeModeOf(mode: string): RouteMode {
  return mode === 'sea' ? 'sea' : mode === 'air' ? 'air' : 'rail';
}

export interface LaneArc {
  /** Quadratic control point. */
  qx: number;
  qy: number;
}

/**
 * Control point of a sky lane. The lane bows to a fixed side of the chord so
 * outbound and inbound flights never overlap, and the bow is capped so short
 * hops stay almost straight.
 */
export function airLaneControl(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  bendRatio = 0.16,
  maxBend = Number.POSITIVE_INFINITY,
): LaneArc {
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy) || 1;
  const bend = Math.min(len * bendRatio, maxBend);
  return { qx: (ax + bx) / 2 - (dy / len) * bend, qy: (ay + by) / 2 + (dx / len) * bend };
}

export interface LanePoint {
  x: number;
  y: number;
  /** Unit tangent along the lane. */
  hx: number;
  hy: number;
}

/** Point and unit tangent at `t` along a quadratic lane. */
export function lanePointAt(
  t: number,
  ax: number,
  ay: number,
  qx: number,
  qy: number,
  bx: number,
  by: number,
): LanePoint {
  const k = 1 - t;
  const x = k * k * ax + 2 * k * t * qx + t * t * bx;
  const y = k * k * ay + 2 * k * t * qy + t * t * by;
  const tx = 2 * k * (qx - ax) + 2 * t * (bx - qx);
  const ty = 2 * k * (qy - ay) + 2 * t * (by - qy);
  const len = Math.hypot(tx, ty) || 1;
  return { x, y, hx: tx / len, hy: ty / len };
}

/** Vehicle used on one step; air steps always fly, sea steps always sail. */
export function vehicleForStep(mode: RouteMode, dice: number): StepVehicle {
  if (mode === 'air') return 'plane';
  if (mode === 'sea') return 'ferry';
  return dice >= 3 ? 'bullet_train' : dice === 2 ? 'express' : 'train';
}
export interface GraphEdge {
  a: string;
  b: string;
}

/**
 * Hop distance from `start` to every reachable node, walking board edges
 * undirected. Unreachable nodes are absent from the map (no Infinity values).
 */
export function hopDistances(start: string, edges: readonly GraphEdge[]): Map<string, number> {
  return multiSourceHopDistances([start], edges);
}

/**
 * Hop distance to the nearest of several starts (e.g. every realm exit).
 * Unreachable nodes are absent from the map.
 */
export function multiSourceHopDistances(
  starts: readonly string[],
  edges: readonly GraphEdge[],
): Map<string, number> {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.a === edge.b) continue;
    const fromA = adjacency.get(edge.a);
    if (fromA) fromA.push(edge.b);
    else adjacency.set(edge.a, [edge.b]);
    const fromB = adjacency.get(edge.b);
    if (fromB) fromB.push(edge.a);
    else adjacency.set(edge.b, [edge.a]);
  }
  const distances = new Map<string, number>();
  const queue: string[] = [];
  for (const start of starts) {
    if (distances.has(start)) continue;
    distances.set(start, 0);
    queue.push(start);
  }
  for (let head = 0; head < queue.length; head++) {
    const id = queue[head];
    const distance = distances.get(id) ?? 0;
    for (const next of adjacency.get(id) ?? []) {
      if (distances.has(next)) continue;
      distances.set(next, distance + 1);
      queue.push(next);
    }
  }
  return distances;
}

/**
 * Candidate heading toward the destination: fewest remaining hops wins, and a
 * station breaks a tie (it is the more useful landing square).
 */
export function chooseRecommended<T extends { id: string; kind: string }>(
  candidates: readonly T[],
  distances: ReadonlyMap<string, number>,
): T | null {
  let best: T | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  let bestStation = false;
  for (const candidate of candidates) {
    const distance = distances.get(candidate.id);
    if (distance === undefined) continue;
    const station = candidate.kind === 'city';
    if (distance < bestDistance || (distance === bestDistance && station && !bestStation)) {
      best = candidate;
      bestDistance = distance;
      bestStation = station;
    }
  }
  return best;
}

/** Where a move should head, resolved from the acting player's own board. */
export interface MoveTarget {
  target: 'destination' | 'exit';
  /** Realm whose exits are the goal; null for the world board. */
  realm: string | null;
  /** World destination node id; only set when `target === 'destination'`. */
  destinationNodeId: string | null;
}

/**
 * Resolve the move goal from the acting player's board rather than from the
 * board currently on screen. A player standing in heaven/hell/space heads for
 * that realm's exits even while the camera shows the world (and vice versa).
 */
export function resolveMoveTarget(
  playerRealm: string | null | undefined,
  destinationNodeId: string | null | undefined,
): MoveTarget | null {
  if (playerRealm) return { target: 'exit', realm: playerRealm, destinationNodeId: null };
  if (!destinationNodeId) return null;
  return { target: 'destination', realm: null, destinationNodeId };
}
