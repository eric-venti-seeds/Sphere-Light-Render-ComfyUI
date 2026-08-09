// Passive compass indicator drawn onto the node's preview render. Purely
// visual — heading is driven by the native `heading` slider (or a connected
// input); this never handles pointer events or writes any value.

// End point of the needle for a heading in degrees (0 = North = up, clockwise;
// canvas y grows down). Exported so the geometry is unit-testable in Node.
export function needlePoint(cx, cy, r, headingDeg) {
  const a = headingDeg * Math.PI / 180;
  return { x: cx + Math.sin(a) * r, y: cy - Math.cos(a) * r };
}

// Draw a mono dark-grey compass centered at (cx, cy) with radius r on a 2D
// canvas context: cardinal letters around a large solid grey disc (no outer
// ring), with a white needle over the disc showing the heading.
export function drawCompass(ctx, cx, cy, r, headingDeg, color = "rgba(58,58,58,0.85)") {
  ctx.save();

  const font = Math.max(8, Math.round(r * 0.42));
  const letterR = r - font * 0.5;                  // glyphs end ≈ r, same footprint as before
  // Disc as large as possible: up to the letters' inner edge (cap height ≈
  // 0.72em, so half ≈ 0.36em below their centerline) minus a small margin.
  const discR = letterR - font * 0.36 - Math.max(1.5, r * 0.05);

  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(cx, cy, discR, 0, Math.PI * 2);
  ctx.fill();

  ctx.font = `bold ${font}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const [ch, deg] of [["N", 0], ["E", 90], ["S", 180], ["W", 270]]) {
    const p = needlePoint(cx, cy, letterR, deg);
    ctx.fillText(ch, p.x, p.y);
  }

  const tip = needlePoint(cx, cy, discR * 0.85, headingDeg);
  ctx.strokeStyle = "rgba(255,255,255,0.95)";
  ctx.lineWidth = Math.max(1.5, r * 0.09);
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(tip.x, tip.y);
  ctx.stroke();

  ctx.restore();
}
