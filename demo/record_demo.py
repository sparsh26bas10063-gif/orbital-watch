# OrbitGuard | ASTRA 2026 | Team AstroNex
"""Record an OrbitGuard demo video by driving headless Chrome over the DevTools protocol.

Usage:  python demo/record_demo.py WORK_DIR [test]
Produces WORK_DIR/frames/*.jpg + WORK_DIR/frames.json (timestamps). demo/encode_demo.py turns them into an MP4.
"""
import base64
import itertools
import json
import math
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path

import websocket

CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
import os
BASE = os.environ.get("DEMO_BASE", "http://127.0.0.1:5000")
W, H = 1600, 900
WORK = Path(sys.argv[1])
TEST = len(sys.argv) > 2 and sys.argv[2] == "test"
FRAMES = WORK / "frames"


# --------------------------------------------------------------------------- CDP client
class CDP:
    def __init__(self, url):
        self.ws = websocket.create_connection(url, max_size=None, suppress_origin=True)
        self.ids = itertools.count(1)
        self.pending, self.handlers, self.lock = {}, {}, threading.Lock()
        threading.Thread(target=self._loop, daemon=True).start()

    def _loop(self):
        while True:
            try:
                msg = json.loads(self.ws.recv())
            except Exception:
                return
            if "id" in msg:
                slot = self.pending.pop(msg["id"], None)
                if slot:
                    slot[1].update(msg)
                    slot[0].set()
            elif msg.get("method") in self.handlers:
                self.handlers[msg["method"]](msg.get("params", {}))

    def _raw(self, i, method, params):
        with self.lock:
            self.ws.send(json.dumps({"id": i, "method": method, "params": params or {}}))

    def send(self, method, params=None, timeout=90):
        i, ev, box = next(self.ids), threading.Event(), {}
        self.pending[i] = (ev, box)
        self._raw(i, method, params)
        if not ev.wait(timeout):
            raise TimeoutError(method)
        if "error" in box:
            raise RuntimeError(f"{method}: {box['error']}")
        return box.get("result", {})

    def fire(self, method, params=None):          # no wait (safe from the reader thread)
        self._raw(next(self.ids), method, params)


