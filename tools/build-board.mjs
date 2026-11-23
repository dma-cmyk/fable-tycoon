#!/usr/bin/env node
/**
 * build-board.mjs — generates src/data/board.json and public/assets/map/land.json.
 *
 * Run: node tools/build-board.mjs
 *
 * Projection: THIS BLOCK MUST STAY IN SYNC WITH src/core/geo.ts (Miller cylindrical,
 * horizontally wrapping world, seam at lon -169). Do not "improve" one without the other.
 * The board is a city graph: Delaunay neighbours, edges classified as rail (land) or
 * sea (water + ports), intermediate squares inserted along each edge.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Delaunay } from 'd3-delaunay';
import { feature } from 'topojson-client';
import { geoContains } from 'd3-geo';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CITY_PATH = join(ROOT, 'src/data/cities.json');
const BOARD_PATH = join(ROOT, 'src/data/board.json');
const LAND_PATH = join(ROOT, 'public/assets/map/land.json');

// ------------------------------------------------------------------ projection
// Copied from src/core/geo.ts. If you change these, change geo.ts and this block.
const CENTRAL_MERIDIAN = 11;
const MAP_W = 4096;
const LAT_TOP = 80;
const LAT_BOTTOM = -56;
const millerY = (latDeg) => {
  const phi = (latDeg * Math.PI) / 180;
  return 1.25 * Math.log(Math.tan(Math.PI / 4 + 0.4 * phi));
};
const Y_TOP = millerY(LAT_TOP);
const Y_BOTTOM = millerY(LAT_BOTTOM);
const SCALE = MAP_W / (2 * Math.PI);
const MAP_H = Math.round((Y_TOP - Y_BOTTOM) * SCALE);

function project(lon, lat) {
  let rel = lon - CENTRAL_MERIDIAN;
  rel = (((rel + 180) % 360) + 360) % 360 - 180;
  const x = ((rel + 180) / 360) * MAP_W;
  const y = (Y_TOP - millerY(Math.max(LAT_BOTTOM, Math.min(LAT_TOP, lat)))) * SCALE;
  return [x, y];
}
function wrapDx(ax, bx) {
  let dx = bx - ax;
  if (dx > MAP_W / 2) dx -= MAP_W;
  if (dx <= -MAP_W / 2) dx += MAP_W;
  return dx;
}
function wrapX(x) {
  return ((x % MAP_W) + MAP_W) % MAP_W;
}
function unproject(x, y) {
  const rel = (wrapX(x) / MAP_W) * 360 - 180;
  const lon = (((rel + CENTRAL_MERIDIAN + 180) % 360) + 360) % 360 - 180;
  const m = Y_TOP - y / SCALE;
  const lat = ((Math.atan(Math.exp(m / 1.25)) - Math.PI / 4) / 0.4) * (180 / Math.PI);
  return [lon, Math.max(LAT_BOTTOM, Math.min(LAT_TOP, lat))];
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const round1 = (v) => Math.round(v * 10) / 10;
const roundHalf = (v) => Math.round(v * 2) / 2;

// ------------------------------------------------------------------ deterministic rng
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------------ land data
const topo = JSON.parse(readFileSync(join(ROOT, 'node_modules/world-atlas/land-50m.json'), 'utf8'));
const landFC = feature(topo, topo.objects.land);

/** Split the land FeatureCollection into one Polygon feature per polygon. */
function splitLandPolygons(fc) {
  const out = [];
  for (const f of fc.features) {
    const g = f.geometry;
    const list = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
    for (const coordinates of list) {
      let maxLat = -90;
      for (const ring of coordinates) for (const [, lat] of ring) maxLat = Math.max(maxLat, lat);
      if (maxLat < -57) continue; // Antarctica is outside the playable map frame.
      out.push({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates } });
    }
  }
  return out;
}
const sourcePolygons = splitLandPolygons(landFC);

/** Project a ring, keeping x continuous across the seam. */
function projectRing(ring) {
  const out = [];
  for (let i = 0; i < ring.length; i++) {
    const [px, py] = project(ring[i][0], ring[i][1]);
    if (i === 0) out.push([px, py]);
    else {
      const prev = out[out.length - 1];
      out.push([prev[0] + wrapDx(wrapX(prev[0]), px), py]);
    }
  }
  return out;
}

// Spatial index over projected polygon bounding boxes so land checks are fast
// while still using d3-geo's spherical geoContains for the actual test.
const GRID = 256;
const GRID_COLS = Math.ceil(MAP_W / GRID);
const GRID_ROWS = Math.ceil(MAP_H / GRID);
const landIndex = new Map(); // cell -> Set<polyIndex>
const landBoxes = [];

function cellRange(lo, hi, max) {
  const a = clamp(Math.floor(lo / GRID), 0, max - 1);
  const b = clamp(Math.floor(hi / GRID), 0, max - 1);
  return [a, b];
}
for (let pi = 0; pi < sourcePolygons.length; pi++) {
  const outer = projectRing(sourcePolygons[pi].geometry.coordinates[0]);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of outer) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  const copies = [];
  for (const k of [-1, 0, 1]) {
    const x0 = minX + k * MAP_W;
    const x1 = maxX + k * MAP_W;
    if (x1 < 0 || x0 > MAP_W) continue;
    copies.push([Math.max(0, x0), Math.min(MAP_W, x1), minY, maxY]);
  }
  landBoxes.push(copies);
  for (const [x0, x1, y0, y1] of copies) {
    const [cx0, cx1] = cellRange(x0, x1, GRID_COLS);
    const [cy0, cy1] = cellRange(y0, y1, GRID_ROWS);
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const key = cy * GRID_COLS + cx;
        let set = landIndex.get(key);
        if (!set) landIndex.set(key, (set = new Set()));
        set.add(pi);
      }
    }
  }
}

