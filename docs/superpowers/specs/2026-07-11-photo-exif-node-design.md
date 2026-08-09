# Photo (EXIF) Node — Design

- **Date:** 2026-07-11
- **Status:** Approved (design), pending implementation plan
- **Component:** Sphere-Light-Render-ComfyUI custom nodes
- **Builds on:** `2026-07-08-input-driven-sphere-light-design.md` (graph-driven
  inputs; since superseded by the client-side mechanism in `js/nodes.js` —
  `connectedInputValue` + `hookSourceWidgets`)

## Goal

A new node, **📷 Sphere Light — Photo (EXIF)**, that turns a photo into the
inputs the Sun nodes want. Upload a photo; the node reads its EXIF metadata and
exposes **latitude, longitude, city, heading, and the capture date/time** as
outputs that wire directly into 🔆 Sun (City) / 🔆 Sun (Coordinates). It also
outputs the photo itself as an `IMAGE`, so one upload feeds both the pixels and
the light direction (it can replace a Load Image node).

End-to-end story: *photo in → sphere lit the way the sun actually was when and
where the photo was taken.*

## Decisions (from brainstorming)

- **Browser parses EXIF; widgets are the data store.** The sphere nodes resolve
  connected inputs client-side by reading a widget **by name** on the origin
  node (`connectedInputValue` in `js/nodes.js`). So this node's parsed values
  live in widgets named exactly `latitude`, `longitude`, `city`, `heading`,
  `year`, `month`, `day`, `hour`, `minute` — and the existing driving/live
  re-render mechanism works with **zero changes to the sphere nodes**.
- **Python is a pass-through** for the nine values (same "browser bakes values"
  pattern as `render_b64`): widget values serialize into the prompt at queue
  time, `execute()` returns them as outputs. No second EXIF parser in Python,
  no new server routes (approach B/C rejected: duplicate parser buys nothing —
  headless runs can't drive the sphere nodes anyway; a parse endpoint would
  re-introduce the round-trip removed in `e53f000`).
- **The node needs the image *file*, not an `IMAGE` input** — tensors are
  decoded pixels, EXIF is already gone. So it has its own Load-Image-style
  upload widget.
- **Widgets stay editable.** A photo missing a tag (no compass heading is
  common — phones only write `GPSImgDirection` when the compass was active)
  can be corrected by hand right on the node; parsing only overwrites widgets
  for tags actually present in the file.
- **Date/time included** (EXIF `DateTimeOriginal`), since sun position at
  capture time is the point. **Image pass-through included.**

## Node definition (Python, `__init__.py`)

`SphereLightPhotoExifNode`, display name **📷 Sphere Light — Photo (EXIF)**,
category `render/3d`.

- **Inputs (all widgets):**
  - `image` — file combo over the ComfyUI input directory with
    `{"image_upload": True}` (standard Load Image pattern; the core frontend
    supplies the upload button and on-node thumbnail).
  - `latitude` FLOAT (−90…90, step 0.0001, default 0), `longitude` FLOAT
    (−180…180, step 0.0001, default 0), `city` STRING (default ""), `heading`
    FLOAT (0…360, step 0.01, default 0), `year`/`month`/`day`/`hour`/`minute`
    INT (same ranges/defaults as the Sun nodes).
- **Outputs:** `IMAGE`, `latitude` FLOAT, `longitude` FLOAT, `city` STRING,
  `heading` FLOAT, `year` INT, `month` INT, `day` INT, `hour` INT, `minute`
  INT.
- **`execute()`:** load the file with PIL (`ImageOps.exif_transpose` so
  orientation matches what the user saw), convert to the usual
  `(1,H,W,3)` float32 tensor, and return it plus the nine widget values
  unchanged. `IS_CHANGED` hashes the file (Load Image pattern). No MASK
  output (YAGNI).

## EXIF parser (`js/exif.js`, new — pure, dependency-free)

`parseExif(arrayBuffer)` → `{ lat, lng, heading, date }`, each `null`/absent
when the tag is missing. Internals:

- **Container scan** to find the TIFF/EXIF payload: JPEG (APP1 segment tagged
  `Exif\0\0`), PNG (`eXIf` chunk), WebP (RIFF `EXIF` chunk). Other/absent →
  "no EXIF".
