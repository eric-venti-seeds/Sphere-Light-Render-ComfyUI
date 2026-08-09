# Input-Driven Sphere Light Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every positioning param of the three light nodes graph-driveable — a connected input wins over its UI control and, via a synchronous browser round-trip, the output image matches the driven values on the same run.

**Architecture:** A new `render_bridge.py` owns the server side: it detects connected inputs from the `PROMPT`, `send_sync`s the resolved params to the browser, and blocks on a `threading.Event` until the browser POSTs the rendered PNG back to a custom route. `js/driven.js` receives the params, reflects them onto the node's controls, renders off-screen through the node's existing `getAngles`/`computeSunAngles` path, and POSTs the image. When no input is connected, `execute()` uses today's `decode_render_b64(render_b64)` path unchanged.

**Tech Stack:** ComfyUI custom node (Python 3 + PyTorch + aiohttp via `server.PromptServer`), vanilla ES-module JS, `node:test`, Python standalone test scripts.

## Global Constraints

- **Rendering stays client-side (Three.js).** No server/Python re-render of the sphere; the browser produces the pixels. Headless/API driving falls back to gray (documented).
- **The interactive path is unchanged.** When no positioning input is connected, `execute()` returns `decode_render_b64(render_b64)` exactly as today; no round-trip, no `send_sync`.
- **Reuse, don't duplicate.** Astronomy stays in `js/sun.js` (`computeSunAngles`); the driven render feeds pushed params through the *same* `getAngles` logic. Do not modify `solar.js`/`tz.js`/`geo.js`/`sun.js`/`cities.json`.
- **Node identity/behavior from the prior spec is preserved.** Display names, `CATEGORY="render/3d"`, `RETURN_TYPES=("IMAGE",)`, and the native-anchor compass/city persistence all stay.
- **Event-driven waiting, no polling/arbitrary sleeps.** `execute()` wakes on `event.set()`; a generous backstop timeout (30 s) plus a connected-client check are the only bounds.
- **Custom route + `send_sync` are module-level** (`from server import PromptServer`), never defined inside a node class.
- **Everything is keyed by `(node_id, run_token)`** so overlapping nodes / re-queues / duplicate tab responses never cross results.
- **Python tests:** standalone scripts under `tools/`, run `python tools/<name>.py`, print `<name>: OK`. **JS tests:** `node --test "js/*.test.js"` (the bare-dir form fails on a Windows/Node quirk).
- Commit after every task.

## File Structure

- **Create `render_bridge.py`** (repo root, sibling of `__init__.py`) — server side of the round-trip: `is_driven`, `build_payload`, the `(node_id, run_token)` registry, `request_render` (injectable wait logic), `deliver`, and the live ComfyUI wiring (`render`, the POST route, `send_sync`, client check). One clear responsibility; imported by `__init__.py`.
- **Modify `__init__.py`** — import `render_bridge`; add hidden `node_id`/`prompt` inputs to the three new node classes; branch `execute()` (driven → `render_bridge.render`, else `decode_render_b64`).
- **Create `js/driven.js`** — frontend listener: reflect pushed params, render off-screen, POST the PNG.
- **Modify `js/nodes.js`** — refactor `getAngles` to accept an optional pushed-params object; expose the node's render + reflect hooks to `driven.js`.
- **Modify `js/preview.js`** — `attachPreview` returns `renderWith(params)`.
- **Create `tools/test_render_bridge.py`** — Python tests for `is_driven`, `build_payload`, `request_render`, `deliver`.
- **Modify `README.md`** — document driven mode + the browser-open requirement.

## Positioning params per node (used by `is_driven`)

```
MANUAL  = ["rotation", "elevation", "intensity"]
CITY    = ["intensity", "city", "year", "month", "day", "hour", "minute", "heading"]
COORDS  = ["intensity", "latitude", "longitude", "year", "month", "day", "hour", "minute", "heading"]
```
(`render_b64` is transport, never a positioning param.)

---

### Task 1: `render_bridge.py` — pure helpers (`is_driven`, `build_payload`)

**Files:**
- Create: `render_bridge.py`
- Test: `tools/test_render_bridge.py`

