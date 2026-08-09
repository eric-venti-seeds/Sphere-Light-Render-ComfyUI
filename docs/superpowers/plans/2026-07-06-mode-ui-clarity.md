# Mode UI Clarity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the node's Manual vs. Date/time lighting modes obvious by moving the toggle to the top, showing only the active mode's inputs, disambiguating city-vs-coordinates with a sub-toggle, and replacing the bare `heading` slider with a draggable compass dial.

**Architecture:** All lighting logic stays client-side (Python only decodes `render_b64`). New *pure* logic (which source drives the sun; which widgets are visible; pointer→bearing math) lives in small node-importable modules with unit tests, mirroring the existing `solar.js` / `geo.js` / `sun.js` split. The DOM/LiteGraph plumbing (reversible show/hide, the compass widget) lives in `sphere_widget.js` / `compass.js` and is verified manually in ComfyUI, matching the untested-by-convention `location_search.js`.

**Tech Stack:** Vanilla ES modules, `node:test` + `node:assert/strict` (run via `node --test <file>`, no package.json), Three.js (vendored) for the scene, ComfyUI/LiteGraph widget API, Python (`__init__.py`) for the node declaration.

## Global Constraints

- **Rendering stays client-side.** `execute()` still only decodes `render_b64`; it must ignore all positioning params (including the new `location_mode`). No new Python dependencies.
- **Do not modify** `js/solar.js`, `js/tz.js`, `js/geo.js`, `js/sun.js`, or `js/cities.json`. The astronomy and city lookup are unchanged.
- **Compass convention:** `0° = North = up, clockwise` → `E = 90°`, `S = 180°`, `W = 270°`. This matches the azimuth convention already in `solar.js`; the dial only sets the `heading` number, it does not change any math.
- **Pure modules must not touch `document` at top level.** `mode.js` and `compass.js` are imported by Node tests; DOM access is allowed only inside factory functions that ComfyUI calls in the browser.
- **Tests:** ES module `import`, `node:test`, `node:assert/strict`; run one file with `node --test js/<name>.test.js`.
- **Mode defaults:** `sun_mode = "manual"`, `location_mode = "city"`.

---

## File Structure

- **Create `js/mode.js`** — pure mode logic: `pickSunSource` (which source drives the sun) and `visibleWidgets` (which widgets show per mode). No DOM.
- **Create `js/mode.test.js`** — unit tests for `mode.js`.
- **Create `js/compass.js`** — `pointerToHeading` (pure bearing math) + `createCompass` (DOM canvas dial factory).
- **Create `js/compass.test.js`** — unit tests for `pointerToHeading`.
- **Modify `__init__.py`** — reorder `INPUT_TYPES` (toggle first), add `location_mode`, update `execute` signature. Behavior unchanged.
- **Modify `tools/test_inputs.py`** — assert `location_mode` exists; update the positional `execute` call to the new order.
- **Modify `js/sphere_widget.js`** — reversible show/hide (`applyVisibility`), source gating via `pickSunSource`, compass DOM widget, hide native `heading` slider, hook `location_mode`.
- **Modify `README.md`** — document the toggle-first layout, City/Coords sub-toggle, and compass.

---

### Task 1: Pure mode logic (`js/mode.js`)

**Files:**
- Create: `js/mode.js`
- Test: `js/mode.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `pickSunSource({ sunMode, locationMode, location, lat, lng }) → { location: string, lat: number, lng: number } | null` — `null` in manual mode; otherwise the `{location,lat,lng}` triple with the *inactive* source blanked so exactly one drives.
  - `visibleWidgets({ sunMode, locationMode }) → string[]` — names of the toggleable widgets that should be visible. Uses DOM-widget names `"location_search"` and `"compass"`.

- [ ] **Step 1: Write the failing test**

Create `js/mode.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickSunSource, visibleWidgets } from "./mode.js";

test("pickSunSource: manual mode returns null", () => {
  assert.equal(
    pickSunSource({ sunMode: "manual", locationMode: "city", location: "Austin, TX", lat: 30, lng: -97 }),
    null
  );
});

test("pickSunSource: city mode blanks the coordinates", () => {
  assert.deepEqual(
    pickSunSource({ sunMode: "date/time", locationMode: "city", location: "Austin, TX", lat: 30.27, lng: -97.74 }),
    { location: "Austin, TX", lat: 0, lng: 0 }
  );
});

