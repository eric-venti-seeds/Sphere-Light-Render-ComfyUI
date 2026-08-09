import { test } from "node:test";
import assert from "node:assert/strict";
import { parseExif, findExifPayload, dmsToDeg, parseTiff } from "../js/exif.js";
import { buildTiff, jpegWith, pngWith, webpWith } from "./helpers/tiff.js";

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
  assert.deepEqual(empty, { lat: null, lng: null, heading: null, headingRef: null, date: null });
});

test("GPSImgDirectionRef comes out alongside the heading", () => {
  const magnetic = parseTiff(buildTiff({ heading: 214.5, headingRef: "M" }));
  assert.equal(magnetic.headingRef, "M");
  assert.ok(Math.abs(magnetic.heading - 214.5) < 1e-6);
  const trueNorth = parseTiff(buildTiff({ heading: 214.5, headingRef: "T" }));
  assert.equal(trueNorth.headingRef, "T");
  // Ref tag absent (the PARIS fixture has none): null, not a guessed "T".
  assert.equal(parseTiff(buildTiff(PARIS)).headingRef, null);
});

test("parseTiff throws on non-TIFF bytes (caller catches)", () => {
  assert.throws(() => parseTiff(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])));
});

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
  const empty = { lat: null, lng: null, heading: null, headingRef: null, date: null };
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

test("parseExif on EXIF-less containers yields all-null (scanners reach their exits)", () => {
  const empty = { lat: null, lng: null, heading: null, headingRef: null, date: null };
  // JPEG: SOI + APP0 stub (marker 0xE0, length 8, 6 payload bytes) + EOI, plus
  // 2 trailing pad bytes so the loop's 4-byte lookahead reaches the EOI marker
  // and actually executes the `marker === 0xd9` break (not just runs out of
  // bytes) — no APP1 anywhere.
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x08, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x00,
    0xff, 0xd9, 0x00, 0x00]);
  // PNG: signature + zero-length IEND chunk (len, "IEND", CRC) — no eXIf.
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0, 0, 0, 0]);
  // WebP: RIFF header + one non-EXIF chunk ("VP8 " with 2 payload bytes, even-padded) — no EXIF chunk.
  const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x0e, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
    0x56, 0x50, 0x38, 0x20, 0x02, 0, 0, 0, 0xaa, 0xbb]);
  for (const bytes of [jpeg, png, webp]) {
    assert.deepEqual(parseExif(bytes.buffer), empty);
  }
});

test("a zero-denominator rational in one coordinate nulls both (no half-GPS)", () => {
  const r = parseTiff(buildTiff({
    lat: [48, 51, 29.6], latRef: "N",
    lng: [2, 17, 40.2], lngRef: "E", lngDen: 0,
    heading: 214.5,
  }));
  assert.equal(r.lat, null);
  assert.equal(r.lng, null);
  assert.ok(Math.abs(r.heading - 214.5) < 1e-6); // unaffected tag still parses
  const h = parseTiff(buildTiff({ heading: 90, headingDen: 0 }));
  assert.equal(h.heading, null);
});

test("parseTiff rejects absurd tag counts (MAX_COUNT cap) and parseExif absorbs it", () => {
  const u16 = (v) => [v & 255, (v >> 8) & 255];
  const u32 = (v) => [...u16(v & 0xffff), ...u16((v >>> 16) & 0xffff)];
  // header | IFD0 @8: 1 entry (GPS pointer -> 26) | GPS IFD @26: GPSImgDirection
  // claiming 100000 rationals — payloadOffset must throw before looping.
  const tiff = new Uint8Array([
    0x49, 0x49, ...u16(42), ...u32(8),
    ...u16(1), ...u16(0x8825), ...u16(4), ...u32(1), ...u32(26), ...u32(0),
    ...u16(1), ...u16(0x0011), ...u16(5), ...u32(100000), ...u32(64), ...u32(0),
  ]);
  assert.throws(() => parseTiff(tiff), /too large/);
  assert.deepEqual(parseExif(jpegWith(tiff).buffer),
                   { lat: null, lng: null, heading: null, headingRef: null, date: null });
});
