/* OrbitGuard | ASTRA 2026 | Team AstroNex */
/* OrbitGuard app: routing, dashboard, satellite finder, collisions, space weather, planner, asteroids */
"use strict";
if (window.Chart) {
  Chart.defaults.color = "#b3b3b3"; Chart.defaults.borderColor = "rgba(128,128,128,.18)";
  Chart.defaults.font.family = '"Inter", system-ui, sans-serif';
}
const charts = {};
const RE_KM = 6378.137;

/* =====================================================================
   Routing + shell
   ===================================================================== */
const VIEWS = $$(".view").map(v => v.id.slice(2));
const visited = {};
const ON_FIRST = {
  satellites: () => { if (Globe?.selected) renderProfile(Globe.selected.id); },
  earth: () => EarthView.open(),
  weather: () => loadWeatherView(),
  changes: () => loadDisturb(),
  asteroids: () => renderAsteroids(),
};
let current = "dashboard";
function go(view, {silent = false} = {}) {
  if (!VIEWS.includes(view)) {
    if (!silent) toast(`There's no "${esc(view)}" section. Showing the dashboard.`, "warn");
    view = "dashboard";
  }
  current = view;
  $$(".view").forEach(v => v.classList.toggle("show", v.id === "v-" + view));
  $$(".nav-btn").forEach(b => b.classList.toggle("active", b.dataset.view === view));
  const slot = $(`#v-${view} [data-globe]`);
  if (slot) Globe?.mount(slot);
  view === "earth" ? EarthView.show() : EarthView.hide();
  document.title = `${$("#v-" + view).dataset.title} · OrbitGuard`;
  history.replaceState(null, "", view === "dashboard" ? location.pathname : "#" + view);
  closeMenu();
  if (!visited[view]) { visited[view] = true; ON_FIRST[view]?.(); }
  scrollTo({top: 0, behavior: REDUCED ? "auto" : "smooth"});
}
$$(".nav-btn").forEach(b => b.onclick = () => go(b.dataset.view));
document.addEventListener("click", e => {
  const g = e.target.closest("[data-go]"); if (g) go(g.dataset.go);
  const l = e.target.closest("[data-locate]"); if (l) openSatellite(+l.dataset.locate);
  if (!e.target.closest("#bell, #alerts-pop")) $("#alerts-pop").hidden = true;
});
function closeMenu() { $("#sidebar").classList.remove("open"); $("#scrim").hidden = true; }
$("#menu-btn").onclick = () => { $("#sidebar").classList.add("open"); $("#scrim").hidden = false; };
$("#scrim").onclick = closeMenu;
$("#bell").onclick = () => { $("#alerts-pop").hidden = !$("#alerts-pop").hidden; };
addEventListener("keydown", e => {
  if (e.key === "/" && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) { e.preventDefault(); $("#top-search input").focus(); }
  if (e.key === "Escape") { closeMenu(); $("#alerts-pop").hidden = true; }
});
setInterval(() => { $("#utc").textContent = new Date().toISOString().slice(0, 19).replace("T", " "); }, 1000);
if (!navigator.onLine) $("#offline").hidden = false;

/* sources + pipeline status */
function setSrc(key, state, text) {
  const dot = $("#d-" + key), lbl = $("#s-" + key), tag = $("#src-" + key);
  dot.className = "dot " + state; lbl.textContent = text;
  tag.className = "tag " + ({ok: "good", warn: "warn", bad: "bad"}[state] || "mute");
  tag.textContent = {ok: "ACTIVE", warn: "LIMITED", bad: "OFFLINE"}[state] || "…";
}
const STEPS = ["orbits", "conj", "drag", "plan"];
function setStep(name, state, text) {
  const el = $(`#pipe [data-s="${name}"]`); if (!el) return;
  el.classList.remove("done", "run"); if (state) el.classList.add(state);
  $("small", el).textContent = text;
  const lastDone = Math.max(-1, ...STEPS.map((s, i) => $(`#pipe [data-s="${s}"]`).classList.contains("done") ? i : -1));
  $("#pipe .fill").style.width = lastDone > 0 ? `${lastDone / 3 * 75}%` : "0";
}

/* =====================================================================
   Search boxes
   ===================================================================== */
function makeSearch(root, {url, render, onPick, min = 2}) {
  const input = $("input", root), box = $(".suggest", root);
  let items = [], idx = -1, forQ = "", seq = 0;
  const close = () => { box.hidden = true; root.setAttribute("aria-expanded", "false"); };
  const open = () => { box.hidden = false; root.setAttribute("aria-expanded", "true"); };
  const draw = () => {
    box.innerHTML = items.map((it, i) => render(it, i === idx)).join("");
    $$(".sg-item", box).forEach((b, i) => b.onmousedown = e => { e.preventDefault(); pick(i); });
  };
  function pick(i) { const it = items[i]; if (!it) return; close(); input.blur(); onPick(it, input); }
  async function search() {
    const q = input.value.trim(), my = ++seq;
    if (q.length < min && !/^\d+$/.test(q)) { items = []; close(); return; }
    open(); box.innerHTML = '<div class="sg-empty">Searching…</div>';
    try {
      const d = await getJSON(url(q), {timeout: 20000});
      if (my !== seq) return;
      items = d.results; forQ = q; idx = items.length ? 0 : -1;
      if (items.length) draw(); else box.innerHTML = `<div class="sg-empty">No match for “${esc(q)}”. Try another spelling or a NORAD number.</div>`;
    } catch (e) {
      if (my !== seq) return;
      items = []; forQ = "";
      box.innerHTML = `<div class="sg-empty" style="color:${e.code === "QUERY_TOO_SHORT" ? "var(--muted)" : "var(--bad)"}">${icon("alert")} <b>${esc(ERROR_TITLES[e.code] || "Search failed")}</b>: ${esc(e.message)}${e.hint ? `<br><small>${esc(e.hint)}</small>` : ""}</div>`;
    }
  }
  const later = debounce(search, 260);
  input.addEventListener("input", later);
  input.addEventListener("focus", () => { if (items.length && input.value.trim() === forQ) { open(); draw(); } });
  input.addEventListener("blur", () => setTimeout(close, 160));
  input.addEventListener("keydown", async e => {
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && items.length) {
      e.preventDefault(); idx = (idx + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length; draw();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (input.value.trim() !== forQ) await search();
      if (items.length) pick(Math.max(0, idx));
    } else if (e.key === "Escape") { close(); input.blur(); }
  });
}
const satItem = (it, on) => `<button type="button" class="sg-item ${it.kind !== "satellite" ? "deb" : ""} ${on ? "on" : ""}" role="option">
  <span class="sg-ic">${icon(it.kind === "satellite" ? "satellite" : "alert")}</span>
  <span><b>${esc(it.name)}</b><small>NORAD ${it.norad} · ${fmt(it.alt_km)} km · ${fmt(it.inc_deg, 1)}°</small></span>
  <span class="tag ${it.kind === "satellite" ? "info" : "bad"}">${it.kind === "satellite" ? it.regime : esc(it.kind.toUpperCase())}</span></button>`;
for (const id of ["#top-search", "#big-search"]) {
  makeSearch($(id), {url: q => "/api/search?q=" + encodeURIComponent(q), render: satItem,
                     onPick: (it, input) => { input.value = ""; openSatellite(it.norad); }});
}
makeSearch($("#place-search"), {
  url: q => "/api/geocode?q=" + encodeURIComponent(q),
  render: (p, on) => `<button type="button" class="sg-item ${on ? "on" : ""}" role="option"><span class="sg-ic">${icon("pin")}</span>
    <span><b>${esc(p.name.split(",")[0])}</b><small>${esc(p.name.split(",").slice(1, 4).join(",") || `${fmt(p.lat, 3)}, ${fmt(p.lon, 3)}`)}</small></span></button>`,
  onPick: (p, input) => { input.value = p.name.split(",")[0]; EarthView.goTo(p); },
});

/* =====================================================================
   Selecting a satellite (globe + hero + profile)
   ===================================================================== */
const profiles = new Map();
const getProfile = id => {
  if (!profiles.has(id)) profiles.set(id, getJSON("/api/satellite/" + id, {timeout: 30000}).catch(e => { profiles.delete(id); throw e; }));
  return profiles.get(id);
};
async function openSatellite(norad, view = "satellites") {
  go(view);
  if (!Globe) { renderProfile(norad); return; }
  $("#profile").innerHTML = '<div class="loading">Locating satellite…</div>';
  try { await Globe.select(norad); }
  catch (e) { showError($("#profile"), e, () => openSatellite(norad, view)); }
}

const SAT_SVG = `<svg class="fallback" viewBox="0 0 120 120" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round">
  <rect x="48" y="44" width="24" height="32" rx="4"/><path d="M60 44V30M54 30h12"/><circle cx="60" cy="27" r="3"/>
  <path d="M48 52H14v16h34M72 52h34v16H72"/><path d="M22 52v16M30 52v16M38 52v16M82 52v16M90 52v16M98 52v16" opacity=".5"/>
  <path d="M54 76l-4 10h20l-4-10"/></svg>`;

