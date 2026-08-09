# Time-of-Day Sun Positioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `date/time` sun mode that positions the sphere's directional light from a real location, date/time, and camera heading, alongside the existing manual-angle mode.

**Architecture:** All astronomy runs client-side in small pure ES modules (`solar`, `tz`, `geo`, `sun`) so the Three.js preview updates live; `sphere_widget.js` is thin glue that applies the computed angles to the existing `doRender()`. City→lat/lng/timezone comes from an offline `cities.json` built at dev time from GeoNames. Python only declares the new widgets so they serialize; it does no scene work.

**Tech Stack:** Vanilla ES modules (browser + Node), Node 22 built-in test runner (`node --test`), `Intl.DateTimeFormat` for DST-correct timezone math, Python 3 (stdlib) for the dataset build, Three.js r128 (already vendored).

## Global Constraints

- **No new runtime dependencies.** Astronomy is hand-vendored JS; timezone math uses the browser-native `Intl` API. Node's test runner and Python stdlib are dev-only. (verbatim from spec: "no library")
- **Offline.** No network calls at render time or edit time. City data is bundled (`js/cities.json`); assets resolve via `new URL('./x', import.meta.url)`.
- **Astronomy lives in JavaScript, not Python.** Python stays passive — it still only decodes `render_b64`.
- **Azimuth convention is fixed once:** degrees, compass — `0 = North`, clockwise (`90 = East`). Convert exactly once, in `solar.js`.
- **Core coupling:** `scene_rotation = normalizeDeg180(solar_azimuth − heading)`.
- **Defaults (approved):** sun below horizon → clamp `elevation` to `0` and flag it; `intensity` stays manual.
- **Date/time mode uses true solar altitude (0–90°)**, not the manual slider's 5–85° cap.

---

### Task 1: Solar position module (`solar.js`)

**Files:**
- Create: `js/package.json`
- Create: `js/solar.js`
- Test: `js/solar.test.js`

**Interfaces:**
- Produces: `sunPosition(lat, lng, dateUTC) → { altitude, azimuth }` — degrees; `altitude` = degrees above horizon (negative below); `azimuth` = compass degrees from North clockwise. `dateUTC` is a JS `Date`.

- [ ] **Step 1: Create `js/package.json` so Node treats `js/*.js` as ES modules**

```json
{
  "type": "module",
  "private": true
}
```

- [ ] **Step 2: Write the failing test**

`js/solar.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { sunPosition } from "./solar.js";

test("near-overhead at solstice on the Tropic of Cancer", () => {
  // Jun 21 2023 12:00 UTC, lat 23.44 (~obliquity), lng 0 -> sun almost overhead
  const { altitude } = sunPosition(23.44, 0, new Date(Date.UTC(2023, 5, 21, 12, 0, 0)));
  assert.ok(altitude > 87, `expected altitude > 87, got ${altitude}`);
});

test("morning sun is up and to the east", () => {
  const { altitude, azimuth } = sunPosition(40, 0, new Date(Date.UTC(2023, 2, 21, 8, 0, 0)));
  assert.ok(altitude > 5 && altitude < 45, `altitude ${altitude}`);
  assert.ok(azimuth > 80 && azimuth < 150, `azimuth ${azimuth}`);
});

test("afternoon sun is up and to the west", () => {
  const { altitude, azimuth } = sunPosition(40, 0, new Date(Date.UTC(2023, 2, 21, 16, 0, 0)));
  assert.ok(altitude > 5 && altitude < 45, `altitude ${altitude}`);
  assert.ok(azimuth > 210 && azimuth < 280, `azimuth ${azimuth}`);
});

test("midnight sun is below the horizon", () => {
  const { altitude } = sunPosition(40, 0, new Date(Date.UTC(2023, 2, 21, 0, 0, 0)));
  assert.ok(altitude < 0, `altitude ${altitude}`);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test js/solar.test.js`
Expected: FAIL — `Cannot find module` / `sunPosition is not a function`.

- [ ] **Step 4: Write the implementation**

`js/solar.js`:

