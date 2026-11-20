"""Used by the GitHub Action: download CelesTrak TLEs into OUT/current and move the old ones to OUT/previous.

Usage: python scripts/update_tle.py OUT_DIR
"""
import shutil
import sys
import time
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from satellites import CATALOG_QUERIES, CELESTRAK_URL  # noqa: E402
from config import TLE_MIRROR_URL, USER_AGENT  # noqa: E402

out = Path(sys.argv[1])
cur, prev = out / "current", out / "previous"
cur.mkdir(parents=True, exist_ok=True)
prev.mkdir(parents=True, exist_ok=True)

ok = 0
for name, params in CATALOG_QUERIES.items():
    # keep the last published copy as "previous" for change detection
    try:
        old = requests.get(f"{TLE_MIRROR_URL}/current/{name}.txt", timeout=60)
        if old.ok and "\n1 " in old.text:
            (prev / f"{name}.txt").write_text(old.text)
    except requests.RequestException as exc:
        print(f"no previous copy for {name}: {exc}")

    text = None
    for attempt in range(1, 4):
        try:
            resp = requests.get(CELESTRAK_URL, params={**params, "FORMAT": "tle"},
                                headers={"User-Agent": USER_AGENT}, timeout=(30, 300))
            if resp.ok and "\n1 " in resp.text:
                text = resp.text
                break
            print(f"{name} attempt {attempt}: HTTP {resp.status_code} {resp.text[:150]!r}")
        except requests.RequestException as exc:
            print(f"{name} attempt {attempt}: {exc}")
        time.sleep(15 * attempt)
    if text:
        (cur / f"{name}.txt").write_text(text)
        print(f"{name}: {text.count(chr(10)) // 3} objects")
        ok += 1
    else:
        print(f"FAILED {name}; keeping last good copy")
        # keep publishing the last good copy instead of nothing
        if (prev / f"{name}.txt").exists():
            shutil.copy(prev / f"{name}.txt", cur / f"{name}.txt")
    time.sleep(2)

if not any(cur.iterdir()):
    sys.exit("CelesTrak download failed for every group and no previous copy exists")
if ok == 0:
    print("::warning::CelesTrak unreachable this run; republished the last good data")