const landCache = new Map();
function isLand(lon, lat) {
  const cacheKey = `${Math.round(lon * 40)},${Math.round(lat * 40)}`;
  const cached = landCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const [x, y] = project(lon, lat);
  if (y < 0 || y > MAP_H) return false;
  const cx = clamp(Math.floor(wrapX(x) / GRID), 0, GRID_COLS - 1);
  const cy = clamp(Math.floor(y / GRID), 0, GRID_ROWS - 1);
  const candidates = landIndex.get(cy * GRID_COLS + cx);
  let result = false;
  if (candidates) {
    for (const pi of candidates) {
      let inBox = false;
      for (const [x0, x1, y0, y1] of landBoxes[pi]) {
        if (x >= x0 && x <= x1 && y >= y0 && y <= y1) { inBox = true; break; }
      }
      if (!inBox) continue;
      if (geoContains(sourcePolygons[pi], [lon, lat])) { result = true; break; }
    }
  }
  landCache.set(cacheKey, result);
  return result;
}
function isLandAt(x, y) {
  const [lon, lat] = unproject(x, y);
  return isLand(lon, lat);
}

// Sanity check the fast index against the whole-land spherical test.
let indexMismatch = 0;
for (let i = 0; i < 120; i++) {
  const lon = -180 + ((i * 137.508) % 360);
  const lat = -55 + ((i * 47.13) % 135);
  if (isLand(lon, lat) !== geoContains(landFC, [lon, lat])) indexMismatch++;
}
if (indexMismatch > 0) {
  throw new Error(`land index mismatch on ${indexMismatch}/120 sample points`);
}

// ------------------------------------------------------------------ cities
const cities = JSON.parse(readFileSync(CITY_PATH, 'utf8'));
if (!Array.isArray(cities) || cities.length === 0) throw new Error('cities.json is empty');
const projected = cities.map((c) => project(c.lon, c.lat));
const cityIndex = new Map(cities.map((c, i) => [c.id, i]));

// ------------------------------------------------------------------ Delaunay
const points = [];
const owners = [];
for (let i = 0; i < cities.length; i++) {
  for (const k of [-1, 0, 1]) {
    points.push([projected[i][0] + k * MAP_W, projected[i][1]]);
    owners.push(i);
  }
}
const triangulation = Delaunay.from(points);
const pairMap = new Map();
for (let t = 0; t < triangulation.triangles.length; t += 3) {
  const a = owners[triangulation.triangles[t]];
  const b = owners[triangulation.triangles[t + 1]];
  const c = owners[triangulation.triangles[t + 2]];
  for (const [u, v] of [[a, b], [b, c], [c, a]]) {
    if (u === v) continue;
    const lo = Math.min(u, v), hi = Math.max(u, v);
    pairMap.set(lo * 100000 + hi, [lo, hi]);
  }
}

function edgeLength(i, j) {
  const dx = wrapDx(projected[i][0], projected[j][0]);
  const dy = projected[j][1] - projected[i][1];
  return Math.hypot(dx, dy);
}

// ------------------------------------------------------------------ sampling / classification
function sampleLand(i, j) {
  const ax = projected[i][0], ay = projected[i][1];
  const dx = wrapDx(ax, projected[j][0]);
  const dy = projected[j][1] - ay;
  const len = Math.hypot(dx, dy);
  // ~0.5 degrees of longitude in map units.
  const step = MAP_W / 720;
  const n = Math.max(4, Math.ceil(len / step));
  const samples = [];
  for (let k = 0; k <= n; k++) {
    const t = k / n;
    samples.push(isLandAt(ax + dx * t, ay + dy * t));
  }

  // For sea routes, a port may sit a few map units inside the coastline. Use a
  // distance-based end zone (up to ~25 map units / ~15% of a short edge), then
  // demand that everything in between is water or tiny islands.
  const stepLen = len / n;
  const seaEnd = Math.max(1, Math.min(Math.floor(n * 0.15), Math.ceil(25 / Math.max(stepLen, 1e-9))));
  const seaInterior = samples.slice(seaEnd, n - seaEnd + 1);
  let seaLand = 0, seaRun = 0;
  const seaInteriorLandRuns = [];
  for (const on of seaInterior) {
    if (on) { seaLand++; seaRun++; }
    else if (seaRun) { seaInteriorLandRuns.push(seaRun); seaRun = 0; }
  }
  if (seaRun) seaInteriorLandRuns.push(seaRun);

  let waterRun = 0, maxWaterRun = 0;
  for (const on of samples) {
    if (!on) { waterRun++; if (waterRun > maxWaterRun) maxWaterRun = waterRun; }
    else waterRun = 0;
  }
  const landFrac = samples.filter(Boolean).length / samples.length;
  return {
    len,
    n,
    landFrac,
    seaInteriorLandFrac: seaInterior.length ? seaLand / seaInterior.length : 0,
    seaInteriorLandRuns,
    maxWaterRunSamples: maxWaterRun,
    maxWaterLen: (maxWaterRun * len) / n,
  };
}

// Straits where a short rail tunnel/bridge is plausible. All other rail edges
// may only cross a river/short strait of at most one 0.5-degree sample.
const RAIL_STRAIT_WHITELIST = new Set([
  'london|paris',        // Channel Tunnel
  'istanbul|belgrade',   // Bosphorus
  'copenhagen|stockholm',// Øresund
  'guangzhou|hong-kong', // Pearl River rail link
  'shenzhen|hong-kong',  // Shenzhen River rail link
]);
// Archipelagos where a sea lane may weave through a handful of small islands.
const SEA_ARCHIPELAGO_WHITELIST = new Set(['stockholm|helsinki']);