on("select", s => { updateHero(s); renderProfile(s.id); lastKey = ""; });
async function updateHero(s) {
  $("#h-name").textContent = s.name;
  $("#h-norad").textContent = s.id;
  $("#h-sub").textContent = `${Globe.BANDS[s.band].short} · ${fmt(s.alt)} km · ${fmt(s.i * 180 / Math.PI, 1)}° inclination`;
  $("#h-status").className = "tag info"; $("#h-status").textContent = "TRACKING";
  $("#h-cospar").textContent = "…"; $("#h-launch").textContent = "…";
  try {
    const p = await getProfile(s.id);
    if (Globe.selected?.id !== s.id) return;
    $("#h-thumb").innerHTML = p.wiki?.image ? `<img src="${esc(p.wiki.image)}" alt="${esc(p.name)}" loading="lazy" referrerpolicy="no-referrer">` : icon("satellite");
    const st = p.satcat?.status || (p.kind === "satellite" ? "Tracked" : p.kind);
    $("#h-status").className = "tag " + (/^Operational|Extended/.test(st) ? "good" : p.kind !== "satellite" ? "bad" : "mute");
    $("#h-status").textContent = st.toUpperCase();
    $("#h-cospar").textContent = p.intl_des || "–";
    $("#h-launch").textContent = p.satcat?.launch_date || "–";
    $("#h-sub").textContent = `${p.mission.category} · ${p.regime} · ${fmt(p.orbit.inc_deg, 1)}° inclination${p.satcat?.owner ? " · " + p.satcat.owner : ""}`;
  } catch { $("#h-cospar").textContent = "–"; $("#h-launch").textContent = "–"; }
}
async function renderProfile(id) {
  const el = $("#profile");
  el.innerHTML = `<div class="profile"><div class="p-img skeleton"></div><div><div class="skeleton" style="height:28px;width:60%"></div>
    <div class="skeleton" style="height:14px;margin-top:14px"></div><div class="skeleton" style="height:14px;margin-top:8px;width:80%"></div></div></div>`;
  let p;
  try { p = await getProfile(id); } catch (e) { showError(el, e, () => renderProfile(id)); return; }
  if (Globe?.selected && Globe.selected.id !== id) return;
  const o = p.orbit, c = p.satcat || {}, w = p.wiki;
  const status = c.status || "Tracked";
  const desc = w?.extract ? (w.extract.length > 480 ? w.extract.slice(0, 480).replace(/\s\S*$/, "") + "…" : w.extract) : p.mission.summary;
  const lifeYr = o.alt_km < 650 ? decayLife(o.alt_km, ballistic(o.bstar)) : null;
  el.innerHTML = `<div class="profile">
    <figure class="p-img" style="margin:0">${w?.image ? `<img src="${esc(w.image_full || w.image)}" alt="${esc(p.name)}" loading="lazy" referrerpolicy="no-referrer"
        onerror="this.replaceWith(document.createRange().createContextualFragment(SAT_SVG))"><figcaption>Image: Wikipedia / Wikimedia Commons</figcaption>` : SAT_SVG}</figure>
    <div style="min-width:0">
      <h2 class="p-name">${esc(p.name)}</h2>
      <div class="p-tags"><span class="tag info">${esc(p.mission.category)}</span><span class="tag mute">${p.regime}</span>
        <span class="tag ${/^Operational|Extended/.test(status) ? "good" : p.kind !== "satellite" ? "bad" : "mute"}">${esc(status)}</span>
        ${c.owner ? `<span class="tag mute">${esc(c.owner)}</span>` : ""}</div>
      <p class="p-desc">${esc(desc)}</p>
      ${w?.url ? `<a href="${esc(w.url)}" target="_blank" rel="noopener" class="link-btn">${icon("ext")}Read more on Wikipedia</a>` : ""}
      <div class="btns mt">
        <button class="btn sm" id="p-locate">${icon("locate")}Locate on globe</button>
        <button class="btn ghost sm" id="p-conj">${icon("radar")}Check collisions</button>
        <button class="btn ghost sm" id="p-ride">${icon("eye")}See Earth below it</button>
      </div>
    </div></div>
    <div class="facts">
      ${[["NORAD ID", p.norad], ["COSPAR ID", p.intl_des || "–"], ["Launched", c.launch_date || "–"], ["Launch site", c.launch_site || "–"],
         ["Altitude", fmt(o.alt_km) + " km"], ["Perigee × apogee", `${fmt(o.perigee_km)} × ${fmt(o.apogee_km)} km`],
         ["Inclination", fmt(o.inc_deg, 2) + "°"], ["Period", fmt(o.period_min, 1) + " min"], ["Speed", fmt(o.speed_kms, 2) + " km/s"],
         ["Radar size (RCS)", c.rcs_m2 ? fmt(c.rcs_m2, 2) + " m²" : "–"], ["Natural lifetime", lifeYr == null ? "Decades+" : fmtLife(lifeYr * 365.25)],
         ["Orbit data age", fmt(o.tle_age_h, 1) + " h"]]
        .map(([k, v]) => `<div class="fact"><span>${k}</span><b>${esc(v)}</b></div>`).join("")}
    </div>`;
  $("#p-locate").onclick = () => Globe?.select(id).then(() => {
    if (!$("#z-follow").classList.contains("on")) $("#z-follow").click();
    $("#v-satellites [data-globe]").scrollIntoView({behavior: REDUCED ? "auto" : "smooth", block: "center"});
  });
  $("#p-conj").onclick = () => { go("collisions"); $("#c-norad").value = id; loadConj(); };
  $("#p-ride").onclick = () => rideUnder(id);
}
function rideUnder(id) {
  const s = Globe?.find(id);
  if (!s) { toast("Select a satellite first.", "warn"); return; }
  go("earth"); EarthView.ride(s);
}
$("#h-more").onclick = () => { go("satellites"); };
$("#h-ride").onclick = () => Globe?.selected && rideUnder(Globe.selected.id);
$("#popular").innerHTML = [["ISS", 25544], ["Tiangong", 48274], ["Hubble", 20580], ["NOAA 20", 43013], ["Landsat 9", 49260], ["Sentinel-2A", 40697], ["Terra", 25994]]
  .map(([n, id]) => `<button class="chip" data-locate="${id}">${icon("satellite")}${n}</button>`).join("");

/* =====================================================================
   Telemetry + live hero values + ground-track map
   ===================================================================== */
const ATM = [[100, 5.297e-7, 5.877], [110, 9.661e-8, 7.263], [120, 2.438e-8, 9.473], [130, 8.484e-9, 12.636], [140, 3.845e-9, 16.149],
  [150, 2.070e-9, 22.523], [180, 5.464e-10, 29.740], [200, 2.789e-10, 37.105], [250, 7.248e-11, 45.546], [300, 2.418e-11, 53.628],
  [350, 9.518e-12, 53.298], [400, 3.725e-12, 58.515], [450, 1.585e-12, 60.828], [500, 6.967e-13, 63.822], [600, 1.454e-13, 71.835],
  [700, 3.614e-14, 88.667], [800, 1.170e-14, 124.64], [900, 5.245e-15, 181.05], [1000, 3.019e-15, 268.00]];
const rho = h => { let b = ATM[0]; for (const r of ATM) if (h >= r[0]) b = r; return b[1] * Math.exp(-(h - b[0]) / b[2]); };
const stormMult = (kp, h) => 1 + (.55 * Math.max(0, kp - 3) ** 1.25) * Math.min(1.2, Math.max(.4, .4 + h / 800));
const decay = (h, bc, m = 1) => rho(h) * m * bc * Math.sqrt(398600.4418e9 * (RE_KM + h) * 1e3) * 86400;
const ballistic = b => b > 1e-6 ? Math.min(.15, Math.max(.001, 12.741621 * b)) : .02;
function decayLife(h, bc) { let t = 0; while (h > 200 && t < 36500 * 3) { const st = Math.min(10, h - 200); t += st * 1000 / decay(h - st / 2, bc); h -= st; } return t / 365.25; }
const fmtLife = d => d < 1 ? "< 1 day" : d < 1.5 ? "1 day" : d < 60 ? `${fmt(d)} days` : d < 730 ? `${fmt(d / 30.4)} months` : d > 36500 ? "100+ years" : `${fmt(d / 365.25)} years`;
const fmtLat = v => `${fmt(Math.abs(v), 3)}° ${v >= 0 ? "N" : "S"}`, fmtLon = v => `${fmt(Math.abs(v), 3)}° ${v >= 0 ? "E" : "W"}`;

