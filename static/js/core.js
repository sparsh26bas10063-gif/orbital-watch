/* OrbitGuard | ASTRA 2026 | Team AstroNex */
/* OrbitGuard core: helpers, errors, toasts, alerts, background */
"use strict";
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const fmt = (n, d = 0) => n == null || Number.isNaN(+n) ? "–" : Number(n).toLocaleString(undefined, {minimumFractionDigits: d, maximumFractionDigits: d});
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
const icon = (n, cls = "") => `<svg class="ic ${cls}" aria-hidden="true"><use href="#i-${n}"/></svg>`;
const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
const ago = iso => {
  const t = Date.parse(iso); if (!t) return "";
  const m = (Date.now() - t) / 60000;
  return m < 1 ? "now" : m < 60 ? `${Math.round(m)}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};
const utc = iso => iso ? String(iso).slice(0, 16).replace("T", " ") : "–";
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const bus = new EventTarget();
const emit = (type, detail) => bus.dispatchEvent(new CustomEvent(type, {detail}));
const on = (type, fn) => bus.addEventListener(type, e => fn(e.detail));

/* ---------------------------------------------------------------- errors */
class AppError extends Error {
  constructor(message, {code = "ERROR", hint = null, status = 0} = {}) { super(message); this.code = code; this.hint = hint; this.status = status; }
}
const ERROR_TITLES = {
  RATE_LIMITED: "NASA rate limit reached", UPSTREAM_UNAVAILABLE: "Data source not responding", UPSTREAM_ERROR: "Data source error",
  BAD_INPUT: "Please check your input", OUT_OF_RANGE: "Value out of range", SAT_NOT_FOUND: "Satellite not found",
  PLACE_NOT_FOUND: "Place not found", CATALOG_UNAVAILABLE: "Satellite catalog unavailable", OFFLINE: "You're offline",
  TIMEOUT: "This is taking too long", NETWORK: "Can't reach OrbitGuard", NOT_FOUND: "Not found", INTERNAL: "Server error",
  QUERY_TOO_SHORT: "Keep typing", BAD_RESPONSE: "Unexpected response", WEBGL: "3D graphics unavailable", MAP: "3D map unavailable",
};

async function getJSON(url, {timeout = 45000} = {}) {
  if (!navigator.onLine) throw new AppError("Your device is not connected to the internet.", {code: "OFFLINE", hint: "Reconnect, then press Retry."});
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), timeout);
  let r;
  try { r = await fetch(url, {signal: ctl.signal}); }
  catch (e) {
    throw e.name === "AbortError"
      ? new AppError("The server took too long to answer.", {code: "TIMEOUT", hint: "Heavy calculations can take up to a minute. Try again or use a shorter time window."})
      : new AppError("Could not reach the OrbitGuard server.", {code: "NETWORK", hint: "Is the app still running? Check your connection."});
  } finally { clearTimeout(timer); }
  let j;
  try { j = await r.json(); }
  catch { throw new AppError(`The server sent an unexpected response (HTTP ${r.status}).`, {code: "BAD_RESPONSE", status: r.status}); }
  if (!r.ok || j.error) throw new AppError(j.error || r.statusText, {code: j.code || "ERROR", hint: j.hint, status: r.status});
  return j;
}

/** Render a friendly error card into `el`. If `retry` is given, a Retry button calls it. */
function showError(el, e, retry, soft = false) {
  const code = e.code || "ERROR";
  el.innerHTML = `<div class="err ${soft ? "soft" : ""}" role="alert"><div class="err-ic">${icon(code === "OFFLINE" || code === "NETWORK" ? "wifioff" : "alert")}</div>
    <div><b>${esc(ERROR_TITLES[code] || "Something went wrong")}</b><p>${esc(e.message)}</p>${e.hint ? `<small>${esc(e.hint)}</small>` : ""}</div>
    ${retry ? `<button class="btn ghost sm" type="button">${icon("refresh")}Retry</button>` : ""}</div>`;
  if (retry) $("button", el).onclick = retry;
}

function toast(text, level = "info", ms = 4200) {
  const el = document.createElement("div");
  el.className = `toast ${level}`;
  el.innerHTML = icon(level === "bad" ? "alert" : level === "good" ? "check" : level === "warn" ? "alert" : "info") + `<div>${text}</div>`;
  $("#toasts").appendChild(el);
  setTimeout(() => { el.classList.add("out"); setTimeout(() => el.remove(), 320); }, ms);
}

addEventListener("online", () => { $("#offline").hidden = true; $("#online-pill").textContent = "ONLINE"; toast("Back online", "good"); });
addEventListener("offline", () => { $("#offline").hidden = false; $("#online-pill").textContent = "OFFLINE"; });
addEventListener("unhandledrejection", e => {
  console.warn(e.reason);
  if (e.reason instanceof AppError) toast(esc(e.reason.message), "bad");
});

/* ---------------------------------------------------------------- loading state helpers */
function busy(btn, isBusy, label) {
  if (!btn) return;
  btn.dataset.html ??= btn.innerHTML;
  btn.disabled = isBusy;
  btn.innerHTML = isBusy ? `${icon("refresh")}${esc(label)}` : btn.dataset.html;
  if (isBusy) $("svg", btn).style.animation = "spin 1s linear infinite";
}
function stat(label, value, cls = "", delay = 0) {
  const v = typeof value === "number" ? `<b data-count="${value}">0</b>` : `<b>${value}</b>`;
  return `<div class="stat ${cls}" style="animation-delay:${delay * 70}ms"><small>${label}</small>${v}</div>`;
}
function runCounters(root) {
  $$("[data-count]", root).forEach(el => {
    const to = +el.dataset.count, t0 = performance.now(), dur = REDUCED ? 1 : 1000, dec = to % 1 ? 1 : 0;
    const step = now => {
      const p = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - p, 3);
      el.textContent = fmt(to * e, dec);
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}
function setStats(sel, html) { const el = $(sel); el.innerHTML = html; runCounters(el); }
/** Responsive table: on phones each row becomes a card (labels from data-label). */
function table(cols, rows, {top = false, empty = "Nothing found."} = {}) {
  if (!rows.length) return `<div class="empty">${icon("check")}<p>${empty}</p></div>`;
  return `<div class="table-wrap"><table><thead><tr>${cols.map(c => `<th class="${c.num ? "num" : ""}">${c.h}</th>`).join("")}</tr></thead><tbody>` +
    rows.map((r, i) => `<tr style="--i:${Math.min(i, 20)}" class="${top && i === 0 ? "top" : ""}">${cols.map(c =>
      `<td class="${c.num ? "num" : ""}" data-label="${esc(c.h.replace(/<[^>]+>/g, ""))}">${c.f(r, i)}</td>`).join("")}</tr>`).join("") +
    "</tbody></table></div>";
}

/* ---------------------------------------------------------------- alerts store */
const Alerts = (() => {
  const items = new Map();
  const ICON = {bad: "alert", warn: "zap", info: "info", good: "check"};
  function render() {
    const list = [...items.values()].sort((a, b) => (b.rank - a.rank) || String(b.time).localeCompare(String(a.time)));
    const html = list.length ? list.map((a, i) => `<div class="feed-item ${a.go ? "click" : ""}" data-id="${esc(a.id)}" style="animation-delay:${i * 40}ms">
        <div class="fi ${a.level}">${icon(a.icon || ICON[a.level])}</div><div><b>${esc(a.title)}</b><p>${a.text}</p></div>
        <time>${esc(a.time ? ago(a.time) : "")}</time></div>`).join("")
      : `<div class="empty">${icon("check")}<p>All clear. No alerts right now.</p></div>`;
    for (const el of [$("#feed"), $("#pop-feed")]) {
      el.innerHTML = html;
      $$(".feed-item.click", el).forEach(f => f.onclick = () => { const a = items.get(f.dataset.id); a?.go(); $("#alerts-pop").hidden = true; });
    }
    const n = list.filter(a => a.level === "bad" || a.level === "warn").length;
    $("#bell-n").hidden = !n; $("#bell-n").textContent = n;
    $("#feed-n").textContent = list.length;
  }
  return {
    add(a) { items.set(a.id, {rank: {bad: 3, warn: 2, info: 1, good: 0}[a.level] ?? 0, ...a}); render(); },
    remove(prefix) { for (const k of [...items.keys()]) if (k.startsWith(prefix)) items.delete(k); render(); },
    render,
  };
})();

/* ---------------------------------------------------------------- minimal starfield */
(() => {
  const c = $("#stars"), x = c.getContext("2d");
  let W, H, stars = [];
  function resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    W = innerWidth; H = innerHeight; c.width = W * dpr; c.height = H * dpr; x.setTransform(dpr, 0, 0, dpr, 0, 0);
    stars = Array.from({length: Math.round(W * H / 9000)}, () => ({x: Math.random() * W, y: Math.random() * H,
      r: Math.random() * 1.1 + .2, t: Math.random() * 6.28, s: .3 + Math.random()}));
  }
  resize(); addEventListener("resize", debounce(resize, 200));
  let last = 0;
  function frame(now) {
    requestAnimationFrame(frame);
    if (now - last < 66) return;            // ~15 fps is plenty for a slow twinkle
    last = now; x.clearRect(0, 0, W, H);
    for (const s of stars) {
      s.t += .066 * s.s;
      x.fillStyle = `rgba(200,220,255,${REDUCED ? .5 : .2 + .5 * (.5 + .5 * Math.sin(s.t))})`;
      x.beginPath(); x.arc(s.x, s.y, s.r, 0, 6.283); x.fill();
    }
  }
  requestAnimationFrame(frame);
})();