function classify(i, j, sample) {
  const a = cities[i], b = cities[j];
  const key = [a.id, b.id].sort().join('|');
  const whitelisted = RAIL_STRAIT_WHITELIST.has(key);

  // Rail: essentially land. Short rivers/straits (up to two 0.5-degree samples)
  // are tolerated; known tunnel/bridge corridors may cross a wider channel.
  const railLandMin = whitelisted ? 0.6 : 0.85;
  const railWaterAllowance = whitelisted ? 5 : 1;
  if (sample.landFrac >= railLandMin && sample.maxWaterRunSamples <= railWaterAllowance) return 'rail';

  // Sea: mostly water. Interior land is allowed only for tiny islands; port
  // approach land is trimmed at both ends.
  const archipelago = SEA_ARCHIPELAGO_WHITELIST.has(key);
  const maxIslandRun = archipelago ? 3 : 2;
  const maxInteriorLand = archipelago ? 0.35 : 0.2;
  const tinyIslands = sample.seaInteriorLandRuns.every((run) => run <= maxIslandRun);
  if (a.port && b.port && sample.landFrac <= 0.55 && tinyIslands && sample.seaInteriorLandFrac <= maxInteriorLand) {
    return 'sea';
  }
  return null;
}

// ------------------------------------------------------------------ geometry safety
function normalizeSeg(ax, ay, bx, by) {
  const mid = (ax + bx) / 2;
  const shift = -Math.round(mid / MAP_W) * MAP_W;
  return [ax + shift, ay, bx + shift, by];
}
function orient(ax, ay, bx, by, cx, cy) {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}
function onSeg(ax, ay, bx, by, px, py) {
  return Math.min(ax, bx) - 1e-9 <= px && px <= Math.max(ax, bx) + 1e-9 &&
    Math.min(ay, by) - 1e-9 <= py && py <= Math.max(ay, by) + 1e-9;
}
function segIntersect(ax, ay, bx, by, cx, cy, dx, dy) {
  const o1 = orient(ax, ay, bx, by, cx, cy);
  const o2 = orient(ax, ay, bx, by, dx, dy);
  const o3 = orient(cx, cy, dx, dy, ax, ay);
  const o4 = orient(cx, cy, dx, dy, bx, by);
  if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) &&
      ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) return true;
  if (o1 === 0 && onSeg(ax, ay, bx, by, cx, cy)) return true;
  if (o2 === 0 && onSeg(ax, ay, bx, by, dx, dy)) return true;
  if (o3 === 0 && onSeg(cx, cy, dx, dy, ax, ay)) return true;
  if (o4 === 0 && onSeg(cx, cy, dx, dy, bx, by)) return true;
  return false;
}
function crossesAccepted(seg, accepted) {
  const [ax, ay, bx, by] = normalizeSeg(seg.ax, seg.ay, seg.bx, seg.by);
  for (const e of accepted) {
    if (e.i === seg.i || e.j === seg.i || e.i === seg.j || e.j === seg.j) continue;
    for (const k of [-1, 0, 1]) {
      const [cx0, cy0, dx0, dy0] = normalizeSeg(e.ax, e.ay, e.bx, e.by);
      if (segIntersect(ax, ay, bx, by, cx0 + k * MAP_W, cy0, dx0 + k * MAP_W, dy0)) return true;
    }
  }
  return false;
}
function passesNearCity(seg) {
  const [ax, ay, bx, by] = normalizeSeg(seg.ax, seg.ay, seg.bx, seg.by);
  const dx = bx - ax, dy = by - ay;
  const L2 = dx * dx + dy * dy;
  for (let k = 0; k < cities.length; k++) {
    if (k === seg.i || k === seg.j) continue;
    for (const m of [-1, 0, 1]) {
      const px = projected[k][0] + m * MAP_W;
      const py = projected[k][1];
      let t = ((px - ax) * dx + (py - ay) * dy) / L2;
      if (t <= 0.12 || t >= 0.88) continue;
      t = clamp(t, 0, 1);
      if (Math.hypot(ax + dx * t - px, ay + dy * t - py) < 4.5) return true;
    }
  }
  return false;
}

// ------------------------------------------------------------------ build city edges
const MIN_EDGE = 24;
const MAX_EDGE = 950;
const candidates = [];
for (const [i, j] of pairMap.values()) {
  const len = edgeLength(i, j);
  if (len > MAX_EDGE) continue;
  const ax = projected[i][0], ay = projected[i][1];
  const bx = ax + wrapDx(ax, projected[j][0]), by = projected[j][1];
  candidates.push({ i, j, len, ax, ay, bx, by });
}
candidates.sort((a, b) => a.len - b.len);

const accepted = [];
const rejected = [];
for (const seg of candidates) {
  if (seg.len < MIN_EDGE) { rejected.push(seg); continue; }
  if (passesNearCity(seg) || crossesAccepted(seg, accepted)) { rejected.push(seg); continue; }
  const sample = sampleLand(seg.i, seg.j);
  const mode = classify(seg.i, seg.j, sample);
  if (!mode) { rejected.push(seg); continue; }
  accepted.push({ ...seg, mode, sample });
}

// ------------------------------------------------------------------ connectivity
const uf = Array.from({ length: cities.length }, (_, i) => i);
const find = (x) => (uf[x] === x ? x : (uf[x] = find(uf[x])));
const union = (a, b) => { uf[find(a)] = find(b); };
const edgeKey = (i, j) => `${Math.min(i, j)}:${Math.max(i, j)}`;
const edgeSet = new Set(accepted.map((e) => edgeKey(e.i, e.j)));
for (const e of accepted) union(e.i, e.j);

function graphConnected(edges = accepted) {
  const adj = Array.from({ length: cities.length }, () => []);
  for (const e of edges) { adj[e.i].push(e.j); adj[e.j].push(e.i); }
  const seen = new Uint8Array(cities.length);
  const queue = [0];
  seen[0] = 1;
  for (let q = 0; q < queue.length; q++) {
    for (const nxt of adj[queue[q]]) if (!seen[nxt]) { seen[nxt] = 1; queue.push(nxt); }
  }
  return queue.length === cities.length;
}

function componentCount() {
  const roots = new Set();
  for (let i = 0; i < cities.length; i++) roots.add(find(i));
  return roots.size;
}

