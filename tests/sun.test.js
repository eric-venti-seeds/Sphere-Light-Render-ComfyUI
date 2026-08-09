import { test } from "node:test";
import assert from "node:assert/strict";
import { computeSunAngles, normalizeDeg180 } from "../js/sun.js";

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
  // Turning the camera clockwise by 90° sweeps the scene light +90°: the sun
  // that was ahead-right ends up behind-right (rotation = 180 - az + heading).
  assert.ok(Math.abs(normalizeDeg180(turned.rotation - base.rotation - 90)) < 0.001);
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

test("city match returns a sun label with the city name", () => {
  const r = computeSunAngles({ location: "Austin, TX", year: 2023, month: 6, day: 21, hour: 12, minute: 0 }, FIX);
  assert.equal(r.source, "city");
  assert.match(r.label, /Austin/);
});

test("coordinates used when no city; timezone borrowed from nearest city", () => {
  const r = computeSunAngles(
    { location: "", lat: 30.27, lng: -97.74, year: 2023, month: 6, day: 21, hour: 8, minute: 0, heading: 0 },
    FIX
  );
  assert.equal(r.error, undefined);
  assert.equal(r.source, "coords");
  assert.equal(r.matched, null);
  assert.ok(r.elevation > 10, `elevation ${r.elevation}`); // 8am Central -> sun is up
  assert.match(r.label, /30\.27/);
});

test("unresolved location returns error with an explanatory label", () => {
  const r = computeSunAngles({ location: "Nowhere, ZZ", year: 2023, month: 6, day: 21, hour: 8, minute: 0 }, FIX);
  assert.equal(r.error, "city_not_found");
  assert.match(r.label, /not found/);
});

test("(0,0) coordinates are treated as unset", () => {
  const r = computeSunAngles({ location: "", lat: 0, lng: 0, year: 2023, month: 6, day: 21, hour: 8, minute: 0 }, FIX);
  assert.equal(r.error, "city_not_found");
});

// ---- physical convention of `rotation` -------------------------------------
// Scene frame (preview.js): the camera sits at +z looking at the origin, and
// lightPosition() measures azimuth from +z — so rotation 0 means the light is
// BEHIND the camera (frontal light), ±180 means backlight. These tests pin
// rotation to reality; the numeric case is a real photo (Philadelphia,
// 2024-01-13 15:29 EST, EXIF heading 350.49°, sun az ~226.9° alt ~13°).

test("sun behind-left of the camera lights the sphere from behind-left", () => {
  const r = computeSunAngles(
    { location: "", lat: 39.976, lng: -75.1799, tz: "America/New_York",
      year: 2024, month: 1, day: 13, hour: 15, minute: 29, heading: 350.49 },
    FIX
  );
  // Sun bearing relative to the camera: 226.94 - 350.49 = -123.55 (behind-left)
  // -> scene rotation 180 - (-123.55) = -56.45: cos>0 (camera side), sin<0 (left).
  assert.ok(Math.abs(r.elevation - 12.96) < 2, `elevation ${r.elevation}`);
  assert.ok(r.rotation > -65 && r.rotation < -48, `rotation ${r.rotation}`);
});

test("facing away from the noon sun gives frontal light (rotation ~0)", () => {
  // Philadelphia solar noon (~12:09 EST) in January: sun due south (az ~180).
  // Camera heading 0 (facing north) -> sun directly behind the photographer.
  const r = computeSunAngles(
    { location: "", lat: 39.976, lng: -75.1799, tz: "America/New_York",
      year: 2024, month: 1, day: 13, hour: 12, minute: 9, heading: 0 },
    FIX
  );
  assert.ok(Math.abs(r.rotation) < 10, `rotation ${r.rotation}`);
});

test("facing into the sun gives backlight (|rotation| ~180)", () => {
  const r = computeSunAngles(
    { location: "", lat: 39.976, lng: -75.1799, tz: "America/New_York",
      year: 2024, month: 1, day: 13, hour: 12, minute: 9, heading: 180 },
    FIX
  );
  assert.ok(Math.abs(r.rotation) > 170, `rotation ${r.rotation}`);
});