test("pickSunSource: coords mode blanks the city text", () => {
  assert.deepEqual(
    pickSunSource({ sunMode: "date/time", locationMode: "coords", location: "Austin, TX", lat: 30.27, lng: -97.74 }),
    { location: "", lat: 30.27, lng: -97.74 }
  );
});

test("visibleWidgets: manual shows only the angle sliders", () => {
  assert.deepEqual(visibleWidgets({ sunMode: "manual", locationMode: "city" }), ["rotation", "elevation"]);
});

test("visibleWidgets: date/time + city shows the search, not lat/lon or angles", () => {
  const v = visibleWidgets({ sunMode: "date/time", locationMode: "city" });
  assert.ok(v.includes("location_search"));
  assert.ok(v.includes("compass"));
  assert.ok(v.includes("location_mode"));
  assert.ok(!v.includes("latitude"));
  assert.ok(!v.includes("rotation"));
});

test("visibleWidgets: date/time + coords shows lat/lon, not the search", () => {
  const v = visibleWidgets({ sunMode: "date/time", locationMode: "coords" });
  assert.ok(v.includes("latitude"));
  assert.ok(v.includes("longitude"));
  assert.ok(!v.includes("location_search"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test js/mode.test.js`
Expected: FAIL — `Cannot find module './mode.js'` (or import error).

- [ ] **Step 3: Write minimal implementation**

Create `js/mode.js`:

```js
// Pure mode / visibility logic for the Sphere Light node. No DOM, no ComfyUI
// dependency, so it is unit-testable in plain Node (like solar.js / geo.js).

// Which source drives the sun in date/time mode. Returns the {location,lat,lng}
// triple to feed computeSunAngles, with the INACTIVE source blanked so exactly
// one drives — or null in manual mode (the caller uses the rotation/elevation
// sliders instead). Blanking lat/lng to 0/0 makes computeSunAngles treat coords
// as "unset"; blanking location makes it skip the city match.
export function pickSunSource({ sunMode, locationMode, location, lat, lng }) {
  if (sunMode !== "date/time") return null;
  if (locationMode === "coords") return { location: "", lat, lng };
  return { location, lat: 0, lng: 0 };
}

// Names of the TOGGLEABLE widgets that should be visible for the given modes.
// Excludes always-on widgets (sun_mode, intensity) and always-off ones
// (render_b64, plus the native `location`/`heading` widgets that the DOM widgets
// replace). "location_search" and "compass" are the DOM widgets' names.
export function visibleWidgets({ sunMode, locationMode }) {
  if (sunMode !== "date/time") return ["rotation", "elevation"];
  const base = ["location_mode", "year", "month", "day", "hour", "minute", "compass"];
  return locationMode === "coords"
    ? [...base, "latitude", "longitude"]
    : [...base, "location_search"];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test js/mode.test.js`
Expected: PASS — `# pass 6`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add js/mode.js js/mode.test.js
git commit -m "feat(js): pure mode logic — source gating and per-mode widget visibility"
```

---

### Task 2: Compass bearing math (`pointerToHeading`)

**Files:**
- Create: `js/compass.js`
- Test: `js/compass.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `pointerToHeading(cx, cy, x, y) → number | null` — bearing (0–360, `0 = up/North`, clockwise) of the pointer `(x,y)` relative to center `(cx,cy)` in canvas pixels (y increases downward). Returns `null` when the pointer is exactly at center (undefined direction).

- [ ] **Step 1: Write the failing test**

Create `js/compass.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { pointerToHeading } from "./compass.js";

test("cardinal points map to compass bearings (N up, clockwise)", () => {
  assert.equal(pointerToHeading(50, 50, 50, 10), 0);   // up    -> N
  assert.equal(pointerToHeading(50, 50, 90, 50), 90);  // right -> E
  assert.equal(pointerToHeading(50, 50, 50, 90), 180); // down  -> S
  assert.equal(pointerToHeading(50, 50, 10, 50), 270); // left  -> W
});

test("diagonal up-right is NE (45)", () => {
  assert.equal(pointerToHeading(50, 50, 90, 10), 45);
});

test("result is always normalized to [0,360)", () => {
  const h = pointerToHeading(50, 50, 10, 90); // down-left -> SW ~225
  assert.ok(h >= 0 && h < 360);
  assert.equal(h, 225);
});

test("dead center returns null (no direction)", () => {
  assert.equal(pointerToHeading(50, 50, 50, 50), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test js/compass.test.js`
Expected: FAIL — `Cannot find module './compass.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `js/compass.js` (add `createCompass` in Task 3; for now only the pure helper):

```js
// Draggable compass dial for the `heading` input. `pointerToHeading` is pure
// (no DOM) so it is unit-tested in Node; `createCompass` (Task 3) is the DOM
// factory and is verified manually, like location_search.js.

// Bearing of (x,y) around center (cx,cy), in canvas pixels where y grows DOWN.
// 0 = up = North, clockwise (E=90, S=180, W=270). null at dead center.
export function pointerToHeading(cx, cy, x, y) {
  const dx = x - cx;
  const dy = y - cy;
  if (dx === 0 && dy === 0) return null;
  // atan2(dx, -dy): up(dx0,-dy>0)->0, right->90, down->180, left->270.
  const deg = Math.atan2(dx, -dy) * 180 / Math.PI;
  return (deg + 360) % 360;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test js/compass.test.js`
Expected: PASS — `# pass 4`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add js/compass.js js/compass.test.js
git commit -m "feat(js): compass bearing math (pointerToHeading)"
```

---

### Task 3: Compass dial DOM widget (`createCompass`)

**Files:**
- Modify: `js/compass.js`

**Interfaces:**
- Consumes: `pointerToHeading` (Task 2).
- Produces: `createCompass({ initial, size, onChange }) → { element: HTMLElement, setValue(deg), getValue() → number, destroy() }`. `onChange(deg)` fires on drag with the new bearing; `element` is the DOM node to hand to `node.addDOMWidget`.

> **Verification is manual** (canvas/DOM — no headless test in this repo; `location_search.js` is likewise untested). The tested `pointerToHeading` core carries the only non-trivial logic.

- [ ] **Step 1: Add the factory**

Append to `js/compass.js` (below `pointerToHeading`):

```js
// A small canvas compass the user drags. Writes `heading` degrees via onChange.
// Colors are literal (canvas can't read CSS vars); N is amber, needle is the
// same blue as the node's status accent.
export function createCompass({ initial = 0, size = 72, onChange } = {}) {
  let heading = (((Number(initial) || 0) % 360) + 360) % 360;

  const container = document.createElement("div");
  Object.assign(container.style, {
    width: "100%", display: "flex", justifyContent: "center", padding: "2px 0",
  });

  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  Object.assign(canvas.style, { cursor: "pointer", touchAction: "none" });
  container.appendChild(canvas);

  const ctx = canvas.getContext("2d");
  const cx = size / 2, cy = size / 2, R = size / 2 - 10;

  const draw = () => {
    ctx.clearRect(0, 0, size, size);

    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.strokeStyle = "#4e4e4e";
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.font = "10px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const [ch, deg] of [["N", 0], ["E", 90], ["S", 180], ["W", 270]]) {
      const a = deg * Math.PI / 180;
      ctx.fillStyle = ch === "N" ? "#e0a848" : "#9aa0a6";
      ctx.fillText(ch, cx + Math.sin(a) * (R + 5), cy - Math.cos(a) * (R + 5));
    }

    const a = heading * Math.PI / 180;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.sin(a) * (R - 4), cy - Math.cos(a) * (R - 4));
    ctx.strokeStyle = "#79c0ff";
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(cx, cy, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = "#79c0ff";
    ctx.fill();

    ctx.fillStyle = "#c9d1d9";
    ctx.font = "9px sans-serif";
    ctx.fillText(`${Math.round(heading)}°`, cx, cy + R - 1);
  };

  const set = (deg, fire) => {
    heading = (((deg % 360) + 360) % 360);
    draw();
    if (fire) onChange?.(heading);
  };

  const fromEvent = (e) => {
    const r = canvas.getBoundingClientRect();
    const x = (e.clientX - r.left) * (size / r.width);
    const y = (e.clientY - r.top) * (size / r.height);
    const deg = pointerToHeading(cx, cy, x, y);
    if (deg !== null) set(deg, true);
  };

  let dragging = false;
  canvas.addEventListener("pointerdown", (e) => {
    dragging = true;
    canvas.setPointerCapture?.(e.pointerId);
    fromEvent(e);
    e.preventDefault();
  });
  canvas.addEventListener("pointermove", (e) => { if (dragging) fromEvent(e); });
  canvas.addEventListener("pointerup", (e) => {
    dragging = false;
    canvas.releasePointerCapture?.(e.pointerId);
  });

  draw();

  return {
    element: container,
    setValue: (deg) => set(deg, false),
    getValue: () => heading,
    destroy: () => {},
  };
}
```

- [ ] **Step 2: Verify the module still imports (no top-level DOM access)**

Run: `node --test js/compass.test.js`
Expected: PASS (unchanged — importing `compass.js` must not throw, proving no `document` access at module top level).

- [ ] **Step 3: Commit**

```bash
git add js/compass.js
git commit -m "feat(js): draggable compass dial DOM widget"
```

---

### Task 4: Python inputs — reorder + `location_mode`

**Files:**
- Modify: `__init__.py:16-44`
- Modify: `tools/test_inputs.py:17-24`

**Interfaces:**
- Consumes: nothing.
- Produces: `INPUT_TYPES().required` ordered `sun_mode, rotation, elevation, intensity, location_mode, location, latitude, longitude, year, month, day, hour, minute, heading, render_b64`; `execute(self, sun_mode, rotation, elevation, intensity, location_mode, location, latitude, longitude, year, month, day, hour, minute, heading, render_b64)`.

- [ ] **Step 1: Update the input test to expect the new shape (failing)**

In `tools/test_inputs.py`, change the required-key list (line 17-18) to include `location_mode`, and change the positional `execute` call (line 24) to the new order:

```python
req = mod.SphereLightNode.INPUT_TYPES()["required"]
for k in ["sun_mode", "location_mode", "location", "latitude", "longitude",
          "year", "month", "day", "hour", "minute", "heading"]:
    assert k in req, f"missing input: {k}"
assert req["sun_mode"][0] == ["manual", "date/time"], req["sun_mode"]
assert req["location_mode"][0] == ["city", "coords"], req["location_mode"]

# execute must still work and ignore the new params (empty render_b64 -> gray)
node = mod.SphereLightNode()
(t,) = node.execute("manual", 0.0, 45.0, 1.5, "city", "Austin, TX", 0.0, 0.0,
                    2025, 6, 21, 12, 0, 0.0, "")
assert tuple(t.shape) == (1, 1024, 1024, 3), t.shape
print("test_inputs: OK")
```

- [ ] **Step 2: Run it to verify it fails**

Run: `python tools/test_inputs.py`
Expected: FAIL — `AssertionError` on `location_mode` missing (or a `TypeError` from the positional `execute` mismatch).

- [ ] **Step 3: Reorder `INPUT_TYPES` and add `location_mode`**

Replace the `required` dict in `__init__.py` (lines 18-33) with:

```python
            "required": {
                "sun_mode":  (["manual", "date/time"], {"default": "manual"}),
                "rotation":  ("FLOAT", {"default": 0.0,  "min": -180, "max": 180, "step": 1,   "display": "slider"}),
                "elevation": ("FLOAT", {"default": 45.0, "min": 5,    "max": 85,  "step": 1,   "display": "slider"}),
                "intensity": ("FLOAT", {"default": 1.5,  "min": 0.2,  "max": 3.0, "step": 0.1, "display": "slider"}),
                "location_mode": (["city", "coords"], {"default": "city"}),
                "location":  ("STRING", {"default": "Austin, TX", "multiline": False}),
                "latitude":  ("FLOAT", {"default": 0.0, "min": -90.0,  "max": 90.0,  "step": 0.0001}),
                "longitude": ("FLOAT", {"default": 0.0, "min": -180.0, "max": 180.0, "step": 0.0001}),
                "year":      ("INT", {"default": 2025, "min": 1, "max": 9999}),
                "month":     ("INT", {"default": 6,  "min": 1,  "max": 12}),
                "day":       ("INT", {"default": 21, "min": 1,  "max": 31}),
                "hour":      ("INT", {"default": 12, "min": 0,  "max": 23}),
                "minute":    ("INT", {"default": 0,  "min": 0,  "max": 59}),
                "heading":   ("FLOAT", {"default": 0.0, "min": 0, "max": 360, "step": 1, "display": "slider"}),
                "render_b64": ("STRING", {"default": "", "multiline": False}),
            }
```

Then update the `execute` signature (lines 42-44) to match the new order and accept `location_mode`:

```python
    def execute(self, sun_mode, rotation, elevation, intensity, location_mode,
                location, latitude, longitude, year, month, day, hour, minute,
                heading, render_b64):
```

Leave the method body unchanged — it still only uses `render_b64`. Update the leading comment to note `location_mode` is also client-side-only:

```python
        # Positioning params (sun_mode, rotation..heading, location_mode,
        # latitude/longitude) are consumed client-side in js/sphere_widget.js;
        # the server only needs render_b64. They appear here because ComfyUI
        # passes every declared input.
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `python tools/test_inputs.py`
Expected: `test_inputs: OK`.

- [ ] **Step 5: Commit**

```bash
git add __init__.py tools/test_inputs.py
git commit -m "feat(node): toggle-first input order + location_mode (city/coords)"
```

---

### Task 5: Wire the widget UI (`js/sphere_widget.js`)

**Files:**
- Modify: `js/sphere_widget.js`

**Interfaces:**
- Consumes: `pickSunSource`, `visibleWidgets` (`./mode.js`); `createCompass` (`./compass.js`); existing `computeSunAngles`, `createLocationSearch`, `formatLabel`.
- Produces: no exports (side-effecting ComfyUI extension). Runtime behavior: only the active mode's widgets render; the compass drives `heading`; the sun is driven by exactly the City *or* Coords source.

> **Verification is manual in ComfyUI** (LiteGraph integration; no headless harness). Steps 1–6 are edits; Step 7 is the manual checklist.

- [ ] **Step 1: Add the imports**

At the top of `js/sphere_widget.js`, below the existing imports (line 4), add:

```js
import { pickSunSource, visibleWidgets } from "./mode.js";
import { createCompass } from "./compass.js";
```

- [ ] **Step 2: Gate the sun source in `getAngles`**

Replace the `getAngles` function body (currently `sphere_widget.js:97-116`) with:

```js
    // Returns the sun angles to render, honoring sun_mode + location_mode.
    const getAngles = () => {
      const intensity = getVal("intensity", 1.5);
      const src = pickSunSource({
        sunMode:      getStr("sun_mode", "manual"),
        locationMode: getStr("location_mode", "city"),
        location:     getStr("location", ""),
        lat:          getVal("latitude", 0),
        lng:          getVal("longitude", 0),
      });
      if (!src || !node._slCities) {
        node._slStatus = "";
        return { az: getVal("rotation", 0), el: getVal("elevation", 45), intensity };
      }
      const r = computeSunAngles({
        location: src.location, lat: src.lat, lng: src.lng,
        year: getVal("year", 2025), month: getVal("month", 6), day: getVal("day", 21),
        hour: getVal("hour", 12), minute: getVal("minute", 0), heading: getVal("heading", 0),
      }, node._slCities);
      node._slStatus = r.label || "";
      if (r.error) {
        // Couldn't resolve — keep the manual sliders driving the light.
        return { az: getVal("rotation", 0), el: getVal("elevation", 45), intensity };
      }
      return { az: r.rotation, el: r.elevation, intensity };
    };
```

- [ ] **Step 3: Skip hidden widgets in the top-height measure**

In `TOP_WIDGETS_H` (`sphere_widget.js:173-183`), skip collapsed widgets so hidden rows don't add phantom spacing. Change the loop body so it `continue`s on hidden widgets:

```js
    const TOP_WIDGETS_H = () => {
      let h = LiteGraph.NODE_TITLE_HEIGHT + 8;
      for (const w of node.widgets ?? []) {
        if (w.name === "_3d_preview") break;
        if (w.type === "hidden") continue;
        const wh = w.computeSize
          ? w.computeSize(node.size[0])[1]
          : LiteGraph.NODE_WIDGET_HEIGHT;
        h += wh + 4;
      }
      return h;
    };
```

- [ ] **Step 4: Add reversible show/hide and `applyVisibility`**

Add these just before `hookSliders` (around `sphere_widget.js:151`):

```js
    // Toggleable widgets by their node.widgets `name` ("location_search" and
    // "compass" are the DOM widgets). Always-on (sun_mode, intensity) and
    // always-off (render_b64, native location/heading) are not listed.
    const TOGGLEABLE = [
      "rotation", "elevation", "location_mode", "location_search",
      "latitude", "longitude", "year", "month", "day", "hour", "minute", "compass",
    ];

    // Reversibly collapse/restore a widget. Native widgets swap computeSize/
    // draw/type; DOM widgets (have `.element`) also toggle display, and keep
    // their internal draw untouched.
    const setWidgetVisible = (w, visible) => {
      if (!w) return;
      const isDom = !!w.element;
      if (visible) {
        if (w._slOrig) {
          w.computeSize = w._slOrig.computeSize;
          w.type = w._slOrig.type;
          if (!isDom) w.draw = w._slOrig.draw;
          w._slOrig = null;
        }
        if (isDom) w.element.style.display = "";
      } else {
        if (!w._slOrig) w._slOrig = { computeSize: w.computeSize, type: w.type, draw: w.draw };
        w.computeSize = () => [0, 0];
        w.type = "hidden";
        if (!isDom) w.draw = () => {};
        if (isDom) w.element.style.display = "none";
      }
    };

    const applyVisibility = () => {
      const show = new Set(visibleWidgets({
        sunMode:      getStr("sun_mode", "manual"),
        locationMode: getStr("location_mode", "city"),
      }));
      for (const name of TOGGLEABLE) {
        setWidgetVisible(node.widgets?.find((w) => w.name === name), show.has(name));
      }
      node.setSize([node.size[0], TOP_WIDGETS_H() + getPreviewRect().side + 16]);
      app.graph.setDirtyCanvas(true, true);
    };
```

- [ ] **Step 5: Hook `location_mode` and re-apply visibility on mode changes**

In `hookSliders` (`sphere_widget.js:151-162`), add `"location_mode"` to the name list and re-apply visibility when a mode widget changes. Replace the function with:

```js
    const hookSliders = () => {
      ["rotation", "elevation", "intensity",
       "sun_mode", "location_mode", "location", "latitude", "longitude",
       "year", "month", "day", "hour", "minute", "heading"
      ].forEach(name => {
        const w = node.widgets?.find(w => w.name === name);
        if (!w || w._slHooked) return;
        w._slHooked = true;
        const orig = w.callback;
        w.callback = function(v, ...args) {
          orig?.call(this, v, ...args);
          if (name === "sun_mode" || name === "location_mode") applyVisibility();
          debounced();
        };
      });
    };
```

- [ ] **Step 6: Add `setupCompass`, call it + `applyVisibility` in init, clean up on remove**

Add `setupCompass` just after `setupLocationSearch` (after `sphere_widget.js:305`):

```js
    // Swap the plain `heading` slider for the draggable compass dial. The dial
    // writes the still-serialized (now hidden) `heading` widget, mirroring how
    // the location search drives `location`.
    const setupCompass = () => {
      if (node._slCompass || typeof node.addDOMWidget !== "function") return;
      const headingW = node.widgets?.find((w) => w.name === "heading");
      if (!headingW) return;
      try {
        const compass = createCompass({
          initial:  parseFloat(headingW.value) || 0,
          onChange: (deg) => { headingW.value = deg; debounced(); },
        });
        node._slCompass = compass;
        const w = node.addDOMWidget("compass", "compass", compass.element, { serialize: false });
        if (w) w.label = "heading";
        headingW.computeSize = () => [0, 0];
        headingW.draw = () => {};
        headingW.type = "hidden";
        const ws = node.widgets;
        const di = ws.indexOf(w), hi = ws.indexOf(headingW);
        if (di > -1 && hi > -1 && di !== hi + 1) {
          ws.splice(di, 1);
          ws.splice(hi + 1, 0, w);
        }
        app.graph.setDirtyCanvas(true, true);
      } catch (e) {
        console.warn("[SphereLight] compass unavailable, using heading slider:", e);
        node._slCompass = null;
      }
    };

    // The raw widget names ("sun_mode", "location_mode") are unclear; give the
    // toggles human labels. LiteGraph draws `label || name`. Idempotent.
    const relabelToggles = () => {
      const sm = node.widgets?.find((w) => w.name === "sun_mode");
      if (sm) sm.label = "Light direction";
      const lm = node.widgets?.find((w) => w.name === "location_mode");
      if (lm) lm.label = "Location by";
    };
```

In `node.onRemoved` (`sphere_widget.js:254-262`), add compass cleanup next to the search cleanup:

```js
      this._slSearch?.destroy?.();   // removes the body-attached suggestion menu
      this._slCompass?.destroy?.();
```

In the first init `setTimeout` (`sphere_widget.js:310-316`), add `setupCompass()` and `applyVisibility()`:

```js
    setTimeout(() => {
      hideB64Widget();
      hookSliders();
      setupLocationSearch();
      setupCompass();
      relabelToggles();
      applyVisibility();
      doRender();
      node.setSize([initW, TOP_WIDGETS_H() + initSide + 16]);
    }, 100);
```

In the fallback `setTimeout` (`sphere_widget.js:318`), add the same setup + visibility:

```js
    setTimeout(() => { hookSliders(); hideB64Widget(); setupLocationSearch(); setupCompass(); relabelToggles(); applyVisibility(); }, 700);
```

- [ ] **Step 7: Manual verification in ComfyUI**

Restart ComfyUI (or reload the browser tab) and add a **🔆 Sphere Light Render** node. Confirm:
- On load the toggle **Light direction** is the first widget; mode is **manual**; only `rotation`, `elevation`, `intensity`, and the preview show. No location/date/heading rows.
- Switch to **date/time**: `rotation`/`elevation` disappear; `intensity`, the **City|Coords** toggle, the city search, date, time, the **compass**, and the status line appear. The node resizes so the preview still fits.
- With **City**: type `Austin, TX`; status shows `☀ Austin, TX`; lat/lon fields are absent. The render updates.
- Flip to **Coords**: the city search disappears, `latitude`/`longitude` appear; set e.g. `35.68 / 139.65`; status shows the `☀ 35.68…` coords label; the city text no longer influences the sun.
- Drag the **compass** dial: the needle follows, the degree readout updates, and the sphere's shadow direction tracks. N is at top/amber.
- Switch back to **manual**: date/time rows and the compass disappear; `rotation`/`elevation` return.

- [ ] **Step 8: Commit**

```bash
git add js/sphere_widget.js
git commit -m "feat(widget): toggle-first UI — per-mode show/hide, city/coords gating, compass"
```

---

### Task 6: Update the README

**Files:**
- Modify: `README.md:29-40`

**Interfaces:** none (docs).

- [ ] **Step 1: Rewrite the "Time of day" section**

Replace `README.md` lines 29-40 with:

```markdown
## Time of day

The node has two modes, chosen by the **Light direction** toggle at the top:

- **Manual** — set the light with the `rotation` and `elevation` sliders (plus
  `intensity`). This is the default.
- **Date/time** — position the light from a real sun position. Only this mode's
  inputs are shown, so the two modes never clutter each other.

In **date/time** mode, pick where the location comes from with the **City /
Coordinates** toggle — only the active one is shown, so it's always clear which
drives the sun:

- **City** — start typing a city and pick from the dropdown (e.g. `Austin, TX`,
  `London, UK`, `Tokyo, Japan`).
- **Coordinates** — for a place not in the bundled list (cities over ~15k
  population), enter `latitude` / `longitude` directly; the timezone is borrowed
  from the nearest listed city.

Set the date and time, then drag the **compass** dial to the direction the camera
faces (N at top, clockwise). A status line shows what was resolved
(`☀ London, England`) or warns when a city isn't found. Timezone and
daylight-saving are handled automatically. Rebuild the city list with
`python tools/build_cities.py`.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: document toggle-first modes, city/coords, compass"
```

---

## Final verification

- [ ] **Run the full JS + Python test suite:**

```bash
node --test js/mode.test.js js/compass.test.js js/geo.test.js js/sun.test.js js/solar.test.js js/tz.test.js js/integration.test.js
python tools/test_inputs.py
```

Expected: all `node --test` files report `# fail 0`; `test_inputs: OK`.

- [ ] **Manual ComfyUI pass** per Task 5 Step 7 completed and behaving as described.