```js
// NOAA solar position algorithm (port of the NOAA solar calculator spreadsheet).
// Returns { altitude, azimuth } in degrees. Azimuth is compass-from-North,
// clockwise (0 = N, 90 = E, 180 = S, 270 = W). Altitude is degrees above the
// horizon (negative when the sun is below it). Pure — no DOM, no globals.

const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;
const mod = (n, m) => ((n % m) + m) % m;

function julianDay(date) {
  return date.getTime() / 86400000 + 2440587.5;
}

export function sunPosition(lat, lng, dateUTC) {
  const jc = (julianDay(dateUTC) - 2451545) / 36525; // Julian century

  const gmls = mod(280.46646 + jc * (36000.76983 + jc * 0.0003032), 360); // geom mean long (deg)
  const gmas = 357.52911 + jc * (35999.05029 - 0.0001537 * jc);           // geom mean anomaly (deg)
  const ecc = 0.016708634 - jc * (0.000042037 + 0.0000001267 * jc);       // eccentricity

  const ctr =
    Math.sin(rad(gmas)) * (1.914602 - jc * (0.004817 + 0.000014 * jc)) +
    Math.sin(rad(2 * gmas)) * (0.019993 - 0.000101 * jc) +
    Math.sin(rad(3 * gmas)) * 0.000289;

  const trueLong = gmls + ctr;
  const appLong = trueLong - 0.00569 - 0.00478 * Math.sin(rad(125.04 - 1934.136 * jc));

  const meanObliq =
    23 + (26 + (21.448 - jc * (46.815 + jc * (0.00059 - jc * 0.001813))) / 60) / 60;
  const obliq = meanObliq + 0.00256 * Math.cos(rad(125.04 - 1934.136 * jc));

  const declin = deg(Math.asin(Math.sin(rad(obliq)) * Math.sin(rad(appLong))));

  const y = Math.tan(rad(obliq / 2)) ** 2;
  const eqTime =
    4 *
    deg(
      y * Math.sin(2 * rad(gmls)) -
        2 * ecc * Math.sin(rad(gmas)) +
        4 * ecc * y * Math.sin(rad(gmas)) * Math.cos(2 * rad(gmls)) -
        0.5 * y * y * Math.sin(4 * rad(gmls)) -
        1.25 * ecc * ecc * Math.sin(2 * rad(gmas))
    ); // minutes

  const utcMin =
    dateUTC.getUTCHours() * 60 + dateUTC.getUTCMinutes() + dateUTC.getUTCSeconds() / 60;
  const trueSolarTime = mod(utcMin + eqTime + 4 * lng, 1440); // minutes; east lng positive
  const hourAngle = trueSolarTime / 4 < 0 ? trueSolarTime / 4 + 180 : trueSolarTime / 4 - 180;

  const zenith = deg(
    Math.acos(
      Math.sin(rad(lat)) * Math.sin(rad(declin)) +
        Math.cos(rad(lat)) * Math.cos(rad(declin)) * Math.cos(rad(hourAngle))
    )
  );
  const altitude = 90 - zenith;

  let azimuth;
  const denom = Math.cos(rad(lat)) * Math.sin(rad(zenith));
  if (Math.abs(denom) > 0.001) {
    let c = (Math.sin(rad(lat)) * Math.cos(rad(zenith)) - Math.sin(rad(declin))) / denom;
    c = Math.max(-1, Math.min(1, c));
    azimuth = deg(Math.acos(c));
    azimuth = hourAngle > 0 ? mod(azimuth + 180, 360) : mod(540 - azimuth, 360);
  } else {
    azimuth = declin > lat ? 180 : 0;
  }

  return { altitude, azimuth };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test js/solar.test.js`
Expected: PASS — 4/4.

- [ ] **Step 6: Commit**

```bash
git add js/package.json js/solar.js js/solar.test.js
git commit -m "feat(solar): NOAA solar-position module with tests"
```

---

### Task 2: Timezone conversion module (`tz.js`)

**Files:**
- Create: `js/tz.js`
- Test: `js/tz.test.js`

**Interfaces:**
- Produces:
  - `zoneOffsetMs(instant, timeZone) → number` — offset in ms of `timeZone` at the given UTC `Date`.
  - `zonedWallTimeToUTC(year, month, day, hour, minute, timeZone) → Date` — interprets the wall-clock time as local to `timeZone` (DST-aware) and returns the UTC instant. `month` is 1–12.

- [ ] **Step 1: Write the failing test**

