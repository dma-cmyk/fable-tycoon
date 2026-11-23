// Shared map projection (Miller cylindrical, horizontally wrapping world).
// Used by tools/build-board.mjs (via a copy of the same formulas) and the renderer.

export const CENTRAL_MERIDIAN = 11; // degrees east; the map seam is at -169 (Bering / mid-Pacific)
export const MAP_W = 4096;
export const LAT_TOP = 80;
export const LAT_BOTTOM = -56;

const millerY = (latDeg: number): number => {
  const phi = (latDeg * Math.PI) / 180;
  return 1.25 * Math.log(Math.tan(Math.PI / 4 + 0.4 * phi));
};

const Y_TOP = millerY(LAT_TOP);
const Y_BOTTOM = millerY(LAT_BOTTOM);
const SCALE = MAP_W / (2 * Math.PI);
export const MAP_H = Math.round((Y_TOP - Y_BOTTOM) * SCALE);

/** lon/lat (degrees) -> map units. x in [0, MAP_W), y in [0, MAP_H] (y grows downward). */
export function project(lon: number, lat: number): [number, number] {
  let rel = lon - CENTRAL_MERIDIAN;
  rel = ((((rel + 180) % 360) + 360) % 360) - 180; // -180..180
  const x = ((rel + 180) / 360) * MAP_W;
  const y = (Y_TOP - millerY(Math.max(LAT_BOTTOM, Math.min(LAT_TOP, lat)))) * SCALE;
  return [x, y];
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
