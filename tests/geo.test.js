import { test } from "node:test";
import assert from "node:assert/strict";
import { findCity, nearestCity } from "../js/geo.js";

const FIX = [
  { city: "Austin", regionCode: "TX", region: "Texas", country: "US", countryName: "United States", lat: 30.27, lng: -97.74, tz: "America/Chicago", population: 961855 },
  { city: "Austin", regionCode: "MN", region: "Minnesota", country: "US", countryName: "United States", lat: 43.67, lng: -92.97, tz: "America/Chicago", population: 24000 },
  { city: "Tokyo", regionCode: "13", region: "Tokyo", country: "JP", countryName: "Japan", lat: 35.68, lng: 139.65, tz: "Asia/Tokyo", population: 37000000 },
  { city: "London", regionCode: "ENG", region: "England", country: "GB", countryName: "United Kingdom", lat: 51.51, lng: -0.13, tz: "Europe/London", population: 8961989 },
  { city: "New York City", regionCode: "NY", region: "New York", country: "US", countryName: "United States", lat: 40.71, lng: -74.01, tz: "America/New_York", population: 8175133 },
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

test("prefix fallback resolves common short forms", () => {
  assert.equal(findCity("New York", FIX).city, "New York City");
  assert.equal(findCity("New York, NY", FIX).city, "New York City");
});

test("common country aliases resolve (UK, USA)", () => {
  assert.equal(findCity("London, UK", FIX).tz, "Europe/London");
  assert.equal(findCity("London, England", FIX).tz, "Europe/London");
  assert.equal(findCity("Austin, USA", FIX).regionCode, "TX"); // most populous Austin in US
});

test("nearestCity returns the closest record", () => {
  assert.equal(nearestCity(30.3, -97.7, FIX).regionCode, "TX"); // near Austin, TX
  assert.equal(nearestCity(35.6, 139.7, FIX).city, "Tokyo");    // near Tokyo
});

test("nearestCity wraps longitude across the antimeridian", () => {
  const PACIFIC = [
    { city: "Suva",    lat: -18.14, lng: 178.44,  tz: "Pacific/Fiji" },
    { city: "Papeete", lat: -17.53, lng: -149.57, tz: "Pacific/Tahiti" },
  ];
  // Just EAST of the date line: numerically ~358° of longitude from Suva but
  // physically ~2°. Naive degree distance would pick Papeete (30° away).
  assert.equal(nearestCity(-17.0, -179.9, PACIFIC).city, "Suva");
});

test("nearestCity scales longitude by cos(latitude)", () => {
  const NORTH = [
    { city: "SameLatEast", lat: 65.0, lng: 10.0, tz: "X" }, // 10° lng ≈ 4.2° ground at 65°N
    { city: "DueSouth",    lat: 58.5, lng: 0.0,  tz: "Y" }, // 6.5° lat away
  ];
  assert.equal(nearestCity(65.0, 0.0, NORTH).city, "SameLatEast");
});
