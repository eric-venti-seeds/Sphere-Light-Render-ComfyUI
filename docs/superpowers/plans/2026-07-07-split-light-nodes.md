# Split Light Nodes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three flat, single-purpose ComfyUI nodes — Manual / Sun (City) / Sun (Coordinates) — alongside the frozen kitchen-sink node, sharing one render engine.

**Architecture:** Extract the Three.js engine and preview-widget scaffolding out of `js/sphere_widget.js` into a reusable `js/preview.js`; the kitchen-sink and all three new nodes import it. The new nodes declare only their own inputs (no mode/location toggles, no show/hide). Their compass and city-search DOM widgets serialize their own values, so the native `heading`/`location` anchors are dropped — gated on a save/reload round-trip in both ComfyUI frontends. Python gains one shared `decode_render_b64` helper.

**Tech Stack:** ComfyUI custom node (Python 3 + PyTorch), vanilla ES-module JS, Three.js (vendored), Node's built-in `node:test` runner.

## Global Constraints

- **Kitchen-sink `SphereLightNode` behavior is unchanged.** Only two edits are allowed to it: it imports the engine from `js/preview.js` instead of defining it inline, and its `execute()` calls `decode_render_b64`. Its `INPUT_TYPES`, toggles, and `applyVisibility` stay exactly as-is.
- **Astronomy/timezone/dataset are untouched:** do not modify `js/solar.js`, `js/tz.js`, `js/geo.js`, `js/sun.js`, or `js/cities.json`.
- **Rendering stays client-side.** Every node's `execute()` only decodes `render_b64` to an IMAGE tensor.
- **Every node:** `CATEGORY = "render/3d"`, `RETURN_TYPES = ("IMAGE",)`, `RETURN_NAMES = ("render",)`, `FUNCTION = "execute"`.
- **New node display names (verbatim):** `🔆 Sphere Light — Manual`, `🔆 Sphere Light — Sun (City)`, `🔆 Sphere Light — Sun (Coordinates)`. Class names: `SphereLightManualNode`, `SphereLightSunCityNode`, `SphereLightSunCoordsNode`.
- **New nodes serialize DOM widgets** (`serialize: true`) and do **not** declare native `heading`/`location`. If the round-trip gate (Task 6) fails in v2, apply the documented native-anchor fallback for the affected widget only.
- **JS tests** are `node:test` files (`*.test.js`), run with `node --test <file>` from the repo root (the `js/` dir is `"type": "module"`). **Python tests** are standalone scripts under `tools/` that stub `torch` and run with `python tools/<name>.py`, printing `<name>: OK`.
- Commit after every task.

## File Structure

- **Create `js/light.js`** — the pure `lightPosition` math helper (imports nothing from ComfyUI, so it is unit-testable under `node --test`).
- **Create `js/light.test.js`** — unit test for `lightPosition`.
- **Create `js/preview.js`** — node-agnostic render engine + preview-widget scaffolding + generic widget helpers; imports `lightPosition` from `./light.js` and `app` from ComfyUI. Imported by the kitchen-sink and the three new nodes.
- **Create `js/status.js`** — pure helpers `haversineKm` + `nearestCityLabel` for the read-only status line.
- **Create `js/status.test.js`** — unit tests for `status.js`.
- **Create `js/nodes.js`** — registers the three new nodes (`setupManual`, `setupSun`) using `preview.js`, `compass.js`, `location_search.js`, `sun.js`, `geo.js`, `status.js`.
- **Modify `js/sphere_widget.js`** — import the engine from `preview.js` instead of defining `loadThree`/`buildScene`/render math/preview widget inline. No behavior change.
- **Modify `__init__.py`** — add `decode_render_b64`; add the three node classes; register them; kitchen-sink `execute()` calls the helper.
- **Create `tools/test_decode.py`** — Python test for `decode_render_b64`.
- **Create `tools/test_new_nodes.py`** — Python test for the three nodes' `INPUT_TYPES` + `execute`.
- **Modify `README.md`** — document the three new nodes (Task 6).

---

### Task 1: Python `decode_render_b64` helper

**Files:**
- Modify: `__init__.py` (extract the decode body from `SphereLightNode.execute`, `__init__.py:43-78`)
- Test: `tools/test_decode.py` (create)

**Interfaces:**
- Produces: `decode_render_b64(render_b64: str) -> tensor` — module-level function in `__init__.py`. Returns a torch tensor of shape `(1, 1024, 1024, 3)`, float32 in `[0,1]`. Empty/invalid/oversized input yields the gray fallback image. Same behavior the current `execute()` has inline.

- [ ] **Step 1: Write the failing test**

Create `tools/test_decode.py`:

```python
import sys, types, importlib.util, os, base64, io
import numpy as np
from PIL import Image

# Stub torch so __init__.py imports without the real dependency.
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

# Empty input -> gray fallback, correct shape.
t = mod.decode_render_b64("")
assert tuple(t.shape) == (1, 1024, 1024, 3), t.shape

# A tiny red PNG data-URI decodes to the target size.
buf = io.BytesIO()
Image.new("RGB", (4, 4), (255, 0, 0)).save(buf, format="PNG")
uri = "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()
t2 = mod.decode_render_b64(uri)
assert tuple(t2.shape) == (1, 1024, 1024, 3), t2.shape

print("test_decode: OK")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python tools/test_decode.py`
Expected: FAIL with `AttributeError: module 'slnode' has no attribute 'decode_render_b64'`.

