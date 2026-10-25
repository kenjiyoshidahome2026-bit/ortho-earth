// @ortho-earth/cesium: the parts that run without a browser (node only).
//   the camera bridge (Cesium pose ⇄ the globe's look-at camera, both ways) · glTF bounding spheres · 3D Tiles bounding volumes ·
//   imagery providers → raster sources · the unsupported report
// The browser part (Viewer, entities, the widgets) is the examples gate: packages/globe/tests/csexamples/run.mjs
import { Cartesian3, Ellipsoid, Matrix4, Rectangle } from "@cesium/core";
import { globeCamOf, poseOfGlobeCam, sameGlobeCam } from "../src/camera.ts";
import { gltfSphere } from "../src/gltf.ts";
import { sphereOfVolume } from "../src/tileset.ts";
import { rasterSourceOf } from "../src/imagery.ts";
import { unsupported, unsupportedReport } from "../src/report.ts";
import { glbOf } from "../src/primitives.ts";

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
	const sky = globeCamOf(pos, Cartesian3.UNIT_Z, Cartesian3.negate(dir, new Cartesian3()));   // looking north along the horizon at 1000 km: misses the globe
	ok("camera at the sky has a target", !!sky && sky.distance >= 1000 && sky.pitch <= 90, JSON.stringify(sky));
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
	const geo = rasterSourceOf(new UrlTemplateImageryProvider({ tilingScheme: new GeographicTilingScheme(), _resource: { _url: "https://g.example/{z}/{x}/{y}" } }));
	ok("geographic tiling is reported, not drawn", geo === null && warns.some(w => /geographic tiling scheme/.test(w)));
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

// ── the unsupported report: once per kind on the console, every time in the counts ──
{
	const before = warns.length;
	unsupported("test thing"); unsupported("test thing");
	ok("unsupported warns once", warns.length - before === 1 && /\[csshim\] unsupported: test thing/.test(warns[warns.length - 1]));
	ok("unsupported counts", unsupportedReport()["test thing"] === 2);
}

console.log(fails ? `${fails} FAILED` : "t-cesium: OK");
process.exit(fails ? 1 : 0);
