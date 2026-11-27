#!/usr/bin/env python3
"""Generate event illustrations one image per request through the agy (Antigravity) CLI.

Usage: python3 tools/art/gen_agy.py [--manifest tools/art/event_art.json] [priority ...]
Reads the manifest, writes art/agy/<eventId>.png, appends art/log.jsonl.
Skips rows that already have an output file, and stops cleanly on a quota/usage-limit error.

agy has no image flag: it runs an agent turn that calls its own image tool and then reads the
file back. The runner therefore:
  1. snapshots existing images under ~/.gemini/antigravity-cli/brain/,
  2. asks agy to generate the picture and save it at an absolute path,
  3. accepts the requested path, else copies the newest brain image produced by this turn.
"""
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MANIFEST = ROOT / "tools/art/event_art.json"
OUT = ROOT / "art/agy"
LOG = ROOT / "art/log.jsonl"
BRAIN = Path.home() / ".gemini/antigravity-cli/brain"
AGY = Path.home() / ".local/bin/agy"
QUOTA_HINTS = ("quota", "usage limit", "rate limit", "resource exhausted", "too many requests",
               "credit", "429")

SHEET_NOTE = (
    "画像は横長 16:9 の 1 枚絵。重要な人物と物は画面の上 2/3 に置き、下 1/3 は空き気味にする。"
    "文字・数字・記号・ロゴ・透かし・枠線・キャプションは一切描かない。"
)


def load() -> dict:
    return json.loads(MANIFEST.read_text())


def save(data: dict) -> None:
    MANIFEST.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n")


def brain_snapshot() -> set[Path]:
    if not BRAIN.exists():
        return set()
    return {p for p in BRAIN.glob("*/*") if p.suffix.lower() in (".png", ".jpg", ".jpeg", ".webp")}


def newest_brain_image(before: set[Path], since: float) -> Path | None:
    fresh = [p for p in brain_snapshot() - before if p.stat().st_mtime >= since - 2]
    if not fresh:
        return None
    return max(fresh, key=lambda p: p.stat().st_mtime)


def prompt_for(row: dict, data: dict, dst: Path) -> str:
    refs = [str(ROOT / r) for r in row.get("refs", []) if (ROOT / r).exists()][:3]
    ref_text = ""
    if refs:
        ref_text = (
            "# 参照画像\n"
            "次のファイルを画像として読み、絵柄（線の太さ・塗り・配色）とキャラクターの外見だけを参考にしてください。"
            "構図や文字をそのまま写さないこと。\n"
            + "\n".join(f"- {p}" for p in refs)
            + "\n\n"
        )
    return (
        "画像生成ツールで画像を 1 枚だけ生成してください。シェルでの作図やSVGは使わず、画像生成ツールを使うこと。\n"
        f"生成した画像のファイルを、変換なしでそのまま {dst} に保存してください。"
        "保存できたら、保存先の絶対パスだけを返答してください。\n\n"
        + ref_text
        + f"# 絵柄\n{data['styles'][row['style']]}\n\n"
        f"# 構図\n{SHEET_NOTE}\n\n"
        f"# 描く内容\n{row['prompt']}\n"
    )


def run_row(row: dict, data: dict) -> bool:
    dst = OUT / f"{row['eventId']}.png"
    if dst.exists() and dst.stat().st_size > 10_000:
        row["status"] = "done"
        row["output"] = str(dst.relative_to(ROOT))
        row["generator"] = "agy"
        print(f"skip {row['eventId']}", flush=True)
        return True
    OUT.mkdir(parents=True, exist_ok=True)
    before = brain_snapshot()
    t0 = time.time()
    cmd = [
        str(AGY), "--dangerously-skip-permissions", "--mode", "accept-edits",
        "--add-dir", str(OUT), "--add-dir", str(ROOT / "public"),
        "--print-timeout", "15m", "-p", prompt_for(row, data, dst),
    ]
    proc = subprocess.run(cmd, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=1200)
    out = (proc.stdout or "") + (proc.stderr or "")
    for line in out.splitlines():
        low = line.lower()
        if any(h in low for h in QUOTA_HINTS):
            with LOG.open("a") as f:
                f.write(json.dumps({"job": row["eventId"], "generator": "agy", "quota": line.strip()},
                                   ensure_ascii=False) + "\n")
            print(f"QUOTA {line.strip()}", flush=True)
            raise SystemExit(3)
    got: Path | None = dst if dst.exists() and dst.stat().st_size > 10_000 else None
    if got is None:
        got = newest_brain_image(before, t0)
        if got is not None:
            shutil.copy(got, dst)
    if got is None:
        print(f"FAIL {row['eventId']}: no image\n{out[-800:]}", flush=True)
        with LOG.open("a") as f:
            f.write(json.dumps({"job": row["eventId"], "generator": "agy", "failed": True}) + "\n")
        return False
    row["status"] = "done"
    row["output"] = str(dst.relative_to(ROOT))
    row["generator"] = "agy"
    save(data)
    with LOG.open("a") as f:
        f.write(json.dumps({"job": row["eventId"], "generator": "agy", "secs": round(time.time() - t0),
                            "file": str(dst.relative_to(ROOT))}, ensure_ascii=False) + "\n")
    print(f"ok {row['eventId']} {round(time.time() - t0)}s", flush=True)
    return True


def main() -> None:
    global MANIFEST
    args = sys.argv[1:]
    if "--manifest" in args:
        i = args.index("--manifest")
        MANIFEST = ROOT / args[i + 1]
        del args[i:i + 2]
    limit = int(os.environ.get("AGY_LIMIT", "0"))
    data = load()
    rows = [r for r in data["rows"] if r.get("status") != "done"]
    if "--event" in args:
        i = args.index("--event")
        rows = [r for r in rows if r["eventId"] == args[i + 1]]
        del args[i:i + 2]
    if args:
        want = {int(a) for a in args}
        rows = [r for r in rows if int(r["priority"]) in want]
    count = 0
    for row in rows:
        # Re-check against the current manifest: another step (cut of a ChatGPT-web image, a
        # hand edit) may have finished this row while earlier rows were generating.
        current = next((r for r in load()["rows"] if r["eventId"] == row["eventId"]), None)
        if current is None or current.get("status") == "done":
            continue
        if run_row(row, data):
            count += 1
            # A generation takes minutes: merge only this row into a fresh copy instead of
            # writing back the snapshot loaded at start (that clobbered concurrent edits).
            fresh = load()
            fresh["rows"] = [row if r["eventId"] == row["eventId"] else r for r in fresh["rows"]]
            save(fresh)
        if limit and count >= limit:
            print(f"stopped after limit {limit}", flush=True)
            break


if __name__ == "__main__":
    main()