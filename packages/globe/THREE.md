# three.js with ortho-earth

ortho-earth draws the globe in a render worker (OffscreenCanvas). three.js runs **inside that worker**, in the same
frame and with the same camera as the map, so your meshes stay glued to the ground at any zoom, are hidden by terrain
and buildings, and answer the map's picking. three.js is not a dependency of `@ortho-earth/globe`: you load it from a
URL (a CDN by default), and the engine does not grow when you don't use it.

There are three ways in. Pick the first one unless you are porting a MapLibre custom layer.

| Route | Where it draws | Hidden by terrain / buildings | Use it for |
|---|---|---|---|
| `map.addThree({ module })` | render worker | yes | new three.js scenes (recommended) |
| `map.addLayer({ type: "custom", url, three })` | render worker | yes (`renderingMode: "3d"`) | MapLibre `CustomLayerInterface` code that uses three.js |
| `map.addLayer({ type: "custom", ...layerObject })` | main thread canvas | **no** (always on top) | MapLibre examples pasted as is |

## Quick start

```js
import { createGlobe } from "@ortho-earth/globe";

const map = await createGlobe({ target: "#map", view: "#16/35.6812/139.7671" });
const h = map.addThree({
	module: new URL("./tower.js", import.meta.url).href,   // your module (below)
	origin: [139.7671, 35.6812, 0],                        // [lon, lat, height m]: the scene's origin
	params: { height: 120 },                               // handed to setup as h.params
});
await h.ready;                                           // resolves after your setup() has run
```

`tower.js` is an ordinary ES module. It may import three.js and its addons with the usual bare specifiers; the
engine resolves them inside the worker (workers have no import maps), and `THREE` is the same instance the engine uses.

```js
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

let model;
export async function setup(_THREE, scene, h) {
	scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 2));
	const gltf = await new GLTFLoader().loadAsync(new URL("./tower.glb", import.meta.url).href);
	model = gltf.scene;
	model.rotation.x = Math.PI / 2;                      // glTF is Y-up; the scene is Z-up (see Coordinates)
	model.scale.setScalar(h.params.height / 100);
	model.position.copy(h.lnglatToLocal(139.7671, 35.6812, 0));
	scene.add(model);
}
export function update(dt, h) { model.rotation.z += dt * 0.5; return true; }   // true = keep drawing
export function onMessage(data, h) { if (data.type === "color") model.traverse(o => o.material?.color?.set(data.value)); }
export function dispose(h) { /* free your own resources */ }
```

From the page, `h.post({ type: "color", value: "#f00" })` reaches `onMessage`, and `h.onmessage = d => …` receives what
the module sends with `h.post(...)` inside the worker.

## Options

| Option | Default | Meaning |
|---|---|---|
| `three` | jsDelivr `three@0.186.1` | URL of `three.module.js`. Use r180 or later for scene depth |
| `addons` | derived from `three` | URL of `three/examples/jsm/` (needed only when `three` does not end in `build/three.module.js`) |
| `module` | none | URL of your module (`setup` / `update` / `onMessage` / `dispose`, all optional) |
| `origin` | current map center | `[lon, lat, hM]`: the scene's origin (relative-to-eye, so no jitter at street zoom) |
| `depth` | `true` | Hide your meshes behind terrain and buildings |
| `params` | none | Anything; passed as `h.params` |
| `name` | `"three"`, then `"three2"`… | Overlay name used by picking and layer events |
| `above` | `false` | Draw above the labels |

The handle: `ready` (Promise), `post(data, transfer?)`, `onmessage`, `pick(x, y)`, `remove()`, plus the overlay handle
members (`name`, `el`, `addLayerId`). `ready` rejects when three.js or your module fails to load or `setup` throws.

## The helpers (`h`)

`setup(THREE, scene, h)` and the other hooks receive:

- `THREE`, `scene`, `camera`, `renderer` (a `WebGLRenderer` on the worker's OffscreenCanvas)
- `origin`, `params`, `earthRadiusM`
- `lnglatToLocal(lon, lat, hM)` → `Vector3` in scene meters; `localToLnglat(v)` → `[lon, lat, hM]`
- `importAddon("loaders/DRACOLoader.js")`: load an addon at run time (same resolution as bare imports)
- `requestDraw()`: ask for a frame after async work (texture loaded…); `post(data)`: send to the page
- `time`, `clock`: the map's shared clock (ms since epoch, and its rate), for animations in sync with the map

## Coordinates

The scene is in **meters, east-north-up** around `origin`: `+x` east, `+y` north, `+z` up. Anything authored Y-up
(glTF, most three.js examples) needs `rotation.x = Math.PI / 2`. Don't touch `camera`: the engine sets its projection
and view every frame from the map camera (`matrixAutoUpdate` is off). The engine multiplies the matrices in float64
before they reach the GPU, so models stay steady at zoom 20. Keep meshes within a few tens of kilometers of `origin`;
for things far apart, use separate origins (or one `addThree` with your own sub-origins via `lnglatToLocal`).

## Picking

Meshes are picked with `THREE.Raycaster` and join the map's unified picking:

```js
map.on("click", "three", e => console.log(e.features[0].properties.name));   // the mesh's name and userData
const hits = await h.pick(x, y);                                             // [{ name, lngLat, properties: { name, userData, altitudeM } }]
```

## Limits and tips

- **It runs in a worker.** There is no `document` or `window`: no DOM-based loaders, no `CSS2DRenderer`, no
  `OrbitControls` (the map owns the camera). `GLTFLoader` uses `ImageBitmapLoader` there, which needs Safari 17 or later.
- **three r180 or later for depth.** Occlusion uses `THREE.ExternalTexture` (added in r180). With an older three.js the
  scene is drawn without depth (always in front) and a console warning says so.
- **One WebGL context per `addThree`.** The render worker can hold about 4 WebGL contexts in Chrome and the globe uses one;
  going over drops the oldest, which is the globe. Put all your models in one `addThree` scene instead of one per model.
- **Depth costs a read-back.** Each `addThree` gets its own context, so the scene depth is copied to it once per frame.
  Turn it off with `depth: false` for things that never go behind buildings (a sky object, a HUD-like marker).
- **WebGL2 only.** three.js's `WebGPURenderer` and TSL are not supported in this route.
- **Lights are yours.** The map's sun is not applied to your materials; add lights in `setup` (or use unlit materials).

## Porting a MapLibre custom layer

MapLibre's three.js examples create a `CustomLayerInterface` object with `onAdd(map, gl)` / `render(gl, args)` and
pass it to `map.addLayer`. That works as is (the main-thread route) but cannot be hidden by terrain or buildings,
because the map's GL context lives in the worker. To get depth, move the layer into a module and point the layer at it:

```js
// layer.js: the same object MapLibre takes, exported from a module
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
export function createLayer(params) {
	return { id: "3d-model", type: "custom", renderingMode: "3d",
		onAdd(map, gl) { this.renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl, antialias: true }); this.renderer.autoClear = false; /* … */ },
		render(gl, args) { /* the same code as in MapLibre, using args.defaultProjectionData.mainMatrix */ } };
}
```

```js
map.addLayer({ id: "3d-model", type: "custom", renderingMode: "3d", url: "./layer.js", three: "https://cdn.jsdelivr.net/npm/three@0.186.1/build/three.module.js", params: {} });
```

`three` (and optionally `addons`) lets the module use bare `"three"` imports, as with `addThree`. Inside the worker,
`map` is a small proxy (`getCanvas`, `triggerRepaint`, `getZoom`, `getCenter`, `getBearing`, `getPitch`,
`getProjection`), so code that reads other map state needs adapting. Passing `renderingMode: "3d"` as an object (no
`url`) logs a one-time warning pointing here.

For new code, `addThree` is simpler: no matrix plumbing, meters around an origin, depth, and picking built in.
