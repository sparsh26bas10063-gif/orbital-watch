"""Satellite search + profile (CelesTrak SATCAT, Wikipedia image/summary, mission category) and place geocoding."""
import re
import time
from datetime import datetime, timezone

import numpy as np
import requests
from sgp4.api import jday

from config import EARTH_RADIUS_KM, MU_EARTH, USER_AGENT

WEB_TIMEOUT = 12
SATCAT_URL = "https://celestrak.org/satcat/records.php"
WIKI_API = "https://en.wikipedia.org/w/api.php"
WIKI_SUMMARY = "https://en.wikipedia.org/api/rest_v1/page/summary/"
NOMINATIM = "https://nominatim.openstreetmap.org/search"
PHOTON = "https://photon.komoot.io/api/"

_cache: dict = {}


def _cached(key, ttl, fn):
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < ttl:
        return hit[1]
    val = fn()
    _cache[key] = (time.time(), val)
    return val


def _get(url, params=None, timeout=WEB_TIMEOUT):
    r = requests.get(url, params=params, headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
                     timeout=timeout)
    r.raise_for_status()
    return r.json()


# ----------------------------------------------------------------------------- search

ALIASES = {
    "iss": 25544, "international space station": 25544, "space station": 25544, "zarya": 25544,
    "hubble": 20580, "hst": 20580, "hubble space telescope": 20580,
    "tiangong": 48274, "css": 48274, "chinese space station": 48274, "tianhe": 48274,
    "noaa 20": 43013, "noaa-20": 43013, "jpss-1": 43013,
    "terra": 25994, "aqua": 27424, "landsat 8": 39084, "landsat 9": 49260,
    "sentinel 2a": 40697, "sentinel-2a": 40697, "sentinel 2b": 42063, "sentinel-2b": 42063,
    "suomi npp": 37849, "goes 16": 41866, "goes-16": 41866, "goes 18": 51850,
}
POPULAR = [25544, 48274, 20580, 43013, 25994, 27424, 39084, 49260, 40697, 42063, 37849]


def kind_of(name: str) -> str:
    return "debris" if " DEB" in name else "rocket body" if "R/B" in name else "satellite"


def regime(alt_km: float) -> str:
    return "LEO" if alt_km < 2000 else "MEO" if alt_km < 30000 else "GEO" if alt_km < 37000 else "HEO"


def search(catalog, q: str, limit: int = 12) -> list[dict]:
    q = q.strip()
    if not q:
        return []
    ql = q.lower()
    hits: dict[int, int] = {}       # norad -> rank (lower is better)
    if ql in ALIASES:
        hits[ALIASES[ql]] = 0
    for k, v in ALIASES.items():
        if k.startswith(ql) and len(ql) >= 2:
            hits.setdefault(v, 1)
    if ql.isdigit():
        for s in catalog:
            if str(s.norad).startswith(ql):
                hits.setdefault(s.norad, 2 if str(s.norad) == ql else 5)
    norm = re.sub(r"[\s_-]+", " ", ql)
    for s in catalog:
        n = re.sub(r"[\s_-]+", " ", s.name.lower())
        if n == norm:
            hits.setdefault(s.norad, 2)
        elif n.startswith(norm):
            hits.setdefault(s.norad, 3)
        elif norm in n:
            hits.setdefault(s.norad, 4)
    by_id = {s.norad: s for s in catalog}
    ranked = sorted((r, 0 if nid in POPULAR else 1, kind_of(by_id[nid].name) != "satellite", nid)
                    for nid, r in hits.items() if nid in by_id)
    out = []
    for *_, nid in ranked[:limit]:
        s = by_id[nid]
        alt = s.a_km - EARTH_RADIUS_KM
        out.append({"norad": s.norad, "name": s.name, "kind": kind_of(s.name), "alt_km": alt,
                    "regime": regime(alt), "inc_deg": s.inc_deg})
    return out


# ----------------------------------------------------------------------------- mission category

