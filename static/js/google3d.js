/* OrbitGuard | ASTRA 2026 | Team AstroNex */
/* OrbitGuard: Google Photorealistic 3D engine for Earth View (used only when a Google Maps API key is configured). */
"use strict";
const Google3D = (() => {
  const KEY = (window.OG && window.OG.googleKey) || "";
  const box = $("#gmap");
  let el = null, libP = null, M = null, pin = null, failed = null, onUser = null, onMove = null;

  const val = v => typeof v === "function" ? v() : v;     // LatLng getters may be functions or numbers

  function load() {
    if (!KEY) return Promise.reject(new AppError("No Google Maps API key is configured.",
      {code: "MAP", hint: "Put GOOGLE_MAPS_API_KEY=your-key in orbital_watch/.env and restart the server."}));
    if (failed) return Promise.reject(failed);
    libP ??= new Promise((res, rej) => {
      // Key problems are only reported through gm_authFailure (2D maps) or a console error (3D maps),
      // so listen to both and turn Google's error codes into a clear fix.
      const HINTS = {
        InvalidKeyMapError: "The key is wrong or was deleted. Copy it again from Google Cloud > Credentials.",
        ApiNotActivatedMapError: "Enable 'Maps JavaScript API' for this key's project in Google Cloud.",
        BillingNotEnabledMapError: "Turn on billing for the project (the first 5,000 3D map loads each month are free).",
        RefererNotAllowedMapError: `Add ${location.origin}/* to the key's allowed websites in Google Cloud.`,
        ApiTargetBlockedMapError: "The key is restricted to other APIs. Allow 'Maps JavaScript API' in its API restrictions.",
        ExpiredKeyMapError: "The key has expired. Create a new one in Google Cloud.",
      };
      const fail = code => {
        if (failed) return;
        failed = new AppError(`Google rejected the Maps API key (${code}).`, {code: "MAP",
          hint: HINTS[code] || "Check the key, billing and website restrictions in Google Cloud."});
        emit("g3d-fail", failed); rej(failed);
      };
      window.gm_authFailure = () => fail("AuthFailure");
      const origError = console.error;
      console.error = function (...args) {
        const msg = args.map(String).join(" "), m = msg.match(/Google Maps JavaScript API error: (\w+)/);
        if (m) fail(m[1]);
        return origError.apply(this, args);
      };
      window.__ogGmapsReady = () => res();
      const s = document.createElement("script");
      s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(KEY)}&v=weekly&loading=async&callback=__ogGmapsReady`;
      s.async = true;
      s.onerror = () => { libP = null; rej(new AppError("Google Maps could not be downloaded.", {code: "MAP", hint: "Check your internet connection and press Retry."})); };
      document.head.appendChild(s);
    }).then(() => google.maps.importLibrary("maps3d")).then(lib => (M = lib));
    return libP;
  }

  async function init() {
    if (el) return el;
    await load();
    try {
      el = new M.Map3DElement({center: {lat: 27.988, lng: 86.925, altitude: 0}, range: 14000, tilt: 65, heading: 0, mode: "HYBRID"});
    } catch (e) {
      throw new AppError("Google 3D maps couldn't start in this browser.", {code: "MAP", hint: e.message});
    }
    el.style.cssText = "position:absolute;inset:0;width:100%;height:100%";
    box.appendChild(el);
    let last = 0;
    const moved = () => { const t = performance.now(); if (t - last > 200) { last = t; onMove?.(); } };
    for (const ev of ["gmp-centerchange", "gmp-rangechange", "gmp-tiltchange", "gmp-headingchange"]) el.addEventListener(ev, moved);
    el.addEventListener("gmp-steadychange", () => onMove?.());
    box.addEventListener("pointerdown", () => onUser?.());
    box.addEventListener("wheel", () => onUser?.(), {passive: true});
    return el;
  }

  function animEnd(ms) {
    return new Promise(r => {
      const done = () => { el.removeEventListener("gmp-animationend", done); clearTimeout(t); r(); };
      const t = setTimeout(done, ms + 800);
      el.addEventListener("gmp-animationend", done);
    });
  }
  function flyTo({lat, lng, range, tilt = 65, heading = 0, ms = 5000}) {
    el.stopCameraAnimation?.();
    if (REDUCED || ms <= 0) { Object.assign(el, {center: {lat, lng, altitude: 0}, range, tilt, heading}); return Promise.resolve(); }
    el.flyCameraTo({endCamera: {center: {lat, lng, altitude: 0}, range, tilt, heading}, durationMillis: ms});
    return animEnd(ms);
  }
  function orbit(on) {
    if (!el) return;
    if (!on || REDUCED) { el.stopCameraAnimation?.(); return; }
    const c = camera();
    el.flyCameraAround({camera: {center: {lat: c.lat, lng: c.lng, altitude: 0}, range: c.range, tilt: c.tilt, heading: c.heading},
                        durationMillis: 80000, repeatCount: 50});
  }
  function camera() {
    const c = el.center || {};
    return {lat: +val(c.lat), lng: +val(c.lng), range: +el.range, tilt: +el.tilt, heading: +el.heading};
  }
  function setPin(lat, lng, label) {
    if (pin) { pin.remove(); pin = null; }
    if (lat == null) return;
    try {
      pin = new M.Marker3DElement({position: {lat, lng}, altitudeMode: "CLAMP_TO_GROUND", label: label ? label.slice(0, 40) : undefined});
      el.append(pin);
    } catch (e) { console.warn("Marker3DElement unavailable", e); }
  }
  function setLabels(on) { try { el.mode = on ? "HYBRID" : "SATELLITE"; } catch { /* older API */ } }

  return {
    get available() { return !!KEY && !failed; },
    get hasKey() { return !!KEY; },
    get ready() { return !!el; },
    init, flyTo, orbit, camera, setPin, setLabels,
    follow(lat, lng, heading) { el.center = {lat, lng, altitude: 0}; el.heading = heading; },
    setView(o) { Object.assign(el, o); },
    stop() { el?.stopCameraAnimation?.(); },
    show(on) { box.hidden = !on; },
    on(handlers) { onUser = handlers.user; onMove = handlers.move; },
  };
})();