- [ ] **Step 3: Extract the helper**

In `__init__.py`, add a module-level function above the class (after the constants at `__init__.py:12`), moving the decode logic verbatim from `execute` (`__init__.py:50-78`):

```python
def decode_render_b64(render_b64):
    """Decode a data-URI PNG from the (untrusted) workflow into a
    (1,1024,1024,3) float32 tensor. Empty/invalid/oversized -> gray fallback."""
    img = None
    if render_b64 and render_b64.startswith("data:image"):
        if len(render_b64) > MAX_B64_CHARS:
            print(f"[SphereLightNode] render_b64 too large "
                  f"({len(render_b64)} chars); using gray fallback")
        else:
            try:
                header, data = render_b64.split(",", 1)
                img_bytes = base64.b64decode(data, validate=True)
                probe = Image.open(io.BytesIO(img_bytes))
                w, h = probe.size
                if w > MAX_IMAGE_SIDE or h > MAX_IMAGE_SIDE:
                    raise ValueError(f"image dimensions too large: {w}x{h}")
                img = probe.convert("RGB").resize(
                    (TARGET_SIZE, TARGET_SIZE), Image.LANCZOS)
            except Exception as e:
                print(f"[SphereLightNode] Error decoding render_b64: {e}")
                img = None
    else:
        print("[SphereLightNode] no render_b64 provided; using gray fallback")

    if img is None:
        img = Image.new("RGB", (TARGET_SIZE, TARGET_SIZE), FALLBACK_GRAY)

    arr = np.array(img).astype(np.float32) / 255.0
    return torch.from_numpy(arr).unsqueeze(0)
```

Then replace the body of `SphereLightNode.execute` (`__init__.py:50-78`) with a single call, keeping the same signature:

```python
        tensor = decode_render_b64(render_b64)
        return (tensor,)
```

- [ ] **Step 4: Run both Python tests to verify they pass**

Run: `python tools/test_decode.py && python tools/test_inputs.py`
Expected: `test_decode: OK` and `test_inputs: OK`.

- [ ] **Step 5: Commit**

```bash
git add __init__.py tools/test_decode.py
git commit -m "refactor: extract decode_render_b64 helper"
```

---

### Task 2: Python — three new node classes

**Files:**
- Modify: `__init__.py` (add three classes + registrations, after `SphereLightNode`, `__init__.py:81-82`)
- Test: `tools/test_new_nodes.py` (create)

**Interfaces:**
- Consumes: `decode_render_b64` (Task 1).
- Produces: classes `SphereLightManualNode`, `SphereLightSunCityNode`, `SphereLightSunCoordsNode`, all registered in `NODE_CLASS_MAPPINGS` / `NODE_DISPLAY_NAME_MAPPINGS`. Each `execute(...)` returns `(decode_render_b64(render_b64),)`.

- [ ] **Step 1: Write the failing test**

Create `tools/test_new_nodes.py`:

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

# Manual node: only rotation/elevation/intensity/render_b64; no heading/location.
man = mod.SphereLightManualNode.INPUT_TYPES()["required"]
for k in ["rotation", "elevation", "intensity", "render_b64"]:
    assert k in man, f"manual missing {k}"
for k in ["heading", "location", "latitude", "longitude", "sun_mode", "location_mode"]:
    assert k not in man, f"manual should not declare {k}"

# Sun (City): city + date/time + intensity + render_b64; no heading/location/latlon.
city = mod.SphereLightSunCityNode.INPUT_TYPES()["required"]
for k in ["intensity", "city", "year", "month", "day", "hour", "minute", "render_b64"]:
    assert k in city, f"city missing {k}"
for k in ["heading", "location", "latitude", "longitude"]:
    assert k not in city, f"city should not declare {k}"

# Sun (Coords): lat/lon (native) + date/time + intensity + render_b64; no heading/city.
coord = mod.SphereLightSunCoordsNode.INPUT_TYPES()["required"]
for k in ["intensity", "latitude", "longitude", "year", "month", "day", "hour", "minute", "render_b64"]:
    assert k in coord, f"coords missing {k}"
for k in ["heading", "city", "location"]:
    assert k not in coord, f"coords should not declare {k}"

# Registration + display names.
for cls in ["SphereLightManualNode", "SphereLightSunCityNode", "SphereLightSunCoordsNode"]:
    assert cls in mod.NODE_CLASS_MAPPINGS, f"{cls} not registered"
assert mod.NODE_DISPLAY_NAME_MAPPINGS["SphereLightManualNode"] == "🔆 Sphere Light — Manual"
assert mod.NODE_DISPLAY_NAME_MAPPINGS["SphereLightSunCityNode"] == "🔆 Sphere Light — Sun (City)"
assert mod.NODE_DISPLAY_NAME_MAPPINGS["SphereLightSunCoordsNode"] == "🔆 Sphere Light — Sun (Coordinates)"

