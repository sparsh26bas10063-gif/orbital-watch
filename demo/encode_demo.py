# OrbitGuard | ASTRA 2026 | Team AstroNex
"""Encode recorded screencast frames (variable timing) into a constant-30fps H.264 MP4 + a poster image.

Usage: python demo/encode_demo.py WORK_DIR OUT.mp4 POSTER.png [poster_second]
"""
import json
import shutil
import subprocess
import sys
from pathlib import Path

import imageio_ffmpeg

work, out, poster = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
poster_t = float(sys.argv[4]) if len(sys.argv) > 4 else 14.0
import os
frames = sorted(json.loads((work / "frames.json").read_text()))
t0 = frames[0][0]
# optional fast-forward of waiting periods: SPEED="start:end:factor[,start:end:factor]" (seconds into the video)
for seg in filter(None, os.environ.get("SPEED", "").split(",")):
    a_, b_, k_ = (float(v) for v in seg.split(":"))
    def warp(t, a_=a_, b_=b_, k_=k_):
        r = t - t0
        return t0 + (r if r < a_ else a_ + (r - a_) / k_ if r <= b_ else a_ + (b_ - a_) / k_ + (r - b_))
    frames = [(warp(t), n) for t, n in frames]
kept = []                       # drop frames closer than 1/60 s (fast-forwarded spans) instead of stretching them
for t, n in frames:
    if not kept or t - kept[-1][0] >= 1 / 60:
        kept.append((t, n))
frames = kept
lines = []
for (t, name), nxt in zip(frames, frames[1:] + [(frames[-1][0] + 1 / 30, None)]):
    lines.append(f"file 'frames/{name}'")
    lines.append(f"duration {nxt[0] - t:.4f}")
lines.append(f"file 'frames/{frames[-1][1]}'")          # concat demuxer needs the last file twice
(work / "list.txt").write_text("\n".join(lines))
ff = imageio_ffmpeg.get_ffmpeg_exe()
out.parent.mkdir(parents=True, exist_ok=True)
subprocess.run([ff, "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", "list.txt",
                "-vf", "fps=30,format=yuv420p", "-c:v", "libx264", "-preset", "slow", "-crf", "27",
                "-movflags", "+faststart", str(out.resolve())], cwd=work, check=True)
# poster: the frame closest to poster_t seconds into the video
best = min(frames, key=lambda f: abs((f[0] - t0) - poster_t))
shutil.copy(work / "frames" / best[1], work / "poster.jpg")
subprocess.run([ff, "-y", "-loglevel", "error", "-i", str(work / "poster.jpg"), str(poster.resolve())], check=True)
total = frames[-1][0] - t0
print(f"{len(frames)} frames, {total:.1f}s, avg {len(frames) / total:.1f} fps -> {out} ({out.stat().st_size / 1e6:.1f} MB)")
