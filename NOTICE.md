# NOTICE

This repository is an independently maintained continuation of
[eric-venti-seeds/Sphere-Light-Render-ComfyUI](https://github.com/eric-venti-seeds/Sphere-Light-Render-ComfyUI).
The original concept, the original node implementation, and the companion
[Sun-Direction LoRA](https://huggingface.co/eric-venti-seeds/Sun-Direction-Lora-Flux2Klein9B)
are the work of **eric-venti-seeds**.

## License status

- **Original upstream code** (everything up to and including upstream commit
  `6e40c7a`, 2026-06-29): the upstream repository does not currently declare a
  license, which by default means all rights are reserved by its author. This
  fork exists and is shared on GitHub under the fork provisions of the
  [GitHub Terms of Service](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service#5-license-grant-to-other-users).
  A request to add an open-source license is open upstream
  ([issue #3](https://github.com/eric-venti-seeds/Sphere-Light-Render-ComfyUI/issues/3));
  if one is granted, this notice will be updated to reflect it.
- **This fork's contributions** (all changes after `6e40c7a` — see
  [CHANGELOG.md](CHANGELOG.md) for the full list): released under the
  [MIT License](LICENSE), copyright Christopher Connock.
- The `license` field in `pyproject.toml` points at that MIT LICENSE and, like
  it, covers this fork's contributions only — any upstream-derived portions
  remain governed by the status described above.

## Third-party components

- **[Three.js](https://threejs.org/)** r128, vendored as `js/three.module.js` —
  MIT License, copyright 2010–2021 Three.js Authors (license header retained
  in the file).
- **[GeoNames](https://www.geonames.org/)** geographical data (`cities15000`,
  `admin1CodesASCII`, `countryInfo`), used to build `js/cities.json` — licensed
  under [Creative Commons Attribution 4.0](https://creativecommons.org/licenses/by/4.0/).
