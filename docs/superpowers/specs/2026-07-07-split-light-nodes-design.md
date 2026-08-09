# Split Light Nodes — Design

- **Date:** 2026-07-07
- **Status:** Approved (design), pending implementation plan
- **Component:** Sphere-Light-Render-ComfyUI custom node
- **Builds on:** `2026-07-06-mode-ui-clarity-design.md`

## Goal

Replace the single "kitchen-sink" node's mode/location **toggles** with three
flat, single-purpose nodes, so the canvas reads honestly (the node you pick *is*
the behavior and the location method) and each node is a short, unconditional
list of inputs. Motivated by **canvas clarity** and **discoverability**; there is
no headless/API driver, so rendering stays client-side and the Python contract is
essentially unchanged.

The existing `SphereLightNode` ("kitchen sink") **stays registered and frozen** —
these three nodes are additive.

## Why three nodes (not one node with toggles)

`sun_mode` (manual vs date/time) and `location_mode` (city vs coords) each pack
two behaviors into one node, shown via client-side show/hide (`mode.js`,
`applyVisibility`, `setWidgetVisible`). That conditional-UI state is *more* code
than three thin node setups once the render engine is shared. Splitting along both
axes removes all of it: no `sun_mode`, no `location_mode`, no `applyVisibility`,
no city↔lat/lon syncing. Each node declares only the inputs it uses, so there is
nothing to hide.

City vs. coords is normally "one responsibility, two input formats" (a weak split
candidate), but because the render engine and geo/astronomy modules are shared, a
third node costs only a ~30-line setup file — so the split is pure clarity win
with no duplication.

## The three nodes (additive)

All: `CATEGORY = "render/3d"`, `RETURN_TYPES = ("IMAGE",)`,
`RETURN_NAMES = ("render",)`. Rendering is client-side; each `execute()` only
decodes `render_b64`.

1. **`SphereLightManualNode`** → `🔆 Sphere Light — Manual`
   Inputs: `rotation`, `elevation`, `intensity`, `render_b64`. Nothing else.

2. **`SphereLightSunCityNode`** → `🔆 Sphere Light — Sun (City)`
   Inputs: `intensity`, `city` (searchable picker), `year`, `month`, `day`,
   `hour`, `minute`, compass (heading), `render_b64`. Read-only status line.

3. **`SphereLightSunCoordsNode`** → `🔆 Sphere Light — Sun (Coordinates)`
   Inputs: `intensity`, `latitude`, `longitude`, `year`, `month`, `day`, `hour`,
   `minute`, compass (heading), `render_b64`. Read-only status line.

There is **no** `sun_mode` toggle, **no** `location_mode` toggle, and **no**
city↔lat/lon syncing anywhere.

## Serialization: DOM widgets own their values (no hidden native anchors)

The kitchen-sink node persists the compass and city search by writing into hidden
*native* `heading`/`location` widgets (DOM widgets are `serialize: false`). The
new nodes drop that indirection:

- The **compass** and the **city search** are added `serialize: true` and own
  their persisted value. Each DOM widget exposes a `value` accessor bridging to
  `createCompass` / `createLocationSearch` (`getValue`/`setValue`), so ComfyUI's
  restore path (which assigns `widget.value` from `widgets_values`) applies the
  saved value back into the dial / search box.
- `heading` and `location` are therefore **removed from `INPUT_TYPES`** on the new
  nodes (both are unused server-side — `execute()` ignores them). The `execute()`
  signatures shrink accordingly.
- `latitude`/`longitude` on the Coords node stay **native** FLOAT inputs (native
  serialization is already bulletproof; no reason to make them DOM).
- `render_b64` stays a **hidden native** STRING input — it is the one hidden
  widget that legitimately persists, because the server consumes it. (Hidden
  because the user must not edit it, not as a persistence anchor.)

**Gate — save/reload round-trip (acceptance test).** DOM-widget *value*
serialization is supported but is the same v1/v2-fragile surface this repo already
works around (`triggerDraw`, `syncLabels`, v-show/v-if handling). So the serialized
compass/city approach is adopted **only if** a save → reload round-trip restores
`heading` and `city` correctly in **both** frontends (v1 LiteGraph and v2 Vue). If
v2 proves flaky for a widget, fall back to the native-anchor pattern for that
widget only (hidden native input + DOM writes into it). The greenfield nodes are
the safe place to try this; the frozen kitchen-sink is unaffected either way.

## Astronomy / timezone (unchanged)

`solar.js`, `tz.js`, and `geo.js` are untouched; both resolution paths already
exist in `sun.js`:

- **Sun (City)** → `computeSunAngles` with the `city` string (blank lat/lon) →
  `findCity` → the city's exact timezone.