**Interfaces:**
- Produces:
  - `is_driven(prompt: dict, node_id, param_names: list) -> bool` — `True` if, in `prompt[str(node_id)]["inputs"]`, any name in `param_names` maps to a **list** (a `[upstream_id, slot]` link) rather than a literal. Missing node/inputs → `False`.
  - `build_payload(node_id, run_token, params: dict) -> dict` → `{"node_id": str(node_id), "run_token": run_token, "params": params}`.

- [ ] **Step 1: Write the failing test**

Create `tools/test_render_bridge.py`:

```python
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import render_bridge as rb

# is_driven: a link is a [id, slot] list; a literal is a scalar.
PROMPT = {"7": {"inputs": {
    "heading": ["3", 0],          # connected
    "intensity": 1.5,             # literal widget value
    "city": "Austin, TX",
}, "class_type": "SphereLightSunCityNode"}}

assert rb.is_driven(PROMPT, "7", ["heading", "intensity"]) is True   # heading is a link
assert rb.is_driven(PROMPT, "7", ["intensity", "city"]) is False     # all literals
assert rb.is_driven(PROMPT, 7, ["heading"]) is True                  # int node_id coerced
assert rb.is_driven(PROMPT, "999", ["heading"]) is False             # missing node
assert rb.is_driven({}, "7", ["heading"]) is False                   # empty prompt

p = rb.build_payload("7", "tok1", {"heading": 90})
assert p == {"node_id": "7", "run_token": "tok1", "params": {"heading": 90}}, p

print("test_render_bridge: OK")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python tools/test_render_bridge.py`
Expected: FAIL — `ModuleNotFoundError: No module named 'render_bridge'`.

- [ ] **Step 3: Create `render_bridge.py` with the pure helpers**

```python
# Server side of the input-driven render round-trip. The heavy ComfyUI wiring
# (route, send_sync, event wait) is added in later tasks; these two helpers are
# pure and import nothing.

def is_driven(prompt, node_id, param_names):
    """True if any of param_names is a connected input (a [upstream_id, slot]
    link) for this node in the prompt graph, rather than a literal widget value."""
    try:
        inputs = prompt[str(node_id)]["inputs"]
    except (KeyError, TypeError):
        return False
    return any(isinstance(inputs.get(name), list) for name in param_names)


def build_payload(node_id, run_token, params):
    return {"node_id": str(node_id), "run_token": run_token, "params": params}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python tools/test_render_bridge.py`
Expected: `test_render_bridge: OK`.

- [ ] **Step 5: Commit**

```bash
git add render_bridge.py tools/test_render_bridge.py
git commit -m "feat: render_bridge is_driven/build_payload pure helpers"
```

---

### Task 2: `render_bridge.py` — registry + `request_render` wait logic

**Files:**
- Modify: `render_bridge.py`
- Test: `tools/test_render_bridge.py` (extend)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces:
  - `request_render(node_id, run_token, notify, client_connected, timeout=30.0) -> str | None` — registers a `threading.Event` under `(str(node_id), run_token)`; if `client_connected()` is falsy, returns `None` immediately (no browser); else calls `notify()` (which fires the browser message) and blocks on `event.wait(timeout)`. Returns the delivered image string on success, or `None` on timeout/no-client. Always removes the registry entry before returning.
  - `deliver(node_id, run_token, image) -> bool` — stores `image` and sets the event for `(node_id, run_token)`. Returns `True` if a matching pending entry existed, `False` for an unknown/stale token.

- [ ] **Step 1: Write the failing test (append)**

Append to `tools/test_render_bridge.py` (before the final print):

```python
import threading, time

# Success: a "browser" thread delivers the image; request_render returns it.
def deliver_later(node_id, token, image, delay):
    time.sleep(delay)
    rb.deliver(node_id, token, image)

t = threading.Thread(target=deliver_later, args=("7", "tokA", "data:image/png;base64,AAAA", 0.05))
t.start()
got = rb.request_render("7", "tokA", notify=lambda: None, client_connected=lambda: True, timeout=2.0)
t.join()
assert got == "data:image/png;base64,AAAA", got

# No client connected -> immediate None, notify never called.
called = []
none1 = rb.request_render("7", "tokB", notify=lambda: called.append(1), client_connected=lambda: False, timeout=2.0)
assert none1 is None and called == [], (none1, called)

# Timeout (nobody delivers) -> None.
t0 = time.time()
none2 = rb.request_render("7", "tokC", notify=lambda: None, client_connected=lambda: True, timeout=0.2)
assert none2 is None, none2
assert time.time() - t0 < 1.0  # returned promptly at the timeout, not hung

# deliver for an unknown token is a no-op returning False.
assert rb.deliver("7", "no-such-token", "x") is False
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python tools/test_render_bridge.py`
Expected: FAIL — `AttributeError: module 'render_bridge' has no attribute 'request_render'`.

