// @ortho-earth/cesium: the parts that run without a browser (node only).
//   the camera bridge (Cesium pose ⇄ the globe's look-at camera, both ways) · glTF bounding spheres · 3D Tiles bounding volumes ·
//   imagery providers → raster sources · the unsupported report
// The browser part (Viewer, entities, the widgets) is the examples gate: packages/globe/tests/csexamples/run.mjs
import { Cartesian3, Ellipsoid, Matrix4, Rectangle } from "@cesium/core";
import { globeCamOf, poseOfGlobeCam, sameGlobeCam } from "../src/camera.ts";
import { gltfSphere } from "../src/gltf.ts";
import { sphereOfVolume } from "../src/tileset.ts";
import { extentOfLayerJson, unionExtents } from "../src/i3s.ts";
import { rasterSourceOf, mercatorRows, adjustPaint } from "../src/imagery.ts";
import { unsupported, unsupportedReport } from "../src/report.ts";
import { glbOf } from "../src/primitives.ts";
import { gridOf, placementOf } from "../src/voxels.ts";
import { cesiumSphereOf } from "../src/spheres.ts";
import { cesiumEnvSH, cesiumEvalSH, cesiumEnvRadiance, CESIUM_SH_UNIFORM_L00 } from "../src/envmap.ts";
import { Entity, JulianDate as EJulianDate } from "@cesium/engine";
import { bandRamp, groundMaterialOf, materialKey, createElevationBandMaterial } from "../src/globe-material.ts";
import { Color, Material } from "@cesium/engine";

let fails = 0; const ok = (n, c, info = "") => { console.log(`${c ? "PASS" : "FAIL"} ${n}${info ? " " + info : ""}`); if (!c) fails++; };
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;
const warns = []; console.warn = m => warns.push(String(m));
const angle = (a, b) => Math.acos(Math.min(1, Cartesian3.dot(Cartesian3.normalize(a, new Cartesian3()), Cartesian3.normalize(b, new Cartesian3())))) * 180 / Math.PI;

// ── camera: globe cam → pose → globe cam is the identity; the pose looks at the target ──
for (const g of [
	{ lng: 139.76, lat: 35.68, height: 0, distance: 2000, heading: 30, pitch: 60, roll: 0 },
	{ lng: -122.4, lat: 37.8, height: 0, distance: 15e6, heading: 0, pitch: 0, roll: 0 },
	{ lng: 10, lat: -45, height: 0, distance: 800, heading: 250, pitch: 80, roll: 5 },
]) {
	const p = poseOfGlobeCam(g), back = globeCamOf(p.position, p.direction, p.up);
	const tgt = Cartesian3.fromDegrees(g.lng, g.lat, g.height);
	ok(`camera round trip (h ${g.heading} p ${g.pitch} r ${g.roll})`, !!back && near(back.lng, g.lng, 1e-6) && near(back.lat, g.lat, 1e-6) && near(back.distance, g.distance, 1e-3 * g.distance)
		&& near(((back.heading - g.heading + 540) % 360) - 180, 0, 1e-4) && near(back.pitch, g.pitch, 1e-4) && near(back.roll, g.roll, 1e-4), JSON.stringify(back));
	ok(`camera looks at the target (p ${g.pitch})`, angle(p.direction, Cartesian3.subtract(tgt, p.position, new Cartesian3())) < 1e-4);
	ok(`camera up ⊥ direction (p ${g.pitch})`, Math.abs(Cartesian3.dot(p.direction, p.up)) < 1e-9);
	ok("sameGlobeCam itself", sameGlobeCam(back, back));
}
{   // straight down from 1000 km over (0, 0): target below, distance = height
	const pos = Cartesian3.fromDegrees(0, 0, 1e6), dir = Cartesian3.negate(Ellipsoid.WGS84.geodeticSurfaceNormal(pos, new Cartesian3()), new Cartesian3());
	const g = globeCamOf(pos, dir, Cartesian3.UNIT_Z);
	ok("camera straight down", near(g.lng, 0, 1e-9) && near(g.lat, 0, 1e-9) && near(g.distance, 1e6, 1e-3) && near(g.pitch, 0, 1e-6) && near(g.heading, 0, 1e-6), JSON.stringify(g));
	// a hair past straight down (pitch -90.00001°, the ray tipped back toward the south): north-up stays north-up (was roll 180 = upside down)
	const back = Cartesian3.normalize(Cartesian3.add(dir, Cartesian3.multiplyByScalar(Cartesian3.UNIT_Z, -2e-7, new Cartesian3()), new Cartesian3()), new Cartesian3());
	const g2 = globeCamOf(pos, back, Cartesian3.UNIT_Z);
	ok("camera a hair past straight down keeps north up", near(g2.heading, 0, 1e-6) && near(g2.roll, 0, 1e-6), JSON.stringify(g2));
	const sky = globeCamOf(pos, Cartesian3.UNIT_Z, Cartesian3.negate(dir, new Cartesian3()));   // looking north along the horizon at 1000 km: misses the globe
	ok("camera at the sky has a target", !!sky && sky.distance >= 1000 && sky.pitch <= 90, JSON.stringify(sky));
}

