// Pure helpers behind the Photo (EXIF) node's browser glue: mapping the image
// widget's value to a /view request, choosing the city string, and composing
// the status line. DOM-free — unit tests in tests/photo.test.js.

import { nearestCity } from "./geo.js";

// LoadImage-style widget values: "name.jpg", "sub/dir/name.jpg", optionally
// annotated "name.jpg [input|output|temp]".
export function parseImageValue(value) {
  let name = String(value || "");
  let type = "input";
  const m = name.match(/^(.*) \[(input|output|temp)\]$/);
  if (m) {
    name = m[1];
    type = m[2];
  }
  let subfolder = "";
  const slash = name.lastIndexOf("/");
  if (slash > -1) {
    subfolder = name.slice(0, slash);
    name = name.slice(slash + 1);
  }
  return { filename: name, subfolder, type };
}

// Sanitize what parseExif produced before it reaches any widget: real-world
// EXIF can carry DMS minutes ≥ 60 (lat beyond ±90), headings outside 0–360,
// or a nonsense date the "YYYY:MM:DD" shape check can't catch. Out-of-range
// coordinates are treated as no-GPS (clamping would invent a location);
// headings wrap (365° means 5°); an invalid date is dropped wholesale.
export function normalizeParsed(parsed) {
  const out = { lat: null, lng: null, heading: null, headingRef: null, date: null };
  if (parsed.lat != null && parsed.lng != null &&
      Math.abs(parsed.lat) <= 90 && Math.abs(parsed.lng) <= 180) {
    out.lat = parsed.lat;
    out.lng = parsed.lng;
  }
  if (parsed.heading != null) {
    out.heading = ((parsed.heading % 360) + 360) % 360;
    out.headingRef = parsed.headingRef ?? null;
  }
  const d = parsed.date;
  if (d != null &&
      d.year >= 1 && d.year <= 9999 && d.month >= 1 && d.month <= 12 &&
      d.day >= 1 && d.day <= 31 && d.hour >= 0 && d.hour <= 23 &&
      d.minute >= 0 && d.minute <= 59) {
    out.date = d;
  }
  return out;
}

// A "City, Region" string that findCity() resolves back to the same record
// (the Sun (City) node parses its city input as "city, qualifier").
export function cityStringFor(lat, lng, records) {
  const r = nearestCity(lat, lng, records || []);
  if (!r) return "";
  const qual = r.region || r.regionCode || r.countryName || r.country || "";
  return qual ? `${r.city}, ${qual}` : r.city;
}

// One status line describing what the photo yielded; explicit about gaps so a
// missing compass heading is visible, not silent.
export function photoStatus(parsed, cityLabel) {
  const parts = [];
  if (parsed.lat != null && parsed.lng != null) {
    const at = `${parsed.lat.toFixed(2)}, ${parsed.lng.toFixed(2)}`;
    parts.push(cityLabel ? `${at} near ${cityLabel}` : at);
  } else {
    parts.push("⚠ no GPS data");
  }
  // A magnetic heading (GPSImgDirectionRef "M") is off from true north by the
  // local declination; surface that rather than silently treating it as true.
  parts.push(parsed.heading != null
    ? `heading ${parsed.heading.toFixed(2)}°` +
      (parsed.headingRef === "M" ? " (magnetic)" : "")
    : "no heading tag");
  if (parsed.date != null) {
    const d = parsed.date;
    const p2 = (n) => String(n).padStart(2, "0");
    parts.push(`${d.year}-${p2(d.month)}-${p2(d.day)} ${p2(d.hour)}:${p2(d.minute)}`);
  } else {
    parts.push("no date/time tag");
  }
  return `📷 ${parts.join(" · ")}`;
}
