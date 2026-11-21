"""Find a good orbit for a new satellite using the real catalog's crowding + basic astrodynamics.

Heuristic trade study (educational), scoring each (altitude, inclination) candidate on:
  * collision risk      - spatial density of tracked objects in that altitude shell
  * launch cost         - delta-v from the launch site (Earth-rotation bonus + Hohmann transfer)
  * orbital lifetime    - too low = re-enters before mission ends; too high = needs deorbit fuel
  * mission fit         - sun-synchronous for imaging, coverage for comms, etc.
"""
import math

import numpy as np

from config import EARTH_RADIUS_KM, J2, MU_EARTH

LAUNCH_SITES = {
    "sriharikota": 13.72,
    "kennedy": 28.57,
    "baikonur": 45.96,
    "kourou": 5.24,
    "vandenberg": 34.63,
    "jiuquan": 40.96,
}

MISSIONS = {
    # preferred altitude band (km), weights for (density, delta-v, lifetime, mission fit)
    "earth-observation": {"band": (450, 800), "w": (0.35, 0.15, 0.2, 0.3)},
    "communications":    {"band": (500, 1300), "w": (0.35, 0.2, 0.2, 0.25)},
    "science":           {"band": (400, 1500), "w": (0.4, 0.3, 0.2, 0.1)},
}

EARTH_ROT_KMS = 0.4651   # equatorial surface speed
SUN_RATE = 2 * math.pi / (365.2422 * 86400)  # required RAAN drift for sun-synchronous orbit (rad/s)


def circular_speed(alt_km: float) -> float:
    return math.sqrt(MU_EARTH / (EARTH_RADIUS_KM + alt_km))


def period_min(alt_km: float) -> float:
    a = EARTH_RADIUS_KM + alt_km
    return 2 * math.pi * math.sqrt(a ** 3 / MU_EARTH) / 60


def sun_sync_inclination(alt_km: float) -> float | None:
    a = EARTH_RADIUS_KM + alt_km
    n = math.sqrt(MU_EARTH / a ** 3)
    cos_i = -SUN_RATE / (1.5 * n * J2 * (EARTH_RADIUS_KM / a) ** 2)
    return math.degrees(math.acos(cos_i)) if -1 <= cos_i <= 1 else None


def hohmann_dv(alt1: float, alt2: float) -> float:
    r1, r2 = EARTH_RADIUS_KM + alt1, EARTH_RADIUS_KM + alt2
    if r1 == r2:
        return 0.0
    at = (r1 + r2) / 2
    v1 = math.sqrt(MU_EARTH / r1); v2 = math.sqrt(MU_EARTH / r2)
    vp = math.sqrt(MU_EARTH * (2 / r1 - 1 / at)); va = math.sqrt(MU_EARTH * (2 / r2 - 1 / at))
    return abs(vp - v1) + abs(v2 - va)


def launch_dv(alt_km: float, inc_deg: float, site_lat: float) -> float:
    """Approximate total delta-v (km/s) to reach a circular orbit from the launch site.

    ~9.3 km/s to a 200 km orbit with no rotation help (incl. gravity & drag losses),
    minus Earth-rotation help for the launch azimuth, plus a Hohmann raise to the final altitude.
    If the inclination is below the site latitude, a costly plane change is added.
    """
    lat = math.radians(site_lat)
    extra = 0.0
    if inc_deg < site_lat:
        extra = 2 * circular_speed(200) * math.sin(math.radians(site_lat - inc_deg) / 2)
        inc_deg = site_lat
    sin_az = max(-1.0, min(1.0, math.cos(math.radians(inc_deg)) / math.cos(lat)))
    rotation_bonus = EARTH_ROT_KMS * math.cos(lat) * sin_az     # negative for retrograde orbits
    return 9.3 - rotation_bonus + hohmann_dv(200, alt_km) + extra


def lifetime_years(alt_km: float) -> float:
    """Very rough natural-decay lifetime for a typical small satellite at moderate solar activity."""
    table = [(200, 0.003), (300, 0.1), (400, 1.0), (500, 5.0), (600, 25.0), (700, 100.0),
             (800, 200.0), (1000, 2000.0), (1500, 1e4)]
    xs, ys = zip(*table)
    return float(10 ** np.interp(alt_km, xs, np.log10(ys)))