# --------------------------------------------------------------------------- overlay injected into every page
OVERLAY = r"""
(() => {
  const css = `#demo-cursor{position:fixed;left:0;top:0;width:26px;height:26px;z-index:2147483647;pointer-events:none;will-change:transform}
  #demo-cursor svg{width:26px;height:26px;filter:drop-shadow(0 3px 5px rgba(0,0,0,.7))}
  .demo-ripple{position:fixed;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;border:3px solid #3ea6ff;z-index:2147483646;pointer-events:none;animation:demoRip .65s ease-out forwards}
  @keyframes demoRip{to{transform:scale(3.4);opacity:0}}
  #demo-cap{position:fixed;left:50%;bottom:28px;transform:translate(-50%,24px);opacity:0;z-index:2147483645;pointer-events:none;
    background:rgba(4,10,24,.9);border:1px solid rgba(62,166,255,.5);border-radius:20px;padding:13px 26px;max-width:78%;text-align:center;
    font:600 21px Inter,system-ui,sans-serif;color:#fff;box-shadow:0 14px 44px rgba(0,0,0,.65);transition:all .5s cubic-bezier(.2,.8,.2,1)}
  #demo-cap.on{opacity:1;transform:translate(-50%,0)}
  #demo-cap small{display:block;font:500 15px Inter,system-ui,sans-serif;color:#9ec9ff;margin-top:4px}
  #demo-cap b{display:inline-block;min-width:30px;height:30px;line-height:30px;border-radius:50%;background:linear-gradient(135deg,#2f8fff,#26c3d7);color:#04121a;margin-right:10px;font-size:16px}
  #demo-card{position:fixed;inset:0;z-index:2147483644;display:grid;place-items:center;text-align:center;opacity:0;pointer-events:none;transition:opacity .8s;
    background:radial-gradient(900px 600px at 25% 15%,rgba(40,110,255,.38),transparent 60%),radial-gradient(800px 600px at 85% 95%,rgba(30,210,190,.28),transparent 60%),#040814}
  #demo-card.on{opacity:1}
  body:has(#demo-card.on) #demo-cursor{opacity:0}
  #demo-card h1{font:800 76px Inter,system-ui,sans-serif;letter-spacing:-.035em;margin:0;background:linear-gradient(90deg,#fff,#9ccfff 50%,#26d7c4);-webkit-background-clip:text;background-clip:text;color:transparent}
  #demo-card p{font:500 25px Inter,system-ui,sans-serif;color:#d6e6ff;margin:16px 0 0}
  #demo-card .meta{font:500 16px 'JetBrains Mono',monospace;color:#8aa0c8;margin-top:30px;line-height:2}
  #demo-card .feat{display:flex;gap:12px;justify-content:center;flex-wrap:wrap;margin-top:28px;max-width:1100px}
  #demo-card .feat span{font:600 15px Inter,system-ui,sans-serif;color:#cfe6ff;padding:8px 16px;border-radius:99px;border:1px solid rgba(62,166,255,.45);background:rgba(62,166,255,.1)}`;
  const add = () => {
    if (document.getElementById("demo-cursor")) return;
    const st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);
    const c = document.createElement("div"); c.id = "demo-cursor";
    c.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 2.5l6.5 18 2.6-7.4 7.4-2.6z" fill="#fff" stroke="#0b1530" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    c.style.transform = "translate(800px,450px)";
    const cap = document.createElement("div"); cap.id = "demo-cap";
    const card = document.createElement("div"); card.id = "demo-card";
    document.body.append(c, cap, card);
    addEventListener("mousemove", e => c.style.transform = `translate(${e.clientX - 3}px,${e.clientY - 2}px)`, true);
    addEventListener("mousedown", e => { const r = document.createElement("div"); r.className = "demo-ripple";
      r.style.left = e.clientX + "px"; r.style.top = e.clientY + "px"; document.body.appendChild(r); setTimeout(() => r.remove(), 700); }, true);
    window.__demo = {
      cap(n, t, s) { cap.innerHTML = (n ? `<b>${n}</b>` : "") + t + (s ? `<small>${s}</small>` : ""); cap.classList.add("on"); },
      capOff() { cap.classList.remove("on"); },
      card(html) { card.innerHTML = html; card.classList.add("on"); },
      cardOff() { card.classList.remove("on"); },
    };
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", add); else add();
})();
"""


# --------------------------------------------------------------------------- browser + recording
def free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p


if FRAMES.exists():
    shutil.rmtree(FRAMES)
FRAMES.mkdir(parents=True)
port = free_port()
profile = WORK / "chrome-profile"
proc = subprocess.Popen([CHROME, "--headless=new", f"--remote-debugging-port={port}", f"--user-data-dir={profile}",
                         f"--window-size={W},{H}", "--hide-scrollbars", "--mute-audio", "--no-first-run",
                         "--no-default-browser-check", "--enable-gpu", "--ignore-gpu-blocklist", "about:blank"],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
for _ in range(60):
    try:
        targets = json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list"))
        page = next(t for t in targets if t["type"] == "page")
        break
    except Exception:
        time.sleep(.5)
cdp = CDP(page["webSocketDebuggerUrl"])
for d in ("Page", "Runtime"):
    cdp.send(f"{d}.enable")
cdp.send("Emulation.setDeviceMetricsOverride", {"width": W, "height": H, "deviceScaleFactor": 1, "mobile": False})
cdp.send("Page.addScriptToEvaluateOnNewDocument", {"source": OVERLAY})

frames, flock = [], threading.Lock()


def on_frame(p):
    cdp.fire("Page.screencastFrameAck", {"sessionId": p["sessionId"]})
    with flock:
        n = len(frames)
        path = FRAMES / f"f{n:06d}.jpg"
        frames.append((p["metadata"]["timestamp"], path.name))
    path.write_bytes(base64.b64decode(p["data"]))


cdp.handlers["Page.screencastFrame"] = on_frame


# --------------------------------------------------------------------------- actions
def js(expr, await_promise=True):
    r = cdp.send("Runtime.evaluate", {"expression": expr, "awaitPromise": await_promise, "returnByValue": True})
    if r.get("exceptionDetails"):
        print("  JS error:", r["exceptionDetails"].get("text"), expr[:80])
    return r.get("result", {}).get("value")


def wait(s):
    time.sleep(s)


def wait_for(cond, timeout=30, every=.25):
    t0 = time.time()
    while time.time() - t0 < timeout:
        if js(f"!!({cond})"):
            return True
        time.sleep(every)
    print("  timeout waiting for:", cond)
    return False


mouse = [W / 2, H / 2]


def move(x, y, dur=.7):
    x0, y0 = mouse
    steps = max(8, int(dur * 45))
    for i in range(1, steps + 1):
        t = i / steps
        e = t * t * (3 - 2 * t)
        mx, my = x0 + (x - x0) * e, y0 + (y - y0) * e + math.sin(t * math.pi) * -18
        cdp.send("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": mx, "y": my})
        time.sleep(dur / steps)
    mouse[:] = [x, y]


