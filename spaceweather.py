# OrbitGuard | ASTRA 2026 | Team AstroNex
"""Space weather (NASA DONKI + NOAA SWPC live Kp) and storm-driven drag alerts for low-orbit satellites.

How the drag alert works (simplified, explainable model):
  1. Read geomagnetic storm data from NASA DONKI (GST events with Kp index) and the live planetary Kp.
  2. A geomagnetic storm heats the upper atmosphere, so air density at satellite altitudes rises.
     We scale a standard exponential density model by a storm multiplier that grows with Kp.
  3. Each satellite's drag sensitivity comes from its TLE B* term (Cd*A/m = 12.74 * B*  [m^2/kg]).
  4. Altitude loss per day = rho * (Cd*A/m) * sqrt(mu * a) * 86400   (circular-orbit decay rate).
  5. Satellites whose loss during the storm crosses a threshold are flagged.
"""
import json
import math
from datetime import datetime, timedelta, timezone

import requests

from config import DATA_DIR, EARTH_RADIUS_KM, HTTP_TIMEOUT, MU_EARTH, NASA_API_KEY, USER_AGENT

DONKI_URL = "https://api.nasa.gov/DONKI/"
NOAA_KP_URL = "https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json"

# Vallado exponential atmosphere: (base altitude km, base density kg/m^3, scale height km)
_ATMOSPHERE = [
    (100, 5.297e-7, 5.877), (110, 9.661e-8, 7.263), (120, 2.438e-8, 9.473), (130, 8.484e-9, 12.636),
    (140, 3.845e-9, 16.149), (150, 2.070e-9, 22.523), (180, 5.464e-10, 29.740), (200, 2.789e-10, 37.105),
    (250, 7.248e-11, 45.546), (300, 2.418e-11, 53.628), (350, 9.518e-12, 53.298), (400, 3.725e-12, 58.515),
    (450, 1.585e-12, 60.828), (500, 6.967e-13, 63.822), (600, 1.454e-13, 71.835), (700, 3.614e-14, 88.667),
    (800, 1.170e-14, 124.64), (900, 5.245e-15, 181.05), (1000, 3.019e-15, 268.00),
]
TYPICAL_BC = 0.02          # m^2/kg, a typical small satellite when B* is missing or unusable
FLAG_BELOW_KM = 650        # only low orbits feel meaningful drag


# ----------------------------------------------------------------------------- data fetch

def _get_json(url: str, params: dict | None = None):
    resp = requests.get(url, params=params, headers={"User-Agent": USER_AGENT}, timeout=HTTP_TIMEOUT)
    resp.raise_for_status()
    return resp.json() if resp.text.strip() else []


_LAST_GOOD_FILE = DATA_DIR / "donki_last_good.json"


def _load_last_good() -> dict:
    try:
        return json.loads(_LAST_GOOD_FILE.read_text())
    except (OSError, ValueError):
        return {}


_last_good = _load_last_good()     # kind -> {"t": iso time, "data": [...]}


def _donki(kind: str, days: int) -> list[dict]:
    end = datetime.now(timezone.utc).date()
    start = end - timedelta(days=days)
    try:
        data = _get_json(DONKI_URL + kind, {"startDate": start.isoformat(), "endDate": end.isoformat(),
                                            "api_key": NASA_API_KEY}) or []
    except requests.HTTPError as exc:
        if exc.response is not None and exc.response.status_code == 404:
            data = []                # DONKI answers 404 when a window has no events
        else:
            raise
    _last_good[kind] = {"t": datetime.now(timezone.utc).isoformat(timespec="minutes"), "data": data}
    try:
        _LAST_GOOD_FILE.write_text(json.dumps(_last_good))
    except OSError:
        pass                         # read-only disk (serverless): memory copy still helps
    return data


def _donki_or_cached(kind: str, days: int, errors: dict, label: str) -> list[dict]:
    """Live DONKI data, or the last good copy (with a note) if NASA is rate-limiting / down."""
    try:
        return _donki(kind, days)
    except Exception as exc:
        hit = _last_good.get(kind)
        if hit:
            errors[label] = f"{_friendly(exc)} Showing NASA data saved at {hit['t'][:16].replace('T', ' ')} UTC."
            return hit["data"]
        errors[label] = _friendly(exc)
        return []