def density_profile(catalog, bin_km: int = 25, max_alt: int = 2000):
    """Objects per km^3 in each altitude shell, each object spread over its perigee-apogee range."""
    edges = np.arange(150, max_alt + bin_km, bin_km)
    counts = np.zeros(len(edges) - 1)
    inc_hist = np.zeros((len(edges) - 1, 18))     # 10-degree inclination bins
    for s in catalog:
        lo, hi = s.perigee_km, s.apogee_km
        if hi < edges[0] or lo > edges[-1]:
            continue
        i0 = max(0, np.searchsorted(edges, lo) - 1)
        i1 = min(len(counts) - 1, np.searchsorted(edges, hi) - 1)
        w = 1.0 / (i1 - i0 + 1)
        counts[i0:i1 + 1] += w
        inc_hist[i0:i1 + 1, min(17, int(s.inc_deg // 10))] += w
    r_in = EARTH_RADIUS_KM + edges[:-1]
    r_out = EARTH_RADIUS_KM + edges[1:]
    volume = 4 / 3 * math.pi * (r_out ** 3 - r_in ** 3)
    return edges, counts / volume, counts, inc_hist


def _norm(x: np.ndarray) -> np.ndarray:
    span = x.max() - x.min()
    return np.zeros_like(x) if span == 0 else (x - x.min()) / span


def optimize(catalog, mission: str = "earth-observation", site_lat: float = 13.72,
             alt_range=(300, 1500), inc_range=(0, 100), mission_years: float = 5, top: int = 5):
    cfg = MISSIONS[mission]
    edges, dens, counts, inc_hist = density_profile(catalog)
    centers = (edges[:-1] + edges[1:]) / 2

    rows = []
    for alt in range(int(alt_range[0]), int(alt_range[1]) + 1, 25):
        if mission == "earth-observation":
            sso = sun_sync_inclination(alt)
            incs = [round(sso, 2)] if sso else []
        else:
            incs = list(range(max(int(inc_range[0]), 0), int(inc_range[1]) + 1, 5))
        k = min(len(dens) - 1, max(0, np.searchsorted(edges, alt) - 1))
        for inc in incs:
            if not (inc_range[0] <= inc <= inc_range[1]):
                continue
            life = lifetime_years(alt)
            # same-inclination crowding (objects that share your orbital plane family)
            same_inc = inc_hist[k, min(17, int(inc // 10))] / max(counts[k], 1)
            band = cfg["band"]
            if mission == "earth-observation":
                fit = 1.0 if band[0] <= alt <= band[1] else 0.3
                fit *= 1 - (alt - band[0]) / 2000           # lower = sharper images
            elif mission == "communications":
                footprint = math.degrees(math.acos(EARTH_RADIUS_KM / (EARTH_RADIUS_KM + alt)))
                fit = footprint / 40 + (0.3 if inc >= 50 else 0)  # wider footprint, global coverage
            else:
                fit = 1.0 if band[0] <= alt <= band[1] else 0.5
            rows.append({
                "alt_km": alt, "inc_deg": inc, "period_min": period_min(alt),
                "density": dens[k] * (0.7 + 0.6 * same_inc), "objects_in_shell": counts[k],
                "dv_kms": launch_dv(alt, inc, site_lat), "lifetime_yr": life, "fit": fit,
            })
    if not rows:
        return [], (centers, dens)

    dens_arr = np.array([r["density"] for r in rows])
    dv_arr = np.array([r["dv_kms"] for r in rows])
    fit_arr = np.array([r["fit"] for r in rows])
    life_arr = np.array([r["lifetime_yr"] for r in rows])
    # lifetime penalty: re-entering before mission end is fatal; > mission + 5 yr (FCC 5-year rule)
    # means a deorbit system is needed
    life_pen = np.where(life_arr < mission_years, 1.0,
                        np.where(life_arr > mission_years + 5,
                                 np.clip(np.log10(life_arr / (mission_years + 5)) / 3, 0, 0.6), 0.0))
    wd, wv, wl, wf = cfg["w"]
    cost = wd * _norm(np.log10(dens_arr + 1e-12)) + wv * _norm(dv_arr) + wl * life_pen + wf * (1 - _norm(fit_arr))
    safety = 100 * (1 - _norm(np.log10(dens_arr + 1e-12)))
    cost_s = 100 * (1 - _norm(dv_arr))
    life_s = 100 * (1 - life_pen)
    cover_s = 100 * _norm(fit_arr)
    for k, (r, c) in enumerate(zip(rows, cost)):
        r["score"] = round(float(100 * (1 - c)), 1)
        r["scores"] = {"safety": float(safety[k]), "lifetime": float(life_s[k]),
                       "coverage": float(cover_s[k]), "launch_cost": float(cost_s[k])}
        r["coverage_lat_deg"] = r["inc_deg"] if r["inc_deg"] <= 90 else 180 - r["inc_deg"]
        r["footprint_km"] = EARTH_RADIUS_KM * math.acos(EARTH_RADIUS_KM / (EARTH_RADIUS_KM + r["alt_km"]))
        r["why"] = _explain(r, mission, mission_years)
    rows.sort(key=lambda r: r["score"], reverse=True)

    # keep diverse results: skip near-duplicates of an already chosen orbit
    chosen = []
    for r in rows:
        if all(abs(r["alt_km"] - c["alt_km"]) >= 50 or abs(r["inc_deg"] - c["inc_deg"]) >= 10 for c in chosen):
            chosen.append(r)
        if len(chosen) == top:
            break
    return chosen, (centers, dens)


def _explain(r: dict, mission: str, mission_years: float) -> list[str]:
    """Plain-language reasons behind a candidate's score."""
    s, why = r["scores"], []
    why.append("Quiet shell: few tracked objects nearby" if s["safety"] >= 66 else
               "Moderately busy shell" if s["safety"] >= 33 else "Crowded shell: higher collision risk")
    life = r["lifetime_yr"]
    if life < mission_years:
        why.append(f"Decays in ~{life:.1f} yr, before the {mission_years:g}-year mission ends")
    elif life <= mission_years + 5:
        why.append(f"Re-enters naturally in ~{life:.0f} yr: meets the 5-year deorbit rule, no debris left behind")
    else:
        why.append(f"Stays up ~{life:.0f} yr: needs a deorbit system to avoid becoming debris")
    lat = r["coverage_lat_deg"]
    if mission == "earth-observation":
        why.append(f"Sun-synchronous: same lighting every pass, covers up to {lat:.0f}° latitude")
    else:
        why.append(f"Covers latitudes up to ±{lat:.0f}°, footprint radius ~{r['footprint_km']:.0f} km")
    why.append("Cheap to reach from this launch site" if s["launch_cost"] >= 60 else "Needs extra launch energy")
    return why


def geo_option(site_lat: float) -> dict:
    """Geostationary option for communications (35,786 km, 0 deg)."""
    alt = 35786
    plane_change = 2 * 1.597 * math.sin(math.radians(site_lat) / 2)   # done at GTO apogee (~1.6 km/s)
    dv = 9.3 - EARTH_ROT_KMS * math.cos(math.radians(site_lat)) + hohmann_dv(200, alt) + plane_change * 0.6
    return {"alt_km": alt, "inc_deg": 0.0, "period_min": period_min(alt), "dv_kms": dv}


def plot_density(centers, dens, best, path) -> None:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    fig, ax = plt.subplots(figsize=(10, 5))
    ax.semilogy(centers, dens * 1e9, lw=2)
    ax.set_xlabel("Altitude (km)"); ax.set_ylabel("Tracked objects per 10^9 km^3")
    ax.set_title("Orbital crowding from CelesTrak catalog (active satellites + major debris clouds)")
    for i, r in enumerate(best):
        ax.axvline(r["alt_km"], color="green" if i == 0 else "orange", ls="--", alpha=0.8,
                   label=f"#{i + 1}: {r['alt_km']} km / {r['inc_deg']}°")
    ax.legend(); ax.grid(alpha=0.3); fig.tight_layout(); fig.savefig(path, dpi=120); plt.close(fig)
