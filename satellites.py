"""Satellite orbit data (CelesTrak), disturbance detection and conjunction screening (SGP4)."""
import json
import time
from datetime import datetime, timedelta, timezone

import numpy as np
import requests
from sgp4.api import Satrec, SatrecArray, jday

from config import DATA_DIR, EARTH_RADIUS_KM, HTTP_TIMEOUT, MU_EARTH, TLE_MIRROR_URL, USER_AGENT

CELESTRAK_URL = "https://celestrak.org/NORAD/elements/gp.php"
CACHE_HOURS = 2  # CelesTrak updates data every ~2 h and asks clients not to download more often
SNAPSHOT_FILE = DATA_DIR / "orbit_snapshot.json"

# Free CelesTrak queries: active satellites + the biggest debris clouds
CATALOG_QUERIES = {
    "active": {"GROUP": "active"},
    "cosmos-2251-debris": {"GROUP": "cosmos-2251-debris"},
    "iridium-33-debris": {"GROUP": "iridium-33-debris"},
    "fengyun-1c-debris": {"INTDES": "1999-025"},
    "cosmos-1408-debris": {"INTDES": "1982-092"},
}


class Sat:
    """A satellite parsed from a TLE plus derived orbital elements."""

    def __init__(self, name: str, line1: str, line2: str):
        self.name = name.strip()
        self.line1, self.line2 = line1, line2
        self.satrec = Satrec.twoline2rv(line1, line2)
        self.norad = int(self.satrec.satnum)
        n_rad_s = self.satrec.no_kozai / 60.0                      # rad/min -> rad/s
        self.a_km = (MU_EARTH / n_rad_s ** 2) ** (1 / 3)
        self.ecc = self.satrec.ecco
        self.inc_deg = float(np.degrees(self.satrec.inclo))
        self.raan_deg = float(np.degrees(self.satrec.nodeo))
        self.perigee_km = self.a_km * (1 - self.ecc) - EARTH_RADIUS_KM
        self.apogee_km = self.a_km * (1 + self.ecc) - EARTH_RADIUS_KM
        self.period_min = 2 * np.pi / self.satrec.no_kozai
        self.bstar = self.satrec.bstar
        self.epoch_jd = self.satrec.jdsatepoch + self.satrec.jdsatepochF

    @property
    def epoch(self) -> datetime:
        return datetime(2000, 1, 1, 12, tzinfo=timezone.utc) + timedelta(days=self.epoch_jd - 2451545.0)


def _from_mirror(name: str, which: str) -> str | None:
    """Fetch the copy saved by the GitHub Action (fast, no CelesTrak rate limits)."""
    try:
        resp = requests.get(f"{TLE_MIRROR_URL}/{which}/{name}.txt",
                            headers={"User-Agent": USER_AGENT}, timeout=30)
        if resp.ok and "\n1 " in resp.text:
            return resp.text
    except requests.RequestException:
        pass
    return None


def _download(name: str, params: dict, which: str = "current") -> str:
    cache = DATA_DIR / (f"tle_{name}.txt" if which == "current" else f"tle_{which}_{name}.txt")
    if cache.exists() and time.time() - cache.stat().st_mtime < CACHE_HOURS * 3600:
        return cache.read_text()
    text = _from_mirror(name, which)
    if text is None and which != "current":
        raise RuntimeError(f"no {which} data in mirror yet")
    if text is None:
        try:
            resp = requests.get(CELESTRAK_URL, params={**params, "FORMAT": "tle"},
                                headers={"User-Agent": USER_AGENT}, timeout=HTTP_TIMEOUT)
            resp.raise_for_status()
            text = resp.text
        except requests.RequestException as exc:
            # CelesTrak blocks IPs that download too often (HTTP 403); a stale copy beats no data
            if cache.exists():
                print(f"  [warn] {exc} -> using older cache for {name}")
                return cache.read_text()
            raise
    if "\n1 " not in text:
        # CelesTrak returns a plain-text message on errors / rate limiting
        if cache.exists():
            print(f"  [warn] CelesTrak said: {text.strip()[:120]} -> using older cache for {name}")
            return cache.read_text()
        raise RuntimeError(f"CelesTrak error for {name}: {text.strip()[:200]}")
    cache.write_text(text)
    return text


