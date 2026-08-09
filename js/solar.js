// NOAA solar position algorithm (port of the NOAA solar calculator spreadsheet).
// Returns { altitude, azimuth } in degrees. Azimuth is compass-from-North,
// clockwise (0 = N, 90 = E, 180 = S, 270 = W). Altitude is degrees above the
// horizon (negative when the sun is below it). Pure — no DOM, no globals.

const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;
const mod = (n, m) => ((n % m) + m) % m;

function julianDay(date) {
  return date.getTime() / 86400000 + 2440587.5;
}

export function sunPosition(lat, lng, dateUTC) {
  const jc = (julianDay(dateUTC) - 2451545) / 36525; // Julian century

  const gmls = mod(280.46646 + jc * (36000.76983 + jc * 0.0003032), 360); // geom mean long (deg)
  const gmas = 357.52911 + jc * (35999.05029 - 0.0001537 * jc);           // geom mean anomaly (deg)
  const ecc = 0.016708634 - jc * (0.000042037 + 0.0000001267 * jc);       // eccentricity

  const ctr =
    Math.sin(rad(gmas)) * (1.914602 - jc * (0.004817 + 0.000014 * jc)) +
    Math.sin(rad(2 * gmas)) * (0.019993 - 0.000101 * jc) +
    Math.sin(rad(3 * gmas)) * 0.000289;

  const trueLong = gmls + ctr;
  const appLong = trueLong - 0.00569 - 0.00478 * Math.sin(rad(125.04 - 1934.136 * jc));

  const meanObliq =
    23 + (26 + (21.448 - jc * (46.815 + jc * (0.00059 - jc * 0.001813))) / 60) / 60;
  const obliq = meanObliq + 0.00256 * Math.cos(rad(125.04 - 1934.136 * jc));

  const declin = deg(Math.asin(Math.sin(rad(obliq)) * Math.sin(rad(appLong))));

  const y = Math.tan(rad(obliq / 2)) ** 2;
  const eqTime =
    4 *
    deg(
      y * Math.sin(2 * rad(gmls)) -
        2 * ecc * Math.sin(rad(gmas)) +
        4 * ecc * y * Math.sin(rad(gmas)) * Math.cos(2 * rad(gmls)) -
        0.5 * y * y * Math.sin(4 * rad(gmls)) -
        1.25 * ecc * ecc * Math.sin(2 * rad(gmas))
    ); // minutes

  const utcMin =
    dateUTC.getUTCHours() * 60 + dateUTC.getUTCMinutes() + dateUTC.getUTCSeconds() / 60;
  const trueSolarTime = mod(utcMin + eqTime + 4 * lng, 1440); // minutes; east lng positive
  const hourAngle = trueSolarTime / 4 < 0 ? trueSolarTime / 4 + 180 : trueSolarTime / 4 - 180;

  const zenith = deg(
    Math.acos(
      Math.sin(rad(lat)) * Math.sin(rad(declin)) +
        Math.cos(rad(lat)) * Math.cos(rad(declin)) * Math.cos(rad(hourAngle))
    )
  );
  const altitude = 90 - zenith;

  let azimuth;
  const denom = Math.cos(rad(lat)) * Math.sin(rad(zenith));
  if (Math.abs(denom) > 0.001) {
    let c = (Math.sin(rad(lat)) * Math.cos(rad(zenith)) - Math.sin(rad(declin))) / denom;
    c = Math.max(-1, Math.min(1, c));
    azimuth = deg(Math.acos(c));
    azimuth = hourAngle > 0 ? mod(azimuth + 180, 360) : mod(540 - azimuth, 360);
  } else {
    azimuth = declin > lat ? 180 : 0;
  }

  return { altitude, azimuth };
}