let repairs = 0;
const repairLog = [];
while (componentCount() > 1) {
  const comps = cities.map((_, i) => find(i));
  const pairs = [];
  for (let i = 0; i < cities.length; i++) {
    for (let j = i + 1; j < cities.length; j++) {
      if (comps[i] === comps[j]) continue;
      const len = edgeLength(i, j);
      pairs.push({ i, j, len });
    }
  }
  pairs.sort((a, b) => a.len - b.len);

  let best = null;
  for (const p of pairs.slice(0, 300)) {
    if (edgeSet.has(edgeKey(p.i, p.j))) continue;
    const ax = projected[p.i][0], ay = projected[p.i][1];
    const bx = ax + wrapDx(ax, projected[p.j][0]), by = projected[p.j][1];
    const seg = { i: p.i, j: p.j, len: p.len, ax, ay, bx, by };
    if (crossesAccepted(seg, accepted) || passesNearCity(seg)) continue;
    const sample = sampleLand(p.i, p.j);
    const mode = classify(p.i, p.j, sample);
    if (!mode) continue;
    const score = p.len + (mode === 'rail' ? sample.maxWaterLen * 3 : sample.landFrac * 250);
    if (!best || score < best.score) best = { ...seg, mode, sample, score };
  }

  if (best) {
    accepted.push({ i: best.i, j: best.j, len: best.len, ax: best.ax, ay: best.ay, bx: best.bx, by: best.by, mode: best.mode, sample: best.sample });
    edgeSet.add(edgeKey(best.i, best.j));
    union(best.i, best.j);
    repairLog.push([cities[best.i].id, cities[best.j].id, best.mode, best.sample.landFrac, best.sample.maxWaterLen]);
    repairs++;
  } else {
    // No straight edge merges the component without crossing. Pick the shortest
    // valid pair anyway, then remove its (non-bridge) crossing edges.
    let fallback = null;
    for (const p of pairs) {
      if (edgeSet.has(edgeKey(p.i, p.j))) continue;
      const sample = sampleLand(p.i, p.j);
      const mode = classify(p.i, p.j, sample);
      if (!mode) continue;
      const ax = projected[p.i][0], ay = projected[p.i][1];
      const bx = ax + wrapDx(ax, projected[p.j][0]), by = projected[p.j][1];
      fallback = { i: p.i, j: p.j, len: p.len, ax, ay, bx, by, mode, sample };
      break;
    }
    if (!fallback) {
      const groups = new Map();
      for (let i = 0; i < cities.length; i++) {
        const root = find(i);
        if (!groups.has(root)) groups.set(root, []);
        groups.get(root).push(cities[i].id);
      }
      const summary = [...groups.values()].map((g) => g.slice(0, 10).join('/') + (g.length > 10 ? `…(${g.length})` : '')).join(' | ');
      throw new Error(`cannot connect ${groups.size} components: ${summary}`);
    }
    const blockers = accepted.filter((e) => {
      if (e.i === fallback.i || e.j === fallback.i || e.i === fallback.j || e.j === fallback.j) return false;
      const [x1, y1, x2, y2] = normalizeSeg(fallback.ax, fallback.ay, fallback.bx, fallback.by);
      const [u1, v1, u2, v2] = normalizeSeg(e.ax, e.ay, e.bx, e.by);
      for (const k of [-1, 0, 1]) {
        if (segIntersect(x1, y1, x2, y2, u1 + k * MAP_W, v1, u2 + k * MAP_W, v2)) return true;
      }
      return false;
    });
    accepted.push(fallback);
    edgeSet.add(edgeKey(fallback.i, fallback.j));
    union(fallback.i, fallback.j);
    for (const blocker of blockers) {
      const idx = accepted.indexOf(blocker);
      if (idx < 0) continue;
      accepted.splice(idx, 1);
      edgeSet.delete(edgeKey(blocker.i, blocker.j));
      if (!graphConnected()) {
        accepted.push(blocker);
        edgeSet.add(edgeKey(blocker.i, blocker.j));
      }
    }
    repairLog.push([cities[fallback.i].id, cities[fallback.j].id, fallback.mode, fallback.sample.landFrac, fallback.sample.maxWaterLen, 'crossing']);
    repairs++;
  }
}

// Named corridors that should always exist on the board.
const corridors = [
  ['fukuoka', 'busan', 'sea'],        // Japan <-> Korea
  ['london', 'paris', 'rail'],        // UK <-> France (Channel Tunnel)
  ['boston', 'lisbon', 'sea'],        // Americas <-> Europe
  ['boston', 'dakar', 'sea'],         // Americas <-> Africa
  ['suva', 'cebu', 'sea'],            // Oceania <-> SE Asia (open Pacific)
  ['tokyo', 'vancouver', 'sea'],      // Trans-Pacific Japan <-> North America
  ['sendai', 'vancouver', 'sea'],     // Second trans-Pacific route
];
const protectedEdges = new Set();
for (const [aId, bId, mode] of corridors) {
  const i = cityIndex.get(aId), j = cityIndex.get(bId);
  if (i === undefined || j === undefined) throw new Error(`corridor city missing: ${aId}/${bId}`);
  const key = edgeKey(i, j);
  if (edgeSet.has(key)) { protectedEdges.add(key); continue; }
  const ax = projected[i][0], ay = projected[i][1];
  const bx = ax + wrapDx(ax, projected[j][0]), by = projected[j][1];
  const len = Math.hypot(bx - ax, by - ay);
  const seg = { i, j, len, ax, ay, bx, by };
  const sample = sampleLand(i, j);
  const classified = classify(i, j, sample);
  if (classified !== mode) {
    throw new Error(`corridor ${aId}-${bId} is not a valid ${mode} (classified ${classified}, land=${sample.landFrac.toFixed(2)})`);
  }
  if (passesNearCity(seg)) { console.warn(`corridor skipped (passes near city): ${aId}-${bId}`); continue; }
  // Find existing edges this corridor would cross, then add it and remove those
  // blockers if doing so keeps the graph connected.
  const blockers = [];
  for (const e of accepted) {
    if (e.i === i || e.j === i || e.i === j || e.j === j) continue;
    const [x1, y1, x2, y2] = normalizeSeg(seg.ax, seg.ay, seg.bx, seg.by);
    const [u1, v1, u2, v2] = normalizeSeg(e.ax, e.ay, e.bx, e.by);
    let hit = false;
    for (const k of [-1, 0, 1]) {
      if (segIntersect(x1, y1, x2, y2, u1 + k * MAP_W, v1, u2 + k * MAP_W, v2)) { hit = true; break; }
    }
    if (hit) blockers.push(e);
  }
  accepted.push({ ...seg, mode, sample });
  edgeSet.add(key);
  let unresolved = 0;
  for (const blocker of blockers) {
    const bkey = edgeKey(blocker.i, blocker.j);
    if (protectedEdges.has(bkey)) { unresolved++; continue; }
    const idx = accepted.indexOf(blocker);
    if (idx < 0) continue;
    accepted.splice(idx, 1);
    edgeSet.delete(bkey);
    if (!graphConnected()) {
      accepted.push(blocker);
      edgeSet.add(bkey);
      unresolved++;
    }
  }
  if (unresolved) {
    const idx = accepted.findIndex((e) => edgeKey(e.i, e.j) === key);
    if (idx >= 0) accepted.splice(idx, 1);
    edgeSet.delete(key);
    console.warn(`corridor skipped (unresolvable crossing): ${aId}-${bId}`);
  } else {
    protectedEdges.add(key);
  }
}

