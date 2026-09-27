#!/usr/bin/env node
// MVT → MLT の変換道具（開発時だけ・#88）。手元に MLT のデータが無いので、既存の MVT（地理院ベクタのタイル・world-z3.pmtiles・検定の試料）から
// MLT のタイルと PMTiles（tileType 6）を作る。解読は core の decodeMVT・書き出しは @maplibre/mlt の encodeTile（最も素朴な符号化＝辞書も RLE も
// Morton も三角形分割も無し・ライブラリの注記どおり Java／Rust の出力より大きいが同じ地物に解ける）。
// 使い方：
//   node packages/tile-formats/scripts/mvt2mlt.mjs <入力> <出力ディレクトリ> [--pmtiles <出力.pmtiles>] [--name <名前>] [--no-tiles]
//   <入力>＝{z}/{x}/{y}.pbf を持つディレクトリ（.pbf／.mvt）か、MVT の PMTiles（ヘッダのズーム域と bbox の中の全タイルを引く）
//   出力＝<出力ディレクトリ>/{z}/{x}/{y}.mlt（--no-tiles で省略）・--pmtiles＝同じタイルを tileType 6 の PMTiles に（圧縮なし・root directory だけ＝数千枚まで）
// 検定（tests/t-mlt.mjs）は toMLTLayers／mvtToMLT／writePMTiles を import して使う。
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { register } from "node:module";
register("../src/node-hook.mjs", import.meta.url);   // @maplibre/mlt の拡張子なし import を Node で解く
const { encodeTile } = await import("@maplibre/mlt");
const { decodeMVT, polygons } = await import("@ortho-earth/core/decode");

// decodeMVT の出力（層名 → { extent, features }）→ encodeTile の Layer[]。
// 点／線の複数パート＝Multi*・面＝polygons()（符号付き面積）で外周と穴に分けて Polygon／MultiPolygon・輪の閉じ点は落とす（encodeTile の約束）
export function toMLTLayers(layers) {
	const out = [];
	for (const [name, L] of Object.entries(layers)) {
		if (name === "__empty" || !L?.features) continue;
		const features = [];
		for (const f of L.features) {
			const geometry = geometryOf(f);
			if (!geometry) continue;
			const properties = {};
			for (const [k, v] of Object.entries(f.props || {})) if (v !== null && v !== undefined) properties[k] = v;
			features.push({ ...(f.id !== undefined ? { id: f.id } : {}), geometry, properties });
		}
		out.push({ name, extent: L.extent || 4096, features });
	}
	return out;
}
function geometryOf(f) {
	const { coords: c, ends } = f.geom;
	const part = (s, e) => { const a = []; for (let i = s; i < e; i += 2) a.push([c[i], c[i + 1]]); return a; };
	if (f.type === "Point") {
		const pts = []; let s = 0; for (const e of ends) { for (let i = s; i < e; i += 2) pts.push([c[i], c[i + 1]]); s = e; }
		if (!pts.length) return null;
		return pts.length === 1 ? { type: "Point", coordinates: pts[0] } : { type: "MultiPoint", coordinates: pts };
	}
	if (f.type === "LineString") {
		const parts = []; let s = 0; for (const e of ends) { if (e - s >= 4) parts.push(part(s, e)); s = e; }
		if (!parts.length) return null;
		return parts.length === 1 ? { type: "LineString", coordinates: parts[0] } : { type: "MultiLineString", coordinates: parts };
	}
	const polys = [];
	for (const [flat, holes] of polygons(f.geom)) {
		const bounds = [0, ...holes.map(h => h * 2), flat.length], rings = [];
		for (let k = 0; k + 1 < bounds.length; k++) {
			const ring = []; for (let i = bounds[k]; i < bounds[k + 1]; i += 2) ring.push([flat[i], flat[i + 1]]);
			if (ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]) ring.pop();   // 閉じ点を落とす
			if (ring.length >= 3) rings.push(ring);
		}
		if (rings.length) polys.push(rings);
	}
	if (!polys.length) return null;
	return polys.length === 1 ? { type: "Polygon", coordinates: polys[0] } : { type: "MultiPolygon", coordinates: polys };
}
export const mvtToMLT = bytes => encodeTile(toMLTLayers(decodeMVT(new Uint8Array(bytes))));

