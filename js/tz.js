// Timezone math using the browser/Node-native Intl API (full ICU). No library.

// Date.UTC() reads years 0-99 as 1900-1999; setUTCFullYear does not, and the
// node advertises years 1-9999.
function utcMs(year, month, day, hour, minute, second) {
  const d = new Date(0);
  d.setUTCFullYear(year, month - 1, day);
  d.setUTCHours(hour, minute, second, 0);
  return d.getTime();
}

export function zoneOffsetMs(instant, timeZone) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p = Object.fromEntries(dtf.formatToParts(instant).map((x) => [x.type, x.value]));
  const asUTC = utcMs(+p.year, +p.month, +p.day, +p.hour, +p.minute, +p.second);
  return asUTC - instant.getTime();
}

export function zonedWallTimeToUTC(year, month, day, hour, minute, timeZone) {
  // Treat the wall time as if it were UTC, then subtract the zone's offset.
  // A second pass recomputes the offset at the first-pass instant so times in
  // the multi-hour window around a DST transition resolve to the correct side.
  // The only irreducible ambiguity is the ~1h nonexistent/repeated wall-clock
  // hour at the transition itself.
  const guess = utcMs(year, month, day, hour, minute, 0);
  let utc = guess - zoneOffsetMs(new Date(guess), timeZone);
  utc = guess - zoneOffsetMs(new Date(utc), timeZone);
  return new Date(utc);
}