# execute() returns a (1,1024,1024,3) tensor for each (empty render_b64 -> gray).
(t,) = mod.SphereLightManualNode().execute(0.0, 45.0, 1.5, "")
assert tuple(t.shape) == (1, 1024, 1024, 3), t.shape
(t,) = mod.SphereLightSunCityNode().execute(1.5, "Austin, TX", 2025, 6, 21, 12, 0, "")
assert tuple(t.shape) == (1, 1024, 1024, 3), t.shape
(t,) = mod.SphereLightSunCoordsNode().execute(1.5, 30.27, -97.74, 2025, 6, 21, 12, 0, "")
assert tuple(t.shape) == (1, 1024, 1024, 3), t.shape

print("test_new_nodes: OK")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python tools/test_new_nodes.py`
Expected: FAIL with `AttributeError: module 'slnode' has no attribute 'SphereLightManualNode'`.

- [ ] **Step 3: Add the three classes and register them**

In `__init__.py`, after `SphereLightNode` (before `NODE_CLASS_MAPPINGS` at `__init__.py:81`), add:

```python
class SphereLightManualNode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "rotation":  ("FLOAT", {"default": 0.0,  "min": -180, "max": 180, "step": 1,   "display": "slider"}),
                "elevation": ("FLOAT", {"default": 45.0, "min": 5,    "max": 85,  "step": 1,   "display": "slider"}),
                "intensity": ("FLOAT", {"default": 1.5,  "min": 0.2,  "max": 3.0, "step": 0.1, "display": "slider"}),
                "render_b64": ("STRING", {"default": "", "multiline": False}),
            }
        }
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("render",)
    FUNCTION = "execute"
    CATEGORY = "render/3d"
    OUTPUT_NODE = False

    def execute(self, rotation, elevation, intensity, render_b64):
        return (decode_render_b64(render_b64),)


class SphereLightSunCityNode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "intensity": ("FLOAT", {"default": 1.5, "min": 0.2, "max": 3.0, "step": 0.1, "display": "slider"}),
                "city":      ("STRING", {"default": "Austin, TX", "multiline": False}),
                "year":      ("INT", {"default": 2025, "min": 1, "max": 9999}),
                "month":     ("INT", {"default": 6,  "min": 1,  "max": 12}),
                "day":       ("INT", {"default": 21, "min": 1,  "max": 31}),
                "hour":      ("INT", {"default": 12, "min": 0,  "max": 23}),
                "minute":    ("INT", {"default": 0,  "min": 0,  "max": 59}),
                "render_b64": ("STRING", {"default": "", "multiline": False}),
            }
        }
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("render",)
    FUNCTION = "execute"
    CATEGORY = "render/3d"
    OUTPUT_NODE = False

    def execute(self, intensity, city, year, month, day, hour, minute, render_b64):
        return (decode_render_b64(render_b64),)


class SphereLightSunCoordsNode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "intensity": ("FLOAT", {"default": 1.5, "min": 0.2, "max": 3.0, "step": 0.1, "display": "slider"}),
                "latitude":  ("FLOAT", {"default": 0.0, "min": -90.0,  "max": 90.0,  "step": 0.0001}),
                "longitude": ("FLOAT", {"default": 0.0, "min": -180.0, "max": 180.0, "step": 0.0001}),
                "year":      ("INT", {"default": 2025, "min": 1, "max": 9999}),
                "month":     ("INT", {"default": 6,  "min": 1,  "max": 12}),
                "day":       ("INT", {"default": 21, "min": 1,  "max": 31}),
                "hour":      ("INT", {"default": 12, "min": 0,  "max": 23}),
                "minute":    ("INT", {"default": 0,  "min": 0,  "max": 59}),
                "render_b64": ("STRING", {"default": "", "multiline": False}),
            }
        }
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("render",)
    FUNCTION = "execute"
    CATEGORY = "render/3d"
    OUTPUT_NODE = False

    def execute(self, intensity, latitude, longitude, year, month, day, hour, minute, render_b64):
        return (decode_render_b64(render_b64),)