`js/tz.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { zonedWallTimeToUTC } from "./tz.js";

test("summer wall time uses DST offset (EDT = UTC-4)", () => {
  const d = zonedWallTimeToUTC(2023, 7, 4, 12, 0, "America/New_York");
  assert.equal(d.getUTCHours(), 16);
});

test("winter wall time uses standard offset (EST = UTC-5)", () => {
  const d = zonedWallTimeToUTC(2023, 1, 15, 12, 0, "America/New_York");
  assert.equal(d.getUTCHours(), 17);
});

test("half-hour zone (India = UTC+5:30)", () => {
  const d = zonedWallTimeToUTC(2023, 1, 15, 12, 0, "Asia/Kolkata");
  assert.equal(d.getUTCHours(), 6);
  assert.equal(d.getUTCMinutes(), 30);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test js/tz.test.js`
Expected: FAIL — `zonedWallTimeToUTC is not a function`.

- [ ] **Step 3: Write the implementation**

`js/tz.js`:

```js
// Timezone math using the browser/Node-native Intl API (full ICU). No library.

export function zoneOffsetMs(instant, timeZone) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p = Object.fromEntries(dtf.formatToParts(instant).map((x) => [x.type, x.value]));
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUTC - instant.getTime();
}

export function zonedWallTimeToUTC(year, month, day, hour, minute, timeZone) {
  // Treat the wall time as if it were UTC, then subtract the zone's offset at
  // that instant. One correction is exact outside the ~1h DST transition window.
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const offset = zoneOffsetMs(new Date(guess), timeZone);
  return new Date(guess - offset);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test js/tz.test.js`
Expected: PASS — 3/3.

- [ ] **Step 5: Commit**

```bash
git add js/tz.js js/tz.test.js
git commit -m "feat(tz): DST-aware wall-time-to-UTC via Intl"
```

---

### Task 3: City lookup module (`geo.js`)

**Files:**
- Create: `js/geo.js`
- Test: `js/geo.test.js`

**Interfaces:**
- Consumes: city records shaped `{ city, regionCode, region, country, countryName, lat, lng, tz, population }` (produced by Task 5).
- Produces:
  - `findCity(query, records) → record | null` — pure. Parses `"City"`, `"City, State"`, `"City, Country"`; matches city name (case-insensitive) and optional qualifier against `regionCode`/`region`/`country`/`countryName`; returns the highest-population match.
  - `loadCities() → Promise<record[]>` — runtime-only glue that fetches `./cities.json`; cached. (Not unit-tested; exercised in Task 7.)

- [ ] **Step 1: Write the failing test**

`js/geo.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { findCity } from "./geo.js";

const FIX = [
  { city: "Austin", regionCode: "TX", region: "Texas", country: "US", countryName: "United States", lat: 30.27, lng: -97.74, tz: "America/Chicago", population: 961855 },
  { city: "Austin", regionCode: "MN", region: "Minnesota", country: "US", countryName: "United States", lat: 43.67, lng: -92.97, tz: "America/Chicago", population: 24000 },
  { city: "Tokyo", regionCode: "13", region: "Tokyo", country: "JP", countryName: "Japan", lat: 35.68, lng: 139.65, tz: "Asia/Tokyo", population: 37000000 },
];

test("matches city + state code", () => {
  assert.equal(findCity("Austin, TX", FIX).region, "Texas");
});

test("bare city returns most populous", () => {
  assert.equal(findCity("Austin", FIX).regionCode, "TX");
});

test("matches city + country name", () => {
  assert.equal(findCity("Tokyo, Japan", FIX).tz, "Asia/Tokyo");
});

test("case-insensitive", () => {
  assert.equal(findCity("austin, texas", FIX).regionCode, "TX");
});

test("no match returns null", () => {
  assert.equal(findCity("Nowhere, ZZ", FIX), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test js/geo.test.js`
Expected: FAIL — `findCity is not a function`.

- [ ] **Step 3: Write the implementation**

`js/geo.js`:

```js
export function findCity(query, records) {
  if (!query) return null;
  const parts = query.split(",").map((s) => s.trim()).filter(Boolean);
  const cityQ = (parts[0] || "").toLowerCase();
  const qualQ = (parts[1] || "").toLowerCase();
  if (!cityQ) return null;

  let matches = records.filter((r) => r.city.toLowerCase() === cityQ);
  if (qualQ) {
    matches = matches.filter(
      (r) =>
        (r.regionCode && r.regionCode.toLowerCase() === qualQ) ||
        (r.region && r.region.toLowerCase() === qualQ) ||
        (r.country && r.country.toLowerCase() === qualQ) ||
        (r.countryName && r.countryName.toLowerCase() === qualQ)
    );
  }
  if (matches.length === 0) return null;
  matches.sort((a, b) => (b.population || 0) - (a.population || 0));
  return matches[0];
}

let _cache = null;
export async function loadCities() {
  if (_cache) return _cache;
  const url = new URL("./cities.json", import.meta.url).href;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`cities.json load failed: ${res.status}`);
  _cache = await res.json();
  return _cache;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test js/geo.test.js`