- [ ] **Step 3: Implement the registry + wait**

Add to `render_bridge.py` (after the imports at the top add `import threading`):

```python
import threading

# (node_id, run_token) -> {"event": Event, "image": None}
_pending = {}
_lock = threading.Lock()


def request_render(node_id, run_token, notify, client_connected, timeout=30.0):
    key = (str(node_id), run_token)
    event = threading.Event()
    with _lock:
        _pending[key] = {"event": event, "image": None}
    try:
        if not client_connected():
            return None            # no browser to render -> caller falls back
        notify()                   # tell the browser to render + post back
        if not event.wait(timeout):
            return None            # backstop: frozen/absent tab
        with _lock:
            return _pending[key]["image"]
    finally:
        with _lock:
            _pending.pop(key, None)


def deliver(node_id, run_token, image):
    key = (str(node_id), run_token)
    with _lock:
        entry = _pending.get(key)
        if entry is None:
            return False           # stale/unknown token
        entry["image"] = image
        entry["event"].set()
        return True
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python tools/test_render_bridge.py`
Expected: `test_render_bridge: OK`.

- [ ] **Step 5: Commit**

```bash
git add render_bridge.py tools/test_render_bridge.py
git commit -m "feat: render_bridge event registry + request_render wait logic"
```

---

### Task 3: `render_bridge.py` — live ComfyUI wiring (route, send_sync, `render`)

**Files:**
- Modify: `render_bridge.py`

**Interfaces:**
- Consumes: `request_render`, `deliver`, `build_payload` (Tasks 1–2).
- Produces:
  - `render(node_id, params) -> str | None` — public entry the nodes call: mints a `run_token` (`uuid.uuid4().hex`), and calls `request_render` with the live `notify`/`client_connected`. Returns the browser-rendered dataURL or `None`.
  - Module import registers `POST /sphere_light/result`.

**This task touches live ComfyUI APIs. Each is marked with how to verify it; treat the manual verification as the task's test.**

- [ ] **Step 1: Add the live wiring**

Add to `render_bridge.py` (top-level imports: `import uuid`; and the ComfyUI server import guarded so the module still imports in the test harness):

```python
import uuid

try:
    from server import PromptServer          # available inside ComfyUI
except Exception:                             # standalone test harness
    PromptServer = None

RENDER_EVENT = "sphere_light.render"
RESULT_ROUTE = "/sphere_light/result"


def _client_connected():
    # PromptServer.instance.sockets is a dict of sid -> websocket. Non-empty
    # means at least one browser tab is listening. VERIFY the attribute name
    # against your ComfyUI (older builds: .sockets; confirm in a REPL / spike).
    inst = getattr(PromptServer, "instance", None)
    return bool(inst and getattr(inst, "sockets", None))


def render(node_id, params, timeout=30.0):
    if PromptServer is None:
        return None
    run_token = uuid.uuid4().hex
    payload = build_payload(node_id, run_token, params)
    def notify():
        # send_sync is broadcast; the frontend filters by node_id. Safe to call
        # from the execution worker thread (it schedules onto the event loop).
        PromptServer.instance.send_sync(RENDER_EVENT, payload)
    return request_render(node_id, run_token, notify, _client_connected, timeout)


# --- POST route: the browser returns the rendered PNG here ---
if PromptServer is not None:
    @PromptServer.instance.routes.post(RESULT_ROUTE)
    async def _sphere_light_result(request):
        from aiohttp import web
        data = await request.json()          # {node_id, run_token, image}
        ok = deliver(data.get("node_id"), data.get("run_token"), data.get("image"))
        return web.json_response({"ok": ok})
```

- [ ] **Step 2: Confirm the standalone tests still pass**

Run: `python tools/test_render_bridge.py`
Expected: `test_render_bridge: OK` (the `try/except` import guard keeps `PromptServer=None` in the harness, so Tasks 1–2 tests are unaffected).

- [ ] **Step 3: Manual verification in ComfyUI (the route + send_sync are live)**