```

Then extend the mappings (replace `__init__.py:81-82`):

```python
NODE_CLASS_MAPPINGS = {
    "SphereLightNode": SphereLightNode,
    "SphereLightManualNode": SphereLightManualNode,
    "SphereLightSunCityNode": SphereLightSunCityNode,
    "SphereLightSunCoordsNode": SphereLightSunCoordsNode,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "SphereLightNode": "🔆 Sphere Light Render",
    "SphereLightManualNode": "🔆 Sphere Light — Manual",
    "SphereLightSunCityNode": "🔆 Sphere Light — Sun (City)",
    "SphereLightSunCoordsNode": "🔆 Sphere Light — Sun (Coordinates)",
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python tools/test_new_nodes.py && python tools/test_inputs.py && python tools/test_decode.py`
Expected: all three print `... OK`.

- [ ] **Step 5: Commit**

```bash
git add __init__.py tools/test_new_nodes.py
git commit -m "feat: add Manual / Sun(City) / Sun(Coords) node classes"
```

---

### Task 3: JS status-label helper

**Files:**
- Create: `js/status.js`
- Test: `js/status.test.js`

**Interfaces:**
- Produces:
  - `haversineKm(lat1, lng1, lat2, lng2) -> number` — great-circle distance in km.
  - `nearestCityLabel({ lat, lng, tz }, records) -> { city, km, label }` — finds the nearest record via `nearestCity` (imported from `geo.js`), computes `km`, and formats `label`: `☀ near {City, region} · {tz}`, adding ` (~{Math.round(km)} km)` when `km > 25`. Returns `{ city: null, km: null, label: "" }` when `records` is empty.
- Consumes: `nearestCity` from `js/geo.js` (unchanged).

- [ ] **Step 1: Write the failing test**

Create `js/status.test.js`:

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { haversineKm, nearestCityLabel } from "./status.js";

const FIX = [
  { city: "Austin", regionCode: "TX", region: "Texas", country: "US", lat: 30.27, lng: -97.74, tz: "America/Chicago" },
  { city: "Tokyo", region: "Tokyo", country: "JP", lat: 35.68, lng: 139.69, tz: "Asia/Tokyo" },
];

test("haversineKm is ~0 for identical points and positive otherwise", () => {
  assert.equal(Math.round(haversineKm(30.27, -97.74, 30.27, -97.74)), 0);
  assert.ok(haversineKm(30.27, -97.74, 35.68, 139.69) > 9000);
});

test("nearestCityLabel names the closest city and its tz", () => {
  const r = nearestCityLabel({ lat: 30.3, lng: -97.7, tz: "America/Chicago" }, FIX);
  assert.equal(r.city.city, "Austin");
  assert.match(r.label, /near Austin, Texas · America\/Chicago/);
});

test("label omits the km hint when the nearest city is close (<25km)", () => {
  const r = nearestCityLabel({ lat: 30.27, lng: -97.74, tz: "America/Chicago" }, FIX);
  assert.ok(!/km/.test(r.label), r.label);
});

test("label includes ~km when the nearest city is far", () => {
  const r = nearestCityLabel({ lat: 32.0, lng: -99.0, tz: "America/Chicago" }, FIX);
  assert.match(r.label, /\(~\d+ km\)/);
});

test("empty records -> empty label", () => {
  const r = nearestCityLabel({ lat: 1, lng: 2, tz: "UTC" }, []);
  assert.equal(r.label, "");
  assert.equal(r.city, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test js/status.test.js`
Expected: FAIL — `Cannot find module './status.js'`.

- [ ] **Step 3: Implement `js/status.js`**

```javascript
import { nearestCity } from "./geo.js";

// Great-circle distance in km (mean Earth radius 6371 km).
export function haversineKm(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Read-only status for the coords node: which listed city the timezone was
// borrowed from, plus a distance hint when that city is far (so the label never
// overstates the match). Presentation only — never writes back to any input.
export function nearestCityLabel({ lat, lng, tz }, records) {
  const city = nearestCity(lat, lng, records);
  if (!city) return { city: null, km: null, label: "" };
  const km = haversineKm(lat, lng, city.lat, city.lng);
  const region = city.region || city.regionCode || city.countryName || city.country || "";
  const name = region ? `${city.city}, ${region}` : city.city;
  const far = km > 25 ? ` (~${Math.round(km)} km)` : "";
  return { city, km, label: `☀ near ${name}${far} · ${tz}` };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test js/status.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add js/status.js js/status.test.js
git commit -m "feat: nearestCityLabel status helper for coords node"
```

---

### Task 4: Extract `js/preview.js` engine and rewire the kitchen-sink

**Files:**
- Create: `js/light.js`
- Create: `js/light.test.js`
- Create: `js/preview.js`
- Modify: `js/sphere_widget.js` (remove the inline engine; import it)

**Interfaces:**
- **Split for testability:** `preview.js` statically imports `app` from `../../scripts/app.js`, which does not resolve under `node --test` — so any test importing `preview.js` crashes on that import. The one unit-testable piece therefore lives in an `app`-free module `js/light.js`, which `preview.js` imports (same reason `compass.js` keeps `pointerToHeading` importable).
- Produces in `js/light.js`:
  - `lightPosition(azDeg, elDeg, r = 10) -> { x, y, z }` — pure; `x = r·cos(el)·sin(az)`, `y = r·sin(el)`, `z = r·cos(el)·cos(az)` (az/el in degrees). Mirrors the mapping in `integration.test.js`.
- Produces in `js/preview.js` (which does `import { lightPosition } from "./light.js"`):
  - `loadThree() -> Promise<void>` — moved verbatim from `sphere_widget.js:13-22`.
  - `buildScene() -> { renderer, scene, camera, dirLight, canvas }` — moved verbatim from `sphere_widget.js:24-79`.
  - `renderLight(ctx, { az, el, intensity }) -> string` — sets `ctx.dirLight.position` via `lightPosition`, sets `intensity`, renders, returns `ctx.canvas.toDataURL("image/png")`.
  - `attachPreview(node, getAngles) -> { ctx, render, scheduleRender }` — awaits `loadThree()`, builds the scene, pushes the `_3d_preview` widget (moved from `sphere_widget.js:256-281`), installs `onResize`/`onRemoved` (from `:283-298`) and the sizing helpers `TOP_WIDGETS_H`/`getPreviewRect` (from `:230-254`) scoped to `node`. `render()` calls `renderLight(ctx, getAngles())`, writes the result into the node's `render_b64` widget, calls `app.graph.setDirtyCanvas(true, false)` and `previewWidget.triggerDraw?.()`. `scheduleRender()` is `render` debounced 80ms.
  - `hideWidget(node, name)` — sets `w.hidden = true` and `(w.options ??= {}).hidden = true`.
  - `hookWidgets(node, names, onChange)` — wraps each named widget's `callback` to also call `onChange()`; idempotent via a `_slHooked` flag (pattern from `sphere_widget.js:205-220`).
  - `addSerializedDOMWidget(node, { name, element, height, getValue, setValue }) -> widget` — `node.addDOMWidget(name, name, element, { serialize: true, getValue, setValue, getHeight: () => height, getMinHeight: () => height, getMaxHeight: () => height, margin: 0 })`; also sets `w.serializeValue = () => getValue()` and `w._slRowH = height`; returns the widget.
- Consumes: `app` from `../../scripts/app.js` (as `sphere_widget.js` already does).

- [ ] **Step 1: Write the failing test for the pure core**

Create `js/light.test.js`:

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { lightPosition } from "./light.js";

test("noon-ish high sun sits mostly above (+Y dominates)", () => {
  const p = lightPosition(0, 90);
  assert.ok(Math.abs(p.y - 10) < 1e-9);
  assert.ok(Math.abs(p.x) < 1e-9 && Math.abs(p.z) < 1e-9);
});

test("azimuth 90 (east) puts the light on +X", () => {
  const p = lightPosition(90, 0);
  assert.ok(p.x > 9.9, `x=${p.x}`);
  assert.ok(Math.abs(p.z) < 1e-9, `z=${p.z}`);
});

test("radius scales the vector", () => {
  const p = lightPosition(0, 0, 5);
  assert.ok(Math.abs(p.z - 5) < 1e-9, `z=${p.z}`);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test js/light.test.js`
Expected: FAIL — `Cannot find module './light.js'`.

- [ ] **Step 3: Create `js/light.js`, then `js/preview.js`**

First create the pure helper `js/light.js`:

```javascript
// Pure light-position math, kept free of any ComfyUI (`app`) import so it stays
// unit-testable under `node --test`.
export function lightPosition(azDeg, elDeg, r = 10) {
  const az = (azDeg * Math.PI) / 180;
  const el = (elDeg * Math.PI) / 180;
  return {
    x: r * Math.cos(el) * Math.sin(az),
    y: r * Math.sin(el),
    z: r * Math.cos(el) * Math.cos(az),
  };
}
```

Then create `js/preview.js`, importing `lightPosition` and moving the engine functions out of `sphere_widget.js` verbatim (see the Interfaces block for exact source line ranges). Skeleton (fill the moved bodies from `sphere_widget.js` as noted):

```javascript
import { app } from "../../scripts/app.js";
import { lightPosition } from "./light.js";

const THREE_CDN = new URL("./three.min.js", import.meta.url).href;

export function loadThree() { /* verbatim from sphere_widget.js:13-22 */ }

export function buildScene() { /* verbatim from sphere_widget.js:24-79 */ }

export function renderLight(ctx, { az, el, intensity }) {
  const p = lightPosition(az, el);
  ctx.dirLight.position.set(p.x, p.y, p.z);
  ctx.dirLight.intensity = intensity;
  ctx.renderer.shadowMap.needsUpdate = true;
  ctx.renderer.render(ctx.scene, ctx.camera);
  return ctx.canvas.toDataURL("image/png");
}

export function hideWidget(node, name) {
  const w = node.widgets?.find((w) => w.name === name);
  if (!w) return;
  w.hidden = true;
  (w.options ??= {}).hidden = true;
}

export function hookWidgets(node, names, onChange) {
  for (const name of names) {
    const w = node.widgets?.find((w) => w.name === name);
    if (!w || w._slHooked) continue;
    w._slHooked = true;
    const orig = w.callback;
    w.callback = function (v, ...args) {
      orig?.call(this, v, ...args);
      onChange();
    };
  }
}

export function addSerializedDOMWidget(node, { name, element, height, getValue, setValue }) {
  const w = node.addDOMWidget(name, name, element, {
    serialize: true, getValue, setValue,
    getHeight: () => height, getMinHeight: () => height, getMaxHeight: () => height,
    margin: 0,
  });
  if (w) { w.serializeValue = () => getValue(); w._slRowH = height; }
  return w;
}

export async function attachPreview(node, getAngles) {
  await loadThree();
  const ctx = buildScene();
  node._slCtx = ctx;
  node._slCanvas = ctx.canvas;
  node._slReady = false;

  const TOP_WIDGETS_H = () => { /* verbatim from sphere_widget.js:230-243, using `node` */ };
  const getPreviewRect = () => { /* verbatim from sphere_widget.js:245-254, using `node` */ };

  const previewWidget = { /* verbatim from sphere_widget.js:256-278, using getPreviewRect/TOP_WIDGETS_H */ };
  node.widgets = node.widgets || [];
  node.widgets.push(previewWidget);

  node.onRemoved = function () { /* verbatim from sphere_widget.js:283-292 */ };
  node.onResize = function (size) { /* verbatim from sphere_widget.js:294-298, using TOP_WIDGETS_H */ };

  const render = () => {
    const b64 = renderLight(ctx, getAngles());
    node._slReady = true;
    const wb = node.widgets?.find((w) => w.name === "render_b64");
    if (wb) wb.value = b64;
    app.graph.setDirtyCanvas(true, false);
    previewWidget.triggerDraw?.();
  };

  let debTimer = null;
  const scheduleRender = () => { clearTimeout(debTimer); debTimer = setTimeout(render, 80); };

  return { ctx, render, scheduleRender, TOP_WIDGETS_H, previewWidget };
}
```

Note: `attachPreview` also returns `TOP_WIDGETS_H` and `previewWidget` so callers can size the node after mounting widgets.

- [ ] **Step 4: Rewire `js/sphere_widget.js` to import the engine**

At the top of `sphere_widget.js`, replace the inline `THREE_CDN`/`loadThree`/`buildScene` (`:11-79`) with an import:

```javascript
import { loadThree, buildScene, renderLight } from "./preview.js";
```

Inside `nodeCreated`, keep the kitchen-sink's existing `doRender` but have it call `renderLight` for the light math instead of the inline block (`sphere_widget.js:137-149`); everything else in `sphere_widget.js` (getAngles, applyVisibility, location search, compass, label sync, mode toggles) stays unchanged. Replace `:137-149` with:

```javascript
      const { az, el, intensity } = getAngles();
      const b64 = renderLight(ctx, { az, el, intensity });
```

and delete the now-dead `const b64 = ctx.canvas.toDataURL(...)` line (`:150`) since `renderLight` returns it. (Keep the widget-write and `triggerDraw` lines `:151-159`.)

- [ ] **Step 5: Run all JS tests and confirm the pure core passes**

Run: `node --test js/`
Expected: PASS — all existing suites (`sun`, `geo`, `tz`, `solar`, `compass`, `integration`) plus `status` and `light` green.

- [ ] **Step 6: Manual kitchen-sink regression**

Restart ComfyUI. Add the existing `🔆 Sphere Light Render` node. Confirm: the preview renders; toggling `light direction` (manual/date-time) and `location by` (city/coords) shows/hides the right widgets; the compass drags and the render tracks — i.e. **behaves exactly as before**.

- [ ] **Step 7: Commit**

```bash
git add js/light.js js/light.test.js js/preview.js js/sphere_widget.js
git commit -m "refactor: extract render engine into preview.js; kitchen-sink imports it"
```

---

### Task 5: Register the three new nodes (`js/nodes.js`)

**Files:**
- Create: `js/nodes.js`

**Interfaces:**
- Consumes: `attachPreview`, `hideWidget`, `hookWidgets`, `addSerializedDOMWidget` (Task 4); `createCompass` (`compass.js`); `createLocationSearch`, `formatLabel` (`location_search.js`); `computeSunAngles` (`sun.js`); `loadCities` (`geo.js`); `nearestCityLabel` (`status.js`).
- Produces: an `app.registerExtension` that, on `nodeCreated`, dispatches by `node.comfyClass` to `setupManual` / `setupSun(node, "city")` / `setupSun(node, "coords")`.

Key wiring facts (from the real interfaces):
- `createCompass({ initial, onChange, label })` returns `{ element, getValue, setValue }` — bridge value via `getValue`/`setValue`.
- `createLocationSearch({ getRecords, initial, onSelect, onText, label })` returns `{ element, getText, setText }` — bridge value via `getText`/`setText`; `onSelect(rec)` fires on a pick, `onText(t)` on typing.
- `computeSunAngles({ location, lat, lng, year, month, day, hour, minute, heading }, records)` returns `{ rotation, elevation, label, error }`. City node passes `location` (blank lat/lng); coords node passes `lat`/`lng` (blank location).

- [ ] **Step 1: Implement `js/nodes.js`**

```javascript
import { app } from "../../scripts/app.js";
import { loadCities } from "./geo.js";
import { computeSunAngles } from "./sun.js";
import { createLocationSearch } from "./location_search.js";
import { createCompass } from "./compass.js";
import { nearestCityLabel } from "./status.js";
import { attachPreview, hideWidget, hookWidgets, addSerializedDOMWidget } from "./preview.js";

const getVal = (node, name, def) => {
  const w = node.widgets?.find((w) => w.name === name);
  return w ? parseFloat(w.value) : def;
};

// A tiny read-only status line (DOM widget, not serialized).
function addStatus(node) {
  const el = document.createElement("div");
  Object.assign(el.style, {
    width: "100%", boxSizing: "border-box", padding: "2px 12px",
    font: "12px sans-serif", color: "var(--descrip-text, #aaa)",
    whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
  });
  const w = node.addDOMWidget?.("status", "status", el, {
    serialize: false, margin: 0,
    getHeight: () => 18, getMinHeight: () => 18, getMaxHeight: () => 18,
  });
  if (w) w._slRowH = 18;
  return (text) => { el.textContent = text || ""; };
}

async function setupManual(node) {
  const getAngles = () => ({
    az: getVal(node, "rotation", 0),
    el: getVal(node, "elevation", 45),
    intensity: getVal(node, "intensity", 1.5),
  });
  const { render, scheduleRender, TOP_WIDGETS_H } = await attachPreview(node, getAngles);
  setTimeout(() => {
    hideWidget(node, "render_b64");
    hookWidgets(node, ["rotation", "elevation", "intensity"], scheduleRender);
    render();
    const w = Math.max(node.size?.[0] || 300, 280);
    node.setSize([w, TOP_WIDGETS_H() + (w - 24) + 16]);
  }, 100);
}

async function setupSun(node, mode) {
  let cities = null;
  let compass = null;
  let search = null;
  let setStatus = () => {};

  const getAngles = () => {
    const intensity = getVal(node, "intensity", 1.5);
    if (!cities) { setStatus(""); return { az: 0, el: 45, intensity }; }
    const heading = compass ? compass.getValue() : 0;
    const base = {
      year: getVal(node, "year", 2025), month: getVal(node, "month", 6),
      day: getVal(node, "day", 21), hour: getVal(node, "hour", 12),
      minute: getVal(node, "minute", 0), heading,
    };
    let params, statusOverride = null;
    if (mode === "city") {
      params = { ...base, location: search ? search.getText() : "" };
    } else {
      const lat = getVal(node, "latitude", 0), lng = getVal(node, "longitude", 0);
      params = { ...base, lat, lng };
    }
    const r = computeSunAngles(params, cities);
    if (mode === "coords" && !r.error) {
      // Prefer the "near <city>" label over sun.js's raw "lat, lng (tz)".
      const near = nearestCityLabel({ lat: params.lat, lng: params.lng, tz: undefined }, cities);
      // tz isn't returned by computeSunAngles; reuse geo via the label helper,
      // and append sun.js's below-horizon note if present.
      statusOverride = near.label;
    }
    setStatus(statusOverride || r.label || "");
    if (r.error) return { az: 0, el: 45, intensity };
    return { az: r.rotation, el: r.elevation, intensity };
  };

  const { render, scheduleRender, TOP_WIDGETS_H } = await attachPreview(node, getAngles);

  loadCities().then((c) => { cities = c; render(); })
              .catch((e) => console.warn("[SphereLight] cities.json failed:", e));

  setTimeout(() => {
    hideWidget(node, "render_b64");

    // Compass (serialized DOM widget; owns `heading`, no native anchor).
    compass = createCompass({ label: "heading", initial: 0, onChange: () => scheduleRender() });
    addSerializedDOMWidget(node, {
      name: "heading", element: compass.element, height: 72,
      getValue: () => compass.getValue(), setValue: (v) => compass.setValue(Number(v) || 0),
    });

    if (mode === "city") {
      search = createLocationSearch({
        label: "city", getRecords: () => cities || [], initial: "Austin, TX",
        onSelect: () => render(), onText: () => scheduleRender(),
      });
      addSerializedDOMWidget(node, {
        name: "city", element: search.element, height: 32,
        getValue: () => search.getText(), setValue: (v) => search.setText(String(v ?? "")),
      });
      hookWidgets(node, ["intensity", "year", "month", "day", "hour", "minute"], scheduleRender);
    } else {
      hookWidgets(node, ["intensity", "latitude", "longitude", "year", "month", "day", "hour", "minute"], scheduleRender);
    }

    setStatus = addStatus(node);
    render();
    const w = Math.max(node.size?.[0] || 320, 300);
    node.setSize([w, TOP_WIDGETS_H() + (w - 24) + 16]);
  }, 100);
}

app.registerExtension({
  name: "SphereLightSplitNodes",
  async nodeCreated(node) {
    if (node.comfyClass === "SphereLightManualNode") return setupManual(node);
    if (node.comfyClass === "SphereLightSunCityNode") return setupSun(node, "city");
    if (node.comfyClass === "SphereLightSunCoordsNode") return setupSun(node, "coords");
  },
});
```

Note on the coords status: `computeSunAngles` does not return `tz`, so the `nearestCityLabel` call above passes `tz: undefined` and the label reads `… · undefined`. Fix by having the coords branch read tz from the nearest record directly: replace the `statusOverride` block with

```javascript
      const near = nearestCityLabel({ lat: params.lat, lng: params.lng, tz: params.tz }, cities);
```

and set `params.tz = near.city ? near.city.tz : "UTC"` computed *before* the label call (compute `near` once, reuse its `city.tz`). Keep the below-horizon suffix from `r.label` only if `r.belowHorizon`.

- [ ] **Step 2: Manual verification in ComfyUI**

Restart ComfyUI. Add each new node from `render/3d`:
- `🔆 Sphere Light — Manual`: three sliders + preview; dragging a slider updates the render.
- `🔆 Sphere Light — Sun (City)`: intensity, city search, date/time, compass, status; picking a city renders and the status reads `☀ City, Region`.
- `🔆 Sphere Light — Sun (Coordinates)`: intensity, lat/lon, date/time, compass, status; entering `30.27 / -97.74` renders and status reads `☀ near Austin, Texas · America/Chicago`; entering remote coords shows `(~N km)`.

- [ ] **Step 3: Confirm JS unit tests still pass**

Run: `node --test js/`
Expected: PASS (no unit test covers `nodes.js`; this confirms nothing else broke).

- [ ] **Step 4: Commit**

```bash
git add js/nodes.js
git commit -m "feat: register Manual / Sun(City) / Sun(Coords) split nodes"
```

---

### Task 6: Serialization round-trip gate + README

**Files:**
- Modify: `README.md`
- (Conditional) Modify: `__init__.py`, `js/nodes.js` — only if the fallback is needed.

**Interfaces:** none new.

- [ ] **Step 1: Round-trip test in the v1 (LiteGraph) frontend**

In ComfyUI (default/v1 renderer): add a `Sun (City)` node, pick `London, UK`, drag the compass to ~135°. Save the workflow to disk. Reload the page / re-open the workflow. **Confirm** the city still reads `London, …` and the compass needle/number restore to ~135°. Repeat for `Sun (Coordinates)` with a non-default lat/lon + heading.

- [ ] **Step 2: Round-trip test in the v2 (Vue) frontend**

Enable the v2/Vue node renderer (ComfyUI settings) and repeat Step 1 for both sun nodes.

- [ ] **Step 3: Decide — pass or fallback**

If both frontends restore `city`/`heading` correctly: the serialized-DOM approach holds; **no code change** — proceed to Step 4.

If a widget fails to restore in v2 (value resets to default), apply the **native-anchor fallback for that widget only**:
- In `__init__.py`, re-add the native input to the affected node's `INPUT_TYPES` and `execute` signature — for heading: `"heading": ("FLOAT", {"default": 0.0, "min": 0, "max": 360, "step": 1, "display": "slider"})`; for city: `"location": ("STRING", {"default": "Austin, TX", "multiline": False})`. Update `tools/test_new_nodes.py` to expect it.
- In `js/nodes.js`, change that widget from `addSerializedDOMWidget` to the kitchen-sink pattern: add it `serialize: false`, `hideWidget(node, "<native>")`, and in the DOM widget's `onChange`/`onSelect` write the native widget's value (e.g. `node.widgets.find(w=>w.name==="heading").value = compass.getValue()`), reading `initial` from the native widget on setup. (This mirrors `sphere_widget.js:304-374`.)
- Re-run Steps 1–2 to confirm the fallback round-trips, then commit the fallback separately.

- [ ] **Step 4: Update the README**

In `README.md`, after the install/quick-start, add a section documenting the three nodes (keep the existing "Time of day" section, which describes the kitchen-sink node):

```markdown
## Nodes

Four nodes are registered under **render/3d**:

- **🔆 Sphere Light Render** — the original all-in-one node (mode + location toggles).
- **🔆 Sphere Light — Manual** — set the light directly with `rotation` / `elevation` / `intensity`.
- **🔆 Sphere Light — Sun (City)** — position the light from a real sun: pick a city, set date/time, drag the compass.
- **🔆 Sphere Light — Sun (Coordinates)** — same, but enter `latitude` / `longitude` directly (timezone borrowed from the nearest listed city).

The three split nodes have no mode toggles — the node you pick *is* the mode. The all-in-one node remains for existing workflows.
```

- [ ] **Step 5: Final full test sweep**

Run: `node --test js/ && python tools/test_inputs.py && python tools/test_decode.py && python tools/test_new_nodes.py`
Expected: all JS suites green; all three Python scripts print `... OK`.

- [ ] **Step 6: Commit**

```bash
git add README.md
git commit -m "docs: document the three split light nodes"
```

---

## Self-Review

**Spec coverage:**
- Three additive nodes + frozen kitchen-sink → Tasks 2, 4 (kitchen-sink import only). ✓
- No toggles / no show-hide / no syncing → Task 2 (INPUT_TYPES omit toggles), Task 5 (flat setup). ✓
- DOM widgets own serialized values; native `heading`/`location` dropped → Task 5 (`addSerializedDOMWidget`), gated by Task 6. ✓
- Round-trip gate in both frontends + native-anchor fallback → Task 6. ✓
- Shared `preview.js` imported by all four nodes → Task 4 (extract + kitchen-sink), Task 5 (new nodes). ✓
- `decode_render_b64` helper for all `execute()`s → Tasks 1, 2. ✓
- Astronomy unchanged; both sun paths via existing `computeSunAngles` → Task 5 (city vs coords params). ✓
- Read-only status line with `near X (~N km)` wording → Task 3 (`nearestCityLabel`) + Task 5 (`addStatus`). ✓
- Tests: existing suites + round-trip + manual pass → Tasks 4/5/6. ✓

**Placeholder scan:** No "TBD"/"handle edge cases". Engine bodies moved verbatim are given exact source line ranges (`sphere_widget.js:NN-MM`), which is a precise move instruction, not a placeholder.

**Type consistency:** `decode_render_b64(str)->tensor` consistent across Tasks 1–2. `lightPosition`/`renderLight`/`attachPreview`/`addSerializedDOMWidget` signatures match between Task 4 (produce) and Task 5 (consume). `nearestCityLabel({lat,lng,tz}, records)->{city,km,label}` consistent between Task 3 and Task 5. Compass value bridge uses `getValue`/`setValue` (real `compass.js` API); city bridge uses `getText`/`setText` (real `location_search.js` API). ✓