def parse_tles(text: str) -> list[Sat]:
    lines = [ln.rstrip() for ln in text.splitlines() if ln.strip()]
    sats = []
    for i in range(0, len(lines) - 2, 3):
        name, l1, l2 = lines[i], lines[i + 1], lines[i + 2]
        if l1.startswith("1 ") and l2.startswith("2 "):
            try:
                sats.append(Sat(name, l1, l2))
            except Exception:
                pass
    return sats


def fetch_catalog(queries: dict | None = None, which: str = "current") -> list[Sat]:
    """Download (or load cached) TLEs for all queries, de-duplicated by NORAD id.

    which="previous" loads the older copy kept by the GitHub Action (used for change detection).
    """
    queries = queries or CATALOG_QUERIES
    by_id: dict[int, Sat] = {}
    for name, params in queries.items():
        try:
            sats = parse_tles(_download(name, params, which))
            print(f"  {name:<22} {len(sats):>6} objects")
            for s in sats:
                by_id[s.norad] = s
        except Exception as exc:
            print(f"  [warn] could not load {name}: {exc}")
    return list(by_id.values())


# --------------------------------------------------------------------------- disturbances

def _snapshot(sats: list[Sat]) -> dict:
    return {str(s.norad): {"name": s.name, "epoch_jd": s.epoch_jd, "a_km": s.a_km, "ecc": s.ecc,
                           "inc_deg": s.inc_deg, "perigee_km": s.perigee_km, "apogee_km": s.apogee_km}
            for s in sats}


def detect_disturbances(sats: list[Sat], save: bool = True, previous_sats: list[Sat] | None = None,
                        da_km: float = 1.0, dinc_deg: float = 0.02, decay_km_per_day: float = 0.5) -> dict:
    """Compare current orbits with the previously saved snapshot.

    Flags:
      MANEUVER-UP / MANEUVER-DOWN : semi-major axis jumped more than `da_km` (beyond normal drag)
      PLANE-CHANGE                : inclination changed more than `dinc_deg`
      DECAYING                    : perigee falling faster than `decay_km_per_day`
      REENTRY-RISK                : perigee below 200 km right now
    """
    current = _snapshot(sats)
    if previous_sats is not None:            # compare with an explicit older catalog (website mode)
        previous, save = _snapshot(previous_sats), False
    else:
        previous = json.loads(SNAPSHOT_FILE.read_text()) if SNAPSHOT_FILE.exists() else {}
    had_baseline = bool(previous)
    events = []

    for s in sats:
        if s.perigee_km < 200 and s.ecc < 0.1:
            events.append({"norad": s.norad, "name": s.name, "type": "REENTRY-RISK",
                           "detail": f"perigee {s.perigee_km:.0f} km"})

    compared = 0
    for sid, now in current.items():
        old = previous.get(sid)
        if not old or now["epoch_jd"] <= old["epoch_jd"]:
            continue
        compared += 1
        dt_days = now["epoch_jd"] - old["epoch_jd"]
        da = now["a_km"] - old["a_km"]
        dinc = now["inc_deg"] - old["inc_deg"]
        dperi_rate = (now["perigee_km"] - old["perigee_km"]) / dt_days
        if da > da_km:
            events.append({"norad": int(sid), "name": now["name"], "type": "MANEUVER-UP",
                           "detail": f"a +{da:.2f} km in {dt_days:.2f} d"})
        elif da < -da_km and abs(da) / dt_days > 2 * da_km:
            events.append({"norad": int(sid), "name": now["name"], "type": "MANEUVER-DOWN",
                           "detail": f"a {da:.2f} km in {dt_days:.2f} d"})
        if abs(dinc) > dinc_deg:
            events.append({"norad": int(sid), "name": now["name"], "type": "PLANE-CHANGE",
                           "detail": f"inc {dinc:+.3f} deg"})
        if dperi_rate < -decay_km_per_day and now["perigee_km"] < 600:
            events.append({"norad": int(sid), "name": now["name"], "type": "DECAYING",
                           "detail": f"perigee {dperi_rate:.2f} km/day, now {now['perigee_km']:.0f} km"})

    if save:
        # merge so objects missing from this download keep their old baseline
        previous.update(current)
        SNAPSHOT_FILE.write_text(json.dumps(previous))
    return {"baseline_existed": had_baseline, "compared": compared, "events": events}