let tTab = "orbit", lastTick = null, lastKey = "";
$$("#t-tabs button").forEach(b => b.onclick = () => { tTab = b.dataset.t; $$("#t-tabs button").forEach(x => x.classList.toggle("on", x === b)); lastKey = ""; renderTelemetry(); });
on("tick", t => { lastTick = t; renderTelemetry(); updateHeroLive(t.st); });
function telemetryRows({s, st}) {
  if (tTab === "orbit") return [["height", "Altitude (mean)", fmt(s.alt, 1) + " km"], ["speed", "Velocity", fmt(st.v, 2) + " km/s"],
    ["angle", "Inclination", fmt(st.inc, 2) + "°"], ["orbit", "Eccentricity", fmt(st.ecc, 4)], ["clock", "Period", fmt(st.period, 1) + " min"],
    ["down", "Perigee / apogee", `${fmt(st.perigee)} / ${fmt(st.apogee)} km`]];
  if (tTab === "pos") return [["pin", "Latitude", fmtLat(st.lat)], ["pin", "Longitude", fmtLon(st.lon)], ["height", "Altitude now", fmt(st.alt, 1) + " km"],
    ["speed", "Ground-track speed", fmt(st.v * RE_KM / (RE_KM + st.alt), 2) + " km/s"],
    [st.sunlit ? "sun" : "moon", "Lighting", st.sunlit ? "Sunlit" : "In Earth's shadow"], ["globe", "Orbit band", Globe.BANDS[s.band].short]];
  const p = profileCache(s.id), bc = ballistic(p?.orbit?.bstar ?? 0), kp = SW?.kp_24h_max ?? 2, h = s.alt;
  if (h > 1200) return [["down", "Atmospheric drag", "Negligible (too high)"], ["shield", "Storm sensitivity", "None"], ["info", "Why", "Air is too thin above ~1,000 km"]];
  const q = decay(h, bc), nowD = decay(h, bc, stormMult(kp, h)), g3 = decay(h, bc, stormMult(7, h));
  const risk = g3 - q >= 1000 ? ["HIGH", "bad"] : g3 - q >= 300 ? ["ELEVATED", "warn"] : g3 - q >= 100 ? ["WATCH", "info"] : ["LOW", "good"];
  return [["layers", "Air density", rho(h).toExponential(2) + " kg/m³"], ["down", `Altitude loss now (Kp ${fmt(kp, 1)})`, fmt(nowD) + " m/day"],
    ["zap", "During a G3 storm (Kp 7)", fmt(g3) + " m/day"], ["alert", "Storm drag risk", `<span class="tag ${risk[1]}">${risk[0]}</span>`],
    ["clock", "Natural lifetime", fmtLife(decayLife(h, bc) * 365.25)], ["info", "Drag factor Cd·A/m", fmt(bc, 4) + " m²/kg"]];
}
const profileCache = id => { const p = profiles.get(id); return p && p.__v; };
on("select", s => getProfile(s.id).then(p => { profiles.get(s.id).__v = p; lastKey = ""; }).catch(() => {}));
function renderTelemetry() {
  if (!lastTick) return;
  const rows = telemetryRows(lastTick), key = tTab + lastTick.s.id + rows.length, body = $("#t-body");
  $("#t-live").textContent = lastTick.live ? "LIVE" : "SIMULATED";
  $("#t-live").className = "tag " + (lastTick.live ? "good" : "warn");
  if (key !== lastKey) {
    lastKey = key;
    body.innerHTML = rows.map(([ic, k, v]) => `<div>${icon(ic)}<span>${k}</span><b>${v}</b></div>`).join("");
  } else {
    $$("b", body).forEach((b, i) => { if (b.innerHTML !== rows[i][2]) b.innerHTML = rows[i][2]; });
    $$("span:not(.tag)", body).forEach((sp, i) => { if (rows[i] && sp.textContent !== rows[i][1]) sp.textContent = rows[i][1]; });
  }
}
function updateHeroLive(st) {
  $("#h-latlon").textContent = `${fmtLat(st.lat)}, ${fmtLon(st.lon)}`;
  $("#h-sun").innerHTML = st.sunlit ? '<span style="color:var(--warn)">☀ Sunlit</span>' : '<span style="color:#ffb3b8">☾ Eclipse</span>';
  $("#h-alt").textContent = fmt(st.alt, 1) + " km";
  $("#h-vel").textContent = fmt(st.v, 2) + " km/s";
  $("#h-per").textContent = fmt(st.period, 1) + " min";
}
const trackImg = new Image(); trackImg.crossOrigin = "anonymous"; trackImg.src = EARTH_TEX;
function drawTrack() {
  const s = Globe?.selected, c = $("#track-map");
  if (!s || current !== "dashboard" || document.hidden) return;
  const x = c.getContext("2d"), W = c.width, H = c.height;
  if (trackImg.complete && trackImg.naturalWidth) x.drawImage(trackImg, 0, 0, W, H); else { x.fillStyle = "#0a0a0a"; x.fillRect(0, 0, W, H); }
  x.fillStyle = "rgba(0,0,0,.42)"; x.fillRect(0, 0, W, H);
  const P = ([lat, lon]) => [(lon + 180) / 360 * W, (90 - lat) / 180 * H];
  const line = (pts, style, w) => {
    x.strokeStyle = style; x.lineWidth = w; x.beginPath(); let prev = null;
    for (const p of pts) { const [px, py] = P(p); if (prev === null || Math.abs(px - prev) > W / 2) x.moveTo(px, py); else x.lineTo(px, py); prev = px; }
    x.stroke();
  };
  const st = Globe.stateOf(s), per = Math.min(st.period, 1440);
  line(Globe.groundTrack(s, -per, 0, 140), "rgba(255,255,255,.4)", 1.4);
  line(Globe.groundTrack(s, 0, per, 140), "#e50914", 2.2);
  const [px, py] = P([st.lat, st.lon]), r = 6 + 4 * Math.sin(performance.now() / 300);
  x.fillStyle = "rgba(229,9,20,.3)"; x.beginPath(); x.arc(px, py, r + 4, 0, 7); x.fill();
  x.fillStyle = "#fff"; x.beginPath(); x.arc(px, py, 4, 0, 7); x.fill();
}
setInterval(drawTrack, 1000);

/* =====================================================================
   Catalog ready -> select ISS, run dashboard collision scan
   ===================================================================== */
setStep("orbits", "run", "loading");
on("catalog", ({total, shown}) => {
  setSrc("cat", "ok", fmt(total));
  setStep("orbits", "done", `${fmt(total)} objects`);
  Globe.select(25544).catch(() => Globe.select(Globe.find(48274) ? 48274 : 20580).catch(() => {}));
  dashConj();
});
on("catalog-error", e => {
  setSrc("cat", "bad", "offline"); setStep("orbits", "", "failed");
  showError($("#dash-conj"), e, () => location.reload());
  Alerts.add({id: "cat-err", level: "bad", icon: "wifioff", title: "Satellite catalog unavailable", text: esc(e.message)});
});
if (!Globe) { setSrc("cat", "warn", "no 3D"); setStep("orbits", "", "no WebGL"); dashConj(); }

/* =====================================================================
   Close approaches
   ===================================================================== */
const sev = km => km < 5 ? "bad" : km < 10 ? "warn" : "info";
async function dashConj() {
  setStep("conj", "run", "scanning ISS");
  const box = $("#dash-conj");
  try {
    const {target: t, events} = await getJSON("/api/conjunctions?norad=25544&hours=24&threshold=25", {timeout: 120000});
    const close = events.filter(e => e.miss_km < 10);
    setStep("conj", "done", `${events.length} passes`);
    $("#nb-conj").hidden = !close.length; $("#nb-conj").textContent = close.length;
    box.innerHTML = `<p class="note">${events.length ? `<b style="color:var(--text)">${events.length}</b> objects pass within 25 km of the <b style="color:var(--text)">ISS</b> in the next 24 h.` : "No objects come within 25 km of the ISS in the next 24 h."}</p>` +
      (events.length ? `<div class="feed">${events.slice(0, 5).map((e, i) => `<div class="feed-item click" data-locate="${e.norad}" style="animation-delay:${i * 50}ms">
        <div class="fi ${sev(e.miss_km)}">${icon("radar")}</div><div><b>${esc(e.name)}</b><p>${utc(e.time)} UTC · ${fmt(e.rel_speed_kms, 1)} km/s</p></div>
        <span class="tag ${sev(e.miss_km)}">${fmt(e.miss_km, 1)} km</span></div>`).join("")}</div>` : `<div class="empty">${icon("check")}<p>All clear</p></div>`);
    events.slice(0, 3).filter(e => e.miss_km < 10).forEach(e => Alerts.add({
      id: "conj-iss-" + e.norad, level: sev(e.miss_km), icon: "radar", time: e.time,
      title: `ISS close approach: ${fmt(e.miss_km, 1)} km`, text: `${esc(e.name)} passes at ${utc(e.time)} UTC (${fmt(e.rel_speed_kms, 1)} km/s).`,
      go: () => { go("collisions"); $("#c-norad").value = 25544; loadConj(); }}));
    if (!close.length) Alerts.add({id: "conj-iss-ok", level: "good", icon: "radar", title: "ISS: no dangerous passes", text: "Nothing within 10 km in the next 24 hours."});
  } catch (e) {
    setStep("conj", "", "failed");
    showError(box, e, dashConj);
  }
}
$("#conj-try").innerHTML = [["ISS", 25544], ["Tiangong", 48274], ["Hubble", 20580], ["NOAA 20", 43013]]
  .map(([n, id]) => `<button class="chip" type="button" data-norad="${id}">${n} · ${id}</button>`).join("") +
  `<button class="chip" type="button" data-norad="sel">${icon("locate")}Selected satellite</button>`;
