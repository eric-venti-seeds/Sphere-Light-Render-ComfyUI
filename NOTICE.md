# NOTICE

Sphere-Light-Render-ComfyUI is released under the [MIT License](LICENSE). This
file records who wrote what, and the terms of the third-party data and
libraries the project bundles.

## Authorship

- **[eric-venti-seeds](https://github.com/eric-venti-seeds)** — the original
  concept and implementation (everything up to and including commit `6e40c7a`,
  2026-06-29): the `SphereLightNode` with manual `rotation` / `elevation` /
  `intensity`, and the in-node Three.js sphere preview whose render is passed
  to the server as the LoRA's reference image.
- **[Christopher Connock](https://github.com/ChristopherConnock)** — the
  sun-position, location, EXIF and graph-driven feature set: NOAA solar
  position math, DST-aware wall-time→UTC conversion, the bundled GeoNames city
  lookup, the split Manual / Sun (City) / Sun (Coordinates) / Photo (EXIF)
  nodes, the browser-side EXIF parser, graph-driven inputs, and the test suite
  and CI. Developed as
  [Sphere-Light-Render-Sundial-ComfyUI](https://github.com/ChristopherConnock/Sphere-Light-Render-Sundial-ComfyUI)
  and merged here in
  [#4](https://github.com/eric-venti-seeds/Sphere-Light-Render-ComfyUI/pull/4)
  (2026-08-09). [CHANGELOG.md](CHANGELOG.md) lists those changes in order.

Both authors' contributions are covered by the MIT License in
[LICENSE](LICENSE).

## Third-party components

- **[Three.js](https://threejs.org/)** r128, vendored as `js/three.module.js` —
  MIT License, copyright 2010–2021 Three.js Authors (license header retained
  in the file).
- **[GeoNames](https://www.geonames.org/)** geographical data (`cities15000`,
  `admin1CodesASCII`, `countryInfo`), used to build `js/cities.json` — licensed
  under [Creative Commons Attribution 4.0](https://creativecommons.org/licenses/by/4.0/).
- The demo photo `docs/media/penn-soccer-pickup-shadows.jpg`, used in the
  README to illustrate the EXIF workflow — photographed by Christopher Connock
  and included under the repository's MIT License.
