/* OrbitGuard Earth View 3D: any place in 3D, as seen from orbit; ride along under a live satellite.
   Two engines:  "google" = Google Photorealistic 3D (needs GOOGLE_MAPS_API_KEY)
                 "open"   = MapLibre + Esri imagery + AWS terrain (free, no key) */
"use strict";
const EarthView = (() => {
  const ML = "https://unpkg.com/maplibre-gl@4.7.1/dist/";
  const D2R = Math.PI / 180;
  let engine = Google3D.available ? "google" : "open";
  let map = null, libP = null, place = null, placeMarker = null, satMarker = null;
  let spinning = false, ride = null, visible = false, ovTimer = null, gibsFallback = false, pending = null;
  const info = $("#ev-info");
  const G = () => engine === "google";

  // Web-Mercator + terrain can't handle the poles: near +-85 deg the terrain lookup returns NaN and
  // corrupts the camera ("Invalid LngLat (NaN, NaN)"). Keep every MapLibre camera target inside +-MAX_LAT.
  const MAX_LAT = 80;
  const clampLat = lat => G() ? lat : Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
  const finite = (...v) => v.every(Number.isFinite);
  let goodCam = {center: [86.925, 27.988], zoom: 11.6, pitch: 60, bearing: 0};
  function camOk() {
    if (!map) return true;
    const c = map.getCenter();
    return finite(c.lng, c.lat, map.getZoom(), map.getPitch(), map.getBearing());
  }
  /** If the MapLibre camera ever became NaN, put it back to the last good position. */
  function repairCam() {
    if (!map || camOk()) return;
    console.warn("OrbitGuard: map camera was invalid, restoring last good view");
    map.stop();
    const t = map.getTerrain?.();
    if (t) map.setTerrain(null);
    map.jumpTo(goodCam);
    if (t) map.setTerrain(t);
  }
  function cam(method, opts) {
    repairCam();
    try { map[method](opts); }
    catch (e) { console.warn(e); map.setTerrain?.(null); map.jumpTo(goodCam); map.setTerrain?.({source: "dem", exaggeration: 1.5}); map[method](opts); }
  }
  const yesterday = () => new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const gibs = layer => `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${layer}/default/${yesterday()}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg`;

  /* ---------- engine: open (MapLibre) ---------- */
  function loadLib() {
    if (window.maplibregl) return Promise.resolve();
    libP ??= new Promise((res, rej) => {
      const css = document.createElement("link"); css.rel = "stylesheet"; css.href = ML + "maplibre-gl.css"; document.head.appendChild(css);
      const s = document.createElement("script"); s.src = ML + "maplibre-gl.js"; s.onload = res;
      s.onerror = () => { libP = null; rej(new AppError("The 3D map library could not be downloaded.", {code: "MAP", hint: "Check your internet connection and press Retry."})); };
      document.head.appendChild(s);
    });
    return libP;
  }
  async function initOpen() {
    if (map) return map;
    info.textContent = "Loading 3D map…";
    await loadLib();
    try {
      map = new maplibregl.Map({
        container: "map", center: [86.925, 27.988], zoom: 11.6, pitch: 68, bearing: -25, maxPitch: 85,
        attributionControl: {compact: true}, fadeDuration: 150,
        style: {
          version: 8,
          sources: {
            hires: {type: "raster", tileSize: 256, maxzoom: 19, attribution: "Imagery © Esri, Maxar, Earthstar Geographics",
                    tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"]},
            today: {type: "raster", tileSize: 256, maxzoom: 9, attribution: "NASA GIBS / VIIRS (yesterday's pass)",
                    tiles: [gibs("VIIRS_NOAA20_CorrectedReflectance_TrueColor")]},
            labels: {type: "raster", tileSize: 256, maxzoom: 19,
                     tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}"]},
            dem: {type: "raster-dem", tileSize: 256, maxzoom: 14, encoding: "terrarium", attribution: "Terrain: Mapzen / AWS Open Data",
                  tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"]},
          },
          layers: [
            {id: "bg", type: "background", paint: {"background-color": "#071029"}},
            {id: "hires", type: "raster", source: "hires"},
            {id: "today", type: "raster", source: "today", layout: {visibility: "none"}},
            {id: "labels", type: "raster", source: "labels", paint: {"raster-opacity": .85}},
          ],
          terrain: {source: "dem", exaggeration: 1.5},
        },
      });
    } catch (e) {
      map = null;
      throw new AppError("Your browser couldn't start the 3D map (WebGL is off or unsupported).", {code: "MAP", hint: "Try another browser or enable hardware acceleration."});
    }
    map.addControl(new maplibregl.NavigationControl({visualizePitch: true}), "bottom-right");
    map.on("error", e => {
      if (e.sourceId === "today" && !gibsFallback) {           // fall back to MODIS if VIIRS tiles are missing
        gibsFallback = true; map.getSource("today")?.setTiles([gibs("MODIS_Terra_CorrectedReflectance_TrueColor")]);
      }
    });
    const userMove = e => { if (e.originalEvent) { stopSpin(); stopRide(); } };
    map.on("dragstart", userMove); map.on("rotatestart", userMove); map.on("pitchstart", userMove);
    let lastInfo = 0;   // throttle (not debounce): the view moves continuously while spinning or riding
    map.on("move", () => { const t = performance.now(); if (t - lastInfo > 200) { lastInfo = t; updateInfo(); } });
    map.on("moveend", () => {
      if (camOk()) {
        const c = map.getCenter();
        goodCam = {center: [c.lng, c.lat], zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing()};
      } else repairCam();
      updateInfo();
    });
    await Promise.race([new Promise(r => map.once("load", r)), new Promise(r => setTimeout(r, 2500))]);
    return map;
  }

  /* ---------- engine: google ---------- */
  Google3D.on({user: () => { stopSpin(); stopRide(); }, move: () => updateInfo()});
  on("g3d-fail", e => {
    // key rejected after loading: tell the user and fall back to the free engine
    toast(`<b>Google 3D unavailable:</b> ${esc(e.message)}<br>${esc(e.hint || "")}<br>Switched to the free 3D terrain view.`, "warn", 12000);
    setEngine("open");
  });

  async function init() {
    if (G()) {
      try { info.textContent = "Loading Google photorealistic 3D…"; return await Google3D.init(); }
      catch (e) {
        toast(`<b>Google 3D unavailable:</b> ${esc(e.message)} Using the free 3D terrain view.`, "warn", 9000);
        engine = "open"; syncEngineUI();
      }
    }
    return initOpen();
  }

  function syncEngineUI() {
    Google3D.show(G());
    $("#map").style.visibility = G() ? "hidden" : "visible";
    const chip = $('#ev-layers [data-layer="engine"]');
    if (chip) {
      chip.classList.toggle("on", G());
      chip.innerHTML = `${icon("cube")}${Google3D.hasKey ? "Google 3D" : "Google 3D (add key)"}`;
    }
    $('#ev-layers [data-layer="today"]').hidden = G();
    $('#ev-layers [data-layer="hires"]').hidden = G();
    $(".map-hud.bl").style.bottom = G() ? "12px" : "";
  }
  async function setEngine(name) {
    if (name === engine && (name === "open" ? map : true)) { syncEngineUI(); return; }
    const was = ride?.s, where = place;
    stopSpin(); stopRide(); Google3D.stop();
    engine = name; syncEngineUI();
    try {
      await init();
      if (was) await rideAlong(was);
      else if (where && !where.name.startsWith("Below ")) await goTo(where);
      else await goTo({name: "Mount Everest, Nepal", lat: 27.98806, lon: 86.92521, bbox: [27.95, 28.03, 86.88, 86.97]});
    } catch (e) { showError(info, e, () => setEngine(name)); }
  }

  /* ---------- info overlay ---------- */
  function updateInfo() {
    let lat, lng, camKm, tilt, elev = null;
    if (G()) {
      if (!Google3D.ready) return;
      const c = Google3D.camera(); if (!finite(c.lat, c.lng)) return;
      lat = c.lat; lng = c.lng; tilt = c.tilt; camKm = c.range / 1000;
    } else {
      if (!map) return;
      if (!camOk()) { repairCam(); return; }
      const c = map.getCenter(), z = map.getZoom();
      lat = c.lat; lng = c.lng; tilt = map.getPitch();
      camKm = 156543.03 * Math.cos(lat * D2R) / 2 ** z * map.getCanvas().clientHeight / 1000 * 1.4;
      try { elev = map.queryTerrainElevation?.(c); } catch { /* terrain not ready */ }
    }
    info.innerHTML = `${place && !ride ? `<b>${esc(place.short)}</b><br>` : ""}` +
      `${fmt(Math.abs(lat), 4)}°${lat >= 0 ? "N" : "S"} ${fmt(Math.abs(lng), 4)}°${lng >= 0 ? "E" : "W"}` +
      (elev > 1 ? ` · ground ${fmt(elev / 1.5)} m` : "") +
      `<br>${G() ? "Camera distance" : "Camera"} ≈ ${camKm < 10 ? fmt(camKm, 2) : fmt(camKm)} km · tilt ${fmt(tilt)}°` +
      `<br><span style="color:var(--accent)">${G() ? "Google Photorealistic 3D" : "Open 3D terrain (Esri + AWS)"}</span>`;
  }

  /* ---------- go to a place ---------- */
  function zoomFor(p) {
    if (p.bbox) {
      const span = Math.max(Math.abs(p.bbox[1] - p.bbox[0]), Math.abs(p.bbox[3] - p.bbox[2]) * Math.cos(p.lat * D2R));
      return Math.min(12.4, Math.max(3, Math.log2(360 / Math.max(span, 1e-4)) - .6));
    }
    return 12;
  }
  function rangeFor(p) {          // Google camera distance (m) that frames the place nicely
    if (!p.bbox) return 2500;
    const spanM = Math.max(Math.abs(p.bbox[1] - p.bbox[0]), Math.abs(p.bbox[3] - p.bbox[2]) * Math.cos(p.lat * D2R)) * 111000;
    return Math.min(3e6, Math.max(450, spanM * 2.4));
  }
  async function goTo(p) {
    stopRide();
    await init();
    if (!finite(+p.lat, +p.lon)) throw new AppError("That place has no usable coordinates.", {code: "PLACE_NOT_FOUND", hint: "Pick another result or type 'lat, lon'."});
    stopSpin();
    const lat = clampLat(+p.lat), lon = +p.lon;
    place = {...p, lat, lon, short: p.name.split(",").slice(0, 2).join(",")};
    refreshOverhead();
    if (G()) {
      Google3D.setPin(lat, lon, place.short);
      const c = Google3D.camera();
      await Google3D.flyTo({lat, lng: lon, range: rangeFor(place), tilt: 67, heading: (finite(c.heading) ? c.heading : 0) + 40, ms: 6000});
      if (!ride && place.lat === lat) startSpin();
      updateInfo();
      return;
    }
    repairCam();
    placeMarker ??= new maplibregl.Marker({element: Object.assign(document.createElement("div"), {className: "pin"})});
    placeMarker.setLngLat([lon, lat]).addTo(map);
    const bearing = (Number.isFinite(map.getBearing()) ? map.getBearing() : 0) + 40;
    cam("flyTo", {center: [lon, lat], zoom: zoomFor(place), pitch: 65, bearing, duration: REDUCED ? 0 : 5000, curve: 1.6, essential: true});
    if (Math.abs(p.lat) > MAX_LAT) toast("Polar regions can't be shown in this 3D view, so it stops at 80° latitude.", "warn");
    map.once("moveend", () => { if (!ride) startSpin(); });
  }

  /* ---------- spin around the place ---------- */
  function startSpin() {
    if (spinning || REDUCED) return;
    spinning = true; $("#ev-spin").classList.add("on");
    if (G()) { Google3D.orbit(true); return; }
    const step = () => {
      if (!spinning || !map || G()) return;
      if (visible) { if (camOk()) map.setBearing(map.getBearing() + .06); else repairCam(); }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
  function stopSpin() {
    if (spinning && G()) Google3D.orbit(false);
    spinning = false; $("#ev-spin")?.classList.remove("on");
  }
  $("#ev-spin").onclick = () => spinning ? stopSpin() : startSpin();
  $("#ev-tilt").onclick = () => {
    stopSpin();
    if (G()) { if (!Google3D.ready) return; const c = Google3D.camera(); Google3D.flyTo({lat: c.lat, lng: c.lng, range: c.range, heading: c.heading, tilt: c.tilt > 20 ? 0 : 67, ms: 900}); return; }
    if (map) cam("easeTo", {pitch: map.getPitch() > 20 ? 0 : 65, duration: 900});
  };

  /* ---------- ride along under a satellite ---------- */
  function heading(a, b) {
    const f1 = a.lat * D2R, f2 = b.lat * D2R, dl = (b.lon - a.lon) * D2R;
    return Math.atan2(Math.sin(dl) * Math.cos(f2), Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl)) / D2R;
  }
  async function rideAlong(s) {
    if (!Globe) throw new AppError("Satellite positions need the 3D globe, which couldn't start.", {code: "WEBGL"});
    await init();
    stopSpin(); stopRide();
    const jd = Globe.nowJD(), st = Globe.stateOf(s, jd), nx = Globe.stateOf(s, jd + 10 / 86400);
    if (!finite(st.lat, st.lon)) throw new AppError(`Couldn't compute where ${s.name} is right now.`, {code: "SAT_NOT_FOUND"});
    const h0 = heading(st, nx);
    ride = {s, ready: false, heading: Number.isFinite(h0) ? h0 : 0};
    place = {name: `Below ${s.name}`, short: `Below ${s.name}`, lat: clampLat(st.lat), lon: st.lon};
    // Build the banner ONCE. It used to be re-rendered every 80 ms, which replaced the Stop button
    // between mousedown and mouseup, so clicks never registered.
    const badge = $("#ride-badge");
    badge.innerHTML = `${icon("satellite")}<span class="ride-text"></span><button type="button" class="ride-stop">${icon("x")}Stop</button>`;
    const badgeText = $(".ride-text", badge);
    const stopBtn = $(".ride-stop", badge);
    // react on press (pointerdown), not only on a completed click, so nothing can swallow it
    stopBtn.addEventListener("pointerdown", e => { e.preventDefault(); e.stopPropagation(); stopRide(true); });
    stopBtn.addEventListener("click", e => { e.stopPropagation(); stopRide(true); });
    stopBtn.title = "Stop riding (Esc)";
    badgeText.textContent = `Flying to ${s.name}…`;
    badge.hidden = false;
    if (G()) {
      // camera sits at the satellite's real height, looking down and slightly ahead along its track
      Google3D.setPin(null);
      ride.range = Math.max(2e5, st.alt * 1000);
      Google3D.flyTo({lat: st.lat, lng: st.lon, range: ride.range, tilt: 35, heading: ride.heading, ms: 4000})
        .then(() => { if (ride?.s === s) ride.ready = true; });
    } else {
      repairCam();
      satMarker ??= new maplibregl.Marker({element: Object.assign(document.createElement("div"), {className: "pin sat"})});
      satMarker.setLngLat([st.lon, clampLat(st.lat)]).addTo(map);
      placeMarker?.remove();
      cam("flyTo", {center: [st.lon, clampLat(st.lat)], zoom: 7.2, pitch: 62, bearing: ride.heading, duration: REDUCED ? 0 : 3500, essential: true});
      map.once("moveend", () => { if (ride?.s === s) ride.ready = true; });
    }
    const tick = () => {
      if (!ride || ride.s !== s) return;
      requestAnimationFrame(tick);
      const now = performance.now();
      if (!visible || now - (ride.t || 0) < 80) return;
      ride.t = now;
      const j = Globe.nowJD(), a = Globe.stateOf(s, j), b = Globe.stateOf(s, j + 10 / 86400);
      if (!finite(a.lat, a.lon)) return;
      const h = heading(a, b);
      if (Number.isFinite(h)) ride.heading += ((h - ride.heading + 540) % 360 - 180) * .1;
      const lat = clampLat(a.lat), polar = lat !== a.lat;
      place.lat = lat; place.lon = a.lon;
      const text = `${G() ? "Seeing Earth from" : "Riding under"} ${s.name} · ${fmt(a.alt)} km up · ${fmt(a.v, 2)} km/s` +
        (polar ? " · over the pole (view held at 80°)" : "");
      if (badgeText.textContent !== text) badgeText.textContent = text;
      if (!ride.ready) return;
      if (G()) { Google3D.follow(a.lat, a.lon, ride.heading); return; }
      satMarker.setLngLat([a.lon, lat]);
      if (!camOk()) { repairCam(); return; }
      try { map.jumpTo({center: [a.lon, lat], bearing: ride.heading}); }
      catch (e) { console.warn(e); repairCam(); }
    };
    requestAnimationFrame(tick);
    refreshOverhead();
    syncStopPanel();
  }
  function syncStopPanel() {
    let b = $("#ov-stop");
    if (!b) {
      $("#ov-note").insertAdjacentHTML("beforebegin", `<button class="btn sm" id="ov-stop" type="button" hidden style="margin-bottom:12px;background:linear-gradient(135deg,#ff5c72,#ff8a5c)">${icon("x")}Stop riding</button>`);
      b = $("#ov-stop");
      b.addEventListener("click", () => stopRide(true));
    }
    b.hidden = !ride;
  }
  addEventListener("keydown", e => { if (e.key === "Escape" && ride && visible) stopRide(true); });
  function stopRide(byUser = false) {
    if (!ride) return;
    const name = ride.s.name;
    ride = null;
    $("#ride-badge").hidden = true;
    satMarker?.remove();
    syncStopPanel();
    if (byUser) {
      // also halt any camera flight still in progress, and leave the view where it is
      if (G()) Google3D.stop(); else map?.stop();
      place = place && {...place, name: `Near ${name}`, short: `Last seen below ${name}`};
      updateInfo(); refreshOverhead();
      toast(`Stopped riding ${esc(name)}. Drag to explore, or pick another satellite.`, "good", 3500);
    }
  }

  /* ---------- satellites overhead ---------- */
  function refreshOverhead() {
    const box = $("#ov-list");
    if (!place) return;
    if (!Globe) { showError(box, new AppError("Needs the 3D globe, which couldn't start.", {code: "WEBGL"})); return; }
    if (!Globe.ready) { box.innerHTML = '<div class="loading">Waiting for satellite data…</div>'; return; }
    const list = Globe.overhead(place.lat, place.lon, 10, 25);
    $("#ov-note").innerHTML = `<b>${list.length}${list.length === 25 ? "+" : ""}</b> satellites are more than 10° above the horizon at <b>${esc(place.short)}</b> right now (from ${fmt(Globe.count)} sampled).`;
    box.innerHTML = list.length ? list.map(({s, el, range}) => `<div class="ov">
        <div class="el" style="--e:${(el / 90 * 100).toFixed(0)}" title="Elevation ${fmt(el)}°"><span>${fmt(el)}°</span></div>
        <div><b>${esc(s.name)}</b><small>${fmt(s.alt)} km up · ${fmt(range)} km away</small></div>
        <button class="btn ghost sm" data-ride="${s.id}" title="See Earth from this satellite">${icon("eye")}Ride</button></div>`).join("")
      : `<div class="empty">${icon("check")}<p>No sampled satellites above 10° right now. Check again in a minute.</p></div>`;
  }
  $("#ov-list").addEventListener("click", e => {
    const b = e.target.closest("[data-ride]"); if (!b) return;
    const s = Globe?.find(+b.dataset.ride);
    if (s) { rideAlong(s).catch(err => toast(esc(err.message), "bad")); Globe.select(s.id, {fly: false}); }
  });

  /* ---------- layers + engine switch ---------- */
  $("#ev-layers").insertAdjacentHTML("afterbegin", `<button class="chip" data-layer="engine" title="Google Photorealistic 3D buildings and terrain"></button>`);
  $$("#ev-layers .chip").forEach(b => b.onclick = async () => {
    const L = b.dataset.layer;
    if (L === "engine") {
      if (!Google3D.hasKey) {
        toast("To use Google's photorealistic 3D: create a key in Google Cloud (enable <b>Maps JavaScript API</b>, billing on: 5,000 free 3D loads/month), " +
              "put <code>GOOGLE_MAPS_API_KEY=your-key</code> in <code>orbital_watch/.env</code>, and restart the server.", "info", 12000);
        return;
      }
      if (!Google3D.available) { toast("Google rejected the key earlier. Fix it in Google Cloud, then reload the page.", "warn", 8000); return; }
      setEngine(G() ? "open" : "google");
      return;
    }
    if (L === "labels") {
      b.classList.toggle("on");
      const show = b.classList.contains("on");
      if (G()) Google3D.setLabels(show);
      if (map) map.setLayoutProperty("labels", "visibility", show ? "visible" : "none");
      return;
    }
    await initOpen().catch(() => null); if (!map) return;
    $$('#ev-layers [data-layer="hires"], #ev-layers [data-layer="today"]').forEach(x => x.classList.toggle("on", x === b));
    map.setLayoutProperty("hires", "visibility", L === "hires" ? "visible" : "none");
    map.setLayoutProperty("today", "visibility", L === "today" ? "visible" : "none");
    if (L === "today") { toast(`Showing NASA's true-colour mosaic from ${yesterday()} (about 375 m per pixel). Zoom out to see it best.`, "info", 6000); if (map.getZoom() > 9) cam("easeTo", {zoom: 7.5}); }
  });
  syncEngineUI();

  /* ---------- public ---------- */
  async function open() {
    try {
      await init();
      syncEngineUI();
      repairCam();
      if (pending) { const p = pending; pending = null; await p(); }
      else if (!place) await goTo({name: "Mount Everest, Nepal", lat: 27.98806, lon: 86.92521, bbox: [27.95, 28.03, 86.88, 86.97]});
    } catch (e) {
      showError(info, e, () => open());
      info.style.maxWidth = "420px";
    }
  }
  return {
    open,
    show() { visible = true; map?.resize(); clearInterval(ovTimer); ovTimer = setInterval(() => { if (visible) refreshOverhead(); }, 4000); refreshOverhead(); },
    hide() { visible = false; clearInterval(ovTimer); },
    goTo: p => goTo(p).catch(e => showError(info, e, () => goTo(p))),
    ride(s) { if (G() ? Google3D.ready : map) rideAlong(s).catch(e => toast(esc(e.message), "bad")); else pending = () => rideAlong(s); },
    queue(fn) { pending = fn; },
  };
})();