{   // the target is on the terrain, not the ellipsoid: a camera 2 km up looking down at 30° over a 1500 m plateau (2026-10-28)
	const pose = poseOfGlobeCam({ lng: 138.7, lat: 35.3, height: 0, distance: 4000, heading: 0, pitch: 60, roll: 0 });   // eye 2000 m up, target on the ellipsoid 3464 m north
	const flat = globeCamOf(pose.position, pose.direction, pose.up, null, () => 0);
	ok("terrain at 0 m = the ellipsoid target", !!flat && near(flat.distance, 4000, 1) && near(flat.height, 0, 0.5) && !flat.pending, JSON.stringify(flat));
	const hill = globeCamOf(pose.position, pose.direction, pose.up, null, () => 1500);
	// the ray meets the plateau where its height is 1500: 2000 − t·cos60° = 1500 → t = 1000 m
	ok("target on a 1500 m plateau", !!hill && near(hill.distance, 1000, 2) && near(hill.height, 1500, 0.5) && !hill.pending, JSON.stringify(hill));
	let asked = 0;
	const late = globeCamOf(pose.position, pose.direction, pose.up, null, (lng, lat) => (++asked % 7 === 0 ? null : 1500));
	ok("unknown heights mark the result pending, the known ones still place the target", !!late && late.pending === true && near(late.distance, 1000, 5), JSON.stringify(late));
	// a 3000 m wall 1500 m north of the eye: the ray (2000 m up, 60° down) meets its face at t = 1500 / sin60° = 1732 m, 1134 m up
	const wall = globeCamOf(pose.position, pose.direction, pose.up, null, (lng, lat) => (lat > 35.3 - 3464 / 111320 + 1500 / 111320 ? 3000 : 0));
	ok("a mountain before the ellipsoid hit is the target", !!wall && near(wall.distance, 1732, 10) && near(wall.height, 1134, 6), JSON.stringify(wall));   // ± a few m: the wall's latitude is a flat-earth estimate
	const focus = Cartesian3.fromDegrees(138.7, 35.3 + 500 / 111320, 1800);   // a tracked model on the ray before the plateau keeps the camera's distance to it
	const f = globeCamOf(pose.position, pose.direction, pose.up, Cartesian3.add(pose.position, Cartesian3.multiplyByScalar(pose.direction, 400, new Cartesian3()), new Cartesian3()), () => 1500);
	ok("a focus on the ray wins over the terrain", !!f && near(f.distance, 400, 1), JSON.stringify(f) + String(focus.x));
}

{   // I3S: the extent read from a scene layer's JSON (fullExtent, or store.extent), and the union over a service's layers
	const a = extentOfLayerJson({ fullExtent: { xmin: -122.5, ymin: 37.7, xmax: -122.3, ymax: 37.9 } }), b = extentOfLayerJson({ store: { extent: [8.6, 50.0, 8.8, 50.2] } });
	ok("I3S fullExtent", !!a && a.join() === "-122.5,37.7,-122.3,37.9", JSON.stringify(a));
	ok("I3S store.extent", !!b && b.join() === "8.6,50,8.8,50.2", JSON.stringify(b));
	ok("I3S without an extent", extentOfLayerJson({ layers: [] }) === null && extentOfLayerJson(null) === null);
	ok("I3S union", unionExtents([a, b]).join() === "-122.5,37.7,8.8,50.2" && unionExtents([]) === null);
}

// ── glTF bounding sphere: node transforms, and glTF (y-up, z-forward) → Cesium's model frame (x-forward, z-up) ──
{
	const json = { scene: 0, scenes: [{ nodes: [0] }], nodes: [{ translation: [0, 0, 10], children: [1] }, { mesh: 0, scale: [2, 2, 2] }],
		meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }], accessors: [{ min: [-1, 0, -1], max: [1, 4, 1] }] };
	const bin = enc => { const j = Buffer.from(JSON.stringify(json).padEnd(Math.ceil(JSON.stringify(json).length / 4) * 4)); const h = Buffer.alloc(20); h.writeUInt32LE(0x46546c67, 0); h.writeUInt32LE(2, 4); h.writeUInt32LE(20 + j.length, 8); h.writeUInt32LE(j.length, 12); h.writeUInt32LE(0x4e4f534a, 16); return enc ? Buffer.concat([h, j]) : Buffer.from(JSON.stringify(json)); };
	globalThis.fetch = async u => ({ ok: true, arrayBuffer: async () => { const b = bin(u.endsWith(".glb")); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); } });
	for (const u of ["m.glb", "m.gltf"]) {
		const s = await gltfSphere(u);   // AABB in glTF: x −2..2, y 0..8, z 8..12 → centre (0, 4, 10) → Cesium (10, 0, 4); half diagonal of (4, 8, 4)
		ok(`gltfSphere ${u}`, !!s && near(s.center[0], 10) && near(s.center[1], 0) && near(s.center[2], 4) && near(s.radius, Math.hypot(4, 8, 4) / 2), JSON.stringify(s));
	}
	globalThis.fetch = async () => ({ ok: false, status: 404 });
	ok("gltfSphere of a missing file is null", (await gltfSphere("missing.glb")) === null);
}