// ------------------------------------------------------------------ sea pruning
// The board should read as a few deliberate ocean lanes, not a spiderweb.
function pruneSeaEdges() {
  const AMERICAS = new Set(['north_america', 'central_america', 'south_america']);
  const EUROPE_AFRICA = new Set(['europe', 'africa']);
  const ASIA_PACIFIC = new Set(['east_asia', 'southeast_asia', 'oceania']);
  const INDIAN_WEST = new Set(['africa', 'middle_east']);
  const SOUTH_ASIA = new Set(['south_asia', 'southeast_asia', 'oceania']);
  const categoryOf = (e) => {
    const ra = cities[e.i].region, rb = cities[e.j].region;
    if ((ra === 'oceania' && rb === 'southeast_asia') || (rb === 'oceania' && ra === 'southeast_asia')) return 'australia';
    if ((AMERICAS.has(ra) && EUROPE_AFRICA.has(rb)) || (AMERICAS.has(rb) && EUROPE_AFRICA.has(ra))) return 'atlantic';
    if ((ASIA_PACIFIC.has(ra) && (rb === 'north_america' || rb === 'central_america')) ||
        (ASIA_PACIFIC.has(rb) && (ra === 'north_america' || ra === 'central_america'))) return 'pacific';
    if ((INDIAN_WEST.has(ra) && SOUTH_ASIA.has(rb)) || (INDIAN_WEST.has(rb) && SOUTH_ASIA.has(ra))) return 'indian';
    return 'local';
  };
  const budgets = { atlantic: 3, pacific: 2, indian: 2, australia: 2 };
  let removed = 0;

  const seaDegrees = () => {
    const deg = new Map();
    for (const e of accepted) {
      if (e.mode !== 'sea') continue;
      deg.set(e.i, (deg.get(e.i) || 0) + 1);
      deg.set(e.j, (deg.get(e.j) || 0) + 1);
    }
    return deg;
  };
  const tryRemove = (e) => {
    const key = edgeKey(e.i, e.j);
    if (protectedEdges.has(key)) return false;
    const idx = accepted.indexOf(e);
    if (idx < 0) return false;
    accepted.splice(idx, 1);
    edgeSet.delete(key);
    if (!graphConnected()) {
      accepted.push(e);
      edgeSet.add(key);
      return false;
    }
    removed++;
    return true;
  };
  const capCity = (id, cap) => {
    const idx = cityIndex.get(id);
    if (idx === undefined) return;
    for (;;) {
      const sea = accepted.filter((e) => e.mode === 'sea' && (e.i === idx || e.j === idx)).sort((a, b) => b.len - a.len);
      if (sea.length <= cap) break;
      let removedOne = false;
      for (const e of sea) if (tryRemove(e)) { removedOne = true; break; }
      if (!removedOne) break;
    }
  };
  capCity('reykjavik', 3);
  // No city should look like a sea hub.
  for (;;) {
    const deg = seaDegrees();
    let worst = -1, worstDeg = 3;
    for (const [idx, d] of deg) {
      if (d > worstDeg) { worst = idx; worstDeg = d; }
    }
    if (worst < 0) break;
    const sea = accepted.filter((e) => e.mode === 'sea' && (e.i === worst || e.j === worst)).sort((a, b) => b.len - a.len);
    let removedOne = false;
    for (const e of sea) if (tryRemove(e)) { removedOne = true; break; }
    if (!removedOne) break;
  }
  // Ocean-lane budgets.
  for (const [cat, budget] of Object.entries(budgets)) {
    for (;;) {
      const group = accepted.filter((e) => e.mode === 'sea' && categoryOf(e) === cat).sort((a, b) => b.len - a.len);
      if (group.length <= budget) break;
      let removedOne = false;
      for (const e of group) if (tryRemove(e)) { removedOne = true; break; }
      if (!removedOne) break;
    }
  }
  // Suva should stay a 3-lane Pacific hub, not a four-lane switchboard.
  const suvaIdx = cityIndex.get('suva'), yokoIdx = cityIndex.get('yokohama');
  if (suvaIdx !== undefined && yokoIdx !== undefined) {
    const key = edgeKey(suvaIdx, yokoIdx);
    const edge = accepted.find((e) => edgeKey(e.i, e.j) === key);
    if (edge) tryRemove(edge);
  }
  // Report the surviving lanes.
  const stats = {};
  for (const e of accepted) {
    if (e.mode !== 'sea') continue;
    const c = categoryOf(e);
    stats[c] = (stats[c] || 0) + 1;
  }
  console.log(`  sea lanes: ${Object.entries(stats).map(([k, v]) => `${k}=${v}`).join(', ')} (pruned ${removed})`);
}
pruneSeaEdges();

if (!graphConnected()) throw new Error('graph is disconnected after corridor/pruning');