MISSION_RULES = [
    (r"^ISS|ZARYA", "Crewed space station", "International Space Station: a crewed orbiting laboratory run by NASA, Roscosmos, ESA, JAXA and CSA."),
    (r"^CSS|TIANHE|WENTIAN|MENGTIAN", "Crewed space station", "China's Tiangong space station."),
    (r"^HST$|HUBBLE", "Space telescope", "Hubble Space Telescope, observing the universe in visible, UV and near-IR light."),
    (r"STARLINK", "Broadband internet constellation", "Part of SpaceX's Starlink low-orbit internet constellation."),
    (r"ONEWEB", "Broadband internet constellation", "Part of the OneWeb (Eutelsat) internet constellation."),
    (r"KUIPER", "Broadband internet constellation", "Part of Amazon's Project Kuiper internet constellation."),
    (r"IRIDIUM", "Satellite phone / data relay", "Iridium constellation for global voice and data links."),
    (r"GLOBALSTAR", "Satellite phone / data relay", "Globalstar mobile satellite communications."),
    (r"ORBCOMM", "IoT / messaging", "ORBCOMM machine-to-machine messaging."),
    (r"GPS|NAVSTAR", "Navigation (GNSS)", "US GPS navigation satellite."),
    (r"GLONASS|COSMOS 2[45]\d\d", "Navigation (GNSS)", "Russian GLONASS navigation satellite."),
    (r"GALILEO|GSAT0", "Navigation (GNSS)", "European Galileo navigation satellite."),
    (r"BEIDOU", "Navigation (GNSS)", "Chinese BeiDou navigation satellite."),
    (r"IRNSS|NVS-", "Navigation (GNSS)", "India's NavIC regional navigation satellite."),
    (r"NOAA|METOP|GOES|METEOSAT|HIMAWARI|FENGYUN|FY-|METEOR|JPSS|SUOMI|DMSP|INSAT-3D", "Weather / meteorology", "Weather satellite feeding forecasts and climate records."),
    (r"LANDSAT|SENTINEL|TERRA|AQUA|AURA|WORLDVIEW|PLEIADES|SPOT|CARTOSAT|RESOURCESAT|EOS-|RISAT|GAOFEN|SKYSAT|FLOCK|DOVE|LEMUR|ICEYE|CAPELLA|KOMPSAT|RADARSAT|SWOT|GRACE|ICESAT|OCO", "Earth observation", "Earth-imaging / Earth-science satellite."),
    (r"INTELSAT|SES|EUTELSAT|ASTRA|TELSTAR|VIASAT|ECHOSTAR|INMARSAT|GSAT|THAICOM|ARABSAT|TURKSAT|NILESAT|ANIK|JCSAT|APSTAR|CHINASAT|YAMAL|EXPRESS", "Communications (GEO)", "Commercial communications satellite (TV, broadband, relay)."),
    (r"TDRS", "Data relay", "NASA Tracking and Data Relay Satellite."),
    (r"CREW DRAGON|DRAGON|SOYUZ|PROGRESS|CYGNUS|SHENZHOU|TIANZHOU|STARLINER", "Crew / cargo vehicle", "Spacecraft carrying crew or cargo to a space station."),
    (r"CUBESAT|\bCUBE\b|SAT-\d|-SAT", "Small satellite / CubeSat", "Small satellite, often for technology demos, education or research."),
]


def mission_of(name: str) -> tuple[str, str]:
    up = name.upper()
    if " DEB" in up:
        return "Debris fragment", "A tracked piece of debris from a broken-up satellite or rocket. Uncontrolled and a collision hazard."
    if "R/B" in up:
        return "Spent rocket stage", "An upper stage left in orbit after launch. Large, uncontrolled and a major debris source."
    for pat, cat, desc in MISSION_RULES:
        if re.search(pat, up):
            return cat, desc
    return "Satellite", "Active satellite tracked in the CelesTrak public catalog."


