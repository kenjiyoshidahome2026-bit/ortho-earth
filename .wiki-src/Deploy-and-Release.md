> **English** · [日本語](Deploy-and-Release-ja)

# Deploy and Release

## Production deploy (workflow `deploy`)

- **Automatic on merge.** A push to `main` that changes something distributable (`apps/**`, `packages/**`, `sdk/**`, `package-lock.json`, the deploy script) starts `deploy` with target `engine-and-apps`. Merges that only touch `www`, `docs`, `gishub-jp`, `geopbf-demo` or `*.md` do not deploy (Cloudflare Pages builds those).
- **Runs on Kenji's Mac** (self-hosted runner, label `ortho-deploy`), because the gates need a real GPU (WebGPU pixel checks). Cloudflare is reached with the Mac's logged-in `wrangler`; no keys are stored in GitHub. If the Mac is asleep the job waits for the runner (GitHub drops it after 24 h).
- **One at a time.** Concurrency keeps the running deploy and only the newest waiting one; an older waiting run shows as "cancelled", which is not a failure.
- **Order:** globe gate (`globe-host` `verify:prod` against the new engine) → engine (`ortho-engine`) → globe host → every app that loads the engine. It stops at the first failing gate. A full run takes about 5–11 minutes.
- **Manual button:** Actions → deploy → Run workflow on `main`, with target `engine-and-apps` (optionally a list of apps), `engine-only`, `gate-only` (gates only, deploys nothing), `native-bucket`, `quakes-mirror` or `sats-mirror`.
- After a deploy the workflow pushes the tag `japan-deployed`, which marks the range for the next Japan editor gate.
- The same thing can be run by hand from a machine with `wrangler`: `npm run deploy:engine` at the root, or `npm run deploy -w <app>` for one Worker.

## The site (`www`)

`www.ortho-earth.com` (top page, `/maplibre/`, `/sandcastle/`, `/docs/`, `/geopbf/`, `/gishub-jp/`) is Cloudflare Pages and is published automatically when `main` changes. Pull requests get a preview at `https://claude-project-thread-<id>.www-ortho-earth.pages.dev` for Claude's branches.

## npm release (workflow `publish`)

- Actions → publish → Run workflow. Leave the package list empty to publish every package whose version is not on npm yet, or name packages (for example `@ortho-earth/core`). Turn **dry run off** to actually publish.
- An option copies the mirrored packages (`geopbf`, `altpbf`, `geoedit`, `native-bucket`, `ortho-world`, `himekuri`) to their standalone repositories afterwards (workflow `mirror`).
- A post-publish check then runs on the Mac. A red check there does not mean the package was not published; look at npm first.
- Bump the version in the package's `package.json` in a pull request before publishing.

## Data

- **R2 bucket:** bulk data is uploaded only through the `apps/uploader` screen. Keep it lean.
- **Demo data:** files under `ortho-data/japan/**` and `ortho-data/us/**` are published to GitHub Pages by the workflow `pages` on push to `main`.

## Other workflows

- `test`: on every pull request and every push to `main`, `npm ci`, the root `npm test` (Node only, no browser) and the i18n gates.
- CodeQL code scanning (JavaScript/TypeScript, Rust, Actions).

## Known harmless messages

`ENOENT /tmp/oe-bucket-cache`, a transient "world card does not appear", and `vite: command not found` on the runner (fix: `npm rebuild vite`).