// Final de-crossing: remove the less important of any two crossing city-pair
// edges when the graph survives the cut.
function deCross() {
  for (;;) {
    let pair = null;
    for (let x = 0; x < accepted.length && !pair; x++) {
      const e = accepted[x];
      const [ax, ay, bx, by] = normalizeSeg(e.ax, e.ay, e.bx, e.by);
      for (let y = x + 1; y < accepted.length; y++) {
        const f = accepted[y];
        if (e.i === f.i || e.i === f.j || e.j === f.i || e.j === f.j) continue;
        const [cx, cy, dx, dy] = normalizeSeg(f.ax, f.ay, f.bx, f.by);
        for (const k of [-1, 0, 1]) {
          if (segIntersect(ax, ay, bx, by, cx + k * MAP_W, cy, dx + k * MAP_W, dy)) { pair = [e, f]; break; }
        }
        if (pair) break;
      }
    }
    if (!pair) return;
    const candidates = pair.slice().sort((a, b) => {
      const pa = protectedEdges.has(edgeKey(a.i, a.j)) ? 1 : 0;
      const pb = protectedEdges.has(edgeKey(b.i, b.j)) ? 1 : 0;
      return pa - pb || b.len - a.len;
    });
    let removed = false;
    for (const e of candidates) {
      const key = edgeKey(e.i, e.j);
      if (protectedEdges.has(key)) continue;
      const idx = accepted.indexOf(e);
      accepted.splice(idx, 1);
      edgeSet.delete(key);
      if (graphConnected()) { removed = true; break; }
      accepted.push(e);
      edgeSet.add(key);
    }
    if (!removed) {
      throw new Error(`unresolvable crossing: ${cities[pair[0].i].id}-${cities[pair[0].j].id} x ${cities[pair[1].i].id}-${cities[pair[1].j].id}`);
    }
  }
}
deCross();

// Post-build guarantees. These catch regressions in wrap/crossing/mode logic.
{
  const missing = corridors.filter(([aId, bId]) => {
    const i = cityIndex.get(aId), j = cityIndex.get(bId);
    return !edgeSet.has(edgeKey(i, j));
  });
  if (missing.length) throw new Error(`missing corridors: ${missing.map(([a, b]) => `${a}-${b}`).join(', ')}`);

  let crossings = 0;
  for (let x = 0; x < accepted.length; x++) {
    for (let y = x + 1; y < accepted.length; y++) {
      const e = accepted[x], f = accepted[y];
      if (e.i === f.i || e.i === f.j || e.j === f.i || e.j === f.j) continue;
      const [ax, ay, bx, by] = normalizeSeg(e.ax, e.ay, e.bx, e.by);
      const [cx, cy, dx, dy] = normalizeSeg(f.ax, f.ay, f.bx, f.by);
      let hit = false;
      for (const k of [-1, 0, 1]) {
        if (segIntersect(ax, ay, bx, by, cx + k * MAP_W, cy, dx + k * MAP_W, dy)) { hit = true; break; }
      }
      if (hit) {
        crossings++;
        console.warn(`crossing: ${cities[e.i].id}-${cities[e.j].id} (${e.mode}) x ${cities[f.i].id}-${cities[f.j].id} (${f.mode})`);
      }
    }
  }
  if (crossings > 0) throw new Error(`${crossings} crossing city-pair edges`);

  const cityDegree = new Map(cities.map((c) => [c.id, 0]));
  for (const e of accepted) {
    cityDegree.set(cities[e.i].id, cityDegree.get(cities[e.i].id) + 1);
    cityDegree.set(cities[e.j].id, cityDegree.get(cities[e.j].id) + 1);
  }
  const isolated = [...cityDegree].filter(([, d]) => d === 0).map(([id]) => id);
  if (isolated.length) throw new Error(`isolated cities: ${isolated.join(', ')}`);

  const railWater = accepted.filter((e) => e.mode === 'rail' && e.sample.maxWaterLen > 40);
  const landSea = accepted.filter((e) => e.mode === 'sea' && e.sample.landFrac >= 0.96);
  if (railWater.length || landSea.length) {
    console.warn(`mode warnings: rail-over-water=${railWater.length}, sea-over-land=${landSea.length}`);
    for (const e of railWater) {
      console.warn(`  rail ${cities[e.i].id}-${cities[e.j].id} land=${e.sample.landFrac.toFixed(2)} maxWater=${e.sample.maxWaterLen.toFixed(1)}`);
    }
  }
}

// ---------------------------------------------------------------- squares along edges
const rng = mulberry32(150150);
function pickSquareKind(prev) {
  const r = rng();
  if (r < 0.42) return 'blue';
  if (r < 0.64) return 'red';
  if (r < 0.82) return 'yellow';
  if (prev === 'news') return 'blue';
  return 'news';
}

function isWaterArea(x, y, r = 3) {
  // A sea square must not look like it is sitting on the coast once the land
  // mesh is simplified and rounded. Keep a small offshore buffer.
  const probes = [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r], [r * 0.7, r * 0.7], [-r * 0.7, r * 0.7], [r * 0.7, -r * 0.7], [-r * 0.7, -r * 0.7]];
  for (const [dx, dy] of probes) {
    if (isLandAt(wrapX(x + dx), y + dy)) return false;
  }
  return true;
}

function waterT(ax, ay, dx, dy, target) {
  // Prefer the nominal position, then nudge along the route until we are on water.
  const tryTs = [target];
  for (let d = 0.01; d <= 0.16; d += 0.01) {
    tryTs.push(target - d, target + d);
  }
  for (const t of tryTs) {
    if (t < 0.08 || t > 0.92) continue;
    const x = wrapX(ax + dx * t), y = ay + dy * t;
    const rx = round1(x), ry = round1(y);
    if (isWaterArea(rx, ry)) return [rx, ry];
  }
  // Fall back to the nearest water sample anywhere on the edge.
  let best = null, bestDist = Infinity;
  for (let k = 1; k < 50; k++) {
    const t = k / 50;
    const x = wrapX(ax + dx * t), y = ay + dy * t;
    const rx = round1(x), ry = round1(y);
    if (isWaterArea(rx, ry) && Math.abs(t - target) < bestDist) {
      best = [rx, ry]; bestDist = Math.abs(t - target);
    }
  }
  return best || [round1(wrapX(ax + dx * target)), round1(ay + dy * target)];
}

