"""Orbital Watch web app.  Run:  python app.py   then open http://127.0.0.1:5000"""
import math
import threading
import time
from datetime import date, datetime

import numpy as np
from flask import Flask, jsonify, render_template, request

import asteroids
import orbit_optimizer as oo
import satellites

app = Flask(__name__)

_catalog = {"sats": None, "loaded": 0.0}
_lock = threading.Lock()


def get_catalog():
    with _lock:
        if _catalog["sats"] is None or time.time() - _catalog["loaded"] > satellites.CACHE_HOURS * 3600:
            _catalog["sats"] = satellites.fetch_catalog()
            _catalog["loaded"] = time.time()
        return _catalog["sats"]


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


@app.route("/api/asteroids")
@api
def api_asteroids():
    neos = asteroids.fetch_neo_feed()
    cad = asteroids.fetch_jpl_close_approaches(days=int(request.args.get("days", 60)))
    return {"neows": neos, "jpl": cad}


@app.route("/api/catalog")
@api
def api_catalog():
    sats = get_catalog()
    return {"count": len(sats), "loaded": datetime.fromtimestamp(_catalog["loaded"])}


@app.route("/api/disturbances")
@api
def api_disturbances():
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