- **Sun (Coordinates)** → `computeSunAngles` with lat/lon (blank location) →
  `nearestCity(lat, lon)` → borrowed timezone (`sun.js:34`, as today).

Each node's setup reads its own widgets' values (DOM `getValue` for compass/city,
native for the rest) and feeds `computeSunAngles`; the manual node skips it and
uses `rotation`/`elevation` directly.

## Status line (read-only output)

Both sun nodes show a read-only status widget — never written back to any input,
so it is not "syncing":

- City: `☀ London, England`, or `⚠ not found` on a miss (light holds last
  position).
- Coords: the resolved label incl. borrowed tz, e.g. `☀ near Austin, TX ·
  America/Chicago`; when `nearestCity` is far, worded `near X (~180 km)` so it
  never overstates the match.

This serves discoverability; drop it later if it proves noisy.

## Sharing / architecture (DRY)

- **`js/preview.js`** *(new, extracted from `sphere_widget.js`)* — the
  node-agnostic engine: `loadThree()`, `buildScene()`,
  `renderLight(ctx, { az, el, intensity }) → dataURL`, plus the canvas
  preview-widget scaffolding (`computeSize`/`draw`, `TOP_WIDGETS_H`,
  `getPreviewRect`, resize/remove handlers). Takes `node`/`ctx` as arguments. No
  ComfyUI-mode logic.
- **Shared sun setup** — one helper used by both sun nodes, differing only in
  which location widget it mounts (city search vs. native lat/lon), so the
  date/time + compass + status wiring is written once.
- **`compass.js` / `location_search.js`** — imported directly; the only change is
  adding them as `serialize: true` DOM widgets with a `value` bridge (see above).
- **`__init__.py`** — one module-level `decode_render_b64(s) → tensor` helper;
  all four node classes call it instead of copy-pasting the decode into each
  `execute()`. Add the three new classes + `NODE_CLASS_MAPPINGS` /
  `NODE_DISPLAY_NAME_MAPPINGS` entries. Kitchen-sink `INPUT_TYPES` unchanged.
- **Kitchen-sink** — switches to import `js/preview.js` for the engine (removing
  its inline copy) and calls `decode_render_b64`. Otherwise untouched: it keeps
  `sun_mode`/`location_mode`, `applyVisibility`, and its native `heading`/
  `location` anchors. Behavior verified unchanged by the existing integration
  test + a manual pass.

## Data flow (per node)

1. **Manual** — `rotation`/`elevation`/`intensity` → `renderLight` → `render_b64`.
2. **Sun (City)** — `city` + date/time + compass `heading` → `computeSunAngles`
   (city path) → `{ az, el }` + `intensity` → `renderLight` → `render_b64`; status
   shows the resolved label.
3. **Sun (Coordinates)** — `latitude`/`longitude` + date/time + compass →
   `computeSunAngles` (coords path) → `renderLight` → `render_b64`; status shows
   `near X · tz`.

## Scope

**In**
- Three new node classes + registrations; `decode_render_b64` helper.
- Extract `js/preview.js`; kitchen-sink adopts it (verified no regression).
- Shared sun-setup helper; thin manual setup.
- Serialized DOM compass + city search on the new nodes; drop native
  `heading`/`location` there, gated on the round-trip test.
- Read-only status line on the sun nodes.
- Tests + the save/reload round-trip acceptance check.

**Out**
- Any astronomy/timezone/dataset change (`solar.js`, `tz.js`, `geo.js`,
  `cities.json`).
- Any change to the kitchen-sink node's *behavior* (only the `preview.js` import
  + `decode_render_b64` call).
- Server-side/headless behavior; online geocoding; the manual-mode math.

## Testing

- **Existing suites** (`sun`, `geo`, `tz`, `solar`, `compass`, integration) pass
  unchanged.
- **Serialization round-trip (gate):** save a workflow containing each sun node →
  reload → `heading` (compass) and `city` restore correctly in **both** v1 and v2
  frontends. Failure for a widget → native-anchor fallback for that widget.
- **Manual ComfyUI pass:** all four nodes appear under `render/3d`; Manual shows
  three sliders; Sun (City) shows city + date/time + compass; Sun (Coordinates)
  shows lat/lon + date/time + compass; each renders and the status label matches;
  kitchen-sink behaves exactly as before.

## Risks / trade-offs

- **DOM-widget serialization across v1/v2** — the main risk; mitigated by the
  explicit round-trip acceptance test and per-widget native-anchor fallback.
- **Extracting `preview.js` touches the working kitchen-sink** — mitigated by the
  existing integration test + manual pass; the extraction is mechanical.
- **Node menu grows to four entries** under `render/3d` — accepted; clear names,
  and legibility is the point.
- **"Nearest city far away" mislabel** on the Coords status — mitigated by the
  `near X (~N km)` wording; read-only, informational only.
