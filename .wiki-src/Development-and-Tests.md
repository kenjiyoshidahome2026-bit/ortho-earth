> **English** · [日本語](Development-and-Tests-ja)

# Development and Tests

## Setup

- Node 22.18 or newer (tests import `.ts` sources directly with Node's built-in type stripping) and npm.
- `npm install` at the root installs every workspace (`packages/*`, `sdk/*`, `apps/*`).

## Running and building

- `npm run dev:www`: the top page with the demo cards.
- `npm run dev -w <app>`: one app, for example `-w japan-map` or `-w globe-map`. In dev the shared engine comes straight from the sources.
- `npm run build:all`: builds www, geopbf-demo, gishub-jp and world and assembles `apps/www/dist` (docs, geopbf, gishub-jp, world, the shared engine).
- `node scripts/size-report.mjs --compare`: sizes of the distributables against the baseline.
- Start with [`packages/globe/README.md`](https://github.com/kenjiyoshidahome2026-bit/ortho-earth/blob/main/packages/globe/README.md) for the engine API, [`PLUGINS.md`](https://github.com/kenjiyoshidahome2026-bit/ortho-earth/blob/main/packages/globe/PLUGINS.md) for plugins and [`packages/geopbf/README.md`](https://github.com/kenjiyoshidahome2026-bit/ortho-earth/blob/main/packages/geopbf/README.md) for the data layer.

## Tests

| Command | What it runs |
|---|---|
| `npm test` | Every Node-only suite in the monorepo, in parallel (`scripts/test-all.mjs`, about 200 files). `npm run test:list` lists them, `npm test -- geopbf` runs a subset, `TEST_JOBS=1` runs them one by one |
| `npm run verify:i18n` | The i18n gates of all apps (a phrase must be in only one dictionary) |
| `npm run verify:app-imports` | No app reads another app (ratchet, part of `npm test`) |
| `npm run verify:regionless -w @ortho-earth/globe` | No region names in globe/core code (ratchet) |
| `verify:ui`, `verify:webgpu`, `verify:nocoi`, `verify:examples` in `packages/globe` | Browser suites of the engine |
| `verify:ui`, `verify:webgpu`, `verify:prod` in `apps/japan-map`; `verify:prod` in `apps/japan-host` | Browser suites of the Japan map |
| `verify:pages` in `packages/geopbf`; `verify:gpu` in `apps/equal` | Other browser suites |

Browser suites drive a pinned headless Chrome for Testing (about 150 MB, cached in `~/.cache/ortho-earth/chrome-for-testing`; `npm run chrome:install` in `packages/globe` fetches it; `CHROME=<path>` overrides it). The WebGPU suites need a real GPU, so WebGPU-only regressions are checked on the Mac.

## Tips

- When an engine change moves UI, update the `verify:ui` tests in the same pull request.
- WGSL uniform fields must match the CPU packer order (`frame-layout.mjs` test).
- Use the public API (`globe.d.ts`) from apps; never `dbgHost` or `__*`.