// ── 3D Tiles bounding volumes ──
{
	const s = sphereOfVolume({ sphere: [1, 2, 3, 4] });
	ok("sphereOfVolume sphere", near(s.center.x, 1) && near(s.center.z, 3) && near(s.radius, 4));
	const b = sphereOfVolume({ box: [0, 0, 0, 3, 0, 0, 0, 4, 0, 0, 0, 12] });
	ok("sphereOfVolume box", near(b.radius, 13, 1e-9));
	const t = sphereOfVolume({ sphere: [0, 0, 0, 1] }, Matrix4.toArray(Matrix4.fromTranslation(new Cartesian3(100, 0, 0))));
	ok("sphereOfVolume with a transform", near(t.center.x, 100));
	const r = sphereOfVolume({ region: [0, 0, 0.001, 0.001, 0, 100] });
	const c = Ellipsoid.WGS84.cartesianToCartographic(r.center);
	ok("sphereOfVolume region", near(c.longitude, 0.0005, 1e-5) && near(c.latitude, 0.0005, 1e-5) && r.radius > 4000 && r.radius < 6000, `${r.radius}`);
}

// ── imagery providers → raster sources (the providers are stand-ins with the fields the real ones carry) ──
{
	class UrlTemplateImageryProvider { constructor(o) { Object.assign(this, o); } }
	class GeographicTilingScheme {}
	const osm = rasterSourceOf(new UrlTemplateImageryProvider({ _resource: { _url: "https://{s}.tile.example/{z}/{x}/{reverseY}.png", queryParameters: { key: "k" } }, _subdomains: ["a", "b"], maximumLevel: 18 }));
	ok("UrlTemplate → raster", osm?.type === "raster" && osm.tiles.length === 2 && osm.tiles[0] === "https://a.tile.example/{z}/{x}/{-y}.png?key=k" && osm.maxzoom === 18, JSON.stringify(osm));
	const wms = rasterSourceOf(new UrlTemplateImageryProvider({ _resource: { _url: "https://w.example/wms?bbox={westProjected},{southProjected},{eastProjected},{northProjected}" } }));
	ok("WMS-style template → bbox-epsg-3857", wms?.tiles[0] === "https://w.example/wms?bbox={bbox-epsg-3857}", JSON.stringify(wms));
	class BingMapsImageryProvider { constructor(o) { Object.assign(this, o); } }
	const bing = rasterSourceOf(new BingMapsImageryProvider({ _imageUrlTemplate: "http://ecn.{subdomain}.example/a{quadkey}.jpeg?mkt={culture}", _imageUrlSubdomains: ["t0", "t1"], _culture: "en-US" }));
	ok("Bing → raster with {quadkey}", bing?.tiles[1] === "https://ecn.t1.example/a{quadkey}.jpeg?mkt=en-US", JSON.stringify(bing));
	const geoP = new UrlTemplateImageryProvider({ tilingScheme: new GeographicTilingScheme(), _resource: { _url: "https://g.example/{z}/{x}/{y}" }, maximumLevel: 6, rectangle: Rectangle.fromDegrees(-180, -90, 180, 90), requestImage() { return null; } });
	const geo = rasterSourceOf(geoP), geo2 = rasterSourceOf(geoP);
	ok("geographic tiling → Mercator tiles through the cs-geo protocol", geo?.type === "raster" && /^cs-geo:\/\/g\d+\/\{z\}\/\{x\}\/\{y\}$/.test(geo.tiles[0]) && geo.maxzoom === 7 && geo.tiles[0] === geo2.tiles[0], JSON.stringify(geo));
	const rows = mercatorRows(0, 0, 1, 256);   // level 0: one geographic tile row over 180°
	ok("Mercator rows map to geographic tile rows by latitude", near(rows[0], (90 - 85.0511) / 180, 1e-4) && near(rows[128], 0.5, 1e-9) && near(rows[256], (90 + 85.0511) / 180, 1e-4) && rows[1] > rows[0], `${rows[0]},${rows[128]},${rows[256]}`);
	// ImageryLayer adjustments → the globe's paint: inverting its factors gives Cesium's mix() back (saturation 3 → factor −2 = mix(gray, c, 3); contrast 2 → ×2; 0.5 → ×0.5)
	const sat = adjustPaint({ brightness: 1, contrast: 1, saturation: 3, hue: 0 })["raster-saturation"];
	ok("saturation 3 → globe factor −2 (mix(gray, c, 3))", near(1 - 1 / (1.001 - sat), -2, 1e-6), String(sat));
	const c2 = adjustPaint({ contrast: 2 })["raster-contrast"], c05 = adjustPaint({ contrast: 0.5 })["raster-contrast"];
	ok("contrast 2 / 0.5 → factors 2 / 0.5", near(1 / (1 - c2), 2, 1e-9) && near(1 + c05, 0.5, 1e-9), `${c2},${c05}`);
	ok("default adjustments → no paint; brightness 0.5 / hue π", Object.keys(adjustPaint({ brightness: 1, contrast: 1, saturation: 1, hue: 0 })).length === 0 && adjustPaint({ brightness: 0.5 })["raster-brightness-max"] === 0.5 && near(adjustPaint({ hue: Math.PI })["raster-hue-rotate"], 180, 1e-9));
	const c2a = adjustPaint({ colorToAlpha: { red: 0.1, green: 0.2, blue: 0.3 }, colorToAlphaThreshold: 0.05, cutoutRectangle: Rectangle.fromDegrees(-100, 10, -60, 50) });
	ok("colorToAlpha / cutoutRectangle → raster-color-to-alpha / raster-cutout (degrees)", JSON.stringify(c2a["raster-color-to-alpha"]) === "[0.1,0.2,0.3,0.05]" && c2a["raster-cutout"].every((v, i) => near(v, [-100, 10, -60, 50][i], 1e-9)), JSON.stringify(c2a));
	const r1 = mercatorRows(1, 1, 2, 4);   // level 1, southern tile: rows run from the equator (tile row 1) to −85°
	ok("Mercator rows at level 1", near(r1[0], 1, 1e-9) && r1[4] < 2 && r1[4] > 1.9, `${r1[0]},${r1[4]}`);
	class SingleTileImageryProvider { constructor(o) { Object.assign(this, o); } }
	const one = rasterSourceOf(new SingleTileImageryProvider({ _resource: { _url: "https://x.example/a.png" }, rectangle: Rectangle.fromDegrees(-10, -5, 10, 5) }));
	ok("SingleTile → image source", one?.type === "image" && near(one.coordinates[0][0], -10, 1e-9) && near(one.coordinates[0][1], 5, 1e-9), JSON.stringify(one));
}

