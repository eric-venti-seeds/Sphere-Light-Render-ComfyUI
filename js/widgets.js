// Pure widget/graph helpers for nodes.js, kept free of any ComfyUI (`app`)
// import so they stay unit-testable under `node --test` (same convention as
// light.js). Unit tests: tests/widgets.test.js.

// The named widget's value as a number; the default covers a missing widget
// AND an unparseable value — a widget holding garbage must not leak NaN into
// the light math (lightPosition(NaN) renders a black preview).
export function getVal(node, name, def) {
  const w = node.widgets?.find((w) => w.name === name);
  if (!w) return def;
  const v = parseFloat(w.value);
  return Number.isFinite(v) ? v : def;
}

export function getStr(node, name, def) {
  const w = node.widgets?.find((w) => w.name === name);
  return w ? String(w.value) : def;
}

// Follow a connected input's link to its source node and read the driven value
// client-side. `rootGraph` (app.graph) is only a fallback — the node's OWN
// graph resolves links first, because a node inside a subgraph lives in a
// child LGraph whose link/node ids are local (a same-numbered root link would
// be an unrelated connection). Returns undefined when the input isn't
// connected or the value can't be resolved in the browser (e.g. a value
// computed mid-run by an upstream node — the documented unsupported case).
//
// Widget choice, in order:
// 1. The widget named like the wired OUTPUT (link.origin_slot) — that's the
//    value the graph actually carries; on a cross-wired multi-output source
//    (Photo EXIF latitude -> longitude) the input's name would read the wrong
//    widget.
// 2. The widget named like the target input (a PrimitiveNode adopts the
//    target widget's name).
// 3. "value" (older PrimitiveNodes keep it).
// 4. A sole widget. Never "the first of several" — on the Photo (EXIF) node
//    that would silently read the image filename.
export function connectedWidgetValue(node, name, rootGraph) {
  const g = node.graph || rootGraph;
  const slot = (node.inputs || []).findIndex((s) => s.name === name);
  if (slot < 0) return undefined;
  const inp = node.inputs[slot];
  if (inp.link == null) return undefined;
  const link = g?.links?.[inp.link];
  if (!link) return undefined;
  const origin = g.getNodeById?.(link.origin_id);
  if (!origin) return undefined;
  const outName = origin.outputs?.[link.origin_slot]?.name;
  const ws = origin.widgets || [];
  const w = (outName != null ? ws.find((x) => x.name === outName) : undefined)
         || ws.find((x) => x.name === name)
         || ws.find((x) => x.name === "value")
         || (ws.length === 1 ? ws[0] : undefined);
  return w ? w.value : undefined;
}

// Whether any of the node's inputs is fed by the source node with id `srcId`.
// Used to scope live re-renders: when a source widget changes, only the
// sphere nodes actually wired to it re-render — and a node hooked once but
// since disconnected triggers nothing.
export function isLinkedToSource(node, srcId, links) {
  return (node.inputs || []).some(
    (inp) => inp.link != null && links?.[inp.link]?.origin_id === srcId
  );
}
