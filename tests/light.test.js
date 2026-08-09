import { test } from "node:test";
import assert from "node:assert/strict";
import { lightPosition } from "../js/light.js";

test("noon-ish high sun sits mostly above (+Y dominates)", () => {
  const p = lightPosition(0, 90);
  assert.ok(Math.abs(p.y - 10) < 1e-9);
  assert.ok(Math.abs(p.x) < 1e-9 && Math.abs(p.z) < 1e-9);
});

test("azimuth 90 (east) puts the light on +X", () => {
  const p = lightPosition(90, 0);
  assert.ok(p.x > 9.9, `x=${p.x}`);
  assert.ok(Math.abs(p.z) < 1e-9, `z=${p.z}`);
});

test("radius scales the vector", () => {
  const p = lightPosition(0, 0, 5);
  assert.ok(Math.abs(p.z - 5) < 1e-9, `z=${p.z}`);
});
