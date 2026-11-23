#!/usr/bin/env python3
"""Build src/data/warp.json: the デフォルメ map deformation (docs/DESIGN.md §11).

Composition of elliptical fisheye lenses over the Miller projection. Each lens maps its
ellipse onto itself with a strictly increasing radial profile and is the identity outside,
so every lens is a homeomorphism and the composition cannot fold. Shapes stay recognizable
(no row/column shear). Output format is the one read by src/core/geo.ts and
tools/lib/project.mjs: displacement (dx, dy) sampled at the UNWARPED grid vertices.

Run: .tmp/venv/bin/python tools/build-warp.py   (prints per-region magnification + min Jacobian)
"""
import json
import math
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
MAP_W = 8192
CENTRAL_MERIDIAN = 11.0
LAT_TOP, LAT_BOTTOM = 80.0, -56.0
SCALE = MAP_W / (2 * math.pi)


def miller_y(lat):
    phi = np.radians(lat)
    return 1.25 * np.log(np.tan(np.pi / 4 + 0.4 * phi))


Y_TOP = float(miller_y(LAT_TOP))
MAP_H = round((Y_TOP - float(miller_y(LAT_BOTTOM))) * SCALE)


def project_raw(lon, lat):
    rel = ((np.asarray(lon, dtype=np.float64) - CENTRAL_MERIDIAN + 180) % 360) - 180
    x = (rel + 180) / 360 * MAP_W
    y = (Y_TOP - miller_y(np.clip(lat, LAT_BOTTOM, LAT_TOP))) * SCALE
    return x, y


# (name, lon, lat, center magnification m, semi-axis rx [deg lon], semi-axis ry [deg lat])
# Ellipses must stay inside the map vertically and must not reach the seam (lon -169).
LENSES = [
    ("Europe", 12, 49, 3.2, 38, 24),
    ("Japan/Korea", 136, 37, 2.2, 22, 17),  # gentler: keep Honshu/Kyushu/Shikoku recognizable
    ("East China", 114, 30, 2.2, 18, 15),
    ("US East/Midwest", -84, 39, 2.4, 26, 16),
    ("India", 78, 21, 1.9, 16, 15),
    ("Mexico/Caribbean", -88, 19, 1.8, 18, 12),
    ("West Africa", 0, 8, 1.5, 16, 12),
    ("SE Asia", 105, 8, 1.6, 16, 14),
    ("Middle East", 45, 30, 1.6, 15, 12),
    ("US West", -120, 38, 1.7, 10, 10),
]
P = 3  # radial profile s(u) = u + (m-1) u (1-u)^P; s' > 0 for m < 5 when P = 3


def lens_params(lon, lat, rx_deg, ry_deg):
    cx, cy = project_raw(lon, lat)
    x1, _ = project_raw(lon + rx_deg, lat)
    _, y_top = project_raw(lon, min(LAT_TOP, lat + ry_deg))
    _, y_bot = project_raw(lon, max(LAT_BOTTOM, lat - ry_deg))
    rx = float(abs(x1 - cx))
    ry = float(min(cy - y_top, y_bot - cy))  # symmetric, never crosses top/bottom edges
    return float(cx), float(cy), rx, ry


def apply_lens(x, y, cx, cy, rx, ry, m):
    dx = (x - cx + MAP_W / 2) % MAP_W - MAP_W / 2
    dy = y - cy
    u = np.sqrt((dx / rx) ** 2 + (dy / ry) ** 2)
    inside = u < 1
    s = np.where(inside, u + (m - 1) * u * (1 - u) ** P, u)
    k = np.where(u > 1e-9, s / np.maximum(u, 1e-9), m)
    return x + dx * (k - 1), y + dy * (k - 1)


def forward(x, y):
    for _, lon, lat, m, rxd, ryd in LENSES:
        cx, cy, rx, ry = lens_params(lon, lat, rxd, ryd)
        x, y = apply_lens(x, y, cx, cy, rx, ry, m)
    return x, y


def main():
    for _, lon, lat, m, *_ in LENSES:
        assert m < 5, "profile only monotone for m < 5"
    cols, rows = 512, 240
    gx = np.arange(cols) * MAP_W / cols
    gy = np.arange(rows) * MAP_H / (rows - 1)
    GX, GY = np.meshgrid(gx, gy)
    fx, fy = forward(GX.copy(), GY.copy())
    dx = np.round((fx - GX + MAP_W / 2) % MAP_W - MAP_W / 2).astype(int)
    dy = np.round(fy - GY).astype(int)

    # Jacobian check on a finer grid (finite differences of the continuous map)
    fxg = np.linspace(0, MAP_W, 2048, endpoint=False)
    fyg = np.linspace(1, MAP_H - 1, 960)
    FX, FY = np.meshgrid(fxg, fyg)
    h = 0.5
    ax, ay = forward(FX + h, FY.copy())
    bx, by = forward(FX - h, FY.copy())
    cxx, cyy = forward(FX.copy(), FY + h)
    dxx, dyy = forward(FX.copy(), FY - h)
    jxx = ((ax - bx + MAP_W / 2) % MAP_W - MAP_W / 2) / (2 * h)
    jyx = (ay - by) / (2 * h)
    jxy = ((cxx - dxx + MAP_W / 2) % MAP_W - MAP_W / 2) / (2 * h)
    jyy = (cyy - dyy) / (2 * h)
    det = jxx * jyy - jxy * jyx
    print(f"Jacobian det: min {det.min():.3f}  max {det.max():.3f}")
    assert det.min() > 0.05, "warp folds"

    for name, lon, lat, *_ in LENSES:
        x0, y0 = project_raw(lon, lat)
        x1, y1 = project_raw(lon + 2, lat)
        a = forward(np.array([x0]), np.array([y0]))
        b = forward(np.array([x1]), np.array([y1]))
        mag = abs(((b[0] - a[0] + MAP_W / 2) % MAP_W - MAP_W / 2)[0]) / abs(x1 - x0)
        print(f"  {name:18s} linear magnification at center ≈ {mag:.2f}")

    payload = {"w": MAP_W, "h": MAP_H, "cols": cols, "rows": rows,
               "dx": dx.ravel().tolist(), "dy": dy.ravel().tolist()}
    (ROOT / "src/data/warp.json").write_text(json.dumps(payload, separators=(",", ":")))
    print(f"wrote src/data/warp.json ({cols}x{rows}, H={MAP_H})")


if __name__ == "__main__":
    main()
