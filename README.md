# Orbital Watch

Asteroid alerts, satellite orbit-disturbance detection, conjunction screening and a launch-orbit finder,
built on free data sources.

| Data | Source | Key? |
|---|---|---|
| Near-Earth asteroids (7-day feed) | NASA NeoWs `api.nasa.gov/neo/rest/v1/feed` | `DEMO_KEY` works; free key at https://api.nasa.gov |
| Close approaches (60 days) | NASA/JPL SBDB `ssd-api.jpl.nasa.gov/cad.api` | none |
| Satellite + debris orbits (TLEs) | CelesTrak `celestrak.org/NORAD/elements/gp.php` | none |
| Orbit propagation | `sgp4` library (offline) | - |

## Run
```powershell
python -m venv .venv
.\.venv\Scripts\activate
pip install -r requirements-cli.txt   # web-only: requirements.txt
$env:NASA_API_KEY = "your-key"      # optional
python main.py                      # menu
python main.py --all
python main.py --conjunctions --norad 25544 --hours 48 --threshold 10
python main.py --optimize --mission communications --site kennedy --years 7
```
**Website:** `pip install flask`, then `python app.py` and open http://127.0.0.1:5000

Plots go to `output/`. TLE downloads are cached in `data/` for 2 hours (CelesTrak asks for this).

## How it works
- **Asteroids**: ranks NEOs by a simple size^3 * speed^2 / distance^2 score and flags potentially hazardous
  asteroids (PHAs) and anything passing inside the Moon's orbit.
- **Disturbances**: every run saves a snapshot of each object's orbit. The next run compares newer TLEs with it and flags
  `MANEUVER-UP/DOWN` (semi-major axis jump), `PLANE-CHANGE`, `DECAYING` (fast perigee drop) and `REENTRY-RISK` (perigee < 200 km).
  So run it at least twice, a few hours or a day apart.
- **Conjunctions**: propagates the target and every object in an overlapping altitude band with SGP4
  (30 s coarse steps, then 1 s refinement) and lists close approaches.
- **Orbit optimizer**: grid search over altitude and inclination. Each candidate is scored on catalog crowding in its altitude shell,
  launch delta-v from the site's latitude, natural-decay lifetime (compared with the mission life and the 5-year deorbit rule) and mission fit
  (sun-synchronous orbits for Earth observation, coverage for communications).

## Limitations
These results are for education and prototyping, not operational use. TLE/SGP4 errors are about 1 km or more and grow over days,
and the free catalog doesn't include classified objects or most small debris. The optimizer is a heuristic trade study, not mission design.
