# Time-of-Day Sun Positioning — Design

- **Date:** 2026-07-05
- **Status:** Approved (design), pending implementation plan
- **Component:** Sphere-Light-Render-ComfyUI custom node

## Goal

Let the user position the sphere's directional light from a **real-world time
of day** instead of only hand-set angles. Given a location, a date/time, and the
direction the camera faces, compute the sun's actual position and drive the
existing render. The current manual angle sliders remain available as a mode.

## Background (current state)

- The node renders a gray sphere on a gray plane in a browser-side Three.js
  scene (`js/sphere_widget.js`), lit by one `DirectionalLight`.
- Sun direction today is set by two manual sliders: `rotation` (azimuth in the
  scene frame) and `elevation`, plus `intensity`. `doRender()` places the light
  at `r·cos(el)·sin(az), r·sin(el), r·cos(el)·cos(az)`.
- The rendered canvas is exported as a base64 PNG into the `render_b64` widget;
  Python (`__init__.py`) decodes it to an IMAGE tensor. **All rendering is
  client-side.** Python does no scene work.

## Scope

**In scope**
- A `sun_mode` toggle: `manual` (today's behavior) vs `date/time` (new).
- New inputs for date/time mode: location, date, time, camera heading.
- Offline city → lat/lon/timezone lookup (US by state + populous cities worldwide).
- DST-correct local-time → UTC conversion using the browser's `Intl` API.
- Solar position (altitude/azimuth) computed in JS, mapped into the scene and
  fed to the **existing** `doRender()` light code.

**Out of scope (future)**
- Auto-deriving `intensity` from sun altitude (stays manual in v1).
- Cities under ~15k population (fall back to manual lat/lon).
- Online geocoder fallback.
- Any server-side / headless rendering change.

## Approach decisions

1. **Astronomy lives in JavaScript, not Python.** The value is the live preview
   updating as the user scrubs the time; a Python round-trip per change would
   kill that. Python stays passive (still only decodes `render_b64`). The new
   inputs are declared in `INPUT_TYPES` so they serialize with the workflow, but
   Python does not act on them.
2. **Offline bundled city dataset**, not an online geocoder — consistent with
   vendoring three.js this session. Derived at build time from GeoNames
   `cities15000` into a trimmed `js/cities.json`
   (`city, region, country, lat, lng, timezone, population`), ~1.5–2 MB.
3. **Timezone comes from the city record (IANA name).** `Intl.DateTimeFormat`
   with that `timeZone` gives the correct UTC offset for the chosen date,
   **including DST** — no manual offset input, no DST checkbox, no tz library.

## Components (small, isolated, testable)

- **`js/solar.js`** — pure function `sunPosition(lat, lng, dateUTC) → {altitude,
  azimuth}` (radians). Vendored NOAA solar-position algorithm (~40 lines). No
  DOM. Unit-testable in isolation.
- **`js/cities.json`** — trimmed GeoNames-derived dataset (built offline).
- **`js/geo.js`** — `lookupCity(query) → {lat, lng, tz, name, population} | null`.
  Parses `"City, State"` / `"City, Country"`, matches case-insensitively,
  disambiguates by highest population.
- **`js/sphere_widget.js`** — adds the widgets; in date/time mode computes az/el
  and calls the **existing, unchanged** `doRender()` light positioning.
- **`__init__.py`** — declares the new widgets in `INPUT_TYPES` (serialization
  only); no behavior change to `execute()`.

## Inputs / widgets

Shown when `sun_mode = date/time`:

| Widget | Type | Notes |
|---|---|---|
| `sun_mode` | combo | `manual` \| `date/time` |
| `location` | string | `"City, State"` (US) or `"City, Country"` |
| `year` | int | e.g. 2025 |
| `month` | int | 1–12 |
| `day` | int | 1–31 |
| `hour` | int | 0–23 (local clock time) |
| `minute` | int | 0–59 |
| `heading` | float | 0–360, compass bearing the camera faces |
| `intensity` | float | unchanged, manual |

Manual mode keeps today's `rotation` / `elevation` / `intensity` sliders.

## Data flow (date/time mode)

1. `location` → `geo.js` → `{lat, lng, tz}` (or fallback to manual lat/lon).
2. Local `year/month/day/hour/minute` + `tz` → DST-correct UTC instant via
   `Intl.DateTimeFormat`.
3. `(lat, lng, UTC)` → `solar.js` → `{altitude, azimuth}`.
4. `elevation = altitude`; `rotation = azimuth − heading`.
5. Feed into the existing `doRender()` light code and re-render the preview.

Note: date/time mode uses the **true solar altitude (0–90°)**, not the manual
slider's 5–85° cap — the manual clamp does not apply here. `rotation` is
normalized to the scene's expected range after subtracting `heading`.

## Conventions (bug-prone; pin down once)

- **Azimuth zero point:** fix a single convention in `solar.js` (compass: 0 =
  North, clockwise) and convert once. A test guards against a 180° flip.
- **Coupling:** `scene_rotation = solar_azimuth − heading`. The sign determines
  whether the shadow points the correct way; covered by a directional test.

## Error handling / defaults

- **City not found** → warn; fall back to manual lat/lon fields (kept available).
- **Ambiguous city** → pick highest population; display the chosen match.
- **Sun below horizon (night)** → clamp `elevation` to the horizon and warn
  ("sun below horizon at this time") rather than render darkness. A reference
  ball at night conveys no direction.
- **Intensity** stays manual in v1.

## Testing

- **`solar.js`**: assert altitude/azimuth against NOAA reference values for a
  known lat/lng/UTC (tolerance ~0.5°). Verified headless via the Playwright +
  local-HTTP harness used earlier this session.
- **`geo.js`**: look up a few US cities (`Austin, TX`) and international cities
  (`Tokyo, Japan`, `London, UK`); assert lat/lng/tz and population-based
  disambiguation.
- **Integration**: sanity-check shadow direction for a known case (e.g. sun in
  the east at ~8am, camera facing north → shadow to the west in-frame).

## Risks / trade-offs

- **Repo size** grows ~1.5–2 MB for `cities.json`. Acceptable; comparable order
  to the vendored three.js.
- **Coverage**: sub-15k-population places are absent → manual lat/lon fallback.
- **Convention errors** (azimuth/heading sign) are the main correctness risk —
  mitigated by explicit tests.