Expected: PASS — 5/5.

- [ ] **Step 5: Commit**

```bash
git add js/geo.js js/geo.test.js
git commit -m "feat(geo): offline city lookup with population disambiguation"
```

---

### Task 4: Compose into sun angles (`sun.js`)

**Files:**
- Create: `js/sun.js`
- Test: `js/sun.test.js`

**Interfaces:**
- Consumes: `sunPosition` (Task 1), `zonedWallTimeToUTC` (Task 2), `findCity` (Task 3).
- Produces:
  - `normalizeDeg180(a) → number` — wraps degrees into `[-180, 180)`.
  - `computeSunAngles(params, records) → { rotation, elevation, belowHorizon, altitude, azimuth, matched } | { error }`
    where `params = { location, year, month, day, hour, minute, heading, lat?, lng?, tz? }`.
    `rotation`/`elevation` are degrees ready for the scene; `belowHorizon` true when the sun is at/under the horizon (then `elevation` is clamped to `0`); `matched` is the city record or `null` (manual lat/lng fallback); `error: "city_not_found"` when neither a city nor manual lat/lng is available.

- [ ] **Step 1: Write the failing test**

`js/sun.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeSunAngles, normalizeDeg180 } from "./sun.js";

const FIX = [
  { city: "Austin", regionCode: "TX", region: "Texas", country: "US", countryName: "United States", lat: 30.27, lng: -97.74, tz: "America/Chicago", population: 961855 },
];

test("normalizeDeg180 wraps", () => {
  assert.equal(normalizeDeg180(190), -170);
  assert.equal(normalizeDeg180(-190), 170);
  assert.equal(normalizeDeg180(45), 45);
});

test("Austin summer morning: sun up and to the east", () => {
  const r = computeSunAngles(
    { location: "Austin, TX", year: 2023, month: 6, day: 21, hour: 8, minute: 0, heading: 0 },
    FIX
  );
  assert.equal(r.belowHorizon, false);
  assert.ok(r.elevation > 10 && r.elevation < 55, `elevation ${r.elevation}`);
  assert.ok(r.rotation > 40 && r.rotation < 130, `rotation ${r.rotation}`);
  assert.equal(r.matched.regionCode, "TX");
});

test("heading rotates the sun in the scene frame", () => {
  const base = computeSunAngles({ location: "Austin, TX", year: 2023, month: 6, day: 21, hour: 8, minute: 0, heading: 0 }, FIX);
  const turned = computeSunAngles({ location: "Austin, TX", year: 2023, month: 6, day: 21, hour: 8, minute: 0, heading: 90 }, FIX);
  assert.ok(Math.abs(normalizeDeg180(base.rotation - turned.rotation - 90)) < 0.001);
});

test("pre-dawn: below horizon, elevation clamped to 0", () => {
  const r = computeSunAngles({ location: "Austin, TX", year: 2023, month: 6, day: 21, hour: 2, minute: 0, heading: 0 }, FIX);
  assert.equal(r.belowHorizon, true);
  assert.equal(r.elevation, 0);
});

test("unknown city with no manual lat/lng returns error", () => {
  const r = computeSunAngles({ location: "Nowhere, ZZ", year: 2023, month: 6, day: 21, hour: 8, minute: 0 }, FIX);
  assert.equal(r.error, "city_not_found");
});

test("manual lat/lng fallback when city not found", () => {
  const r = computeSunAngles(
    { location: "", lat: 30.27, lng: -97.74, tz: "America/Chicago", year: 2023, month: 6, day: 21, hour: 8, minute: 0, heading: 0 },
    FIX
  );
  assert.equal(r.error, undefined);
  assert.ok(r.elevation > 10);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test js/sun.test.js`
Expected: FAIL — `computeSunAngles is not a function`.

- [ ] **Step 3: Write the implementation**

`js/sun.js`:

```js
import { sunPosition } from "./solar.js";
import { zonedWallTimeToUTC } from "./tz.js";
import { findCity } from "./geo.js";

export function normalizeDeg180(a) {
  return (((a + 180) % 360) + 360) % 360 - 180;
}

export function computeSunAngles(params, records) {
  const { location, year, month, day, hour, minute, heading = 0 } = params;

  let lat, lng, tz, matched;
  const city = findCity(location, records);
  if (city) {
    ({ lat, lng, tz } = city);
    matched = city;
  } else if (Number.isFinite(params.lat) && Number.isFinite(params.lng)) {
    lat = params.lat;
    lng = params.lng;
    tz = params.tz || "UTC";
    matched = null;
  } else {
    return { error: "city_not_found" };
  }

  const utc = zonedWallTimeToUTC(year, month, day, hour, minute, tz);
  const { altitude, azimuth } = sunPosition(lat, lng, utc);
  const belowHorizon = altitude <= 0;

  return {
    rotation: normalizeDeg180(azimuth - heading),
    elevation: belowHorizon ? 0 : altitude,
    belowHorizon,
    altitude,
    azimuth,
    matched,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test js/sun.test.js`
Expected: PASS — 6/6.

- [ ] **Step 5: Run the whole JS suite**

Run: `node --test js/`
Expected: PASS — all files (solar, tz, geo, sun).

- [ ] **Step 6: Commit**

```bash
git add js/sun.js js/sun.test.js
git commit -m "feat(sun): compose geo+tz+solar into scene angles"
```

---

### Task 5: Build the offline city dataset (`tools/build_cities.py` → `js/cities.json`)

**Files:**
- Create: `tools/build_cities.py`
- Generate: `js/cities.json` (committed artifact)
- Test: `tools/verify_cities.py`

**Interfaces:**
- Produces: `js/cities.json` — a JSON array of `{ city, regionCode, region, country, countryName, lat, lng, tz, population }`, consumed by `geo.js` (Task 3) and `loadCities()` (Task 7).

- [ ] **Step 1: Write the build script**

`tools/build_cities.py`:

```python
"""Build js/cities.json from GeoNames (cities >= 15k population, worldwide).

Downloads are one-time and cached in tools/_cache/. Output is committed so end
users never fetch anything. Run: python tools/build_cities.py
"""
import io, json, os, urllib.request, zipfile, csv

BASE = "https://download.geonames.org/export/dump/"
CACHE = os.path.join(os.path.dirname(__file__), "_cache")
OUT = os.path.join(os.path.dirname(__file__), "..", "js", "cities.json")

def fetch(name):
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, name)
    if not os.path.exists(path):
        print("downloading", name)
        urllib.request.urlretrieve(BASE + name, path)
    return path

def load_admin1():
    # admin1CodesASCII.txt: "US.TX\tTexas\tTexas\t<id>"
    m = {}
    with open(fetch("admin1CodesASCII.txt"), encoding="utf-8") as f:
        for row in csv.reader(f, delimiter="\t"):
            if len(row) >= 2:
                m[row[0]] = row[1]  # "US.TX" -> "Texas"
    return m

def load_countries():
    # countryInfo.txt: comment lines start with '#'; ISO code col 0, name col 4
    m = {}
    with open(fetch("countryInfo.txt"), encoding="utf-8") as f:
        for line in f:
            if line.startswith("#"):
                continue
            c = line.split("\t")
            if len(c) > 4 and c[0]:
                m[c[0]] = c[4]
    return m

def main():
    admin1 = load_admin1()
    countries = load_countries()
    zpath = fetch("cities15000.zip")
    with zipfile.ZipFile(zpath) as z:
        raw = z.read("cities15000.txt").decode("utf-8")

    out = []
    for row in csv.reader(io.StringIO(raw), delimiter="\t"):
        # cols: 1 name, 4 lat, 5 lng, 8 country, 10 admin1, 14 pop, 17 tz
        name, lat, lng = row[1], row[4], row[5]
        country, admin1code, pop, tz = row[8], row[10], row[14], row[17]
        out.append({
            "city": name,
            "regionCode": admin1code,
            "region": admin1.get(f"{country}.{admin1code}", ""),
            "country": country,
            "countryName": countries.get(country, ""),
            "lat": round(float(lat), 4),
            "lng": round(float(lng), 4),
            "tz": tz,
            "population": int(pop) if pop else 0,
        })

    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print(f"wrote {len(out)} cities to {os.path.normpath(OUT)}")

if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Run the build**

Run: `python tools/build_cities.py`
Expected: `wrote <~25000> cities to js/cities.json` (one-time GeoNames download of a few MB into `tools/_cache/`).

- [ ] **Step 3: Write the verification script**

`tools/verify_cities.py`:

```python
import json, os
p = os.path.join(os.path.dirname(__file__), "..", "js", "cities.json")
data = json.load(open(p, encoding="utf-8"))
assert len(data) > 10000, f"too few cities: {len(data)}"