def click_xy(x, y, dur=.7):
    move(x, y, dur)
    time.sleep(.12)
    for t in ("mousePressed", "mouseReleased"):
        cdp.send("Input.dispatchMouseEvent", {"type": t, "x": x, "y": y, "button": "left", "clickCount": 1})
        time.sleep(.09)


def locate(sel):
    """Scroll an element into view if needed and return its centre."""
    q = json.dumps(sel)
    vis = js(f"""(() => {{ const e = document.querySelector({q}); if (!e) return null;
        const r = e.getBoundingClientRect(); return r.top >= 70 && r.bottom <= innerHeight - 20; }})()""")
    if vis is None:
        print("  missing element:", sel)
        return None
    if not vis:
        js(f"document.querySelector({q}).scrollIntoView({{behavior:'smooth', block:'center'}})")
        time.sleep(1.0)
    return js(f"""(() => {{ const r = document.querySelector({q}).getBoundingClientRect();
        return [r.left + r.width / 2, r.top + r.height / 2]; }})()""")


def click(sel, dur=.7):
    c = locate(sel)
    if c:
        click_xy(*c, dur)
    return bool(c)


def type_text(text, delay=.09):
    for ch in text:
        cdp.send("Input.insertText", {"text": ch})
        time.sleep(delay)


def key(name):
    codes = {"Enter": 13, "Escape": 27}
    base = {"key": name, "code": name, "windowsVirtualKeyCode": codes[name], "nativeVirtualKeyCode": codes[name]}
    cdp.send("Input.dispatchKeyEvent", {"type": "keyDown", **base, **({"text": "\r"} if name == "Enter" else {})})
    cdp.send("Input.dispatchKeyEvent", {"type": "keyUp", **base})


def drag(x0, y0, x1, y1, dur=1.2):
    move(x0, y0, .5)
    cdp.send("Input.dispatchMouseEvent", {"type": "mousePressed", "x": x0, "y": y0, "button": "left", "clickCount": 1})
    steps = int(dur * 45)
    for i in range(1, steps + 1):
        t = i / steps
        cdp.send("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": x0 + (x1 - x0) * t, "y": y0 + (y1 - y0) * t, "buttons": 1})
        time.sleep(dur / steps)
    cdp.send("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": x1, "y": y1, "button": "left", "clickCount": 1})
    mouse[:] = [x1, y1]


def scroll_to(y, settle=1.3):
    js(f"window.scrollTo({{top: {y}, behavior: 'smooth'}})")
    time.sleep(settle)


def scroll_el(sel, block="start", settle=1.4):
    js(f"document.querySelector({json.dumps(sel)})?.scrollIntoView({{behavior:'smooth', block:'{block}'}})")
    time.sleep(settle)


def cap(n, title, sub=""):
    js(f"window.__demo && __demo.cap({json.dumps(n)}, {json.dumps(title)}, {json.dumps(sub)})")


def cap_off():
    js("window.__demo && __demo.capOff()")


def card(html):
    js(f"window.__demo && __demo.card({json.dumps(html)})")


def card_off():
    js("window.__demo && __demo.cardOff()")


def nav(view):
    click(f'.nav-btn[data-view="{view}"]', .8)


def navigate(url):
    cdp.send("Page.navigate", {"url": url})
    wait_for("document.readyState === 'complete' && window.__demo", 40)


