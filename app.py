"""Orbital Watch web app.  Run:  python app.py   then open http://127.0.0.1:5000"""
import math
import os
import threading
import time
from datetime import date, datetime

import numpy as np
from flask import Flask, jsonify, render_template, request

import asteroids
import orbit_optimizer as oo
import satellites

app = Flask(__name__)

ON_VERCEL = bool(os.getenv("VERCEL"))
_catalogs = {}   # which -> {"sats": [...], "loaded": t}
_lock = threading.Lock()


def get_catalog(which: str = "current"):
    with _lock:
        c = _catalogs.get(which)
        if c is None or not c["sats"] or time.time() - c["loaded"] > satellites.CACHE_HOURS * 3600:
            c = _catalogs[which] = {"sats": satellites.fetch_catalog(which=which), "loaded": time.time()}
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
            return jsonify({"error": str(exc)}), 500
    wrapper.__name__ = fn.__name__
    return wrapper


@app.route("/")
def index():
    return render_template("index.html", sites=oo.LAUNCH_SITES, missions=list(oo.MISSIONS))


_ast_cache = {}   # key -> (time, data); NASA's DEMO_KEY allows only ~30 requests/hour


def cached(key, ttl, fn):
    hit = _ast_cache.get(key)
    if hit and time.time() - hit[0] < ttl:
        return hit[1]
    try:
        data = fn()
    except Exception:
        if hit:                      # serve stale data rather than nothing
            return hit[1]
        raise
    _ast_cache[key] = (time.time(), data)
    return data


@app.route("/api/asteroids")
@api
def api_asteroids():
    out = {"neows": [], "jpl": []}
    try:
        out["neows"] = cached("neows", 3600, asteroids.fetch_neo_feed)
    except Exception as exc:
        out["neows_error"] = ("NASA DEMO_KEY rate limit reached; try again later or set NASA_API_KEY"
                              if "429" in str(exc) else str(exc))
    days = int(request.args.get("days", 60))
    try:
        out["jpl"] = cached(f"jpl{days}", 3600, lambda: asteroids.fetch_jpl_close_approaches(days=days))
    except Exception as exc:
        out["jpl_error"] = str(exc)
    return out


@app.route("/api/catalog")
@api
def api_catalog():
    sats = get_catalog()
    return {"count": len(sats), "loaded": datetime.fromtimestamp(_catalogs["current"]["loaded"])}


@app.route("/api/disturbances")
@api
def api_disturbances():
    if ON_VERCEL:
        # serverless: no persistent disk, so compare with the older copy kept by the GitHub Action
        return satellites.detect_disturbances(get_catalog(), previous_sats=get_catalog("previous"))
    return satellites.detect_disturbances(get_catalog())


@app.route("/api/conjunctions")
@api
def api_conjunctions():
    cat = get_catalog()
    norad = int(request.args.get("norad", 25544))
    hours = min(float(request.args.get("hours", 24)), 72)
    threshold = float(request.args.get("threshold", 25))
    target = satellites.find_by_norad(cat, norad)
    if not target:
        return {"error": f"NORAD {norad} not found in catalog"}
    events = satellites.find_conjunctions(target, cat, hours=hours, threshold_km=threshold)
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
        limit = max(100, min(int(request.args.get("limit", 4000)), 20000))
        sats = cat[::max(1, len(cat) // limit)]
        have = {s.norad for s in sats}
        sats += [s for s in cat if s.norad in (25544, 48274, 20580) and s.norad not in have]

    def kind(name):
        return "deb" if " DEB" in name else "rb" if "R/B" in name else "sat"

    r = lambda x, d=6: round(float(x), d)
    rows = [[s.norad, s.name, r(s.satrec.no_kozai, 9), r(s.ecc, 7), r(s.satrec.inclo), r(s.satrec.nodeo),
             r(s.satrec.argpo), r(s.satrec.mo), r(s.epoch_jd, 6), kind(s.name)] for s in sats]
    return {"total": len(cat), "fields": ["norad", "name", "n_rad_min", "ecc", "inc", "raan", "argp",
                                          "M", "epoch_jd", "kind"], "sats": rows}


@app.route("/api/optimize")
@api
def api_optimize():
    cat = get_catalog()
    mission = request.args.get("mission", "earth-observation")
    lat_arg = request.args.get("lat")
    site = request.args.get("site", "sriharikota")
    site_lat = float(lat_arg) if lat_arg else oo.LAUNCH_SITES[site]
    years = float(request.args.get("years", 5))
    best, (centers, dens) = oo.optimize(cat, mission=mission, site_lat=site_lat, mission_years=years)
    out = {"best": best, "site_lat": site_lat, "mission": mission,
           "density": {"alt": list(centers), "per_1e9_km3": list(dens * 1e9)}}
    if mission == "communications":
        out["geo"] = oo.geo_option(site_lat)
    return out


if __name__ == "__main__":
    print("Orbital Watch running at http://127.0.0.1:5000")
    app.run(debug=False, threaded=True)
