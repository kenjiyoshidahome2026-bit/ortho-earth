# ortho-japan

> 日本語版ドキュメント: [README-ja.md](README-ja.md)

A serverless, dependency-free 3D globe of Japan for any web page. GSI optimized vector tiles and MLIT PLATEAU city models, drawn on a true sphere with WebGPU/WebGL2 — zoom out to a globe, zoom in and the buildings stand up. No API keys, no billing, no servers: public data is fetched directly by the visitor's browser and cached locally.

```html
<link rel="stylesheet" href="/ortho-japan/ortho-japan.css">
<div id="here" style="width:640px;height:420px"></div>
<script type="module">
  import orthoJapan from "/ortho-japan/ortho-japan.js";
  await orthoJapan({ target: "#here", assetBase: "/ortho-japan-assets/" });
</script>
```

## Install

**npm** — `npm install @ortho-earth/japan`. The package ships a prebuilt, self-contained ESM bundle (`dist/lib/`) and its runtime assets (`assets/`, ~150 KB). It declares **zero runtime dependencies** — check `package.json`, it's empty.

**zip** — grab `ortho-japan-sdk-<version>.zip` from [GitHub Releases](https://github.com/kenjiyoshidahome2026-bit/ortho-earth/releases). Same artifact, plus a runnable `example/`.

Either way, deployment is the same: **serve `dist/lib/` (or the zip's `lib/`) and `assets/` as static files** on your site, import the entry by URL, and point `assetBase` at wherever you put the assets. There is no bundler step — workers and lazy chunks resolve relative to the module, so the SDK works at any path. (From npm, copy `node_modules/@ortho-earth/japan/dist/lib` and `assets` into your public directory, or wire up your bundler's static-copy plugin.)

A working sample ships in the zip (`example/index.html`): serve the unzipped folder over HTTP and open `/example/`. `file://` will not work — ES modules.

## orthoJapan(opts)

| option | default | description |
|---|---|---|
| `target` | auto | Where to embed (selector or element). The container's id is normalized to `map` while the map lives there and returned on `destroy()` |
| `view` | last view | Initial view `"#zoom/lat/lon/45t/30r/l=place.rail/c=dark"` (t = tilt°, r = rotation°, l = layers, c = theme) |
| `theme` | `"mono"` | Fixed color theme: `"mono"` (blank map), `"dark"`, `"gsi"` (official GSI map colors), `"sepia"`, or a custom theme object. Unset = selectable via the shared-URL `c=` token |
| `layers` | — | Pin layers on/off: `place`, `terrain`, `rail`, `road`, `facility`. `true` = always on, `false` = always off (both hide the toggle chip); unset = user-toggleable |
| `chips` | `true` | The layer/theme chip bar (top right) |
| `instruments` | `true` | Bottom instrument bar. `true` = all, array = selective, `false` = none. Keys: `pos`, `scale`, `attr` (attribution), `log` |
| `plateau` | `true` | 3D buildings (PLATEAU) master switch. `false` disables the catalog, workers, and auto-loading entirely — no multi-MB transfers ever start |
| `maxPitch` | `75°` | Tilt limit in **radians**. `0` = locked top-down |
| `lang` | auto | UI language `"ja"` / `"en"`. Unset = `?lang=` → browser language. Applies to UI chrome only — map labels are part of the map data |
| `assetBase` | `"./"` | Where the runtime assets live (see Install). Relative or absolute URL |

Returns `map` = `{ cam, flyTo, renderer, mapEl, gadget, destroy }`.

`map.destroy()` tears everything down — workers, listeners, render loop, DOM — and returns the container as it was. IndexedDB caches (PLATEAU, elevation) survive as origin assets, so revisits stay fast.

## Opt-in gadgets (map.gadget.*)

Only what you call gets mounted; call order = top-to-bottom placement.

```js
map.gadget.search();    // place/address search (GSI API, no key)
map.gadget.compass();   // compass + reset (appears only in 3D)
map.gadget.zoom();      // zoom +/- buttons
map.gadget.palette();   // theme switcher with live previews
map.gadget.measure();   // geodesic distance / area measurement
map.gadget.shot();      // save the view as an image (attribution baked in)
map.gadget.print();     // paper-spec plan printing (true scale, A4/A3, graticule) → PDF
map.gadget.qr();        // share the current view as a QR code
map.gadget.plateau();   // 3D building data manager (preload / delete)
map.gadget.contextmenu();
map.gadget.dropFile();  // drag & drop GIS files (GeoJSON/Shapefile/KML/GPX/FGB/GML…)
map.gadget.hint();      // gesture help card
map.gadget("myGadget", function () { /* this = map */ });   // your own
```

## Promises to the host page

Verified mechanically on every build (`verify:lib`):

- Never touches your `html`/`body` — background, margins, overflow, fonts and scroll are identical before and after embedding
- Renders only inside the div you provide (no full-screen takeover)
- No `window` globals (debug handles appear only without `target`, or with `debugGlobals: true`)
- `destroy()` restores the host completely

**COOP/COEP not required.** `crossOriginIsolated` only enables a SharedArrayBuffer fast path; without it the engine falls back to one extra copy and produces identical results.

**One map per page** (fixed element-id contract). Requirements: WebGL2 + OffscreenCanvas (Chrome / Edge / Firefox / Safari 17+). Unsupported browsers get a polite text explanation instead of a blank page.

## Attribution (required)

The map data comes with attribution obligations. **Displaying attribution is the embedder's duty.**

- [GSI Optimized Vector Tiles (experimental)](https://maps.gsi.go.jp/development/ichiran.html#optbv)
- [MLIT Project PLATEAU](https://www.mlit.go.jp/plateau/)
- [JAXA AW3D30](https://www.eorc.jaxa.jp/ALOS/en/dataset/aw3d30/aw3d30_e.htm)

The built-in `attr` instrument (bottom right) covers this by default. **If you remove it, the obligation does not disappear** — put an equivalent credit somewhere visible on your page:

> Source: GSI Optimized Vector Tiles (experimental), GSI elevation tiles (DEM10B), MLIT PLATEAU, JAXA AW3D30 (created by processing these data sources)

## Developing with AI agents

A one-page canon for AI coding agents (API surface, pitfall ledger, verification recipes) is served at **https://www.ortho-earth.com/japan/llms.txt** and bundled in the package. Drop the bundled `sdk/skill/ortho-earth-sdk/` into your `.claude/skills/` and Claude Code writes against the SDK idiomatically. TypeScript definitions: `dist/lib/ortho-japan.d.ts`.

## License

GPL-3.0-or-later ([LICENSE](LICENSE)). A commercial license — without GPL obligations such as disclosing your site's source — is available: contact kenji.yoshida.home.2026@gmail.com.

---

Development guide (build, verification harnesses, dev/prod dual structure): see [README-ja.md](README-ja.md). Live flagship: **https://www.ortho-earth.com/japan/**
