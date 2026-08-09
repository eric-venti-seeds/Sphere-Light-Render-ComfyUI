# Photo (EXIF) Node Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new node, 📷 Sphere Light — Photo (EXIF), that reads a photo's EXIF in the browser and outputs `IMAGE` + latitude/longitude/city/heading/year/month/day/hour/minute for wiring into the Sun nodes.

**Architecture:** The browser parses EXIF (`js/exif.js`, dependency-free) and bakes the values into widgets on the node whose **names match the Sun nodes' input names** — that is the entire integration, because `connectedInputValue()` in `js/nodes.js` resolves a connection by looking up an identically named widget on the origin node. Python (`__init__.py`) is a Load-Image-style file loader plus a pass-through of the nine widget values.

**Tech Stack:** Vanilla ES modules + `node:test` (JS); PIL/numpy/torch already in `__init__.py` (Python, no new deps).

**Spec:** `docs/superpowers/specs/2026-07-11-photo-exif-node-design.md`

## Global Constraints

- **No new dependencies**, JS or Python. The EXIF parser is hand-rolled.
- **`js/` is ComfyUI's WEB_DIRECTORY** — every `.js` file in it is auto-imported by the browser. Runtime modules only; tests and test helpers go under `tests/`.
- **Widget names on the new node must exactly match the Sun nodes' input names:** `latitude`, `longitude`, `city`, `heading`, `year`, `month`, `day`, `hour`, `minute`. Renaming any of them silently breaks driving.
- **The user has unrelated staged changes in the index.** Every commit MUST use the path-restricted form `git commit -m "..." -- <paths>` (never bare `git add … && git commit`), so their staged work is not swept into your commit.
- JS tests: `npm test` from the repo root runs `node --test "tests/*.test.js"`.
- Python tool tests run as plain scripts: `python tools/<name>.py` from the repo root (they must keep working without ComfyUI installed — stub `torch`/`folder_paths`).
- Widget ranges/defaults copied from the Sun nodes: latitude FLOAT −90…90 step 0.0001, longitude FLOAT −180…180 step 0.0001, heading FLOAT 0…360 step 0.01, year INT 1…9999 default 2025, month INT 1…12 default 6, day INT 1…31 default 21, hour INT 0…23 default 12, minute INT 0…59 default 0.

---

### Task 1: TIFF/EXIF core — `dmsToDeg` + `parseTiff`

**Files:**
- Create: `js/exif.js`
- Create: `tests/helpers/tiff.js` (fixture builder, shared with Task 2 and the e2e fixture generator)
- Create: `tests/exif.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `js/exif.js`: `dmsToDeg(dms: number[], ref: string) -> number`; `parseTiff(bytes: Uint8Array) -> { lat, lng, heading, date }` where each field is `null` when absent, `date` is `{year, month, day, hour, minute}`; throws on malformed input.
  - `tests/helpers/tiff.js`: `buildTiff(opts) -> Uint8Array` with opts `{ lat: [d,m,s], latRef, lng: [d,m,s], lngRef, heading: number, dateTime: "YYYY:MM:DD HH:MM:SS", littleEndian: boolean }` (all optional).

- [ ] **Step 1: Write the fixture builder**

`tests/helpers/tiff.js` (complete file):

```js
// Hand-rolled TIFF/EXIF fixture builder for tests (and the e2e fixture
// script). Layout: header(8) | IFD0 | GPS IFD | Exif IFD | data area.
// opts: { lat: [d,m,s], latRef, lng: [d,m,s], lngRef, heading: number,
//         dateTime: "YYYY:MM:DD HH:MM:SS", littleEndian (default true) }
export function buildTiff(opts = {}) {
  const le = opts.littleEndian !== false;
  const u16 = (v) => (le ? [v & 255, (v >> 8) & 255] : [(v >> 8) & 255, v & 255]);
  const u32 = (v) =>
    le ? [...u16(v & 0xffff), ...u16(v >>> 16)] : [...u16(v >>> 16), ...u16(v & 0xffff)];
  const rational = (v, den = 10000) => [...u32(Math.round(v * den)), ...u32(den)];
  const ascii = (s) => [...s].map((c) => c.charCodeAt(0)).concat([0]);

  // Entry spec: [tag, type, count, inline4Bytes | null, outOfLineBytes | null]
  const gps = [];
  if (opts.lat != null) {
    gps.push([0x0001, 2, 2, ascii(opts.latRef || "N").concat([0, 0]).slice(0, 4), null]);
    gps.push([0x0002, 5, 3, null, opts.lat.flatMap((v) => rational(v))]);
    gps.push([0x0003, 2, 2, ascii(opts.lngRef || "E").concat([0, 0]).slice(0, 4), null]);
    gps.push([0x0004, 5, 3, null, opts.lng.flatMap((v) => rational(v))]);
  }
  if (opts.heading != null) gps.push([0x0011, 5, 1, null, rational(opts.heading)]);
  const exif = [];
  if (opts.dateTime != null) exif.push([0x9003, 2, 20, null, ascii(opts.dateTime)]);

  const ifdSize = (n) => 2 + n * 12 + 4;
  const ifd0N = (gps.length ? 1 : 0) + (exif.length ? 1 : 0);
  const gpsOff = 8 + ifdSize(ifd0N);
  const exifOff = gpsOff + (gps.length ? ifdSize(gps.length) : 0);
  let dataOff = exifOff + (exif.length ? ifdSize(exif.length) : 0);
  const ifd0 = [];
  if (gps.length) ifd0.push([0x8825, 4, 1, u32(gpsOff), null]);
  if (exif.length) ifd0.push([0x8769, 4, 1, u32(exifOff), null]);

  const out = [];
  const data = [];
  const writeIfd = (entries) => {
    out.push(...u16(entries.length));
    for (const [tag, type, count, inline, payload] of entries) {
      out.push(...u16(tag), ...u16(type), ...u32(count));
      if (inline) out.push(...inline);
      else {
        out.push(...u32(dataOff));
        data.push(...payload);
        dataOff += payload.length;
      }
    }
    out.push(...u32(0)); // next-IFD pointer: none
  };
  out.push(...(le ? [0x49, 0x49] : [0x4d, 0x4d]), ...u16(42), ...u32(8));
  writeIfd(ifd0);
  if (gps.length) writeIfd(gps);
  if (exif.length) writeIfd(exif);
  out.push(...data);
  return new Uint8Array(out);
}
```

- [ ] **Step 2: Write the failing tests**

`tests/exif.test.js` (initial content; Task 2 appends to it):

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { dmsToDeg, parseTiff } from "../js/exif.js";
import { buildTiff } from "./helpers/tiff.js";

test("dmsToDeg converts DMS and applies hemisphere sign", () => {
  assert.ok(Math.abs(dmsToDeg([48, 51, 29.6], "N") - 48.858222) < 1e-4);
  assert.ok(Math.abs(dmsToDeg([48, 51, 29.6], "S") + 48.858222) < 1e-4);
  assert.ok(dmsToDeg([2, 17, 40.2], "W") < 0);
  assert.ok(dmsToDeg([2, 17, 40.2], "E") > 0);
});

const PARIS = {
  lat: [48, 51, 29.6], latRef: "N",
  lng: [2, 17, 40.2], lngRef: "E",
  heading: 214.5, dateTime: "2023:06:21 14:30:00",
};

test("parseTiff reads GPS, heading, and date (little-endian)", () => {
  const r = parseTiff(buildTiff(PARIS));
  assert.ok(Math.abs(r.lat - 48.858222) < 1e-4);
  assert.ok(Math.abs(r.lng - 2.294500) < 1e-4);
  assert.ok(Math.abs(r.heading - 214.5) < 1e-6);
  assert.deepEqual(r.date, { year: 2023, month: 6, day: 21, hour: 14, minute: 30 });
});

test("parseTiff reads big-endian TIFF", () => {
  const r = parseTiff(buildTiff({ ...PARIS, littleEndian: false }));
  assert.ok(Math.abs(r.lat - 48.858222) < 1e-4);
  assert.ok(Math.abs(r.heading - 214.5) < 1e-6);
  assert.deepEqual(r.date, { year: 2023, month: 6, day: 21, hour: 14, minute: 30 });
});

test("southern/western hemisphere comes out negative", () => {
  const r = parseTiff(buildTiff({
    lat: [33, 52, 4], latRef: "S", lng: [151, 12, 26], lngRef: "W",
  }));
  assert.ok(r.lat < 0);
  assert.ok(r.lng < 0);
});

test("missing tags yield nulls, present ones still parse", () => {
  const r = parseTiff(buildTiff({ heading: 90 }));
  assert.equal(r.lat, null);
  assert.equal(r.lng, null);
  assert.equal(r.date, null);
  assert.ok(Math.abs(r.heading - 90) < 1e-6);
  const empty = parseTiff(buildTiff({}));
  assert.deepEqual(empty, { lat: null, lng: null, heading: null, date: null });
});

test("parseTiff throws on non-TIFF bytes (caller catches)", () => {
  assert.throws(() => parseTiff(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])));
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../js/exif.js'` (the seven pre-existing test files still pass).

