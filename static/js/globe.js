/* OrbitGuard 3D globe: real satellites propagated in the browser (Kepler + J2 secular drift from TLE elements). */
"use strict";
const EARTH_TEX = "https://unpkg.com/three-globe@2.31.0/example/img/earth-blue-marble.jpg";

const Globe = (() => {
  const wrapEl = $("#globe-wrap"), host = $("#globe"), labelsEl = $("#globe-labels"), tip = $("#g-tip");
  const fail = msg => { host.innerHTML = `<div class="globe-msg">${icon("alert")}<div><b>${ERROR_TITLES.WEBGL}</b><br>${msg}</div></div>`; return null; };
  if (!window.THREE || !THREE.OrbitControls) return fail("The 3D library could not load. Check your connection and reload.");

  const MU = 398600.4418, RE = 6378.137, J2 = 1.08262668e-3, D2R = Math.PI / 180, TAU = Math.PI * 2;
  const BANDS = {
    b1: {short: "< 500 km", css: "#26d7c4", c: [0.15, 0.84, 0.77], size: .016},
    b2: {short: "500–1,000 km", css: "#3ea6ff", c: [0.24, 0.65, 1.0], size: .016},
    b3: {short: "1,000–2,000 km", css: "#8f7bff", c: [0.56, 0.48, 1.0], size: .018},
    meo: {short: "MEO", css: "#f7b84b", c: [0.97, 0.72, 0.29], size: .03},
    geo: {short: "GEO", css: "#ff7ad9", c: [1.0, 0.48, 0.85], size: .034},
    deb: {short: "Debris", css: "#ff5c72", c: [1.0, 0.36, 0.45], size: .012},
  };

  let renderer;
  try { renderer = new THREE.WebGLRenderer({antialias: true, alpha: true}); }
  catch (e) { return fail("WebGL is turned off or not supported in this browser."); }
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  host.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 500);
  const HOME = new THREE.Vector3(2.2, 1.5, 3.3);
  camera.position.copy(HOME);
  const controls = new THREE.OrbitControls(camera, renderer.domElement);
  Object.assign(controls, {enableDamping: true, dampingFactor: .06, minDistance: 1.3, maxDistance: 22, enablePan: false,
                           autoRotate: !REDUCED, autoRotateSpeed: .3, rotateSpeed: .6, zoomSpeed: .8});
  let follow = false, anim = null;
  controls.addEventListener("start", () => { controls.autoRotate = false; anim = null; setFollow(false); });

  // distant stars
  {
    const n = 2000, p = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const u = Math.random() * 2 - 1, t = Math.random() * TAU, r = 120 + Math.random() * 60, s = Math.sqrt(1 - u * u);
      p.set([r * s * Math.cos(t), r * u, r * s * Math.sin(t)], i * 3);
    }
    const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.BufferAttribute(p, 3));
    scene.add(new THREE.Points(g, new THREE.PointsMaterial({color: 0xaabbff, size: 1.2, sizeAttenuation: false, transparent: true, opacity: .6})));
  }

  // Earth with day/night shader
  const loader = new THREE.TextureLoader(); loader.setCrossOrigin("anonymous");
  const earthU = {dayTex: {value: null}, nightTex: {value: null}, sunDir: {value: new THREE.Vector3(1, 0, 0)}, hasTex: {value: 0}};
  loader.load(EARTH_TEX, t => { t.anisotropy = 8; earthU.dayTex.value = t; earthU.hasTex.value = 1; }, undefined,
    () => loader.load("https://cdn.jsdelivr.net/gh/mrdoob/three.js@r128/examples/textures/planets/earth_atmos_2048.jpg",
                      t => { earthU.dayTex.value = t; earthU.hasTex.value = 1; }));
  loader.load("https://unpkg.com/three-globe@2.31.0/example/img/earth-night.jpg", t => earthU.nightTex.value = t);
  const earth = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 96), new THREE.ShaderMaterial({
    uniforms: earthU,
    vertexShader: `varying vec2 vUv; varying vec3 vN;
      void main(){ vUv = uv; vN = normalize(mat3(modelMatrix) * normal); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `uniform sampler2D dayTex; uniform sampler2D nightTex; uniform vec3 sunDir; uniform float hasTex;
      varying vec2 vUv; varying vec3 vN;
      void main(){
        float d = dot(normalize(vN), normalize(sunDir));
        vec3 base = vec3(0.05, 0.18, 0.42);
        vec3 day = mix(base, texture2D(dayTex, vUv).rgb, hasTex);
        vec3 night = texture2D(nightTex, vUv).rgb * vec3(1.6, 1.35, 1.0) * hasTex + vec3(0.006, 0.012, 0.035);
        float t = smoothstep(-0.12, 0.22, d);
        vec3 c = mix(night, day * (0.3 + 0.95 * max(d, 0.0)), t);
        float twilight = (1.0 - abs(d) * 5.0); c += vec3(0.25, 0.09, 0.02) * max(twilight, 0.0) * 0.35;
        gl_FragColor = vec4(c, 1.0);
      }`
  }));
  scene.add(earth);
  scene.add(new THREE.Mesh(new THREE.SphereGeometry(1.12, 64, 64), new THREE.ShaderMaterial({
    vertexShader: `varying vec3 vN; void main(){ vN = normalize(normalMatrix * normal); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `varying vec3 vN; void main(){ float i = pow(0.68 - dot(vN, vec3(0.0, 0.0, 1.0)), 2.6); gl_FragColor = vec4(0.3, 0.62, 1.0, 1.0) * i; }`,
    blending: THREE.AdditiveBlending, side: THREE.BackSide, transparent: true, depthWrite: false
  })));

  // glowing-point shader
  const pointUniforms = () => ({uScale: {value: 600}, uTime: {value: 0}, uPulse: {value: 0}});
  const pointMat = u => new THREE.ShaderMaterial({
    uniforms: u, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: `attribute float aSize; attribute vec3 aColor; uniform float uScale; uniform float uTime; uniform float uPulse; varying vec3 vC;
      void main(){ vC = aColor; vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float pulse = 1.0 + uPulse * 0.35 * sin(uTime * 4.0 + position.x * 10.0);
        gl_PointSize = max(aSize * uScale / -mv.z * pulse, aSize > 0.0 ? 1.5 : 0.0); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `varying vec3 vC; void main(){ vec2 p = gl_PointCoord - 0.5; float r = length(p); if (r > 0.5) discard;
        float a = smoothstep(0.5, 0.05, r); float core = smoothstep(0.2, 0.0, r);
        gl_FragColor = vec4(vC * a + vec3(core) * 0.55, a); }`
  });

  /* ---------- orbital mechanics ---------- */
  const nowJD = () => Date.now() / 86400000 + 2440587.5;
  const gmst = jd => ((280.46061837 + 360.98564736629 * (jd - 2451545)) % 360) * D2R;
  function sunECI(jd) {
    const d = jd - 2451545, g = (357.529 + 0.98560028 * d) * D2R, q = (280.459 + 0.98564736 * d) * D2R;
    const L = q + (1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * D2R, e = 23.439 * D2R;
    return {x: Math.cos(L), y: Math.cos(e) * Math.sin(L), z: Math.sin(e) * Math.sin(L), ra: Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L))};
  }
  function bandOf(kind, alt) {
    return kind !== "sat" ? "deb" : alt < 500 ? "b1" : alt < 1000 ? "b2" : alt < 2000 ? "b3" : alt < 30000 ? "meo" : "geo";
  }
  function prep(r) {
    const [id, name, n, e, i, raan, argp, M0, ejd, kind] = r;
    const nS = n / 60, a = Math.cbrt(MU / (nS * nS)), p = a * (1 - e * e), k = 1.5 * J2 * (RE / p) ** 2 * n;
    const alt = a - RE;
    return {id, name, n, e, i, raan, argp, M0, ejd, kind, a, alt, band: bandOf(kind, alt), sq: Math.sqrt(1 - e * e),
            draan: -k * Math.cos(i), dargp: k * (2 - 2.5 * Math.sin(i) ** 2)};
  }
  function eciKm(s, jd, out) {
    const dt = (jd - s.ejd) * 1440;
    const M = ((s.M0 + s.n * dt) % TAU + TAU) % TAU;
    let E = s.e > 0.8 ? Math.PI : M;
    if (s.e > 1e-4) for (let k = 0; k < 8; k++) E -= (E - s.e * Math.sin(E) - M) / (1 - s.e * Math.cos(E));
    const xp = s.a * (Math.cos(E) - s.e), yp = s.a * s.sq * Math.sin(E);
    const W = s.raan + s.draan * dt, w = s.argp + s.dargp * dt;
    const cW = Math.cos(W), sW = Math.sin(W), cw = Math.cos(w), sw = Math.sin(w), ci = Math.cos(s.i), si = Math.sin(s.i);
    out[0] = xp * (cW * cw - sW * sw * ci) - yp * (cW * sw + sW * cw * ci);
    out[1] = xp * (sW * cw + cW * sw * ci) + yp * (cW * cw * ci - sW * sw);
    out[2] = xp * (sw * si) + yp * (cw * si);
    return out;
  }
  const kmTmp = [0, 0, 0];
  function eci(s, jd, out) {     // scene coordinates (earth radii, y up)
    eciKm(s, jd, kmTmp);
    out[0] = kmTmp[0] / RE; out[1] = kmTmp[2] / RE; out[2] = -kmTmp[1] / RE;
    return out;
  }
  /** Live state of a satellite: sub-point, altitude, speed, sunlight. */
  function stateOf(s, jd = simJD) {
    const r = eciKm(s, jd, [0, 0, 0]), rn = Math.hypot(r[0], r[1], r[2]);
    let lon = (Math.atan2(r[1], r[0]) - gmst(jd)) / D2R; lon = ((lon % 360) + 540) % 360 - 180;
    const lat = Math.atan2(r[2], Math.hypot(r[0], r[1])) / D2R;
    const sun = sunECI(jd), dot = r[0] * sun.x + r[1] * sun.y + r[2] * sun.z;
    const sunlit = dot > 0 || Math.sqrt(Math.max(0, rn * rn - dot * dot)) > RE;
    return {lat, lon, alt: rn - RE, v: Math.sqrt(MU * (2 / rn - 1 / s.a)), sunlit, period: TAU / s.n,
            inc: s.i / D2R, ecc: s.e, perigee: s.a * (1 - s.e) - RE, apogee: s.a * (1 + s.e) - RE};
  }
  function groundTrack(s, fromMin, toMin, steps = 160, jd = simJD) {
    const pts = [];
    for (let k = 0; k <= steps; k++) {
      const st = stateOf(s, jd + (fromMin + (toMin - fromMin) * k / steps) / 1440);
      pts.push([st.lat, st.lon]);
    }
    return pts;
  }
  /** Satellites above the horizon of (lat, lon) right now (real time, not simulated). */
  function overhead(lat, lon, minEl = 10, limit = 30) {
    const jd = nowJD(), g = gmst(jd), cg = Math.cos(g), sg = Math.sin(g);
    const la = lat * D2R, lo = lon * D2R;
    const up = [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
    const ob = up.map(u => u * RE), r = [0, 0, 0], out = [];
    for (const s of sats) {
      if (s.alt > 40000) continue;
      eciKm(s, jd, r);
      const x = r[0] * cg + r[1] * sg - ob[0], y = -r[0] * sg + r[1] * cg - ob[1], z = r[2] - ob[2];
      const d = Math.hypot(x, y, z), el = Math.asin((x * up[0] + y * up[1] + z * up[2]) / d) / D2R;
      if (el >= minEl) out.push({s, el, range: d});
    }
    return out.sort((a, b) => ((a.s.alt > 2000) - (b.s.alt > 2000)) || b.el - a.el).slice(0, limit);   // low orbits first
  }

  /* ---------- state ---------- */
  let simJD = nowJD(), speed = 1, total = 0, selected = null;
  let sats = [], byId = new Map(), mainGeo = null, mainU = pointUniforms();
  const visible = new Set(Object.keys(BANDS));
  const groups = {};      // name -> [{s, color, size, label, cls, orbit}]
  let spGeo = null, spPts = null, spList = [], spU = pointUniforms(); spU.uPulse.value = 1;
  const orbitLines = [], tmp = [0, 0, 0];

  // legend chips (filter by altitude band)
  $("#g-legend").innerHTML = Object.entries(BANDS).map(([k, b]) =>
    `<button class="chip on" data-band="${k}" title="Show/hide ${b.short}"><i style="color:${b.css};background:${b.css}"></i>${b.short}</button>`).join("");
  $$("#g-legend .chip").forEach(b => b.onclick = () => {
    const k = b.dataset.band; visible.has(k) ? visible.delete(k) : visible.add(k);
    b.classList.toggle("on", visible.has(k)); b.classList.toggle("off", !visible.has(k)); applySizes();
  });

  function buildMain() {
    if (mainGeo) { scene.remove(mainGeo.__pts); mainGeo.dispose(); }
    const n = sats.length;
    mainGeo = new THREE.BufferGeometry();
    mainGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    mainGeo.setAttribute("aColor", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    mainGeo.setAttribute("aSize", new THREE.BufferAttribute(new Float32Array(n), 1));
    sats.forEach((s, i) => mainGeo.attributes.aColor.array.set(BANDS[s.band].c, i * 3));
    applySizes();
    const pts = new THREE.Points(mainGeo, pointMat(mainU)); pts.frustumCulled = false; scene.add(pts); mainGeo.__pts = pts;
  }
  function applySizes() {
    if (!mainGeo) return;
    const a = mainGeo.attributes.aSize.array;
    sats.forEach((s, i) => a[i] = visible.has(s.band) ? BANDS[s.band].size : 0);
    mainGeo.attributes.aSize.needsUpdate = true;
    $("#g-count").innerHTML = `<b>${fmt(sats.filter(s => visible.has(s.band)).length)}</b> of ${fmt(total)} objects`;
  }

  function rebuildSpecials() {
    if (spPts) { scene.remove(spPts); spGeo.dispose(); }
    orbitLines.splice(0).forEach(l => { scene.remove(l.line); l.line.geometry.dispose(); });
    labelsEl.innerHTML = "";
    const selId = selected?.id;
    spList = Object.entries(groups).flatMap(([g, list]) => g === "focus" ? list : list.filter(o => o.s.id !== selId));
    if (!spList.length) { spPts = spGeo = null; return; }
    spGeo = new THREE.BufferGeometry();
    spGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(spList.length * 3), 3));
    spGeo.setAttribute("aColor", new THREE.BufferAttribute(new Float32Array(spList.flatMap(o => o.color)), 3));
    spGeo.setAttribute("aSize", new THREE.BufferAttribute(new Float32Array(spList.map(o => o.size)), 1));
    spPts = new THREE.Points(spGeo, pointMat(spU)); spPts.frustumCulled = false; scene.add(spPts);
    for (const o of spList) {
      if (o.label) {
        o.el = document.createElement("div"); o.el.className = "glabel " + (o.cls || "");
        o.el.innerHTML = o.html || esc(o.label);
        labelsEl.appendChild(o.el);
      }
      if (o.orbit) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(241 * 3), 3));
        const line = new THREE.Line(geo, new THREE.LineBasicMaterial({color: new THREE.Color(...o.color), transparent: true, opacity: .6,
                                                                      blending: THREE.AdditiveBlending, depthWrite: false}));
        line.frustumCulled = false; scene.add(line); orbitLines.push({line, s: o.s});
      }
    }
    updateOrbitLines();
  }
  function updateOrbitLines() {
    for (const {line, s} of orbitLines) {
      const arr = line.geometry.attributes.position.array, per = TAU / s.n / 1440;
      for (let k = 0; k <= 240; k++) { eci(s, simJD + per * k / 240, tmp); arr.set(tmp, k * 3); }
      line.geometry.attributes.position.needsUpdate = true;
    }
  }

  const v3 = new THREE.Vector3();
  function occluded(p) {
    const c = camera.position, d = p.clone().sub(c), L = d.length(); d.divideScalar(L);
    const t = -c.dot(d); if (t < 0 || t > L) return false;
    return c.clone().addScaledVector(d, t).length() < 0.995;
  }
  function updateLabels() {
    const w = wrapEl.clientWidth, h = wrapEl.clientHeight;
    for (let i = 0; i < spList.length; i++) {
      const o = spList[i]; if (!o.el) continue;
      v3.fromArray(spGeo.attributes.position.array, i * 3);
      const hidden = occluded(v3); v3.project(camera);
      if (hidden || v3.z > 1 || Math.abs(v3.x) > 1.1 || Math.abs(v3.y) > 1.1) { o.el.style.display = "none"; continue; }
      o.el.style.display = "";
      o.el.style.transform = `translate(${(v3.x + 1) / 2 * w}px, ${(1 - v3.y) / 2 * h}px) translate(-50%, -100%)`;
    }
  }

  /* ---------- picking + hover tooltip ---------- */
  function pick(clientX, clientY) {
    const rect = host.getBoundingClientRect(), mx = clientX - rect.left, my = clientY - rect.top, w = rect.width, h = rect.height;
    const cands = [];
    const scan = (geo, list, sizeOk) => {
      if (!geo) return;
      const a = geo.attributes.position.array;
      for (let i = 0; i < list.length; i++) {
        if (!sizeOk(i)) continue;
        v3.set(a[i * 3], a[i * 3 + 1], a[i * 3 + 2]).project(camera);
        if (v3.z > 1) continue;
        const dx = (v3.x + 1) / 2 * w - mx, dy = (1 - v3.y) / 2 * h - my, d2 = dx * dx + dy * dy;
        if (d2 < 144) cands.push({d2, i, list, a});
      }
    };
    scan(spGeo, spList.map(o => o.s), () => true);
    scan(mainGeo, sats, i => mainGeo.attributes.aSize.array[i] > 0);
    cands.sort((p, q) => p.d2 - q.d2);
    for (const c of cands) {
      v3.set(c.a[c.i * 3], c.a[c.i * 3 + 1], c.a[c.i * 3 + 2]);
      if (!occluded(v3)) return c.list[c.i];
    }
    return null;
  }
  let down = null, lastHover = 0;
  host.addEventListener("pointerdown", e => down = [e.clientX, e.clientY]);
  host.addEventListener("pointerup", e => {
    if (down && Math.hypot(e.clientX - down[0], e.clientY - down[1]) < 5) {
      const s = pick(e.clientX, e.clientY);
      if (s && s.id > 0) select(s.id, {fly: false}).catch(err => toast(esc(err.message), "bad"));
    }
    down = null;
  });
  host.addEventListener("pointermove", e => {
    if (e.pointerType !== "mouse" || e.buttons || performance.now() - lastHover < 60) return;
    lastHover = performance.now();
    const s = pick(e.clientX, e.clientY), rect = wrapEl.getBoundingClientRect();
    host.classList.toggle("pointing", !!s);
    if (!s) { tip.hidden = true; return; }
    tip.hidden = false;
    tip.style.left = Math.min(e.clientX - rect.left, rect.width - 200) + "px"; tip.style.top = (e.clientY - rect.top) + "px";
    tip.innerHTML = `<b>${esc(s.name)}</b> · ${fmt(s.alt)} km · ${BANDS[s.band].short}<br><span style="color:var(--accent)">click to select</span>`;
  });
  host.addEventListener("pointerleave", () => { tip.hidden = true; });

  /* ---------- render loop ---------- */
  function resize() {
    const w = wrapEl.clientWidth, h = wrapEl.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix();
    const sc = h / (2 * Math.tan(camera.fov * D2R / 2));
    mainU.uScale.value = sc; spU.uScale.value = sc;
  }
  new ResizeObserver(resize).observe(wrapEl); resize();
  let onScreen = true;
  new IntersectionObserver(e => onScreen = e[0].isIntersecting).observe(wrapEl);

  const selPos = new THREE.Vector3();
  let last = performance.now(), frameN = 0, lastHud = 0;
  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    simJD += dt * speed / 86400;
    if (now - lastHud > 250) {
      lastHud = now;
      const live = speed === 1 && Math.abs(simJD - nowJD()) < 2 / 1440;
      $("#g-mode").innerHTML = live ? '<span class="live">● LIVE</span>' : `<span class="sim">◷ SIMULATED ${speed}×</span>`;
      $("#g-time").innerHTML = `<b>${new Date((simJD - 2440587.5) * 86400000).toISOString().slice(0, 19).replace("T", " ")}</b> UTC`;
      if (selected) emit("tick", {s: selected, st: stateOf(selected), live});
    }
    if (!onScreen || document.hidden) return;
    earth.rotation.y = gmst(simJD);
    const sun = sunECI(simJD); earthU.sunDir.value.set(sun.x, sun.z, -sun.y);
    mainU.uTime.value = spU.uTime.value = now / 1000;
    if (mainGeo) {
      const a = mainGeo.attributes.position.array;
      for (let i = 0; i < sats.length; i++) { eci(sats[i], simJD, tmp); a[i * 3] = tmp[0]; a[i * 3 + 1] = tmp[1]; a[i * 3 + 2] = tmp[2]; }
      mainGeo.attributes.position.needsUpdate = true;
    }
    if (spGeo) {
      const a = spGeo.attributes.position.array;
      for (let i = 0; i < spList.length; i++) { eci(spList[i].s, simJD, tmp); a.set(tmp, i * 3); }
      spGeo.attributes.position.needsUpdate = true;
    }
    if (++frameN % 45 === 0) updateOrbitLines();
    if (anim) {
      const p = Math.min(1, (now - anim.t0) / anim.dur), e = p < .5 ? 4 * p ** 3 : 1 - (-2 * p + 2) ** 3 / 2;
      const to = anim.target();
      camera.position.copy(anim.from).lerp(to, e).setLength(anim.from.length() + (to.length() - anim.from.length()) * e);
      if (p >= 1) anim = null;
    } else if (follow && selected) {
      eci(selected, simJD, tmp); selPos.fromArray(tmp).normalize().multiplyScalar(camera.position.length());
      camera.position.lerp(selPos, .05).setLength(selPos.length());
    }
    controls.update();
    renderer.render(scene, camera);
    updateLabels();
  }
  requestAnimationFrame(frame);

  /* ---------- controls ---------- */
  $$("#g-speed .chip").forEach(b => b.onclick = () => {
    speed = +b.dataset.speed;
    if (speed === 1) simJD = nowJD();             // "Live" snaps back to now
    $$("#g-speed .chip").forEach(x => x.classList.toggle("on", x === b));
  });
  const zoom = f => { anim = null; camera.position.setLength(Math.min(22, Math.max(1.3, camera.position.length() * f))); };
  $("#z-in").onclick = () => zoom(.8);
  $("#z-out").onclick = () => zoom(1.25);
  $("#z-reset").onclick = () => { setFollow(false); flyCam(() => HOME.clone(), 1200); controls.autoRotate = !REDUCED; };
  $("#z-follow").onclick = () => { setFollow(!follow); if (follow && selected) flyToSat(selected); };
  function setFollow(v) { follow = v && !!selected; $("#z-follow").classList.toggle("on", follow); if (follow) controls.autoRotate = false; }
  function flyCam(target, dur = 1400) { anim = {from: camera.position.clone(), target, t0: performance.now(), dur: REDUCED ? 1 : dur}; }
  function flyToSat(s, dist) {
    controls.autoRotate = false;
    const d = dist || Math.max(2.2, Math.min(camera.position.length(), 1 + s.alt / RE + 2.4));
    flyCam(() => { eci(s, simJD, tmp); return new THREE.Vector3(...tmp).normalize().multiplyScalar(d); });
  }

  /* ---------- data + public API ---------- */
  const find = id => byId.get(id);
  async function ensure(ids) {
    const missing = ids.filter(id => !byId.has(id));
    if (missing.length) {
      const d = await getJSON("/api/orbits?ids=" + missing.join(","));
      d.sats.map(prep).forEach(s => byId.set(s.id, s));
    }
    return ids.map(id => byId.get(id)).filter(Boolean);
  }
  async function load() {
    try {
      const d = await getJSON("/api/orbits?limit=" + (innerWidth < 700 ? 2500 : 6000), {timeout: 90000});
      total = d.total;
      sats = d.sats.map(prep).filter(s => s.alt > 120 && s.a < RE * 12);
      sats.forEach(s => byId.set(s.id, s));
      buildMain();
      const iss = find(25544), css = find(48274), hst = find(20580);
      groups.default = [
        iss && {s: iss, color: [1, 1, 1], size: .05, label: "ISS"},
        css && {s: css, color: [1, .9, .55], size: .045, label: "Tiangong"},
        hst && {s: hst, color: [.75, .85, 1], size: .04, label: "Hubble"},
      ].filter(Boolean);
      rebuildSpecials();
      emit("catalog", {total, shown: sats.length});
    } catch (e) {
      $("#g-count").textContent = "Satellite data unavailable";
      emit("catalog-error", e);
    }
  }
  async function select(id, {fly = true} = {}) {
    const [s] = await ensure([id]);
    if (!s) throw new AppError(`Satellite ${id} isn't in the current catalog.`, {code: "SAT_NOT_FOUND"});
    selected = s;
    groups.focus = [{s, color: [.55, .95, 1], size: .08, label: s.name, orbit: true, cls: "focus",
                     html: `${esc(s.name)}<small>${fmt(s.alt)} km · ${fmt(s.i / D2R, 1)}°</small>`}];
    rebuildSpecials();
    if (fly) flyToSat(s);
    emit("select", s);
    return s;
  }
  async function showObjects(group, ids, {color, size = .05, labels = {}, orbitIds = [], cls = "", colorOf} = {}) {
    const all = await ensure(ids);
    groups[group] = all.map(s => ({s, color: colorOf ? colorOf(s) : color, size, label: labels[s.id], orbit: orbitIds.includes(s.id), cls}));
    rebuildSpecials();
  }
  function showPlanned(altKm, incDeg, mission) {
    const a = RE + altKm, n = Math.sqrt(MU / a ** 3) * 60, sun = sunECI(simJD);
    const raan = mission === "earth-observation" ? sun.ra + 157.5 * D2R : sun.ra;   // ~10:30 descending node for SSO
    const s = prep([-1, "Your satellite", n, 0, incDeg * D2R, raan, 0, 0, simJD, "sat"]);
    groups.planned = [{s, color: [.18, .95, .6], size: .075, label: `Your satellite · ${altKm} km · ${incDeg.toFixed(1)}°`, orbit: true, cls: "planned"}];
    rebuildSpecials();
    setFollow(false); flyCam(() => camera.position.clone().setLength(3.8));
  }
  function clear(group) { delete groups[group]; rebuildSpecials(); }
  function mount(slot) { if (slot && wrapEl.parentElement !== slot) { slot.appendChild(wrapEl); requestAnimationFrame(resize); } }
  load();
  return {select, showObjects, showPlanned, clear, mount, stateOf, groundTrack, overhead, ensure, find, nowJD,
          get selected() { return selected; }, get ready() { return !!sats.length; }, get count() { return sats.length; }, BANDS};
})();
