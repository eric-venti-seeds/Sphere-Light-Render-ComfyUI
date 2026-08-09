# Input-Driven Sphere Light — Design

- **Date:** 2026-07-08
- **Status:** Approved (design), pending implementation plan
- **Component:** Sphere-Light-Render-ComfyUI custom nodes
- **Builds on:** `2026-07-07-split-light-nodes-design.md` (the three flat nodes)

## Goal

Make every positioning parameter of the three light nodes **graph-driveable**. A
value can be set by its on-node UI control (slider, number field, city search,
compass) **or** driven by an upstream graph connection — and **the connection
wins when present**. The compass becomes just one optional driver for `heading`,
not "the" heading control.

When any positioning input is connected, the node renders the sphere with the
**graph-resolved** values and returns an image that matches those values **on the
same run**, via a synchronous browser round-trip.

## Non-negotiable constraints

- **Rendering stays client-side (Three.js).** A Python/server re-render is off the
  table — the LoRA was trained on the exact Three.js output, so only that
  renderer is acceptable. (A headless-GL server render was considered and
  rejected for cross-platform fragility; the user chose browser-open.)
- **Works only with a ComfyUI browser tab connected.** A headless/API run driving
  an input has no browser to render → documented fallback to gray.
- **The interactive (nothing-connected) path is unchanged and fast** — no
  round-trip. The three nodes from the prior spec are *retrofitted*, not replaced.
- **Reuse** `js/preview.js` (render engine), `js/sun.js` (astronomy), `compass.js`,
  `location_search.js`. Astronomy/timezone/dataset unchanged.

## Model — inputs win when connected; else UI; connected → reflect

Every positioning param is *already* an `INPUT_TYPES` field (already a widget,
already convertible to an input). This work adds the three things that make
driving actually function:

1. **The round-trip** so a connected value affects the rendered output.
2. **Reflect-on-connect** — a driven control becomes a read-only mirror of the
   resolved value, updated after each run (the compass needle spins to the driven
   heading; lat/lon/date fields show the driven values).
3. **Fallback** when no browser can render.

Per parameter:
- **Not connected** → its UI control drives, exactly as today.
- **Connected** → the graph value wins; the UI control reflects it (read-only).

## Two execution modes (decided per run, per node)

- **Interactive mode** — *no* positioning input is connected. Unchanged from
  today: the browser renders from widget values into the hidden `render_b64`, and
  `execute()` calls `decode_render_b64(render_b64)`. No round-trip.
- **Driven mode** — *≥1* positioning input is connected. Synchronous round-trip
  (below).

`execute()` decides the mode by inspecting the `PROMPT` (hidden input) for its own
`UNIQUE_ID`: an input encoded as `[upstream_id, slot]` is connected; a literal is a
widget value. If none of the positioning inputs are connected → interactive mode.

## The synchronous round-trip (driven mode)

One queued execution, when ≥1 input is connected:

1. `execute()` receives every param already resolved by ComfyUI (connected →
   upstream value; else the widget value), plus hidden `UNIQUE_ID` and `PROMPT`.
2. It builds `{ node_id, run_token, params }` and `PromptServer.instance.send_sync(
   "sphere_light.render", payload)` (broadcast; the frontend filters by `node_id`).
   `run_token` is a fresh per-run id.
3. `execute()` blocks on a per-`(node_id, run_token)` `threading.Event`, waiting for
   the browser to return the rendered PNG. The wait is **event-driven with layered
   failure handling** (see below).
4. **Browser** (`js/driven.js`): a listener matches the event to its node by
   `node_id`, **applies the resolved params to that node's controls** (this is the
   *reflect* — dial spins, fields update), resolves the scene angles from those
   pushed params through the node's **existing** angle path (`computeSunAngles` for
   the sun nodes, direct rotation/elevation for Manual — the same `getAngles` logic,
   just fed the pushed params instead of widget reads), renders the Three.js sphere
   off-screen, reads the `dataURL`, and POSTs `{ node_id, run_token, image }` to a
   custom route `/sphere_light/result`.
5. The route stores the image under `(node_id, run_token)` and `event.set()`s.
6. `execute()` wakes, decodes the returned PNG via the existing
   `decode_render_b64` path, and returns the IMAGE. The output matches the driven
   inputs on this run.

## Components (small, isolated, testable)

- **`__init__.py` — `RenderBridge`** *(new, module-level)*: owns the whole
  server side of the round-trip, isolated from the node classes.
  - Registers the aiohttp route `POST /sphere_light/result` once (idempotent).
  - A registry mapping `(node_id, run_token) → {event, image}`.
  - `request_render(node_id, params) -> tensor`: mints a `run_token`, registers the
    event, `send_sync`s the payload, waits (layered), then returns the decoded
    tensor or the fallback.
  - Pure helpers (unit-testable): `is_driven(prompt, node_id, param_names) -> bool`
    (connected-input detection) and `build_payload(node_id, run_token, params)`.
