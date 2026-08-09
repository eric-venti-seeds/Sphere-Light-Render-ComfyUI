import { app } from "../../scripts/app.js";
import { lightPosition } from "./light.js";
import { drawCompass } from "./compass.js";
// Vendored locally (was cdnjs) so the node works offline / air-gapped and
// isn't exposed to a third-party CDN being compromised. The ES-module build is
// imported under a module-local namespace — the old UMD bundle assigned
// `globalThis.THREE`, clobbering (or being clobbered by) any other custom
// node's Three.js, load-order dependent. ComfyUI auto-imports every .js under
// WEB_DIRECTORY; for an ES module that's harmless (the module cache dedupes).
import * as THREE from "./three.module.js";

export function buildScene() {
  const R = THREE;
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 512;

  const renderer = new R.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = R.PCFSoftShadowMap;
  renderer.setSize(512, 512, false);
  renderer.setClearColor(0x8a8a8a);
  renderer.outputEncoding = R.sRGBEncoding;

  const scene = new R.Scene();
  scene.background = new R.Color(0x8a8a8a);

  const camera = new R.PerspectiveCamera(35, 1, 0.1, 200);
  camera.position.set(0, 6, 8);
  camera.lookAt(0, -0.5, 0);

  const plane = new R.Mesh(
    new R.PlaneGeometry(100, 100),
    new R.MeshStandardMaterial({ color: 0x8a8a8a, roughness: 1, metalness: 0 })
  );
  plane.rotation.x = -Math.PI / 2;
  plane.position.y = -1;
  plane.receiveShadow = true;
  scene.add(plane);

  const sphere = new R.Mesh(
    new R.SphereGeometry(1, 64, 64),
    new R.MeshStandardMaterial({ color: 0xcccccc, roughness: 0.8, metalness: 0 })
  );
  sphere.position.y = 0;
  sphere.castShadow = true;
  sphere.receiveShadow = true;
  scene.add(sphere);

  scene.add(new R.AmbientLight(0xffffff, 0.2));

  const dirLight = new R.DirectionalLight(0xffffff, 1.5);
  dirLight.castShadow = true;
  dirLight.shadow.mapSize.width  = 2048;
  dirLight.shadow.mapSize.height = 2048;
  dirLight.shadow.camera.near   = 0.1;
  dirLight.shadow.camera.far    = 50;
  dirLight.shadow.camera.left   = -8;
  dirLight.shadow.camera.right  =  8;
  dirLight.shadow.camera.top    =  8;
  dirLight.shadow.camera.bottom = -8;
  dirLight.shadow.bias = -0.0005;
  dirLight.shadow.radius = 2;
  scene.add(dirLight);

  return { renderer, scene, camera, dirLight, canvas };
}

// One WebGL renderer/scene shared by ALL sphere-light nodes. Browsers cap
// live WebGL contexts (~8–16), so per-node renderers stopped rendering once a
// workflow held enough nodes. Each node renders its own angles into the
// shared canvas, then copies the pixels to its own 2D snapshot canvas — so
// every node still displays its own image simultaneously, but only one GL
// context ever exists (and it lives for the page, so there's nothing to free
// per node).
let _shared = null;
export function sharedScene() {
  return (_shared ??= buildScene());
}

export function renderLight(ctx, { az, el, intensity }) {
  const p = lightPosition(az, el);
  ctx.dirLight.position.set(p.x, p.y, p.z);
  ctx.dirLight.intensity = intensity;
  ctx.renderer.shadowMap.needsUpdate = true;
  ctx.renderer.render(ctx.scene, ctx.camera);
  return ctx.canvas.toDataURL("image/png");
}

export function hideWidget(node, name) {
  const w = node.widgets?.find((w) => w.name === name);
  if (!w) return;
  w.hidden = true;
  (w.options ??= {}).hidden = true;
}

export function hookWidgets(node, names, onChange) {
  for (const name of names) {
    const w = node.widgets?.find((w) => w.name === name);
    if (!w || w._slHooked) continue;
    w._slHooked = true;
    const orig = w.callback;
    w.callback = function (v, ...args) {
      orig?.call(this, v, ...args);
      onChange();
    };
  }
}