$$("#conj-try .chip").forEach(b => b.onclick = () => {
  const id = b.dataset.norad === "sel" ? Globe?.selected?.id : +b.dataset.norad;
  if (!id) { toast("Select a satellite on the globe first.", "warn"); return; }
  $("#c-norad").value = id; loadConj();
});
$("#conj-form").onsubmit = e => { e.preventDefault(); loadConj(); };
async function loadConj() {
  const btn = $("#conj-btn"), out = $("#conj-out");
  const norad = $("#c-norad").value.trim(), hours = +$("#c-hours").value, thr = +$("#c-thr").value;
  if (!/^\d+$/.test(norad)) { showError(out, new AppError("Enter the satellite's NORAD catalog number (digits only).", {code: "BAD_INPUT", hint: "Find it with the search bar, e.g. ISS = 25544."})); return; }
  if (!(hours >= 1 && hours <= 72)) { showError(out, new AppError("Hours ahead must be between 1 and 72.", {code: "OUT_OF_RANGE"})); return; }
  if (!(thr >= 1 && thr <= 200)) { showError(out, new AppError("The alert distance must be between 1 and 200 km.", {code: "OUT_OF_RANGE"})); return; }
  busy(btn, true, "Screening…");
  out.innerHTML = '<div class="loading">Propagating every nearby orbit with SGP4… (10-40 s)</div>';
  try {
    const {target: t, events} = await getJSON(`/api/conjunctions?norad=${norad}&hours=${hours}&threshold=${thr}`, {timeout: 150000});
    const worst = events[0];
    out.innerHTML = `<div class="stats">${stat("Target", esc(t.name))}${stat("Orbit", `${fmt(t.perigee_km)} × ${fmt(t.apogee_km)} km`, "", 1)}
        ${stat("Close passes", events.length, events.some(e => e.miss_km < 5) ? "bad" : events.length ? "warn" : "good", 2)}
        ${stat("Closest", worst ? fmt(worst.miss_km, 2) + " km" : "none", worst ? sev(worst.miss_km) : "good", 3)}</div>` +
      table([
        {h: "Time (UTC)", f: e => utc(e.time)}, {h: "Object", f: e => `<button class="link-btn" data-locate="${e.norad}">${esc(e.name)}</button>`},
        {h: "NORAD", num: 1, f: e => e.norad},
        {h: "Miss distance", num: 1, f: e => `<span class="tag ${sev(e.miss_km)}">${fmt(e.miss_km, 2)} km</span>`},
        {h: "Rel. speed", num: 1, f: e => fmt(e.rel_speed_kms, 2) + " km/s"}], events,
        {empty: `No object comes within ${thr} km of ${esc(t.name)} in the next ${hours} h.`}) +
      '<p class="note mt">Orbit data (TLE) is accurate to about 1 km, so treat this as screening, not an official conjunction warning.</p>';
    runCounters(out);
    const top = events.slice(0, 5), labels = {[t.norad]: `${t.name} (target)`};
    top.slice(0, 3).forEach(e => labels[e.norad] = `${e.name} · ${fmt(e.miss_km, 1)} km`);
    Globe?.showObjects("conj", [t.norad, ...top.map(e => e.norad)], {color: [1, .3, .38], size: .055, labels, orbitIds: [t.norad], cls: "conj"});
    if (events.length && events[0].miss_km < 5) toast(`<b>${esc(t.name)}</b>: ${esc(events[0].name)} passes within ${fmt(events[0].miss_km, 1)} km`, "bad", 6000);
  } catch (e) { showError(out, e, loadConj); }
  busy(btn, false);
}

/* =====================================================================
   Space weather (NASA DONKI) + drag alerts
   ===================================================================== */
let SW = null, swP = null;
const fetchSW = () => swP ??= getJSON("/api/spaceweather", {timeout: 60000}).then(d => (SW = d)).catch(e => { swP = null; throw e; });
const G_CLASS = g => g >= 3 ? "bad" : g >= 1 ? "warn" : "good";
const kpColor = kp => kp >= 7 ? "#ff5c72" : kp >= 6 ? "#ff9a4b" : kp >= 5 ? "#f7b84b" : kp >= 4 ? "#a8d84b" : "#2fd39a";
function gaugeSVG(kp) {
  const seg = [...Array(9)].map((_, i) => {
    const a0 = Math.PI + i * Math.PI / 9 + .02, a1 = Math.PI + (i + 1) * Math.PI / 9 - .02, r = 60;
    const p = a => `${(75 + r * Math.cos(a)).toFixed(1)} ${(75 + r * Math.sin(a)).toFixed(1)}`;
    return `<path d="M${p(a0)} A${r} ${r} 0 0 1 ${p(a1)}" stroke="${kpColor(i + .5)}" stroke-width="10" fill="none" opacity="${i < kp ? 1 : .22}"/>`;
  }).join("");
  return `<svg viewBox="0 0 150 88">${seg}<g class="needle" style="transform:rotate(${Math.min(9, kp) / 9 * 180}deg)">
    <line x1="75" y1="75" x2="24" y2="75" stroke="#fff" stroke-width="3" stroke-linecap="round"/></g>
    <circle cx="75" cy="75" r="6" fill="#fff"/><text x="12" y="88" fill="#808080" font-size="9">0</text><text x="133" y="88" fill="#808080" font-size="9">9</text></svg>`;
}
function renderGauge(d) {
  const g = $("#kp-gauge");
  g.innerHTML = `${gaugeSVG(0)}<div style="min-width:0"><div class="val">Kp ${fmt(d.kp_now, 1)}</div>
    <div class="lvl" style="color:var(--${G_CLASS(d.g_now)})">${esc(d.g_name)}</div>
    <small class="muted">24 h max ${fmt(d.kp_24h_max, 1)} · ${esc(d.kp_source.split(" (")[0])}</small>
    <div class="kv" style="margin-top:8px"><div><span>Storms (30 days)</span><b>${d.storms_30d}</b></div>
    <div><span>CMEs toward Earth (7 d)</span><b>${d.earth_cmes_7d}</b></div><div><span>Drag alerts now</span><b id="g-drag">…</b></div></div></div>`;
  requestAnimationFrame(() => requestAnimationFrame(() => { $(".needle", g).style.transform = `rotate(${Math.min(9, d.kp_now) / 9 * 180}deg)`; }));
  $(".needle", g).style.transform = "rotate(0deg)";
}
async function dashWeather() {
  setStep("drag", "run", "reading NASA");
  try {
    const d = await fetchSW();
    renderGauge(d);
    const errs = Object.values(d.errors || {});
    setSrc("sw", errs.length ? "warn" : "ok", errs.length ? "partial" : `Kp ${fmt(d.kp_now, 1)}`);
    errs.forEach((m, i) => Alerts.add({id: "sw-err" + i, level: "info", icon: "wifioff", title: "Some NASA data is missing", text: esc(m)}));
    Alerts.add(d.g_now ? {id: "sw-now", level: G_CLASS(d.g_now), icon: "zap", title: `Geomagnetic storm: ${d.g_name}`,
                          text: `Kp reached ${fmt(d.kp_24h_max, 1)} in the last 24 h. Low satellites face extra drag.`, go: () => go("weather")}
                       : {id: "sw-now", level: "good", icon: "sun", title: "Space weather is quiet", text: `Kp ${fmt(d.kp_now, 1)} now (${esc(d.kp_source.split(" (")[0])}). No storm drag.`, go: () => go("weather")});
    const s = d.storms[0];
    if (s) Alerts.add({id: "sw-last", level: "info", icon: "zap", time: s.start, title: `Last NASA-reported storm: ${s.level}`, text: `Peak Kp ${fmt(s.max_kp, 1)}, started ${utc(s.start)} UTC.`, go: () => go("weather")});
    d.cmes.filter(c => c.earth_directed).slice(0, 2).forEach(c => Alerts.add({id: "cme-" + c.id, level: "warn", icon: "sun", time: c.start,
      title: "Earth-directed solar eruption (CME)", text: c.earth_arrival ? `Predicted arrival ${utc(c.earth_arrival)} UTC${c.speed_kms ? ` · ${fmt(c.speed_kms)} km/s` : ""}.` : "NASA models show it may reach Earth.", go: () => go("weather")}));
    const dr = await getJSON("/api/drag?kp=now", {timeout: 60000});
    const n = dr.total_flagged, hi = dr.counts.HIGH + dr.counts.ELEVATED;
    $("#g-drag").textContent = hi; $("#nb-sw").hidden = !hi; $("#nb-sw").textContent = hi;
    setStep("drag", "done", hi ? `${hi} at risk` : n ? `${n} to watch` : "all clear");
    if (hi) Alerts.add({id: "drag-now", level: dr.counts.HIGH ? "bad" : "warn", icon: "down", title: `${hi} low satellites at drag risk`,
                       text: `${dr.counts.HIGH} high, ${dr.counts.ELEVATED} elevated at Kp ${fmt(dr.kp, 1)}.`, go: () => go("weather")});
  } catch (e) {
    setSrc("sw", "bad", "offline"); setStep("drag", "", "failed");
    showError($("#kp-gauge"), e, () => { swP = null; dashWeather(); });
  }
}