def _noaa_kp() -> list[dict]:
    """NOAA SWPC 3-hourly planetary Kp for the last ~7 days (handles both list and dict formats)."""
    raw = _get_json(NOAA_KP_URL)
    rows = []
    if raw and isinstance(raw[0], list):        # [["time_tag","Kp",...], [...], ...]
        head = [h.lower() for h in raw[0]]
        ti, ki = head.index("time_tag"), head.index("kp")
        raw = [{"time_tag": r[ti], "Kp": r[ki]} for r in raw[1:]]
    for r in raw:
        try:
            kp = float(r.get("Kp", r.get("kp_index")))
            t = str(r["time_tag"]).replace(" ", "T")
            rows.append({"t": t if t.endswith("Z") else t[:19] + "Z", "kp": kp, "src": "NOAA SWPC"})
        except (TypeError, ValueError, KeyError):
            continue
    return rows


def g_level(kp: float) -> int:
    """NOAA geomagnetic storm scale: Kp 5 = G1 ... Kp 9 = G5."""
    return 0 if kp < 5 else min(5, int(math.floor(kp + 1e-9)) - 4)


G_NAMES = {0: "Quiet", 1: "G1 Minor", 2: "G2 Moderate", 3: "G3 Strong", 4: "G4 Severe", 5: "G5 Extreme"}


def _friendly(exc: Exception) -> str:
    s = str(exc)
    if "429" in s:
        return "NASA DEMO_KEY rate limit reached (about 30 requests/hour). Set NASA_API_KEY for more."
    if isinstance(exc, (requests.ConnectionError, requests.Timeout)):
        return "Could not reach the data server. Check the internet connection."
    return s[:200]


def summary() -> dict:
    """Everything the space-weather page needs, gathered from NASA DONKI (and NOAA for live Kp)."""
    out = {"errors": {}, "storms": [], "flares": [], "cmes": [], "kp_series": []}

    gst = _donki_or_cached("GST", 30, out["errors"], "storms")
    for g in gst:
        kps = [float(k["kpIndex"]) for k in (g.get("allKpIndex") or []) if k.get("kpIndex") is not None]
        for k in g.get("allKpIndex") or []:
            out["kp_series"].append({"t": k["observedTime"], "kp": float(k["kpIndex"]), "src": "NASA DONKI"})
        mk = max(kps) if kps else 5.0
        out["storms"].append({"id": g.get("gstID"), "start": g.get("startTime"), "max_kp": mk,
                              "level": G_NAMES[g_level(mk)], "link": g.get("link")})
    out["storms"].sort(key=lambda s: s["start"] or "", reverse=True)

    flr = _donki_or_cached("FLR", 7, out["errors"], "flares")
    for f in flr:
        cls = f.get("classType") or "?"
        out["flares"].append({"id": f.get("flrID"), "peak": f.get("peakTime"), "class": cls,
                              "region": f.get("activeRegionNum"), "link": f.get("link"),
                              "strong": cls[:1] in ("M", "X")})
    out["flares"].sort(key=lambda f: f["peak"] or "", reverse=True)

    cme = _donki_or_cached("CME", 7, out["errors"], "cmes")
    for c in cme:
        an = c.get("cmeAnalyses") or []
        best = next((a for a in an if a.get("isMostAccurate")), an[0] if an else {}) or {}
        enlil = [e for a in an for e in (a.get("enlilList") or [])]
        arrival = next((e.get("estimatedShockArrivalTime") for e in enlil if e.get("estimatedShockArrivalTime")), None)
        out["cmes"].append({"id": c.get("activityID"), "start": c.get("startTime"), "speed_kms": best.get("speed"),
                            "type": best.get("type"), "earth_arrival": arrival,
                            "earth_directed": bool(arrival) or any(e.get("isEarthGB") for e in enlil),
                            "note": (c.get("note") or "")[:240], "link": c.get("link")})
    out["cmes"].sort(key=lambda c: c["start"] or "", reverse=True)

    try:
        noaa = _noaa_kp()
    except Exception as exc:
        noaa, out["errors"]["kp_live"] = [], _friendly(exc)

    now = datetime.now(timezone.utc)

    def age_h(t: str) -> float:
        try:
            return (now - datetime.fromisoformat(t.replace("Z", "+00:00"))).total_seconds() / 3600
        except ValueError:
            return 1e9

    series = sorted(out["kp_series"] + noaa, key=lambda r: r["t"])
    out["kp_series"] = [r for r in series if age_h(r["t"]) <= 24 * 30]
    recent = [r for r in series if age_h(r["t"]) <= 24]
    if noaa:
        latest = noaa[-1]
        out["kp_now"], out["kp_source"] = latest["kp"], "NOAA SWPC (live, 3-hourly)"
    elif recent:
        out["kp_now"], out["kp_source"] = recent[-1]["kp"], "NASA DONKI"
    else:
        out["kp_now"], out["kp_source"] = 2.0, "No storm reported by NASA DONKI in the last 24 h (quiet assumed)"
    out["kp_24h_max"] = max([r["kp"] for r in recent] + [out["kp_now"]])
    out["g_now"] = g_level(out["kp_24h_max"])
    out["g_name"] = G_NAMES[out["g_now"]]
    out["storms_30d"] = len(out["storms"])
    out["strong_flares_7d"] = sum(f["strong"] for f in out["flares"])
    out["earth_cmes_7d"] = sum(c["earth_directed"] for c in out["cmes"])
    return out


