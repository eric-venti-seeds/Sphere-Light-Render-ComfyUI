// Hand-rolled TIFF/EXIF fixture builder for tests (and the e2e fixture
// script). Layout: header(8) | IFD0 | GPS IFD | Exif IFD | data area.
// opts: { lat: [d,m,s], latRef, lng: [d,m,s], lngRef, heading: number,
//         headingRef: "T" | "M" (GPSImgDirectionRef; omitted when absent),
//         dateTime: "YYYY:MM:DD HH:MM:SS", littleEndian (default true),
//         lngDen/headingDen: rational denominator overrides (default 10000;
//         pass 0 to fixture a corrupt zero-denominator rational) }
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
    gps.push([0x0004, 5, 3, null, opts.lng.flatMap((v) => rational(v, opts.lngDen ?? 10000))]);
  }
  if (opts.headingRef != null) {
    gps.push([0x0010, 2, 2, ascii(opts.headingRef).concat([0, 0]).slice(0, 4), null]);
  }
  if (opts.heading != null) {
    gps.push([0x0011, 5, 1, null, rational(opts.heading, opts.headingDen ?? 10000)]);
  }
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