- **TIFF/IFD reader:** endianness from `II`/`MM`; IFD0 → GPS IFD pointer
  (0x8825) and Exif IFD pointer (0x8769).
  - GPS IFD: `GPSLatitude` (three rationals, DMS → decimal) with
    `GPSLatitudeRef` (`S` → negative), same for longitude (`W` → negative),
    `GPSImgDirection` (rational, degrees from North — the repo's `heading`
    definition already matches it per the README).
  - Exif IFD: `DateTimeOriginal` (`YYYY:MM:DD HH:MM:SS`) → `{year, month,
    day, hour, minute}`.
- Every offset/count is bounds-checked; malformed data throws and the caller
  treats it as "no EXIF" (the file arrives from the user's own disk, but a
  truncated or repacked file must not wedge the node).

Pure functions over an `ArrayBuffer` — unit-testable in Node with synthetic
byte fixtures, no DOM.

## Node glue (`js/nodes.js`)

A `setupPhotoExif(node)` branch in the existing `nodeCreated` extension:

1. Add the same status line the Sun nodes use (`addStatus`).
2. Hook the `image` widget's callback. Parse **only when the image changes**
   (upload or picking another file) — not at setup: widget values persist in
   the workflow JSON, so re-parsing on reload would only serve to clobber
   hand-corrected values. On change:
   - Fetch the file from ComfyUI's `/view` endpoint (`filename`/`subfolder`/
     `type=input` derived from the widget value, handling the
     `subfolder/name [type]` annotation format).
   - `parseExif()` the bytes.
   - For each tag present, set the matching widget **via its callback**, so
     `hookSourceWidgets`' wrapper fires and any connected sphere node
     re-renders live. Absent tags leave their widgets untouched.
   - `city`: reverse-geocode with the existing `nearestCity(lat, lng)` and
     write a string that `findCity` resolves back to the same record
     (`City, RegionCode-or-Country`).
   - Status reports what was found:
     `📷 48.86, 2.35 near Paris · heading 214.50°`, with warnings for the
     gaps: `⚠ no GPS data in this image`, `no heading tag`,
     `no date/time tag`.

## Data flow (driving the Sun nodes)

Connect e.g. `heading → heading`, `city → city` (Sun City) or
`latitude/longitude → latitude/longitude` (Sun Coords), plus the date/time
outputs. At queue time — and live, on photo change — the sphere node's
`connectedInputValue` follows the link to this node and finds the identically
named widget holding the parsed value. Nothing new to build on the consumer
side; this node just has to keep those widgets accurate.

## Error handling

- No/garbled EXIF, missing tags, unreadable file, fetch failure → status-line
  warning; widgets keep their current (hand-editable) values; never throws
  into LiteGraph.
- Python `execute()` guards file loading the same way Load Image does; the
  nine value outputs are pass-through and can't fail.
- Headless/API runs: outputs are the last browser-baked widget values — the
  same documented limitation as every driven input in this repo.

## Scope

**In:** the new node class + registration; `js/exif.js`; the `setupPhotoExif`
glue; `tests/exif.test.js`; README section; `tools/test_comfy_load.py`
coverage.

**Out:** HEIC parsing (browsers can't preview it and ComfyUI uploads rarely
carry it — revisit on demand); magnetic vs true north correction for
`GPSImgDirectionRef` (treated as-is, like EXIF viewers do); any change to the
three existing nodes; server-side EXIF parsing.

## Testing

- **`tests/exif.test.js` (node:test):** DMS→decimal incl. S/W signs; rational
  heading; `DateTimeOriginal` parsing; JPEG/PNG/WebP container location;
  missing-tag and truncated/garbage buffers (no throw leaks); both
  endiannesses. Fixtures are small hand-built byte arrays.
- **Python:** node registers and loads (`tools/test_comfy_load.py`).
- **End-to-end gate (Playwright on the local ComfyUI):** upload a real
  GPS-tagged photo → widgets fill, status shows the resolved city; wire
  outputs into a Sun node → sphere re-renders to match; photo without GPS →
  warning, widgets untouched.

## Risks / trade-offs

- **Hand-rolled EXIF parsing** — the format is stable and the needed subset is
  small; bounded by tests over synthetic fixtures and real-photo verification.
- **Widget-name coupling** — driving depends on this node's widget names
  matching the Sun nodes' input names; cheap to keep in sync, called out in
  code comments on both sides.
- **`nearestCity` mismatch** — the nearest listed city can be a suburb, so the
  `city` string may surprise; the status line shows exactly what was resolved,
  and lat/lon outputs (Sun Coords) bypass the issue entirely.
