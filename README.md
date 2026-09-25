<h1><img src="apps/www/public/favicon.svg" width="28" height="28" alt="Ortho Earth logo"> Ortho Earth</h1>

A serverless WebGPU/GL2 orthographic map engine and GIS workstation, built from scratch — zero dependencies, no tile servers. Runs entirely in the browser.

<img src="assets/hero.png" width="600" alt="Ortho Earth hero">

**top page:** [www.ortho-earth.com](https://www.ortho-earth.com)

**ortho-japan (flagship 3D map):**  [www.ortho-earth.com/japan](https://www.ortho-earth.com/japan/)

**GIS-HUB(apps):**  [www.ortho-earth.com/gishub](https://www.ortho-earth.com/gishub/)

**technical documents:**  [www.ortho-earth.com/#technologies](https://www.ortho-earth.com/#technologies)

## Tests

`npm test` at the repository root runs every Node-only test suite in the monorepo (about 30 seconds, no browser or network needed).
Browser suites stay per package: `npm run verify` in `packages/globe`, `npm run verify:ui` / `verify:webgpu` / `verify:prod` in `apps/ortho-japan`,
`npm run verify:pages` in `packages/geopbf`. They drive a local Google Chrome, and the WebGPU suites need a real GPU.

## Contributors & Acknowledgments

This project is fully engineered and conceptualized by Kenji Yoshida.
I also acknowledge the invaluable support of my AI collaborators:

- **Claude** (Anthropic) & **Gemini** (Google) - AI Collaborators for architectural ideation, coding, and technical writing.

## License

- Engine & apps (`@ortho-earth/core`, `@ortho-earth/globe`, `ortho-japan`, `apps/*`): **GPL-3.0-or-later**
- Data formats & utilities (`geopbf`, `altpbf`, `native-bucket`, `common`, `himekuri`): **MIT**

For commercial use without GPL obligations, a separate commercial license is available — contact kenji.yoshida.home.2026@gmail.com.