// ── PMTiles v3 の書き出し（圧縮なし・root directory だけ・globe の検定試料 make-mvt.mjs と同じ最小形）──
export async function writePMTiles(path, tiles, { tileType = 6, metadata = {}, bounds = null, center = null } = {}) {
	const { zxyToTileId } = await import("pmtiles");
	const varint = (arr, v) => { while (v >= 0x80) { arr.push((v & 0x7f) | 0x80); v = Math.floor(v / 128); } arr.push(v); };
	const ents = tiles.map(t => ({ id: zxyToTileId(t.z, t.x, t.y), buf: Buffer.from(t.buf), z: t.z, x: t.x, y: t.y })).sort((a, b) => a.id - b.id);
	if (ents.length > 20000) throw new Error("writePMTiles: too many tiles for a root-only directory");
	let off = 0; for (const e of ents) { e.offset = off; e.length = e.buf.length; off += e.length; }
	const dir = []; varint(dir, ents.length);
	let last = 0; for (const e of ents) { varint(dir, e.id - last); last = e.id; }
	for (const e of ents) varint(dir, 1);
	for (const e of ents) varint(dir, e.length);
	ents.forEach((e, i) => varint(dir, i > 0 && e.offset === ents[i - 1].offset + ents[i - 1].length ? 0 : e.offset + 1));
	const meta = Buffer.from(JSON.stringify(metadata));
	const zs = ents.map(e => e.z), minZ = Math.min(...zs), maxZ = Math.max(...zs);
	const H = Buffer.alloc(127), rootOff = 127, metaOff = rootOff + dir.length, dataOff = metaOff + meta.length;
	H.write("PMTiles", 0); H[7] = 3;
	const u64 = (o, v) => H.writeBigUInt64LE(BigInt(v), o);
	u64(8, rootOff); u64(16, dir.length); u64(24, metaOff); u64(32, meta.length); u64(40, 0); u64(48, 0); u64(56, dataOff); u64(64, off);
	u64(72, ents.length); u64(80, ents.length); u64(88, ents.length);
	H[96] = 1; H[97] = 1; H[98] = 1; H[99] = tileType; H[100] = minZ; H[101] = maxZ;   // clustered・内部圧縮なし・タイル圧縮なし・tileType・ズーム域
	const bb = bounds || tilesBounds(ents);
	H.writeInt32LE(Math.round(bb[0] * 1e7), 102); H.writeInt32LE(Math.round(bb[1] * 1e7), 106); H.writeInt32LE(Math.round(bb[2] * 1e7), 110); H.writeInt32LE(Math.round(bb[3] * 1e7), 114);
	const c = center || [(bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2];
	H[118] = minZ; H.writeInt32LE(Math.round(c[0] * 1e7), 119); H.writeInt32LE(Math.round(c[1] * 1e7), 123);
	const out = Buffer.concat([H, Buffer.from(dir), meta, ...ents.map(e => e.buf)]);
	if (path) writeFileSync(path, out);
	return out;
}
const x2lon = (x, z) => x / 2 ** z * 360 - 180;
const y2lat = (y, z) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y / 2 ** z))) * 180 / Math.PI;
function tilesBounds(ents) {
	let w = 180, s = 90, e = -180, n = -90;
	for (const t of ents) { w = Math.min(w, x2lon(t.x, t.z)); e = Math.max(e, x2lon(t.x + 1, t.z)); s = Math.min(s, y2lat(t.y + 1, t.z)); n = Math.max(n, y2lat(t.y, t.z)); }
	return [w, s, e, n];
}

