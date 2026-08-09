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
const GPS_IMG_DIR_REF = 0x0010, GPS_IMG_DIR = 0x0011;
const EXIF_DATETIME_ORIGINAL = 0x9003;

// Parse a TIFF/EXIF block. Returns { lat, lng, heading, headingRef, date } —
// each null when absent (date: {year, month, day, hour, minute}; headingRef is
// GPSImgDirectionRef, "T" true north / "M" magnetic north). Throws on
// malformed input; parseExif() is the catching entry point. Out-of-range
// offsets throw RangeError from DataView, which serves as the bounds check.
export function parseTiff(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const order = dv.getUint16(0);
  if (order !== 0x4949 && order !== 0x4d4d) throw new Error("not a TIFF block");
  const le = order === 0x4949;
  if (dv.getUint16(2, le) !== 42) throw new Error("bad TIFF magic");
  const ifd0 = readIfd(dv, dv.getUint32(4, le), le);

  const out = { lat: null, lng: null, heading: null, headingRef: null, date: null };

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
      if (Number.isFinite(h)) {
        out.heading = h;
        // The ref only means something alongside a heading; anything other
        // than the two spec values stays null (unknown, not assumed true).
        const refEntry = gps.get(GPS_IMG_DIR_REF);
        if (refEntry) {
          const ref = readAscii(dv, refEntry, le).trim().toUpperCase();
          if (ref === "T" || ref === "M") out.headingRef = ref;
        }
      }
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

// The one entry point: photo file bytes in, { lat, lng, heading, headingRef,
// date } out. Never throws — malformed or absent EXIF yields all-null.
export function parseExif(arrayBuffer) {
  const empty = { lat: null, lng: null, heading: null, headingRef: null, date: null };
  try {
    const tiff = findExifPayload(new Uint8Array(arrayBuffer));
    return tiff ? parseTiff(tiff) : empty;
  } catch (e) {
    return empty;
  }
}