- [ ] **Step 4: Implement the TIFF core**

`js/exif.js` (initial content; Task 2 appends the container scan):

```js
// Minimal EXIF reader: enough to pull the GPS position, the compass heading
// (GPSImgDirection — the repo's `heading` definition), and the capture time
// out of a photo in the browser. No dependencies; pure functions over bytes.
// Unit tests: tests/exif.test.js.

const TYPE_SIZES = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
const MAX_COUNT = 4096; // sanity cap — no tag we read is remotely this large

// One IFD (directory of 12-byte tag entries) -> Map(tag -> entry).
function readIfd(dv, ifdOffset, le) {
  const entries = new Map();
  const count = dv.getUint16(ifdOffset, le);
  for (let i = 0; i < count; i++) {
    const off = ifdOffset + 2 + i * 12;
    entries.set(dv.getUint16(off, le), {
      type: dv.getUint16(off + 2, le),
      count: dv.getUint32(off + 4, le),
      valueOffset: off + 8, // where the 4 value-or-pointer bytes live
    });
  }
  return entries;
}

// Where an entry's payload starts: inline if it fits the 4 bytes, else pointed-to.
function payloadOffset(dv, entry, le) {
  if (entry.count > MAX_COUNT) throw new Error("EXIF value too large");
  const size = (TYPE_SIZES[entry.type] || 1) * entry.count;
  return size <= 4 ? entry.valueOffset : dv.getUint32(entry.valueOffset, le);
}

function readAscii(dv, entry, le) {
  const off = payloadOffset(dv, entry, le);
  let s = "";
  for (let i = 0; i < entry.count; i++) {
    const c = dv.getUint8(off + i);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

function readRationals(dv, entry, le) {
  const off = payloadOffset(dv, entry, le);
  const out = [];
  for (let i = 0; i < entry.count; i++) {
    const num = dv.getUint32(off + i * 8, le);
    const den = dv.getUint32(off + i * 8 + 4, le);
    out.push(den === 0 ? NaN : num / den);
  }
  return out;
}

// [deg, min, sec] -> signed decimal degrees ("S"/"W" hemisphere -> negative).
export function dmsToDeg(dms, ref) {
  const [d = NaN, m = 0, s = 0] = dms || [];
  const deg = d + m / 60 + s / 3600;
  return /^[SW]/i.test(ref || "") ? -deg : deg;
}

// Tag ids (EXIF 2.3).
const IFD0_GPS = 0x8825;
const IFD0_EXIF = 0x8769;
const GPS_LAT_REF = 0x0001, GPS_LAT = 0x0002, GPS_LNG_REF = 0x0003, GPS_LNG = 0x0004;
const GPS_IMG_DIR = 0x0011;
const EXIF_DATETIME_ORIGINAL = 0x9003;

// Parse a TIFF/EXIF block. Returns { lat, lng, heading, date } — each null
// when absent (date: {year, month, day, hour, minute}). Throws on malformed
// input; parseExif() is the catching entry point. Out-of-range offsets throw
// RangeError from DataView, which serves as the bounds check.
export function parseTiff(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const order = dv.getUint16(0);
  if (order !== 0x4949 && order !== 0x4d4d) throw new Error("not a TIFF block");
  const le = order === 0x4949;
  if (dv.getUint16(2, le) !== 42) throw new Error("bad TIFF magic");
  const ifd0 = readIfd(dv, dv.getUint32(4, le), le);

  const out = { lat: null, lng: null, heading: null, date: null };

  const gpsPtr = ifd0.get(IFD0_GPS);
  if (gpsPtr) {
    const gps = readIfd(dv, dv.getUint32(gpsPtr.valueOffset, le), le);
    const lat = gps.get(GPS_LAT), lng = gps.get(GPS_LNG);
    if (lat && lng) {
      const latRef = gps.has(GPS_LAT_REF) ? readAscii(dv, gps.get(GPS_LAT_REF), le) : "N";
      const lngRef = gps.has(GPS_LNG_REF) ? readAscii(dv, gps.get(GPS_LNG_REF), le) : "E";
      const la = dmsToDeg(readRationals(dv, lat, le), latRef);
      const ln = dmsToDeg(readRationals(dv, lng, le), lngRef);
      if (Number.isFinite(la) && Number.isFinite(ln)) {
        out.lat = la;
        out.lng = ln;
      }
    }
    const dir = gps.get(GPS_IMG_DIR);
    if (dir) {
      const h = readRationals(dv, dir, le)[0];
      if (Number.isFinite(h)) out.heading = h;
    }
  }

  const exifPtr = ifd0.get(IFD0_EXIF);
  if (exifPtr) {
    const exif = readIfd(dv, dv.getUint32(exifPtr.valueOffset, le), le);
    const dt = exif.get(EXIF_DATETIME_ORIGINAL);
    if (dt) {
      const m = readAscii(dv, dt, le).match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2})/);
      if (m) {
        out.date = { year: +m[1], month: +m[2], day: +m[3], hour: +m[4], minute: +m[5] };
      }
    }
  }
  return out;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: PASS (all files, including the 7 pre-existing ones).

- [ ] **Step 6: Commit (path-restricted — see Global Constraints)**

```bash
git commit -m "feat(exif): TIFF/IFD core — GPS lat/lng, heading, DateTimeOriginal" -- js/exif.js tests/exif.test.js tests/helpers/tiff.js
```

---

### Task 2: Container scan — `findExifPayload` + `parseExif`

**Files:**
- Modify: `js/exif.js` (append)
- Modify: `tests/helpers/tiff.js` (append wrappers)
- Modify: `tests/exif.test.js` (append tests)

**Interfaces:**
- Consumes: `parseTiff`, `buildTiff` from Task 1.
- Produces:
  - `js/exif.js`: `findExifPayload(bytes: Uint8Array) -> Uint8Array | null`; `parseExif(arrayBuffer: ArrayBuffer) -> { lat, lng, heading, date }` — **never throws**; malformed/absent EXIF yields all-null.
  - `tests/helpers/tiff.js`: `app1Segment(tiff) -> number[]` (the raw JPEG APP1 bytes — reused by the e2e fixture script in Task 6), `jpegWith(tiff) -> Uint8Array`, `pngWith(tiff) -> Uint8Array`, `webpWith(tiff) -> Uint8Array`.

- [ ] **Step 1: Append container wrappers to the fixture builder**

Append to `tests/helpers/tiff.js`:

```js
// ---- container wrappers ----------------------------------------------------

