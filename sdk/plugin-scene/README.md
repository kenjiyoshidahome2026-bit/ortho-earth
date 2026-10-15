# @ortho-earth/plugin-scene

Instanced meshes, billboards and 3D text for [`@ortho-earth/globe`](../../packages/globe). The plugin registers three `map.addData` kinds on the `dataKinds` extension point. Each kind draws as a same-frame overlay with the globe's camera.

- **`instanced`** draws one mesh many times. The mesh can be a box, cylinder, cone, sphere, your own mesh or an uncompressed `.glb`. Each item has a position, a scale in meters, a heading, pitch and roll, and a color.
- **`billboards`** draws images at 3D positions. They can face the screen, lie flat on the ground or stand upright, sized in pixels or meters.
- **`labels3d`** draws text at 3D positions. The text is drawn to an atlas on the main thread with the page's fonts, then takes the billboard path.

All three are hidden by terrain and buildings through the scene depth. They are picked by the unified picking: `handle.pick(x, y)`, `map.on("click", id, …)` and `queryRenderedFeatures({ layers: [id] })`.

```js
import { createGlobe } from "@ortho-earth/globe";
import { scenePlugin } from "@ortho-earth/plugin-scene";

const map = await createGlobe({ target: "#map", plugins: [scenePlugin()] });   // or map.use(scenePlugin())
map.supports("data.instanced");                                               // true ("plugin", via "plugin-scene")

const trees = map.addData(points, {
	kind: "instanced", id: "trees", shape: "cone",
	getPosition: d => [d.lon, d.lat], getScale: d => [4, 4, d.height], getColor: [40, 140, 60],
	getProperties: d => ({ species: d.species }),
});
const pins = map.addData(shops, { kind: "billboards", id: "pins", getIcon: "pin", icons: { pin: "/img/pin.png" }, getSize: 32, getPosition: d => [d.lon, d.lat, 20] });
const names = map.addData(peaks, { kind: "labels3d", id: "peaks", getText: d => d.name, getSize: 14, getPosition: d => [d.lon, d.lat, d.ele], altitude: "absolute" });

await trees.ready;
map.on("click", "trees", e => console.log(e.features[0].properties.species));
await trees.setData(morePoints);          // re-bake everything (same as addData's builtin kinds)
await trees.setProps({ shape: "/models/tree.glb" });
pins.setVisible(false);
names.remove();
```

## Options

| kind | options |
|---|---|
| all | `id`, `getPosition` ([lon, lat, h m], default the Point geometry), `altitude` ("relative" above the ground, or "absolute"), `getProperties`, `depthTest` (default true), `above` (draw above the labels) |
| `instanced` | `shape` (name, `{ pos, idx, nrm?, col? }` in x east / y north / z up with the base at z 0, `.glb` URL or bytes), `getScale` (m, number or [e, n, u]), `getOrientation` ([heading, pitch, roll] degrees), `getColor`, `color`, `sizeScale` |
| `billboards` | `getIcon` (a key of `icons`, a URL or an image), `icons`, `getSize` (height; width follows the image), `getColor`, `getAngle`, `facing` ("screen", "flat", "upright"), `sizeUnits` ("pixels", "meters"), `anchor` (default "bottom") |
| `labels3d` | `getText` (`\n` breaks lines), `getSize`, `getColor`, `font`, `fontWeight`, `haloColor`, `haloWidth`, `getAngle`, `facing`, `sizeUnits`, `anchor` (default "center") |

Colors are `[r, g, b, a?]` from 0 to 255 or CSS colors. The handle is `{ id, kind, n, ready, setData, setProps, setVisible, pick, remove, overlay }`. A pick hit carries `object` and `dataIndex`, which point back into your data.

## Limits

- `.glb` files must be uncompressed. Draco and meshopt are refused with an error. Skins, morph targets and animations are ignored; the nodes of the default scene are baked into one mesh.
- One handle draws one mesh. Use one handle per model.
- Labels are not collision-checked against each other or against the map's labels. Use the map's symbol layers for that.
- Drawing is WebGL2 on the overlay canvas in the render worker, in the same frame as the globe. The page check runs on the WebGL2 backend.

Tests: `npm test -w @ortho-earth/plugin-scene` (node: shapes, `.glb` parsing, atlas packing, colors, baking, plugin shape) and, in `packages/globe`, `npm run verify:ui -- t-pscene` (a tower at Tokyo Station: a box in front is drawn and a box behind it is hidden, billboard and text drawn, picks, setData, setProps, setVisible, remove, unuse).
