#!/usr/bin/env python3
"""Event illustration pipeline: sheet planning, cutting, applying, contact sheets.

Manifest: tools/art/event_art.json
  {
    "styles": { "chibi": "...", "photoreal": "..." },   # shared style preambles
    "rows": [
      { "eventId": "final-tax-audit-frontrunner", "priority": 1, "style": "chibi",
        "prompt": "...", "sheet": "ev_01", "slot": 1, "status": "pending",
        "output": "public/assets/events/final-tax-audit-frontrunner.webp" }
    ]
  }

Subcommands:
  sheets   assign sheets (4 same-style rows per 2x2 sheet) and write art/event_jobs.json
  status   print progress counts
  cut      split art/raw/ev_*.png into public/assets/events/<eventId>.webp
  contact  build a <=1000px contact sheet of cut panels for review
  apply    write "image" into src/data/events.json for every row with a cut file

Python deps: Pillow + numpy (system python3 is fine; scipy is not needed).
"""
import json
import math
import re
import sys
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
MANIFEST = ROOT / "tools/art/event_art.json"
RAW = ROOT / "art/raw"
OUT = ROOT / "public/assets/events"
JOBS = ROOT / "art/event_jobs.json"
EVENTS_JSON = ROOT / "src/data/events.json"

PANEL_W, PANEL_H = 800, 450
STYLE_REF = "public/assets/events/ai.webp"   # painted chibi reference (style only)
PHOTO_REF = ""                                # photoreal sheets use no style ref
SLOTS = ["1", "2", "3", "4"]  # top-left, top-right, bottom-left, bottom-right
SHEET_GRID = (
    "画像は 16:9 の横長 1 枚。中央に縦横の白い余白（ガター）を入れて、独立した 16:9 の絵を "
    "2x2 の 4 区画に並べる。使わない区画は純白のまま完全に空けておく。"
    "ガターは画像全体の幅・高さの約 2.5% で、純白の平らな帯。"
    "各パネルは自分の枠の中に完全に収まり、隣のパネルと要素が重ならない。"
    "パネルの外側の余白はすべて純白。パネル内部の背景は平らで読みやすい色面にし、"
    "細かい模様でガターと紛れないようにする。文字・数字・記号・ロゴ・透かし・枠線・キャプションは一切描かない。"
    "各パネルは横長で、重要な人物と物は画面の上 2/3 に置き、下 1/3 は空き気味にする。"
)


def load() -> dict:
    return json.loads(MANIFEST.read_text())


def save(data: dict) -> None:
    MANIFEST.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n")


def panel_brief(row: dict, data: dict) -> str:
    return f"【パネル {row['slot']}】{data['styles'][row['style']]}\n{row['prompt']}"


# ---------------------------------------------------------------- sheets
def _sheet_job(sheet_id: str, style: str, sheet_rows: list[dict], data: dict) -> dict:
    panels = [panel_brief(r, data) for r in sheet_rows]
    refs = [STYLE_REF] if style == "chibi" else ([PHOTO_REF] if PHOTO_REF else [])
    seen = set(refs)
    # Character sprites help identity; keep the total small so the style ref stays dominant.
    if style == "chibi":
        for row in sheet_rows:
            for ref in row.get("refs", []):
                if ref in seen or len(refs) >= 3:
                    continue
                seen.add(ref)
                refs.append(ref)
    return {
        "id": sheet_id,
        "style": SHEET_GRID,
        "prompt": "\n\n".join(panels),
        "refs": refs,
        "style_kind": style,
        "events": [r["eventId"] for r in sheet_rows],
    }