const chars = (s) => [...s].map((c) => c.charCodeAt(0));

// The raw JPEG APP1 segment (marker + length + "Exif\0\0" + TIFF) — also used
// to splice EXIF into a real photo for the e2e fixture.
export function app1Segment(tiff) {
  const payload = [...chars("Exif"), 0, 0, ...tiff];
  const len = payload.length + 2; // length field counts itself
  return [0xff, 0xe1, (len >> 8) & 255, len & 255, ...payload];
}

export function jpegWith(tiff) {
  return new Uint8Array([0xff, 0xd8, ...app1Segment(tiff), 0xff, 0xd9]);
}

export function pngWith(tiff) {
  const be32 = (v) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...be32(tiff.length), ...chars("eXIf"), ...tiff, 0, 0, 0, 0, // CRC unchecked
    ...be32(0), ...chars("IEND"), 0, 0, 0, 0,
  ]);
}

export function webpWith(tiff) {
  const le32 = (v) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255];
  const chunk = [...chars("EXIF"), ...le32(tiff.length), ...tiff];
  if (tiff.length & 1) chunk.push(0); // chunks are even-padded
  return new Uint8Array([...chars("RIFF"), ...le32(4 + chunk.length), ...chars("WEBP"), ...chunk]);
}
```

- [ ] **Step 2: Append the failing tests**

Append to `tests/exif.test.js` (also extend the first import line to `import { parseExif, findExifPayload, dmsToDeg, parseTiff } from "../js/exif.js";` and the helper import to `import { buildTiff, jpegWith, pngWith, webpWith } from "./helpers/tiff.js";`):

```js
test("findExifPayload locates the TIFF block in JPEG, PNG, and WebP", () => {
  const tiff = buildTiff(PARIS);
  for (const wrap of [jpegWith, pngWith, webpWith]) {
    const found = findExifPayload(wrap(tiff));
    assert.ok(found, wrap.name);
    assert.deepEqual([...found.subarray(0, 4)], [...tiff.subarray(0, 4)], wrap.name);
  }
});

test("parseExif end-to-end on each container", () => {
  const tiff = buildTiff(PARIS);
  for (const wrap of [jpegWith, pngWith, webpWith]) {
    const r = parseExif(wrap(tiff).buffer);
    assert.ok(Math.abs(r.lat - 48.858222) < 1e-4, wrap.name);
    assert.ok(Math.abs(r.heading - 214.5) < 1e-6, wrap.name);
    assert.equal(r.date.year, 2023, wrap.name);
  }
});

