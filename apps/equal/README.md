# ortho-equal

The whole Earth on one sheet: Natural Earth 10m in the **Equal Earth** projection, drawn on the GPU (WebGPU, WebGL2 fallback).
Served at `www.ortho-earth.com/equal/`; also mounted *inside* `/japan/` and `/globe/` as the "Equal Earth" gadget
(`createEqual()` from `src/equal.js` is a part you hand a `<div>`; `index.html` + `src/main.js` is only the shell).

| | |
|---|---|
| URL | `/equal/` — `?lang=`, `?labels`, `?hypso`, `?choro`, `?year`, `?g=<geopbf>`, `?csv=<url>`, `#z/lat/lon` |
| Languages | 26 (UI + place names); language `<select>` in the layers panel |
| Data | Natural Earth 10m, GEBCO relief, Köppen climate, World DB (choropleths) — bucket `GIS/world/` |
| Head | English `<head>` with share card (`og:image` = www thumbnail), canonical, theme-color |

## Develop

```
npm run dev -w ortho-equal        # http://localhost:5198/equal/
npm test -w ortho-equal           # node tests (projection, CSV join, choropleth, bake, labels, theme)
npm run i18n:build -w ortho-equal # bake i18n/lang/<code>.json after editing i18n/ui.json
```

`tests/gpu-parity-run.mjs` compares the WebGPU and WebGL2 renderers on a real GPU (not part of `npm test`).

License: GPL-3.0-or-later.