def cmd_sheets(remake: bool = False) -> None:
    """Assign a stable sheet id to every row without one, then write art/event_jobs.json.

    Existing assignments are never reshuffled: a sheet that failed stays with its own rows so a
    retry reproduces the same 4 panels. Rows marked `sheet: null` (a _v2 regeneration) get a new
    sheet id at the end of the numbering.
    """
    data = load()
    rows = data["rows"]
    if remake:
        for row in rows:
            if row.get("status") != "done":
                row["sheet"] = None
                row["slot"] = 0
    used = {r["sheet"] for r in rows if r.get("sheet")}
    next_no = 1
    while f"ev_{next_no:02d}" in used:
        next_no += 1

    # Complete half-filled sheets first (same style, same id), then open new ones.
    by_sheet: dict[str, list[dict]] = {}
    for row in rows:
        if row.get("sheet"):
            by_sheet.setdefault(row["sheet"], []).append(row)
    open_for: dict[str, str] = {}
    for sid, sheet_rows in by_sheet.items():
        if len(sheet_rows) < 4:
            open_for[sheet_rows[0]["style"]] = sid
    pending_new = [r for r in rows if not r.get("sheet") and r.get("status") != "done"]
    pending_new.sort(key=lambda r: r["priority"])
    for row in pending_new:
        style = row["style"]
        sid = open_for.get(style)
        if sid is None:
            sid = f"ev_{next_no:02d}"
            next_no += 1
            open_for[style] = sid
            by_sheet[sid] = []
        slot = len(by_sheet[sid]) + 1
        row["sheet"] = sid
        row["slot"] = slot
        by_sheet[sid].append(row)
    for sid in list(by_sheet):
        if not by_sheet[sid]:
            del by_sheet[sid]

    jobs = []
    for sid in sorted(by_sheet):
        sheet_rows = sorted(by_sheet[sid], key=lambda r: r["slot"])
        jobs.append(_sheet_job(sid, sheet_rows[0]["style"], sheet_rows, data))
    JOBS.write_text(json.dumps(jobs, ensure_ascii=False, indent=1) + "\n")
    save(data)
    n_pending = sum(1 for r in rows if r.get("status") != "done")
    print(f"{n_pending} pending rows -> {len(jobs)} sheets ({JOBS.relative_to(ROOT)})")


# ---------------------------------------------------------------- status
def cmd_status() -> None:
    data = load()
    rows = data["rows"]
    by_style: dict[str, dict[str, int]] = {}
    for row in rows:
        bucket = by_style.setdefault(row["style"], {"done": 0, "pending": 0})
        bucket["done" if row.get("status") == "done" else "pending"] += 1
    print(f"rows={len(rows)}")
    for style, bucket in sorted(by_style.items()):
        print(f"  {style}: done={bucket['done']} pending={bucket['pending']}")
    left = sorted({r["sheet"] for r in rows if r.get("status") != "done" and r.get("sheet")})
    print("sheets left:", " ".join(left) or "-")


