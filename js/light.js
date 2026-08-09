// Pure light-position math, kept free of any ComfyUI (`app`) import so it stays
// unit-testable under `node --test`.
export function lightPosition(azDeg, elDeg, r = 10) {
  const az = (azDeg * Math.PI) / 180;
  const el = (elDeg * Math.PI) / 180;
  return {
    x: r * Math.cos(el) * Math.sin(az),
    y: r * Math.sin(el),
    z: r * Math.cos(el) * Math.cos(az),
  };
}
