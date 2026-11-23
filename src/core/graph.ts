// Board adjacency, cached BFS distances, and dice-reachable node enumeration.
//
// Movement rule (DESIGN §2.1):
//  - exactly `steps` edges are taken, except that the destination city truncates the path
//    as soon as it is passed / reached.
//  - an edge may not be traversed back immediately, unless the current node is a dead end.
//  - `prevNodeId` (the square the player just came from) is treated as the previous node for
//    the first step, so a player cannot immediately step back where they came from.

import type { BoardEdge, BoardNode, GameData, MoveOption } from './types';

export interface Neighbour {
  id: string;
  mode: 'rail' | 'sea';
}

export interface Graph {
  nodes: Map<string, BoardNode>;
  adj: Map<string, Neighbour[]>;
  /** cityId -> board node id ("c:<cityId>") */
  cityNode: Map<string, string>;
  /** Origin-keyed BFS cache. Cleared only when the backing GameData object is replaced. */
  distances: Map<string, Map<string, number>>;
}

const graphs = new WeakMap<GameData, Graph>();

export function getGraph(data: GameData): Graph {
  const cached = graphs.get(data);
  if (cached) return cached;

  const nodes = new Map<string, BoardNode>();
  for (const n of data.board.nodes) nodes.set(n.id, n);

  const adj = new Map<string, Neighbour[]>();
  for (const n of data.board.nodes) adj.set(n.id, []);
  const addEdge = (e: BoardEdge): void => {
    const a = adj.get(e.a);
    const b = adj.get(e.b);
    if (!a || !b) {
      // Dangling edges are a data bug; ignore them rather than making the map unusable.
      return;
    }
    a.push({ id: e.b, mode: e.mode });
    b.push({ id: e.a, mode: e.mode });
  };
  for (const e of data.board.edges) addEdge(e);

  const cityNode = new Map<string, string>();
  for (const n of data.board.nodes) {
    if (n.kind === 'city' && n.cityId) cityNode.set(n.cityId, n.id);
  }

  const graph: Graph = { nodes, adj, cityNode, distances: new Map() };
  graphs.set(data, graph);
  return graph;
}

/** BFS distances from one origin (cached inside the Graph). */
export function distancesFrom(data: GameData, fromNodeId: string): Map<string, number> {
  const graph = getGraph(data);
  const cached = graph.distances.get(fromNodeId);
  if (cached) return cached;
  if (!graph.nodes.has(fromNodeId)) throw new Error(`unknown board node: ${fromNodeId}`);

  const dist = new Map<string, number>();
  dist.set(fromNodeId, 0);
  const queue: string[] = [fromNodeId];
  for (let head = 0; head < queue.length; head += 1) {
    const cur = queue[head];
    const d = dist.get(cur) as number;
    for (const nb of graph.adj.get(cur) ?? []) {
      if (dist.has(nb.id)) continue;
      dist.set(nb.id, d + 1);
      queue.push(nb.id);
    }
  }
  graph.distances.set(fromNodeId, dist);
  return dist;
}

/** Shortest number of edges; Infinity when disconnected. */
export function shortestDistance(data: GameData, fromNodeId: string, toNodeId: string): number {
  if (fromNodeId === toNodeId) return 0;
  return distancesFrom(data, fromNodeId).get(toNodeId) ?? Infinity;
}

/**
 * All distinct endpoint nodes reachable in exactly `steps` edges under the movement rules,
 * with one concrete path each. If `stopNodeId` or an extra stop (portal) is passed, the path is
 * truncated there and that node is returned as an option instead of continuing on.
 */
export function reachableInExactly(
  data: GameData,
  startNodeId: string,
  steps: number,
  prevNodeId: string | null = null,
  stopNodeId: string | null = null,
  extraStopNodeIds: ReadonlySet<string> | null = null,
): MoveOption[] {
  const graph = getGraph(data);
  if (!graph.nodes.has(startNodeId)) return [];
  if (steps <= 0) return [];

  interface Walker {
    node: string;
    prev: string | null;
    path: string[];
  }

  const found = new Map<string, MoveOption>();
  let layer: Walker[] = [{ node: startNodeId, prev: prevNodeId, path: [] }];

  for (let depth = 1; depth <= steps; depth += 1) {
    const next = new Map<string, Walker>();
    for (const walker of layer) {
      const neighbours = graph.adj.get(walker.node) ?? [];
      const uniqueNeighbours = new Set(neighbours.map((nb) => nb.id));
      const deadEnd = uniqueNeighbours.size <= 1;
      for (const nb of neighbours) {
        if (!deadEnd && nb.id === walker.prev) continue;
        const path = [...walker.path, nb.id];
        const destinationStop =
          stopNodeId !== null && nb.id === stopNodeId && stopNodeId !== startNodeId;
        const portalStop = extraStopNodeIds !== null && extraStopNodeIds.has(nb.id);
        // The destination claims movement the moment it is reached (including passing).
        if (destinationStop || portalStop) {
          if (!found.has(nb.id)) found.set(nb.id, { nodeId: nb.id, path });
          continue;
        }
        if (depth === steps) {
          if (!found.has(nb.id)) found.set(nb.id, { nodeId: nb.id, path });
          continue;
        }
        const key = `${nb.id}|${walker.node}`;
        if (!next.has(key)) next.set(key, { node: nb.id, prev: walker.node, path });
      }
    }
    layer = [...next.values()];
    if (layer.length === 0) break;
  }

  return [...found.values()].sort((a, b) =>
    a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0,
  );
}

/** True when the node belongs to a port city or is adjacent to at least one sea edge. */
export function isPortOrAdjacentSea(data: GameData, nodeId: string): boolean {
  const graph = getGraph(data);
  const node = graph.nodes.get(nodeId);
  if (!node) return false;
  if (node.kind === 'city' && node.cityId) {
    const city = data.cities.find((c) => c.id === node.cityId);
    if (city?.port) return true;
  }
  return (graph.adj.get(nodeId) ?? []).some((nb) => nb.mode === 'sea');
}

/** Board node id for a city id, or null. */
export function nodeForCity(data: GameData, cityId: string): string | null {
  return getGraph(data).cityNode.get(cityId) ?? null;
}