def find(city, code):
    return [r for r in data if r["city"] == city and r["regionCode"] == code]

austin = find("Austin", "TX")
assert austin, "Austin, TX missing"
a = max(austin, key=lambda r: r["population"])
assert 29 < a["lat"] < 31 and -99 < a["lng"] < -96, a
assert a["tz"] == "America/Chicago", a

tokyo = [r for r in data if r["city"] == "Tokyo" and r["country"] == "JP"]
assert tokyo and tokyo[0]["tz"] == "Asia/Tokyo", "Tokyo missing/wrong tz"
print("verify_cities: OK", len(data), "cities")
```

- [ ] **Step 4: Run verification**

Run: `python tools/verify_cities.py`
Expected: `verify_cities: OK <count> cities`

- [ ] **Step 5: Ignore the download cache**

Append to `.gitignore`:

```
tools/_cache/
```

- [ ] **Step 6: Commit**

```bash
git add tools/build_cities.py tools/verify_cities.py js/cities.json .gitignore
git commit -m "feat(data): offline GeoNames city dataset + build/verify scripts"
```

---

### Task 6: Declare the new widgets in Python (`__init__.py`)

**Files:**
- Modify: `C:\Users\chris\Documents\GitHub\Sphere-Light-Render-ComfyUI\__init__.py` (INPUT_TYPES + `execute` signature)
- Test: `tools/test_inputs.py`

**Interfaces:**
- Consumes: nothing new (Python stays passive).
- Produces: `INPUT_TYPES()["required"]` gains keys `sun_mode, location, year, month, day, hour, minute, heading`; `execute` accepts them and ignores them (rendering still comes from `render_b64`).

- [ ] **Step 1: Write the failing test**

`tools/test_inputs.py`:

```python
import sys, types, importlib.util, os, numpy as np

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

req = mod.SphereLightNode.INPUT_TYPES()["required"]
for k in ["sun_mode", "location", "year", "month", "day", "hour", "minute", "heading"]:
    assert k in req, f"missing input: {k}"
assert req["sun_mode"][0] == ["manual", "date/time"], req["sun_mode"]

# execute must still work and ignore the new params (empty render_b64 -> gray)
node = mod.SphereLightNode()
(t,) = node.execute(0.0, 45.0, 1.5, "manual", "Austin, TX", 2025, 6, 21, 12, 0, 0.0, "")
assert tuple(t.shape) == (1, 1024, 1024, 3), t.shape
print("test_inputs: OK")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python tools/test_inputs.py`
Expected: FAIL — `AssertionError: missing input: sun_mode` (or a `TypeError` on the new `execute` args).

- [ ] **Step 3: Add the inputs to `INPUT_TYPES`**

In `__init__.py`, replace the `required` dict so it reads:

```python
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "rotation":  ("FLOAT", {"default": 0.0,  "min": -180, "max": 180, "step": 1,   "display": "slider"}),
                "elevation": ("FLOAT", {"default": 45.0, "min": 5,    "max": 85,  "step": 1,   "display": "slider"}),
                "intensity": ("FLOAT", {"default": 1.5,  "min": 0.2,  "max": 3.0, "step": 0.1, "display": "slider"}),
                "sun_mode":  (["manual", "date/time"], {"default": "manual"}),
                "location":  ("STRING", {"default": "Austin, TX", "multiline": False}),
                "year":      ("INT", {"default": 2025, "min": 1, "max": 9999}),
                "month":     ("INT", {"default": 6,  "min": 1,  "max": 12}),
                "day":       ("INT", {"default": 21, "min": 1,  "max": 31}),
                "hour":      ("INT", {"default": 12, "min": 0,  "max": 23}),
                "minute":    ("INT", {"default": 0,  "min": 0,  "max": 59}),
                "heading":   ("FLOAT", {"default": 0.0, "min": 0, "max": 360, "step": 1, "display": "slider"}),
                "render_b64": ("STRING", {"default": "", "multiline": False}),
            }
        }
