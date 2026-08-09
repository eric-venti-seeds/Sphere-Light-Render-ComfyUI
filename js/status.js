import { nearestCity } from "./geo.js";

// Great-circle distance in km (mean Earth radius 6371 km).
export function haversineKm(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Read-only status for the coords node: which listed city the timezone was
// borrowed from, plus a distance hint when that city is far (so the label never
// overstates the match). Presentation only — never writes back to any input.
export function nearestCityLabel({ lat, lng, tz }, records) {
  const city = nearestCity(lat, lng, records);
  if (!city) return { city: null, km: null, label: "" };
  const km = haversineKm(lat, lng, city.lat, city.lng);
  const region = city.region || city.regionCode || city.countryName || city.country || "";
  const name = region ? `${city.city}, ${region}` : city.city;
  const far = km > 25 ? ` (~${Math.round(km)} km)` : "";
  return { city, km, label: `☀ near ${name}${far} · ${tz}` };
}
