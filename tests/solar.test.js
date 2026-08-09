import { test } from "node:test";
import assert from "node:assert/strict";
import { sunPosition } from "../js/solar.js";

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
