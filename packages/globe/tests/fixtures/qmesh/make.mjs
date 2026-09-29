// quantized-mesh（#110）の検定試料＝node tests/fixtures/qmesh/make.mjs（packages/globe で）
// t-dem と同じ円錐（150.5E 30.5N・高さ 3000m・半径 0.3°・海の上＝既定の標高は 0）を quantized-mesh で。z7〜z10・各タイル 33×33 の格子・gzip のまま置く。
// 高さは**楕円体高**（標高＋ジオイド高 N・EGM96 30 分＝core geoid.js）＝読み手がジオイドを引けば 3000m に戻る（heights:"orthometric" で読むと N だけ高い）。
import { writeFileSync, mkdirSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { encodeQuantizedMesh, qmTileAt, qmTileBounds } from "../../../../ortho-core/src/qmesh.js";
import { loadGeoid, geoidHeight } from "../../../../ortho-core/src/geoid.js";
const DIR = path.dirname(fileURLToPath(import.meta.url));
await loadGeoid();
const C = [150.5, 30.5], R = 0.3, PEAK = 3000, G = 33;
const ortho = (lon, lat) => PEAK * Math.max(0, 1 - Math.hypot((lon - C[0]) * Math.cos(lat * Math.PI / 180), lat - C[1]) / R);
const available = [];
for (let z = 0; z <= 10; z++) {
	if (z < 7) { available.push([]); continue; }
	const [x0, y0] = qmTileAt(z, 150, 30), [x1, y1] = qmTileAt(z, 151 - 1e-9, 31 - 1e-9);
	available.push([{ startX: x0, startY: y0, endX: x1, endY: y1 }]);
	for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
		const [w, s, e, n] = qmTileBounds(z, x, y), verts = [], tris = [];
		for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) {
			const u = Math.round(i / (G - 1) * 32767), v = Math.round(j / (G - 1) * 32767), lon = w + u / 32767 * (e - w), lat = s + v / 32767 * (n - s);
			verts.push([u, v, ortho(lon, lat) + geoidHeight(lon, lat)]);
		}
		const order = [], seen = new Map(), m = i => { if (!seen.has(i)) { seen.set(i, order.length); order.push(i); } return seen.get(i); };
		for (let j = 0; j < G - 1; j++) for (let i = 0; i < G - 1; i++) { const a = j * G + i, b = a + 1, c = a + G, d = c + 1; tris.push([a, b, c].map(m), [b, d, c].map(m)); }
		const vs = order.map(i => verts[i]), hs = vs.map(v => v[2]);
		const ab = encodeQuantizedMesh({ verts: vs, tris, minH: Math.min(...hs), maxH: Math.max(...hs) });
		mkdirSync(path.join(DIR, `${z}/${x}`), { recursive: true });
		writeFileSync(path.join(DIR, `${z}/${x}/${y}.terrain`), gzipSync(Buffer.from(ab)));
	}
}
writeFileSync(path.join(DIR, "layer.json"), JSON.stringify({ tilejson: "2.1.0", format: "quantized-mesh-1.0", version: "1.0.0", scheme: "tms", projection: "EPSG:4326",
	tiles: ["{z}/{x}/{y}.terrain?v={version}"], minzoom: 0, maxzoom: 10, bounds: [150, 30, 151, 31], available }, null, 1));
console.log("ok N(150.5,30.5) =", geoidHeight(150.5, 30.5).toFixed(2), "m");
