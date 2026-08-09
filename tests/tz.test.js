import { test } from "node:test";
import assert from "node:assert/strict";
import { zonedWallTimeToUTC } from "../js/tz.js";

test("summer wall time uses DST offset (EDT = UTC-4)", () => {
  const d = zonedWallTimeToUTC(2023, 7, 4, 12, 0, "America/New_York");
  assert.equal(d.getUTCHours(), 16);
});

test("winter wall time uses standard offset (EST = UTC-5)", () => {
  const d = zonedWallTimeToUTC(2023, 1, 15, 12, 0, "America/New_York");
  assert.equal(d.getUTCHours(), 17);
});

test("half-hour zone (India = UTC+5:30)", () => {
  const d = zonedWallTimeToUTC(2023, 1, 15, 12, 0, "Asia/Kolkata");
  assert.equal(d.getUTCHours(), 6);
  assert.equal(d.getUTCMinutes(), 30);
});

test("DST spring-forward morning resolves to correct UTC (EDT)", () => {
  // 2023-03-12 clocks jump 2:00->3:00; 03:00 local is EDT (UTC-4) -> 07:00 UTC
  const d = zonedWallTimeToUTC(2023, 3, 12, 3, 0, "America/New_York");
  assert.equal(d.getUTCHours(), 7);
});

test("DST spring-forward later morning (EDT)", () => {
  const d = zonedWallTimeToUTC(2023, 3, 12, 5, 0, "America/New_York");
  assert.equal(d.getUTCHours(), 9);
});

test("DST fall-back morning resolves to correct UTC (EST)", () => {
  // 2023-11-05 clocks fall 2:00->1:00; 03:00 local is EST (UTC-5) -> 08:00 UTC
  const d = zonedWallTimeToUTC(2023, 11, 5, 3, 0, "America/New_York");
  assert.equal(d.getUTCHours(), 8);
});

test("years 1-99 stay themselves (no legacy 19xx remap)", () => {
  // Date.UTC(1, ...) means 1901; the node advertises years 1-9999, so year 1
  // must come out as year 1.
  const d = zonedWallTimeToUTC(1, 6, 21, 12, 0, "UTC");
  assert.equal(d.getUTCFullYear(), 1);
  assert.equal(d.getUTCHours(), 12);
  const d99 = zonedWallTimeToUTC(99, 1, 15, 6, 30, "UTC");
  assert.equal(d99.getUTCFullYear(), 99);
  assert.equal(d99.getUTCMinutes(), 30);
});