export async function attachPreview(node, getAngles) {
  const ctx = sharedScene();
  const snap = document.createElement("canvas");
  snap.width = 512;
  snap.height = 512;
  const snap2d = snap.getContext("2d");
  node._slCanvas = snap;   // this node's own copy of its last render
  node._slReady = false;

  const TOP_WIDGETS_H = () => {
    let h = LiteGraph.NODE_TITLE_HEIGHT + 8;
    for (const w of node.widgets ?? []) {
      if (w.name === "_3d_preview") break;
      if (w.hidden) continue;
      // DOM widgets size via computeLayoutSize (not computeSize); we pin their
      // row height in _slRowH so the preview below them is placed correctly.
      const wh = w._slRowH ?? (w.computeSize
        ? w.computeSize(node.size[0])[1]
        : LiteGraph.NODE_WIDGET_HEIGHT);
      h += wh + 4;
    }
    return h;
  };

  const getPreviewRect = () => {
    const nodeW  = node.size[0];
    const nodeH  = node.size[1];
    const topH   = TOP_WIDGETS_H();
    const availW = nodeW - 24;
    const availH = nodeH - topH - 16;
    const side   = Math.max(Math.min(availW, availH), 20);
    const x      = (nodeW - side) / 2;
    return { x, y: topH, side };
  };

  const previewWidget = {
    name:      "_3d_preview",
    type:      "3d_preview",
    value:     null,
    serialize: false,
    options:   { serialize: false },

    computeSize(nw) {
      const side = Math.min(nw - 24, node.size[1] - TOP_WIDGETS_H() - 16);
      return [nw - 12, Math.max(side, 20)];
    },

    draw(ctx2d, node, widget_width, y) {
      if (!node._slReady || !node._slCanvas) return;
      const { x, side } = getPreviewRect();
      ctx2d.save();
      ctx2d.beginPath();
      ctx2d.roundRect(x, y, side, side, 8);
      ctx2d.clip();
      ctx2d.drawImage(node._slCanvas, x, y, side, side);
      // Passive heading indicator in the preview's upper-right corner (sun
      // nodes set _slHeading on every render). Drawn on the node canvas, not
      // the WebGL render, so it never appears in the output image.
      if (Number.isFinite(node._slHeading)) {
        const r = Math.min(Math.max(side * 0.1, 14), 36);
        const pad = r * 0.45;
        drawCompass(ctx2d, x + side - pad - r, y + pad + r, r, node._slHeading);
      }
      ctx2d.restore();
    },
  };

  node.widgets = node.widgets || [];
  node.widgets.push(previewWidget);

  // Chain, don't clobber: core or another extension may have installed these
  // handlers first (and one installed after us must not lose our cleanup).
  const origRemoved = node.onRemoved;
  node.onRemoved = function () {
    origRemoved?.apply(this, arguments);
    // The GL renderer is shared and stays; only this node's snapshot goes.
    this._slCanvas = null;
    this._slReady = false;
  };

  const origResize = node.onResize;
  node.onResize = function (size) {
    origResize?.apply(this, arguments);
    const minH = TOP_WIDGETS_H() + 60 + 16;
    if (size[1] < minH) size[1] = minH;
    app.graph.setDirtyCanvas(true, false);
  };

  const render = () => {
    const b64 = renderLight(ctx, getAngles());
    snap2d.drawImage(ctx.canvas, 0, 0);   // keep this node's own copy
    node._slReady = true;
    const wb = node.widgets?.find((w) => w.name === "render_b64");
    if (wb) wb.value = b64;
    app.graph.setDirtyCanvas(true, false);
    previewWidget.triggerDraw?.();
  };

  // When the prompt is built for a run, re-render from the CURRENT values
  // (widgets + connected inputs) so a graph-driven value lands in the
  // serialized image for THIS run. serializeValue is the sanctioned per-widget
  // hook — the frontend awaits it in graphToPrompt (core webcam/load3d nodes
  // bake their captures the same way).
  {
    const wb = node.widgets?.find((w) => w.name === "render_b64");
    if (wb) wb.serializeValue = () => { render(); return wb.value; };
  }

  let debTimer = null;
  const scheduleRender = () => { clearTimeout(debTimer); debTimer = setTimeout(render, 80); };

  return { ctx, render, scheduleRender, TOP_WIDGETS_H, previewWidget };
}
