import { test } from "node:test";
import assert from "node:assert/strict";
import { needlePoint } from "../js/compass.js";

const close = (a, b) => Math.abs(a - b) < 1e-9;

test("heading 0 points North (up: -y in canvas space)", () => {
  const p = needlePoint(50, 50, 10, 0);
  assert.ok(close(p.x, 50) && close(p.y, 40), JSON.stringify(p));
});

test("heading 90 points East (+x)", () => {
  const p = needlePoint(50, 50, 10, 90);
  assert.ok(close(p.x, 60) && close(p.y, 50), JSON.stringify(p));
});

test("heading 180 points South (+y)", () => {
  const p = needlePoint(50, 50, 10, 180);
  assert.ok(close(p.x, 50) && close(p.y, 60), JSON.stringify(p));
});

test("heading 270 points West (-x)", () => {
  const p = needlePoint(50, 50, 10, 270);
  assert.ok(close(p.x, 40) && close(p.y, 50), JSON.stringify(p));
});
