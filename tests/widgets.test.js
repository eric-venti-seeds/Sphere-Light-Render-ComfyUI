import { test } from "node:test";
import assert from "node:assert/strict";
import { getVal, getStr, isLinkedToSource, connectedWidgetValue } from "../js/widgets.js";

const node = (widgets) => ({ widgets });

// Minimal LGraph stand-in: links by id + node lookup.
const graphOf = (links, nodes) => ({
  links,
  getNodeById: (id) => nodes.find((n) => n.id === id),
});

test("getVal parses the named widget's value as a number", () => {
  assert.equal(getVal(node([{ name: "rotation", value: "12.5" }]), "rotation", 0), 12.5);
  assert.equal(getVal(node([{ name: "rotation", value: 90 }]), "rotation", 0), 90);
});

test("getVal falls back to the default when the widget is missing", () => {
  assert.equal(getVal(node([]), "rotation", 45), 45);
  assert.equal(getVal({}, "rotation", 45), 45);
});

test("getVal falls back to the default when the value isn't a finite number", () => {
  assert.equal(getVal(node([{ name: "rotation", value: "garbage" }]), "rotation", 45), 45);
  assert.equal(getVal(node([{ name: "rotation", value: "" }]), "rotation", 45), 45);
  assert.equal(getVal(node([{ name: "rotation", value: null }]), "rotation", 45), 45);
});

test("getStr returns the named widget's value as a string", () => {
  assert.equal(getStr(node([{ name: "city", value: "Austin, TX" }]), "city", ""), "Austin, TX");
  assert.equal(getStr(node([{ name: "city", value: 7 }]), "city", ""), "7");
});

test("getStr falls back to the default when the widget is missing", () => {
  assert.equal(getStr(node([]), "city", "London"), "London");
});

// ---- connectedWidgetValue --------------------------------------------------

test("connectedWidgetValue reads the origin widget matching the input name", () => {
  const origin = { id: 7, outputs: [{ name: "FLOAT" }],
                   widgets: [{ name: "heading", value: 214.5 }, { name: "other", value: 1 }] };
  const root = graphOf({ 3: { origin_id: 7, origin_slot: 0 } }, [origin]);
  const target = { inputs: [{ name: "heading", link: 3 }] };
  assert.equal(connectedWidgetValue(target, "heading", root), 214.5);
});

test("connectedWidgetValue prefers the wired OUTPUT's widget over the input's name", () => {
  // Cross-wired: the origin's `latitude` output feeds the target's `longitude`
  // input. The value that flows through the graph is latitude's — matching by
  // the target input's name would silently read the wrong widget.
  const origin = { id: 7,
    outputs: [{ name: "latitude" }, { name: "longitude" }],
    widgets: [{ name: "latitude", value: 48.85 }, { name: "longitude", value: 2.29 }] };
  const root = graphOf({ 3: { origin_id: 7, origin_slot: 0 } }, [origin]);
  const target = { inputs: [{ name: "longitude", link: 3 }] };
  assert.equal(connectedWidgetValue(target, "longitude", root), 48.85);
});

test("connectedWidgetValue resolves in the node's own graph, not the root", () => {
  // Subgraphs get their own LGraph with local link/node ids; a same-numbered
  // link in the root graph must not win.
  const subOrigin  = { id: 7, outputs: [{ name: "value" }], widgets: [{ name: "value", value: "sub" }] };
  const rootOrigin = { id: 9, outputs: [{ name: "value" }], widgets: [{ name: "value", value: "root" }] };
  const sub  = graphOf({ 3: { origin_id: 7, origin_slot: 0 } }, [subOrigin]);
  const root = graphOf({ 3: { origin_id: 9, origin_slot: 0 } }, [rootOrigin]);
  const target = { graph: sub, inputs: [{ name: "city", link: 3 }] };
  assert.equal(connectedWidgetValue(target, "city", root), "sub");
});

test("connectedWidgetValue falls back to 'value' then a sole widget (Primitive-style)", () => {
  const primitive = { id: 7, outputs: [{ name: "INT" }], widgets: [{ name: "value", value: 12 }] };
  const root = graphOf({ 3: { origin_id: 7, origin_slot: 0 } }, [primitive]);
  assert.equal(connectedWidgetValue({ inputs: [{ name: "year", link: 3 }] }, "year", root), 12);
  const soleWidget = { id: 8, outputs: [{ name: "INT" }], widgets: [{ name: "number", value: 6 }] };
  const root2 = graphOf({ 4: { origin_id: 8, origin_slot: 0 } }, [soleWidget]);
  assert.equal(connectedWidgetValue({ inputs: [{ name: "month", link: 4 }] }, "month", root2), 6);
});

test("connectedWidgetValue is undefined when unlinked, unresolvable, or ambiguous", () => {
  const root = graphOf({}, []);
  assert.equal(connectedWidgetValue({ inputs: [] }, "heading", root), undefined);
  assert.equal(connectedWidgetValue({ inputs: [{ name: "heading", link: null }] }, "heading", root), undefined);
  assert.equal(connectedWidgetValue({ inputs: [{ name: "heading", link: 3 }] }, "heading", root), undefined);
  // Multi-widget origin with no name match: never guess "the first widget".
  const multi = { id: 7, outputs: [{ name: "IMAGE" }],
                  widgets: [{ name: "image", value: "a.jpg" }, { name: "x", value: 1 }] };
  const root2 = graphOf({ 3: { origin_id: 7, origin_slot: 0 } }, [multi]);
  assert.equal(connectedWidgetValue({ inputs: [{ name: "rotation", link: 3 }] }, "rotation", root2), undefined);
});

test("isLinkedToSource is true only for nodes wired to that source", () => {
  const links = { 5: { origin_id: 42 }, 6: { origin_id: 99 } };
  const wired    = { inputs: [{ name: "heading", link: 5 }] };
  const other    = { inputs: [{ name: "heading", link: 6 }] };
  const unwired  = { inputs: [{ name: "heading", link: null }] };
  const noInputs = {};
  assert.equal(isLinkedToSource(wired, 42, links), true);
  assert.equal(isLinkedToSource(other, 42, links), false);
  assert.equal(isLinkedToSource(unwired, 42, links), false);
  assert.equal(isLinkedToSource(noInputs, 42, links), false);
  assert.equal(isLinkedToSource(wired, 42, undefined), false);
});
