#!/usr/bin/env python3
"""
cut_tiles.py — cuts batched icon sheets into individual transparent tiles.

Sheets (all chroma green #00FF00, green keyed ONLY where connected to the sheet
border so enclosed green art such as trees/fruit/rainbow bands survives):

  art/raw/square_tiles.png   4x2  blue red yellow news / shop warp portal blank
      -> public/assets/tiles/<name>.webp  + tiles/small/<name>.webp
  art/raw/city_tiles.png     4x2  metro city town port / airport heaven hell space
      -> public/assets/tiles/city/<name>.webp + tiles/city/small/<name>.webp
  art/raw/city_icons_NN.png  4x4  future per-city sheets, ids from tools/art/city_motifs.json
      -> public/assets/tiles/cities/<cityId>.webp + tiles/cities/small/<cityId>.webp

Normalisation: every tile on a 256x256 transparent canvas, ONE scale per sheet so
the platform footprint matches across all sheets (the ground pad is drawn at a
consistent relative size in the source), bottoms aligned to a shared baseline.
64x64 WebP copies for UI lists.

Run: .tmp/venv/bin/python tools/art/cut_tiles.py            # all sheets
     .tmp/venv/bin/python tools/art/cut_tiles.py --sheet square
Idempotent: always regenerated from the source sheets.
"""
from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont
from scipy.ndimage import distance_transform_edt, gaussian_filter, label

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "art/raw"
TILES = ROOT / "public/assets/tiles"
TMP = ROOT / ".tmp"

SIZE = 256
SMALL = 64
PAD = 10
BASELINE = SIZE - 12
FOOTPRINT = 176          # target platform (bottom band) width in px on the 256 canvas
MIN_ENCLOSED_PX = 4      # enclosed pure-chroma holes smaller than this are left alone
WEBP_QUALITY = 90

SHEETS = [
    {
        "id": "square",
        "src": RAW / "square_tiles.png",
        "cols": 4,
        "rows": 2,
        "names": [["blue", "red", "yellow", "news"], ["shop", "warp", "portal", "blank"]],
        "out": TILES,
    },
    {
        "id": "city",
        "src": RAW / "city_tiles.png",
        "cols": 4,
        "rows": 2,
        "names": [["metro", "city", "town", "port"], ["airport", "heaven", "hell", "space"]],
        "out": TILES / "city",
    },
]


def city_icon_sheets():
    """Future 4xN per-city sheets; ids/order from city_motifs.json `sheet` groups."""
    motifs_path = ROOT / "tools/art/city_motifs.json"
    sheets = []
    for path in sorted(RAW.glob("city_icons_*.png")):
        if not motifs_path.exists():
            raise SystemExit(f"{path.name} present but tools/art/city_motifs.json is missing")
        motifs = json.loads(motifs_path.read_text())
        if not isinstance(motifs, list):
            raise SystemExit("city_motifs.json must be a list of {id, ..., sheet}")
        ids = [m["id"] for m in motifs if m.get("sheet") == path.stem]
        if not ids:
            raise SystemExit(f"no city_motifs entries with sheet == {path.stem!r}")
        cols = 4
        rows = [ids[i:i + cols] for i in range(0, len(ids), cols)]
        sheets.append({
            "id": path.stem,
            "src": path,
            "cols": cols,
            "rows": len(rows),
            "names": rows,
            "out": TILES / "cities",
        })
    return sheets

# ------------------------------------------------------------------ chroma key
def key_background(rgb: np.ndarray) -> np.ndarray:
    """Chroma green to remove.

    Pass 1: green tones connected to the sheet border (the surrounding backdrop).
    Pass 2: enclosed regions of *near pure* chroma (#00FF00: g>=200, r<=90, b<=90,
    g-max(r,b)>=150) with at least MIN_ENCLOSED_PX pixels — holes such as the inside
    of the heaven halo. Natural dark/green foliage and fruit do not satisfy the pure
    chroma test and are kept.
    """
    r, g, b = rgb[:, :, 0], rgb[:, :, 1], rgb[:, :, 2]
    green = (g > 90) & (g - np.maximum(r, b) > 25)
    lab, _ = label(green, structure=np.ones((3, 3), dtype=int))
    border = np.unique(np.concatenate([lab[0, :], lab[-1, :], lab[:, 0], lab[:, -1]]))
    border = border[border > 0]
    bg = np.isin(lab, border)

    pure = (g >= 200) & (r <= 90) & (b <= 90) & (g - np.maximum(r, b) >= 150)
    plab, pcount = label(pure, structure=np.ones((3, 3), dtype=int))
    if pcount:
        psizes = np.bincount(plab.ravel())
        keep = np.zeros(pcount + 1, dtype=bool)
        for comp in range(1, pcount + 1):
            keep[comp] = psizes[comp] >= MIN_ENCLOSED_PX
        bg |= keep[plab]
    return bg


