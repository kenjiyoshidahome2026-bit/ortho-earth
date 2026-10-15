# ortho-engine

The shared engine served at `www.ortho-earth.com/globe/engine/<version>/`. It is one versioned build of
[`@ortho-earth/globe`](../../packages/globe) plus every module that two or more apps use: i18n, core, geopbf, h3,
the jp and nl region packs, and Equal Earth. Apps import these by URL instead of each bundling a copy, so one
browser cache serves every app.

- `src/entries.mjs` lists the entries (`import name → <name>.js`). It is written into `current.json` as `imports`, which
  each app's build reads through `sharedEngine()` (`packages/globe/scripts/lib/shared-engine.mjs`).
- `npm run build -w ortho-engine` writes `dist/site/globe/engine/<version>/` and `current.json`. The version is a hash of
  the output, so the same sources give the same URL. Every app build that uses `sharedEngine()` rebuilds it first.
- `deploy-worker.js` serves `/globe/engine/*`. Old-version entry points are redirected (302) to the current version,
  entries are `no-cache`, and chunks are immutable.
- Deploy with `npm run deploy:engine` at the repository root. It verifies the `ortho-globe` pages against the new
  engine, deploys this Worker, and then deploys every app that loads the engine.