let dragKp = null, dragShowAll = false;
async function loadWeatherView() {
  try {
    const d = await fetchSW();
    setStats("#sw-stats",
      stat("Kp index now", `${fmt(d.kp_now, 1)}`, G_CLASS(g(d.kp_now))) + stat("Storm level (24 h)", esc(d.g_name), G_CLASS(d.g_now), 1) +
      stat("Storms, last 30 days", d.storms_30d, d.storms_30d ? "warn" : "good", 2) + stat("CMEs toward Earth (7 d)", d.earth_cmes_7d, d.earth_cmes_7d ? "warn" : "", 3) +
      stat("Strong flares M/X (7 d)", d.strong_flares_7d, d.strong_flares_7d ? "warn" : "", 4));
    const last = d.storms[0];
    const presets = [["Now", d.kp_24h_max]];
    if (last) presets.push([`Last storm ${last.start.slice(5, 10)} (${last.level.split(" ")[0]})`, last.max_kp]);
    presets.push(["G3 strong", 7], ["G5 extreme (May 2024)", 9]);
    $("#kp-presets").innerHTML = presets.map(([n, k]) => `<button class="chip" data-kp="${k}">${esc(n)} · Kp ${fmt(k, 1)}</button>`).join("");
    $$("#kp-presets .chip").forEach(b => b.onclick = () => { $("#kp").value = b.dataset.kp; loadDrag(+b.dataset.kp); });
    const start = d.kp_24h_max >= 5 ? d.kp_24h_max : last ? last.max_kp : 6;
    $("#kp").value = start;
    loadDrag(start);
    renderKpChart(d); renderEvents(d);
    if (Object.keys(d.errors).length) $("#sw-events").insertAdjacentHTML("afterbegin", `<div class="err soft">${icon("alert")}<div><b>Some NASA feeds are unavailable</b><p>${Object.values(d.errors).map(esc).join("<br>")}</p></div></div>`);
  } catch (e) {
    showError($("#drag-sum"), e, () => { swP = null; loadWeatherView(); });
    $("#drag-table").innerHTML = ""; $("#sw-events").innerHTML = "";
  }
}
const g = kp => kp < 5 ? 0 : Math.min(5, Math.floor(kp) - 4);
const G_NAMES = ["Quiet", "G1 Minor", "G2 Moderate", "G3 Strong", "G4 Severe", "G5 Extreme"];
$("#kp").addEventListener("input", e => showKp(+e.target.value));
$("#kp").addEventListener("change", e => loadDrag(+e.target.value));
function showKp(kp) { $("#kp-val").innerHTML = `Kp ${fmt(kp, 1)}<small style="color:var(--${G_CLASS(g(kp))})">${G_NAMES[g(kp)]}</small>`; }
async function loadDrag(kp) {
  dragKp = kp; showKp(kp);
  const sum = $("#drag-sum"), tbl = $("#drag-table");
  sum.innerHTML = '<div class="loading">Estimating drag for every low-orbit satellite…</div>';
  try {
    const d = await getJSON(`/api/drag?kp=${kp}`, {timeout: 60000});
    if (dragKp !== kp) return;
    const nowKp = SW?.kp_24h_max;
    const sim = nowKp != null && Math.abs(nowKp - kp) > .2;
    sum.innerHTML = (sim ? `<div class="err soft" style="animation:none;margin-bottom:12px"><div class="err-ic">${icon("info")}</div><div><b>What-if simulation</b><p>Right now Kp is ${fmt(nowKp, 1)} (${esc(SW.g_name)}). This shows what a Kp ${fmt(kp, 1)} storm would do to today's satellites.</p></div></div>` : "") +
      (d.total_flagged
        ? `<p style="margin:0 0 10px"><b style="font-size:20px">${fmt(d.counts.HIGH + d.counts.ELEVATED)}</b> of ${fmt(d.screened)} low-orbit satellites at real risk, ${fmt(d.counts.WATCH)} more to watch. Air at 450 km becomes <b>${fmt(d.multiplier_450km, 1)}×</b> denser.</p>
           <div class="chips"><span class="tag bad">HIGH ${fmt(d.counts.HIGH)}</span><span class="tag warn">ELEVATED ${fmt(d.counts.ELEVATED)}</span><span class="tag info">WATCH ${fmt(d.counts.WATCH)}</span></div>`
        : `<div class="empty">${icon("check")}<p><b>No satellites at extra risk</b> at Kp ${fmt(kp, 1)}. The upper atmosphere is calm.</p></div>`);
    $("#drag-n").textContent = fmt(d.total_flagged);
    const LV = {HIGH: "bad", ELEVATED: "warn", WATCH: "info"};
    const rows = dragShowAll ? d.flagged.slice(0, 150) : d.flagged.slice(0, 25);
    tbl.innerHTML = table([
      {h: "Satellite", f: r => `<button class="link-btn" data-locate="${r.norad}">${esc(r.name)}</button>`},
      {h: "Altitude", num: 1, f: r => fmt(r.alt_km) + " km"},
      {h: "Quiet loss", num: 1, f: r => fmt(r.quiet_m_day) + " m/d"},
      {h: "Storm loss", num: 1, f: r => fmt(r.storm_m_day) + " m/d"},
      {h: "Extra from storm", num: 1, f: r => `<b>+${fmt(r.extra_m_day)}</b> m/d`},
      {h: "Natural lifetime", num: 1, f: r => r.days_to_reentry_est == null ? "re-entering" : fmtLife(r.days_to_reentry_est)},
      {h: "Risk", f: r => `<span class="tag ${LV[r.level]}">${r.level}</span>`}], rows, {empty: "Nothing flagged at this storm strength."}) +
      (d.flagged.length > 25 ? `<div class="btns mt"><button class="btn ghost sm" id="drag-more">${dragShowAll ? "Show top 25" : `Show top ${Math.min(150, d.flagged.length)}`}</button></div>` : "") +
      '<p class="note mt">Simplified model: exponential atmosphere × storm multiplier, drag factor from each TLE\'s B*. Satellites with thrusters (e.g. Starlink, ISS) can re-boost.</p>';
    $("#drag-more")?.addEventListener("click", () => { dragShowAll = !dragShowAll; loadDrag(kp); });
    const top = d.flagged.slice(0, 150), lv = Object.fromEntries(top.map(r => [r.norad, r.level]));
    if (top.length) Globe?.showObjects("drag", top.map(r => r.norad), {size: .04, cls: "drag",
      colorOf: s => lv[s.id] === "HIGH" ? [1, .3, .4] : lv[s.id] === "ELEVATED" ? [1, .7, .25] : [.95, .9, .4],
      labels: Object.fromEntries(top.slice(0, 3).map(r => [r.norad, `${r.name} · +${fmt(r.extra_m_day)} m/day`]))});
    else Globe?.clear("drag");
    renderDragChart(d);
  } catch (e) { showError(sum, e, () => loadDrag(kp)); tbl.innerHTML = ""; }
}
function renderKpChart(d) {
  if (!window.Chart) return;
  const pts = d.kp_series.slice(-120);
  charts.kp?.destroy();
  charts.kp = new Chart($("#kp-chart"), {type: "bar",
    data: {labels: pts.map(p => p.t.slice(5, 13).replace("T", " ") + "h"),
           datasets: [{label: "Kp", data: pts.map(p => p.kp), backgroundColor: pts.map(p => kpColor(p.kp)), borderRadius: 3, maxBarThickness: 14}]},
    options: {maintainAspectRatio: false, plugins: {legend: {display: false}, tooltip: {callbacks: {afterLabel: c => pts[c.dataIndex].src}}},
      animation: {duration: REDUCED ? 0 : 900}, scales: {y: {min: 0, max: 9, ticks: {stepSize: 1}, title: {display: true, text: "Kp"}}, x: {ticks: {maxTicksLimit: 8, maxRotation: 0}}}}});
}
function renderDragChart(d) {
  if (!window.Chart) return;
  charts.drag?.destroy();
  charts.drag = new Chart($("#drag-chart"), {type: "line",
    data: {labels: d.curve.alt, datasets: [
      {label: "Quiet sun", data: d.curve.quiet, borderColor: "#3ea6ff", backgroundColor: "rgba(62,166,255,.1)", fill: true, pointRadius: 0, tension: .3},
      {label: `Storm (Kp ${fmt(d.kp, 1)})`, data: d.curve.storm, borderColor: "#ff5c72", backgroundColor: "rgba(255,92,114,.1)", fill: true, pointRadius: 0, tension: .3}]},
    options: {maintainAspectRatio: false, interaction: {mode: "index", intersect: false}, animation: {duration: REDUCED ? 0 : 900},
      plugins: {tooltip: {callbacks: {title: c => `${c[0].label} km`, label: c => `${c.dataset.label}: ${fmt(c.raw)} m/day`}}},
      scales: {y: {type: "logarithmic", title: {display: true, text: "metres lost per day"}}, x: {title: {display: true, text: "Altitude (km)"}, ticks: {maxTicksLimit: 8}}}}});
}
function renderEvents(d) {
  const ev = [
    ...d.storms.map(s => ({t: s.start, level: G_CLASS(g(s.max_kp)), ic: "zap", title: `Geomagnetic storm · ${s.level}`, text: `Peak Kp ${fmt(s.max_kp, 1)}`, link: s.link})),
    ...d.cmes.map(c => ({t: c.start, level: c.earth_directed ? "warn" : "info", ic: "sun", title: `Coronal mass ejection${c.earth_directed ? " · Earth-directed" : ""}`,
                         text: `${c.speed_kms ? fmt(c.speed_kms) + " km/s · " : ""}${c.earth_arrival ? "arrival " + utc(c.earth_arrival) + " UTC · " : ""}${esc(c.note.slice(0, 140))}`, link: c.link})),
    ...d.flares.map(f => ({t: f.peak, level: f.strong ? "warn" : "info", ic: "sun", title: `Solar flare · class ${esc(f.class)}`, text: f.region ? `Active region ${f.region}` : "", link: f.link})),
  ].sort((a, b) => String(b.t).localeCompare(String(a.t))).slice(0, 25);
  $("#sw-events").innerHTML = ev.length ? ev.map((e, i) => `<div class="feed-item" style="animation-delay:${i * 30}ms"><div class="fi ${e.level}">${icon(e.ic)}</div>
      <div><b>${e.title}</b><p>${e.text}${e.link ? ` · <a href="${esc(e.link)}" target="_blank" rel="noopener">NASA DONKI ↗</a>` : ""}</p></div><time>${esc(utc(e.t))}</time></div>`).join("")
    : `<div class="empty">${icon("check")}<p>No storms, CMEs or flares reported recently.</p></div>`;
}

