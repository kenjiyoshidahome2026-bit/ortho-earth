# Development, tests and deploy

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
| `npm test` | Every Node-only suite in the monorepo, in parallel (`scripts/test-all.mjs`: each workspace's suites unrolled to about 290 test files, no browser or network needed). `npm run test:list` lists them, `npm test -- geopbf` runs a subset, `TEST_JOBS=1` runs them one by one |
| `npm run verify:i18n` | The i18n gates of all apps (a phrase must be in only one dictionary) |
| `npm run test:docs-links` | No broken relative links in the repository's `.md` files (part of `npm test`; `scripts/check-doc-links.mjs`) |
| `npm run test:npm-meta` | Every published package's `description` fits npm's 255 characters and its README npm's 64 KB (part of `npm test`; `scripts/check-npm-meta.mjs`) |
| `npm run verify:app-imports` | No app reads another app (ratchet, part of `npm test`) |
| `npm run verify:regionless -w @ortho-earth/globe` | No region names in globe/core code (ratchet) |
| `verify:ui`, `verify:webgpu`, `verify:nocoi`, `verify:examples` in `packages/globe` | Browser suites of the engine |
| `verify:ui`, `verify:webgpu`, `verify:prod` in `apps/japan-map`; `verify:prod` in `apps/japan-host` | Browser suites of the Japan map |
| `verify:pages` in `packages/geopbf`; `verify:gpu` in `apps/equal` | Other browser suites |

Browser suites drive a pinned headless Chrome for Testing (about 150 MB, cached in `~/.cache/ortho-earth/chrome-for-testing`; `npm run chrome:install` in `packages/globe` fetches it; `CHROME=<path>` overrides it). It is separate from your everyday Chrome, so a running suite never blocks you from opening Chrome. The WebGPU suites need a real GPU, so WebGPU-only regressions are checked on the Mac.

## Tips

- When an engine change moves UI, update the `verify:ui` tests in the same pull request.
- WGSL uniform fields must match the CPU packer order (`frame-layout.mjs` test).
- Use the public API (`globe.d.ts`) from apps; never `dbgHost` or `__*`.

## Deploy: production deploy (workflow `deploy`)

- **Automatic on merge.** A push to `main` that changes something distributable (`apps/**`, `packages/**`, `sdk/**`, `package-lock.json`, the deploy script) starts `deploy` with target `engine-and-apps`. Merges that only touch `www`, `docs`, `gishub-jp`, `geopbf-demo` or `*.md` do not deploy (Cloudflare Pages builds those).
- **Runs on Kenji's Mac** (self-hosted runner, label `ortho-deploy`), because the gates need a real GPU (WebGPU pixel checks). Cloudflare is reached with the Mac's logged-in `wrangler`; no keys are stored in GitHub. If the Mac is asleep the job waits for the runner (GitHub drops it after 24 h).
- **One at a time.** Concurrency keeps the running deploy and only the newest waiting one; an older waiting run shows as "cancelled", which is not a failure.
- **Order:** globe gate (`globe-host` `verify:prod` against the new engine) → engine (`ortho-engine`) → globe host → every app that loads the engine (`quakes`, `globe-host`, `census2020`, `ortho-nl`, `quiz`, `choju`, `yokohama`, `world`, `equal`, `japan-host`, `solar`, `himekuri`). It stops at the first failing gate, and an app refuses to go out if the engine version it was built against is not live yet. A full run takes about 5–11 minutes.
- **Manual button:** Actions → deploy → Run workflow on `main`, with target `engine-and-apps` (optionally a list of apps), `engine-only`, `gate-only` (gates only, deploys nothing), `native-bucket`, `quakes-mirror` or `sats-mirror`.
- After a deploy the workflow pushes the tag `japan-deployed`, which marks the range for the next Japan editor gate.
- The same thing can be run by hand from a machine with `wrangler`: `npm run deploy:engine` at the root, or `npm run deploy -w <app>` for one Worker.

## Deploy: the site (`www`)

`www.ortho-earth.com` (top page, `/maplibre/`, `/sandcastle/`, `/docs/`, `/geopbf/`, `/gishub-jp/`) is Cloudflare Pages and is published automatically when `main` changes. Pull requests get a preview at `https://claude-project-thread-<id>.www-ortho-earth.pages.dev` for Claude's branches.

## Deploy: npm release (workflow `publish`)

- Actions → publish → Run workflow. Leave the package list empty to publish every package whose version is not on npm yet, or name packages (for example `@ortho-earth/core`). Turn **dry run off** to actually publish.
- An option copies the mirrored packages (`geopbf`, `altpbf`, `geoedit`, `native-bucket`, `ortho-world`, `himekuri`) to their standalone repositories afterwards (workflow `mirror`).
- A post-publish check then runs on the Mac. A red check there does not mean the package was not published; look at npm first.
- Bump the version in the package's `package.json` in a pull request before publishing.
- The `/sandcastle/` and `/maplibre/` galleries print the globe version (`v2.4.x`) from `packages/globe/package.json` at the moment they are generated (`packages/globe/tests/csexamples/publish.mjs`, `tests/mlexamples/report.mjs`). Pictures shot just before a release still say the old series, so in the release pull request change `vX.Y.x` / `@ortho-earth/globe X.Y.x` in `apps/www/public/sandcastle/index.html` and `apps/www/public/maplibre/index.html` too (or regenerate after the bump). Also check the version named in `apps/docs/from-maplibre*.html` and the README's MapLibre grading line.

## Deploy: data

- **R2 bucket:** bulk data is uploaded only through the `apps/uploader` screen. Keep it lean.
- **Demo data:** files under `ortho-data/japan/**` and `ortho-data/us/**` are published to GitHub Pages by the workflow `pages` on push to `main`.

## Deploy: other workflows

- `test`: on every pull request and every push to `main`, `npm ci`, the root `npm test` (Node only, no browser) and the i18n gates; the type check runs as its own job, split across three runners.
- CodeQL code scanning (JavaScript/TypeScript, Rust, Actions).

## Deploy: known harmless messages

`ENOENT /tmp/oe-bucket-cache`, a transient "world card does not appear", and `vite: command not found` on the runner (fix: `npm rebuild vite`).
