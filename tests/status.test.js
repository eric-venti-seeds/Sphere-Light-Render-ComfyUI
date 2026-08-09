import { test } from "node:test";
import assert from "node:assert/strict";
import { haversineKm, nearestCityLabel } from "../js/status.js";

const FIX = [
  { city: "Austin", regionCode: "TX", region: "Texas", country: "US", lat: 30.27, lng: -97.74, tz: "America/Chicago" },
  { city: "Tokyo", region: "Tokyo", country: "JP", lat: 35.68, lng: 139.69, tz: "Asia/Tokyo" },
];

test("haversineKm is ~0 for identical points and positive otherwise", () => {
  assert.equal(Math.round(haversineKm(30.27, -97.74, 30.27, -97.74)), 0);
  assert.ok(haversineKm(30.27, -97.74, 35.68, 139.69) > 9000);
});

test("nearestCityLabel names the closest city and its tz", () => {
  const r = nearestCityLabel({ lat: 30.3, lng: -97.7, tz: "America/Chicago" }, FIX);
  assert.equal(r.city.city, "Austin");
  assert.match(r.label, /near Austin, Texas · America\/Chicago/);
});

test("label omits the km hint when the nearest city is close (<25km)", () => {
  const r = nearestCityLabel({ lat: 30.27, lng: -97.74, tz: "America/Chicago" }, FIX);
  assert.ok(!/km/.test(r.label), r.label);
});

test("label includes ~km when the nearest city is far", () => {
  const r = nearestCityLabel({ lat: 32.0, lng: -99.0, tz: "America/Chicago" }, FIX);
  assert.match(r.label, /\(~\d+ km\)/);
});

test("empty records -> empty label", () => {
  const r = nearestCityLabel({ lat: 1, lng: 2, tz: "UTC" }, []);
  assert.equal(r.label, "");
  assert.equal(r.city, null);
});
