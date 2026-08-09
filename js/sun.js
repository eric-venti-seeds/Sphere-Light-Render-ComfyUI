import { sunPosition } from "./solar.js";
import { zonedWallTimeToUTC } from "./tz.js";
import { findCity, nearestCity } from "./geo.js";

export function normalizeDeg180(a) {
  return (((a + 180) % 360) + 360) % 360 - 180;
}

function cityLabel(c) {
  const region = c.region || c.regionCode || c.countryName || c.country || "";
  return region ? `${c.city}, ${region}` : c.city;
}

// Resolve location + date/time + heading into scene angles, and always return a
// human-readable `label` describing what was resolved (so the UI can show it).
// Priority: a matched city, else manual lat/lng (timezone borrowed from the
// nearest listed city), else an error with an explanatory label.
export function computeSunAngles(params, records) {
  const { location, year, month, day, hour, minute, heading = 0 } = params;
  const hasCoords =
    Number.isFinite(params.lat) && Number.isFinite(params.lng) &&
    !(params.lat === 0 && params.lng === 0);

  let lat, lng, tz, matched, source, label;
  const city = findCity(location, records);
  if (city) {
    ({ lat, lng, tz } = city);
    matched = city;
    source = "city";
    label = `☀ ${cityLabel(city)}`;
  } else if (hasCoords) {
    lat = params.lat;
    lng = params.lng;
    const near = nearestCity(lat, lng, records);
    tz = params.tz || (near ? near.tz : "UTC");
    matched = null;
    source = "coords";
    label = `☀ ${lat.toFixed(3)}, ${lng.toFixed(3)} (${tz})`;
  } else {
    const q = (location || "").trim();
    return {
      error: "city_not_found",
      label: q
        ? `⚠ "${q}" not found — check spelling or set lat/lon`
        : `⚠ enter a city or lat/lon`,
    };
  }

  const utc = zonedWallTimeToUTC(year, month, day, hour, minute, tz);
  const { altitude, azimuth } = sunPosition(lat, lng, utc);
  const belowHorizon = altitude <= 0;
  if (belowHorizon) label += ` — sun below horizon`;

  // Scene mapping: lightPosition() measures azimuth from +z, and the camera
  // also sits at +z — so scene rotation 0 is light BEHIND the camera (frontal)
  // and ±180 is backlight. The sun's bearing relative to the camera facing is
  // (azimuth - heading), where 0 means dead ahead — the mirror image. Mapping
  // through 180 - rel makes the render physically match a camera at `heading`:
  // face away from the sun -> frontal light; shoot into it -> backlight; sun to
  // your right -> light from screen right.
  return {
    rotation: normalizeDeg180(180 - (azimuth - heading)),
    elevation: belowHorizon ? 0 : altitude,
    belowHorizon,
    altitude,
    azimuth,
    matched,
    source,
    label,
  };
}
