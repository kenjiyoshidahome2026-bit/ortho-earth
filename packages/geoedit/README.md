# geoedit

The editor half of the [geopbf](../geopbf) format: a topological GeoPBF editor that mounts on an ortho-earth map
(`ortho-japan` today, `ortho-globe` next) as a gadget. Shapes are edited **on the sphere** (edges are great circles,
moves are rotations, circles are small circles), `@style` annotations (pins, bands, blur, splines, tips, pop-ups) are
drawn with the same primitives the viewer uses (`geopbf/edit/draw`), and a large-file mode edits a GintBUF-backed
model in place. MIT, like geopbf. Split out of `apps/ortho-japan/gadgets/geoedit` on 2026-09-20.

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

**Host contract** — the editor uses only the map's public surface: `mapEl`, `unprojectXY`, `projectLL`,
`makeProjector`, `onFrame`, `requestDraw`, `getZoom`, `view`, `addGint`, `applyGintData`, `paintTable`, `userPbf`,
`setEditClick`, `setMaxPitch`/`maxPitch`, `setZoomMin`/`zoomMin`, `requestSnapshot`, `ellipsoidOn`, and the `tip`/`pop`
gadgets (`map.gadget.tip()`, `map.gadget.pop()`). Styles are baked into `src/editor.css.js` (from `editor.scss`; `npm run build:css`), so the host needs neither sass nor Vite-only imports.

Install: `npm i geoedit` (depends on `geopbf` ≥ 1.9.0). Tests live with the host app for now (`apps/ortho-japan/tests/t-editor.html` and friends) and run with
`npm test` here (→ `verify:editor` of ortho-japan).