// ── primitives: the glb the globe loads (CESIUM_RTC, y-up, COLOR_0, _BATCHID) ──
{
	const c = Cartesian3.fromDegrees(139.7, 35.6, 0);
	const tris = { pos: [c.x, c.y, c.z, c.x + 100, c.y, c.z, c.x, c.y + 100, c.z], nrm: null, col: [255, 0, 0, 128, 255, 0, 0, 128, 255, 0, 0, 128], bid: [0, 0, 0], idx: [0, 1, 2] };
	const { glb, blend } = glbOf(tris);
	const dv = new DataView(glb.buffer), jl = dv.getUint32(12, true), j = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jl)));
	const rtc = j.extensions.CESIUM_RTC.center, acc = j.accessors[0];
	ok("glb header", dv.getUint32(0, true) === 0x46546c67 && dv.getUint32(8, true) === glb.length && jl % 4 === 0);
	ok("glb CESIUM_RTC centre is the mean", near(rtc[0], c.x + 100 / 3, 1e-6) && near(rtc[1], c.y + 100 / 3, 1e-6) && near(rtc[2], c.z, 1e-6));
	ok("glb positions are y-up (ECEF Y → −z)", near(acc.max[2], -(c.y - rtc[1]), 1e-3) && near(acc.min[2], -(c.y + 100 - rtc[1]), 1e-3), JSON.stringify(acc));
	ok("glb translucent colour → BLEND", blend && j.materials[0].alphaMode === "BLEND" && j.meshes[0].primitives[0].attributes._BATCHID === 2);
}