// ── 入力を読む：ディレクトリ（z/x/y.pbf）か PMTiles ──
function readTileDir(dir) {
	const out = [];
	for (const z of readdirSync(dir)) {
		if (!/^\d+$/.test(z) || !statSync(join(dir, z)).isDirectory()) continue;
		for (const x of readdirSync(join(dir, z))) {
			if (!/^\d+$/.test(x)) continue;
			for (const f of readdirSync(join(dir, z, x))) { const m = /^(\d+)\.(pbf|mvt)$/.exec(f); if (m) out.push({ z: +z, x: +x, y: +m[1], buf: readFileSync(join(dir, z, x, f)) }); }
		}
	}
	return out;
}
async function readPMTiles(path) {
	const { PMTiles } = await import("pmtiles");
	const fd = openSync(path, "r"), size = statSync(path).size;
	const source = { getKey: () => path, getBytes: async (offset, length) => { const b = Buffer.alloc(Math.min(length, size - offset)); readSync(fd, b, 0, b.length, offset); return { data: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) }; } };
	const pm = new PMTiles(source), h = await pm.getHeader(), md = await pm.getMetadata().catch(() => ({}));
	if (h.tileType !== 1) throw new Error(`input PMTiles is not MVT (tileType ${h.tileType})`);
	const lon2x = (lon, z) => Math.floor((lon + 180) / 360 * 2 ** z), lat2y = (lat, z) => { const s = Math.sin(lat * Math.PI / 180); return Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 2 ** z); };
	const tiles = [];
	for (let z = h.minZoom; z <= h.maxZoom; z++) {
		const n = 2 ** z, x0 = Math.max(0, lon2x(h.minLon, z)), x1 = Math.min(n - 1, lon2x(h.maxLon - 1e-9, z)), y0 = Math.max(0, lat2y(Math.min(85.05, h.maxLat), z)), y1 = Math.min(n - 1, lat2y(Math.max(-85.05, h.minLat) + 1e-9, z));
		for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) { const t = await pm.getZxy(z, x, y); if (t?.data?.byteLength) tiles.push({ z, x, y, buf: Buffer.from(t.data) }); }
	}
	closeSync(fd);
	return { tiles, metadata: md, bounds: [h.minLon, h.minLat, h.maxLon, h.maxLat], center: [h.centerLon, h.centerLat] };
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
	const args = process.argv.slice(2), opt = {}, pos = [];
	for (let i = 0; i < args.length; i++) { const a = args[i]; if (a === "--pmtiles") opt.pmtiles = args[++i]; else if (a === "--name") opt.name = args[++i]; else if (a === "--no-tiles") opt.noTiles = true; else pos.push(a); }
	const [input, outDir] = pos;
	if (!input || !outDir) { console.error("usage: mvt2mlt.mjs <tiles dir | mvt.pmtiles> <out dir> [--pmtiles out.pmtiles] [--name name] [--no-tiles]"); process.exit(2); }
	const src = statSync(input).isDirectory() ? { tiles: readTileDir(input), metadata: null, bounds: null, center: null } : await readPMTiles(input);
	const tiles = [];
	let inBytes = 0, outBytes = 0;
	for (const t of src.tiles) {
		const mlt = mvtToMLT(t.buf);
		inBytes += t.buf.length; outBytes += mlt.length;
		tiles.push({ z: t.z, x: t.x, y: t.y, buf: mlt });
		if (!opt.noTiles) { const f = join(resolve(outDir), String(t.z), String(t.x), `${t.y}.mlt`); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, mlt); }
	}
	if (opt.pmtiles) {
		const layers = new Set(); for (const t of src.tiles) for (const n of Object.keys(decodeMVT(new Uint8Array(t.buf)))) layers.add(n);
		const metadata = { ...(src.metadata || {}), name: opt.name || src.metadata?.name || "mvt2mlt", vector_layers: src.metadata?.vector_layers || [...layers].map(id => ({ id })) };
		await writePMTiles(resolve(opt.pmtiles), tiles, { tileType: 6, metadata, bounds: src.bounds, center: src.center });
	}
	console.log(`mvt2mlt: ${tiles.length} tiles  MVT ${inBytes} B → MLT ${outBytes} B${opt.pmtiles ? `  pmtiles → ${opt.pmtiles}` : ""}`);
}
