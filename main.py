"""Orbital Watch - asteroid alerts, satellite disturbance detection and launch-orbit finder.

Examples:
    python main.py                      # interactive menu
    python main.py --all
    python main.py --asteroids
    python main.py --disturbances
    python main.py --conjunctions --norad 25544 --hours 24
    python main.py --optimize --mission communications --site kennedy
"""
import argparse
import sys

from config import OUTPUT_DIR


def run_asteroids():
    import asteroids
    print("\n[1] Fetching near-Earth asteroids from NASA NeoWs ...")
    neos = asteroids.fetch_neo_feed()
    asteroids.print_report(neos, "NASA NeoWs: closest/riskiest asteroids in next 7 days")
    close = [n for n in neos if n["miss_ld"] < 1]
    haz = [n for n in neos if n["hazardous"]]
    print(f"\n  -> {len(close)} pass inside the Moon's orbit, {len(haz)} are 'potentially hazardous'.")
    path = OUTPUT_DIR / "asteroid_miss_distances.png"
    asteroids.plot_miss_distances(neos, path)
    print(f"  Plot saved: {path}")

    print("\n    Fetching JPL close-approach list (next 60 days, < 0.05 AU) ...")
    cad = asteroids.fetch_jpl_close_approaches()
    asteroids.print_report(cad, "JPL SBDB close approaches (sorted by distance)", limit=10)


def load_catalog():
    import satellites
    print("\n  Loading satellite + debris catalog from CelesTrak (cached for 2 h) ...")
    cat = satellites.fetch_catalog()
    print(f"  Total unique tracked objects: {len(cat)}")
    return cat


def run_disturbances(cat):
    import satellites
    print("\n[2] Checking for orbit disturbances (maneuvers, decay, plane changes) ...")
    res = satellites.detect_disturbances(cat)
    if not res["baseline_existed"]:
        print("  First run: baseline snapshot saved. Run again later (a few hours / next day) "
              "to detect changes between snapshots.")
    else:
        print(f"  Compared {res['compared']} objects that have newer orbit data than the baseline.")
    by_type = {}
    for e in res["events"]:
        by_type.setdefault(e["type"], []).append(e)
    if not by_type:
        print("  No disturbances detected.")
    for t, evs in by_type.items():
        print(f"\n  {t}: {len(evs)} objects")
        for e in evs[:10]:
            print(f"    {e['norad']:>6}  {e['name'][:30]:<30} {e['detail']}")
        if len(evs) > 10:
            print(f"    ... and {len(evs) - 10} more")


def run_conjunctions(cat, norad: int, hours: float, threshold: float):
    import satellites
    target = satellites.find_by_norad(cat, norad)
    if not target:
        print(f"  NORAD {norad} not found in catalog.")
        return
    print(f"\n[3] Conjunction screening for {target.name} (NORAD {norad}), next {hours:g} h, "
          f"threshold {threshold:g} km")
    print(f"    Orbit: {target.perigee_km:.0f} x {target.apogee_km:.0f} km, inc {target.inc_deg:.2f} deg, "
          f"TLE epoch {target.epoch:%Y-%m-%d %H:%M} UTC")
    events = satellites.find_conjunctions(target, cat, hours=hours, threshold_km=threshold)
    if not events:
        print("    No close approaches found.")
    for e in events[:15]:
        print(f"    {e['time']:%Y-%m-%d %H:%M:%S} UTC  {e['name'][:28]:<28} (#{e['norad']:>6})  "
              f"miss {e['miss_km']:6.2f} km  rel.speed {e['rel_speed_kms']:5.2f} km/s")
    print("    Note: TLE accuracy is ~1 km+, so these are screening results, not collision predictions.")


def run_optimizer(cat, mission: str, site: str, lat: float | None, years: float):
    import orbit_optimizer as oo
    site_lat = lat if lat is not None else oo.LAUNCH_SITES[site]
    print(f"\n[4] Optimal orbit search: mission={mission}, launch latitude={site_lat:.2f} deg"
          f" ({site if lat is None else 'custom'}), mission life={years:g} yr")
    best, (centers, dens) = oo.optimize(cat, mission=mission, site_lat=site_lat, mission_years=years)
    print(f"  {'#':<3}{'Alt(km)':>8}{'Inc(deg)':>10}{'Period(min)':>12}{'Obj/shell':>11}"
          f"{'dv(km/s)':>10}{'Life(yr)':>10}{'Score':>8}")
    for i, r in enumerate(best, 1):
        print(f"  {i:<3}{r['alt_km']:>8}{r['inc_deg']:>10.2f}{r['period_min']:>12.1f}"
              f"{r['objects_in_shell']:>11.0f}{r['dv_kms']:>10.2f}{r['lifetime_yr']:>10.1f}{r['score']:>8.1f}")
    if best:
        b = best[0]
        print(f"\n  Recommended: {b['alt_km']} km circular orbit at {b['inc_deg']:.2f} deg inclination"
              + (" (sun-synchronous)" if mission == "earth-observation" else ""))
    if mission == "communications":
        g = oo.geo_option(site_lat)
        print(f"  Alternative GEO: {g['alt_km']} km, 0 deg, period {g['period_min']:.0f} min, "
              f"approx dv {g['dv_kms']:.2f} km/s (much more expensive, 3 sats cover the globe)")
    path = OUTPUT_DIR / "altitude_density.png"
    oo.plot_density(centers, dens, best, path)
    print(f"  Plot saved: {path}")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--all", action="store_true")
    p.add_argument("--asteroids", action="store_true")
    p.add_argument("--disturbances", action="store_true")
    p.add_argument("--conjunctions", action="store_true")
    p.add_argument("--optimize", action="store_true")
    p.add_argument("--norad", type=int, default=25544, help="target satellite (default ISS)")
    p.add_argument("--hours", type=float, default=24)
    p.add_argument("--threshold", type=float, default=25, help="conjunction report distance, km")
    p.add_argument("--mission", choices=["earth-observation", "communications", "science"],
                   default="earth-observation")
    p.add_argument("--site", default="sriharikota", help="sriharikota, kennedy, baikonur, kourou, vandenberg, jiuquan")
    p.add_argument("--lat", type=float, help="custom launch-site latitude (overrides --site)")
    p.add_argument("--years", type=float, default=5, help="mission lifetime in years")
    a = p.parse_args()

    if not any([a.all, a.asteroids, a.disturbances, a.conjunctions, a.optimize]):
        print("Orbital Watch\n 1) Asteroid report\n 2) Satellite disturbances\n 3) Conjunction check (ISS)\n"
              " 4) Optimal orbit for new satellite\n 5) All")
        choice = input("Choose 1-5: ").strip()
        a.asteroids, a.disturbances, a.conjunctions, a.optimize, a.all = (
            choice == "1", choice == "2", choice == "3", choice == "4", choice == "5")

    if a.all or a.asteroids:
        try:
            run_asteroids()
        except Exception as exc:
            print(f"  Asteroid step failed: {exc}")

    if a.all or a.disturbances or a.conjunctions or a.optimize:
        cat = load_catalog()
        if not cat:
            sys.exit("No catalog data available.")
        if a.all or a.disturbances:
            run_disturbances(cat)
        if a.all or a.conjunctions:
            run_conjunctions(cat, a.norad, a.hours, a.threshold)
        if a.all or a.optimize:
            run_optimizer(cat, a.mission, a.site, a.lat, a.years)


if __name__ == "__main__":
    main()