// ── voxels: provider tiles → one grid (finest level, padding stripped, glTF y-up order), and the placement ──
{
	const d = { x: 2, y: 2, z: 2 }, one = { x: 1, y: 1, z: 1 };
	const prov = { dimensions: d, paddingBefore: one, paddingAfter: one, availableLevels: 2, types: ["VEC4"], names: ["color"],
		requestData: async ({ tileLevel: l, tileX: x, tileY: y, tileZ: z }) => {   // cell value = (level, global x, y, z) of the cell; padding = −1
			if (l === 1 && x === 1 && y === 1 && z === 1) throw new Error("not available");
			const a = new Float32Array(4 * 4 * 4 * 4).fill(-1);
			for (let k = 0; k < 2; k++) for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) a.set([l, x * 2 + i, y * 2 + j, z * 2 + k], ((i + 1) + 4 * ((j + 1) + 4 * (k + 1))) * 4);
			return { metadata: [a] };
		} };
	const g = await gridOf({ provider: prov, shape: "BOX" });
	const at = (i, j, k) => Array.from(g.values.subarray((i + 4 * (j + 4 * k)) * 4, (i + 4 * (j + 4 * k)) * 4 + 4));
	ok("voxel grid at the finest level", g.dims.join() === "4,4,4" && g.comps === 4 && at(3, 2, 1).join() === "1,3,2,1", JSON.stringify(at(3, 2, 1)));
	ok("voxel grid keeps the parent where a child is missing", at(3, 3, 3).join() === "0,1,1,1", JSON.stringify(at(3, 3, 3)));
	const yup = { ...prov, metadataOrder: 1, availableLevels: 1, requestData: async () => { const a = new Float32Array(64 * 4); a[(1 + 4 * (1 + 4 * 2)) * 4] = 7; return { metadata: [a] }; } };   // stored (x 0, z 0, flipped y: 4 − 1 − (0 + 1) = 2)
	const gy = await gridOf({ provider: yup, shape: "BOX" });
	ok("voxel grid reads glTF y-up tiles", gy.values[0] === 7);
	const pl = placementOf({ provider: { globalTransform: Matrix4.fromUniformScale(10) }, shape: "BOX", minBounds: new Cartesian3(-1, -1, -1), maxBounds: new Cartesian3(1, 1, 0), modelMatrix: Matrix4.IDENTITY });
	ok("voxel box placement", pl.box.transform[0] === 20 && pl.box.transform[10] === 10 && pl.box.transform[12] === -10 && pl.box.transform[14] === -10, JSON.stringify(pl.box.transform));
	const pr = placementOf({ provider: {}, shape: "ELLIPSOID", minBounds: new Cartesian3(-Math.PI, -Math.PI / 2, 0), maxBounds: new Cartesian3(Math.PI, Math.PI / 2, 1e6), modelMatrix: Matrix4.IDENTITY });
	ok("voxel ellipsoid → region", pr.shape === "region" && near(pr.region[0], -180) && near(pr.region[3], 90) && pr.region[5] === 1e6);
}

// ── entity bounding spheres as Cesium frames them (the geometry's own sphere, single-precision centre) ──
{
	const scene = { context: { stencilBuffer: true, depthTexture: true }, frameState: { context: { stencilBuffer: true, depthTexture: true } } };
	const at = Cartesian3.fromDegrees(-106, 45, 100000), t = EJulianDate.now();
	const box = cesiumSphereOf(new Entity({ position: at, box: { dimensions: new Cartesian3(90000, 90000, 90000) } }), scene, t);
	ok("sphere of a box", !!box && near(box.bs.radius, Math.hypot(45000, 45000, 45000), 1e-3) && near(box.bs.center.x, Math.fround(at.x), 1e-9) && !box.dynamic, JSON.stringify(box?.bs));
	ok("no geometry → null", cesiumSphereOf(new Entity({ position: at, point: { pixelSize: 5 } }), scene, t) === null);
}

// ── the unsupported report: once per kind on the console, every time in the counts ──
{
	const before = warns.length;
	unsupported("test thing"); unsupported("test thing");
	ok("unsupported warns once", warns.length - before === 1 && /\[csshim\] unsupported: test thing/.test(warns[warns.length - 1]));
	ok("unsupported counts", unsupportedReport()["test thing"] === 2);
}

// ── envmap: Cesium's procedural environment map as SH9. Reference: environmentMapManager.sphericalHarmonicCoefficients read from the real
//    Cesium (the 3d-models example: Cesium Air 5 km over Oregon, default atmosphere, dynamicLighting NONE) ──
{
	const pos = [-2507719.254607259, -3850587.6079121437, 4415594.838831293], radius = 6367843.849970561;
	const ref = [[0.06361, 0.08863, 0.11976], [0.02933, 0.04739, 0.08296], [-0.00119, -0.00116, -0.00101], [-0.00115, -0.00093, -0.00093], [0.00001, 0.00003, 0.00009], [0.00026, 0.00022, 0.00004], [0.00071, 0.00445, 0.00340], [0.00159, 0.00181, 0.00164], [0.00451, 0.00934, 0.00773]];
	const t0 = performance.now(), sh = cesiumEnvSH(pos, { radius }), ms = performance.now() - t0;
	const rel = (i, c) => Math.abs(sh[i * 3 + c] - ref[i][c]) / Math.abs(ref[i][c]);
	ok("envmap L00 (the mean) within 12% of Cesium's", [0, 1, 2].every(c => rel(0, c) < 0.12), Array.from(sh.subarray(0, 3), v => v.toFixed(4)).join(","));
	ok("envmap L1-1 (sky over ground) within 3% of Cesium's", [0, 1, 2].every(c => rel(1, c) < 0.03), Array.from(sh.subarray(3, 6), v => v.toFixed(4)).join(","));
	ok("envmap L20 within 25% of Cesium's", [1, 2].every(c => rel(6, c) < 0.25));
	const up = cesiumEvalSH(sh, [0, 1, 0]), down = cesiumEvalSH(sh, [0, -1, 0]);
	ok("envmap: the sky lights from above, blue", up[2] > down[2] * 2 && up[2] > up[0]);
	ok("envmap: a uniform environment comes back as its radiance", near(cesiumEvalSH(new Float32Array(27).fill(0).map((v, i) => i < 3 ? CESIUM_SH_UNIFORM_L00 * 2 : 0), [0.3, 0.9, 0.3])[0] / (CESIUM_SH_UNIFORM_L00 * 2), 1, 1e-6));
	ok("envmap: the ground is the ground colour under the zenith light", cesiumEnvRadiance(pos, [0, 0, -1], { radius }).every((v, c) => Math.abs(v - [113, 113, 69][c] / 255 * 0.31 * 2) < 0.15));
	ok("envmap computes quickly", ms < 200, `${ms.toFixed(1)} ms`);
	const ground = cesiumEnvSH([-2503858.174101297, -3844658.942363919, 4415712.092618074], { radius: 6367827.056697302 });   // a point on the surface (where the facade's camera looks): rays meet the ground at distance 0
	ok("envmap on the surface has no NaN", Array.from(ground).every(Number.isFinite) && ground[0] > 0.01, Array.from(ground.subarray(0, 3), v => v.toFixed(4)).join(","));
	const night = cesiumEnvSH(pos, { radius, dynamicLighting: 2, sunDirWC: [0.3, 0.3, -0.9] });   // SUNLIGHT with the sun below: darker
	ok("envmap SUNLIGHT mode follows the sun", night[0] < sh[0] * 0.8, `${night[0].toFixed(4)} vs ${sh[0].toFixed(4)}`);
}

