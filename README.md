# OrbitGuard (Orbital Watch)

*Know what's at risk in orbit today, and where it's safe to launch tomorrow.* Team AstroNex · ASTRA 2026.

A mission-control web dashboard: live 3D satellite globe (coloured by altitude), close-approach alerts,
NASA space-weather drag warnings, a best-orbit recommender, a satellite finder (photo, mission, orbit)
and a 3D Earth view that can ride along under any satellite. Built on free public data.

| Data | Source | Key? |
|---|---|---|
| Near-Earth asteroids (7-day feed) | NASA NeoWs `api.nasa.gov/neo/rest/v1/feed` | `DEMO_KEY` works; free key at https://api.nasa.gov |
| Close approaches (60 days) | NASA/JPL SBDB `ssd-api.jpl.nasa.gov/cad.api` | none |
| Satellite + debris orbits (TLEs) | CelesTrak `celestrak.org/NORAD/elements/gp.php` | none |
| Geomagnetic storms, flares, CMEs | NASA DONKI `api.nasa.gov/DONKI/{GST,FLR,CME}` | same NASA key |
| Live planetary Kp | NOAA SWPC `services.swpc.noaa.gov` | none |
| Satellite owner / launch facts | CelesTrak SATCAT | none |
| Satellite photo + summary | Wikipedia REST API | none |
| Place search | OpenStreetMap Nominatim (Photon fallback) | none |
| 3D Earth view | Esri World Imagery, NASA GIBS (VIIRS), AWS Terrain Tiles, MapLibre GL | none |
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

- **Space-weather drag alerts**: reads geomagnetic storms (Kp) from NASA DONKI plus NOAA's live Kp. A storm heats the upper
  atmosphere, so density is scaled by a Kp-dependent multiplier (~2x at Kp 5, ~6x at Kp 9). Each satellite's drag factor comes
  from its TLE B* term (Cd*A/m = 12.74 x B*), and altitude loss per day = rho * Cd*A/m * sqrt(mu*a). Satellites losing an extra
  100 / 300 / 1000+ m per day are flagged WATCH / ELEVATED / HIGH. A slider simulates stronger storms. The last good DONKI
  response is kept, so a rate limit never blanks the page.
- **Satellite finder**: search by name, alias (ISS, Hubble, Tiangong) or NORAD ID; shows the Wikipedia photo and summary,
  CelesTrak SATCAT owner/launch facts, orbit, natural lifetime, and locates it on the globe.
- **Earth View 3D**: geocode any place and fly to it over 3D terrain, or "ride along" under a satellite's live ground track.
  With `GOOGLE_MAPS_API_KEY` set it uses **Google Photorealistic 3D** (real 3D buildings; "Ride" puts the camera at the
  satellite's own altitude). Without a key, or if Google rejects the key, it falls back to the free open terrain view.

## Keys (optional)
Copy `.env.example` to `.env` (git-ignored) and fill in:
- `NASA_API_KEY`: free at https://api.nasa.gov (DEMO_KEY allows only ~30 requests/hour).
- `GOOGLE_MAPS_API_KEY`: Google Cloud > enable **Maps JavaScript API** > Credentials > Create API key. Billing must be
  enabled; Photorealistic 3D is billed as "Immersive Maps" with 5,000 free map loads per month. Restrict the key to
  your sites (e.g. `http://127.0.0.1:5000/*`).
- **Errors**: every API error returns JSON `{error, code, hint}` shown as a friendly card with Retry; unknown pages get a custom 404.

## Limitations
These results are for education and prototyping, not operational use. TLE/SGP4 errors are about 1 km or more and grow over days,
and the free catalog doesn't include classified objects or most small debris. The optimizer is a heuristic trade study, not mission design.
