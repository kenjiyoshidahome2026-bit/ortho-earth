# geoedit

The editor half of the [geopbf](../geopbf) format: a topological GeoPBF editor that mounts on an ortho-earth map
(`ortho-japan` today, `ortho-globe` next) as a gadget. Shapes are edited **on the sphere** (edges are great circles,
moves are rotations, circles are small circles), `@style` annotations (pins, bands, blur, splines, tips, pop-ups) are
drawn with the same primitives the viewer uses (`geopbf/edit/draw`), and a large-file mode edits a GintBUF-backed
model in place. MIT, like geopbf. Split out of `apps/ortho-japan/gadgets/geoedit` on 2026-09-20.

This repository is a read-only mirror of `packages/geoedit` in the [ortho-earth monorepo](https://github.com/kenjiyoshidahome2026-bit/ortho-earth) (`npm run mirror`); issues and pull requests go there.

```js
import { initEditor, setLang } from "geoedit";
await setLang("ja");                       // the editor carries its own 26-language table (i18n/ui.json)
const editor = initEditor(map, {           // map = an ortho-earth map (public API only, see below)
	adopt: true,                            // start from the map's current user layer (drop / ?g=)
	data: null,                             // or an ArrayBuffer of a GeoPBF to edit
	onClose: () => {},                      // toolbar "×" — read editor.result() then editor.destroy()
	setDropOwner: on => {},                 // let the host hand file drops to the editor while mounted
	dock: mapEl => el,                      // host's bottom-left dock (default: #dock inside map.mapEl)
	cloudPanel: (container, hooks, toast) => el,   // host's cloud/share panel (optional — button hidden without it)
});
```

**Data the editor writes** (all plain GeoPBF properties, so they survive export to any format):

- `@fill`, `@stroke`, `@width`, `@shape`, `@icon`, `@text`, `@size`, `@spline`, `@blur`, `@poly`, `@start`/`@end`, `@tip`, `@pop` — presentation, replayed by the viewer.
- `height` (polygons, metres; v0.2) — building height. Deliberately **not** `@`: it is data, and it is the key MapLibre (`fill-extrusion`) and OSM use, so it keeps its meaning outside ortho-earth. ortho-japan extrudes polygons that carry it.
- `@image` + `@opacity` (v0.2) — an **image placed by its four corners** (old map, scanned plan, photo). Drop a PNG/JPEG/WebP on the editor (or use the import button): it lands north-up at the view centre, half the screen wide. It is a 4-vertex polygon whose ring runs top-left → top-right → bottom-right → bottom-left, so dragging vertices *is* fitting the corners, and the move tool shifts/rotates it; the image warps live while you drag. Mapping and drawing are shared with the viewer (`geopbf/edit/imagequad`).

**Host contract** — the editor uses only the map's public surface: `mapEl`, `unprojectXY`, `projectLL`,
`makeProjector`, `onFrame`, `requestDraw`, `getZoom`, `view`, `addGint`, `applyGintData`, `paintTable`, `userPbf`,
`setEditClick`, `setMaxPitch`/`maxPitch`, `setZoomMin`/`zoomMin`, `requestSnapshot`, `ellipsoidOn`, and the `tip`/`pop`
gadgets (`map.gadget.tip()`, `map.gadget.pop()`). Styles are baked into `src/editor.css.js` (from `editor.scss`; `npm run build:css`), so the host needs neither sass nor Vite-only imports.

**Worker entry** — the editing model runs in a module worker (role `"geoedit:model"`). A host with its own worker entry can
run it there instead, sharing geopbf's core with its other workers: `setWorkerFactory(role => new Worker(…, { name: role }))`
(from `geoedit` or the tiny `geoedit/worker-factory`), and in the host worker `import("geoedit/model-worker")` for that name.
Return `null` to keep the built-in worker. Same convention as geopbf (README "Worker entry"), including the build alias
that drops the built-in worker.

Install: `npm i geoedit` (depends on `geopbf` ≥ 1.11.0). With Vite, set `worker: { format: "es" }` in your config (geopbf's workers use dynamic imports; Vite's default `iife` worker format cannot bundle them). Tests live with the host app for now (`apps/ortho-japan/tests/t-editor.html` and friends) and run with
`npm test` here (→ `verify:editor` of ortho-japan).
