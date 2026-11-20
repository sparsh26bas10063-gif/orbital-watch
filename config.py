"""Shared settings and physical constants."""
import os
from pathlib import Path

# Free key from https://api.nasa.gov (DEMO_KEY works but is limited to ~30 requests/hour)
NASA_API_KEY = os.getenv("NASA_API_KEY", "DEMO_KEY")

BASE_DIR = Path(__file__).resolve().parent
if os.getenv("VERCEL"):
    # Vercel's filesystem is read-only except /tmp (wiped between cold starts)
    DATA_DIR = Path("/tmp/orbital_watch/data")
    OUTPUT_DIR = Path("/tmp/orbital_watch/output")
else:
    DATA_DIR = BASE_DIR / "data"
    OUTPUT_DIR = BASE_DIR / "output"
DATA_DIR.mkdir(parents=True, exist_ok=True)
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

HTTP_TIMEOUT = 60
USER_AGENT = "orbital-watch-student-project/1.0"

# Physical constants
EARTH_RADIUS_KM = 6378.137
MU_EARTH = 398600.4418          # km^3/s^2
J2 = 1.08262668e-3
LUNAR_DISTANCE_KM = 384400.0
AU_KM = 149597870.7
SECONDS_PER_DAY = 86400.0
