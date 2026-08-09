import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { loadCities, nearestCity } from "./geo.js";
import { computeSunAngles } from "./sun.js";
import { nearestCityLabel } from "./status.js";
import { attachPreview, hideWidget, hookWidgets } from "./preview.js";
import { parseExif } from "./exif.js";
import { parseImageValue, cityStringFor, photoStatus, normalizeParsed } from "./photo.js";
import { getVal, getStr, isLinkedToSource, connectedWidgetValue } from "./widgets.js";

// If a positioning input is connected in the graph, read the driven value
// client-side (see connectedWidgetValue in widgets.js — resolves in the node's
// own graph so subgraphs work, and by origin output slot so cross-wired
// multi-output sources read the right widget). A connected input wins over the
// on-node control; this is what makes params graph-driveable.
function connectedInputValue(node, name) {
  return connectedWidgetValue(node, name, app.graph);
}

// While an input is connected, its on-node field mirrors the driven value —
// otherwise the field keeps showing a stale local number (e.g. 0.0000 under a
// driven latitude). Direct value write, no callback: the widget callbacks are
// wrapped to re-render, and mirroring happens DURING a render.
function mirrorWidget(node, name, v) {
  const w = node.widgets?.find((x) => x.name === name);
  if (!w || w.value === v) return;
  w.value = v;
  node.setDirtyCanvas?.(true, false);
}

// Shared value resolvers: a connected input wins over the widget (and mirrors
// into it); else the widget drives, as before. An unparseable driven number
// (e.g. a mis-wired string) falls back to the widget instead of going NaN.
function makeResolvers(node) {
  const num = (name, d) => {
    const c = connectedInputValue(node, name);
    if (c != null) {
      const v = parseFloat(c);
      if (Number.isFinite(v)) {
        mirrorWidget(node, name, v);
        return v;
      }
    }
    return getVal(node, name, d);
  };
  const str = (name, d) => {
    const c = connectedInputValue(node, name);
    if (c != null) {
      const v = String(c);
      mirrorWidget(node, name, v);
      return v;
    }
    return getStr(node, name, d);
  };
  return { num, str };
}

// A connected value only re-renders on connect and at queue time. So dragging
// the SOURCE's slider (e.g. a Primitive feeding intensity/heading) wouldn't move
// the preview — it looked dead even though the queued output was correct. Wrap
// the source node's widget callbacks (once) so changing its value re-renders
// the sphere-light nodes wired to it. Scoping by live links (not "all sphere
// nodes") also makes a stale hook inert after a disconnect, and the debounced
// scheduler keeps a keystroke burst from doing a full render per character.
function hookSourceWidgets(src) {
  if (!src || src._slSourceHooked || !src.widgets) return;
  src._slSourceHooked = true;
  for (const w of src.widgets) {
    const orig = w.callback;
    w.callback = function (...args) {
      const r = orig ? orig.apply(this, args) : undefined;
      // The sphere nodes wired to this source live in the SAME graph as it
      // (links never cross a subgraph boundary), so scan src's own graph.
      const g = src.graph || app.graph;
      for (const n of g?.nodes || g?._nodes || []) {
        if (typeof n._slScheduleRender !== "function") continue;
        if (isLinkedToSource(n, src.id, g.links)) {
          try { n._slScheduleRender(); } catch (e) {}
        }
      }
      return r;
    };
  }
}

// Hook the source behind every currently-connected positioning input (used on
// reload, where connections exist before onConnectionsChange ever fires).
function hookConnectedSources(node) {
  const g = node.graph || app.graph;
  for (const inp of node.inputs || []) {
    if (inp.link == null) continue;
    const link = g?.links?.[inp.link];
    if (link) hookSourceWidgets(g.getNodeById?.(link.origin_id));
  }
}