# --------------------------------------------------------------------------- the demo
prof = json.load(urllib.request.urlopen(BASE + "/api/satellite/20580", timeout=120))
img = (prof.get("wiki") or {}).get("image_full") or (prof.get("wiki") or {}).get("image")
if img:
    cdp.send("Page.navigate", {"url": img})
    wait_for("document.readyState === 'complete'", 60)
    time.sleep(2)
navigate(BASE + "/")
card("<div><h1>OrbitGuard</h1><p>Know what's at risk in orbit today, and where it's safe to launch tomorrow.</p>"
     "<div class='meta'>ASTRA 2026 · Domain 06: Sustainable Space &amp; Space Environment<br>Team AstroNex (S28)</div></div>")
wait_for("typeof Globe !== 'undefined' && Globe && Globe.ready && Globe.selected", 120)
wait(2)          # let the camera settle on the ISS behind the title card
cdp.send("Page.startScreencast", {"format": "jpeg", "quality": 82, "maxWidth": W, "maxHeight": H, "everyNthFrame": 1})
t_start = time.time()
wait(4.5 if not TEST else 2)
card_off(); wait(1)

if TEST:
    cap("1", "Test capture", "checking frame rate")
    wait(6)
else:
    # ---------- 1. dashboard
    cap("1", "Live mission dashboard", "18,000+ satellites & debris from CelesTrak, propagated live in your browser and coloured by altitude")
    wait(3)
    drag(1000, 520, 760, 470, 1.6); wait(1.2)
    click('#g-speed .chip[data-speed="600"]'); wait(3)
    click('#g-legend .chip[data-band="deb"]'); wait(1.6)
    click('#g-legend .chip[data-band="deb"]'); wait(1)
    click('#g-speed .chip[data-speed="1"]'); wait(1)
    cap("1", "Live telemetry for the selected satellite", "Orbit, position, sunlight and storm-drag sensitivity, updated every quarter second")
    click('#t-tabs button[data-t="pos"]'); wait(2.2)
    click('#t-tabs button[data-t="drag"]'); wait(2.2)
    click('#t-tabs button[data-t="orbit"]'); wait(1)
    scroll_to(560, 1.8)
    cap("1", "Alerts, safety pipeline and ISS close approaches", "Everything OrbitGuard found, in one place")
    wait(3.5)
    click("#bell"); wait(2.5); click("#bell"); wait(.6)
    scroll_to(0, 1.2)

    # ---------- 2. satellite finder: Hubble
    cap("2", "Satellite Finder: search any satellite", "Example: the Hubble Space Telescope (HST)")
    click("#top-search input")
    type_text("Hubble", .16)
    wait_for("document.querySelector('#top-search .sg-item')", 15)
    wait(1.4)
    key("Enter")
    wait_for("document.querySelector('#p-locate')", 30)
    cap("2", "Hubble located on the 3D globe", "Photo, mission, owner, launch facts and live orbit, from CelesTrak SATCAT + Wikipedia")
    wait(3.5)
    click("#p-locate"); wait(3)
    js("document.querySelector('#v-satellites [data-globe]').scrollIntoView({behavior:'smooth', block:'end'})"); wait(3)
    scroll_el("#profile .facts", "center", 1.6); wait(2.5)
    scroll_to(0, 1)

    # ---------- 3. close approaches for Hubble
    cap("3", "Close-approach alerts for Hubble", "SGP4 propagates every object at a similar altitude for the next 24 h and flags close passes")
    click("#p-conj")
    wait_for("document.querySelector('#conj-out table, #conj-out .empty')", 120)
    wait(2.5)
    scroll_el("#conj-out", "start", 1.6); wait(3)
    scroll_to(0, 1); wait(1.5)

    # ---------- 4. space weather + drag
    nav("weather")
    cap("4", "NASA DONKI space weather", "Geomagnetic storms, flares and CMEs, plus NOAA's live Kp index")
    wait_for("document.querySelector('#drag-table table, #drag-table .empty')", 60)
    wait(3)
    cap("4", "Storm drag alerts for low-orbit satellites", "Simulate a G3 storm (Kp 7): air at 450 km gets ~4x denser and flagged satellites glow on the globe")
    click('#kp-presets .chip[data-kp="7"]')
    wait_for("document.querySelector('#drag-table table')", 60)
    wait(3.5)
    scroll_el("#drag-table", "start", 1.8); wait(3)
    scroll_el("#kp-chart", "center", 1.8); wait(3)
    scroll_el("#sw-events", "start", 1.8); wait(2.5)
    scroll_to(0, 1)

    # ---------- 5. earth view: VIT Bhopal + ride under Hubble
    nav("earth")
    cap("5", "Earth View 3D", "Search any place and see it in 3D terrain, the way a satellite sees it")
    wait(3)
    click("#place-search input")
    type_text("VIT Bhopal", .14)
    wait_for("document.querySelector('#place-search .sg-item')", 20)
    wait(1.2)
    key("Enter")
    cap("5", "Flying to VIT Bhopal University", "Esri imagery on AWS terrain, with live list of satellites passing overhead")
    wait(9)
    click("#ev-tilt"); wait(3)
    click("#ev-tilt"); wait(4)
    nav("dashboard"); wait(2)
    cap("5", "Ride along under Hubble", "The 3D view follows Hubble's live ground track at 7.6 km/s")
    click("#h-ride")
    wait(11)
    click("#ride-badge .ride-stop"); wait(2.5)

    # ---------- 6. best orbit finder
    nav("planner")
    cap("6", "Best-orbit recommender", "Scores every orbit on safety, lifetime (5-year deorbit rule), coverage and launch cost, then explains the winner")
    wait(1.5)
    click("#opt-btn")
    wait_for("document.querySelector('#opt-out .reco')", 90)
    wait(4)
    scroll_el("#opt-out .reco", "center", 1.6); wait(3)
    scroll_to(0, 1)
    cap("6", "Or place the satellite in your own orbit", "Example: 420 km polar orbit, ranked against every other option")
    click('#own-orbit [data-alt="420"]'); wait(.8)
    click('#own-orbit [data-inc="90"]'); wait(.8)
    click("#opt-btn")
    wait_for("document.querySelector('#opt-out .cmp')", 90)
    wait(1.5)
    scroll_el("#opt-out .cmp", "start", 1.6); wait(4)
    scroll_el("#opt-chart-card", "center", 1.8); wait(3)
    scroll_to(0, 1)

    # ---------- 7. orbit changes + asteroids
    nav("changes")
    cap("7", "Orbit changes", "Detects maneuvers, plane changes, fast decay and re-entry risks between catalog snapshots")
    wait_for("document.querySelector('#dist-out table, #dist-out .empty, #dist-out .err')", 120)
    wait(4)
    nav("asteroids")
    cap("7", "Near-Earth asteroids", "NASA NeoWs and JPL close approaches, animated on a log scale around Earth and the Moon")
    wait(5)
    scroll_el("#ast-chart", "center", 1.8); wait(3)
    scroll_to(0, 1)

    # ---------- 8. errors + responsive
    cap("8", "Friendly errors everywhere", "Custom 404 page, plus clear error cards with hints and Retry in every section")
    wait(1.5)
    cap_off()
    navigate(BASE + "/this-page-is-lost-in-space")
    wait(.5)
    cap("8", "Custom 404: 'Lost in space'", "")
    wait(4)

    # ---------- outro
    card("<div><h1>OrbitGuard</h1><p>Turning scattered orbit data into clear decisions.</p>"
         "<div class='feat'><span>Live 3D satellite map</span><span>Close-approach alerts</span><span>NASA storm drag alerts</span>"
         "<span>Best-orbit recommender</span><span>Satellite Finder</span><span>Earth View 3D</span></div>"
         "<div class='meta'>Live: orbital-watch-z9bu.vercel.app · Code: github.com/sparsh26bas10063-gif/orbital-watch<br>"
         "Data: CelesTrak · NASA DONKI · NASA NeoWs · NASA/JPL · NOAA SWPC · Wikipedia · OpenStreetMap<br>Team AstroNex · ASTRA 2026</div></div>")
    wait(6)

cdp.send("Page.stopScreencast")
time.sleep(.5)
dur = time.time() - t_start
with flock:
    (WORK / "frames.json").write_text(json.dumps(frames))
print(f"recorded {len(frames)} frames in {dur:.1f}s -> {len(frames) / dur:.1f} fps")
proc.terminate()