Restart ComfyUI. In the browser devtools console, confirm the route exists and the event plumbing is reachable:
```js
// route is registered (expects {"ok": false} for an unknown token):
await (await fetch("/sphere_light/result", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({node_id:"x", run_token:"y", image:"z"})})).json()
```
Expected: `{ok: false}` (route reachable; `deliver` returns False for the unknown token). If you get a 404, the route registration didn't take — check `PromptServer.instance.routes` is the right attribute for your build (mine against core `Preview3DAdvanced`/the docs `comms_routes`).

- [ ] **Step 4: Commit**

```bash
git add render_bridge.py
git commit -m "feat: render_bridge live wiring (send_sync + /sphere_light/result route)"
```

---

### Task 4: `__init__.py` — hidden inputs + driven/interactive branch in `execute()`

**Files:**
- Modify: `__init__.py`
- Test: `tools/test_new_nodes.py` (extend) — or a new `tools/test_driven_execute.py`

**Interfaces:**
- Consumes: `render_bridge.is_driven`, `render_bridge.render`; existing `decode_render_b64`.
- Produces: each new node declares `"hidden": {"node_id": "UNIQUE_ID", "prompt": "PROMPT"}`; `execute()` returns the driven image when any positioning input is connected, else `decode_render_b64(render_b64)`.

- [ ] **Step 1: Write the failing test**

Create `tools/test_driven_execute.py`:

```python
import sys, types, importlib.util, os
import numpy as np

faketorch = types.ModuleType("torch")
class FT:
    def __init__(self, a): self.a = a
    def unsqueeze(self, d): return FT(np.expand_dims(self.a, d))
    @property
    def shape(self): return self.a.shape
faketorch.from_numpy = lambda a: FT(a)
sys.modules["torch"] = faketorch

NODE = os.path.join(os.path.dirname(__file__), "..", "__init__.py")
spec = importlib.util.spec_from_file_location("slnode", NODE)
mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)

# Stub render_bridge on the loaded module so no ComfyUI is needed.
import render_bridge as rb
calls = {}
rb.render = lambda node_id, params, **kw: (calls.__setitem__("params", params) or
    "data:image/png;base64,AAAA")  # pretend the browser rendered a 1x1

# Hidden inputs are declared.
city_it = mod.SphereLightSunCityNode.INPUT_TYPES()
assert city_it.get("hidden") == {"node_id": "UNIQUE_ID", "prompt": "PROMPT"}, city_it.get("hidden")

# Driven mode: heading is a link in the prompt -> execute calls render_bridge.render.
node = mod.SphereLightSunCityNode()
prompt = {"5": {"inputs": {"heading": ["9", 0]}}}
(t,) = node.execute(1.5, "Austin, TX", 2025, 6, 21, 12, 0, 0.0, "", node_id="5", prompt=prompt)
assert tuple(t.shape) == (1, 1024, 1024, 3), t.shape
assert calls["params"]["heading"] == 0.0            # resolved params passed through
assert calls["params"]["city"] == "Austin, TX"

# Interactive mode: nothing connected -> decode_render_b64 path (empty -> gray), render NOT called.
calls.clear()
(t,) = node.execute(1.5, "Austin, TX", 2025, 6, 21, 12, 0, 0.0, "", node_id="5", prompt={"5": {"inputs": {}}})
assert tuple(t.shape) == (1, 1024, 1024, 3), t.shape
assert "params" not in calls                        # render_bridge.render was not called

print("test_driven_execute: OK")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python tools/test_driven_execute.py`
Expected: FAIL — the `hidden` assertion fails (no hidden inputs yet).

- [ ] **Step 3: Implement — import, hidden inputs, branch**

In `__init__.py`, add near the top (after the existing imports):

```python
import render_bridge

_POS_PARAMS = {
    "SphereLightManualNode": ["rotation", "elevation", "intensity"],
    "SphereLightSunCityNode": ["intensity", "city", "year", "month", "day", "hour", "minute", "heading"],
    "SphereLightSunCoordsNode": ["intensity", "latitude", "longitude", "year", "month", "day", "hour", "minute", "heading"],
}

def _render(node_id, prompt, cls_name, params, render_b64):
    """Driven mode (a positioning input is connected) -> browser round-trip;
    else the interactive render_b64 path. Falls back to render_b64/gray if the
    round-trip yields nothing (no browser, timeout)."""
    if prompt and render_bridge.is_driven(prompt, node_id, _POS_PARAMS[cls_name]):
        img = render_bridge.render(node_id, params)
        return decode_render_b64(img if img else render_b64)
    return decode_render_b64(render_b64)
```