# ---------------------------------------------------------------- cut
def _band_mask(img: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Return (row_is_gutter, col_is_gutter) for a near-white flat separator."""
    h, w, _ = img.shape
    flat = img.astype(np.int16)
    bright = flat.mean(axis=2) > 232
    spread = flat.max(axis=2) - flat.min(axis=2)
    white = bright & (spread < 26)
    # A gutter line is mostly white across its whole length.
    col_is_gutter = white.mean(axis=0) > 0.90
    row_is_gutter = white.mean(axis=1) > 0.90
    return row_is_gutter, col_is_gutter


def _run_center(mask: np.ndarray, lo: int, hi: int) -> int | None:
    """Center of the longest True run inside [lo, hi), or None."""
    best, cur = None, None
    for i in range(lo, max(lo, hi)):
        if mask[i]:
            cur = (cur[0] if cur else i, i)
            if best is None or (cur[1] - cur[0]) > (best[1] - best[0]):
                best = cur
        else:
            cur = None
    return None if best is None else (best[0] + best[1]) // 2


def find_split(img: np.ndarray) -> tuple[int, int]:
    """Find the gutter between the four panels; fall back to exact equal quarters."""
    h, w, _ = img.shape
    row_g, col_g = _band_mask(img)
    x = _run_center(col_g, int(w * 0.30), int(w * 0.70))
    y = _run_center(row_g, int(h * 0.30), int(h * 0.70))
    if x is None:
        x = w // 2
    if y is None:
        y = h // 2
    # Sanity: a detected gutter never sits outside 35..65%.
    x = min(max(x, int(w * 0.35)), int(w * 0.65))
    y = min(max(y, int(h * 0.35)), int(h * 0.65))
    return x, y


def crop_169(img: Image.Image, bias_top: bool = True) -> Image.Image:
    """Center-crop to 16:9, keeping more of the top because content lives there."""
    w, h = img.size
    target = 16 / 9
    if w / h > target:
        nw = int(round(h * target))
        left = (w - nw) // 2
        return img.crop((left, 0, left + nw, h))
    nh = int(round(w / target))
    top = 0 if bias_top else max(0, (h - nh) // 2)
    return img.crop((0, top, w, top + nh))


def trim_borders(panel: Image.Image) -> Image.Image:
    """Shave a white rim left by an imprecise gutter."""
    arr = np.asarray(panel.convert("RGB")).astype(np.int16)
    h, w, _ = arr.shape
    spread = arr.max(axis=2) - arr.min(axis=2)
    white = (arr.mean(axis=2) > 232) & (spread < 26)
    col_w = white.mean(axis=0)
    row_w = white.mean(axis=1)
    left = 0
    while left < w * 0.06 and col_w[left] > 0.90:
        left += 1
    right = w - 1
    while right > w * 0.94 and col_w[right] > 0.90:
        right -= 1
    top = 0
    while top < h * 0.06 and row_w[top] > 0.90:
        top += 1
    bottom = h - 1
    while bottom > h * 0.94 and row_w[bottom] > 0.90:
        bottom -= 1
    if right - left < w * 0.6 or bottom - top < h * 0.6:
        return panel
    return panel.crop((left, top, right + 1, bottom + 1))


def _save_panel(panel: Image.Image, dst: Path) -> None:
    panel = crop_169(panel)
    panel = panel.resize((PANEL_W, PANEL_H), Image.LANCZOS)
    dst.parent.mkdir(parents=True, exist_ok=True)
    panel.save(dst, "WEBP", quality=82, method=6)


def cmd_cut(only: list[str], force: bool = False) -> None:
    """Cut 2x2 Codex sheets and single agy images into public/assets/events/<id>.webp."""
    data = load()
    rows = data["rows"]
    OUT.mkdir(parents=True, exist_ok=True)
    cut = 0

    # (b) agy singles: art/agy/<eventId>.png -> 800x450 webp
    for row in rows:
        src = ROOT / "art/agy" / f"{row['eventId']}.png"
        if not src.exists():
            continue
        dst = OUT / f"{row.get('target') or row['eventId']}.webp"
        if dst.exists() and not force and dst.stat().st_mtime >= src.stat().st_mtime:
            continue
        _save_panel(trim_borders(Image.open(src).convert("RGB")), dst)
        row["status"] = "done"
        row["output"] = str(dst.relative_to(ROOT))
        row.setdefault("generator", "agy")
        print(f"cut single {row['eventId']} <- {src.name}")
        cut += 1
    save(data)

    # (a) Codex sheets: art/raw/<sheet>.png -> 4 panels
    for sheet_id in sorted({r["sheet"] for r in rows if r.get("sheet")}):
        if only and sheet_id not in set(only):
            continue
        src = RAW / f"{sheet_id}.png"
        if not src.exists():
            continue
        sheet_rows = sorted([r for r in rows if r["sheet"] == sheet_id], key=lambda r: r["slot"])
        pending = [r for r in sheet_rows if force or not (OUT / f"{r['eventId']}.webp").exists()]
        if not pending:
            continue
        img = Image.open(src).convert("RGB")
        x, y = find_split(np.asarray(img))
        boxes = {
            1: (0, 0, x, y),
            2: (x, 0, img.size[0], y),
            3: (0, y, x, img.size[1]),
            4: (x, y, img.size[0], img.size[1]),
        }
        for row in sheet_rows:
            dst = OUT / f"{row.get('target') or row['eventId']}.webp"
            if dst.exists() and not force:
                row["status"] = "done"
                row["output"] = str(dst.relative_to(ROOT))
                continue
            _save_panel(trim_borders(img.crop(boxes[row["slot"]])), dst)
            row["status"] = "done"
            row["output"] = str(dst.relative_to(ROOT))
            row.setdefault("generator", "codex")
            print(f"cut {row['eventId']} <- {sheet_id} slot {row['slot']}")
            cut += 1
    save(data)
    print(f"{cut} panels cut")


# ---------------------------------------------------------------- contact
def cmd_contact(name: str = "contact", cols: int = 4) -> None:
    data = load()
    files = sorted(OUT.glob("*.webp"))
    if not files:
        print("no cut images")
        return
    thumb_w = 250
    thumb_h = 141
    rows = math.ceil(len(files) / cols)
    sheet = Image.new("RGB", (cols * thumb_w, rows * thumb_h), (18, 22, 30))
    for i, path in enumerate(files):
        img = Image.open(path).convert("RGB").resize((thumb_w, thumb_h), Image.LANCZOS)
        sheet.paste(img, ((i % cols) * thumb_w, (i // cols) * thumb_h))
    dst = ROOT / f".tmp/fun/eventart/{name}.jpg"
    dst.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(dst, "JPEG", quality=80)
    print(f"{dst.relative_to(ROOT)} ({sheet.size[0]}x{sheet.size[1]}, {len(files)} panels)")



def update_asset_manifest() -> None:
    """Keep src/ui/assetManifest.ts EVENT_IMAGE_IDS in sync with public/assets/events."""
    manifest = ROOT / "src/ui/assetManifest.ts"
    stems = sorted(p.stem for p in OUT.glob("*.webp"))
    text = manifest.read_text()
    import re
    line = 'export const EVENT_IMAGE_IDS = new Set<string>(' + json.dumps(stems) + ');'
    new_text, n = re.subn(r'export const EVENT_IMAGE_IDS = new Set<string>\(\[[^\]]*\]\);', line, text)
    if n != 1:
        print("WARN assetManifest.ts: EVENT_IMAGE_IDS line not found")
        return
    manifest.write_text(new_text)
    print(f"assetManifest: {len(stems)} event ids")

# ---------------------------------------------------------------- apply
def cmd_apply() -> None:
    """Insert/update the `image` field in events.json without reformatting the file.

    events.json is hand-formatted and shared with other slices, so it is edited line by line
    rather than re-serialised. Top-level event objects start with exactly two spaces before `{`.
    An existing `image` line is rewritten in place; otherwise the field is inserted right after
    the event's `"id"` line (which always ends with a comma).
    """
    data = load()
    text = EVENTS_JSON.read_text()
    lines = text.split("\n")
    entries: dict[str, str] = {}
    for row in data["rows"]:
        if row.get("status") != "done":
            continue
        path = row.get("output")
        if not path or not (ROOT / path).exists():
            continue
        entries[row.get("target") or row["eventId"]] = path.replace("public/", "", 1)
    if not entries:
        print("nothing to apply")
        return

    # Blocks: a line "  {" opens an event object; it closes at a line "  }" or "  },".
    blocks: list[list[str]] = []
    current: list[str] | None = None
    for line in lines:
        if line == "  {":
            current = [line]
            blocks.append(current)
            continue
        if current is not None:
            current.append(line)
            if line in ("  }", "  },"):
                current = None
            continue
        blocks.append([line])

    wrote = 0
    for block in blocks:
        eid = None
        for line in block:
            t = line.strip()
            if t.startswith('"id": '):
                eid = t.split('"')[3]
                break
        if eid not in entries:
            continue
        path = entries[eid]
        replaced = False
        for i, line in enumerate(block):
            t = line.strip()
            if t.startswith('"image": '):
                indent = line[: len(line) - len(line.lstrip())]
                comma = "," if t.endswith(",") else ""
                block[i] = f'{indent}"image": "{path}"{comma}'
                replaced = True
                wrote += 1
                break
        if replaced:
            continue
        for i, line in enumerate(block):
            if line.strip().startswith('"id": '):
                indent = line[: len(line) - len(line.lstrip())]
                block.insert(i + 1, f'{indent}"image": "{path}",')
                wrote += 1
                break

    EVENTS_JSON.write_text("\n".join(line for block in blocks for line in block))
    update_asset_manifest()
    print(f"applied {wrote} images into src/data/events.json")


def main() -> None:
    args = sys.argv[1:]
    cmd = args[0] if args else "status"
    if cmd == "sheets":
        cmd_sheets()
    elif cmd == "status":
        cmd_status()
    elif cmd == "cut":
        cmd_cut(args[1:])
    elif cmd == "contact":
        cmd_contact(*(args[1:2] or ["contact"]))
    elif cmd == "apply":
        cmd_apply()
    else:
        sys.exit(f"unknown command {cmd}")


if __name__ == "__main__":
    main()