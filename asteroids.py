# OrbitGuard | ASTRA 2026 | Team AstroNex
"""Near-Earth asteroid detection using NASA NeoWs and the JPL Close-Approach API."""
from datetime import date, timedelta

import requests

from config import AU_KM, HTTP_TIMEOUT, LUNAR_DISTANCE_KM, NASA_API_KEY, USER_AGENT

NEOWS_FEED_URL = "https://api.nasa.gov/neo/rest/v1/feed"
JPL_CAD_URL = "https://ssd-api.jpl.nasa.gov/cad.api"


def fetch_neo_feed(start: date | None = None, end: date | None = None) -> list[dict]:
    """Return asteroids passing Earth between start and end (NeoWs allows max 7 days)."""
    start = start or date.today()
    end = end or start + timedelta(days=7)
    if (end - start).days > 7:
        raise ValueError("NeoWs feed allows at most a 7-day window")

    resp = requests.get(
        NEOWS_FEED_URL,
        params={"start_date": start.isoformat(), "end_date": end.isoformat(), "api_key": NASA_API_KEY},
        headers={"User-Agent": USER_AGENT},
        timeout=HTTP_TIMEOUT,
    )
    resp.raise_for_status()
    data = resp.json()

    neos = []
    for day, objects in data["near_earth_objects"].items():
        for obj in objects:
            ca = obj["close_approach_data"][0]
            diam = obj["estimated_diameter"]["meters"]
            neos.append({
                "name": obj["name"],
                "id": obj["id"],
                "date": ca["close_approach_date_full"] or day,
                "diameter_m": (diam["estimated_diameter_min"] + diam["estimated_diameter_max"]) / 2,
                "miss_km": float(ca["miss_distance"]["kilometers"]),
                "miss_ld": float(ca["miss_distance"]["lunar"]),
                "velocity_kms": float(ca["relative_velocity"]["kilometers_per_second"]),
                "hazardous": obj["is_potentially_hazardous_asteroid"],
            })
    # NeoWs sometimes lists the same object twice (numbered + provisional id); dedupe by approach
    unique = {}
    for n in neos:
        n["risk"] = risk_score(n["diameter_m"], n["miss_km"], n["velocity_kms"])
        unique.setdefault((n["date"], round(n["miss_km"], -2)), n)
    return sorted(unique.values(), key=lambda n: n["risk"], reverse=True)


def fetch_jpl_close_approaches(days: int = 60, dist_max_au: str = "0.05") -> list[dict]:
    """Upcoming close approaches from JPL SBDB CAD API (no key needed)."""
    resp = requests.get(
        JPL_CAD_URL,
        params={"date-min": "now", "date-max": f"+{days}", "dist-max": dist_max_au,
                "sort": "dist", "diameter": "true"},
        headers={"User-Agent": USER_AGENT},
        timeout=HTTP_TIMEOUT,
    )
    resp.raise_for_status()
    data = resp.json()
    fields = data.get("fields", [])
    out = []
    for row in data.get("data", []):
        rec = dict(zip(fields, row))
        dist_km = float(rec["dist"]) * AU_KM
        h = float(rec["h"]) if rec.get("h") else None
        # Estimate diameter from absolute magnitude H assuming albedo 0.14 when not given
        if rec.get("diameter"):
            diameter_m = float(rec["diameter"]) * 1000
        elif h is not None:
            diameter_m = 1329 / (0.14 ** 0.5) * 10 ** (-h / 5) * 1000
        else:
            diameter_m = 0.0
        out.append({
            "name": rec["des"],
            "date": rec["cd"],
            "miss_km": dist_km,
            "miss_ld": dist_km / LUNAR_DISTANCE_KM,
            "velocity_kms": float(rec["v_rel"]),
            "diameter_m": diameter_m,
            "risk": risk_score(diameter_m, dist_km, float(rec["v_rel"])),
        })
    return out


def risk_score(diameter_m: float, miss_km: float, velocity_kms: float) -> float:
    """Simple relative ranking: bigger, faster, closer = higher. Not an official Torino/Palermo scale."""
    if miss_km <= 0:
        return float("inf")
    energy = diameter_m ** 3 * velocity_kms ** 2          # ~ kinetic energy (mass ~ d^3)
    return energy / (miss_km / LUNAR_DISTANCE_KM) ** 2 / 1e6


def print_report(neos: list[dict], title: str, limit: int = 15) -> None:
    print(f"\n=== {title} ({len(neos)} objects) ===")
    print(f"{'Name':<28}{'Date':<20}{'Diam(m)':>9}{'Miss(LD)':>10}{'Miss(km)':>14}{'v(km/s)':>9}{'Risk':>10}  Flags")
    for n in neos[:limit]:
        flags = []
        if n.get("hazardous"):
            flags.append("PHA")
        if n["miss_ld"] < 1:
            flags.append("INSIDE-MOON-ORBIT")
        print(f"{n['name'][:27]:<28}{n['date'][:19]:<20}{n['diameter_m']:>9.0f}{n['miss_ld']:>10.2f}"
              f"{n['miss_km']:>14,.0f}{n['velocity_kms']:>9.2f}{n['risk']:>10.2f}  {' '.join(flags)}")


def plot_miss_distances(neos: list[dict], path) -> None:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    fig, ax = plt.subplots(figsize=(9, 5))
    haz = [n for n in neos if n.get("hazardous")]
    safe = [n for n in neos if not n.get("hazardous")]
    ax.scatter([n["miss_ld"] for n in safe], [n["diameter_m"] for n in safe], label="Not hazardous", alpha=0.7)
    ax.scatter([n["miss_ld"] for n in haz], [n["diameter_m"] for n in haz], color="red", label="Potentially hazardous")
    ax.axvline(1, linestyle="--", color="gray", label="Moon distance")
    ax.set_xscale("log"); ax.set_yscale("log")
    ax.set_xlabel("Miss distance (lunar distances)"); ax.set_ylabel("Estimated diameter (m)")
    ax.set_title("Near-Earth asteroids this week (NASA NeoWs)")
    ax.legend(); fig.tight_layout(); fig.savefig(path, dpi=120); plt.close(fig)
