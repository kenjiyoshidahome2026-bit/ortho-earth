// TILE_BOUNDING_BOX metadata overrides the header volume (Cesium3DTile.createBoundingVolume): ion Reality Tiler roots (3d-tiles-1.1-photogrammetry,
// asset 2325106) carry a loose cube + the tight box as metadata; zoomTo framed the cube → the camera 310 m too high
import { tileVolume } from "../src/tile-volume.ts";
import { sphereOfVolume } from "../src/tileset.ts";
let fails = 0;
const ok = (name, c, info = "") => { console.log(`${c ? "PASS" : "FAIL"} ${name}${info ? " " + info : ""}`); if (!c) fails++; };
const schema = { classes: { tile: { properties: { tight: { type: "SCALAR", componentType: "FLOAT64", array: true, count: 12, semantic: "TILE_BOUNDING_BOX" } } } } };
const root = { boundingVolume: { box: [0, 0, 0, 300, 0, 0, 0, 300, 0, 0, 0, 300] }, metadata: { class: "tile", properties: { tight: [0, 0, 0, 3, 0, 0, 0, 4, 0, 0, 0, 12] } } };
const r = sphereOfVolume(tileVolume({ schema, root }, root)).radius;
ok("tileVolume: TILE_BOUNDING_BOX metadata wins", Math.abs(r - 13) < 1e-9, `${r}`);
ok("tileVolume: no metadata → header volume", tileVolume({}, { boundingVolume: { sphere: [0, 0, 0, 5] } }).sphere[3] === 5);
const sphSchema = { classes: { t: { properties: { s: { type: "SCALAR", array: true, count: 4, semantic: "TILE_BOUNDING_SPHERE" } } } } };
ok("tileVolume: 3DTILES_metadata extension sphere", tileVolume({ extensions: { "3DTILES_metadata": { schema: sphSchema } } }, { boundingVolume: { sphere: [0, 0, 0, 5] }, extensions: { "3DTILES_metadata": { class: "t", properties: { s: [1, 2, 3, 4] } } } }).sphere[3] === 4);
console.log(fails ? `${fails} FAILED` : "t-tile-volume: OK");
process.exit(fails ? 1 : 0);