OWNERS = {
    "US": "United States", "PRC": "China", "CIS": "Russia / former USSR", "IND": "India", "ISS": "International (ISS partners)",
    "ESA": "European Space Agency", "JPN": "Japan", "FR": "France", "UK": "United Kingdom", "GER": "Germany",
    "IT": "Italy", "CA": "Canada", "SKOR": "South Korea", "ISRA": "Israel", "BRAZ": "Brazil", "SPN": "Spain",
    "AUS": "Australia", "UAE": "United Arab Emirates", "SES": "SES (Luxembourg)", "O3B": "O3b Networks",
    "ITSO": "Intelsat", "GLOB": "Globalstar", "ORB": "ORBCOMM", "EUTE": "Eutelsat", "IRID": "Iridium",
    "FIN": "Finland", "NOR": "Norway", "TURK": "Turkey", "ARGN": "Argentina", "TWN": "Taiwan", "NZ": "New Zealand",
}
SITES = {
    "AFETR": "Cape Canaveral, USA", "AFWTR": "Vandenberg, USA", "TYMSC": "Baikonur, Kazakhstan",
    "PLMSC": "Plesetsk, Russia", "SRILR": "Sriharikota, India", "FRGUI": "Kourou, French Guiana",
    "JSC": "Jiuquan, China", "TSC": "Taiyuan, China", "XSC": "Xichang, China", "WSC": "Wenchang, China",
    "TNSTA": "Tanegashima, Japan", "KYMSC": "Kapustin Yar, Russia", "VOSTO": "Vostochny, Russia",
    "RLLB": "Rocket Lab, Mahia, New Zealand", "KSCUT": "Uchinoura, Japan", "WRAS": "Wallops, USA",
    "YSLA": "Yellow Sea (sea launch), China", "SEAL": "Sea Launch, Pacific", "SVOBO": "Svobodny, Russia",
}
STATUS = {"+": "Operational", "-": "Non-operational", "P": "Partially operational", "B": "Backup / standby",
          "S": "Spare", "X": "Extended mission", "D": "Decayed", "?": "Unknown"}


def satcat(norad: int) -> dict | None:
    def fetch():
        try:
            rows = _get(SATCAT_URL, {"CATNR": norad, "FORMAT": "json"})
        except Exception:
            return None
        if not rows:
            return None
        r = rows[0]
        return {"intl_des": r.get("OBJECT_ID"), "type": r.get("OBJECT_TYPE"),
                "status": STATUS.get(r.get("OPS_STATUS_CODE") or "?", "Unknown"),
                "owner_code": r.get("OWNER"), "owner": OWNERS.get(r.get("OWNER"), r.get("OWNER")),
                "launch_date": r.get("LAUNCH_DATE"),
                "launch_site": SITES.get(r.get("LAUNCH_SITE"), r.get("LAUNCH_SITE")),
                "rcs_m2": r.get("RCS"), "decay_date": r.get("DECAY_DATE")}
    return _cached(("satcat", norad), 24 * 3600, fetch)


# ----------------------------------------------------------------------------- Wikipedia

WIKI_TITLES = {25544: "International Space Station", 48274: "Tiangong space station", 20580: "Hubble Space Telescope",
               43013: "NOAA-20", 25994: "Terra (satellite)", 27424: "Aqua (satellite)", 39084: "Landsat 8",
               49260: "Landsat 9", 40697: "Sentinel-2", 42063: "Sentinel-2", 37849: "Suomi NPP"}
SPACE_WORDS = ("satellite", "spacecraft", "space station", "telescope", "constellation", "orbit", "rocket",
               "launch vehicle", "probe", "observatory", "cubesat", "space")


def _summary(title: str) -> dict | None:
    try:
        s = _get(WIKI_SUMMARY + requests.utils.quote(title.replace(" ", "_"), safe=""))
    except Exception:
        return None
    if s.get("type") == "disambiguation":
        return None
    text = f"{s.get('description', '')} {s.get('extract', '')}".lower()
    if not any(w in text for w in SPACE_WORDS):
        return None
    img = (s.get("originalimage") or s.get("thumbnail") or {}).get("source")
    return {"title": s.get("title"), "description": s.get("description"), "extract": s.get("extract"),
            "image": (s.get("thumbnail") or {}).get("source") or img, "image_full": img,
            "url": (s.get("content_urls") or {}).get("desktop", {}).get("page")}


def wiki(norad: int, name: str) -> dict | None:
    def fetch():
        if norad in WIKI_TITLES:
            return _summary(WIKI_TITLES[norad])
        base = re.sub(r"\s*\(.*?\)", "", name).strip()
        family = re.sub(r"[\s-]*\d+[A-Z]?$", "", base).strip()     # STARLINK-1234 -> STARLINK
        tried = set()
        for cand in (base, family):
            if not cand or cand.lower() in tried or " DEB" in cand or "R/B" in cand:
                continue
            tried.add(cand.lower())
            try:
                res = _get(WIKI_API, {"action": "query", "list": "search", "srsearch": f"{cand} satellite",
                                      "srlimit": 3, "format": "json"})
            except Exception:
                return None
            for hit in res.get("query", {}).get("search", []):
                words = re.findall(r"[a-z]+", cand.lower())
                if words and not any(w in hit["title"].lower() for w in words if len(w) > 2):
                    continue
                s = _summary(hit["title"])
                if s:
                    return s
        return None
    return _cached(("wiki", norad), 24 * 3600, fetch)


