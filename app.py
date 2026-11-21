# OrbitGuard | ASTRA 2026 | Team AstroNex
"""OrbitGuard web app.  Run:  python app.py   then open http://127.0.0.1:5000"""
import math
import os
import threading
import time
from datetime import date, datetime

import numpy as np
import requests
from flask import Flask, jsonify, render_template, request
from werkzeug.exceptions import HTTPException

import asteroids
import config
import orbit_optimizer as oo
import satellites
import satinfo
import spaceweather

app = Flask(__name__)


@app.url_defaults
def _static_version(endpoint, values):
    """Add ?v=<mtime> to static URLs so browsers always load the newest CSS/JS after a change."""
    if endpoint == "static" and "filename" in values:
        try:
            values["v"] = int(os.path.getmtime(os.path.join(app.static_folder, values["filename"])))
        except OSError:
            pass

ON_VERCEL = bool(os.getenv("VERCEL"))
_catalogs = {}   # which -> {"sats": [...], "loaded": t}
_lock = threading.Lock()


# ============================================================================ errors

class ApiError(Exception):
    """An error with a friendly message, a machine code and a hint for the user."""

    def __init__(self, message: str, code: str = "BAD_REQUEST", status: int = 400, hint: str | None = None):
        super().__init__(message)
        self.message, self.code, self.status, self.hint = message, code, status, hint


def classify(exc: Exception) -> ApiError:
    """Turn any exception into a user-friendly ApiError."""
    if isinstance(exc, ApiError):
        return exc
    s = str(exc)
    if isinstance(exc, requests.HTTPError) and "429" in s:
        return ApiError("NASA's free DEMO_KEY rate limit was reached.", "RATE_LIMITED", 429,
                        "Wait a few minutes, or set the NASA_API_KEY environment variable (free at api.nasa.gov).")
    if isinstance(exc, (requests.ConnectionError, requests.Timeout)):
        return ApiError("A data source did not respond in time.", "UPSTREAM_UNAVAILABLE", 503,
                        "Check your internet connection and try again in a moment.")
    if isinstance(exc, requests.HTTPError):
        return ApiError(f"A data source returned an error ({s[:120]}).", "UPSTREAM_ERROR", 502,
                        "The external service may be down. Try again later.")
    if isinstance(exc, ValueError):
        return ApiError(s or "Invalid input.", "BAD_INPUT", 400, "Check the values you entered.")
    return ApiError("Something went wrong on our side.", "INTERNAL", 500, s[:200] or None)


def error_json(err: ApiError):
    return jsonify({"error": err.message, "code": err.code, "hint": err.hint, "status": err.status}), err.status


ERROR_PAGES = {
    404: ("Lost in space", "This page drifted out of orbit. The link may be broken or the page was moved."),
    405: ("Wrong approach vector", "That request method isn't allowed here."),
    500: ("Mission anomaly", "Something failed on our side. The team has been notified (well, the logs have)."),
    503: ("Loss of signal", "A data source is temporarily unreachable. Please try again shortly."),
}


@app.errorhandler(HTTPException)
def handle_http(exc: HTTPException):
    if request.path.startswith("/api/"):
        names = {404: "NOT_FOUND", 405: "METHOD_NOT_ALLOWED"}
        return error_json(ApiError(
            "No such API endpoint." if exc.code == 404 else exc.description, names.get(exc.code, "HTTP_ERROR"),
            exc.code or 500, "See /api for the list of endpoints." if exc.code == 404 else None))
    title, text = ERROR_PAGES.get(exc.code, ("Unexpected error", exc.description))
    return render_template("error.html", code=exc.code, title=title, text=text, path=request.path), exc.code


@app.errorhandler(Exception)
def handle_any(exc: Exception):
    err = classify(exc)
    if request.path.startswith("/api/"):
        return error_json(err)
    title, text = ERROR_PAGES[500]
    return render_template("error.html", code=500, title=title, text=text, path=request.path), 500


# ============================================================================ helpers

def get_catalog(which: str = "current"):
    with _lock:
        c = _catalogs.get(which)
        if c is None or not c["sats"] or time.time() - c["loaded"] > satellites.CACHE_HOURS * 3600:
            c = _catalogs[which] = {"sats": satellites.fetch_catalog(which=which), "loaded": time.time()}
        if not c["sats"]:
            raise ApiError("Satellite catalog could not be downloaded.", "CATALOG_UNAVAILABLE", 503,
                           "CelesTrak may be rate-limiting or offline. Try again in a few minutes.")
        return c["sats"]