// attachPreview() pushes the `_3d_preview` widget onto node.widgets before the
// status widget below is created. TOP_WIDGETS_H() (preview.js) sums row
// heights only up to the first `_3d_preview` it finds, and LiteGraph draws
// widgets in array order — so a widget appended *after* `_3d_preview` is both
// left out of the height sum and drawn below/behind the preview square.
// Reinsert each new widget immediately before `_3d_preview` so it lands in the
// top (input) area.
function moveBeforePreview(node, widget) {
  const ws = node.widgets;
  if (!ws || !widget) return;
  const pi = ws.findIndex((w) => w.name === "_3d_preview");
  const wi = ws.indexOf(widget);
  if (pi > -1 && wi > -1 && wi > pi) {
    ws.splice(wi, 1);
    ws.splice(pi, 0, widget);
  }
}

// A tiny read-only status line (DOM widget, not serialized).
function addStatus(node) {
  const el = document.createElement("div");
  Object.assign(el.style, {
    width: "100%", boxSizing: "border-box", padding: "2px 12px",
    font: "12px sans-serif", color: "var(--descrip-text, #aaa)",
    whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
  });
  const w = node.addDOMWidget?.("status", "status", el, {
    serialize: false, margin: 0,
    getHeight: () => 18, getMinHeight: () => 18, getMaxHeight: () => 18,
  });
  if (w) { w._slRowH = 18; moveBeforePreview(node, w); }
  return (text) => { el.textContent = text || ""; };
}

async function setupManual(node) {
  const { num } = makeResolvers(node);
  const getAngles = () => {
    return {
      az: num("rotation", 0),
      el: num("elevation", 45),
      intensity: num("intensity", 1.5),
    };
  };
  const { render, scheduleRender, TOP_WIDGETS_H } = await attachPreview(node, getAngles);
  node._slRender = render;   // queue-time refresh + connection-change re-render
  node._slScheduleRender = scheduleRender;   // debounced: live source-widget changes

  setTimeout(() => {
    hideWidget(node, "render_b64");
    hookWidgets(node, ["rotation", "elevation", "intensity"], scheduleRender);
    render();
    const w = Math.max(node.size?.[0] || 300, 280);
    node.setSize([w, TOP_WIDGETS_H() + (w - 24) + 16]);
  }, 100);
  setTimeout(() => {
    hideWidget(node, "render_b64");
    const w = Math.max(node.size?.[0] || 300, 280);
    node.setSize([w, TOP_WIDGETS_H() + (w - 24) + 16]);
  }, 700);
}