# ----------------------------------------------------------------------------- profile

def _intl_des(line1: str) -> str | None:
    raw = line1[9:17].strip()
    if len(raw) < 5:
        return None
    yy = int(raw[:2])
    return f"{1900 + yy if yy >= 57 else 2000 + yy}-{raw[2:]}"


def position_now(s) -> dict:
    now = datetime.now(timezone.utc)
    jd, fr = jday(now.year, now.month, now.day, now.hour, now.minute, now.second + now.microsecond / 1e6)
    err, r, v = s.satrec.sgp4(jd, fr)
    if err:
        return {}
    r, v = np.array(r), np.array(v)
    t = (jd + fr - 2451545.0)
    gmst = np.radians((280.46061837 + 360.98564736629 * t) % 360)
    lon = np.degrees(np.arctan2(r[1], r[0]) - gmst)
    lon = (lon + 540) % 360 - 180
    lat = np.degrees(np.arctan2(r[2], np.hypot(r[0], r[1])))
    return {"lat": float(lat), "lon": float(lon), "alt_km": float(np.linalg.norm(r) - EARTH_RADIUS_KM),
            "speed_kms": float(np.linalg.norm(v)), "time": now}


def profile(s) -> dict:
    alt = s.a_km - EARTH_RADIUS_KM
    category, blurb = mission_of(s.name)
    cat = satcat(s.norad) or {}
    w = wiki(s.norad, s.name) if kind_of(s.name) == "satellite" else None
    intl = cat.get("intl_des") or _intl_des(s.line1)
    return {
        "norad": s.norad, "name": s.name, "kind": kind_of(s.name), "regime": regime(alt),
        "mission": {"category": category, "summary": blurb},
        "intl_des": intl, "satcat": cat, "wiki": w,
        "orbit": {"alt_km": alt, "perigee_km": s.perigee_km, "apogee_km": s.apogee_km, "inc_deg": s.inc_deg,
                  "ecc": s.ecc, "period_min": s.period_min, "raan_deg": s.raan_deg, "bstar": s.bstar,
                  "speed_kms": float(np.sqrt(MU_EARTH / s.a_km)), "epoch": s.epoch,
                  "tle_age_h": (datetime.now(timezone.utc) - s.epoch).total_seconds() / 3600},
        "now": position_now(s), "tle": [s.line1, s.line2],
    }


# ----------------------------------------------------------------------------- geocoding

def geocode(q: str) -> list[dict]:
    q = q.strip()
    m = re.fullmatch(r"\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*", q)
    if m:
        lat, lon = float(m.group(1)), float(m.group(2))
        if -90 <= lat <= 90 and -180 <= lon <= 180:
            return [{"name": f"{lat:.4f}, {lon:.4f}", "lat": lat, "lon": lon, "type": "coordinates"}]
        raise ValueError("Coordinates out of range: latitude must be -90..90 and longitude -180..180")

    def fetch():
        try:
            rows = _get(NOMINATIM, {"q": q, "format": "jsonv2", "limit": 6, "accept-language": "en"})
            return [{"name": r["display_name"], "lat": float(r["lat"]), "lon": float(r["lon"]),
                     "type": r.get("type") or r.get("category"),
                     "bbox": [float(x) for x in r["boundingbox"]] if r.get("boundingbox") else None} for r in rows]
        except Exception:
            rows = _get(PHOTON, {"q": q, "limit": 6}).get("features", [])
            out = []
            for f in rows:
                p = f.get("properties", {})
                lon, lat = f["geometry"]["coordinates"]
                label = ", ".join(x for x in (p.get("name"), p.get("city"), p.get("state"), p.get("country")) if x)
                out.append({"name": label or q, "lat": lat, "lon": lon, "type": p.get("osm_value")})
            return out
    return _cached(("geo", q.lower()), 24 * 3600, fetch)