def clean(obj):
    """Make numpy / datetime / inf values JSON-safe."""
    if isinstance(obj, dict):
        return {k: clean(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [clean(v) for v in obj]
    if isinstance(obj, (datetime, date)):
        return obj.isoformat()
    if isinstance(obj, (np.integer,)):
        return int(obj)
    if isinstance(obj, (float, np.floating)):
        f = float(obj)
        return None if math.isnan(f) or math.isinf(f) else f
    if isinstance(obj, np.bool_):
        return bool(obj)
    return obj


def api(fn):
    def wrapper(*a, **kw):
        try:
            return jsonify(clean(fn(*a, **kw)))
        except Exception as exc:
            app.logger.warning("API %s failed: %r", request.path, exc)
            return error_json(classify(exc))
    wrapper.__name__ = fn.__name__
    return wrapper


def arg(name, cast, default, lo=None, hi=None, label=None):
    """Read a query parameter with validation and a friendly error message."""
    raw = request.args.get(name)
    if raw in (None, ""):
        return default
    cap = lambda t: t[:1].upper() + t[1:]
    try:
        val = cast(raw)
    except (TypeError, ValueError):
        raise ApiError(f"'{raw}' is not a valid {label or name}.", "BAD_INPUT", 400,
                       f"{cap(label or name)} must be a number.") from None
    if (lo is not None and val < lo) or (hi is not None and val > hi):
        raise ApiError(f"{cap(label or name)} must be between {lo} and {hi}.", "OUT_OF_RANGE", 400)
    return val


_cache = {}   # key -> (time, data); NASA's DEMO_KEY allows only ~30 requests/hour


def cached(key, ttl, fn):
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < ttl:
        return hit[1]
    try:
        data = fn()
    except Exception:
        if hit:                      # serve stale data rather than nothing
            return hit[1]
        raise
    _cache[key] = (time.time(), data)
    return data


def find_sat(norad: int):
    s = satellites.find_by_norad(get_catalog(), norad)
    if not s:
        raise ApiError(f"No satellite with NORAD ID {norad} in the current catalog.", "SAT_NOT_FOUND", 404,
                       "Search by name instead, e.g. 'ISS', 'Hubble' or 'Starlink'.")
    return s


# ============================================================================ pages

@app.route("/")
def index():
    return render_template("index.html", sites=oo.LAUNCH_SITES, missions=list(oo.MISSIONS),
                           google_key=config.GOOGLE_MAPS_API_KEY)


@app.route("/api")
@app.route("/api/")
def api_index():
    return jsonify({"name": "OrbitGuard API", "endpoints": sorted(
        r.rule for r in app.url_map.iter_rules() if r.rule.startswith("/api/") and r.rule != "/api/")})


# ============================================================================ data endpoints

@app.route("/api/asteroids")
@api
def api_asteroids():
    out = {"neows": [], "jpl": []}
    try:
        out["neows"] = cached("neows", 3600, asteroids.fetch_neo_feed)
    except Exception as exc:
        out["neows_error"] = classify(exc).message
    days = arg("days", int, 60, 1, 365, "days")
    try:
        out["jpl"] = cached(f"jpl{days}", 3600, lambda: asteroids.fetch_jpl_close_approaches(days=days))
    except Exception as exc:
        out["jpl_error"] = classify(exc).message
    return out


@app.route("/api/catalog")
@api
def api_catalog():
    sats = get_catalog()
    return {"count": len(sats), "loaded": datetime.fromtimestamp(_catalogs["current"]["loaded"])}


@app.route("/api/disturbances")
@api
def api_disturbances():
    current = get_catalog()             # a real catalog failure should still surface as an error
    if ON_VERCEL:
        # serverless: no persistent disk, so compare with the older copy kept by the GitHub Action.
        # Right after the repo/mirror is created there is no "previous" copy yet: don't fail, just run
        # without a baseline (re-entry risks still work) and let the UI show its "first run" note.
        try:
            previous = get_catalog("previous")
        except ApiError:
            previous = []
        return satellites.detect_disturbances(current, previous_sats=previous)
    return satellites.detect_disturbances(current)


@app.route("/api/conjunctions")
@api
def api_conjunctions():
    norad = arg("norad", int, 25544, 1, 999999, "NORAD ID")
    hours = arg("hours", float, 24, 1, 72, "hours ahead")
    threshold = arg("threshold", float, 25, 0.5, 200, "distance threshold")
    target = find_sat(norad)
    events = cached(f"conj{norad}:{hours}:{threshold}", 600,
                    lambda: satellites.find_conjunctions(target, get_catalog(), hours=hours, threshold_km=threshold))
    return {"target": {"name": target.name, "norad": target.norad, "perigee_km": target.perigee_km,
                       "apogee_km": target.apogee_km, "inc_deg": target.inc_deg, "epoch": target.epoch},
            "events": events}


@app.route("/api/orbits")
@api
def api_orbits():
    """Compact orbital elements so the browser can animate satellites on the 3D globe."""
    cat = get_catalog()
    ids = request.args.get("ids")
    if ids:
        want = {int(x) for x in ids.split(",") if x.strip().isdigit()}
        sats = [s for s in cat if s.norad in want]
    else:
        limit = arg("limit", int, 4000, 100, 20000, "limit")
        sats = cat[::max(1, len(cat) // limit)]
        have = {s.norad for s in sats}
        sats += [s for s in cat if s.norad in satinfo.POPULAR and s.norad not in have]

    r = lambda x, d=6: round(float(x), d)
    kind = lambda n: {"debris": "deb", "rocket body": "rb"}.get(satinfo.kind_of(n), "sat")
    rows = [[s.norad, s.name, r(s.satrec.no_kozai, 9), r(s.ecc, 7), r(s.satrec.inclo), r(s.satrec.nodeo),
             r(s.satrec.argpo), r(s.satrec.mo), r(s.epoch_jd, 6), kind(s.name)] for s in sats]
    return {"total": len(cat), "fields": ["norad", "name", "n_rad_min", "ecc", "inc", "raan", "argp",
                                          "M", "epoch_jd", "kind"], "sats": rows}


@app.route("/api/optimize")
@api
def api_optimize():
    cat = get_catalog()
    mission = request.args.get("mission", "earth-observation")
    if mission not in oo.MISSIONS:
        raise ApiError(f"Unknown mission type '{mission}'.", "BAD_INPUT", 400,
                       "Choose one of: " + ", ".join(oo.MISSIONS))
    site = request.args.get("site", "sriharikota")
    if site not in oo.LAUNCH_SITES:
        raise ApiError(f"Unknown launch site '{site}'.", "BAD_INPUT", 400)
    site_lat = arg("lat", float, oo.LAUNCH_SITES[site], -90, 90, "latitude")
    years = arg("years", float, 5, 0.5, 30, "mission life")
    # optional: place the satellite in your own orbit
    alt = arg("alt", float, None, 160, 40000, "altitude (km)")
    inc = arg("inc", float, None, 0, 180, "inclination (degrees)")
    details = {}
    best, (centers, dens) = oo.optimize(cat, mission=mission, site_lat=site_lat, mission_years=years,
                                        custom_alt=alt, custom_inc=inc, details=details)
    out = {"best": best, "site_lat": site_lat, "mission": mission,
           "density": {"alt": list(centers), "per_1e9_km3": list(dens * 1e9)}}
    if alt is not None or inc is not None:
        out["custom"] = {"alt_km": alt, "inc_deg": inc, "rank": details.get("user_rank"),
                         "of": details.get("candidates"), "overall_best": details.get("overall_best")}
        if mission == "earth-observation" and alt is not None and oo.sun_sync_inclination(alt) is None:
            out["custom"]["note"] = "Sun-synchronous orbits are impossible above ~5,970 km, so this can't be a typical imaging orbit."
    if mission == "communications":
        out["geo"] = oo.geo_option(site_lat)
    return out


# ---------------------------------------------------------------- space weather (NASA DONKI)

@app.route("/api/spaceweather")
@api
def api_spaceweather():
    return space_weather()


def space_weather():
    hit = _cache.get("sw")
    ttl = 300 if hit and hit[1].get("errors") else 1800     # retry sooner when a NASA feed failed
    return cached("sw", ttl, spaceweather.summary)


@app.route("/api/drag")
@api
def api_drag():
    kp = request.args.get("kp")
    if kp in (None, "", "now"):
        kp = space_weather()["kp_24h_max"]
    else:
        kp = arg("kp", float, 5, 0, 9, "Kp index")
    debris = request.args.get("debris") == "1"
    out = spaceweather.drag_alerts(get_catalog(), kp, include_debris=debris)
    return out


# ---------------------------------------------------------------- satellite search + profile

@app.route("/api/search")
@api
def api_search():
    q = request.args.get("q", "")
    if len(q.strip()) < 2 and not q.strip().isdigit():
        raise ApiError("Type at least 2 characters to search.", "QUERY_TOO_SHORT", 400)
    if len(q) > 60:
        raise ApiError("Search text is too long.", "BAD_INPUT", 400)
    return {"q": q, "results": satinfo.search(get_catalog(), q)}


@app.route("/api/satellite/<int:norad>")
@api
def api_satellite(norad):
    return satinfo.profile(find_sat(norad))


@app.route("/api/geocode")
@api
def api_geocode():
    q = request.args.get("q", "").strip()
    if len(q) < 2:
        raise ApiError("Type a place name or 'lat, lon'.", "QUERY_TOO_SHORT", 400)
    res = satinfo.geocode(q[:120])
    if not res:
        raise ApiError(f"No place called '{q}' was found.", "PLACE_NOT_FOUND", 404,
                       "Try a city, landmark or coordinates like '27.98, 86.92'.")
    return {"q": q, "results": res}


@app.route("/api/health")
@api
def api_health():
    c = _catalogs.get("current")
    return {"ok": True, "catalog_loaded": bool(c and c["sats"]), "objects": len(c["sats"]) if c else 0}


if __name__ == "__main__":
    print("OrbitGuard running at http://127.0.0.1:5000")
    app.run(debug=False, threaded=True)