// ── globe.material → the globe's ground material (globe-material.ts): ramps, contour, bands, land only ──
{
	const img = { width: 4, height: 1 }, pix = Uint8Array.from([0, 0, 0, 255, 255, 0, 0, 255, 0, 255, 0, 255, 255, 255, 255, 255]);
	const read = im => (im === img ? pix : null);
	const ramp = { type: "ElevationRamp", uniforms: { image: img, minimumHeight: -414, maximumHeight: 8777 } };
	const spec = groundMaterialOf(ramp, read);
	ok("ElevationRamp → elevation ramp with min/max", spec?.ramp?.kind === "elevation" && spec.ramp.min === -414 && spec.ramp.max === 8777 && spec.ramp.colors.length === 16 && spec.ramp.colors[4] === 255 && !spec.contour && !spec.landOnly);
	ok("SlopeRamp / AspectRamp → their kinds", groundMaterialOf({ type: "SlopeRamp", uniforms: { image: img } }, read)?.ramp?.kind === "slope" && groundMaterialOf({ type: "AspectRamp", uniforms: { image: img } }, read)?.ramp?.kind === "aspect");
	const contour = { type: "ElevationContour", uniforms: { color: new Color(1, 0, 0, 1), spacing: 150, width: 2 } };
	const c = groundMaterialOf(contour, read);
	ok("ElevationContour alone → contour, no ramp", !c?.ramp && c?.contour?.spacing === 150 && c.contour.width === 2 && c.contour.color.join() === "1,0,0,1");
	const comp = { type: "ElevationColorContour", materials: { contourMaterial: contour, elevationRampMaterial: ramp } };
	const cs = groundMaterialOf(comp, read);
	ok("composite contour + ramp → both", cs?.ramp?.kind === "elevation" && cs.contour?.spacing === 150);
	const land = { type: "ElevationLand", materials: { waterMaskMaterial: { type: "WaterMask", uniforms: {} }, elevationRampMaterial: ramp } };
	const ls = groundMaterialOf(land, read);
	ok("composite water mask + ramp → land only", ls?.ramp?.kind === "elevation" && ls.landOnly === true);
	const before = warns.length;
	ok("an unknown material is null and reported", groundMaterialOf({ type: "Stripe", uniforms: {} }, read) === null && warns.length === before + 1);
	ok("an unreadable ramp image is null", groundMaterialOf({ type: "ElevationRamp", uniforms: { image: {} } }, read) === null);
	const k1 = materialKey(ramp); ramp.uniforms.minimumHeight = -10000; const k2 = materialKey(ramp); ramp.uniforms.image = { width: 4, height: 1 }; const k3 = materialKey(ramp);
	ok("materialKey follows the uniforms and the image", k1 !== k2 && k2 !== k3 && materialKey(ramp) === k3);
}
{   // elevation bands: the layers baked into one ramp, later layers over earlier ones, ends transparent unless extended
	const bg = { entries: [{ height: 4200, color: new Color(0, 0, 0.2, 0.75) }, { height: 8000, color: new Color(1, 1, 1, 0.75) }], extendDownwards: true, extendUpwards: true };
	const band = { entries: [{ height: 6900, color: new Color(0, 0, 1, 0) }, { height: 6950, color: new Color(0, 0, 1, 1) }, { height: 7050, color: new Color(0, 0, 1, 1) }, { height: 7100, color: new Color(0, 0, 1, 0) }] };
	const r = bandRamp([bg, band], 1000);
	const at = h => { const i = Math.round((h - r.min) / (r.max - r.min) * 999) * 4; return Array.from(r.colors.subarray(i, i + 4)); };
	ok("bandRamp spans the layers' heights", r.min === 4200 && r.max === 8000, `${r.min}..${r.max}`);
	ok("bandRamp: the background at its low end", at(4200)[2] === 51 && at(4200)[3] === 191, at(4200).join());
	ok("bandRamp: the band is opaque blue in its middle", at(7000)[2] === 255 && at(7000)[0] === 0 && at(7000)[3] === 255, at(7000).join());
	ok("bandRamp: outside the band the background shows (grey, 0.75)", at(6000)[3] === 191 && Math.abs(at(6000)[0] - at(6000)[1]) < 2, at(6000).join());
	const r2 = bandRamp([band], 100);
	ok("bandRamp: a band that does not extend is transparent at the ramp's ends", r2.colors[3] === 0 && r2.colors[99 * 4 + 3] === 0 && r2.min < 6900 && r2.max > 7100);
	ok("bandRamp: a single entry extends both ways", bandRamp([{ entries: [{ height: 100, color: new Color(1, 0, 0, 1) }] }], 8).colors[3] === 255);
	const m = createElevationBandMaterial({ layers: [bg, band] });
	ok("createElevationBandMaterial makes an ElevationBand material that the globe can paint", m instanceof Material && m.type === "ElevationBand" && groundMaterialOf(m, () => null)?.ramp?.kind === "elevation");
	let threw = false; try { createElevationBandMaterial({ layers: [] }); } catch { threw = true; }
	ok("createElevationBandMaterial needs layers", threw);
}