test("parseExif never throws on junk or truncated input", () => {
  const empty = { lat: null, lng: null, heading: null, date: null };
  const truncated = jpegWith(buildTiff(PARIS)).slice(0, 24);
  for (const buf of [
    new ArrayBuffer(0),
    new Uint8Array([1, 2, 3]).buffer,
    truncated.buffer.slice(truncated.byteOffset, truncated.byteOffset + truncated.byteLength),
    new Uint8Array(64).buffer, // zeros: no known container signature
  ]) {
    assert.deepEqual(parseExif(buf), empty);
  }
});

test("parseExif on an EXIF-less container yields all-null", () => {
  // A JPEG with no APP1 at all: SOI + EOI.
  assert.deepEqual(parseExif(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer),
                   { lat: null, lng: null, heading: null, date: null });
});
```

- [ ] **Step 3: Run tests to verify the new ones fail**

Run: `npm test`
Expected: FAIL — `findExifPayload`/`parseExif` are not exported.

- [ ] **Step 4: Append the container scan to `js/exif.js`**

```js
// ---- container scan: find the TIFF/EXIF payload in a photo file ------------

// JPEG: scan APP1 segments for an "Exif\0\0" payload.
function tiffFromJpeg(bytes, dv) {
  let i = 2;
  while (i + 4 <= bytes.length) {
    if (bytes[i] !== 0xff) break;
    const marker = bytes[i + 1];
    if (marker === 0xd9 || marker === 0xda) break; // EOI / start of image data
    const len = dv.getUint16(i + 2); // includes the 2 length bytes
    if (marker === 0xe1 && len >= 8 &&
        String.fromCharCode(...bytes.subarray(i + 4, i + 10)) === "Exif\0\0") {
      return bytes.subarray(i + 10, i + 2 + len);
    }
    i += 2 + len;
  }
  return null;
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function tiffFromPng(bytes, dv) {
  let i = 8;
  while (i + 8 <= bytes.length) {
    const len = dv.getUint32(i); // big-endian
    const type = String.fromCharCode(...bytes.subarray(i + 4, i + 8));
    if (type === "eXIf") return bytes.subarray(i + 8, i + 8 + len);
    if (type === "IEND") break;
    i += 12 + len; // length + type + data + CRC
  }
  return null;
}

function tiffFromWebp(bytes, dv) {
  let i = 12;
  while (i + 8 <= bytes.length) {
    const fourcc = String.fromCharCode(...bytes.subarray(i, i + 4));
    const len = dv.getUint32(i + 4, true); // little-endian
    if (fourcc === "EXIF") {
      let p = bytes.subarray(i + 8, i + 8 + len);
      // Some writers keep the JPEG-style "Exif\0\0" prefix inside the chunk.
      if (p.length >= 6 && String.fromCharCode(...p.subarray(0, 6)) === "Exif\0\0") {
        p = p.subarray(6);
      }
      return p;
    }
    i += 8 + len + (len & 1); // chunks are even-padded
  }
  return null;
}

// Locate the TIFF block inside a JPEG / PNG / WebP file; null when absent.
export function findExifPayload(bytes) {
  if (bytes.length < 12) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint16(0) === 0xffd8) return tiffFromJpeg(bytes, dv);
  if (PNG_SIG.every((b, i) => bytes[i] === b)) return tiffFromPng(bytes, dv);
  if (String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" &&
      String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP") {
    return tiffFromWebp(bytes, dv);
  }
  return null;
}