/* =====================================================================
   Orbit changes
   ===================================================================== */
const typeTag = {"REENTRY-RISK": "bad", "DECAYING": "warn", "MANEUVER-UP": "info", "MANEUVER-DOWN": "info", "PLANE-CHANGE": "good"};
$("#dist-btn").onclick = () => loadDisturb();
async function loadDisturb() {
  const btn = $("#dist-btn"); busy(btn, true, "Checking…");
  $("#dist-out").innerHTML = '<div class="loading">Comparing ~18,000 orbits…</div>';
  try {
    const [cat, res] = await Promise.all([getJSON("/api/catalog"), getJSON("/api/disturbances", {timeout: 90000})]);
    const count = t => res.events.filter(e => e.type === t).length;
    setStats("#dist-stats", stat("Objects tracked", cat.count) + stat("Compared with baseline", res.compared, "", 1) +
      stat("Re-entry risk", count("REENTRY-RISK"), count("REENTRY-RISK") ? "bad" : "good", 2) +
      stat("Maneuvers detected", count("MANEUVER-UP") + count("MANEUVER-DOWN") + count("PLANE-CHANGE"), "", 3));
    const note = res.baseline_existed ? "" : `<div class="err soft" style="animation:none;margin-bottom:12px"><div class="err-ic">${icon("info")}</div><div><b>First run</b><p>No earlier snapshot to compare with yet, so only re-entry risks are shown. Run again later to catch maneuvers and decay.</p></div></div>`;
    $("#dist-out").innerHTML = note + table([
      {h: "Type", f: e => `<span class="tag ${typeTag[e.type] || "info"}">${e.type}</span>`},
      {h: "NORAD", num: 1, f: e => e.norad}, {h: "Name", f: e => `<button class="link-btn" data-locate="${e.norad}">${esc(e.name)}</button>`},
      {h: "Detail", f: e => esc(e.detail)}], res.events, {empty: "No orbit changes detected."});
    const ids = [...new Set(res.events.map(e => e.norad))].slice(0, 25);
    const labels = Object.fromEntries(res.events.slice(0, 6).map(e => [e.norad, `${e.name} · ${e.type.toLowerCase()}`]));
    if (ids.length) Globe?.showObjects("disturb", ids, {color: [1, .75, .2], size: .05, labels, cls: "reentry"});
  } catch (e) { showError($("#dist-out"), e, loadDisturb); }
  busy(btn, false);
}

/* =====================================================================
   Asteroids
   ===================================================================== */