# ----------------------------------------------------------------------------- drag model

def density(alt_km: float) -> float:
    base = _ATMOSPHERE[0]
    for row in _ATMOSPHERE:
        if alt_km >= row[0]:
            base = row
    h0, rho0, H = base
    return rho0 * math.exp(-(alt_km - h0) / H)


def storm_multiplier(kp: float, alt_km: float = 450) -> float:
    """How much denser the upper atmosphere gets during a storm (1 = quiet).

    Roughly x2 at Kp 5, x4 at Kp 7, x6 at Kp 9 near 400-500 km; the effect is weaker lower down.
    """
    base = 1 + 0.55 * max(0.0, kp - 3) ** 1.25
    sens = min(1.2, max(0.4, 0.4 + alt_km / 800))
    return 1 + (base - 1) * sens


def decay_m_per_day(alt_km: float, bc_m2_kg: float, mult: float = 1.0) -> float:
    a_m = (EARTH_RADIUS_KM + alt_km) * 1e3
    return density(alt_km) * mult * bc_m2_kg * math.sqrt(MU_EARTH * 1e9 * a_m) * 86400


def ballistic(bstar: float) -> tuple[float, bool]:
    """Cd*A/m (m^2/kg) from TLE B* (1/earth radii). Returns (value, assumed?)."""
    if bstar is None or bstar <= 1e-6:
        return TYPICAL_BC, True
    return min(0.15, max(0.001, 12.741621 * bstar)), False


def _kind(name: str) -> str:
    return "debris" if " DEB" in name else "rocket body" if "R/B" in name else "satellite"


def drag_alerts(catalog, kp: float, include_debris: bool = False, limit: int = 300) -> dict:
    flagged, counts = [], {"HIGH": 0, "ELEVATED": 0, "WATCH": 0}
    screened = 0
    for s in catalog:
        alt = s.a_km - EARTH_RADIUS_KM
        if s.ecc > 0.05 or alt > FLAG_BELOW_KM or alt < 120:
            continue
        kind = _kind(s.name)
        if kind != "satellite" and not include_debris:
            continue
        screened += 1
        bc, assumed = ballistic(s.bstar)
        mult = storm_multiplier(kp, alt)
        quiet = decay_m_per_day(alt, bc)
        storm = decay_m_per_day(alt, bc, mult)
        extra = storm - quiet           # altitude lost *because of* the storm (m/day)
        if extra >= 1000 or (alt < 250 and kp >= 5):
            level = "HIGH"
        elif extra >= 300:
            level = "ELEVATED"
        elif extra >= 100:
            level = "WATCH"
        else:
            continue
        counts[level] += 1
        days_to_200 = None
        if storm > 0 and alt > 200:
            # rough natural lifetime: integrate the quiet-sun decay rate down to 200 km in 10 km steps
            t, h = 0.0, alt
            while h > 200 and t < 36500:
                step = min(10.0, h - 200)
                t += step * 1000 / decay_m_per_day(h - step / 2, bc)
                h -= step
            days_to_200 = t
        flagged.append({
            "norad": s.norad, "name": s.name, "kind": kind, "alt_km": alt, "perigee_km": s.perigee_km,
            "inc_deg": s.inc_deg, "bc": bc, "bc_assumed": assumed, "multiplier": mult,
            "quiet_m_day": quiet, "storm_m_day": storm, "extra_m_day": storm - quiet,
            "level": level, "days_to_reentry_est": days_to_200,
        })
    flagged.sort(key=lambda r: r["storm_m_day"], reverse=True)

    alts = list(range(200, 801, 10))
    curve = {"alt": alts,
             "quiet": [decay_m_per_day(h, TYPICAL_BC) for h in alts],
             "storm": [decay_m_per_day(h, TYPICAL_BC, storm_multiplier(kp, h)) for h in alts]}
    return {"kp": kp, "g_level": g_level(kp), "g_name": G_NAMES[g_level(kp)],
            "multiplier_450km": storm_multiplier(kp, 450), "screened": screened,
            "counts": counts, "flagged": flagged[:limit], "total_flagged": len(flagged), "curve": curve}