// ── entity display: a ground polygon with classificationType CESIUM_3D_TILE / BOTH becomes a classification volume on the 3D Tiles (building-insert's yellow lot) ──
{
	const { EntityDisplay } = await import("../src/display.ts");
	const { ClassificationType, Entity: CEntity, JulianDate: CJulianDate, PolygonHierarchy } = await import("@cesium/engine");
	const calls = [], removed = [], srcData = [];
	const map = {
		addClassification: (data, opts) => { const h = { data, opts, remove: () => removed.push(h) }; calls.push(h); return h; },
		getSource: () => null, addSource: (id, s) => srcData.push(s.data), addLayer: () => {}, getLayer: () => null, removeLayer: () => {}, removeSource: () => {},
		overlay: () => ({ post: () => {}, remove: () => {} }), gadget: { model: () => Promise.resolve({ clear: () => {} }) }, clock: null,
	};
	const scene = { frameState: { time: CJulianDate.now() }, camera: null, drawingBufferWidth: 800, drawingBufferHeight: 600 };
	const disp = new EntityDisplay({ scene, dataSourceCollection: { length: 0, get: () => null }, host: { map, ready: Promise.resolve(map), display: null } });
	const ring = Cartesian3.fromDegreesArray([-105.0077, 39.7520, -105.0096, 39.7505, -105.0072, 39.7513, -105.0077, 39.7520]);
	const lot = disp.defaultDataSource.entities.add(new CEntity({ polygon: { hierarchy: new PolygonHierarchy(ring), material: Color.YELLOW.withAlpha(0.6), classificationType: ClassificationType.CESIUM_3D_TILE } }));
	const both = disp.defaultDataSource.entities.add(new CEntity({ polygon: { hierarchy: new PolygonHierarchy(ring), material: Color.RED.withAlpha(0.5), classificationType: ClassificationType.BOTH } }));
	disp.defaultDataSource.entities.add(new CEntity({ polygon: { hierarchy: new PolygonHierarchy(ring), material: Color.BLUE } }));   // no classificationType: a fill only
	const t = CJulianDate.now();
	disp.update(t);
	ok("display: CESIUM_3D_TILE and BOTH polygons each make one tiles3d classification volume", calls.length === 2 && calls.every(h => h.opts.type === "tiles3d" && h.data.type === "MultiPolygon"), `calls=${calls.length}`);
	ok("display: the volume carries the material's colour and alpha", calls[0]?.opts.color === "rgb(255,255,0)" && near(calls[0]?.opts.opacity, 0.6) && calls[1]?.opts.color === "rgb(255,0,0)" && near(calls[1]?.opts.opacity, 0.5), JSON.stringify(calls.map(h => [h.opts.color, h.opts.opacity])));
	const fills = (srcData[srcData.length - 1]?.features || []).filter(f => f.properties._k === "fill");
	ok("display: CESIUM_3D_TILE leaves the terrain unpainted, BOTH and the plain polygon are fills", fills.length === 2 && !fills.some(f => f.properties._fc === "rgb(255,255,0)"), `fills=${fills.length}`);
	disp.update(t);
	ok("display: an unchanged scene keeps its volumes", calls.length === 2 && removed.length === 0);
	disp.defaultDataSource.entities.remove(lot);
	disp.update(t);
	ok("display: removing the entity removes its volume", removed.length === 1 && removed[0] === calls[0] && calls.length === 2);
	both.polygon.material = Color.GREEN.withAlpha(0.5);
	disp.update(t);
	ok("display: a colour change replaces the volume", calls.length === 3 && removed.length === 2 && calls[2].opts.color === "rgb(0,128,0)", JSON.stringify(calls[2]?.opts));
	// a clamped polyline with CESIUM_3D_TILE: a band of its pixel width on the tiles (1 m/px without a camera), no ground line
	const road = disp.defaultDataSource.entities.add(new CEntity({ polyline: { positions: ring.slice(0, 3), width: 6, material: Color.YELLOW, clampToGround: true, classificationType: ClassificationType.CESIUM_3D_TILE } }));
	disp.update(t);
	const band = calls[3];
	ok("display: a clamped CESIUM_3D_TILE polyline makes a tiles3d band of its pixel width", calls.length === 4 && band?.data.type === "LineString" && band.opts.type === "tiles3d" && near(band.opts.width, 6) && band.opts.color === "rgb(255,255,0)", JSON.stringify(band?.opts));
	ok("display: the CESIUM_3D_TILE polyline draws no ground line", !(srcData[srcData.length - 1]?.features || []).some(f => f.properties._k === "line"));
	disp.defaultDataSource.entities.remove(road); disp.update(t);
	ok("display: removing the polyline removes its band", removed.length === 3 && removed[2] === band);
	disp.destroy();
	ok("display: destroy removes every volume", removed.length === 4);
}