let AST = null;
async function fetchAsteroids() {
  try {
    AST = await getJSON("/api/asteroids", {timeout: 60000});
    const {neows, jpl, neows_error} = AST;
    setSrc("neo", neows_error ? (jpl.length ? "warn" : "bad") : "ok", neows_error ? "limited" : `${neows.length} NEOs`);
    const haz = neows.filter(n => n.hazardous), inside = neows.filter(n => n.miss_ld < 1);
    if (inside.length) Alerts.add({id: "ast-moon", level: "warn", icon: "comet", title: `${inside.length} asteroid${inside.length > 1 ? "s" : ""} inside the Moon's orbit`,
      text: inside.slice(0, 2).map(n => `${esc(n.name)} at ${fmt(n.miss_ld, 2)} LD`).join(", ") + " this week.", go: () => go("asteroids")});
    if (haz.length) Alerts.add({id: "ast-pha", level: "info", icon: "comet", title: `${haz.length} potentially hazardous asteroids pass this week`,
      text: `Closest: ${esc(haz.sort((a, b) => a.miss_ld - b.miss_ld)[0].name)}. None on a collision course.`, go: () => go("asteroids")});
    if (neows_error) Alerts.add({id: "ast-err", level: "info", icon: "wifioff", title: "NASA NeoWs limited", text: esc(neows_error)});
    if (visited.asteroids) renderAsteroids();
  } catch (e) {
    setSrc("neo", "bad", "offline");
    AST = {error: e};
    if (visited.asteroids) renderAsteroids();
  }
}
function renderAsteroids() {
  if (!AST) { $("#ast-table").innerHTML = '<div class="loading">Loading NASA data…</div>'; return; }
  if (AST.error) { showError($("#ast-table"), AST.error, async () => { AST = null; renderAsteroids(); await fetchAsteroids(); renderAsteroids(); }); $("#cad-table").innerHTML = ""; return; }
  const {neows, jpl, neows_error, jpl_error} = AST;
  Flyby?.set(neows.length ? neows : jpl);
  const closest = [...jpl].sort((a, b) => a.miss_km - b.miss_km)[0];
  setStats("#ast-stats", stat("Asteroids this week", neows.length) + stat("Potentially hazardous", neows.filter(n => n.hazardous).length, "warn", 1) +
    stat("Inside Moon's orbit", neows.filter(n => n.miss_ld < 1).length, "", 2) + stat("Closest in 60 days", closest ? `${esc(closest.name)} · ${fmt(closest.miss_ld, 2)} LD` : "–", "", 3));
  const flags = n => (n.hazardous ? '<span class="tag bad">PHA</span> ' : "") + (n.miss_ld < 1 ? '<span class="tag warn">inside Moon orbit</span>' : "");
  const cols = [{h: "Name", f: n => esc(n.name)}, {h: "Date (UTC)", f: n => esc(n.date)}, {h: "Diameter", num: 1, f: n => fmt(n.diameter_m) + " m"},
    {h: "Miss (LD)", num: 1, f: n => fmt(n.miss_ld, 2)}, {h: "Miss (km)", num: 1, f: n => fmt(n.miss_km)}, {h: "Speed", num: 1, f: n => fmt(n.velocity_kms, 2) + " km/s"},
    {h: "Risk score", num: 1, f: n => fmt(n.risk, 2)}, {h: "Flags", f: flags}];
  if (neows_error) showError($("#ast-table"), new AppError(neows_error + " The 60-day JPL list below still works.", {code: "RATE_LIMITED"}), null, true);
  else $("#ast-table").innerHTML = table(cols, neows.slice(0, 15));
  if (jpl_error) showError($("#cad-table"), new AppError(jpl_error, {code: "UPSTREAM_ERROR"})); else $("#cad-table").innerHTML = table(cols.slice(0, 7), jpl.slice(0, 15));
  if (!window.Chart || !neows.length) return;
  const pts = arr => arr.map(n => ({x: n.miss_ld, y: n.diameter_m, name: n.name}));
  const maxLd = Math.max(...neows.map(n => n.miss_ld), 2);
  charts.ast?.destroy();
  charts.ast = new Chart($("#ast-chart"), {type: "scatter",
    data: {datasets: [
      {label: "Not hazardous", data: pts(neows.filter(n => !n.hazardous)), backgroundColor: "rgba(62,166,255,.85)", pointRadius: 5, pointHoverRadius: 9},
      {label: "Potentially hazardous", data: pts(neows.filter(n => n.hazardous)), backgroundColor: "#ff5c72", pointRadius: 7, pointHoverRadius: 11},
      {label: "Moon distance", type: "line", data: [{x: 1, y: 1}, {x: 1, y: 5000}], borderColor: "#b3b3b3", borderDash: [6, 4], pointRadius: 0}]},
    options: {maintainAspectRatio: false, animation: {duration: REDUCED ? 0 : 1200, easing: "easeOutQuart", delay: c => c.type === "data" ? c.dataIndex * 30 : 0},
      scales: {x: {type: "logarithmic", min: .5, max: maxLd * 1.5, title: {display: true, text: "Miss distance (lunar distances)"}},
               y: {type: "logarithmic", title: {display: true, text: "Estimated diameter (m)"}}},
      plugins: {tooltip: {callbacks: {label: c => c.raw.name ? `${c.raw.name}: ${fmt(c.raw.y)} m at ${fmt(c.raw.x, 1)} LD` : "Moon"}}}}});
}
const Flyby = (() => {
  const c = $("#flyby"), x = c.getContext("2d");
  let W = 0, H = 0, objs = [], maxLd = 100, t = 0;
  function resize() { const dpr = Math.min(devicePixelRatio || 1, 2); W = c.clientWidth; H = c.clientHeight; c.width = W * dpr; c.height = H * dpr; x.setTransform(dpr, 0, 0, dpr, 0, 0); }
  new ResizeObserver(resize).observe(c); resize();
  const R = () => Math.min(W, H) / 2 - 24;
  const scale = ld => 26 + (R() - 26) * Math.log10(1 + ld * 3) / Math.log10(1 + maxLd * 3);
  function set(neos) {
    const list = [...neos].sort((a, b) => a.miss_ld - b.miss_ld).slice(0, 16);
    maxLd = Math.max(2, ...list.map(n => n.miss_ld)) * 1.1;
    objs = list.map((n, i) => ({...n, ang: (i * 2.399963) % (Math.PI * 2), phase: (i * .618) % 1, dir: i % 2 ? 1 : -1,
      spd: .025 + n.velocity_kms / 900, size: 1.6 + Math.log10(Math.max(n.diameter_m || 5, 5)) * 1.1}));
  }
  function ring(r, dash, color, label) {
    x.setLineDash(dash); x.strokeStyle = color; x.lineWidth = 1; x.beginPath(); x.arc(W / 2, H / 2, r, 0, Math.PI * 2); x.stroke(); x.setLineDash([]);
    if (label) { x.fillStyle = "rgba(179,179,179,.8)"; x.font = "10px JetBrains Mono, monospace"; x.fillText(label, W / 2 + r * .707 + 4, H / 2 - r * .707); }
  }
  let last = performance.now(), vis = false;
  new IntersectionObserver(e => vis = e[0].isIntersecting).observe(c);
  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(.05, (now - last) / 1000); last = now;
    if (!vis || !W) return;
    t += dt; x.clearRect(0, 0, W, H);
    const cx = W / 2, cy = H / 2;
    for (const ld of [10, 50, 100, 200]) if (ld < maxLd) ring(scale(ld), [2, 6], "rgba(128,128,128,.22)", ld + " LD");
    ring(scale(1), [5, 5], "rgba(200,210,255,.45)", "Moon");
    const ma = t * .25, mr = scale(1);
    x.fillStyle = "#cfd6e6"; x.beginPath(); x.arc(cx + Math.cos(ma) * mr, cy + Math.sin(ma) * mr, 3.2, 0, 7); x.fill();
    const gr = x.createRadialGradient(cx, cy, 2, cx, cy, 26);
    gr.addColorStop(0, "#9fd3ff"); gr.addColorStop(.35, "#2f7bff"); gr.addColorStop(.6, "rgba(47,123,255,.25)"); gr.addColorStop(1, "rgba(47,123,255,0)");
    x.fillStyle = gr; x.beginPath(); x.arc(cx, cy, 26, 0, 7); x.fill();
    x.fillStyle = "#1f5fd6"; x.beginPath(); x.arc(cx, cy, 9, 0, 7); x.fill();
    if (!objs.length) { x.fillStyle = "#b3b3b3"; x.font = "13px Inter, sans-serif"; x.textAlign = "center"; x.fillText("Loading NASA asteroid data…", cx, cy + 50); x.textAlign = "left"; return; }
    const L = R() * 1.6;
    for (const o of objs) {
      const s = ((t * o.spd + o.phase) % 1) * 2 - 1, r = scale(o.miss_ld), nx = Math.cos(o.ang), ny = Math.sin(o.ang);
      const tx = -ny * o.dir, ty = nx * o.dir, px = cx + nx * r + tx * s * L, py = cy + ny * r + ty * s * L;
      const tl = 26 + o.velocity_kms * 1.5, tr = x.createLinearGradient(px, py, px - tx * tl, py - ty * tl);
      const col = o.hazardous ? "255,92,114" : o.miss_ld < 5 ? "247,184,75" : "155,190,255";
      tr.addColorStop(0, `rgba(${col},.85)`); tr.addColorStop(1, `rgba(${col},0)`);
      x.strokeStyle = tr; x.lineWidth = o.size; x.lineCap = "round"; x.beginPath(); x.moveTo(px, py); x.lineTo(px - tx * tl, py - ty * tl); x.stroke();
      x.fillStyle = `rgb(${col})`; x.shadowColor = `rgb(${col})`; x.shadowBlur = 12; x.beginPath(); x.arc(px, py, o.size, 0, 7); x.fill(); x.shadowBlur = 0;
      if (Math.abs(s) < .18) {
        const a = 1 - Math.abs(s) / .18;
        x.strokeStyle = `rgba(${col},${a * .5})`; x.setLineDash([2, 3]); x.lineWidth = 1; x.beginPath(); x.moveTo(cx, cy); x.lineTo(px, py); x.stroke(); x.setLineDash([]);
        x.fillStyle = `rgba(231,238,252,${a})`; x.font = "11px JetBrains Mono, monospace";
        x.fillText(`${o.name.replace(/[()]/g, "")}  ${fmt(o.miss_ld, 1)} LD · ${fmt(o.diameter_m)} m`, Math.min(px + 8, W - 220), py - 8);
      }
    }
  }
  requestAnimationFrame(frame);
  return {set};
})();

/* =====================================================================
   Best-orbit planner
   ===================================================================== */
$("#opt-form").onsubmit = e => { e.preventDefault(); loadOpt(); };

/* optional "your own orbit" inputs */
const ssoInc = altKm => {                    // sun-synchronous inclination (deg) or null if impossible
  const a = RE_KM + altKm, n = Math.sqrt(398600.4418 / a ** 3);
  const c = -(2 * Math.PI / (365.2422 * 86400)) / (1.5 * n * 1.08262668e-3 * (RE_KM / a) ** 2);
  return Math.abs(c) <= 1 ? Math.acos(c) * 180 / Math.PI : null;
};
function syncOwnOrbit() {
  const active = !!($("#o-alt").value.trim() || $("#o-inc").value.trim());
  $("#own-orbit").classList.toggle("active", active);
  $("#own-clear").hidden = !active;
  $$("#own-orbit [data-alt]").forEach(c => c.classList.toggle("on", c.dataset.alt === $("#o-alt").value.trim()));
  $$("#own-orbit [data-inc]").forEach(c => c.classList.toggle("on", c.dataset.inc === $("#o-inc").value.trim()));
}
$("#o-alt").addEventListener("input", syncOwnOrbit);
$("#o-inc").addEventListener("input", syncOwnOrbit);
$$("#own-orbit [data-alt]").forEach(c => c.onclick = () => { $("#o-alt").value = c.dataset.alt; syncOwnOrbit(); });
$$("#own-orbit [data-inc]").forEach(c => c.onclick = () => {
  if (c.dataset.inc !== "sso") { $("#o-inc").value = c.dataset.inc; syncOwnOrbit(); return; }
  const alt = +$("#o-alt").value;
  if (!alt) {
    $("#o-inc").value = ""; $("#o-mission").value = "earth-observation";
    toast("Sun-synchronous inclination is picked automatically for Earth-observation missions. Set an altitude to see the exact angle.", "info", 5000);
  } else {
    const i = ssoInc(alt);
    if (i == null) { toast(`Sun-synchronous orbits are impossible at ${fmt(alt)} km (only below ~5,970 km).`, "warn", 5000); return; }
    $("#o-inc").value = i.toFixed(2);
  }
  syncOwnOrbit();
});
$("#own-clear").onclick = () => { $("#o-alt").value = ""; $("#o-inc").value = ""; syncOwnOrbit(); };