async function setupSun(node, mode) {
  let cities = null;
  let citiesFailed = false;
  let setStatus = () => {};

  const { num, str } = makeResolvers(node);
  const getAngles = () => {
    const intensity = num("intensity", 1.5);
    // Until the city dataset arrives the render uses fixed fallback angles —
    // say so instead of showing a valid-looking sphere with a blank status.
    if (!cities) {
      setStatus(citiesFailed ? "⚠ city data failed to load — using fallback light"
                             : "⏳ loading city data…");
      return { az: 0, el: 45, intensity };
    }
    const heading = num("heading", 0);
    node._slHeading = heading;   // preview.js draws the passive compass overlay
    const base = {
      year: num("year", 2025), month: num("month", 6),
      day: num("day", 21), hour: num("hour", 12),
      minute: num("minute", 0), heading,
    };
    let params;
    if (mode === "city") {
      params = { ...base, location: str("city", "") };
    } else {
      const lat = num("latitude", 0), lng = num("longitude", 0);
      params = { ...base, lat, lng };
    }
    const r = computeSunAngles(params, cities);

    let statusText = r.label || "";
    if (mode === "coords" && !r.error) {
      // Prefer the "near <city>" label over sun.js's raw "lat, lng (tz)" string.
      // computeSunAngles doesn't return the tz it resolved, so look it up the
      // same way it does internally (nearest listed city) instead of passing
      // `tz: undefined` into nearestCityLabel — that would render "· undefined".
      const rec = nearestCity(params.lat, params.lng, cities);
      const tz = rec ? rec.tz : "UTC";
      const near = nearestCityLabel({ lat: params.lat, lng: params.lng, tz }, cities);
      statusText = near.label + (r.belowHorizon ? ` — sun below horizon` : "");
    }
    setStatus(statusText);

    if (r.error) return { az: 0, el: 45, intensity };
    return { az: r.rotation, el: r.elevation, intensity };
  };

  const { render, scheduleRender, TOP_WIDGETS_H } = await attachPreview(node, getAngles);
  node._slRender = render;   // queue-time refresh + connection-change re-render
  node._slScheduleRender = scheduleRender;   // debounced: live source-widget changes

  loadCities().then((c) => { cities = c; render(); })
              .catch((e) => {
                citiesFailed = true;
                setStatus("⚠ city data failed to load — using fallback light");
                console.warn("[SphereLight] cities.json failed:", e);
              });

  const watched = mode === "city"
    ? ["intensity", "city", "year", "month", "day", "hour", "minute", "heading"]
    : ["intensity", "latitude", "longitude", "year", "month", "day", "hour", "minute", "heading"];

  setTimeout(() => {
    hideWidget(node, "render_b64");
    hookWidgets(node, watched, scheduleRender);
    setStatus = addStatus(node);
    render();
    const w = Math.max(node.size?.[0] || 320, 300);
    node.setSize([w, TOP_WIDGETS_H() + (w - 24) + 16]);
  }, 100);
  setTimeout(() => {
    hideWidget(node, "render_b64");
    const w = Math.max(node.size?.[0] || 320, 300);
    node.setSize([w, TOP_WIDGETS_H() + (w - 24) + 16]);
  }, 700);
}

async function setupPhotoExif(node) {
  let setStatus = () => {};

  // Must mirror the INPUT_TYPES defaults in __init__.py: picking a new photo
  // resets every metadata widget to its server-declared default first, so a
  // photo missing a tag shows the default — never the PREVIOUS photo's value
  // silently feeding connected Sun nodes. Still hand-editable afterwards.
  const METADATA_DEFAULTS = {
    latitude: 0, longitude: 0, city: "",
    year: 2025, month: 6, day: 21, hour: 12, minute: 0, heading: 0,
  };

  // Set through the widget callback so hookSourceWidgets' wrapper fires and
  // any connected sphere node re-renders live.
  const set = (name, v) => {
    const w = node.widgets?.find((x) => x.name === name);
    if (!w) return;
    w.value = v;
    try { w.callback?.(v, app.canvas, node); } catch (e) {}
  };

  // Fetch the picked photo, parse its EXIF, and bake the values into this
  // node's widgets. The widget names deliberately match the Sun nodes' input
  // names: connectedInputValue() on a sphere node resolves a connection by
  // looking up the identically named widget here.
  // Two rapid image picks interleave two async fills; the sequence token makes
  // a superseded fill drop out instead of stamping stale values last.
  let fillSeq = 0;
  const fill = async () => {
    const value = getStr(node, "image", "");
    if (!value) return;
    const seq = ++fillSeq;
    // Reset synchronously (before any await) so two rapid picks apply their
    // resets in pick order and the seq guard alone decides whose EXIF lands.
    for (const [name, v] of Object.entries(METADATA_DEFAULTS)) set(name, v);
    let parsed;
    try {
      const { filename, subfolder, type } = parseImageValue(value);
      const res = await fetch(api.apiURL(
        `/view?filename=${encodeURIComponent(filename)}` +
        `&subfolder=${encodeURIComponent(subfolder)}&type=${type}`));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // normalizeParsed range-checks what came out of the file: bad GPS is
      // treated as no-GPS, headings wrap into [0,360), invalid dates drop.
      parsed = normalizeParsed(parseExif(await res.arrayBuffer()));
    } catch (e) {
      if (seq !== fillSeq) return;
      console.warn("[SphereLight] EXIF read failed:", e);
      setStatus("⚠ couldn't read the image file");
      return;
    }
    if (seq !== fillSeq) return;
    let cityLabel = "";
    if (parsed.lat != null && parsed.lng != null) {
      set("latitude", Math.round(parsed.lat * 10000) / 10000);
      set("longitude", Math.round(parsed.lng * 10000) / 10000);
      try {
        cityLabel = cityStringFor(parsed.lat, parsed.lng, await loadCities());
        if (seq !== fillSeq) return;
        if (cityLabel) set("city", cityLabel);
      } catch (e) {
        console.warn("[SphereLight] cities.json failed:", e);
      }
      if (seq !== fillSeq) return;
    }
    if (parsed.heading != null) set("heading", Math.round(parsed.heading * 100) / 100);
    if (parsed.date != null) {
      set("year", parsed.date.year);
      set("month", parsed.date.month);
      set("day", parsed.date.day);
      set("hour", parsed.date.hour);
      set("minute", parsed.date.minute);
    }
    setStatus(photoStatus(parsed, cityLabel));
    node.setDirtyCanvas?.(true, true);
  };

  setTimeout(() => {
    setStatus = addStatus(node);
    // Parse when the photo changes (upload or picking another file).
    const w = node.widgets?.find((x) => x.name === "image");
    if (w) {
      const orig = w.callback;
      w.callback = function (...args) {
        const r = orig ? orig.apply(this, args) : undefined;
        fill();
        return r;
      };
    }
    // A BRAND-NEW node also parses its initial (default) image, so the photo
    // it displays and the metadata it emits agree from the start. A node
    // materialized from a saved workflow or paste got onConfigure (see the
    // extension registration) — its widgets carry serialized, possibly
    // hand-corrected values a re-parse would clobber, so it is skipped.
    // Configure fires synchronously right after construction, well before
    // this 100 ms timer, so the flag is settled by now.
    if (!node._slConfigured) fill();
  }, 100);
}