def cell_components(fg: np.ndarray, cols: int, rows: int, sheet_id: str = "") -> dict:
    """Collect foreground components into grid cells; return mask+bbox per cell.

    Cells are located from component centroids, so a tile made of several islands
    (e.g. the airport's separate plane) is still collected as one tile.

    Repair pass: when the generator lets two neighbouring tiles touch, they become
    ONE component and the cell it is assigned to gets both while the other stays
    empty. Only then (an empty cell, never pre-emptively) is that component cut
    along the shared cell divider and relabelled. Neighbouring tiles that merely
    overhang a divider by a few px are left alone.
    """
    lab, count = label(fg, structure=np.ones((3, 3), dtype=int))
    sizes = np.bincount(lab.ravel())
    sizes[0] = 0
    h, w = fg.shape
    cw, ch = w / cols, h / rows

    def cell_of(x, y):
        return (int(np.clip(y // ch, 0, rows - 1)), int(np.clip(x // cw, 0, cols - 1)))

    comps: dict[int, np.ndarray] = {}
    owner: dict[tuple[int, int], int] = {}
    for comp in range(1, count + 1):
        if sizes[comp] < 120:
            continue
        mask = lab == comp
        ys, xs = np.nonzero(mask)
        key = cell_of(float(xs.mean()), float(ys.mean()))
        comps[comp] = mask
        owner.setdefault(key, comp)  # biggest first? sizes random; keep first

    # prefer the largest component when two land in the same cell
    for comp in sorted(comps, key=lambda c: -sizes[c]):
        ys, xs = np.nonzero(comps[comp])
        key = cell_of(float(xs.mean()), float(ys.mean()))
        if key not in owner or sizes[owner[key]] < sizes[comp]:
            owner[key] = comp

    empty = [(r, c) for r in range(rows) for c in range(cols) if (r, c) not in owner]
    for er, ec in empty:
        best = None
        for comp, mask in comps.items():
            ys, xs = np.nonzero(mask)
            in_cell = ((xs // cw).astype(int) == ec) & ((ys // ch).astype(int) == er)
            share = in_cell.sum() / len(xs)
            if share < 0.20:
                continue
            if best is None or share > best[0]:
                best = (share, comp)
        if best is None:
            print(f"  WARN: {sheet_id} cell r{er}c{ec} has no artwork")
            continue
        comp = best[1]
        mask = comps[comp]
        mys, mxs = np.nonzero(mask)
        # dominant cell of the merged component (largest pixel share)
        cell_ids = np.clip((mxs // cw).astype(int), 0, cols - 1) + cols * np.clip((mys // ch).astype(int), 0, rows - 1)
        uniq, counts = np.unique(cell_ids, return_counts=True)
        empty_id = ec + cols * er
        order = np.argsort(counts)[::-1]
        # dominant cell = biggest cell that is NOT the empty one (which owns nothing)
        dom = next((int(uniq[i]) for i in order if int(uniq[i]) != empty_id), int(uniq[order[0]]))
        dc, dr = dom % cols, dom // cols
        cut = mask.copy()
        if dr == er and dc != ec:      # side by side: cut the vertical divider between them
            x0 = int(round((min(dc, ec) + 1) * cw))
            cut[:, max(0, x0 - 1):x0 + 1] = False
        elif dc == ec and dr != er:    # stacked: cut the horizontal divider between them
            y0 = int(round((min(dr, er) + 1) * ch))
            cut[max(0, y0 - 1):y0 + 1, :] = False
        else:
            print(f"  WARN: {sheet_id} cell r{er}c{ec} empty but merged tile is diagonal; left as is")
            continue
        sub, subn = label(cut, structure=np.ones((3, 3), dtype=int))
        sub_sizes = np.bincount(sub.ravel())
        sub_sizes[0] = 0
        pieces = [p for p in range(1, subn + 1) if sub_sizes[p] >= 400]
        if len(pieces) < 2:
            print(f"  WARN: {sheet_id} cell r{er}c{ec} empty and the neighbour cannot be split")
            continue
        # assign the piece that lands in the empty cell to it, others back to their cell.
        # Pieces use synthetic ids above every real component id so they cannot
        # overwrite an unrelated tile in comps[]/owner[].
        next_id = max([*comps.keys(), *owner.values(), count]) + 1
        for piece in pieces:
            pm = sub == piece
            pys, pxs = np.nonzero(pm)
            pk = cell_of(float(pxs.mean()), float(pys.mean()))
            comps[next_id] = pm
            if pk == (er, ec) or pk not in owner or owner[pk] == comp:
                owner[pk] = next_id
            next_id += 1
        # remove the merged original
        owner = {k: v for k, v in owner.items() if v != comp}
        comps.pop(comp, None)
        print(f"  NOTE: {sheet_id} split a merged tile to fill empty cell r{er}c{ec}")

    # any cell still empty (split pieces may have landed elsewhere) -> report
    for r in range(rows):
        for c in range(cols):
            if (r, c) not in owner:
                print(f"  WARN: {sheet_id} cell r{r}c{c} has no artwork")

    out = {}
    for key, comp in owner.items():
        mask = comps[comp]
        ys, xs = np.nonzero(mask)
        out[key] = {
            "mask": mask,
            "bbox": (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1),
        }
    return out


def nearest_fill(rgb: np.ndarray, bg: np.ndarray) -> np.ndarray:
    '''Replace background colours with the nearest foreground colour.'''
    _, (iy, ix) = distance_transform_edt(bg, return_indices=True)
    filled = rgb[iy, ix].copy()
    filled[~bg] = rgb[~bg]
    return filled


def build_alpha(mask: np.ndarray) -> np.ndarray:
    soft = gaussian_filter(mask.astype(np.float32), 0.65)
    return np.clip((soft - 0.28) / 0.44, 0.0, 1.0)


def despill(rgb: np.ndarray, alpha: np.ndarray) -> np.ndarray:
    """Soft-edge colours come from the nearest opaque pixel (kills green fringe)."""
    core = alpha > 0.985
    if not core.any():
        return rgb
    _, (iy, ix) = distance_transform_edt(~core, return_indices=True)
    rim = ~core & (alpha > 0.0)
    out = rgb.copy()
    out[rim] = rgb[iy[rim], ix[rim]]
    # rim pixels can still inherit a dark green tint from the sheet background
    r, g, b = out[:, :, 0], out[:, :, 1], out[:, :, 2]
    mx = np.maximum(r, b)
    tinted = rim & (g > mx + 8.0 / 255.0)
    cap = mx + 0.15 * (g - mx)
    out[:, :, 1] = np.where(tinted, cap, g)
    return out


def footprint_width(mask: np.ndarray) -> float:
    ys, xs = np.nonzero(mask)
    h = ys.max() - ys.min() + 1
    band = ys > ys.max() - 0.18 * h
    return float(xs[band].max() - xs[band].min() + 1)


def extract_tile(rgb: np.ndarray, bg: np.ndarray, cell: dict) -> tuple[Image.Image, float]:
    x0, y0, x1, y1 = cell["bbox"]
    m = 2
    xa, ya = max(0, x0 - m), max(0, y0 - m)
    xb, yb = min(rgb.shape[1], x1 + m), min(rgb.shape[0], y1 + m)
    sub_rgb = rgb[ya:yb, xa:xb].astype(np.float32) / 255.0
    sub_mask = cell["mask"][ya:yb, xa:xb]
    filled = nearest_fill(sub_rgb, bg[ya:yb, xa:xb])
    alpha = build_alpha(sub_mask)
    filled = despill(filled, alpha)
    rgba = np.dstack([np.clip(filled * 255.0, 0, 255).astype(np.uint8),
                      (alpha * 255.0).astype(np.uint8)])
    img = Image.fromarray(rgba, "RGBA")
    bbox = img.getchannel("A").point(lambda v: 255 if v > 6 else 0).getbbox()
    if bbox:
        img = img.crop(bbox)
    return img, footprint_width(sub_mask)


def place(img: Image.Image, scale: float) -> Image.Image:
    w = max(1, int(round(img.width * scale)))
    h = max(1, int(round(img.height * scale)))
    scaled = img.resize((w, h), Image.LANCZOS)
    canvas = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    canvas.alpha_composite(scaled, ((SIZE - w) // 2, BASELINE - h))
    return canvas


# ------------------------------------------------------------------ driver
def process_sheet(sheet: dict) -> dict:
    path = sheet["src"]
    if not path.exists():
        raise SystemExit(f"missing sheet {path}")
    rgb = np.asarray(Image.open(path).convert("RGB"), dtype=np.float32)
    bg = key_background(rgb)
    cells = cell_components(~bg, sheet["cols"], sheet["rows"], sheet["id"])

    tiles = {}
    for (row, col), cell in cells.items():
        row_names = sheet["names"][row] if row < len(sheet["names"]) else []
        if col >= len(row_names):
            print(f"  WARN: artwork in empty cell r{row}c{col} of {path.name}, ignored")
            continue
        tiles[row_names[col]] = extract_tile(rgb, bg, cell)

    # one scale per sheet, driven by the platform footprint so all sheets match
    med = float(np.median([fp for _, fp in tiles.values()]))
    scale_fp = FOOTPRINT / max(med, 1.0)
    content = SIZE - 2 * PAD
    scale_fit = min(content / max(im.width for im, _ in tiles.values()),
                    content / max(im.height for im, _ in tiles.values()))
    scale = min(scale_fp, scale_fit)
    print(f"{sheet['id']}: {path.name} scale={scale:.3f} "
          f"(footprint {med:.0f}px -> {med * scale:.0f}px, fit cap {scale_fit:.3f})")

    out: Path = sheet["out"]
    (out / "small").mkdir(parents=True, exist_ok=True)
    stats = {}
    for name, (img, _) in tiles.items():
        big = place(img, scale)
        big.save(out / f"{name}.webp", "WEBP", quality=WEBP_QUALITY, method=6)
        big.resize((SMALL, SMALL), Image.LANCZOS).save(
            out / "small" / f"{name}.webp", "WEBP", quality=WEBP_QUALITY, method=6)
        stats[name] = {
            "src": [img.width, img.height],
            "big_kb": round((out / f"{name}.webp").stat().st_size / 1024, 1),
            "small_kb": round((out / "small" / f"{name}.webp").stat().st_size / 1024, 1),
        }
        print(f"  {name:9s} {img.width}x{img.height} -> 256 "
              f"{stats[name]['big_kb']:.1f} KB / 64 {stats[name]['small_kb']:.1f} KB")
    return {"id": sheet["id"], "scale": round(scale, 3), "tiles": stats, "out": str(out)}


def contact_sheets(results: list[dict], sheets: list[dict]):
    results_by_id = {r["id"]: r for r in results}
    """Per-sheet blocks (light + dark at 256), then 1:1 64px strips and 2x edge zooms."""
    groups = []
    for sheet, res in zip(sheets, results):
        names = [n for row in sheet["names"] for n in row]
        groups.append((sheet["id"], Path(res["out"]), names))

    cols = 4
    cell = 290
    tile_y = 8
    label_h = 26
    pad = 12
    header = 32
    width = cell * cols + pad * 2
    height = pad
    for _, _, names in groups:
        rows = max(1, -(-len(names) // cols))
        height += 2 * (rows * cell + header + 8)
    per_row = (width - pad * 2 - 8) // 72
    total_small = sum(len(n) for s in sheets for row in s["names"] for n in row)
    strip_rows = max(1, -(-total_small // per_row))
    height += 2 * (strip_rows * 72 + header) + (150 + header) + pad
    img = Image.new("RGBA", (width, height), (250, 250, 252, 255))
    draw = ImageDraw.Draw(img)
    try:
        font = ImageFont.truetype("/usr/share/fonts/noto-cjk/NotoSansCJK-Bold.ttc", 18)
        small_font = ImageFont.truetype("/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc", 13)
    except Exception:
        font = ImageFont.load_default()
        small_font = font

    y_cursor = pad
    for sid, out_dir, names in groups:
        rows = max(1, -(-len(names) // cols))
        block_h = rows * cell + header + 8
        for bgcol, bgname in (((246, 242, 230, 255), "明るい背景 / light"),
                              ((30, 32, 38, 255), "暗い背景 / dark")):
            draw.rectangle([pad, y_cursor, width - pad, y_cursor + block_h], fill=bgcol)
            fg = (20, 20, 20, 255) if bgcol[0] > 128 else (238, 238, 238, 255)
            draw.text((pad + 8, y_cursor + 5), f"{sid} — {bgname}", font=font, fill=fg)
            for i, name in enumerate(names):
                r, c = divmod(i, cols)
                x = pad + c * cell
                y = y_cursor + header + r * cell
                big = Image.open(out_dir / f"{name}.webp").convert("RGBA")
                img.alpha_composite(big, (x + (cell - SIZE) // 2, y + tile_y))
                draw.text((x + (cell - SIZE) // 2 + 4, y + tile_y + SIZE + 3),
                          f"{name}  {res_kb(out_dir, name)}KB", font=small_font, fill=fg)
            y_cursor += block_h

    # 1:1 64px strips, wrapped to as many rows as needed
    per_row = (width - pad * 2 - 8) // 72
    total_small = sum(len(names) for _, _, names in groups)
    strip_rows = max(1, -(-total_small // per_row))
    for bgcol, bgname in (((246, 242, 230, 255), "64px 等倍 / light"),
                          ((30, 32, 38, 255), "64px 等倍 / dark")):
        block_h = strip_rows * 72 + header
        draw.rectangle([pad, y_cursor, width - pad, y_cursor + block_h], fill=bgcol)
        fg = (20, 20, 20, 255) if bgcol[0] > 128 else (238, 238, 238, 255)
        draw.text((pad + 8, y_cursor + 5), bgname, font=font, fill=fg)
        i = 0
        for sid, out_dir, names in groups:
            for name in names:
                x = pad + 8 + (i % per_row) * 72
                y = y_cursor + header + 4 + (i // per_row) * 72
                sm = Image.open(out_dir / "small" / f"{name}.webp").convert("RGBA")
                img.alpha_composite(sm, (x, y))
                i += 1
        y_cursor += block_h

    # 2x edge zooms (bottom half of each tile, where the ground pad sits)
    zbg = (128, 128, 128, 255)
    draw.rectangle([pad, y_cursor, width - pad, y_cursor + 150 + header], fill=zbg)
    draw.text((pad + 8, y_cursor + 5), "2x 拡大（縁の緑フリンジ・接地位置）", font=font,
              fill=(255, 255, 255, 255))
    zx = pad + 8
    for sid, out_dir, names in groups:
        for name in names[:4]:
            t = Image.open(out_dir / f"{name}.webp").convert("RGBA")
            z = t.crop((28, SIZE - 128, 228, SIZE)).resize((400, 256), Image.LANCZOS)
            if zx + 210 > width - pad:
                break
            img.alpha_composite(z.resize((200, 128), Image.LANCZOS), (zx, y_cursor + header + 8))
            draw.text((zx + 2, y_cursor + header + 2), name, font=small_font, fill=(255, 255, 255, 255))
            zx += 210
        if zx > width - 220:
            break

    img = img.crop((0, 0, width, min(height, y_cursor + 150 + header + pad)))
    img.convert("RGB").save(TMP / "tiles-contact.png")
    print(f"  .tmp/tiles-contact.png ({img.width}x{img.height})")
    if len(groups) == 1:
        sid = groups[0][0]
        img.convert("RGB").save(TMP / f"tiles-contact-{sid}.png")
        print(f"  .tmp/tiles-contact-{sid}.png")
    else:
        t0 = time.time()
        for sid, out_dir, names in groups:
            per_sheet_contact(sid, out_dir, names, results_by_id[sid])
        print(f"  {len(groups)} per-sheet contact files in {time.time() - t0:.1f}s")


def motif_map(sid: str) -> dict[str, str]:
    """id -> motif text for city sheets; empty for the generic sheets."""
    path = ROOT / "tools/art/city_motifs.json"
    if not path.exists() or not sid.startswith("city_icons_"):
        return {}
    return {m["id"]: m.get("motif", "") for m in json.loads(path.read_text())
            if m.get("sheet") == sid}


def per_sheet_contact(sid: str, out_dir: Path, names: list[str], res: dict):
    """Self-contained contact image for one 4xN sheet (light + dark, 256 + 64)."""
    motifs = motif_map(sid)
    cols = 4
    cell = 268
    pad = 10
    header = 28
    rows = max(1, -(-len(names) // cols))
    width = cell * cols + pad * 2
    height = pad + 2 * (rows * cell + header + 6) + 2 * (80 + header) + pad
    img = Image.new("RGBA", (width, height), (250, 250, 252, 255))
    draw = ImageDraw.Draw(img)
    try:
        font = ImageFont.truetype("/usr/share/fonts/noto-cjk/NotoSansCJK-Bold.ttc", 16)
        small_font = ImageFont.truetype("/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc", 12)
    except Exception:
        font = ImageFont.load_default()
        small_font = font
    y = pad
    for bgcol, bgname in (((246, 242, 230, 255), "明るい背景 / light"),
                          ((30, 32, 38, 255), "暗い背景 / dark")):
        block_h = rows * cell + header + 6
        draw.rectangle([pad, y, width - pad, y + block_h], fill=bgcol)
        fg = (20, 20, 20, 255) if bgcol[0] > 128 else (238, 238, 238, 255)
        draw.text((pad + 8, y + 4), f"{sid} — {bgname}", font=font, fill=fg)
        for i, name in enumerate(names):
            r, c = divmod(i, cols)
            x = pad + c * cell
            yy = y + header + r * cell
            big = Image.open(out_dir / f"{name}.webp").convert("RGBA")
            img.alpha_composite(big, (x + (cell - SIZE) // 2, yy))
            draw.text((x + (cell - SIZE) // 2 + 4, yy + SIZE + 2),
                      f"{name}  {(out_dir / f'{name}.webp').stat().st_size / 1024:.1f}KB",
                      font=small_font, fill=fg)
            motif = motifs.get(name, "")
            if motif:
                draw.text((x + (cell - SIZE) // 2 + 4, yy + SIZE + 16), motif[:22],
                          font=small_font, fill=(235, 120, 40, 255) if bgcol[0] < 128 else (196, 96, 24, 255))
        y += block_h
    per_row = (width - pad * 2 - 8) // 72
    for bgcol, bgname in (((246, 242, 230, 255), "64px 等倍 / light"),
                          ((30, 32, 38, 255), "64px 等倍 / dark")):
        block_h = max(1, -(-len(names) // per_row)) * 72 + header
        draw.rectangle([pad, y, width - pad, y + block_h], fill=bgcol)
        fg = (20, 20, 20, 255) if bgcol[0] > 128 else (238, 238, 238, 255)
        draw.text((pad + 8, y + 4), bgname, font=font, fill=fg)
        for i, name in enumerate(names):
            x = pad + 8 + (i % per_row) * 72
            yy = y + header + 4 + (i // per_row) * 72
            sm = Image.open(out_dir / "small" / f"{name}.webp").convert("RGBA")
            img.alpha_composite(sm, (x, yy))
        y += block_h
    img = img.crop((0, 0, width, min(height, y + pad)))
    img.convert("RGB").save(TMP / f"tiles-contact-{sid}.png")


def res_kb(out_dir: Path, name: str) -> str:
    return f"{(out_dir / f'{name}.webp').stat().st_size / 1024:.1f}"


def main():
    ap = argparse.ArgumentParser(description="Cut batched icon sheets into tiles.")
    ap.add_argument("--sheet", default="all", help="sheet id, comma list, or all")
    ap.add_argument("--include-future", action="store_true",
                    help="also cut art/raw/city_icons_*.png described by city_motifs.json")
    ap.add_argument("--contacts-only", action="store_true",
                    help="skip cutting; rebuild contact sheets from the existing WebPs")
    args = ap.parse_args()

    sheets = list(SHEETS)
    if args.include_future:
        sheets += city_icon_sheets()
    if args.sheet != "all":
        wanted = {s.strip() for s in args.sheet.split(",")}
        sheets = [s for s in sheets if s["id"] in wanted]
        if not sheets:
            raise SystemExit("no matching sheets")

    if args.contacts_only:
        results = []
        for sheet in sheets:
            out = sheet["out"]
            names = [n for row in sheet["names"] for n in row]
            missing = [n for n in names if not (out / f"{n}.webp").exists()]
            if missing:
                raise SystemExit(f"{sheet['id']}: missing outputs for {missing[:6]}")
            results.append({"id": sheet["id"], "scale": 0.0, "out": str(out), "tiles": {
                n: {"big_kb": round((out / f"{n}.webp").stat().st_size / 1024, 1),
                    "small_kb": round((out / "small" / f"{n}.webp").stat().st_size / 1024, 1)}
                for n in names}})
    else:
        results = [process_sheet(s) for s in sheets]
    contact_sheets(results, sheets)
    summary = {
        r["id"]: {
            "scale": r["scale"],
            "big_total_kb": round(sum(v["big_kb"] for v in r["tiles"].values()), 1),
            "small_total_kb": round(sum(v["small_kb"] for v in r["tiles"].values()), 1),
            "tiles": r["tiles"],
        }
        for r in results
    }
    (TMP / "tiles-sizes.json").write_text(json.dumps(summary, indent=1, ensure_ascii=False))
    for sid, s in summary.items():
        print(f"{sid}: {len(s['tiles'])} tiles, {s['big_total_kb']} KB @256 + {s['small_total_kb']} KB @64")


if __name__ == "__main__":
    main()