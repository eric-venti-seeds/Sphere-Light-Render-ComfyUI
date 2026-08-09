# Mode UI Clarity — Design

- **Date:** 2026-07-06
- **Status:** Approved (design), pending implementation plan
- **Component:** Sphere-Light-Render-ComfyUI custom node
- **Builds on:** `2026-07-05-time-of-day-sun-design.md`

## Goal

Make the node's two lighting modes (manual angles vs. date/time sun) obvious and
uncluttered. Today every input for both modes is shown at once, the mode toggle
is buried mid-stack, city vs. lat/lon ambiguity is invisible, and `heading` is a
context-free 0–360 number. Fix all four so the active model is always clear.

## Background (current state)

- `__init__.py` declares inputs in this order: `rotation`, `elevation`,
  `intensity`, `sun_mode`, `location`, `latitude`, `longitude`, `year`, `month`,
  `day`, `hour`, `minute`, `heading`, `render_b64`. ComfyUI shows **all** of them
  regardless of `sun_mode`.
- `sun_mode` (combo `manual` | `date/time`) is the 4th widget.
- `js/sun.js` (`computeSunAngles`) silently prefers a matched city, else falls
  back to lat/lon — the UI never states which won.
- `heading` is a bare slider with no N/E/S/W cues.
- Rendering is entirely client-side; Python only decodes `render_b64`
  (unchanged by this work).

## Problems → causes

| Complaint | Cause |
|---|---|
| Toggling modes is unclear | `sun_mode` is the 4th widget, not the first |
| All inputs visible at once | Nothing hides based on the selected mode |
| City vs. lat/lon — which drives? | Both always shown; resolver silently picks |
| Heading is a meaningless number | 0–360 slider with no cardinal context |

## Scope

**In scope**
- Move the mode toggle to the top; relabel it `Light direction` with values
  `Manual` / `Date/time`.
- Show only the active mode's controls (reversible show/hide).
- A `City` / `Coordinates` sub-toggle in date/time mode; only the chosen input is
  shown, and only it drives the sun (no silent fallback).
- Replace the `heading` slider with a small draggable compass dial (N up, 0°,
  clockwise) that keeps full-precision angles.

**Out of scope**
- Any change to the astronomy (`solar.js`), timezone, or city dataset.
- Server-side / headless behavior; `execute()` still only decodes `render_b64`.
- Auto-intensity, new dataset coverage, online geocoding.

## Approach decisions

1. **Reorder `INPUT_TYPES` directly** to get the toggle-first, stable layout.
   ComfyUI serializes widget values positionally, so this shifts old workflows'
   value slots — accepted: the user confirmed order preservation is unneeded and
   the date/time feature only landed a few commits ago. Simpler than doing all
   reordering in JS.
2. **Reversible show/hide in JS**, reusing the existing collapse trick (set
   `computeSize → [0,0]`, no-op `draw`, `type = "hidden"`; for DOM widgets also
   `element.style.display = "none"`). Originals are captured once so widgets can
   be restored. One `applyVisibility()` runs on every mode / sub-mode change.
3. **Explicit location source.** A new serialized `location_mode` combo
   (`city` | `coords`). `getAngles()` passes only the active source into
   `computeSunAngles` (city mode → blank lat/lon; coords mode → blank location),
   so the resolver's existing priority logic yields exactly the chosen source.
   `sun.js` is otherwise unchanged.
4. **Compass as a DOM widget**, mirroring the location search: a self-contained
   module with a pure angle helper, driving the still-serialized (now hidden)
   `heading` value.

## Components (small, isolated, testable)

- **`__init__.py`** — reordered `INPUT_TYPES`; new `location_mode` combo. No
  `execute()` behavior change (add the param, ignore it like the others).
- **`js/compass.js`** *(new)* — `createCompass({ initial, onChange }) →
  { element, setValue, getValue, destroy }`. Canvas dial with N/E/S/W ticks and a
  needle; pointer-drag sets the angle. Pure helper
  `pointerToHeading(cx, cy, x, y) → deg` (0 = N/up, clockwise) carries the math.
  No ComfyUI dependency — driveable in a plain browser, like `location_search.js`.
- **`js/compass.test.js`** *(new)* — unit tests for `pointerToHeading`
  (cardinal points, wraparound, center-click stability).
- **`js/sphere_widget.js`** — `applyVisibility()` for mode + sub-mode; integrate
  the compass DOM widget and hide the native `heading` slider (same pattern as the
  location search hiding `location`); gate city/coords in `getAngles()`; keep the
  status widget, shown only in date/time mode; add `location_mode` to the hooked
  widgets so changes re-render and re-apply visibility.

## Widget visibility by mode

**Manual** — visible: `Light direction`, `rotation`, `elevation`, `intensity`.
Hidden: everything date/time.

**Date/time** — visible: `Light direction`, `intensity`, `location_mode`
(`City`|`Coordinates`), then **either** the city search **or** `latitude` +
`longitude`, then `year`/`month`/`day`/`hour`/`minute`, the compass, and the
status line. Hidden: `rotation`, `elevation`, and the inactive location input.

`intensity` shows in both modes; `rotation`/`elevation` are manual-only (they are
computed, not set, in date/time mode).

## Compass convention

- **0° = North = up; clockwise** (E = 90°, S = 180°, W = 270°) — matches the
  compass azimuth convention already fixed in `solar.js`. The dial only sets the
  `heading` number; the heading → scene mapping in `sun.js`
  (`rotation = azimuth − heading`) is unchanged.
- Drag anywhere on the dial → `pointerToHeading` maps the pointer vector to a
  bearing; a click at dead center is a no-op (undefined direction).

## Data flow (unchanged except source gating)

1. `location_mode` selects source: city text **or** lat/lon (never both).
2. Selected source + date/time + `heading` → `computeSunAngles` (unchanged).
3. `elevation = altitude`, `rotation = azimuth − heading` → existing `doRender()`.
4. Status widget shows the resolved `☀ …` label or a `⚠ …` hint.

## Error handling / defaults

- **Coords mode, lat/lon still 0/0** → resolver returns the existing
  "enter a city or lat/lon" hint (no stale-city fallthrough, since city text is
  suppressed in coords mode).
- **City mode, name not found** → existing "…not found — check spelling" hint;
  the light holds its last position.
- Mode/sub-mode default: `sun_mode = manual`, `location_mode = city`.

## Testing

- **`compass.test.js`**: `pointerToHeading` returns 0/90/180/270 for
  up/right/down/left, wraps correctly, and is stable at center.
- **Existing suites** (`sun`, `geo`, `tz`, `solar`, integration) still pass.
- **Manual pass in ComfyUI**: toggle modes and City↔Coords and confirm only the
  active inputs render; drag the compass and confirm the render tracks and the
  status label matches the active source.

## Risks / trade-offs

- **Serialization order break** for pre-existing saved workflows — accepted (see
  Approach 1).
- **Reversible-hide fiddliness**: collapsing/restoring widgets must also resize
  the node so the preview reflows; covered by re-running the existing size
  recompute after `applyVisibility()`.
- **Compass is a custom widget** (more code than a slider) — chosen deliberately
  for intuitiveness; contained to `compass.js` with a tested pure core.
