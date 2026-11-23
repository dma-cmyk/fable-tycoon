#!/usr/bin/env python3
"""
build-map-art.py — builds the illustrated world map assets for グローバル寓話大富豪.

Run:  .tmp/venv/bin/python tools/build-map-art.py
      .tmp/venv/bin/python tools/build-map-art.py --stages terrain,preview
      .tmp/venv/bin/python tools/build-map-art.py --land-mode warped

Outputs (all in the game's warped Miller map coordinates, MAP_W=8192, MAP_H=3817):
  src/data/warp.json                     INPUT: smooth デフォルメ warp grid (run tools/build-warp.py)
  public/assets/map/terrain.webp         4096 px wide RGBA terrain (alpha = land)
  public/assets/map/terrain_lo.webp      1024 px wide RGBA terrain
  public/assets/map/rivers.json          major rivers, flat coords
  public/assets/map/lakes.json           lake polygons, flat coords
  public/assets/map/borders.json         shared country borders
  public/assets/map/labels.json          ocean / continent / country / river / lake labels

Data: Natural Earth II shaded relief (public domain), Natural Earth 50m/10m
vectors (public domain), world-atlas countries-50m (ISC). Downloads are cached
in .tmp/ne/. See docs/MAP-ART.md and docs/CREDITS.md.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import subprocess
import sys
import time
import urllib.request
import zipfile
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont
from scipy.ndimage import distance_transform_edt, gaussian_filter, map_coordinates
from shapely.geometry import LineString, MultiLineString, MultiPolygon, Polygon, box, shape
from shapely.ops import polylabel, unary_union

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / ".tmp" / "ne"
OUT = ROOT / "public" / "assets" / "map"
TMP = ROOT / ".tmp"

MAP_W, MAP_H = 8192, 3817
LAT_TOP, LAT_BOTTOM = 80.0, -56.0
CENTRAL_MERIDIAN = 11.0
TERRAIN_W = 4096
TERRAIN_H = int(round(TERRAIN_W * MAP_H / MAP_W))
LO_W = 1024
LO_H = int(round(LO_W * MAP_H / MAP_W))

NE2_URL = "https://naciscdn.org/naturalearth/50m/raster/NE2_50M_SR_W.zip"
NE_URLS = {
    "rivers": "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_rivers_lake_centerlines.geojson",
    "lakes50": "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_lakes.geojson",
    "lakes10": "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_lakes.geojson",
    "countries": "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson",
    "land50": "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_land.geojson",
}
UA = {"User-Agent": "fable-tycoon-map-art/1.0"}


# ------------------------------------------------------------------ projection
def miller_y(lat_deg):
    phi = np.radians(lat_deg)
    return 1.25 * np.log(np.tan(np.pi / 4 + 0.4 * phi))


Y_TOP = float(miller_y(LAT_TOP))
SCALE = MAP_W / (2 * math.pi)


def project_raw(lon, lat):
    """lon/lat (degrees, scalars or arrays) -> unwarped Miller map units."""
    lon = np.asarray(lon, dtype=np.float64)
    lat = np.asarray(lat, dtype=np.float64)
    rel = (lon - CENTRAL_MERIDIAN + 180.0) % 360.0 - 180.0
    x = (rel + 180.0) / 360.0 * MAP_W
    y = (Y_TOP - miller_y(np.clip(lat, LAT_BOTTOM, LAT_TOP))) * SCALE
    return x, y


def unproject_raw(x, y):
    """unwarped Miller map units -> lon/lat."""
    rel = (np.asarray(x) % MAP_W) / MAP_W * 360.0 - 180.0
    lon = ((rel + CENTRAL_MERIDIAN + 180.0) % 360.0) - 180.0
    m = Y_TOP - np.asarray(y) / SCALE
    lat = np.degrees((np.arctan(np.exp(m / 1.25)) - np.pi / 4) / 0.4)
    return lon, np.clip(lat, LAT_BOTTOM, LAT_TOP)


def wrap_x(x):
    return np.mod(x, MAP_W)


# ------------------------------------------------------------------ warp
class Warp:
    """Bilinear sampler for the baked warp grid (periodic in x)."""

    def __init__(self, data):
        self.w = float(data["w"])
        self.h = float(data["h"])
        self.cols = int(data["cols"])
        self.rows = int(data["rows"])
        self.dx = np.asarray(data["dx"], dtype=np.float32).reshape(self.rows, self.cols)
        self.dy = np.asarray(data["dy"], dtype=np.float32).reshape(self.rows, self.cols)
        self.dx_flat = self.dx.ravel()
        self.dy_flat = self.dy.ravel()

    def sample(self, px, py):
        px = np.asarray(px, dtype=np.float64)
        py = np.asarray(py, dtype=np.float64)
        fx = (px / self.w * self.cols) % self.cols
        fy = np.clip(py / self.h * (self.rows - 1), 0, self.rows - 1)
        i0 = np.floor(fx).astype(np.int32) % self.cols
        i1 = (i0 + 1) % self.cols
        tx = fx - np.floor(fx)
        j0 = np.floor(fy).astype(np.int32)
        j1 = np.minimum(j0 + 1, self.rows - 1)
        ty = fy - j0
        row0 = j0 * self.cols
        row1 = j1 * self.cols
        dx = (self.dx_flat[row0 + i0] * (1 - tx) + self.dx_flat[row0 + i1] * tx) * (1 - ty) \
            + (self.dx_flat[row1 + i0] * (1 - tx) + self.dx_flat[row1 + i1] * tx) * ty
        dy = (self.dy_flat[row0 + i0] * (1 - tx) + self.dy_flat[row0 + i1] * tx) * (1 - ty) \
            + (self.dy_flat[row1 + i0] * (1 - tx) + self.dy_flat[row1 + i1] * tx) * ty
        return dx, dy

    def forward(self, x, y):
        dx, dy = self.sample(x, y)
        return wrap_x(x + dx), np.clip(y + dy, 0, self.h)

    def inverse(self, xw, yw, iterations=16):
        """Robust inverse (damped Newton with a displacement initial guess)."""
        dx0, dy0 = self.sample(xw, yw)
        x = wrap_x(xw - dx0)
        y = np.clip(yw - dy0, 0, self.h)
        for _ in range(iterations):
            wx, wy = self.forward(x, y)
            rx = (xw - wx + self.w / 2) % self.w - self.w / 2
            ry = yw - wy
            err = np.hypot(rx, ry)
            if err.size and float(np.max(err)) < 0.01:
                break
            h = 2.0
            wx1, wy1 = self.forward(x + h, y)
            wx0, wy0 = self.forward(x - h, y)
            wxy, wyy = self.forward(x, y + h)
            wx0y, wy0y = self.forward(x, y - h)
            a = ((wx1 - wx0 + self.w / 2) % self.w - self.w / 2) / (2 * h)
            c = (wy1 - wy0) / (2 * h)
            b = ((wxy - wx0y + self.w / 2) % self.w - self.w / 2) / (2 * h)
            d = (wyy - wy0y) / (2 * h)
            det = a * d - b * c
            det = np.where(np.abs(det) < 0.05, np.where(det < 0, -0.05, 0.05), det)
            sx = (d * rx - b * ry) / det
            sy = (-c * rx + a * ry) / det
            mag = np.hypot(sx, sy)
            lim = np.minimum(1.0, 120.0 / np.maximum(mag, 1e-9))
            x = wrap_x(x + sx * lim)
            y = np.clip(y + sy * lim, 0, self.h)
        return x, y


def load_warp():
    return Warp(json.loads((ROOT / "src/data/warp.json").read_text()))


# ------------------------------------------------------------------ download helpers
def download(url, dest: Path):
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists() and dest.stat().st_size > 0:
        return dest
    print(f"  download {url}")
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=120) as r, open(dest, "wb") as f:
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)
    return dest


def ensure_data():
    CACHE.mkdir(parents=True, exist_ok=True)
    zip_path = CACHE / "NE2_50M_SR_W.zip"
    download(NE2_URL, zip_path)
    ne2_dir = CACHE / "ne2" / "NE2_50M_SR_W"
    if not (ne2_dir / "NE2_50M_SR_W.tif").exists():
        print("  extract NE2 raster")
        with zipfile.ZipFile(zip_path) as z:
            z.extractall(CACHE / "ne2")
    for key, url in NE_URLS.items():
        dest = {
            "rivers": "ne_50m_rivers_lake_centerlines.geojson",
            "lakes50": "ne_50m_lakes.geojson",
            "lakes10": "ne_10m_lakes.geojson",
            "countries": "ne_50m_admin_0_countries.geojson",
            "land50": "ne_50m_land.geojson",
        }[key]
        download(url, CACHE / dest)
    mesh_path = CACHE / "countries-50m-mesh.geojson"
    if not mesh_path.exists():
        print("  export world-atlas border mesh")
        node = os.environ.get("NODE", "node")
        subprocess.run(
            [node, str(ROOT / "tools/topojson-mesh.mjs"),
             str(ROOT / "node_modules/world-atlas/countries-50m.json"), "countries", str(mesh_path)],
            check=True,
        )
    return {
        "ne2": ne2_dir / "NE2_50M_SR_W.tif",
        "rivers": CACHE / "ne_50m_rivers_lake_centerlines.geojson",
        "lakes50": CACHE / "ne_50m_lakes.geojson",
        "lakes10": CACHE / "ne_10m_lakes.geojson",
        "countries": CACHE / "ne_50m_admin_0_countries.geojson",
        "land50": CACHE / "ne_50m_land.geojson",
        "mesh": mesh_path,
    }


# ------------------------------------------------------------------ warp generation
def generate_warp():
    """Density-equalising per-axis stretch (monotone by construction)."""
    cities = json.loads((ROOT / "src/data/cities.json").read_text())
    weights = np.array([1.7 if c["tier"] == 1 else 1.0 if c["tier"] == 2 else 0.8 for c in cities], dtype=np.float32)
    cx, cy = project_raw(np.array([c["lon"] for c in cities]), np.array([c["lat"] for c in cities]))
    cxy = np.stack([cx, cy], axis=1)

    NX, NY = 256, 120
    gx = np.arange(NX) * MAP_W / NX
    gy = np.arange(NY) * MAP_H / (NY - 1)
    GX, GY = np.meshgrid(gx, gy)

    def density(sigma):
        f = np.zeros((NY, NX), dtype=np.float32)
        for (x, y), wt in zip(cxy, weights):
            dx = (GX - x + MAP_W / 2) % MAP_W - MAP_W / 2
            dy = GY - y
            f += wt * np.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma))
        return f

    d = density(110) + 0.7 * density(380)
    d = gaussian_filter(d, sigma=(3, 3), mode=("nearest", "wrap"))
    d /= d.mean()

    def deg_y(sig_deg, lat0=45.0):
        y0 = float(project_raw(0.0, lat0)[1])
        y1 = float(project_raw(0.0, lat0 + sig_deg)[1])
        return abs(y1 - y0)

    amps = [2.6, 2.6, 0.25, 2.4, 0.75, 0.95, 0.45, 0.35, 0.4, 0.3, 0.3, 0.25, 0.25]
    base = [
        (15, 49, 700, deg_y(10)), (135, 38, 330, deg_y(8)), (114, 31, 460, deg_y(8)),
        (-84, 41, 700, deg_y(9)), (-88, 22, 420, deg_y(7)), (78, 22, 520, deg_y(10)),
        (-120, 37, 260, deg_y(7)), (106, 5, 520, deg_y(11)), (-46, -22, 420, deg_y(8)),
        (150, -33, 360, deg_y(7)), (-99, 20, 300, deg_y(7)), (-122, 47, 280, deg_y(6)),
        (29, 41, 280, deg_y(6)),
    ]
    sx = 1.0 + 0.25 * (d - 1.0)
    sy = 1.0 + 0.20 * (d - 1.0)
    for (lon, lat, sigx, sigy), amp in zip(base, amps):
        px, py = project_raw(lon, lat)
        dx = np.abs((GX - px + MAP_W / 2) % MAP_W - MAP_W / 2)
        dy = GY - py
        sx += amp * np.exp(-(dx * dx / (2 * sigx * sigx) + dy * dy / (2 * sigy * sigy)))
        sy += amp * 0.55 * np.exp(-(dx * dx / (2 * 700.0 * 700.0) + dy * dy / (2 * deg_y(12) ** 2)))
    sx = np.clip(sx, 0.12, 6.0)
    sx /= sx.mean(axis=1, keepdims=True)
    sy = np.clip(sy, 0.2, 6.0)
    sy /= sy.mean(axis=0, keepdims=True)

    hx = MAP_W / NX
    cs = np.cumsum(sx, axis=1)
    fx = hx * (cs - 0.5 * sx)
    fx[:, 0] = 0.0
    fx *= MAP_W / (hx * sx.sum(axis=1, keepdims=True))
    gy_cum = np.cumsum(sy, axis=0)
    gy_cum -= gy_cum[0:1, :]
    gy_cum *= MAP_H / gy_cum[-1:, :]

    fy = np.clip(gy_cum / MAP_H * (NY - 1), 0, NY - 1)
    j0 = np.floor(fy).astype(int)
    j1 = np.minimum(j0 + 1, NY - 1)
    ty = fy - j0
    ii = np.arange(NX)[None, :]
    x1 = fx[j0, ii] * (1 - ty) + fx[j1, ii] * ty
    dx = np.round(x1 - GX).astype(int)
    dy = np.round(gy_cum - GY).astype(int)

    payload = {
        "w": MAP_W, "h": MAP_H, "cols": NX, "rows": NY,
        "dx": dx.ravel().tolist(), "dy": dy.ravel().tolist(),
    }
    text = json.dumps(payload, separators=(",", ":"))
    path = ROOT / "src/data/warp.json"
    old = path.read_text() if path.exists() else ""
    if old != text:
        path.write_text(text)
        print(f"  wrote src/data/warp.json ({len(text) / 1024:.0f} KB)")
    else:
        print("  warp.json unchanged")
    return Warp(payload)


def inverse_grid(warp: Warp, gw=2048, gh=954):
    """Cache the robust inverse of the warp on a regular output grid."""
    key = hashlib.sha1((ROOT / "src/data/warp.json").read_bytes()).hexdigest()[:12]
    cache = TMP / "map-art" / f"inverse-{gw}x{gh}-{key}.npz"
    if cache.exists():
        z = np.load(cache)
        return z["rx"], z["ry"]
    print(f"  inverting warp on {gw}x{gh} grid ...")
    t0 = time.time()
    xw = np.arange(gw) * MAP_W / gw
    yw = np.arange(gh) * MAP_H / (gh - 1)
    XW, YW = np.meshgrid(xw, yw)
    rx, ry = warp.inverse(XW, YW)
    cache.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(cache, rx=rx.astype(np.float32), ry=ry.astype(np.float32))
    print(f"    done in {time.time() - t0:.1f}s")
    return rx.astype(np.float32), ry.astype(np.float32)


def sample_grid(arr, px, py):
    """Bilinear sample of a regular (rows, cols) grid over the whole map."""
    rows, cols = arr.shape
    fx = (np.asarray(px) / MAP_W * cols) % cols
    fy = np.clip(np.asarray(py) / MAP_H * (rows - 1), 0, rows - 1)
    i0 = np.floor(fx).astype(np.int64) % cols
    i1 = (i0 + 1) % cols
    tx = fx - np.floor(fx)
    j0 = np.floor(fy).astype(np.int64)
    j1 = np.minimum(j0 + 1, rows - 1)
    ty = fy - j0
    a = arr[j0, i0]
    b = arr[j0, i1]
    c = arr[j1, i0]
    d = arr[j1, i1]
    # unwrap x discontinuities for unwarped raw-coordinate fields
    b = np.where(b - a > MAP_W / 2, b - MAP_W, b)
    b = np.where(b - a < -MAP_W / 2, b + MAP_W, b)
    d = np.where(d - c > MAP_W / 2, d - MAP_W, d)
    d = np.where(d - c < -MAP_W / 2, d + MAP_W, d)
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty


# ------------------------------------------------------------------ geometry helpers
def densify_raw(x, y, step=8.0):
    """Densify an unwrapped raw Miller polyline, return arrays."""
    if len(x) < 2:
        return x, y
    ox, oy = [x[0]], [y[0]]
    for i in range(1, len(x)):
        d = math.hypot(x[i] - x[i - 1], y[i] - y[i - 1])
        n = max(1, int(math.ceil(d / step)))
        for k in range(1, n + 1):
            t = k / n
            ox.append(x[i - 1] + (x[i] - x[i - 1]) * t)
            oy.append(y[i - 1] + (y[i] - y[i - 1]) * t)
    return np.asarray(ox), np.asarray(oy)


def densify_ring(ring, step=8.0):
    arr = np.asarray(ring, dtype=np.float64)
    if arr.shape[0] < 2:
        return arr
    out = []
    for i in range(arr.shape[0] - 1):
        a, b = arr[i], arr[i + 1]
        d = math.hypot(b[0] - a[0], b[1] - a[1])
        n = max(1, int(math.ceil(d / step)))
        for k in range(n):
            t = k / n
            out.append(a + (b - a) * t)
    out.append(arr[-1])
    return np.asarray(out)


def split_line(coords, tol=0.0):
    """Clip an unwrapped projected LineString to one map period; return pieces."""
    if len(coords) < 2:
        return []
    ls = LineString(coords)
    pieces = []
    kmin = int(math.floor(ls.bounds[0] / MAP_W)) - 1
    kmax = int(math.floor(ls.bounds[2] / MAP_W)) + 1
    for k in range(kmin, kmax + 1):
        inter = ls.intersection(box(k * MAP_W, 0, (k + 1) * MAP_W, MAP_H))
        if inter.is_empty:
            continue
        geoms = [inter] if inter.geom_type == "LineString" else list(getattr(inter, "geoms", []))
        for g in geoms:
            if g.geom_type != "LineString" or len(g.coords) < 2:
                continue
            arr = np.asarray(g.coords, dtype=np.float64)
            arr[:, 0] -= k * MAP_W
            pieces.append(arr)
    return pieces


def split_polygon(rings):
    """Clip a projected polygon (list of rings, unwrapped) to one map period."""
    if not rings:
        return []
    poly = Polygon(rings[0], rings[1:])
    if not poly.is_valid:
        poly = poly.buffer(0)
    out = []
    kmin = int(math.floor(poly.bounds[0] / MAP_W)) - 1
    kmax = int(math.floor(poly.bounds[2] / MAP_W)) + 1
    for k in range(kmin, kmax + 1):
        inter = poly.intersection(box(k * MAP_W, 0, (k + 1) * MAP_W, MAP_H))
        if inter.is_empty:
            continue
        geoms = [inter] if inter.geom_type == "Polygon" else list(getattr(inter, "geoms", []))
        for g in geoms:
            if g.geom_type != "Polygon" or g.area < 1.0:
                continue
            ext = np.asarray(g.exterior.coords, dtype=np.float64)
            ext[:, 0] -= k * MAP_W
            holes = []
            for h in g.interiors:
                arr = np.asarray(h.coords, dtype=np.float64)
                arr[:, 0] -= k * MAP_W
                holes.append(arr)
            out.append([ext, *holes])
    return out


def round_half(values):
    return np.round(np.asarray(values) * 2.0) / 2.0


def flat_coords(arr):
    return [float(v) for v in round_half(np.asarray(arr).ravel())]

# ------------------------------------------------------------------ terrain
def load_land_polygons():
    path = OUT / "land.json"
    if not path.exists():
        raise FileNotFoundError(f"{path} missing; run `node tools/build-board.mjs` first")
    return json.loads(path.read_text())


def rasterize_land_raw(land, width=4096):
    """Unwarped land mask in raw Miller space at `width` px."""
    height = int(round(width * MAP_H / MAP_W))
    sx, sy = width / MAP_W, height / MAP_H
    img = Image.new("L", (width, height), 0)
    dr = ImageDraw.Draw(img)
    for poly in land["polygons"]:
        if not poly:
            continue
        for ri, ring in enumerate(poly):
            if len(ring) < 6:
                continue
            pts = np.asarray(ring, dtype=np.float64).reshape(-1, 2)
            pts[:, 0] *= sx
            pts[:, 1] *= sy
            fill = 255 if ri == 0 else 0
            for shift in (-width, 0, width):
                xs = pts[:, 0] + shift
                if xs.max() < 0 or xs.min() > width:
                    continue
                dr.polygon(list(zip(xs.tolist(), pts[:, 1].tolist())), fill=fill)
    return img


def rasterize_land_warped(land, width=TERRAIN_W):
    """Land mask directly in warped map space at output resolution (2x supersampled)."""
    height = int(round(width * MAP_H / MAP_W))
    draw_w, draw_h = width * 2, height * 2
    sx, sy = draw_w / MAP_W, draw_h / MAP_H
    img = Image.new("L", (draw_w, draw_h), 0)
    dr = ImageDraw.Draw(img)
    for poly in land["polygons"]:
        if not poly:
            continue
        for ri, ring in enumerate(poly):
            if len(ring) < 6:
                continue
            pts = np.asarray(ring, dtype=np.float64).reshape(-1, 2)
            pts[:, 0] *= sx
            pts[:, 1] *= sy
            fill = 255 if ri == 0 else 0
            for shift in (-draw_w, 0, draw_w):
                xs = pts[:, 0] + shift
                if xs.max() < 0 or xs.min() > draw_w:
                    continue
                dr.polygon(list(zip(xs.tolist(), pts[:, 1].tolist())), fill=fill)
    return img.resize((width, height), Image.LANCZOS)


def sample_image_rgb(arr, sx, sy, chunk_rows=96):
    """Bilinear sample an HxWx3 uint8 image; sx/sy are 2-D pixel-center coords."""
    h, w = arr.shape[:2]
    out = np.empty(sx.shape + (3,), dtype=np.float32)
    for y0 in range(0, sx.shape[0], chunk_rows):
        y1 = min(sx.shape[0], y0 + chunk_rows)
        coords = [np.clip(sy[y0:y1], 0, h - 1.001), np.mod(sx[y0:y1], w)]
        for c in range(3):
            out[y0:y1, :, c] = map_coordinates(arr[:, :, c], coords, order=1, mode="nearest")
    return out


def build_terrain(warp, land_mode="auto"):
    t0 = time.time()
    print("terrain:")
    src_path = CACHE / "ne2" / "NE2_50M_SR_W" / "NE2_50M_SR_W.tif"
    src = Image.open(src_path).convert("RGB")
    if src.width > 6000:
        src = src.resize((5400, 2700), Image.LANCZOS)
    src_arr = np.asarray(src, dtype=np.uint8)
    SW, SH = src.size
    print(f"  source {SW}x{SH}")

    inv_rx, inv_ry = inverse_grid(warp, 2048, 954)
    OW, OH = TERRAIN_W, TERRAIN_H
    xs = (np.arange(OW) + 0.5) * MAP_W / OW
    ys = (np.arange(OH) + 0.5) * MAP_H / OH
    PX, PY = np.meshgrid(xs, ys)
    RX = sample_grid(inv_rx, PX, PY)
    RY = sample_grid(inv_ry, PX, PY)
    lon, lat = unproject_raw(RX, RY)
    sx = (lon + 180.0) / 360.0 * SW - 0.5
    sy = (90.0 - lat) / 180.0 * SH - 0.5
    print("  sampling shaded relief ...")
    raw = np.clip(sample_image_rgb(src_arr, sx, sy), 0, 255).astype(np.uint8)
    del src_arr, src
    print(f"    sampled in {time.time() - t0:.1f}s")

    # median smoothing kills raster noise but keeps the plateau structure
    smoothed = np.asarray(
        Image.fromarray(raw).filter(ImageFilter.MedianFilter(5)).filter(ImageFilter.GaussianBlur(1.0)),
        dtype=np.float32,
    ) / 255.0
    del raw
    hsv = np.asarray(
        Image.fromarray((smoothed * 255).astype(np.uint8)).convert("HSV"), dtype=np.float32
    )
    hue = hsv[:, :, 0] * (360.0 / 255.0)
    sat = hsv[:, :, 1] / 255.0
    val = hsv[:, :, 2] / 255.0
    del hsv
    hue = gaussian_filter(hue, sigma=4.0)
    sat = gaussian_filter(sat, sigma=4.0)
    val = gaussian_filter(val, sigma=4.0)
    lum = 0.299 * smoothed[:, :, 0] + 0.587 * smoothed[:, :, 1] + 0.114 * smoothed[:, :, 2]
    relief = np.clip((lum - gaussian_filter(lum, sigma=22)) / 0.22, -1.2, 1.2)
    warm = smoothed[:, :, 0] - smoothed[:, :, 2]

    # low-frequency climate noise keeps biome boundaries organic
    rng = np.random.default_rng(20261123)
    cnoise = gaussian_filter(rng.normal(0, 1, (max(2, OH // 8), max(2, OW // 8))), sigma=2.0)
    cnoise = np.asarray(Image.fromarray(((cnoise - cnoise.min()) / (np.ptp(cnoise) + 1e-9) * 255).astype(np.uint8))
                        .resize((OW, OH), Image.BICUBIC), dtype=np.float32) / 255.0 * 2 - 1
    lat_noise = lat + cnoise * 3.5

    def ss(x, a, b):
        t = np.clip((x - a) / (b - a), 0, 1)
        return t * t * (3 - 2 * t)

    abslat = np.abs(lat_noise)
    val_s = gaussian_filter(val, sigma=12)
    sat_s = gaussian_filter(sat, sigma=8)
    w_des = ss(warm, 0.02, 0.10) * ss(hue, 18, 32) * (1 - ss(hue, 66, 82)) * ss(val_s, 0.60, 0.72)
    w_grass = ss(hue, 52, 66) * (1 - ss(hue, 76, 90)) * (1 - w_des) * ss(warm, 0.015, 0.055) * 0.9
    w_trop = (1 - ss(abslat, 26, 36)) * ss(hue, 88, 104)
    w_tundra = ss(lat_noise, 47, 64) * (1 - w_des) * 0.95
    w_rock = np.clip(ss(-sat_s, -0.14, -0.06) * ss(-val_s, -0.72, -0.55) * 0.85 + 0.35 * ss(relief, 0.35, 0.8), 0, 1)
    w_snow = ss(val_s, 0.87, 0.96) * (1 - ss(sat_s, 0.08, 0.18)) * ss(abslat, 40, 60)
    w_snow = np.clip(w_snow + 0.9 * ss(relief, 0.45, 0.9) * ss(val_s, 0.68, 0.82) * ss(abslat, 20, 40), 0, 1)
    w_ice = np.clip((ss(sat_s, -0.14, -0.04) * ss(abslat, 66, 78)
                     + ss(val_s, 0.92, 0.99) * ss(-sat_s, -0.12, -0.04)) * 0.9, 0, 1)
    # stylised mountain ranges: local relief texture, not satellite shading
    tex = gaussian_filter(lum * lum, sigma=14) - gaussian_filter(lum, sigma=14) ** 2
    p_lo, p_hi = np.percentile(tex, 86), np.percentile(tex, 99.5)
    w_mtn = ss(tex, p_lo, p_hi) * ss(abslat, 15, 45) * (1 - ss(sat_s, 0.12, 0.24))
    w_rock = np.clip(w_rock + 0.60 * w_mtn, 0, 1)
    w_snow = np.clip(w_snow + 1.15 * w_mtn * ss(val_s, 0.58, 0.76), 0, 1)

    t = np.clip((val_s - 0.40) / 0.38, 0, 1)

    def ramp(dark, light):
        d = np.array(dark, dtype=np.float32)
        l = np.array(light, dtype=np.float32)
        return d[None, None, :] + (l - d)[None, None, :] * t[:, :, None]

    forest = ramp([56, 138, 66], [118, 194, 82])
    tropical = ramp([40, 124, 64], [88, 178, 84])
    grass = ramp([148, 198, 86], [210, 226, 130])
    desert = ramp([214, 178, 112], [246, 226, 172])
    tundra = ramp([168, 188, 150], [210, 222, 192])
    rock = ramp([110, 96, 76], [176, 156, 126])

    col = forest * (1 - w_trop[:, :, None]) + tropical * w_trop[:, :, None]
    col = col * (1 - w_grass[:, :, None]) + grass * w_grass[:, :, None]
    col = col * (1 - w_des[:, :, None]) + desert * w_des[:, :, None]
    col = col * (1 - w_tundra[:, :, None]) + tundra * w_tundra[:, :, None]
    col = col * (1 - w_rock[:, :, None]) + rock * w_rock[:, :, None]
    col = col * (1 - w_snow[:, :, None]) + np.array([250, 252, 248], dtype=np.float32)[None, None, :] * w_snow[:, :, None]
    col = col * (1 - w_ice[:, :, None]) + np.array([222, 240, 248], dtype=np.float32)[None, None, :] * w_ice[:, :, None]
    del forest, tropical, grass, desert, tundra, rock

    # soft directional hillshade from a smoothed elevation proxy (NW light)
    elev = gaussian_filter(lum, sigma=40)
    gy, gx = np.gradient(elev)
    shade = np.clip((gx * 5.0 - gy * 5.0), -1.0, 1.0)
    col *= 1.0 + 0.055 * shade[:, :, None]
    # a little hand-painted texture
    noise = gaussian_filter(rng.normal(0, 1, (max(2, OH // 4), max(2, OW // 4))), sigma=1.6)
    noise = (noise - noise.min()) / (np.ptp(noise) + 1e-9)
    noise = np.asarray(
        Image.fromarray((noise * 255).astype(np.uint8)).resize((OW, OH), Image.BICUBIC),
        dtype=np.float32,
    ) / 255.0 * 2 - 1
    col *= 1.0 + 0.022 * noise[:, :, None] + 0.030 * cnoise[:, :, None]
    del noise, shade, elev, gx, gy

    # alpha from land.json (raw sampling or direct warped rasterisation)
    land = load_land_polygons()
    warp_path = ROOT / "src/data/warp.json"
    if land_mode == "auto":
        land_mode = "warped" if (OUT / "land.json").stat().st_mtime >= warp_path.stat().st_mtime else "raw"
    print(f"  land mask mode: {land_mode}")
    if land_mode == "warped":
        mask_img = rasterize_land_warped(land, OW)
        alpha = np.asarray(mask_img, dtype=np.float32)
    else:
        raw_mask = rasterize_land_raw(land, 4096)
        alpha = map_coordinates(
            np.asarray(raw_mask, dtype=np.float32),
            [RY / MAP_H * raw_mask.height, RX / MAP_W * raw_mask.width],
            order=1, mode="grid-wrap",
        )
    alpha_img = Image.fromarray(np.clip(alpha, 0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(0.9))
    alpha = np.asarray(alpha_img, dtype=np.float32) / 255.0
    print(f"  alpha coverage {alpha.mean():.3f}")

    # beach rim + remove source-water blue that leaked inside the land mask
    land_bin = alpha > 0.5
    dist = distance_transform_edt(land_bin)
    rim = np.clip((4.0 - dist) / 4.0, 0, 1) * land_bin
    col = col * (1 - 0.35 * rim[:, :, None]) + np.array([239, 221, 172], dtype=np.float32)[None, None, :] * (0.35 * rim[:, :, None])
    # source shelf water can leak inside a simplified land mask; paint it as beach
    water = (hue > 168) & (sat > 0.06) & (smoothed[:, :, 2] > smoothed[:, :, 0] + 0.015) & (val_s < 0.88) & land_bin
    if water.any():
        col[water] = (236, 215, 168)
    del water, dist, rim, land_bin

    col = np.clip(col, 0, 255)
    hsv2 = np.asarray(Image.fromarray(col.astype(np.uint8)).convert("HSV"), dtype=np.float32)
    hsv2[:, :, 1] = np.clip(hsv2[:, :, 1] * 1.18 + 4, 0, 255)
    hsv2[:, :, 2] = np.clip(hsv2[:, :, 2] * 1.03 + 2, 0, 255)
    col = np.asarray(Image.fromarray(hsv2.astype(np.uint8), "HSV").convert("RGB"), dtype=np.uint8)
    rgba = np.dstack([col, np.clip(alpha * 255, 0, 255).astype(np.uint8)])
    rgba[rgba[:, :, 3] == 0, :3] = (70, 160, 200)  # constant under transparent ocean
    img = Image.fromarray(rgba, "RGBA")
    OUT.mkdir(parents=True, exist_ok=True)
    terrain_path = OUT / "terrain.webp"
    img.save(terrain_path, "WEBP", quality=85, method=6)
    lo = img.resize((LO_W, LO_H), Image.LANCZOS)
    lo_path = OUT / "terrain_lo.webp"
    lo.save(lo_path, "WEBP", quality=82, method=6)
    print(f"  terrain.webp {terrain_path.stat().st_size / 1e6:.2f} MB, terrain_lo.webp {lo_path.stat().st_size / 1e3:.0f} KB")
    if terrain_path.stat().st_size > 3.5 * 1e6:
        print("  WARNING: terrain.webp exceeds 3.5 MB")
    # keep a lossless-ish PNG for previews only
    img.resize((2048, int(round(2048 * MAP_H / MAP_W))), Image.LANCZOS).save(TMP / "terrain-preview.png")
    print(f"  done in {time.time() - t0:.1f}s")


# ------------------------------------------------------------------ hydrography
RIVER_WIDTH = {1: 6.0, 2: 5.2, 3: 4.4, 4: 3.6, 5: 2.9, 6: 2.3}

RIVER_JA = {
    "Nile": "ナイル川", "Amazonas": "アマゾン川", "Yangtze": "長江", "Mississippi": "ミシシッピ川",
    "Danube": "ドナウ川", "Rhine": "ライン川", "Ganges": "ガンジス川", "Volga": "ヴォルガ川",
    "Mekong": "メコン川", "Congo": "コンゴ川", "Niger": "ニジェール川", "Zambezi": "ザンベジ川",
    "Ob": "オビ川", "Lena": "レナ川", "Amur": "アムール川", "Indus": "インダス川",
    "Euphrates": "ユーフラテス川", "Tigris": "チグリス川", "Yukon": "ユーコン川",
    "Mackenzie": "マッケンジー川", "Murray": "マレー川", "Orinoco": "オリノコ川",
    "Brahmaputra": "ブラマプトラ川", "Colorado": "コロラド川", "Rio Grande": "リオグランデ川",
    "Magdalena": "マグダレナ川", "Volta": "ヴォルタ川", "Orange": "オレンジ川",
    "Darling": "ダーリング川", "Paranaíba": "パラナイバ川", "Tobol": "トボル川",
    "Angara": "アンガラ川", "Alabama": "アラバマ川", "Churchill": "チャーチル川",
    "Columbia": "コロンビア川", "Dniester": "ドニエストル川", "Victoria Nile": "ヴィクトリアナイル川",
    "Albert Nile": "アルバートナイル川", "Athabasca": "アサバスカ川", "Back": "バック川",
    "Coppermine": "コッパーマイン川", "Biya": "ビヤ川", "Dalälven": "ダルエルヴェン川",
    "Kama": "カマ川", "Abay": "アバイ川", "Al Furat": "ユーフラテス川",
}
LAKE_JA = {
    "Caspian Sea": "カスピ海", "Lake Baikal": "バイカル湖", "Lake Victoria": "ヴィクトリア湖",
    "Lake Superior": "スペリオル湖", "Lake Michigan": "ミシガン湖", "Lake Huron": "ヒューロン湖",
    "Lake Erie": "エリー湖", "Lake Ontario": "オンタリオ湖", "Lake Tanganyika": "タンガニーカ湖",
    "Lake Malawi": "マラウイ湖", "Lago Titicaca": "チチカカ湖", "Biwa Ko": "琵琶湖",
    "South Aral Sea": "アラル海", "North Aral Sea": "アラル海", "Lake Ladoga": "ラドガ湖",
    "Lake Chad": "チャド湖", "Lake Winnipeg": "ウィニペグ湖", "Great Bear Lake": "グレートベア湖",
    "Great Slave Lake": "グレートスレーブ湖", "Lake Balkhash": "バルハシ湖",
    "Lake Onega": "オネガ湖", "Lake Tana": "タナ湖", "Lago de Nicaragua": "ニカラグア湖",
    "Issyk-Kul": "イシク・クル", "Lake Eyre North": "エア湖", "Lake Vänern": "ヴェーネルン湖",
    "Lake Saimaa": "サイマー湖", "Lake Taymyr": "タイミル湖", "Lake Athabasca": "アサバスカ湖",
}

CASPIAN = [
    (48.5, 46.8), (50.0, 47.1), (51.5, 47.0), (53.0, 46.5), (53.8, 45.2), (52.8, 44.5),
    (51.3, 44.4), (50.3, 44.2), (51.1, 43.0), (52.6, 42.0), (53.0, 40.6), (54.0, 39.8),
    (53.4, 38.0), (52.0, 37.0), (50.0, 37.0), (49.0, 38.2), (49.7, 40.0), (48.5, 41.5),
    (47.5, 42.6), (47.0, 44.0), (46.5, 45.0), (47.4, 46.1), (48.5, 46.8),
]


def unwrap_x_series(x):
    x = np.asarray(x, dtype=np.float64)
    if len(x) == 0:
        return x
    out = np.empty_like(x)
    out[0] = x[0]
    for i in range(1, len(x)):
        d = (x[i] - x[i - 1] + MAP_W / 2) % MAP_W - MAP_W / 2
        out[i] = out[i - 1] + d
    return out


def project_lonlat_line(coords, warp: Warp, densify=8.0):
    arr = np.asarray(coords, dtype=np.float64)
    if len(arr) < 2:
        return None
    lon, lat = arr[:, 0], arr[:, 1]
    x, y = project_raw(lon, lat)
    x = unwrap_x_series(x)
    x, y = densify_raw(x, y, step=densify)
    wx, wy = warp.forward(x, y)
    wx = unwrap_x_series(wx)
    return np.column_stack([wx, wy])


def project_lonlat_ring(coords, warp: Warp, densify=8.0):
    arr = np.asarray(coords, dtype=np.float64)
    if len(arr) < 4:
        return None
    lon, lat = arr[:, 0], arr[:, 1]
    x, y = project_raw(lon, lat)
    x = unwrap_x_series(x)
    if abs(x[-1] - x[0]) < 1e-6:
        x[-1] = x[0]
    pts = densify_ring(np.column_stack([x, y]), step=densify)
    wx, wy = warp.forward(pts[:, 0], pts[:, 1])
    wx = unwrap_x_series(wx)
    return np.column_stack([wx, wy])


def polyline_length(pts):
    if len(pts) < 2:
        return 0.0
    return float(np.sum(np.hypot(np.diff(pts[:, 0]), np.diff(pts[:, 1]))))


def build_rivers(warp: Warp, data):
    t0 = time.time()
    print("rivers:")
    geo = json.loads(data["rivers"].read_text())
    out = []
    for ft in geo["features"]:
        props = ft["properties"]
        if (props.get("featurecla") or "") != "River":
            continue
        rank = props.get("scalerank")
        if rank is None or rank > 6:
            continue
        geom = ft["geometry"]
        parts = geom["coordinates"] if geom["type"] == "MultiLineString" else [geom["coordinates"]]
        for part in parts:
            pts = project_lonlat_line(part, warp, densify=8.0)
            if pts is None:
                continue
            ls = LineString(pts).simplify(1.0, preserve_topology=False)
            if ls.is_empty or ls.length < 8:
                continue
            for piece in split_line(np.asarray(ls.coords)):
                if polyline_length(piece) < 8:
                    continue
                name = props.get("name") or ""
                entry = {
                    "rank": int(rank),
                    "w": RIVER_WIDTH.get(int(rank), 2.3),
                    "pts": flat_coords(piece),
                }
                if name:
                    entry["name"] = name
                ja = RIVER_JA.get(name)
                if ja:
                    entry["nameJa"] = ja
                out.append(entry)
    out.sort(key=lambda r: (r["rank"], r.get("name", "")))
    payload = {"w": MAP_W, "h": MAP_H, "rivers": out}
    path = OUT / "rivers.json"
    path.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    print(f"  {len(out)} river pieces, {path.stat().st_size / 1024:.0f} KB, {time.time() - t0:.1f}s")


def build_lakes(warp: Warp, data):
    t0 = time.time()
    print("lakes:")
    by_name = {}
    names50 = set()
    geo50 = json.loads(data["lakes50"].read_text())
    for ft in geo50["features"]:
        name = (ft["properties"].get("name") or "").strip()
        if not name:
            continue
        names50.add(name)
        by_name[name] = ft
    # 10m adds only the famous lakes missing from 50m (Biwa, Aral, ...)
    for ft in json.loads(data["lakes10"].read_text())["features"]:
        name = (ft["properties"].get("name") or "").strip()
        if not name or name in names50 or name not in LAKE_JA:
            continue
        by_name[name] = ft
    out = []
    for name, ft in sorted(by_name.items(), key=lambda kv: -shape(kv[1]["geometry"]).area):
        geom = shape(ft["geometry"])
        polys = [geom] if geom.geom_type == "Polygon" else list(getattr(geom, "geoms", []))
        for poly in polys:
            if poly.is_empty:
                continue
            ext = project_lonlat_ring(poly.exterior.coords, warp, densify=6.0)
            if ext is None:
                continue
            holes = []
            for h in poly.interiors:
                hp = project_lonlat_ring(h.coords, warp, densify=6.0)
                if hp is not None:
                    holes.append(hp)
            # area in map units^2 (shoelace of the outer ring)
            a = abs(float(np.dot(ext[:, 0], np.roll(ext[:, 1], 1)) - np.dot(ext[:, 1], np.roll(ext[:, 0], 1)))) / 2
            famous = name in LAKE_JA
            if not famous and a < 15:
                continue
            if a < 6:
                continue
            for piece in split_polygon([ext, *holes]):
                outer = piece[0]
                if len(outer) < 4:
                    continue
                rings = [flat_coords(outer)]
                for h in piece[1:]:
                    if len(h) >= 4:
                        rings.append(flat_coords(h))
                ja = LAKE_JA.get(name) or ft["properties"].get("name_ja")
                entry = {"rank": int(ft["properties"].get("scalerank") or 0), "rings": rings}
                entry["name"] = name
                if ja:
                    entry["nameJa"] = ja
                out.append(entry)
    # hand-authored Caspian (Natural Earth's lake layer omits it)
    cas = project_lonlat_ring(CASPIAN, warp, densify=6.0)
    if cas is not None:
        for piece in split_polygon([cas]):
            out.append({"name": "Caspian Sea", "nameJa": "カスピ海", "rank": 0,
                        "rings": [flat_coords(piece[0])] + [flat_coords(h) for h in piece[1:] if len(h) >= 4]})
    out.sort(key=lambda l: -abs(np.dot(np.array(l["rings"][0][0::2]), np.roll(np.array(l["rings"][0][1::2]), 1))
                                - np.dot(np.array(l["rings"][0][1::2]), np.roll(np.array(l["rings"][0][0::2]), 1))))
    payload = {"w": MAP_W, "h": MAP_H, "lakes": out}
    path = OUT / "lakes.json"
    path.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    print(f"  {len(out)} lake pieces, {path.stat().st_size / 1024:.0f} KB, {time.time() - t0:.1f}s")


def build_borders(warp: Warp, data):
    t0 = time.time()
    print("borders:")
    geo = json.loads(data["mesh"].read_text())
    out = []
    for ft in geo["features"]:
        geom = ft["geometry"]
        coords = geom["coordinates"]
        if len(coords) < 2:
            continue
        pts = project_lonlat_line(coords, warp, densify=10.0)
        if pts is None:
            continue
        ls = LineString(pts).simplify(1.4, preserve_topology=False)
        if ls.is_empty:
            continue
        for piece in split_line(np.asarray(ls.coords)):
            if polyline_length(piece) < 8:
                continue
            out.append(flat_coords(piece))
    payload = {"w": MAP_W, "h": MAP_H, "lines": out}
    path = OUT / "borders.json"
    path.write_text(json.dumps(payload, separators=(",", ":")))
    print(f"  {len(out)} border pieces, {path.stat().st_size / 1024:.0f} KB, {time.time() - t0:.1f}s")
    if path.stat().st_size > 400 * 1024:
        print("  WARNING: borders.json exceeds 400 KB")


# ------------------------------------------------------------------ labels
OCEAN_SEAS = [
    ("太平洋", 170.0, 22.0, "ocean", 150, 0.08, 1.1, 0),
    ("太平洋", -155.0, -18.0, "ocean", 140, 0.08, 1.1, 0),
    ("大西洋", -34.0, 18.0, "ocean", 120, 0.08, 1.1, 0),
    ("インド洋", 78.0, -22.0, "ocean", 120, 0.08, 1.1, 0),
    ("北極海", -20.0, 77.0, "ocean", 80, 0.1, 1.0, 0),
    ("南極海", 10.0, -51.5, "ocean", 90, 0.1, 1.0, 0),
    ("地中海", 15.0, 36.5, "sea", 56, 0.13, 1.2, -8),
    ("カリブ海", -73.0, 15.0, "sea", 52, 0.13, 1.2, 0),
    ("日本海", 134.0, 40.0, "sea", 44, 0.15, 1.4, 34),
    ("南シナ海", 114.0, 13.0, "sea", 50, 0.15, 1.4, 18),
    ("アラビア海", 63.0, 15.0, "sea", 54, 0.13, 1.2, 0),
    ("ベンガル湾", 88.0, 15.0, "sea", 48, 0.15, 1.3, 0),
    ("メキシコ湾", -89.0, 24.5, "sea", 46, 0.15, 1.3, 0),
    ("北海", 3.5, 56.0, "sea", 34, 0.2, 1.5, 0),
    ("バルト海", 19.0, 57.0, "sea", 32, 0.2, 1.5, 62),
    ("黒海", 36.5, 43.5, "sea", 34, 0.2, 1.5, 0),
    ("紅海", 40.0, 20.5, "sea", 34, 0.18, 1.4, 56),
    ("ペルシャ湾", 53.0, 26.5, "sea", 32, 0.2, 1.5, -30),
    ("オホーツク海", 150.0, 55.0, "sea", 44, 0.15, 1.3, 0),
    ("タスマン海", 160.0, -38.0, "sea", 46, 0.13, 1.2, 0),
    ("ベーリング海", -175.0, 57.0, "sea", 42, 0.15, 1.3, 0),
    ("アンダマン海", 96.0, 9.0, "sea", 30, 0.22, 1.6, 62),
    ("セレベス海", 122.0, 2.0, "sea", 30, 0.22, 1.6, 0),
    ("ソロモン海", 155.0, -8.0, "sea", 32, 0.2, 1.5, 0),
]

CONTINENTS = [
    ("アジア", 92.0, 47.0, 170, 0.08, 0.5),
    ("ヨーロッパ", 18.0, 52.0, 120, 0.1, 0.6),
    ("アフリカ", 20.0, 3.0, 150, 0.08, 0.5),
    ("北アメリカ", -101.0, 45.0, 150, 0.08, 0.5),
    ("南アメリカ", -60.0, -14.0, 130, 0.08, 0.5),
    ("オセアニア", 162.0, -10.0, 110, 0.1, 0.6),
]

# ADMIN: (label size in map units, minZoom)
COUNTRY_LABELS = {
    "Russia": (86, 0.12), "Canada": (76, 0.12), "China": (72, 0.13),
    "United States of America": (72, 0.13), "Brazil": (66, 0.13), "Australia": (62, 0.13),
    "India": (56, 0.15), "Argentina": (50, 0.15), "Kazakhstan": (48, 0.15),
    "Algeria": (44, 0.16), "Democratic Republic of the Congo": (46, 0.16),
    "Mexico": (42, 0.16), "Indonesia": (44, 0.16), "Saudi Arabia": (42, 0.16),
    "Libya": (40, 0.17), "Iran": (40, 0.17), "Mongolia": (40, 0.17),
    "Peru": (38, 0.18), "Chad": (38, 0.18), "Niger": (38, 0.18), "Angola": (38, 0.18),
    "Mali": (36, 0.18), "South Africa": (38, 0.17), "Colombia": (38, 0.18),
    "Ethiopia": (38, 0.18), "Bolivia": (36, 0.18), "Mauritania": (34, 0.2),
    "Egypt": (36, 0.18), "United Republic of Tanzania": (34, 0.2),
    "Nigeria": (36, 0.18), "Venezuela": (36, 0.2), "Namibia": (34, 0.2),
    "Mozambique": (34, 0.2), "Pakistan": (36, 0.18), "Turkey": (36, 0.18),
    "Chile": (34, 0.2), "Zambia": (34, 0.2), "Myanmar": (34, 0.2),
    "Afghanistan": (34, 0.2), "Somalia": (32, 0.2), "Central African Republic": (32, 0.22),
    "South Sudan": (32, 0.22), "Ukraine": (34, 0.2), "Madagascar": (30, 0.22),
    "Botswana": (30, 0.22), "Kenya": (32, 0.2), "France": (34, 0.2), "Spain": (34, 0.2),
    "Sweden": (32, 0.22), "Norway": (30, 0.22), "Finland": (30, 0.22),
    "Germany": (30, 0.22), "Poland": (30, 0.22), "Italy": (30, 0.22),
    "United Kingdom": (28, 0.24), "Romania": (28, 0.24), "Belarus": (28, 0.24),
    "Greece": (26, 0.26), "Hungary": (26, 0.26), "Japan": (30, 0.22),
    "South Korea": (24, 0.3), "Vietnam": (30, 0.22), "Thailand": (30, 0.22),
    "Philippines": (30, 0.22), "Malaysia": (26, 0.28), "New Zealand": (28, 0.24),
    "Iraq": (30, 0.22), "Uzbekistan": (30, 0.22), "Papua New Guinea": (30, 0.22),
}
# famous river label: (Japanese, size, minZoom)
RIVER_LABELS = {
    "Nile": ("ナイル川", 30, 0.42), "Amazonas": ("アマゾン川", 32, 0.4),
    "Yangtze": ("長江", 30, 0.42), "Mississippi": ("ミシシッピ川", 30, 0.42),
    "Danube": ("ドナウ川", 26, 0.48), "Rhine": ("ライン川", 24, 0.55),
    "Ganges": ("ガンジス川", 26, 0.48), "Volga": ("ヴォルガ川", 28, 0.45),
    "Mekong": ("メコン川", 28, 0.45), "Congo": ("コンゴ川", 28, 0.45),
    "Niger": ("ニジェール川", 26, 0.48), "Zambezi": ("ザンベジ川", 26, 0.48),
    "Ob": ("オビ川", 26, 0.48), "Lena": ("レナ川", 26, 0.48),
    "Amur": ("アムール川", 26, 0.48), "Indus": ("インダス川", 26, 0.48),
    "Euphrates": ("ユーフラテス川", 24, 0.55), "Tigris": ("チグリス川", 24, 0.55),
    "Yukon": ("ユーコン川", 24, 0.55), "Mackenzie": ("マッケンジー川", 26, 0.48),
    "Murray": ("マレー川", 24, 0.55), "Orinoco": ("オリノコ川", 24, 0.55),
    "Brahmaputra": ("ブラマプトラ川", 24, 0.55), "Colorado": ("コロラド川", 24, 0.55),
    "Rio Grande": ("リオグランデ川", 24, 0.55),
}
LAKE_LABELS = {
    "Caspian Sea": ("カスピ海", 36, 0.4), "Lake Baikal": ("バイカル湖", 30, 0.45),
    "Lake Victoria": ("ヴィクトリア湖", 28, 0.5), "Lake Superior": ("スペリオル湖", 26, 0.55),
    "Lake Michigan": ("ミシガン湖", 26, 0.55), "Lake Huron": ("ヒューロン湖", 26, 0.55),
    "Lake Erie": ("エリー湖", 24, 0.6), "Lake Ontario": ("オンタリオ湖", 24, 0.6),
    "Lake Tanganyika": ("タンガニーカ湖", 26, 0.55), "Lake Malawi": ("マラウイ湖", 24, 0.6),
    "Lago Titicaca": ("チチカカ湖", 22, 0.62), "Biwa Ko": ("琵琶湖", 20, 0.7),
    "South Aral Sea": ("アラル海", 24, 0.6), "Lake Ladoga": ("ラドガ湖", 20, 0.7),
    "Lake Chad": ("チャド湖", 22, 0.62), "Lake Winnipeg": ("ウィニペグ湖", 22, 0.62),
    "Great Bear Lake": ("グレートベア湖", 22, 0.62), "Great Slave Lake": ("グレートスレーブ湖", 22, 0.62),
}


def warp_lonlat(warp: Warp, lon, lat):
    x, y = project_raw(lon, lat)
    wx, wy = warp.forward(np.array([x]), np.array([y]))
    return float(wx[0]), float(wy[0])


def country_point(geom, warp: Warp):
    """Pole of inaccessibility in lon/lat, then warped to map units."""
    polys = [geom] if geom.geom_type == "Polygon" else list(getattr(geom, "geoms", []))
    if not polys:
        return None
    polys = sorted(polys, key=lambda p: p.area, reverse=True)
    for poly in polys[:3]:
        try:
            pt = polylabel(poly, tolerance=0.5)
        except Exception:
            continue
        if pt is None:
            continue
        return warp_lonlat(warp, float(pt.x), float(pt.y))
    return None

def river_label_point(pts, frac=0.5):
    arr = np.asarray(pts, dtype=np.float64).reshape(-1, 2)
    if len(arr) < 2:
        return None
    seg = np.hypot(np.diff(arr[:, 0]), np.diff(arr[:, 1]))
    total = float(seg.sum())
    if total <= 0:
        return None
    target = total * frac
    acc = 0.0
    for i, d in enumerate(seg):
        if acc + d >= target:
            t = (target - acc) / max(d, 1e-9)
            x = arr[i, 0] + (arr[i + 1, 0] - arr[i, 0]) * t
            y = arr[i, 1] + (arr[i + 1, 1] - arr[i, 1]) * t
            ang = math.degrees(math.atan2(-(arr[i + 1, 1] - arr[i, 1]), arr[i + 1, 0] - arr[i, 0]))
            if ang > 90:
                ang -= 180
            if ang < -90:
                ang += 180
            return float(x), float(y), round(ang, 1)
        acc += d
    return None


def build_labels(warp: Warp, data):
    t0 = time.time()
    print("labels:")
    labels = []
    for text, lon, lat, kind, size, zmin, zmax, rot in OCEAN_SEAS:
        x, y = warp_lonlat(warp, lon, lat)
        labels.append({"text": text, "x": round(x, 1), "y": round(y, 1), "kind": kind,
                       "size": size, "minZoom": zmin, "maxZoom": zmax, "rotate": rot})
    for text, lon, lat, size, zmin, zmax in CONTINENTS:
        x, y = warp_lonlat(warp, lon, lat)
        labels.append({"text": text, "x": round(x, 1), "y": round(y, 1), "kind": "continent",
                       "size": size, "minZoom": zmin, "maxZoom": zmax, "rotate": 0})

    countries_geo = json.loads(data["countries"].read_text())
    by_admin = {}
    for ft in countries_geo["features"]:
        props = ft["properties"]
        admin = props.get("ADMIN") or props.get("NAME")
        if admin in COUNTRY_LABELS and admin not in by_admin:
            by_admin[admin] = ft
    missing = [a for a in COUNTRY_LABELS if a not in by_admin]
    if missing:
        print(f"  country labels missing: {missing}")
    for admin, ft in by_admin.items():
        size, zmin = COUNTRY_LABELS[admin]
        pt = country_point(shape(ft["geometry"]), warp)
        if pt is None:
            print(f"  no interior point for {admin}")
            continue
        x, y = pt
        text = ft["properties"].get("NAME_JA") or ft["properties"].get("NAME") or admin
        labels.append({"text": text, "x": round(x, 1), "y": round(y, 1), "kind": "country",
                       "size": size, "minZoom": zmin, "maxZoom": 1.8, "rotate": 0})

    lakes_group = warp_lonlat(warp, -84.5, 45.0)
    labels.append({"text": "五大湖", "x": round(lakes_group[0], 1), "y": round(lakes_group[1], 1),
                   "kind": "lake", "size": 26, "minZoom": 0.5, "maxZoom": 2.2, "rotate": 0})
    rivers_path = OUT / "rivers.json"
    if rivers_path.exists():
        rivers = json.loads(rivers_path.read_text())["rivers"]
        for name, (text, size, zmin) in RIVER_LABELS.items():
            candidates = [r for r in rivers if r.get("name") == name]
            if not candidates:
                continue
            best = max(candidates, key=lambda r: polyline_length(np.asarray(r["pts"]).reshape(-1, 2)))
            pt = river_label_point(best["pts"], 0.45)
            if pt is None:
                continue
            x, y, ang = pt
            labels.append({"text": text, "x": round(x, 1), "y": round(y, 1), "kind": "river",
                           "size": size, "minZoom": zmin, "maxZoom": 2.6, "rotate": ang})

    lakes_path = OUT / "lakes.json"
    if lakes_path.exists():
        lakes = json.loads(lakes_path.read_text())["lakes"]
        for name, (text, size, zmin) in LAKE_LABELS.items():
            candidates = [l for l in lakes if l.get("name") == name]
            if not candidates:
                continue
            best = max(candidates, key=lambda l: abs(Polygon(np.asarray(l["rings"][0]).reshape(-1, 2)).area))
            arr = np.asarray(best["rings"][0], dtype=np.float64).reshape(-1, 2)
            try:
                pt = polylabel(Polygon(arr), tolerance=1.0)
            except Exception:
                pt = Polygon(arr).representative_point()
            labels.append({"text": text, "x": round(float(pt.x), 1), "y": round(float(pt.y), 1),
                           "kind": "lake", "size": size, "minZoom": zmin, "maxZoom": 2.6, "rotate": 0})

    path = OUT / "labels.json"
    path.write_text(json.dumps(labels, ensure_ascii=False, separators=(",", ":")))
    kinds = {}
    for l in labels:
        kinds[l["kind"]] = kinds.get(l["kind"], 0) + 1
    print(f"  {len(labels)} labels {kinds}, {path.stat().st_size / 1024:.0f} KB, {time.time() - t0:.1f}s")


# ------------------------------------------------------------------ preview
OCEAN_TOP = (102, 198, 238)
OCEAN_BOTTOM = (56, 144, 206)
SHALLOW = (150, 232, 244)
RIVER = (58, 132, 174)
LAKE_FILL = (78, 174, 214)
LAKE_EDGE = (42, 110, 150)
BORDER = (86, 100, 78)
LABEL_OCEAN = (22, 86, 128)
LABEL_LAND = (54, 78, 40)
LABEL_WATER = (27, 96, 138)


def draw_rotated_text(base, text, x, y, size, fill, font_path, angle=0, stroke=2):
    try:
        font = ImageFont.truetype(font_path, size, index=0)
    except Exception:
        font = ImageFont.load_default()
    bbox = font.getbbox(text, stroke_width=stroke)
    w = bbox[2] - bbox[0] + stroke * 2 + 4
    h = bbox[3] - bbox[1] + stroke * 2 + 4
    layer = Image.new("RGBA", (max(2, w), max(2, h)), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    d.text((w / 2, h / 2), text, font=font, fill=fill, anchor="mm",
           stroke_width=stroke, stroke_fill=(255, 255, 255, 220))
    if angle:
        layer = layer.rotate(angle, resample=Image.BICUBIC, expand=True)
    base.alpha_composite(layer, (int(x - layer.width / 2), int(y - layer.height / 2)))


def dashed_polyline(draw, pts, fill, width=1, dash=7, gap=5):
    arr = np.asarray(pts, dtype=np.float64)
    if len(arr) < 2:
        return
    phase = 0.0
    on = True
    for i in range(len(arr) - 1):
        x0, y0 = arr[i]
        x1, y1 = arr[i + 1]
        seg = math.hypot(x1 - x0, y1 - y0)
        t = 0.0
        while t < seg:
            take = (dash if on else gap) - phase
            take = min(take, seg - t)
            if on and take > 0:
                a = t / seg
                b = (t + take) / seg
                draw.line([(x0 + (x1 - x0) * a, y0 + (y1 - y0) * a),
                           (x0 + (x1 - x0) * b, y0 + (y1 - y0) * b)], fill=fill, width=width)
            t += take
            phase += take
            if phase >= (dash if on else gap) - 1e-9:
                on = not on
                phase = 0.0


def build_preview(warp: Warp):
    t0 = time.time()
    print("preview:")
    Wp, Hp = 2048, int(round(2048 * MAP_H / MAP_W))
    sx, sy = Wp / MAP_W, Hp / MAP_H
    y = np.linspace(0, 1, Hp)[:, None]
    top = np.array(OCEAN_TOP, dtype=np.float32)
    bot = np.array(OCEAN_BOTTOM, dtype=np.float32)
    ocean = top[None, :] + (bot - top)[None, :] * (y ** 1.15)
    base = np.repeat(ocean[:, None, :], Wp, axis=1).astype(np.uint8)
    img = Image.fromarray(base, "RGB").convert("RGBA")

    terrain_path = OUT / "terrain.webp"
    terrain = Image.open(terrain_path).convert("RGBA").resize((Wp, Hp), Image.LANCZOS)
    alpha = terrain.getchannel("A")
    halo = alpha.filter(ImageFilter.MaxFilter(7)).filter(ImageFilter.GaussianBlur(2))
    halo_img = Image.new("RGBA", (Wp, Hp), SHALLOW + (255,))
    halo_img.putalpha(halo.point(lambda v: int(v * 0.32)))
    img.alpha_composite(halo_img)
    img.alpha_composite(terrain)

    d = ImageDraw.Draw(img)
    lakes_path = OUT / "lakes.json"
    if lakes_path.exists():
        for lake in json.loads(lakes_path.read_text())["lakes"]:
            for ri, ring in enumerate(lake["rings"]):
                arr = np.asarray(ring, dtype=np.float64).reshape(-1, 2)
                pts = [(p[0] * sx, p[1] * sy) for p in arr]
                if len(pts) < 3:
                    continue
                d.polygon(pts, fill=LAKE_FILL if ri == 0 else OCEAN_TOP, outline=LAKE_EDGE)
    river_layer = Image.new("RGBA", (Wp, Hp), (0, 0, 0, 0))
    rd = ImageDraw.Draw(river_layer)
    rivers_path = OUT / "rivers.json"
    if rivers_path.exists():
        for r in json.loads(rivers_path.read_text())["rivers"]:
            arr = np.asarray(r["pts"], dtype=np.float64).reshape(-1, 2)
            pts = [(p[0] * sx, p[1] * sy) for p in arr]
            if len(pts) >= 2:
                lw = max(1, int(round(r.get("w", 2.0) * sx * 1.2)))
                rd.line(pts, fill=RIVER + (205,), width=lw, joint="curve")
    img.alpha_composite(river_layer)
    border_layer = Image.new("RGBA", (Wp, Hp), (0, 0, 0, 0))
    bd = ImageDraw.Draw(border_layer)
    borders_path = OUT / "borders.json"
    if borders_path.exists():
        for line in json.loads(borders_path.read_text())["lines"]:
            arr = np.asarray(line, dtype=np.float64).reshape(-1, 2)
            pts = [(p[0] * sx, p[1] * sy) for p in arr]
            dashed_polyline(bd, pts, BORDER + (80,), width=1, dash=6, gap=5)
    img.alpha_composite(border_layer)

    labels_path = OUT / "labels.json"
    overview = img.copy()
    detail = img.copy()
    if labels_path.exists():
        font_bold = "/usr/share/fonts/noto-cjk/NotoSansCJK-Bold.ttc"
        font_reg = "/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc"
        labels = json.loads(labels_path.read_text())
        order = {"ocean": 0, "continent": 1, "sea": 2, "country": 3, "lake": 4, "river": 5}
        labels.sort(key=lambda l: order.get(l["kind"], 9))
        for l in labels:
            px, py = l["x"] * sx, l["y"] * sy
            fsize = max(8, int(round(l["size"] * sx * 1.05)))
            if l["kind"] in ("ocean", "continent"):
                col = LABEL_OCEAN if l["kind"] == "ocean" else LABEL_LAND
                draw_rotated_text(detail, l["text"], px, py, fsize, col, font_bold, l.get("rotate", 0), 2)
                draw_rotated_text(overview, l["text"], px, py, fsize, col, font_bold, l.get("rotate", 0), 2)
            elif l["kind"] == "sea":
                draw_rotated_text(detail, l["text"], px, py, fsize, LABEL_OCEAN, font_reg, l.get("rotate", 0), 2)
                if l["minZoom"] <= 0.17:
                    draw_rotated_text(overview, l["text"], px, py, fsize, LABEL_OCEAN, font_reg, l.get("rotate", 0), 2)
            elif l["kind"] == "country":
                draw_rotated_text(detail, l["text"], px, py, fsize, LABEL_LAND, font_reg, 0, 1)
                if l["minZoom"] <= 0.15:
                    draw_rotated_text(overview, l["text"], px, py, fsize, LABEL_LAND, font_reg, 0, 1)
            else:
                draw_rotated_text(detail, l["text"], px, py, fsize, LABEL_WATER, font_reg, l.get("rotate", 0), 1)

    overview.convert("RGB").save(TMP / "mapart-preview.png")
    boxes = {
        "europe": (700, 190, 1420, 540),
        "sahara": (700, 400, 1300, 760),
        "himalaya": (1120, 250, 1700, 600),
        "amazon": (400, 470, 850, 850),
        "japan": (1580, 280, 2010, 620),
    }
    for name, b in boxes.items():
        crop = detail.crop(b)
        crop.resize((crop.width * 2, crop.height * 2), Image.LANCZOS).convert("RGB").save(TMP / f"mapart-{name}.png")
    print(f"  .tmp/mapart-preview.png + 5 crops, {time.time() - t0:.1f}s")


# ------------------------------------------------------------------ main
def main():
    ap = argparse.ArgumentParser(description="Build the warped illustrated world-map assets.")
    ap.add_argument("--stages", default="all",
                    help="comma list of warp,terrain,hydro,borders,labels,preview or all")
    ap.add_argument("--land-mode", choices=["auto", "raw", "warped"], default="auto",
                    help="land.json coordinate space for the terrain alpha mask")
    ap.add_argument("--generate-warp", action="store_true",
                    help="legacy: regenerate warp.json from cities (default off; tools/build-warp.py owns it)")
    args = ap.parse_args()
    stages = [s.strip() for s in args.stages.split(",") if s.strip()]
    if "all" in stages:
        stages = ["warp", "terrain", "hydro", "borders", "labels", "preview"]

    print("map art build")
    data = ensure_data()
    if args.generate_warp:
        warp = generate_warp()
    else:
        warp_path = ROOT / "src/data/warp.json"
        if not warp_path.exists():
            raise SystemExit("src/data/warp.json missing; run .tmp/venv/bin/python tools/build-warp.py")
        warp = load_warp()

    if "terrain" in stages:
        build_terrain(warp, args.land_mode)
    if "hydro" in stages:
        build_rivers(warp, data)
        build_lakes(warp, data)
    if "borders" in stages:
        build_borders(warp, data)
    if "labels" in stages:
        build_labels(warp, data)
    if "preview" in stages:
        build_preview(warp)

    print("outputs:")
    for name in ("terrain.webp", "terrain_lo.webp", "rivers.json", "lakes.json", "borders.json", "labels.json"):
        p = OUT / name
        if p.exists():
            print(f"  public/assets/map/{name:18s} {p.stat().st_size / 1024:8.1f} KB")
    w = ROOT / "src/data/warp.json"
    if w.exists():
        print(f"  src/data/warp.json          {w.stat().st_size / 1024:8.1f} KB")


if __name__ == "__main__":
    main()