async function loadOpt() {
  const btn = $("#opt-btn"), out = $("#opt-out");
  const lat = $("#o-lat").value.trim(), years = +$("#o-years").value;
  const altS = $("#o-alt").value.trim(), incS = $("#o-inc").value.trim();
  const bad = (msg, hint) => { showError(out, new AppError(msg, {code: "OUT_OF_RANGE", hint})); return true; };
  if (lat && !(Math.abs(+lat) <= 90) && bad("Latitude must be between -90 and 90 degrees.")) return;
  if (!(years >= 1 && years <= 30) && bad("Mission life must be between 1 and 30 years.")) return;
  if (altS && !(+altS >= 160 && +altS <= 40000) &&
      bad("Altitude must be between 160 and 40,000 km.", "Below ~160 km a satellite re-enters within hours; GEO is 35,786 km.")) return;
  if (incS && !(+incS >= 0 && +incS <= 180) &&
      bad("Inclination must be between 0° and 180°.", "0° = over the equator, 90° = over the poles, above 90° = retrograde.")) return;
  const own = !!(altS || incS);
  busy(btn, true, "Scoring…"); setStep("plan", "run", "scoring");
  out.innerHTML = `<div class="loading">${own ? "Scoring your orbit against" : "Scoring candidate orbits against"} the real catalog…</div>`;
  try {
    const q = new URLSearchParams({mission: $("#o-mission").value, site: $("#o-site").value, years});
    if (lat) q.set("lat", lat);
    if (altS) q.set("alt", altS);
    if (incS) q.set("inc", incS);
    const r = await getJSON("/api/optimize?" + q, {timeout: 90000});
    const b = r.best[0];
    if (!b) throw new AppError("No orbit fits these constraints.", {code: "BAD_INPUT", hint: "Try a longer mission life, another launch site, or clear your own altitude/inclination."});
    const sc = b.scores, cu = r.custom;
    const sso = ssoInc(b.alt_km), isSso = sso != null && Math.abs(b.inc_deg - sso) < .5;
    const title = !cu ? "Recommended orbit" : altS && incS ? "Your orbit" : altS ? `Best inclination at ${fmt(+altS)} km` : `Best altitude at ${fmt(+incS, 1)}°`;
    const life = y => y >= 1000 ? "permanent" : y < 1 ? fmtLife(y * 365.25) : fmt(y, 1) + " yr";
    let html = "";
    if (cu) {
      const o = cu.overall_best, gap = o.score - b.score;
      const verdict = cu.rank === 1 ? ["good", "Top choice"] : gap <= 3 ? ["good", "Close to the best"] : gap <= 10 ? ["warn", "Good, but better exists"] : ["bad", "Much better orbits exist"];
      html += `<div class="cmp"><div><div class="rank">#${fmt(cu.rank)} <span class="muted" style="font-size:13px;font-weight:500">of ${fmt(cu.of)} orbits</span></div>
          <span class="tag ${verdict[0]}">${verdict[1]}</span></div>
        <div class="muted">Best overall: <b style="color:var(--text)">${fmt(o.alt_km)} km · ${fmt(o.inc_deg, 1)}°</b> (score ${fmt(o.score, 1)})<br>Your pick scores <b style="color:var(--text)">${fmt(b.score, 1)}</b>${gap > 0 ? `, ${fmt(gap, 1)} lower` : ""}</div>
        ${cu.rank > 1 ? `<button class="btn ghost sm" type="button" id="use-best">${icon("check")}Use best instead</button>` : ""}</div>` +
        (cu.note ? `<div class="err soft" style="animation:none;margin-bottom:14px"><div class="err-ic">${icon("info")}</div><div><b>Heads-up</b><p>${esc(cu.note)}</p></div></div>` : "");
    }
    html += `<div class="reco"><div><h4>${icon("check")} ${esc(title)}</h4>
        <div class="orbit">${fmt(b.alt_km)} km · ${fmt(b.inc_deg, 1)}°${isSso ? " sun-synchronous" : b.alt_km > 30000 && b.inc_deg < 5 ? " geostationary" : ""}</div>
        <p class="muted" style="margin:4px 0 0">Period ${b.period_min > 600 ? fmt(b.period_min / 60, 1) + " h" : fmt(b.period_min, 1) + " min"} · lifetime ≈ ${life(b.lifetime_yr)} · launch Δv ≈ ${fmt(b.dv_kms, 2)} km/s · score <b style="color:var(--text)">${fmt(b.score, 1)}</b></p>
        <ul>${b.why.map(w => `<li>${icon("check")}<span>${esc(w)}</span></li>`).join("")}</ul></div>
      <div class="bars">${[["Safety", sc.safety], ["Lifetime", sc.lifetime], ["Coverage", sc.coverage], ["Launch cost", sc.launch_cost]]
        .map(([n, v]) => `<div class="bar"><span>${n}</span><div class="tr"><i data-w="${v.toFixed(0)}"></i></div><b>${fmt(v)}</b></div>`).join("")}</div></div>`;
    if (r.best.length > 1 || !cu) {
      if (cu) html += `<p class="note">${altS ? "Other inclinations at this altitude:" : "Other altitudes at this inclination:"}</p>`;
      html += table([
        {h: "#", f: (x, i) => i + 1}, {h: "Altitude", num: 1, f: x => fmt(x.alt_km) + " km"}, {h: "Inclination", num: 1, f: x => fmt(x.inc_deg, 1) + "°"},
        {h: "Safety", num: 1, f: x => fmt(x.scores.safety)}, {h: "Lifetime", num: 1, f: x => life(x.lifetime_yr)},
        {h: "Coverage", num: 1, f: x => "±" + fmt(x.coverage_lat_deg) + "°"}, {h: "Δv", num: 1, f: x => fmt(x.dv_kms, 2) + " km/s"},
        {h: "Score", num: 1, f: x => `<b>${fmt(x.score, 1)}</b>`}], r.best, {top: true});
    }
    if (r.geo && !(cu && b.alt_km > 30000)) html += `<p class="note mt">Alternative: GEO at ${fmt(r.geo.alt_km)} km, 0°, Δv ≈ ${fmt(r.geo.dv_kms, 2)} km/s. Much more expensive, but 3 satellites cover most of the globe.</p>`;
    out.innerHTML = html;
    $("#use-best")?.addEventListener("click", () => { $("#o-alt").value = ""; $("#o-inc").value = ""; syncOwnOrbit(); loadOpt(); });
    requestAnimationFrame(() => $$(".bar i", out).forEach(i => i.style.width = i.dataset.w + "%"));
    Globe?.showPlanned(b.alt_km, b.inc_deg, isSso ? "earth-observation" : r.mission);
    setStep("plan", "done", `${fmt(b.alt_km)} km`);
    Alerts.add({id: "plan", level: "good", icon: "rocket", time: new Date().toISOString(), title: `${cu ? "Your orbit" : "Best orbit"}: ${fmt(b.alt_km)} km at ${fmt(b.inc_deg, 1)}°`,
                text: `${esc($("#o-mission").selectedOptions[0].text)} mission, score ${fmt(b.score, 1)}${cu ? `, rank #${cu.rank}` : ""}.`, go: () => go("planner")});
    $("#opt-chart-card").hidden = false;
    $("#opt-chart-card .note").innerHTML = "Tracked objects per 10⁹ km³ (active satellites + major debris clouds). Green = " +
      (cu ? "your orbit" : "recommended") + ", amber = runners-up." +
      (b.alt_km > 2000 ? ` <b>Your altitude (${fmt(b.alt_km)} km) is above this chart's 2,000 km range, where tracked objects are far sparser.</b>` : "");
    if (!window.Chart) return;
    charts.opt?.destroy();
    const keep = r.density.alt.map((a, i) => [a, r.density.per_1e9_km3[i]]).filter(([a]) => a <= 2000);
    const best = r.best.map(x => x.alt_km);
    charts.opt = new Chart($("#opt-chart"), {type: "bar",
      data: {labels: keep.map(([a]) => Math.round(a)), datasets: [{label: "Objects per 10⁹ km³", data: keep.map(([, v]) => v), borderRadius: 3,
        backgroundColor: keep.map(([a]) => Math.abs(b.alt_km - a) <= 12.5 ? "#2fd39a" : best.some(x => Math.abs(x - a) <= 12.5) ? "#f7b84b" : "rgba(62,166,255,.7)")}]},
      options: {maintainAspectRatio: false, plugins: {legend: {display: false}},
        animation: {duration: REDUCED ? 0 : 1000, easing: "easeOutQuart", delay: c => c.type === "data" ? c.dataIndex * 10 : 0},
        scales: {y: {type: "logarithmic", title: {display: true, text: "Objects per 10⁹ km³"}}, x: {title: {display: true, text: "Altitude (km)"}, ticks: {maxTicksLimit: 14}}}}});
  } catch (e) { showError(out, e, loadOpt); setStep("plan", "", "failed"); }
  busy(btn, false);
}

/* =====================================================================
   Boot
   ===================================================================== */
Alerts.render();
dashWeather();
fetchAsteroids();
const startView = location.hash.slice(1);
if (startView) go(startView); else visited.dashboard = true;