function landT(ax, ay, dx, dy, target) {
  // Rail squares prefer dry land (bridges/tunnels stay on the line but the
  // station icon should not float in the sea).
  const tryTs = [target];
  for (let d = 0.01; d <= 0.14; d += 0.01) tryTs.push(target - d, target + d);
  for (const t of tryTs) {
    if (t < 0.06 || t > 0.94) continue;
    const x = round1(wrapX(ax + dx * t)), y = round1(ay + dy * t);
    if (isLandAt(x, y)) return [x, y];
  }
  return [round1(wrapX(ax + dx * target)), round1(ay + dy * target)];
}

const nodes = cities.map((c, i) => ({
  id: `c:${c.id}`,
  kind: 'city',
  x: round1(projected[i][0]),
  y: round1(projected[i][1]),
  cityId: c.id,
}));
const edges = [];
let squareNo = 1;
const squareKinds = { blue: 0, red: 0, yellow: 0, news: 0 };
let seaSquaresOnLand = 0;
let railSquaresOnWater = 0;

accepted.sort((a, b) => a.len - b.len);
for (const e of accepted) {
  const count = clamp(Math.round(e.len / 35) - 1, 1, 7);
  const dx = e.bx - e.ax, dy = e.by - e.ay;
  let prevKind = null;
  let prevId = `c:${cities[e.i].id}`;
  for (let k = 0; k < count; k++) {
    const t = (k + 1) / (count + 1);
    let x, y;
    if (e.mode === 'sea') [x, y] = waterT(e.ax, e.ay, dx, dy, t);
    else [x, y] = landT(e.ax, e.ay, dx, dy, t);
    if (e.mode === 'sea' && isLandAt(x, y)) {
      seaSquaresOnLand++;
      console.warn(`sea square on land: ${cities[e.i].id}-${cities[e.j].id} (land=${e.sample.landFrac.toFixed(2)}, waterRun=${e.sample.maxWaterLen.toFixed(0)}, t=${t.toFixed(2)}, ${x},${y})`);
    }
    if (e.mode === 'rail' && !isLandAt(x, y)) railSquaresOnWater++;
    const kind = pickSquareKind(prevKind);
    prevKind = kind;
    squareKinds[kind]++;
    const node = { id: `s:${squareNo++}`, kind, x, y };
    nodes.push(node);
    edges.push({ a: prevId, b: node.id, mode: e.mode });
    prevId = node.id;
  }
  edges.push({ a: prevId, b: `c:${cities[e.j].id}`, mode: e.mode });
}

// ------------------------------------------------------------------ board stats
const byKind = {};
for (const n of nodes) byKind[n.kind] = (byKind[n.kind] || 0) + 1;
const byMode = {};
for (const e of edges) byMode[e.mode] = (byMode[e.mode] || 0) + 1;
const degrees = new Map(nodes.map((n) => [n.id, 0]));
const adj = new Map(nodes.map((n) => [n.id, []]));
for (const e of edges) {
  degrees.set(e.a, (degrees.get(e.a) || 0) + 1);
  degrees.set(e.b, (degrees.get(e.b) || 0) + 1);
  adj.get(e.a).push(e.b);
  adj.get(e.b).push(e.a);
}
let avgDegree = 0;
for (const d of degrees.values()) avgDegree += d;
avgDegree /= nodes.length;

function bfsFarthest(start) {
  const dist = new Map([[start, 0]]);
  const queue = [start];
  let far = start;
  for (let q = 0; q < queue.length; q++) {
    const cur = queue[q];
    for (const nxt of adj.get(cur)) {
      if (dist.has(nxt)) continue;
      dist.set(nxt, dist.get(cur) + 1);
      if (dist.get(nxt) > dist.get(far)) far = nxt;
      queue.push(nxt);
    }
  }
  return { far, dist };
}
let diameter = 0;
for (const n of nodes) {
  const { far, dist } = bfsFarthest(n.id);
  const d = dist.get(far);
  if (d > diameter) diameter = d;
}
// Connectivity over the final node graph.
let nodeComponents = 0;
const seenNodes = new Set();
for (const n of nodes) {
  if (seenNodes.has(n.id)) continue;
  nodeComponents++;
  const queue = [n.id];
  seenNodes.add(n.id);
  for (let q = 0; q < queue.length; q++) {
    for (const nxt of adj.get(queue[q])) {
      if (!seenNodes.has(nxt)) { seenNodes.add(nxt); queue.push(nxt); }
    }
  }
}
if (nodeComponents !== 1) throw new Error(`board graph has ${nodeComponents} components`);

