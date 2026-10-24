# japan-host

The `/japan/` Worker (its Cloudflare name stays `ortho-japan`). It holds no page of its own: every page under `www.ortho-earth.com/japan/` is its own app
(`apps/<name>/`, with `"servedAt": "/japan/"` in its package.json) — the front page is [`apps/japan-map`](../japan-map), the others are fireworks, geoedit-app, models, onsen, parks, pointcloud, scene, tellus and terrain.
Until 2026-10-24 the front page and this Worker were one folder, `apps/ortho-japan`.

```
npm run build -w japan-host        # gather-apps.mjs /japan/ --clean: build every /japan/ app and gather the output into dist/site/japan/
npm run build:prod -w japan-host   # the same, plus the SDK (sdk/japan) at /japan/lib/
npm run deploy -w japan-host       # i18n gate (japan-map) → regionless gate → editor gate (japan-map tests) ‖ globe gate ‖ verify:prod → wrangler deploy → verify-live
```

`deploy-worker.js` adds COOP/COEP to every response and sends the old URLs (`/japan/earth`, `/japan/quakes`, `/japan/sats`, `/ortho-japan/…`) on with 301.

License: GPL-3.0-or-later.