Then, for **each** of the three new classes: add `"hidden": {"node_id": "UNIQUE_ID", "prompt": "PROMPT"}` to the `INPUT_TYPES()` return dict (a sibling key to `"required"`), and rewrite `execute` to accept `node_id`/`prompt` and delegate. Example for `SphereLightSunCityNode`:

```python
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": { ... unchanged ... },
            "hidden": {"node_id": "UNIQUE_ID", "prompt": "PROMPT"},
        }

    def execute(self, intensity, city, year, month, day, hour, minute, heading, render_b64, node_id=None, prompt=None):
        params = {"intensity": intensity, "city": city, "year": year, "month": month,
                  "day": day, "hour": hour, "minute": minute, "heading": heading}
        return (_render(node_id, prompt, "SphereLightSunCityNode", params, render_b64),)
```

Apply the analogous change to `SphereLightManualNode` (params: `rotation`/`elevation`/`intensity`) and `SphereLightSunCoordsNode` (params: `intensity`/`latitude`/`longitude`/`year`.../`heading`). Keep every `required` block, signature order (hidden kwargs last), and `SphereLightNode` (kitchen-sink) exactly as they are.

- [ ] **Step 4: Run tests to verify they pass**

Run: `python tools/test_driven_execute.py && python tools/test_new_nodes.py && python tools/test_inputs.py && python tools/test_decode.py`
Expected: all print `... OK`. (`test_new_nodes.py` still passes — hidden inputs don't change the `required` assertions.)

- [ ] **Step 5: Commit**

```bash
git add __init__.py tools/test_driven_execute.py
git commit -m "feat: driven/interactive branch + hidden node_id/prompt inputs"
```

---

### Task 5: `getAngles(pushedParams)` + `renderWith` (JS refactor)

**Files:**
- Modify: `js/nodes.js`
- Modify: `js/preview.js`

**Interfaces:**
- Consumes: `attachPreview` (from `preview.js`), the existing `getAngles` in `nodes.js`.
- Produces:
  - `getAngles(pushed)` in `nodes.js` — when `pushed` is provided, uses `pushed.<name>` in place of `getVal/getStr(node, <name>)`; otherwise reads widgets exactly as today. Same return `{az, el, intensity}`, same `computeSunAngles` call.
  - `renderWith(params) -> dataURL` on the object returned by `attachPreview` — `renderLight(ctx, getAngles(params))` then `ctx.canvas.toDataURL("image/png")`. `render()`/`scheduleRender()` unchanged (widget-driven).

- [ ] **Step 1: Refactor `getAngles` to accept pushed params**

In `js/nodes.js`, change `setupSun`'s `getAngles` (and `setupManual`'s) to take an optional `pushed` object. Replace each `getVal(node, "X", d)` with `pick("X", d)` and `getStr(node, "X", d)` with `pickStr("X", d)`, where near the top of `getAngles`:

