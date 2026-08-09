import { test } from "node:test";
import assert from "node:assert/strict";
import { parseImageValue, cityStringFor, photoStatus, normalizeParsed } from "../js/photo.js";
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
  const s = photoStatus({ lat: null, lng: null, heading: null, headingRef: null, date: null }, "");
  assert.equal(s, "📷 ⚠ no GPS data · no heading tag · no date/time tag");
});

test("photoStatus with GPS but no city label still shows coordinates", () => {
  const s = photoStatus({ lat: 1.5, lng: -3.25, heading: 90, date: null }, "");
  assert.equal(s, "📷 1.50, -3.25 · heading 90.00° · no date/time tag");
});

test("photoStatus marks a magnetic heading; true north stays unmarked", () => {
  const base = { lat: null, lng: null, date: null };
  assert.match(photoStatus({ ...base, heading: 90, headingRef: "M" }, ""),
               /heading 90\.00° \(magnetic\)/);
  const t = photoStatus({ ...base, heading: 90, headingRef: "T" }, "");
  assert.match(t, /heading 90\.00°/);
  assert.doesNotMatch(t, /magnetic/);
});

// ---- normalizeParsed -------------------------------------------------------

test("normalizeParsed passes valid values through (wrapping heading into [0,360))", () => {
  const parsed = {
    lat: 48.858222, lng: 2.2945, heading: 214.5, headingRef: null,
    date: { year: 2023, month: 6, day: 21, hour: 14, minute: 30 },
  };
  assert.deepEqual(normalizeParsed(parsed), parsed);
  assert.equal(normalizeParsed({ ...parsed, heading: 365.5 }).heading, 5.5);
  assert.equal(normalizeParsed({ ...parsed, heading: -45 }).heading, 315);
  assert.equal(normalizeParsed({ ...parsed, heading: 360 }).heading, 0);
});

test("normalizeParsed keeps headingRef only while a heading survives", () => {
  const base = { lat: null, lng: null, date: null };
  assert.equal(normalizeParsed({ ...base, heading: 214.5, headingRef: "M" }).headingRef, "M");
  assert.equal(normalizeParsed({ ...base, heading: 214.5, headingRef: "T" }).headingRef, "T");
  // No heading -> the ref means nothing, drop it.
  assert.equal(normalizeParsed({ ...base, heading: null, headingRef: "M" }).headingRef, null);
});

test("normalizeParsed rejects out-of-range coordinates as no-GPS (both nulled)", () => {
  const base = { lat: 91.2, lng: 2.29, heading: null, date: null };
  assert.deepEqual(normalizeParsed(base), { lat: null, lng: null, heading: null, headingRef: null, date: null });
  assert.equal(normalizeParsed({ ...base, lat: 48.9, lng: -180.5 }).lat, null);
  assert.equal(normalizeParsed({ ...base, lat: 48.9, lng: -180.5 }).lng, null);
});

test("normalizeParsed rejects an invalid date wholesale", () => {
  const d = (date) => normalizeParsed({ lat: null, lng: null, heading: null, date }).date;
  assert.equal(d({ year: 2023, month: 99, day: 21, hour: 14, minute: 30 }), null);
  assert.equal(d({ year: 2023, month: 6, day: 0, hour: 14, minute: 30 }), null);
  assert.equal(d({ year: 2023, month: 6, day: 21, hour: 24, minute: 30 }), null);
  assert.equal(d({ year: 0, month: 6, day: 21, hour: 14, minute: 30 }), null);
  assert.deepEqual(d({ year: 1, month: 1, day: 1, hour: 0, minute: 0 }),
                   { year: 1, month: 1, day: 1, hour: 0, minute: 0 });
});

test("normalizeParsed keeps all-null input all-null", () => {
  const empty = { lat: null, lng: null, heading: null, headingRef: null, date: null };
  assert.deepEqual(normalizeParsed(empty), empty);
});

test("cityStringFor qualifier fallback chain round-trips through findCity", () => {
  const mk = (extra) => [{ city: "Testville", lat: 10, lng: 10, tz: "UTC", population: 1, ...extra }];
  let recs = mk({ regionCode: "TS" });
  assert.equal(cityStringFor(10, 10, recs), "Testville, TS");
  assert.equal(findCity("Testville, TS", recs).city, "Testville");
  recs = mk({ countryName: "Testland" });
  assert.equal(cityStringFor(10, 10, recs), "Testville, Testland");
  assert.equal(findCity("Testville, Testland", recs).city, "Testville");
  recs = mk({ country: "TL" });
  assert.equal(cityStringFor(10, 10, recs), "Testville, TL");
  assert.equal(findCity("Testville, TL", recs).city, "Testville");
  recs = mk({});
  assert.equal(cityStringFor(10, 10, recs), "Testville");
  assert.equal(findCity("Testville", recs).city, "Testville");
});