# --------------------------------------------------------------------------- conjunctions

def _positions(sats: list[Sat], jd: np.ndarray, fr: np.ndarray) -> np.ndarray:
    arr = SatrecArray([s.satrec for s in sats])
    err, r, _ = arr.sgp4(jd, fr)
    r[err != 0] = np.nan
    return r  # shape (n_sats, n_times, 3), TEME km


def find_conjunctions(target: Sat, catalog: list[Sat], hours: float = 24, threshold_km: float = 25,
                      coarse_step_s: int = 30, start: datetime | None = None) -> list[dict]:
    """Screen `target` against the catalog for close approaches in the next `hours`."""
    start = start or datetime.now(timezone.utc)
    margin = 50
    # Altitude-shell prefilter: only objects whose perigee-apogee band overlaps the target's
    cands = [s for s in catalog if s.norad != target.norad
             and s.perigee_km - margin <= target.apogee_km and s.apogee_km + margin >= target.perigee_km]
    if not cands:
        return []

    jd0, fr0 = jday(start.year, start.month, start.day, start.hour, start.minute, start.second)
    n_steps = int(hours * 3600 / coarse_step_s)
    offsets = np.arange(n_steps) * coarse_step_s / 86400.0

    results = {}
    chunk = 240
    for c0 in range(0, n_steps, chunk):
        fr = fr0 + offsets[c0:c0 + chunk]
        jd = np.full_like(fr, jd0)
        rt = _positions([target], jd, fr)[0]                       # (t, 3)
        rc = _positions(cands, jd, fr)                             # (n, t, 3)
        dist = np.linalg.norm(rc - rt[None, :, :], axis=2)
        dist = np.where(np.isnan(dist), np.inf, dist)
        idx = np.argmin(dist, axis=1)
        dmin = dist[np.arange(len(cands)), idx]
        for k in np.where(dmin < 500)[0]:                          # coarse screen, refine below
            t_off = offsets[c0 + idx[k]]
            prev = results.get(k)
            if prev is None or dmin[k] < prev[0]:
                results[k] = (dmin[k], t_off)

    events = []
    for k, (_, t_off) in results.items():
        fine = t_off + np.arange(-coarse_step_s, coarse_step_s + 1) / 86400.0
        fr = fr0 + fine
        jd = np.full_like(fr, jd0)
        rt = _positions([target], jd, fr)[0]
        rc = _positions([cands[k]], jd, fr)[0]
        d = np.linalg.norm(rc - rt, axis=1)
        i = int(np.nanargmin(d))
        rel_speed = float(np.linalg.norm(np.diff(rc - rt, axis=0)[min(i, len(d) - 2)]))
        if d[i] < 1.0 and rel_speed < 0.05:
            continue  # docked / attached to the target (e.g. ISS modules, visiting vehicles)
        if d[i] < threshold_km:
            when = datetime(2000, 1, 1, 12, tzinfo=timezone.utc) + timedelta(
                days=jd0 + fr[i] - 2451545.0)
            vt = np.diff(rt, axis=0)[min(i, len(d) - 2)]
            vc = np.diff(rc, axis=0)[min(i, len(d) - 2)]
            events.append({"name": cands[k].name, "norad": cands[k].norad, "time": when,
                           "miss_km": float(d[i]), "rel_speed_kms": float(np.linalg.norm(vc - vt))})
    return sorted(events, key=lambda e: e["miss_km"])


def find_by_norad(catalog: list[Sat], norad: int) -> Sat | None:
    return next((s for s in catalog if s.norad == norad), None)