```

- [ ] **Step 4: Update the `execute` signature to accept (and ignore) the new params**

Change the signature line only; the body is unchanged:

```python
    def execute(self, rotation, elevation, intensity, sun_mode, location,
                year, month, day, hour, minute, heading, render_b64):
        # Positioning params (sun_mode..heading) are consumed client-side in
        # js/sphere_widget.js; the server only needs render_b64. They appear
        # here because ComfyUI passes every declared input.
        img = None
```

- [ ] **Step 5: Run test to verify it passes**

Run: `python tools/test_inputs.py`
Expected: `test_inputs: OK`

- [ ] **Step 6: Commit**

```bash
git add __init__.py tools/test_inputs.py
git commit -m "feat(node): declare date/time sun inputs (server stays passive)"
```

---

### Task 7: Wire date/time mode into the widget (`sphere_widget.js`)

**Files:**
- Modify: `js/sphere_widget.js`
- Test: `js/integration.test.js` (headless pipeline check) + manual ComfyUI checklist

**Interfaces:**
- Consumes: `computeSunAngles` (Task 4), `loadCities` (Task 3), `cities.json` (Task 5).
- Produces: live re-render driven by date/time inputs; `doRender()` sources its angles from `getAngles()`.

- [ ] **Step 1: Add imports at the top of `js/sphere_widget.js`**

After the existing `import { app } ...` line, add:

```js
import { loadCities } from "./geo.js";
import { computeSunAngles } from "./sun.js";
```

- [ ] **Step 2: Load the dataset once per node and expose an angle source**

Inside `nodeCreated`, after `node._slReady = false;`, add:

```js
    node._slCities = null;
    loadCities().then((c) => { node._slCities = c; doRender(); })
                .catch((e) => console.warn("[SphereLight] cities.json failed:", e));

    // Returns the sun angles to render, honoring sun_mode.
    const getAngles = () => {
      const mode = node.widgets?.find((w) => w.name === "sun_mode")?.value;
      const intensity = getVal("intensity", 1.5);
      if (mode !== "date/time" || !node._slCities) {
        return { az: getVal("rotation", 0), el: getVal("elevation", 45), intensity };
      }
      const r = computeSunAngles({
        location: getStr("location", ""),
        year: getVal("year", 2025), month: getVal("month", 6), day: getVal("day", 21),
        hour: getVal("hour", 12), minute: getVal("minute", 0), heading: getVal("heading", 0),
      }, node._slCities);
      if (r.error) { console.warn("[SphereLight] location not found:", getStr("location", "")); 
        return { az: getVal("rotation", 0), el: getVal("elevation", 45), intensity }; }
      if (r.belowHorizon) console.warn("[SphereLight] sun below horizon at this time");
      return { az: r.rotation, el: r.elevation, intensity };
    };
```

- [ ] **Step 3: Add the `getStr` helper next to the existing `getVal`**

Immediately after the existing `const getVal = ...` definition, add:

```js
    const getStr = (name, def) => {
      const w = node.widgets?.find((w) => w.name === name);
      return w ? String(w.value) : def;
    };
```

- [ ] **Step 4: Make `doRender` use `getAngles()`**

In `doRender`, replace the first four lines (the `az`/`el`/`r`/`ctx.dirLight.position.set(...)` block through `ctx.dirLight.intensity = ...`) with:

```js
      const { az: azDeg, el: elDeg, intensity } = getAngles();
      const az = azDeg * Math.PI / 180;
      const el = elDeg * Math.PI / 180;
      const r  = 10;
      ctx.dirLight.position.set(
        r * Math.cos(el) * Math.sin(az),
        r * Math.sin(el),
        r * Math.cos(el) * Math.cos(az)
      );
      ctx.dirLight.intensity = intensity;
