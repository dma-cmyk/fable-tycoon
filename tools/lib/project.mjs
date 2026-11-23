/**
 * Shared map projection for Node tooling (build-board, validate-data, previews).
 *
 * The world is a Miller cylindrical map warped by a smooth, fold-free
 * density-equalising stretch baked into src/data/warp.json by
 * tools/build-map-art.py. Keep in sync with src/core/geo.ts.
 *
 * warp.json: { w, h, cols, rows, dx:number[], dy:number[] }
 *   dx/dy are integer map-unit displacements on a cols x rows vertex grid:
 *   x vertices at i*w/cols (periodic, column 0 is both x=0 and x=w),
 *   y vertices at j*h/(rows-1) (inclusive top and bottom).
 *
 * A point is warped as [wrapX(x + dx), clamp(y + dy, 0, h)].
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CENTRAL_MERIDIAN = 11;
export const LAT_TOP = 80;
export const LAT_BOTTOM = -56;

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const WARP_PATH = join(ROOT, 'src/data/warp.json');

let warp = null;
try {
  warp = JSON.parse(readFileSync(WARP_PATH, 'utf8'));
} catch {
  console.warn(`warp.json not found (${WARP_PATH}); using unwarped Miller projection`);
}

const millerY = (latDeg) => {
  const phi = (latDeg * Math.PI) / 180;
  return 1.25 * Math.log(Math.tan(Math.PI / 4 + 0.4 * phi));
};
const Y_TOP = millerY(LAT_TOP);
const Y_BOTTOM = millerY(LAT_BOTTOM);

export const MAP_W = warp ? warp.w : 8192;
const SCALE = MAP_W / (2 * Math.PI);
export const MAP_H = warp ? warp.h : Math.round((Y_TOP - Y_BOTTOM) * SCALE);

export const WARP_COLS = warp ? warp.cols : 0;
export const WARP_ROWS = warp ? warp.rows : 0;
const WARP_DX = warp ? warp.dx : null;
const WARP_DY = warp ? warp.dy : null;

export function wrapX(x) {
  return ((x % MAP_W) + MAP_W) % MAP_W;
}

export function wrapDx(ax, bx) {
  let dx = bx - ax;
  if (dx > MAP_W / 2) dx -= MAP_W;
  if (dx <= -MAP_W / 2) dx += MAP_W;
  return dx;
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** lon/lat -> unwarped Miller map coordinates. */
export function projectRaw(lon, lat) {
  let rel = lon - CENTRAL_MERIDIAN;
  rel = (((rel + 180) % 360) + 360) % 360 - 180;
  const x = ((rel + 180) / 360) * MAP_W;
  const y = (Y_TOP - millerY(clamp(lat, LAT_BOTTOM, LAT_TOP))) * SCALE;
  return [x, y];
}

/** Unwarped Miller map coordinates -> lon/lat. */
export function unprojectRaw(x, y) {
  const rel = (wrapX(x) / MAP_W) * 360 - 180;
  const lon = (((rel + CENTRAL_MERIDIAN + 180) % 360) + 360) % 360 - 180;
  const m = Y_TOP - y / SCALE;
  const lat = ((Math.atan(Math.exp(m / 1.25)) - Math.PI / 4) / 0.4) * (180 / Math.PI);
  return [lon, clamp(lat, LAT_BOTTOM, LAT_TOP)];
}

/** Bilinear displacement lookup (periodic in x, clamped in y). */
function sampleDisp(x, y) {
  if (!WARP_DX) return [0, 0];
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

/** Warp unwarped Miller map coordinates. */
export function warpPoint(x, y) {
  const [dx, dy] = sampleDisp(x, y);
  return [wrapX(x + dx), clamp(y + dy, 0, MAP_H)];
}

/** lon/lat -> final (warped) map coordinates. */
export function project(lon, lat) {
  const [x, y] = projectRaw(lon, lat);
  return warpPoint(x, y);
}

/**
 * Final (warped) map coordinates -> lon/lat. Newton inversion of the bilinear
 * warp; used only by build-time land sampling, not by the renderer.
 */
export function unproject(xw, yw) {
  let x = wrapX(xw);
  let y = clamp(yw, 0, MAP_H);
  for (let i = 0; i < 12; i++) {
    const [wx, wy] = warpPoint(x, y);
    const rx = wrapDx(wx, xw);
    const ry = yw - wy;
    if (Math.abs(rx) < 0.02 && Math.abs(ry) < 0.02) break;
    const h = 1;
    const [wx1, wy1] = warpPoint(x + h, y);
    const [wx0, wy0] = warpPoint(x - h, y);
    const [wxy, wyy] = warpPoint(x, y + h);
    const [wx0y, wy0y] = warpPoint(x, y - h);
    const a = (wrapDx(wx0, wx1)) / (2 * h); // d(wx)/dx
    const b = wrapDx(wx0y, wxy) / (2 * h); // d(wx)/dy
    const c = (wy1 - wy0) / (2 * h); // d(wy)/dx
    const d = (wyy - wy0y) / (2 * h); // d(wy)/dy
    const det = a * d - b * c;
    if (!(det > 1e-6)) break;
    const dx = (d * rx - b * ry) / det;
    const dy = (-c * rx + a * ry) / det;
    x = wrapX(x + dx);
    y = clamp(y + dy, 0, MAP_H);
  }
  return unprojectRaw(x, y);
}