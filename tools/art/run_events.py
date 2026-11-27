#!/usr/bin/env python3
"""Drive the event-art pipeline: Codex sheets first, then agy singles, cutting and applying as it goes.

Usage: python3 tools/art/run_events.py [--limit N] [--priority 1,2]
Runs one generator at a time (the host has 7.5 GB RAM). Idempotent: rows whose output webp already
exists are skipped, so re-running after a quota recovery resumes exactly where it stopped.

Sequence per iteration:
  1. Codex: generate the next 2x2 sheet (4 rows of one style) with gen_codex.py.
     On a usage limit, mark Codex exhausted for this process and fall through.
  2. agy: generate one image, preferring the row whose Codex sheet has the fewest rows left, so agy
     finishes partly-done sheets instead of eating into full ones (a Codex sheet is 4 rows per call).
  3. Cut every new raw image, then apply finished images into src/data/events.json.
"""
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MANIFEST = ROOT / "tools/art/event_art.json"
JOBS = ROOT / "art/event_jobs.json"
PY = sys.executable


def load() -> dict:
    return json.loads(MANIFEST.read_text())


def pending(priority: set[int] | None = None) -> list[dict]:
    rows = [r for r in load()["rows"] if r.get("status") != "done"]
    if priority:
        rows = [r for r in rows if int(r["priority"]) in priority]
    return rows


def run(cmd: list[str], env: dict | None = None) -> int:
    print("$", " ".join(cmd), flush=True)
    merged = {**os.environ, **(env or {})}
    return subprocess.run(cmd, cwd=ROOT, env=merged).returncode


def sheet_ready(sheet_id: str) -> bool:
    return (ROOT / "art/raw" / f"{sheet_id}.png").exists()


def pending_sheet(priority: set[int] | None) -> str | None:
    """Next full sheet (4 rows) that has an uncut row and no raw PNG yet.

    A sheet with fewer rows (a _v2 redo) is left to agy: Codex draws only the given panels in a
    corner of the 2x2 canvas, and the 2x2 cut then produces empty panels.
    """
    size: dict[str, int] = {}
    for row in load()["rows"]:
        if row.get("sheet"):
            size[row["sheet"]] = size.get(row["sheet"], 0) + 1
    for row in pending(priority):
        sid = row.get("sheet")
        if sid and size.get(sid) == 4 and not sheet_ready(sid):
            return sid
    return None


def refresh_sheets() -> None:
    run([PY, "tools/art/event_art.py", "sheets"])


def main() -> None:
    args = sys.argv[1:]
    limit = 0
    prio: set[int] | None = None
    if "--limit" in args:
        limit = int(args[args.index("--limit") + 1])
    if "--priority" in args:
        prio = {int(x) for x in args[args.index("--priority") + 1].split(",")}
    refresh_sheets()
    done = 0
    codex_ok = True
    while True:
        if limit and done >= limit:
            print(f"limit {limit} reached", flush=True)
            return
        rows = pending(prio)
        if not rows:
            print("all rows done", flush=True)
            return
        # 1) Codex sheets
        if codex_ok:
            sid = pending_sheet(prio)
            if sid:
                rc = run([PY, "tools/art/gen_codex.py", "--jobs", "art/event_jobs.json", sid])
                if rc == 0:
                    run([PY, "tools/art/event_art.py", "cut", sid])
                    run([PY, "tools/art/event_art.py", "apply"])
                    done += 4
                    refresh_sheets()
                    continue
                codex_ok = False
                print("codex unavailable -> agy", flush=True)
        # 2) agy singles
        rows = pending(prio)
        left: dict[str, int] = {}
        for r in rows:
            left[r.get("sheet") or ""] = left.get(r.get("sheet") or "", 0) + 1
        row = min(rows, key=lambda r: (left[r.get("sheet") or ""], rows.index(r)))
        rc = run([PY, "tools/art/gen_agy.py", "--event", row["eventId"]], env={"AGY_LIMIT": "1"})
        if rc != 0:
            print(f"agy stopped rc={rc}; remaining {len(pending(prio))} rows", flush=True)
            run([PY, "tools/art/event_art.py", "cut"])
            run([PY, "tools/art/event_art.py", "apply"])
            return
        run([PY, "tools/art/event_art.py", "cut"])
        run([PY, "tools/art/event_art.py", "apply"])
        done += 1


if __name__ == "__main__":
    main()