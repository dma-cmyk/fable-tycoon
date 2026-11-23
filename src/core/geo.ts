// Shared map projection: Miller cylindrical base + the smooth デフォルメ warp
// baked into src/data/warp.json (see tools/build-map-art.py, docs/MAP-ART.md).
// Keep in sync with tools/lib/project.mjs, which the build scripts use.

import warpJson from '../data/warp.json';

export const CENTRAL_MERIDIAN = 11; // degrees east; the map seam is at -169 (Bering / mid-Pacific)
export const MAP_W = 8192;
export const LAT_TOP = 80;
export const LAT_BOTTOM = -56;

const millerY = (latDeg: number): number => {
  const phi = (latDeg * Math.PI) / 180;
  return 1.25 * Math.log(Math.tan(Math.PI / 4 + 0.4 * phi));
};

const Y_TOP = millerY(LAT_TOP);
const SCALE = MAP_W / (2 * Math.PI);
export const MAP_H = warpJson.h;

/** Warp grid: periodic in x (col 0 = x 0 and x MAP_W), inclusive in y. */
export const WARP_COLS = warpJson.cols;
export const WARP_ROWS = warpJson.rows;
const WARP_DX = warpJson.dx;
const WARP_DY = warpJson.dy;

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** lon/lat (degrees) -> unwarped Miller map units. x in [0, MAP_W). */
export function projectRaw(lon: number, lat: number): [number, number] {
  let rel = lon - CENTRAL_MERIDIAN;
  rel = ((((rel + 180) % 360) + 360) % 360) - 180; // -180..180
  const x = ((rel + 180) / 360) * MAP_W;
  const y = (Y_TOP - millerY(clamp(lat, LAT_BOTTOM, LAT_TOP))) * SCALE;
  return [x, y];
}

/** Bilinear displacement lookup (periodic in x, clamped in y). */
function sampleDisp(x: number, y: number): [number, number] {
  const fx = (x / MAP_W) * WARP_COLS;
  const fy = clamp((y / MAP_H) * (WARP_ROWS - 1), 0, WARP_ROWS - 1);
  const i0 = ((Math.floor(fx) % WARP_COLS) + WARP_COLS) % WARP_COLS;
  const i1 = (i0 + 1) % WARP_COLS;
  const tx = fx - Math.floor(fx);
  const j0 = Math.min(WARP_ROWS - 1, Math.max(0, Math.floor(fy)));
  const j1 = Math.min(WARP_ROWS - 1, j0 + 1);
  const ty = fy - j0;
  const row0 = j0 * WARP_COLS;
  const row1 = j1 * WARP_COLS;
  const dx = (WARP_DX[row0 + i0] * (1 - tx) + WARP_DX[row0 + i1] * tx) * (1 - ty)
    + (WARP_DX[row1 + i0] * (1 - tx) + WARP_DX[row1 + i1] * tx) * ty;
  const dy = (WARP_DY[row0 + i0] * (1 - tx) + WARP_DY[row0 + i1] * tx) * (1 - ty)
    + (WARP_DY[row1 + i0] * (1 - tx) + WARP_DY[row1 + i1] * tx) * ty;
  return [dx, dy];
}

/** Warp unwarped Miller map units into final map units. */
export function warpPoint(x: number, y: number): [number, number] {
  const [dx, dy] = sampleDisp(x, y);
  return [wrapX(x + dx), clamp(y + dy, 0, MAP_H)];
}

/**
 * lon/lat (degrees) -> final map units. x in [0, MAP_W), y in [0, MAP_H]
 * (y grows downward). The warp only redistributes space; no folds.
 */
export function project(lon: number, lat: number): [number, number] {
  const [x, y] = projectRaw(lon, lat);
  return warpPoint(x, y);
}

/** Shortest horizontal delta on the wrapping map (b - a), in (-MAP_W/2, MAP_W/2]. */
export function wrapDx(ax: number, bx: number): number {
  let dx = bx - ax;
  if (dx > MAP_W / 2) dx -= MAP_W;
  if (dx <= -MAP_W / 2) dx += MAP_W;
  return dx;
}

export function wrapX(x: number): number {
  return ((x % MAP_W) + MAP_W) % MAP_W;
}