app.registerExtension({
  name: "SphereLight.Nodes",
  async nodeCreated(node) {
    let setup;
    if (node.comfyClass === "SphereLightManualNode") setup = setupManual(node);
    else if (node.comfyClass === "SphereLightSunCityNode") setup = setupSun(node, "city");
    else if (node.comfyClass === "SphereLightSunCoordsNode") setup = setupSun(node, "coords");
    else if (node.comfyClass === "SphereLightPhotoExifNode") setup = setupPhotoExif(node);
    else return;
    // Re-render when an input is connected/disconnected so the preview (and
    // render_b64) immediately reflects a newly driven — or released — value, and
    // start tracking the newly-connected source's live value changes.
    const origOCC = node.onConnectionsChange;
    node.onConnectionsChange = function (type, slotIndex, isConnected, linkInfo, ioSlot) {
      origOCC?.apply(this, arguments);
      if (node._slRender) setTimeout(() => node._slRender(), 0);
      if (isConnected && type === LiteGraph.INPUT && linkInfo) {
        const g = node.graph || app.graph;
        hookSourceWidgets(g?.getNodeById?.(linkInfo.origin_id));
      }
    };
    // Existing connections (e.g. after a reload) predate the handler above.
    // onConfigure is the deterministic signal (it fires when a workflow is
    // loaded into the node); the deferral lets the whole graph finish
    // configuring so every link resolves. The timeout stays as a fallback for
    // paths that never configure (hookSourceWidgets is idempotent).
    // The flag also distinguishes a loaded/pasted node (serialized widget
    // values, possibly hand-corrected) from a brand-new one — setupPhotoExif
    // parses the initial image only when it never fires.
    const origConfigure = node.onConfigure;
    node.onConfigure = function () {
      this._slConfigured = true;
      origConfigure?.apply(this, arguments);
      setTimeout(() => hookConnectedSources(node), 0);
    };
    setTimeout(() => hookConnectedSources(node), 900);
    return setup;
  },
});
