#!/usr/bin/env python3
"""Cut generated art sheets (art/raw/*.png) into game assets under public/assets/.

Run with the project venv: .tmp/venv/bin/python tools/art/cut_sprites.py [sheet ...]
Sheets on a chroma background (green/magenta) are keyed to alpha and split by grid cell;
panel sheets (white gutters) are split into equal panels; keyart is resized.
"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "art/raw"
OUT = ROOT / "public/assets"

CHARS = {
    "chars1": ["momotaro", "momo_dog", "momo_monkey", "momo_pheasant", "aka_oni", "kintaro", "urashima", "kaguya"],
    "chars2": ["issun", "bunbuku", "wukong", "sinbad", "aladdin", "lamp_genie", "ali_baba", "anansi"],
    "chars3": ["alice", "white_rabbit", "cheshire", "heart_queen", "mad_hatter", "naked_emperor", "pinocchio", "puss"],
    "chars4": ["red_hood", "wolf", "granny", "gretel", "candy_witch", "rumpel", "jack", "giant"],
    "chars5": ["cinderella", "stepmother", "stepsister", "snow_white", "evil_queen", "dwarf", "mermaid", "ugly_duckling"],
    "chars6": ["ant", "grasshopper", "golden_goose", "baba_yaga", "tortoise", "thumbelina", "robin_hood", "kappa"],
    "npcs": ["piper1", "piper2", "piper3", "owl_anchor", "tariff_bulldog", "banker_pig", "tech_kid", "midas"],
}
LANDMARKS = {
    "landmarks1": ["big_ben", "eiffel", "brandenburg", "colosseum", "kremlin", "statue_liberty", "golden_gate",
                   "sugarloaf", "pyramids", "taj_mahal", "tokyo_tower", "great_wall"],
    "landmarks2": ["angkor_wat", "machu_picchu", "chichen_itza", "table_mountain", "harbour_bridge", "windmill",
                   "osaka_castle", "acropolis", "cn_tower", "gyeongbokgung", "petra", "kilimanjaro"],
    "landmarks3": ["neuschwanstein", "mt_fuji", "niagara", "iguazu", "victoria_falls", "ha_long_bay",
                   "cappadocia", "prague_castle", "hermitage", "gateway_arch", "baobab", "terracotta"],
}
BG = {k: "green" for k in CHARS} | {"chars6": "magenta"} | {k: "magenta" for k in LANDMARKS}
EVENTS = {"events1": ["ai", "tulip", "suez", "tariff"], "events2": ["bailout", "goldrush", "emperor", "hyperinflation"]}


def key_alpha(rgb: np.ndarray, bg: str) -> np.ndarray:
    r, g, b = (rgb[..., i].astype(np.float32) for i in range(3))
    dom = g - np.maximum(r, b) if bg == "green" else np.minimum(r, b) - g
    # dom >= hi -> background; dom <= lo -> foreground; soft in between
    lo, hi = 25.0, 90.0
    return np.clip((hi - dom) / (hi - lo), 0, 1)


def despill(rgb: np.ndarray, alpha: np.ndarray, bg: str) -> np.ndarray:
    out = rgb.astype(np.float32)
    edge = ndimage.binary_dilation(alpha < 0.98, iterations=3) & (alpha > 0)
    r, g, b = out[..., 0], out[..., 1], out[..., 2]
    if bg == "green":
        cap = np.maximum(r, b)
        g[edge] = np.minimum(g[edge], cap[edge])
    else:
        r[edge] = np.minimum(r[edge], g[edge] + (r[edge] - b[edge]).clip(0))
        b[edge] = np.minimum(b[edge], g[edge] + 10)
    return out.clip(0, 255).astype(np.uint8)


def cut_grid(sheet: str, names: list[str], cols: int, rows: int, outdir: Path, max_h: int) -> None:
    img = np.array(Image.open(RAW / f"{sheet}.png").convert("RGB"))
    bg = BG[sheet]
    alpha = key_alpha(img, bg)
    solid = alpha > 0.5
    labels, n = ndimage.label(solid)
    h, w = solid.shape
    cell_w, cell_h = w / cols, h / rows
    sizes = ndimage.sum(solid, labels, range(1, n + 1))
    coms = ndimage.center_of_mass(solid, labels, range(1, n + 1))
    min_size = cell_w * cell_h * 0.002
    cell_masks = [np.zeros_like(solid) for _ in names]
    for i, (sz, (cy, cx)) in enumerate(zip(sizes, coms)):
        if sz < min_size:
            continue
        idx = int(cy // cell_h) * cols + int(cx // cell_w)
        if idx < len(names):
            cell_masks[idx] |= labels == (i + 1)
    rgb = despill(img, alpha, bg)
    outdir.mkdir(parents=True, exist_ok=True)
    for name, m in zip(names, cell_masks):
        if not m.any():
            print(f"  !! {sheet}/{name}: empty")
            continue
        grown = ndimage.binary_dilation(m, iterations=4)
        a = np.where(grown, alpha, 0)
        a[a < 0.12] = 0
        ys, xs = np.nonzero(a)
        y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
        pad = 4
        y0, x0 = max(0, y0 - pad), max(0, x0 - pad)
        y1, x1 = min(h, y1 + pad), min(w, x1 + pad)
        rgba = np.dstack([rgb, (a * 255).astype(np.uint8)])[y0:y1, x0:x1]
        im = Image.fromarray(rgba, "RGBA")
        if im.height > max_h:
            im = im.resize((round(im.width * max_h / im.height), max_h), Image.LANCZOS)
        edge = [a[y0, x0:x1].mean(), a[y1 - 1, x0:x1].mean(), a[y0:y1, x0].mean(), a[y0:y1, x1 - 1].mean()]
        warn = " EDGE" if max(edge) > 0.05 else ""
        im.save(outdir / f"{name}.webp", "WEBP", quality=90, method=4)
        print(f"  {sheet}/{name}: {im.width}x{im.height}{warn}")


def cut_panels(sheet: str, names: list[str], outdir: Path) -> None:
    im = Image.open(RAW / f"{sheet}.png").convert("RGB")
    arr = np.asarray(im).astype(np.int16)
    h, w, _ = arr.shape
    white = (arr.min(axis=2) > 225)
    # find gutters near the middle
    col_white = white.mean(axis=0)
    row_white = white.mean(axis=1)
    mid_x = int(np.argmax(col_white[int(w * 0.4):int(w * 0.6)])) + int(w * 0.4)
    mid_y = int(np.argmax(row_white[int(h * 0.4):int(h * 0.6)])) + int(h * 0.4)
    boxes = [(0, 0, mid_x, mid_y), (mid_x, 0, w, mid_y), (0, mid_y, mid_x, h), (mid_x, mid_y, w, h)]
    outdir.mkdir(parents=True, exist_ok=True)
    for name, (x0, y0, x1, y1) in zip(names, boxes):
        sub = white[y0:y1, x0:x1]
        # trim white borders
        cols = np.nonzero(sub.mean(axis=0) < 0.9)[0]
        rows = np.nonzero(sub.mean(axis=1) < 0.9)[0]
        cx0, cx1 = x0 + cols.min(), x0 + cols.max() + 1
        cy0, cy1 = y0 + rows.min(), y0 + rows.max() + 1
        inset = 3
        p = im.crop((cx0 + inset, cy0 + inset, cx1 - inset, cy1 - inset))
        p = p.resize((800, round(800 * p.height / p.width)), Image.LANCZOS)
        p.save(outdir / f"{name}.webp", "WEBP", quality=86, method=4)
        print(f"  {sheet}/{name}: {p.width}x{p.height}")


def main() -> None:
    want = set(sys.argv[1:])
    def ok(s: str) -> bool:
        return (not want or s in want) and (RAW / f"{s}.png").exists()
    for s, names in CHARS.items():
        if ok(s):
            cut_grid(s, names, 4, 2, OUT / ("npcs" if s == "npcs" else "chars"), 512)
    for s, names in CHARS.items():
        if s == "npcs":
            continue
        for mood in ("joy", "sad"):
            sheet = f"{s}_{mood}"
            BG[sheet] = BG[s]
            if ok(sheet):
                cut_grid(sheet, [f"{n}_{mood}" for n in names], 4, 2, OUT / "chars", 512)
    for s, names in LANDMARKS.items():
        if ok(s):
            cut_grid(s, names, 4, 3, OUT / "landmarks", 256)
    if ok("vehicles"):
        BG["vehicles"] = "green"
        cut_grid("vehicles", ["train", "express", "bullet_train", "ferry", "plane", "rocket", "carpet", "sailboat"],
                 4, 2, OUT / "vehicles", 256)
    if ok("ui_icons"):
        BG["ui_icons"] = "magenta"
        cut_grid("ui_icons", ["coins", "moneybag", "property", "cards", "treasure", "chart", "globe", "gear",
                              "menu", "help", "chat", "emote", "trophy", "calendar", "flag", "hourglass"],
                 4, 4, OUT / "ui", 192)
    if ok("title_logo"):
        BG["title_logo"] = "magenta"
        cut_grid("title_logo", ["logo"], 1, 1, OUT / "ui", 600)
    if ok("map_stamps"):
        BG["map_stamps"] = "magenta"
        cut_grid("map_stamps", ["mountains", "snow_mountain", "volcano", "conifer_forest", "forest", "palms", "desert",
                                "fields", "town", "metropolis", "port_town", "station", "iceberg", "ranch", "oil_rig",
                                "factory"], 4, 4, OUT / "stamps", 192)
    for s, names in EVENTS.items():
        if ok(s):
            cut_panels(s, names, OUT / "events")
    if ok("keyart"):
        im = Image.open(RAW / "keyart.png").convert("RGB")
        im = im.resize((1920, round(1920 * im.height / im.width)), Image.LANCZOS)
        (OUT / "ui").mkdir(parents=True, exist_ok=True)
        im.save(OUT / "ui/keyart.webp", "WEBP", quality=85, method=4)
        print("  keyart", im.size)


if __name__ == "__main__":
    main()
