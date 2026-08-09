import { test } from "node:test";
import assert from "node:assert/strict";
import { computeSunAngles } from "../js/sun.js";
import { parseExif } from "../js/exif.js";
import { normalizeParsed, cityStringFor } from "../js/photo.js";
import { lightPosition } from "../js/light.js";
import { buildTiff, jpegWith } from "./helpers/tiff.js";

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

// The full Photo (EXIF) → Sun (Coordinates) pipeline, with the README's Penn
// Park photo values: EXIF bytes → parseExif → normalizeParsed → city label +
// computeSunAngles → lightPosition. Everything a queued run bakes, minus the
// DOM.
test("photo EXIF drives the sun pipeline end-to-end (Penn Park photo)", () => {
  const jpeg = jpegWith(buildTiff({
    lat: [39, 57, 2.88], latRef: "N",     // 39.9508
    lng: [75, 11, 6.72], lngRef: "W",     // -75.1852
    heading: 85.48,                        // facing just north of east
    dateTime: "2017:01:01 12:59:00",
  }));

  const parsed = normalizeParsed(parseExif(jpeg.buffer));
  assert.ok(Math.abs(parsed.lat - 39.9508) < 1e-4, `lat ${parsed.lat}`);
  assert.ok(Math.abs(parsed.lng - -75.1852) < 1e-4, `lng ${parsed.lng}`);
  assert.ok(Math.abs(parsed.heading - 85.48) < 1e-4, `heading ${parsed.heading}`);
  assert.deepEqual(parsed.date, { year: 2017, month: 1, day: 1, hour: 12, minute: 59 });

  const PHL = [
    { city: "Philadelphia", regionCode: "PA", region: "Pennsylvania", country: "US", countryName: "United States", lat: 39.9526, lng: -75.1652, tz: "America/New_York", population: 1526006 },
  ];
  assert.equal(cityStringFor(parsed.lat, parsed.lng, PHL), "Philadelphia, Pennsylvania");

  const r = computeSunAngles({
    lat: parsed.lat, lng: parsed.lng,
    year: parsed.date.year, month: parsed.date.month, day: parsed.date.day,
    hour: parsed.date.hour, minute: parsed.date.minute,
    heading: parsed.heading,
  }, PHL);

  assert.ok(!r.error, r.label);
  assert.equal(r.belowHorizon, false);
  // Philadelphia, New Year's Day, just before 1pm EST: low winter sun a
  // little past due south (solar noon ≈ 12:05).
  assert.ok(r.elevation > 20 && r.elevation < 30, `elevation ${r.elevation}`);
  assert.ok(r.azimuth > 180 && r.azimuth < 215, `azimuth ${r.azimuth}`);
  // Sun ~107° clockwise of an east-facing camera -> light from screen right.
  assert.ok(r.rotation > 50 && r.rotation < 90, `rotation ${r.rotation}`);
  const p = lightPosition(r.rotation, r.elevation);
  assert.ok(p.x > 0, `light X should be from the right, got ${p.x}`);
  assert.ok(p.y > 0, `light Y should be above horizon, got ${p.y}`);
});