// The one entry point: photo file bytes in, { lat, lng, heading, date } out.
// Never throws — malformed or absent EXIF yields all-null.
export function parseExif(arrayBuffer) {
  const empty = { lat: null, lng: null, heading: null, date: null };
  try {
    const tiff = findExifPayload(new Uint8Array(arrayBuffer));
    return tiff ? parseTiff(tiff) : empty;
  } catch (e) {
    return empty;
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(exif): container scan (JPEG/PNG/WebP) + parseExif entry point" -- js/exif.js tests/exif.test.js tests/helpers/tiff.js
```

---

### Task 3: Pure glue helpers — `js/photo.js`

**Files:**
- Create: `js/photo.js`
- Create: `tests/photo.test.js`

**Interfaces:**
- Consumes: `nearestCity(lat, lng, records)` and `findCity(query, records)` from `js/geo.js`; the `parsed` shape from Task 2 (`{ lat, lng, heading, date }`).
- Produces (used by Task 5's glue in `js/nodes.js`):
  - `parseImageValue(value: string) -> { filename, subfolder, type }`
  - `cityStringFor(lat, lng, records) -> string` ("" when unresolvable)
  - `photoStatus(parsed, cityLabel: string) -> string`

- [ ] **Step 1: Write the failing tests**

`tests/photo.test.js` (complete file):

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseImageValue, cityStringFor, photoStatus } from "../js/photo.js";
import { findCity } from "../js/geo.js";

test("parseImageValue handles plain, subfolder, and annotated values", () => {
  assert.deepEqual(parseImageValue("photo.jpg"),
    { filename: "photo.jpg", subfolder: "", type: "input" });
  assert.deepEqual(parseImageValue("trip/day1/photo.jpg"),
    { filename: "photo.jpg", subfolder: "trip/day1", type: "input" });
  assert.deepEqual(parseImageValue("photo.jpg [output]"),
    { filename: "photo.jpg", subfolder: "", type: "output" });
  assert.deepEqual(parseImageValue("sub/photo.jpg [temp]"),
    { filename: "photo.jpg", subfolder: "sub", type: "temp" });
  assert.deepEqual(parseImageValue(""),
    { filename: "", subfolder: "", type: "input" });
});

const RECORDS = [
  { city: "Paris", region: "Île-de-France", regionCode: "11", country: "FR",
    countryName: "France", lat: 48.8534, lng: 2.3488, tz: "Europe/Paris", population: 2138551 },
  { city: "Versailles", region: "Île-de-France", regionCode: "11", country: "FR",
    countryName: "France", lat: 48.8047, lng: 2.1204, tz: "Europe/Paris", population: 85416 },
];

test("cityStringFor picks the nearest record and round-trips through findCity", () => {
  const s = cityStringFor(48.858, 2.294, RECORDS);
  assert.equal(s, "Paris, Île-de-France");
  assert.equal(findCity(s, RECORDS).city, "Paris");
});

test("cityStringFor returns empty string with no records", () => {
  assert.equal(cityStringFor(48.858, 2.294, []), "");
});

test("photoStatus reports everything found", () => {
  const s = photoStatus(
    { lat: 48.858222, lng: 2.2945, heading: 214.5,
      date: { year: 2023, month: 6, day: 21, hour: 14, minute: 30 } },
    "Paris, Île-de-France");
  assert.equal(s,
    "📷 48.86, 2.29 near Paris, Île-de-France · heading 214.50° · 2023-06-21 14:30");
});

test("photoStatus flags each gap explicitly", () => {
  const s = photoStatus({ lat: null, lng: null, heading: null, date: null }, "");
  assert.equal(s, "📷 ⚠ no GPS data · no heading tag · no date/time tag");
});

test("photoStatus with GPS but no city label still shows coordinates", () => {
  const s = photoStatus({ lat: 1.5, lng: -3.25, heading: 90, date: null }, "");
  assert.equal(s, "📷 1.50, -3.25 · heading 90.00° · no date/time tag");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../js/photo.js'`.

- [ ] **Step 3: Implement `js/photo.js`**

Complete file:

```js
// Pure helpers behind the Photo (EXIF) node's browser glue: mapping the image
// widget's value to a /view request, choosing the city string, and composing
// the status line. DOM-free — unit tests in tests/photo.test.js.

import { nearestCity } from "./geo.js";

// LoadImage-style widget values: "name.jpg", "sub/dir/name.jpg", optionally
// annotated "name.jpg [input|output|temp]".
export function parseImageValue(value) {
  let name = String(value || "");
  let type = "input";
  const m = name.match(/^(.*) \[(input|output|temp)\]$/);
  if (m) {
    name = m[1];
    type = m[2];
  }
  let subfolder = "";
  const slash = name.lastIndexOf("/");
  if (slash > -1) {
    subfolder = name.slice(0, slash);
    name = name.slice(slash + 1);
  }
  return { filename: name, subfolder, type };
}

// A "City, Region" string that findCity() resolves back to the same record
// (the Sun (City) node parses its city input as "city, qualifier").
export function cityStringFor(lat, lng, records) {
  const r = nearestCity(lat, lng, records || []);
  if (!r) return "";
  const qual = r.region || r.regionCode || r.countryName || r.country || "";
  return qual ? `${r.city}, ${qual}` : r.city;
}

// One status line describing what the photo yielded; explicit about gaps so a
// missing compass heading is visible, not silent.
export function photoStatus(parsed, cityLabel) {
  const parts = [];
  if (parsed.lat != null && parsed.lng != null) {
    const at = `${parsed.lat.toFixed(2)}, ${parsed.lng.toFixed(2)}`;
    parts.push(cityLabel ? `${at} near ${cityLabel}` : at);
  } else {
    parts.push("⚠ no GPS data");
  }
  parts.push(parsed.heading != null
    ? `heading ${parsed.heading.toFixed(2)}°`
    : "no heading tag");
  if (parsed.date != null) {
    const d = parsed.date;
    const p2 = (n) => String(n).padStart(2, "0");
    parts.push(`${d.year}-${p2(d.month)}-${p2(d.day)} ${p2(d.hour)}:${p2(d.minute)}`);
  } else {
    parts.push("no date/time tag");
  }
  return `📷 ${parts.join(" · ")}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(photo): pure glue helpers — /view value parsing, city string, status line" -- js/photo.js tests/photo.test.js
```

---

### Task 4: Python node — `SphereLightPhotoExifNode`

**Files:**
- Modify: `__init__.py` (imports at top; new class before `NODE_CLASS_MAPPINGS`; both mappings)
- Modify: `tools/test_comfy_load.py` (stub `folder_paths`, extend the expected node set)
- Create: `tools/test_photo_exif.py`

**Interfaces:**
- Consumes: `decode_render_b64` module context (existing imports: `torch`, `numpy as np`, `PIL.Image`).
- Produces: node class `SphereLightPhotoExifNode` registered as `"SphereLightPhotoExifNode"` / display `"📷 Sphere Light — Photo (EXIF)"`; `execute(image, latitude, longitude, city, heading, year, month, day, hour, minute)` returning `(IMAGE tensor, latitude, longitude, city, heading, year, month, day, hour, minute)`. Task 5's JS keys off `comfyClass === "SphereLightPhotoExifNode"`.

- [ ] **Step 1: Stub `folder_paths` in the load test and extend the expected set (failing test first)**

In `tools/test_comfy_load.py`, after the `sys.modules["torch"] = faketorch` line, add:

```python
# __init__.py imports folder_paths (a ComfyUI module) for the photo node;
# stub the four functions it uses so the load works outside ComfyUI.
fakefp = types.ModuleType("folder_paths")
fakefp.get_input_directory = lambda: os.path.dirname(__file__)
fakefp.filter_files_content_types = lambda files, kinds: files
fakefp.get_annotated_filepath = lambda name: name
fakefp.exists_annotated_filepath = lambda name: os.path.exists(name)
sys.modules["folder_paths"] = fakefp
```

And change the expected set:

```python
want = {"SphereLightManualNode",
        "SphereLightSunCityNode", "SphereLightSunCoordsNode",
        "SphereLightPhotoExifNode"}
```

- [ ] **Step 2: Write the failing execute test**

`tools/test_photo_exif.py` (complete file):

```python
import sys, types, importlib.util, os, tempfile
import numpy as np

# Same fake-torch shim as test_comfy_load.py: enough for from_numpy().unsqueeze().
faketorch = types.ModuleType("torch")
class FT:
    def __init__(self, a): self.a = a
    def unsqueeze(self, d): return FT(np.expand_dims(self.a, d))
    @property
    def shape(self): return self.a.shape
faketorch.from_numpy = lambda a: FT(a)
sys.modules["torch"] = faketorch

# Stub folder_paths around a temp input directory holding one real image.
from PIL import Image
tmp = tempfile.mkdtemp()
Image.new("RGB", (32, 16), (10, 20, 30)).save(os.path.join(tmp, "photo.png"))

fakefp = types.ModuleType("folder_paths")
fakefp.get_input_directory = lambda: tmp
fakefp.filter_files_content_types = lambda files, kinds: files
fakefp.get_annotated_filepath = lambda name: os.path.join(tmp, name)
fakefp.exists_annotated_filepath = lambda name: os.path.exists(os.path.join(tmp, name))
sys.modules["folder_paths"] = fakefp

INIT = os.path.join(os.path.dirname(__file__), "..", "__init__.py")
spec = importlib.util.spec_from_file_location("sphere_light_photo_test", INIT)
mod = importlib.util.module_from_spec(spec)
sys.modules["sphere_light_photo_test"] = mod
spec.loader.exec_module(mod)

cls = mod.NODE_CLASS_MAPPINGS["SphereLightPhotoExifNode"]

# The upload combo lists the input directory.
files = cls.INPUT_TYPES()["required"]["image"][0]
assert "photo.png" in files, files

# execute(): loads the file as a (1,H,W,3) float tensor and passes the nine
# EXIF-derived widget values straight through.
out = cls().execute("photo.png", 48.8582, 2.2945, "Paris, Île-de-France",
                    214.5, 2023, 6, 21, 14, 30)
assert out[0].shape == (1, 16, 32, 3), out[0].shape
assert out[1:] == (48.8582, 2.2945, "Paris, Île-de-France", 214.5, 2023, 6, 21, 14, 30)

# The widget names the browser fills must exactly match the Sun nodes' input
# names — that name equality is what makes graph-driving work.
req = cls.INPUT_TYPES()["required"]
for name in ("latitude", "longitude", "city", "heading",
             "year", "month", "day", "hour", "minute"):
    assert name in req, f"missing widget: {name}"

assert cls.VALIDATE_INPUTS("photo.png") is True
assert cls.VALIDATE_INPUTS("missing.png") != True
assert isinstance(cls.IS_CHANGED("photo.png"), str)

print("test_photo_exif: OK")
```

- [ ] **Step 3: Run both to verify they fail**

Run (repo root):
```
python tools/test_comfy_load.py
python tools/test_photo_exif.py
```
Expected: both FAIL — `SphereLightPhotoExifNode` missing from `NODE_CLASS_MAPPINGS` / KeyError.

- [ ] **Step 4: Implement the node in `__init__.py`**

Change the import block at the top:

```python
import torch
import numpy as np
from PIL import Image, ImageOps
import io, base64, os, hashlib
import folder_paths
```

Insert the class after `SphereLightSunCoordsNode` (before `NODE_CLASS_MAPPINGS`):

```python
class SphereLightPhotoExifNode:
    DESCRIPTION = ("Loads a photo and reads its EXIF in the browser: GPS "
                   "position, nearest city, compass heading (GPSImgDirection), "
                   "and capture date/time come out as outputs to wire into the "
                   "Sun nodes; the photo itself comes out as IMAGE.")

    @classmethod
    def INPUT_TYPES(cls):
        input_dir = folder_paths.get_input_directory()
        files = [f for f in os.listdir(input_dir)
                 if os.path.isfile(os.path.join(input_dir, f))]
        files = folder_paths.filter_files_content_types(files, ["image"])
        return {
            "required": {
                "image": (sorted(files), {"image_upload": True,
                          "tooltip": "The photo whose EXIF supplies the values below."}),
                # The browser (js/nodes.js) parses the photo's EXIF and writes
                # the results into these widgets before the run. Their names
                # must exactly match the Sun nodes' input names — the client
                # resolves a connection by identical widget name (see
                # connectedInputValue in js/nodes.js). Hand-editable so a photo
                # missing a tag can be corrected on the node.
                "latitude":  ("FLOAT", {"default": 0.0, "min": -90.0, "max": 90.0, "step": 0.0001,
                                        "tooltip": "From EXIF GPS; degrees north (negative = south)."}),
                "longitude": ("FLOAT", {"default": 0.0, "min": -180.0, "max": 180.0, "step": 0.0001,
                                        "tooltip": "From EXIF GPS; degrees east (negative = west)."}),
                "city":      ("STRING", {"default": "", "multiline": False,
                                         "tooltip": "Nearest listed city to the photo's GPS position."}),
                "heading":   ("FLOAT", {"default": 0.0, "min": 0, "max": 360, "step": 0.01,
                                        "tooltip": "From EXIF GPSImgDirection; degrees clockwise from North."}),
                "year":      ("INT", {"default": 2025, "min": 1, "max": 9999}),
                "month":     ("INT", {"default": 6,  "min": 1,  "max": 12}),
                "day":       ("INT", {"default": 21, "min": 1,  "max": 31}),
                "hour":      ("INT", {"default": 12, "min": 0,  "max": 23}),
                "minute":    ("INT", {"default": 0,  "min": 0,  "max": 59}),
            }
        }

    RETURN_TYPES = ("IMAGE", "FLOAT", "FLOAT", "STRING", "FLOAT",
                    "INT", "INT", "INT", "INT", "INT")
    RETURN_NAMES = ("image", "latitude", "longitude", "city", "heading",
                    "year", "month", "day", "hour", "minute")
    FUNCTION = "execute"
    CATEGORY = "render/3d"
    OUTPUT_NODE = False

    def execute(self, image, latitude, longitude, city, heading,
                year, month, day, hour, minute):
        # The nine values are pass-throughs: the browser parsed the EXIF and
        # baked them into the widgets at edit time (same pattern as render_b64
        # on the sphere nodes), so they are already in the serialized prompt.
        path = folder_paths.get_annotated_filepath(image)
        img = ImageOps.exif_transpose(Image.open(path)).convert("RGB")
        arr = np.array(img).astype(np.float32) / 255.0
        tensor = torch.from_numpy(arr).unsqueeze(0)
        return (tensor, latitude, longitude, city, heading,
                year, month, day, hour, minute)

    @classmethod
    def IS_CHANGED(cls, image, **kwargs):
        path = folder_paths.get_annotated_filepath(image)
        m = hashlib.sha256()
        with open(path, "rb") as f:
            m.update(f.read())
        return m.digest().hex()

    @classmethod
    def VALIDATE_INPUTS(cls, image, **kwargs):
        if not folder_paths.exists_annotated_filepath(image):
            return f"Invalid image file: {image}"
        return True
```

Extend both mappings:

```python
NODE_CLASS_MAPPINGS = {
    "SphereLightManualNode": SphereLightManualNode,
    "SphereLightSunCityNode": SphereLightSunCityNode,
    "SphereLightSunCoordsNode": SphereLightSunCoordsNode,
    "SphereLightPhotoExifNode": SphereLightPhotoExifNode,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "SphereLightManualNode": "🔆 Sphere Light — Manual",
    "SphereLightSunCityNode": "🔆 Sphere Light — Sun (City)",
    "SphereLightSunCoordsNode": "🔆 Sphere Light — Sun (Coordinates)",
    "SphereLightPhotoExifNode": "📷 Sphere Light — Photo (EXIF)",
}
```

- [ ] **Step 5: Run the Python tests to verify they pass**

Run (repo root):
```
python tools/test_comfy_load.py
python tools/test_photo_exif.py
python tools/test_decode.py
python tools/test_new_nodes.py
```
Expected: all print their OK lines. (`test_decode`/`test_new_nodes` guard against regressions from the import-block change — if either now needs the `folder_paths` stub too, add the same 6-line stub there.)

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(nodes): SphereLightPhotoExifNode — photo loader + EXIF value pass-through" -- __init__.py tools/test_comfy_load.py tools/test_photo_exif.py
```

---

### Task 5: Browser glue in `js/nodes.js` + README

**Files:**
- Modify: `js/nodes.js` (new imports, `setupPhotoExif`, one branch in `nodeCreated`)
- Modify: `README.md` (node list + a short subsection)

**Interfaces:**
- Consumes: `parseExif` (Task 2); `parseImageValue`, `cityStringFor`, `photoStatus` (Task 3); existing `loadCities`, `getStr`, `addStatus`, `app`; `api` from ComfyUI's `../../scripts/api.js`; node class name from Task 4.
- Produces: the running feature. No JS unit tests here (graph/DOM code — covered by the Task 6 gate).

- [ ] **Step 1: Add imports to `js/nodes.js`**

Below `import { app } from "../../scripts/app.js";` add:

```js
import { api } from "../../scripts/api.js";
```

Extend the geo import to include nothing new (already imports `loadCities, nearestCity`), and add:

```js
import { parseExif } from "./exif.js";
import { parseImageValue, cityStringFor, photoStatus } from "./photo.js";
```

- [ ] **Step 2: Add `setupPhotoExif` (after `setupSun`, before `app.registerExtension`)**

```js
async function setupPhotoExif(node) {
  let setStatus = () => {};

  // Fetch the picked photo, parse its EXIF, and bake the values into this
  // node's widgets. The widget names deliberately match the Sun nodes' input
  // names: connectedInputValue() on a sphere node resolves a connection by
  // looking up the identically named widget here. Tags absent from the file
  // leave their widgets untouched (hand-editable fallbacks).
  const fill = async () => {
    const value = getStr(node, "image", "");
    if (!value) return;
    let parsed;
    try {
      const { filename, subfolder, type } = parseImageValue(value);
      const res = await fetch(api.apiURL(
        `/view?filename=${encodeURIComponent(filename)}` +
        `&subfolder=${encodeURIComponent(subfolder)}&type=${type}`));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      parsed = parseExif(await res.arrayBuffer());
    } catch (e) {
      console.warn("[SphereLight] EXIF read failed:", e);
      setStatus("⚠ couldn't read the image file");
      return;
    }
    // Set through the widget callback so hookSourceWidgets' wrapper fires and
    // any connected sphere node re-renders live.
    const set = (name, v) => {
      const w = node.widgets?.find((x) => x.name === name);
      if (!w) return;
      w.value = v;
      try { w.callback?.(v, app.canvas, node); } catch (e) {}
    };
    let cityLabel = "";
    if (parsed.lat != null && parsed.lng != null) {
      set("latitude", Math.round(parsed.lat * 10000) / 10000);
      set("longitude", Math.round(parsed.lng * 10000) / 10000);
      try {
        cityLabel = cityStringFor(parsed.lat, parsed.lng, await loadCities());
        if (cityLabel) set("city", cityLabel);
      } catch (e) {
        console.warn("[SphereLight] cities.json failed:", e);
      }
    }
    if (parsed.heading != null) set("heading", Math.round(parsed.heading * 100) / 100);
    if (parsed.date != null) {
      set("year", parsed.date.year);
      set("month", parsed.date.month);
      set("day", parsed.date.day);
      set("hour", parsed.date.hour);
      set("minute", parsed.date.minute);
    }
    setStatus(photoStatus(parsed, cityLabel));
    node.setDirtyCanvas?.(true, true);
  };

  setTimeout(() => {
    setStatus = addStatus(node);
    // Parse when the photo changes (upload or picking another file) — NOT at
    // setup: widget values persist in the workflow, so a reload re-parse
    // would only clobber hand-corrected values.
    const w = node.widgets?.find((x) => x.name === "image");
    if (w) {
      const orig = w.callback;
      w.callback = function (...args) {
        const r = orig ? orig.apply(this, args) : undefined;
        fill();
        return r;
      };
    }
  }, 100);
}
```

- [ ] **Step 3: Register the branch in `nodeCreated`**

In `app.registerExtension`'s `nodeCreated`, add before `else return;`:

```js
    else if (node.comfyClass === "SphereLightPhotoExifNode") setup = setupPhotoExif(node);
```

(The shared `onConnectionsChange` wrapper that follows is harmless for this node — it has no inputs and no `_slRender`.)

- [ ] **Step 4: Run the JS tests (regression only)**

Run: `npm test`
Expected: PASS — nothing in `tests/` imports `nodes.js`, this is a no-regression check.

- [ ] **Step 5: Update `README.md`**

In the node list under `## Nodes`, change the intro line "Three nodes are registered under **render/3d**" to "Four nodes are registered under **render/3d**" and append the bullet:

```markdown
- **📷 Sphere Light — Photo (EXIF)** — upload a photo; its EXIF supplies
  `latitude`/`longitude`, the nearest `city`, `heading` (`GPSImgDirection`),
  and the capture date/time as outputs — wire them into the Sun nodes to light
  the sphere the way the sun actually was when and where the photo was taken.
  The photo itself comes out as `IMAGE` (it can replace a Load Image node).
```

After the "Driving inputs from the graph" section, add:

```markdown
### From a photo's EXIF

The Photo (EXIF) node reads the metadata in the browser when you pick the
image and writes the values onto its widgets (a status line shows what was
found). Tags the photo doesn't carry — phones only record `GPSImgDirection`
when the compass was active — leave their widgets untouched, so you can type a
correction by hand. Like all driven inputs, an open browser tab is what bakes
fresh values in; headless runs reuse the last-saved ones. JPEG, PNG (`eXIf`),
and WebP files carry EXIF; HEIC is not supported (ComfyUI can't decode it
either).
```

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(photo-exif): browser glue — parse on pick, fill widgets, status line; README" -- js/nodes.js README.md
```

---

### Task 6: End-to-end verification gate (Playwright on the local ComfyUI)

**Files:**
- Create (scratchpad only, not committed): `<scratchpad>/make_fixture.mjs`, `<scratchpad>/paris.jpg`, `<scratchpad>/nogps.jpg`

**Interfaces:**
- Consumes: everything; `buildTiff`/`app1Segment` from `tests/helpers/tiff.js`; the running ComfyUI at `http://127.0.0.1:8188` (portable install `C:\ML\ComfyUI-App-270`; the repo is junctioned into `custom_nodes`).

- [ ] **Step 1: Build a real GPS-tagged JPEG fixture**

Create a base JPEG with the install's Python, then splice in an EXIF APP1 with the shared helper:

```powershell
& "C:\ML\ComfyUI-App-270\python_embeded\python.exe" -c "from PIL import Image; Image.new('RGB',(64,64),(200,150,90)).save(r'<scratchpad>\base.jpg'); Image.new('RGB',(64,64),(90,150,200)).save(r'<scratchpad>\nogps.jpg')"
```

`<scratchpad>/make_fixture.mjs` (run with `node make_fixture.mjs` from the scratchpad; adjust the import path to the repo):

```js
import { readFileSync, writeFileSync } from "node:fs";
import { buildTiff, app1Segment } from "C:/Users/chris/Documents/GitHub/Sphere-Light-Render-ComfyUI/tests/helpers/tiff.js";

const tiff = buildTiff({
  lat: [48, 51, 29.6], latRef: "N",
  lng: [2, 17, 40.2], lngRef: "E",
  heading: 214.5, dateTime: "2023:06:21 14:30:00",
});
const base = readFileSync("base.jpg");
// Insert the APP1 segment right after the SOI marker (first two bytes).
writeFileSync("paris.jpg",
  Buffer.concat([base.subarray(0, 2), Buffer.from(app1Segment(tiff)), base.subarray(2)]));
console.log("paris.jpg written");
```

Sanity-check the fixture parses before touching the browser:

```powershell
node -e "import('C:/Users/chris/Documents/GitHub/Sphere-Light-Render-ComfyUI/js/exif.js').then(m => console.log(m.parseExif(require('node:fs').readFileSync('paris.jpg').buffer)))"
```

Expected: `{ lat: ~48.8582, lng: ~2.2945, heading: 214.5, date: { year: 2023, ... } }`.

- [ ] **Step 2: Restart the ComfyUI server** (Python change; per the documented procedure)

Check the queue is idle (`GET http://127.0.0.1:8188/prompt` → `queue_remaining: 0`), stop the `python.exe` running `ComfyUI\main.py` (and its parent `cmd.exe`), then `Start-Process "C:\ML\ComfyUI-App-270\run_nvidia_gpu.bat" -WorkingDirectory "C:\ML\ComfyUI-App-270"`. Poll until `http://127.0.0.1:8188` responds (~10–20 s).

- [ ] **Step 3: Drive the browser (Playwright MCP)**

1. Navigate to `http://127.0.0.1:8188`; add a **📷 Sphere Light — Photo (EXIF)** node (double-click canvas → search "Photo (EXIF)").
2. Click the image widget's upload control; `browser_file_upload` with `paris.jpg`.
3. **Assert:** widgets read latitude ≈ `48.8582`, longitude ≈ `2.2945`, heading `214.5`, city `Paris, Île-de-France`, year `2023`, month `6`, day `21`, hour `14`, minute `30`; the status line shows `📷 48.86, 2.29 near Paris, Île-de-France · heading 214.50° · 2023-06-21 14:30`.
4. Add a **🔆 Sphere Light — Sun (Coordinates)** node; connect latitude→latitude, longitude→longitude, heading→heading, year→year, month→month, day→day, hour→hour, minute→minute. **Assert:** its status line resolves near Paris and the sphere preview re-renders (not gray).
5. Upload `nogps.jpg` on the photo node. **Assert:** status shows `📷 ⚠ no GPS data · no heading tag · no date/time tag` and the lat/lon/heading widgets still hold the Paris values (untouched).
6. Queue the workflow once. **Assert:** it completes without server errors and the Photo node outputs flow (no red node).
7. Check the browser console for `[SphereLight]` errors: none expected.

- [ ] **Step 4: Fix anything the gate catches, re-run the failing step, then finish**

Any fix goes through the relevant task's test first (add a failing case, then fix). When the gate passes clean, the feature is done — proceed to the finishing-a-development-branch skill.