// ------------------------------------------------------------------ land.json
function clipRingX(ring, bound, keepGreater) {
  const out = [];
  const inside = (p) => (keepGreater ? p[0] >= bound : p[0] <= bound);
  for (let i = 0; i < ring.length; i++) {
    const cur = ring[i];
    const prev = ring[(i + ring.length - 1) % ring.length];
    const ci = inside(cur), pi = inside(prev);
    if (ci) {
      if (!pi) {
        const t = (bound - prev[0]) / (cur[0] - prev[0] || 1e-12);
        out.push([bound, prev[1] + t * (cur[1] - prev[1])]);
      }
      out.push(cur);
    } else if (pi) {
      const t = (bound - prev[0]) / (cur[0] - prev[0] || 1e-12);
      out.push([bound, prev[1] + t * (cur[1] - prev[1])]);
    }
  }
  return out;
}
function perpDistance(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
  t = clamp(t, 0, 1);
  return Math.hypot(p[0] - (a[0] + dx * t), p[1] - (a[1] + dy * t));
}
function simplify(points, tolerance) {
  if (points.length <= 4) return points;
  const closed = points[0][0] === points[points.length - 1][0] && points[0][1] === points[points.length - 1][1];
  const pts = closed ? points.slice(0, -1) : points.slice();
  if (pts.length <= 3) return points;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop();
    let maxD = -1, idx = -1;
    for (let i = lo + 1; i < hi; i++) {
      const d = perpDistance(pts[i], pts[lo], pts[hi]);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tolerance && idx > 0) {
      keep[idx] = 1;
      stack.push([lo, idx], [idx, hi]);
    }
  }
  const out = pts.filter((_, i) => keep[i]);
  if (out.length < 3) return points;
  if (closed) out.push(out[0]);
  return out;
}
function ringArea(ring) {
  let s = 0;
  for (let i = 0; i < ring.length - 1; i++) s += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  return s / 2;
}
function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if (((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
function cleanRing(ring) {
  const out = [];
  for (const p of ring) {
    const rp = [roundHalf(p[0]), roundHalf(p[1])];
    const last = out[out.length - 1];
    if (!last || last[0] !== rp[0] || last[1] !== rp[1]) out.push(rp);
  }
  if (out.length && (out[0][0] !== out[out.length - 1][0] || out[0][1] !== out[out.length - 1][1])) out.push(out[0]);
  return out;
}
function normalizeOrientation(ring, wantPositive) {
  const area = ringArea(ring);
  if ((area > 0) !== wantPositive) ring.reverse();
  return ring;
}

const cityPoints = projected.map(([x, y]) => [x, y]);
const landPolygons = [];
let tinyKept = 0;
for (let pi = 0; pi < sourcePolygons.length; pi++) {
  const coords = sourcePolygons[pi].geometry.coordinates;
  const projectedRings = coords.map(projectRing);
  for (const k of [-1, 0, 1]) {
    const shifted = projectedRings.map((ring) => ring.map(([x, y]) => [x + k * MAP_W, y]));
    const clipped = shifted.map((ring) => clipRingX(clipRingX(ring, 0, true), MAP_W, false))
      .filter((ring) => ring.length >= 3);
    if (!clipped.length) continue;
    const outerRaw = clipped[0];
    const rawArea = Math.abs(ringArea(outerRaw));
    if (rawArea < 0.5) continue;

    const containsCity = cityPoints.some(([cx, cy]) => {
      for (const m of [-1, 0, 1]) {
        const px = cx + m * MAP_W;
        if (!pointInRing(px, cy, outerRaw)) continue;
        let inHole = false;
        for (let h = 1; h < clipped.length; h++) if (pointInRing(px, cy, clipped[h])) { inHole = true; break; }
        if (!inHole) return true;
      }
      return false;
    });
    if (rawArea < 6 && !containsCity) continue;
    if (rawArea < 6 && containsCity) tinyKept++;

    const outer = cleanRing(normalizeOrientation(simplify(outerRaw, 1.5), true));
    if (outer.length < 4) continue;
    const rings = [outer];
    for (let h = 1; h < clipped.length; h++) {
      const holeArea = Math.abs(ringArea(clipped[h]));
      if (holeArea < 4) continue;
      const hole = cleanRing(normalizeOrientation(simplify(clipped[h], 1.5), false));
      if (hole.length >= 4) rings.push(hole);
    }
    landPolygons.push(rings);
  }
}
const landOut = { w: MAP_W, h: MAP_H, polygons: landPolygons.map((poly) => poly.map((ring) => ring.flat())) };
let seamJumps = 0, outOfBounds = 0;
for (const rings of landPolygons) {
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const [x, y] = ring[i];
      if (x < 0 || x > MAP_W || y < 0 || y > MAP_H) outOfBounds++;
      if (i > 0 && Math.abs(x - ring[i - 1][0]) > MAP_W / 2) seamJumps++;
    }
  }
}
if (seamJumps || outOfBounds) throw new Error(`land rings invalid: seamJumps=${seamJumps}, outOfBounds=${outOfBounds}`);
const landJson = JSON.stringify(landOut);
if (landJson.length > 600 * 1024) throw new Error(`land.json is ${(landJson.length / 1024).toFixed(1)} KB (target < 600 KB)`);
mkdirSync(dirname(LAND_PATH), { recursive: true });
writeFileSync(LAND_PATH, landJson + '\n');
const landPoints = landPolygons.reduce((s, rings) => s + rings.reduce((a, r) => a + r.length, 0), 0);

// ------------------------------------------------------------------ write board
const board = { nodes, edges };
if (nodes.length < 900) throw new Error(`only ${nodes.length} nodes (target >= 900)`);
mkdirSync(dirname(BOARD_PATH), { recursive: true });
writeFileSync(BOARD_PATH, JSON.stringify(board) + '\n');

// ------------------------------------------------------------------ report
console.log('board:');
console.log(`  cities: ${cities.length}`);
console.log(`  squares: ${nodes.length - cities.length}`);
console.log(`  total nodes: ${nodes.length} (${Object.entries(byKind).map(([k, v]) => `${k}=${v}`).join(', ')})`);
console.log(`  edges: ${edges.length} (${Object.entries(byMode).map(([k, v]) => `${k}=${v}`).join(', ')})`);
console.log(`  avg degree: ${avgDegree.toFixed(2)}`);
console.log(`  diameter: ${diameter} steps`);
console.log(`  components: ${nodeComponents}`);
console.log(`  connectivity repairs: ${repairs}`);
if (repairLog.length) {
  console.log(`    ${repairLog.map(([a, b, m, lf, mw, tag]) => `${a}-${b} (${m}, land=${lf.toFixed(2)}, waterRun=${mw.toFixed(0)}${tag ? ', ' + tag : ''})`).join('\n    ')}`);
}
console.log(`  square mix: ${Object.entries(squareKinds).map(([k, v]) => `${k}=${v}`).join(', ')}`);
console.log(`  sea squares on land: ${seaSquaresOnLand}, rail squares on water: ${railSquaresOnWater}`);
console.log(`  land polygons: ${landPolygons.length}, land points: ${landPoints}, land.json: ${(landJson.length / 1024).toFixed(1)} KB, tiny city islands kept: ${tinyKept}`);