```javascript
  const getAngles = (pushed) => {
    const num = (name, d) => pushed && pushed[name] != null ? parseFloat(pushed[name]) : getVal(node, name, d);
    const str = (name, d) => pushed && pushed[name] != null ? String(pushed[name]) : getStr(node, name, d);
    const intensity = num("intensity", 1.5);
    // ...use num("heading",0), num("latitude",0), str("city",""), num("year",2025), etc.
    //    everywhere the body currently calls getVal/getStr.
  };
```
(Manual's `getAngles` becomes `(pushed) => ({ az: num("rotation",0), el: num("elevation",45), intensity: num("intensity",1.5) })` with the same `num` helper.)

- [ ] **Step 2: Expose `renderWith` from `attachPreview`**

In `js/preview.js`, inside `attachPreview`, after `render`/`scheduleRender` are defined, add:

```javascript
  const renderWith = (params) => {
    const b64 = renderLight(ctx, getAngles(params));   // getAngles passed in by the caller
    return b64;
  };
```
`attachPreview(node, getAngles)` already receives `getAngles`; return `renderWith` alongside the existing members:
```javascript
  return { ctx, render, scheduleRender, renderWith, TOP_WIDGETS_H, previewWidget };
```

- [ ] **Step 3: Verify the interactive path is unchanged**

Run: `node --test "js/*.test.js"`
Expected: 49/49 still pass (no unit test imports `nodes.js`/`preview.js`; this confirms no syntax/regression in the tested modules). Then `node --check js/nodes.js && node --check js/preview.js` → clean.

- [ ] **Step 4: Manual check in ComfyUI**

Restart ComfyUI; add each node; confirm the interactive render/compass/city/status behave exactly as before (the `pushed`-less `getAngles()` path is today's behavior). No driving yet — that's Task 6.

- [ ] **Step 5: Commit**

```bash
git add js/nodes.js js/preview.js
git commit -m "refactor: getAngles accepts pushed params; attachPreview exposes renderWith"
```

---

### Task 6: `js/driven.js` — reflect, render, POST (the browser half of the round-trip)

**Files:**
- Create: `js/driven.js`
- Modify: `js/nodes.js` (stash a per-node driven hook)

**Interfaces:**
- Consumes: the `RENDER_EVENT` `"sphere_light.render"` payload `{node_id, run_token, params}`; the node's `renderWith(params)` and its reflect controls (compass/search/native widgets).
- Produces: on each event, applies params (reflect), renders, and POSTs `{node_id, run_token, image}` to `/sphere_light/result`.

- [ ] **Step 1: Expose a per-node driven hook in `nodes.js`**

In `setupSun`/`setupManual`, after `attachPreview` resolves, stash a hook on the node so `driven.js` can reach the render + reflect for that node id:

```javascript
  node._slDriven = {
    renderWith,                                   // from attachPreview
    reflect: (p) => {                             // mirror pushed values onto controls
      if (p.heading != null && node._slCompass) node._slCompass.setValue(parseFloat(p.heading));
      if (p.city != null && node._slSearch) node._slSearch.setText(String(p.city));
      for (const name of ["intensity","latitude","longitude","year","month","day","hour","minute","rotation","elevation"]) {
        if (p[name] == null) continue;
        const w = node.widgets?.find((w) => w.name === name);
        if (w) w.value = p[name];
      }
      app.graph.setDirtyCanvas(true, false);
    },
  };
```
(Destructure `renderWith` from the `attachPreview` return.)

- [ ] **Step 2: Create `js/driven.js`**

```javascript
import { app } from "../../scripts/app.js";

// Server → browser: execute() pushed the graph-resolved params; render the sphere
// with them and POST the PNG back so execute() can return it as the IMAGE output.
app.registerExtension({
  name: "SphereLightDriven",
  async setup() {
    app.api.addEventListener("sphere_light.render", async (event) => {
      const { node_id, run_token, params } = event.detail || {};
      const node = app.graph?.getNodeById?.(Number(node_id)) || app.graph?.getNodeById?.(node_id);
      const driven = node?._slDriven;
      let image = null;
      try {
        if (driven) {
          driven.reflect(params);          // mirror onto the compass/fields
          image = driven.renderWith(params); // off-screen render from pushed params
        }
      } catch (e) {
        console.warn("[SphereLight] driven render failed:", e);
      }
      // Always answer (even with null) so execute() unblocks fast instead of waiting the backstop.
      try {
        await fetch("/sphere_light/result", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ node_id, run_token, image }),
        });
      } catch (e) {
        console.warn("[SphereLight] result POST failed:", e);
      }
    });
  },
});
```
Register `driven.js` alongside the others — it is picked up automatically from `WEB_DIRECTORY = "./js"`.

Note: `image` may be `null` (node not on this tab, or render threw). `deliver` stores `null` and `execute()`'s `_render` falls back to `render_b64`/gray. That's intended.

- [ ] **Step 3: Manual verification in ComfyUI (the full round-trip — the gate)**

Restart ComfyUI. Add a `🔆 Sphere Light — Sun (Coordinates)` node. Add a **Primitive** (or any FLOAT source) and wire it to the node's `heading` input (convert `heading` to an input if needed). Set the primitive to `90`, queue:
- The compass needle reflects to 90° and the rendered image shows the light from that heading.
- Change the primitive to `270`, queue again → image updates to match on that run (no one-hop lag).
- Disconnect the primitive → the node is interactive again (dial drives).
- Close the browser tab mid-queue (or queue with no tab) → the run **falls back to gray and does not hang** the queue.

- [ ] **Step 4: Confirm JS unit tests still green**

Run: `node --test "js/*.test.js"` → 49/49. `node --check js/driven.js js/nodes.js` → clean.

- [ ] **Step 5: Commit**

```bash
git add js/driven.js js/nodes.js
git commit -m "feat: driven.js browser round-trip (reflect + render + POST)"
```

---

### Task 7: README + full manual gate

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document driven mode**

In `README.md`, under the `## Nodes` section, add:

```markdown
### Driving inputs from the graph

Every positioning parameter (heading, lat/lon, date/time, intensity, and Manual's
rotation/elevation) can be driven by an upstream node: convert the widget to an
input and wire it. A connected input **wins** over the on-node control, and the
control **reflects** the driven value after each run.

**Requires an open ComfyUI browser tab.** The sphere renders client-side, so a
driven run asks the browser to render and return the image. A headless/API run
with a driven input has no browser to render and falls back to a gray image — use
the widgets (no connections) for headless workflows.
```

- [ ] **Step 2: Full manual gate**

Confirm, in ComfyUI with a tab open: (a) driving `heading`, `latitude`, `hour` each updates the rendered image on the same queue and reflects onto the controls; (b) mixed driven+widget params compose correctly; (c) an auto-queue loop driving an incrementing `hour` produces a correct sun sweep frame-by-frame; (d) closing the tab mid-run falls back to gray without hanging the queue.

- [ ] **Step 3: Final test sweep**

Run: `node --test "js/*.test.js" && python tools/test_render_bridge.py && python tools/test_driven_execute.py && python tools/test_new_nodes.py && python tools/test_inputs.py && python tools/test_decode.py`
Expected: JS 49/49; every Python script prints `... OK`.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: document graph-driven inputs and the browser-open requirement"
```

---

## Self-Review

**Spec coverage:**
- Inputs win when connected; else UI → Task 4 (`is_driven` branch), Task 5/6 (pushed params render). ✓
- Reflect-on-connect → Task 6 (`reflect`). ✓
- Synchronous round-trip (send_sync → browser render → POST → return) → Tasks 3, 4, 6. ✓
- `execute()` detects connected via `PROMPT` → Task 1 (`is_driven`) + Task 4 (hidden `prompt`). ✓
- Layered event-driven failure (client check, backstop timeout, fallback) → Task 2 (`request_render`) + Task 3 (`_client_connected`) + Task 4 (`img or render_b64`). ✓
- `(node_id, run_token)` concurrency keying → Task 2. ✓
- Shared astronomy (no duplication) → Task 5 (`getAngles(pushed)`). ✓
- Interactive path unchanged → Task 4 (non-driven branch), Task 5 (pushed-less `getAngles`). ✓
- Browser-open documented → Task 7. ✓
- Reference `Preview3DAdvanced` for the fiddly convert-to-input/reflect visibility → called out in Task 3/6 verification.

**Deferred / honest gaps (integration, not unit-testable here):**
- Client-disconnect **fast-fail** and ComfyUI **cancel** wake (spec's failure items 2–3) are approximated by the connected-client pre-check + backstop timeout in this plan. True disconnect/cancel-driven wake needs live PromptServer hooks — verify feasibility during Task 3's manual step; if easy, add a follow-up; the pre-check + 30 s backstop is the safe MVP and never hangs the queue.
- The `PromptServer.instance.sockets` attribute name and `routes.post` availability are version-dependent — Task 3 Step 3 verifies both against the running build before Tasks 4/6 build on them.

**Placeholder scan:** No "TBD"/"handle edge cases". Integration lines that depend on the live build carry explicit verify-in-ComfyUI steps rather than being hand-waved.

**Type consistency:** `is_driven(prompt, node_id, param_names)`, `build_payload(node_id, run_token, params)`, `request_render(...ure...)->str|None`, `deliver(...)->bool`, `render(node_id, params)->str|None` are consistent across Tasks 1–4. JS `renderWith(params)->dataURL`, `node._slDriven.{renderWith,reflect}` consistent across Tasks 5–6. Payload shape `{node_id, run_token, params}` / result `{node_id, run_token, image}` consistent across Python (Tasks 3–4) and JS (Task 6).