```

- [ ] **Step 5: Hook the date/time widgets to re-render**

In `hookSliders`, extend the widget-name list so it reads:

```js
      ["rotation", "elevation", "intensity",
       "sun_mode", "location", "year", "month", "day", "hour", "minute", "heading"
      ].forEach(name => {
```

- [ ] **Step 6: Headless pipeline test (mirrors the render's light math)**

`js/integration.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeSunAngles } from "./sun.js";

const FIX = [
  { city: "Austin", regionCode: "TX", region: "Texas", country: "US", countryName: "United States", lat: 30.27, lng: -97.74, tz: "America/Chicago", population: 961855 },
];

// Same mapping doRender() uses: light X uses sin(az), Z uses cos(az), Y uses sin(el).
test("morning sun places the light to the east (+X) and above (+Y)", () => {
  const { rotation, elevation } = computeSunAngles(
    { location: "Austin, TX", year: 2023, month: 6, day: 21, hour: 8, minute: 0, heading: 0 }, FIX);
  const az = rotation * Math.PI / 180, el = elevation * Math.PI / 180;
  const x = Math.cos(el) * Math.sin(az);
  const y = Math.sin(el);
  assert.ok(x > 0, `light X should be east/+, got ${x}`);
  assert.ok(y > 0, `light Y should be above horizon, got ${y}`);
});
```

- [ ] **Step 7: Run tests**

Run: `node --test js/`
Expected: PASS — all suites including `integration.test.js`.

- [ ] **Step 8: Manual verification in ComfyUI**

Restart ComfyUI, hard-refresh the browser, add the node, then confirm:
- [ ] `sun_mode = manual` behaves exactly as before (sliders move the sun).
- [ ] `sun_mode = date/time`, `location = "Austin, TX"`, morning hour → the sphere's shadow falls to the **west** in the preview; evening → to the **east**.
- [ ] Changing `heading` rotates the shadow.
- [ ] A night hour prints "sun below horizon" and flattens the light.
- [ ] An unknown `location` prints a warning and falls back without crashing.

- [ ] **Step 9: Commit**

```bash
git add js/sphere_widget.js js/integration.test.js
git commit -m "feat(widget): drive the light from date/time sun position"
```

---

### Task 8: Document the feature (`README.md`)

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add a "Time of day" section**

Insert after the "Quick start" section:

```markdown
## Time of day

Set `sun_mode` to `date/time` to position the light from a real sun position.
Enter a `location` ("City, State" for the US, or "City, Country" elsewhere — from
a bundled offline list of cities over ~15k population), the date/time, and the
compass `heading` the camera faces. Timezone and daylight-saving are handled
automatically. Places not in the list: switch back to `manual`, or use a nearby
listed city. Rebuild the city list with `python tools/build_cities.py`.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: document date/time sun mode"
```

---

## Self-Review

**1. Spec coverage**
- Mode toggle → Task 6 (`sun_mode`) + Task 7 (`getAngles` branch). ✓
- Offline city→lat/lng/tz (US + populous worldwide, GeoNames) → Task 5. ✓
- DST-correct local→UTC via `Intl` → Task 2. ✓
- JS-side solar position feeding existing render → Tasks 1, 4, 7. ✓
- `scene_rotation = azimuth − heading`, normalized → Task 4. ✓
- Azimuth convention fixed once (N, clockwise) → Task 1 + test. ✓
- Below-horizon clamp + flag → Task 4 (`belowHorizon`, elevation 0) + Task 7 warning. ✓
- Intensity stays manual → Task 6 (still a slider), Task 7 (`getAngles` passes it through). ✓
- City not found / ambiguous → Task 3 (population sort, `null`) + Task 4 (manual lat/lng fallback / error) + Task 7 (warn + fall back). ✓
- Manual lat/lng fallback → Task 4 test + `computeSunAngles` params `lat/lng/tz`. ✓ (Note: exposed in logic; the widget currently only warns and reverts to manual sliders — manual lat/lng UI fields are not added here, matching "fallback stays available" via manual mode. If dedicated lat/lng widgets are wanted, add them in a follow-up.)
- Python passive → Task 6 (signature ignores new params). ✓
- True altitude 0–90 in date/time mode → Task 4 (no 5–85 clamp applied). ✓
- Testing (solar vs reference, geo cities, shadow direction) → Tasks 1, 3, 7. ✓

**2. Placeholder scan:** No TBD/TODO; every code step contains complete code and exact run/expected lines. ✓

**3. Type consistency:** Record shape `{ city, regionCode, region, country, countryName, lat, lng, tz, population }` is identical across Task 3 (`findCity`), Task 4 fixture, Task 5 output, Task 7 fixture. `computeSunAngles` return keys (`rotation, elevation, belowHorizon, altitude, azimuth, matched, error`) match between Task 4 definition and Task 7 consumption. `getVal`/`getStr` names match their uses. ✓

**One resolved gap:** the spec mentions "manual lat/lon fields" as a fallback. The plan implements the *logic* for it (`computeSunAngles` accepts `lat/lng/tz`) but does not add dedicated lat/lng widgets — date/time failures fall back to manual-slider mode instead. This keeps v1 lean; dedicated manual-coordinate widgets can be a follow-up task if desired. Flagged here rather than silently dropped.