// ── post: scene.postProcessStages → the globe's post chain (postprocess.ts, 順 4): the library stages by name, a user stage's GLSL + uniforms, bloom's uniforms → threshold/radius, what is skipped ──
{
	const { postChainOf, bloomOf, uniformValue } = await import("../src/postprocess.ts");
	const stage = (name, uniforms, extra = {}) => ({ name, enabled: true, uniforms, ...extra });
	const coll = (stages, o = {}) => ({ fxaa: { enabled: false }, bloom: { enabled: false, uniforms: {} }, ambientOcclusion: { enabled: false }, length: stages.length, get: i => stages[i], ...o });
	const sil = stage("czm_silhouette", { color: Color.YELLOW, length: 0.25 }), bw = stage("czm_black_and_white", { gradations: 5 }, { enabled: false });
	const r = postChainOf(coll([sil, bw, stage("czm_brightness", { brightness: 0.5 }), stage("czm_night_vision", {})], { fxaa: { enabled: true } }));
	ok("post: library stages by name, disabled ones dropped, fxaa last", JSON.stringify(r.chain) === JSON.stringify([{ type: "silhouette", color: [1, 1, 0, 1], length: 0.25 }, { type: "brightness", value: 0.5 }, { type: "nightVision" }, { type: "fxaa" }]), JSON.stringify(r.chain));
	const user = { name: "fog", enabled: true, fragmentShader: "void main(){}", uniforms: { fogByDistance: new (await import("@cesium/core")).Cartesian4(10, 0, 200, 1), fogColor: Color.BLACK, k: 2, on: true, tex: "img.png" } };
	const r2 = postChainOf(coll([user]));
	ok("post: a user stage carries its GLSL and uniforms (Cartesian4/Color/number/boolean), textures are skipped", r2.chain.length === 1 && r2.chain[0].type === "glsl" && r2.chain[0].src === "void main(){}" && JSON.stringify(r2.chain[0].uniforms) === JSON.stringify({ fogByDistance: [10, 0, 200, 1], fogColor: [0, 0, 0, 1], k: 2, on: true }) && r2.skipped.includes("postProcessStages texture uniforms"));
	const r3 = postChainOf(coll([stage("czm_silhouette", { color: Color.RED, length: 0.5 }, { selected: [{}] }), stage("czm_depth_of_field", {}), stage("czm_ambient_occlusion", {})], { bloom: { enabled: true, uniforms: { contrast: 128, brightness: -0.3, sigma: 3.78, stepSize: 5 } }, ambientOcclusion: { enabled: false } }));
	ok("post: per-feature (selected) and depth of field are skipped, ambient occlusion sets the flag, bloom comes from its uniforms", r3.chain.length === 1 && r3.chain[0].type === "bloom" && r3.ao && r3.skipped.length === 2, JSON.stringify(r3));
	const b = bloomOf({ contrast: 128, brightness: -0.3, sigma: 3.78, stepSize: 5 });
	ok("post: bloom threshold from contrast/brightness, radius from sigma×stepSize", near(b.threshold, 0.5 - 0.5 / ((259 * 383) / (255 * 131)) + 0.3, 1e-9) && b.radius === 4 && b.strength === 1, JSON.stringify(b));
	ok("post: uniformValue shapes", JSON.stringify([uniformValue(1), uniformValue(false), uniformValue(() => 3), uniformValue({ x: 1, y: 2 }), uniformValue("s")]) === "[1,false,3,[1,2],null]");
	ok("post: empty collection → nothing", postChainOf(coll([])).chain.length === 0 && postChainOf(null).chain.length === 0);
}

console.log(fails ? `${fails} FAILED` : "t-cesium: OK");
process.exit(fails ? 1 : 0);