- **`__init__.py` — the node classes**: add hidden inputs
  `"hidden": {"node_id": "UNIQUE_ID", "prompt": "PROMPT"}`; `execute()` branches:
  driven → `RenderBridge.request_render(...)`; interactive → `decode_render_b64(
  render_b64)` (today's path). Visible inputs unchanged.
- **`js/driven.js`** *(new)*: `api.addEventListener("sphere_light.render", …)`.
  For the matching node: apply params to its widgets/compass (reflect), resolve
  angles via the node's shared angle path, request an off-screen render, POST the
  result.
- **`js/nodes.js` / `js/preview.js`**: refactor the per-node `getAngles` to accept
  an optional explicit param set — `getAngles()` reads widgets (interactive, today);
  `getAngles(pushedParams)` uses the pushed values. This shares the astronomy
  (`computeSunAngles`) between both modes with no duplication. `attachPreview` then
  exposes `renderWith(params) = renderLight(ctx, getAngles(params))` for `driven.js`.
  Additive; the existing `render()`/`scheduleRender()` (widget-driven) are unchanged.
- **`js/nodes.js`**: wire `driven.js`'s reflect to the node's compass/search/native
  widgets (`compass.setValue`, set lat/lon/date/city widget values), and keep the
  driven controls visible-and-reflecting rather than letting convert-to-input hide
  them (follow the `Preview3DAdvanced` approach of keeping the viewport and
  applying the input).

## Error handling — layered, event-driven (no polling, no arbitrary delay)

`event.wait(timeout)` wakes the instant it's `set()`, so the success path has zero
added latency. The failure paths are made event-driven so the fixed timeout is a
rare last resort:

1. **Success** → browser POST → route `set()`s → `execute()` wakes immediately.
2. **No client / disconnect** → before waiting, check that a client is connected
   (PromptServer tracks websocket sids); wake on a client-disconnect event to
   **fail fast** instead of waiting out the clock.
3. **Cancel** → honor ComfyUI's interrupt so a stuck render is killable.
4. **Backstop timeout** (generous, e.g. 30 s) only for a frozen/backgrounded tab
   that neither posts nor disconnects.
5. **Fallback** on any failure path: return the last widget-rendered `render_b64`
   if present, else the gray image (`decode_render_b64("")`); log which fired.
6. *(Optional nicety)* a quick browser **ack** on receipt distinguishes "no
   browser" (instant fail) from "browser is rendering" (keep waiting) without
   leaning on the timeout.

**Concurrency:** everything is keyed by `(node_id, run_token)`, so overlapping
nodes, re-queues, and duplicate responses (same workflow open in two tabs) can't
cross results — the first valid image for a token wins; stale/unknown tokens are
dropped.

## Reflect behavior (UI)

- Connected param → its control mirrors the resolved value after each run
  (read-only). Compass needle spins to the driven heading; lat/lon/date show driven
  values; the city field shows the resolved label.
- Not connected → editable and drives, as today.
- `driven.js` applies the pushed params to controls in step 4 (before rendering),
  so the mirror is always consistent with the image just produced.

## Scope

**In:** retrofit the three nodes with driven-mode round-trip + reflect + fallback;
`RenderBridge` (route/event/`send_sync`/detection); `js/driven.js`; the
`renderWith(params)` hook in `preview.js`; hidden `UNIQUE_ID`/`PROMPT` inputs;
tests.

**Out:** headless-GL server rendering; any astronomy/timezone/dataset change; any
change to the interactive (non-driven) path; new node classes; making the compass
anything other than one driver of `heading`.

## Testing

- **`RenderBridge` (Python, standalone-script pattern with stubbed `torch` +
  stubbed `send_sync`/route):** `is_driven` from a `PROMPT` fixture (connected vs
  literal); success (test drives the Event, asserts the right image comes back);
  fast-fail when no client; backstop timeout returns fallback; concurrency keying
  (token A's image never returned for token B); fallback returns gray/last frame.
- **Pure helpers:** `is_driven`, `build_payload` — direct unit tests.
- **JS (`node:test`):** any DOM-free part of `driven.js` (e.g. payload → widget-value
  mapping) unit-tested; the render+POST path is manual.
- **Manual ComfyUI gate (browser open):** wire a Primitive to `heading` → queue →
  compass reflects and the output image matches the driven heading; disconnect →
  interactive again; close the tab mid-run → falls back to gray and the **queue
  does not hang**; auto-queue an incrementing `hour`/`heading` → each frame's image
  is correct (no one-hop lag).

## Risks / trade-offs

- **Blocking `execute()` on a browser round-trip** — mitigated by the layered
  event-driven failure handling + backstop; the queue never hangs.
- **convert-to-input hiding vs keeping the control visible-and-reflecting** — the
  fiddly part; follow the `Preview3DAdvanced`/`PreviewUI3D` pattern; contained to
  `driven.js`/`nodes.js`.
- **Browser-only** — documented; headless driven → gray.
- **Per-driven-run latency** (one round-trip) — the render is fast; acceptable for
  browser-interactive and auto-queue animation.

## Reference implementation to mine

- Core `Preview3DAdvanced` (PR Comfy-Org/ComfyUI#14175) + its frontend PR (#12527):
  "inputs win when connected," resolved values forwarded to the viewport via an
  `onExecuted`/`PreviewUI3D` side-effect. Closest existing precedent.
- Comms: `PromptServer.instance.send_sync(event, data)` + `api.addEventListener`;
  `UNIQUE_ID`/`PROMPT` hidden inputs. (ComfyUI docs: messages, JS objects.)
