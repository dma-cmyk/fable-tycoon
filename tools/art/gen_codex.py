#!/usr/bin/env python3
"""Generate art sheets with the Codex CLI image tool, sequentially and idempotently.

Usage: python3 tools/art/gen_codex.py [job_id ...]
Reads tools/art/jobs.json, writes art/raw/<job>.png and appends art/log.jsonl.
Skips jobs whose PNG already exists.
"""
import json
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
JOBS = json.loads((ROOT / "tools/art/jobs.json").read_text())
RAW = ROOT / "art/raw"
LOG = ROOT / "art/log.jsonl"
GEN = Path.home() / ".codex/generated_images"

PREAMBLE = (
    "画像生成ツールで画像を 1 枚だけ生成してください。シェルコマンドの実行やファイル操作はしないでください。"
    "生成が終わったら「done」とだけ返答してください。\n\n# 生成する画像\n"
)


def run(job: dict) -> None:
    out = RAW / f"{job['id']}.png"
    if out.exists():
        print(f"skip {job['id']}", flush=True)
        return
    prompt = PREAMBLE + job["style"] + "\n\n" + job["prompt"]
    with tempfile.TemporaryDirectory() as tmp:
        cmd = ["codex", "exec", "--skip-git-repo-check", "--json", "--sandbox", "read-only", "-C", tmp]
        for ref in job.get("refs", []):
            cmd.append(f"--image={ROOT / ref}")
        cmd.append(prompt)
        t0 = time.time()
        for attempt in range(2):
            proc = subprocess.run(cmd, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=900)
            thread = None
            usage = None
            error = None
            for line in proc.stdout.splitlines():
                try:
                    ev = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if ev.get("type") == "thread.started":
                    thread = ev.get("thread_id")
                elif ev.get("type") == "turn.completed":
                    usage = ev.get("usage")
                elif ev.get("type") in ("error", "turn.failed"):
                    error = ev.get("message") or (ev.get("error") or {}).get("message")
            pngs = sorted((GEN / thread).glob("*.png")) if thread and (GEN / thread).exists() else []
            if pngs:
                shutil.copy(pngs[-1], out)
                rec = {"job": job["id"], "thread": thread, "usage": usage, "secs": round(time.time() - t0), "file": str(out)}
                with LOG.open("a") as f:
                    f.write(json.dumps(rec, ensure_ascii=False) + "\n")
                print(f"ok {job['id']} {thread} {rec['secs']}s", flush=True)
                return
            print(f"FAIL {job['id']} attempt {attempt}: {error} rc={proc.returncode}", flush=True)
            if error and "usage limit" in error:
                sys.exit(f"usage limit: {error}")
    with LOG.open("a") as f:
        f.write(json.dumps({"job": job["id"], "failed": True}) + "\n")


def main() -> None:
    wanted = set(sys.argv[1:])
    for job in JOBS:
        if wanted and job["id"] not in wanted:
            continue
        run(job)


if __name__ == "__main__":
    main()
