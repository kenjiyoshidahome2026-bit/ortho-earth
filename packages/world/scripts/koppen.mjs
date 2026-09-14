#!/usr/bin/env node
// ケッペン気候区分＝ out/climate-koppen.geopbf（Beck et al. 2023, Scientific Data 10:724・CC BY 4.0・1991–2020・0.1°）。Kenji 2026-09-15「30 区分は属性に残して塗りは大区分」
//   ラスタ（ラベル 1..30・0=海）を区分ごとに面にする: 区分の境界となるセル辺を集め、環に繋ぎ、共線の頂点を落とす（隣り合う区分同士は同じ辺を共有＝隙間も重なりも無い）。
//   1 区分 1 地物（MultiPolygon）。属性 id / code（Af…EF）/ group（A B C D E）/ name / color（Beck の RGB）/ period
//   TIFF は geopbf の COG 読み口（tiff.js / decode.js＝LZW・タイル）で読む＝GDAL 不要。
//   使い方: node scripts/koppen.mjs [--period 1991_2020] [--res 0p1] [--out PATH(拡張子なし)] [--geojson]
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { gzipSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GeoPBF } from "../../geopbf/src/pbf-base.js";
import { parseTiff } from "../../geopbf/src/cog/tiff.js";
import { decodeTile } from "../../geopbf/src/cog/decode.js";
globalThis.ImageData ??= class ImageData { constructor(data, width, height) { this.data = data; this.width = width; this.height = height; } };
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ARGS = process.argv.slice(2), opt = (n, d) => { const i = ARGS.indexOf("--" + n); return i < 0 ? d : (ARGS[i + 1] && !ARGS[i + 1].startsWith("--") ? ARGS[i + 1] : true); };
const PERIOD = typeof opt("period") === "string" ? opt("period") : "1991_2020", RES = typeof opt("res") === "string" ? opt("res") : "0p1";
const OUT = path.resolve(ROOT, typeof opt("out") === "string" ? opt("out") : "out/climate-koppen");
const T0 = Date.now(), log = (...a) => console.error(`[${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...a);
const tifPath = path.join(ROOT, `.cache/koppen/${PERIOD}/koppen_geiger_${RES}.tif`);
if (!existsSync(tifPath)) throw new Error(`${tifPath} が無い＝.cache/koppen/koppen_geiger_tif.zip（figshare 21789074）から unzip する`);
// ── 凡例 ──
const legend = {}; for (const l of (await readFile(path.join(ROOT, ".cache/koppen/legend.txt"), "utf8")).split("\n")) { const m = l.match(/^\s*(\d+):\s+(\w+)\s+(.+?)\s+\[(\d+) (\d+) (\d+)\]/); if (m) legend[+m[1]] = { code: m[2], name: m[3].trim(), color: [+m[4], +m[5], +m[6]] }; }
// ── ラスタ ──
const buf = new Uint8Array(await readFile(tifPath));
const t = await parseTiff(async (from, len) => buf.subarray(from, from + len));
const ifd = t.ifds[0], W = ifd.width, H = ifd.height, le = t.littleEndian;
const grid = new Uint8Array(W * H);
for (let ty = 0; ty < ifd.tilesY; ty++) for (let tx = 0; tx < ifd.tilesX; tx++) {
	const i = ty * ifd.tilesX + tx, off = ifd.offsets[i], cnt = ifd.counts[i]; if (!cnt) continue;
	const { data } = await decodeTile(buf.subarray(off, off + cnt), ifd, le);
	for (let y = 0; y < ifd.tileH; y++) { const gy = ty * ifd.tileH + y; if (gy >= H) break; for (let x = 0; x < ifd.tileW; x++) { const gx = tx * ifd.tileW + x; if (gx >= W) break; grid[gy * W + gx] = data[y * ifd.tileW + x]; } }
}
const [x0, y0] = [t.geo.x0 ?? t.bbox[0], t.geo.y0 ?? t.bbox[3]], dx = (t.bbox[2] - t.bbox[0]) / W, dy = (t.bbox[3] - t.bbox[1]) / H;
const lon = x => +(t.bbox[0] + x * dx).toFixed(4), lat = y => +(t.bbox[3] - y * dy).toFixed(4);
const hist = new Array(31).fill(0); for (const v of grid) hist[v]++;
log(`raster ${W}×${H}・陸セル ${grid.length - hist[0]}・区分 ${hist.slice(1).filter(Boolean).length}`);
// ── 区分ごとの面 ──
const at = (x, y) => (x < 0 || y < 0 || x >= W || y >= H) ? 0 : grid[y * W + x];
function vectorize(c) {
	// セルを画面座標で時計回りに辿る向きの辺（上: (x,y)→(x+1,y)・右・下・左）。区分の外側と接する辺だけ集める
	const key = (x, y) => y * (W + 1) + x, outE = new Map();   // 始点 → [終点…]
	const add = (ax, ay, bx, by) => { const k = key(ax, ay); let a = outE.get(k); if (!a) outE.set(k, a = []); a.push(key(bx, by)); };
	for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
		if (grid[y * W + x] !== c) continue;
		if (at(x, y - 1) !== c) add(x, y, x + 1, y); if (at(x + 1, y) !== c) add(x + 1, y, x + 1, y + 1);
		if (at(x, y + 1) !== c) add(x + 1, y + 1, x, y + 1); if (at(x - 1, y) !== c) add(x, y + 1, x, y);
	}
	const rings = [];
	const dirOf = (a, b) => { const ax = a % (W + 1), ay = (a - ax) / (W + 1), bx = b % (W + 1), by = (b - bx) / (W + 1); return [bx - ax, by - ay]; };
	for (const [start, list] of outE) {
		while (list.length) {
			let prev = start, cur = list.pop(); const ring = [start, cur];
			while (cur !== start) {
				const cand = outE.get(cur); if (!cand || !cand.length) { ring.length = 0; break; }
				let pick = 0;
				if (cand.length > 1) {   // 鞍点: 右折を優先（対角の同区分セルを別の環に分ける）
					const [dx1, dy1] = dirOf(prev, cur); let best = -9;
					cand.forEach((n, i) => { const [dx2, dy2] = dirOf(cur, n); const cross = dx1 * dy2 - dy1 * dx2, dot = dx1 * dx2 + dy1 * dy2; const score = cross > 0 ? 3 : dot > 0 ? 2 : cross < 0 ? 1 : 0; if (score > best) { best = score; pick = i; } });
				}
				const next = cand.splice(pick, 1)[0]; prev = cur; cur = next; ring.push(cur);
			}
			if (ring.length) rings.push(ring);
		}
	}
	// 共線の頂点を落とし、経緯度へ
	const polys = rings.map(r => {
		const pts = r.slice(0, -1).map(k => { const x = k % (W + 1); return [x, (k - x) / (W + 1)]; });
		const out = [];
		for (let i = 0; i < pts.length; i++) { const p = pts[(i + pts.length - 1) % pts.length], q = pts[i], n = pts[(i + 1) % pts.length]; if ((q[0] - p[0]) * (n[1] - q[1]) - (q[1] - p[1]) * (n[0] - q[0]) !== 0) out.push(q); }
		let a = 0; for (let i = 0, j = out.length - 1; i < out.length; j = i++) a += out[j][0] * out[i][1] - out[i][0] * out[j][1];
		return { pts: out, area: a };   // 画面座標の符号付き面積（時計回りの外環＝正）
	}).filter(p => p.pts.length >= 3);
	const outers = polys.filter(p => p.area > 0).sort((u, v) => v.area - u.area), holes = polys.filter(p => p.area < 0);
	const bbox = p => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const [x, y] of p.pts) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } return [x0, y0, x1, y1]; };
	for (const o of outers) { o.bb = bbox(o); o.holes = []; }
	const pip = (pts, x, y) => { let ins = false; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) { const [xi, yi] = pts[i], [xj, yj] = pts[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) ins = !ins; } return ins; };
	for (const h of holes) {   // 穴＝それを含む最小の外環へ（外環は面積降順なので最後に当たったものが最小）
		const [hx, hy] = h.pts[0]; const cx = hx + 0.5, cy = hy + 0.5;   // 頂点は外環上に乗り得るので少し内側の点で判定
		let owner = null; for (const o of outers) if (cx >= o.bb[0] && cx <= o.bb[2] && cy >= o.bb[1] && cy <= o.bb[3] && pip(o.pts, cx, cy)) owner = o;
		if (owner) owner.holes.push(h); 
	}
	const toLL = pts => { const r = pts.map(([x, y]) => [lon(x), lat(y)]); r.push(r[0]); return r; };
	return outers.map(o => [toLL(o.pts), ...o.holes.map(h => toLL(h.pts))]);
}
const features = [];
for (let c = 1; c <= 30; c++) {
	if (!hist[c]) continue;
	const polys = vectorize(c), lg = legend[c];
	features.push({ type: "Feature", properties: { id: c, code: lg.code, group: lg.code[0], name: lg.name, color: lg.color, period: PERIOD.replace("_", "–"), cells: hist[c] }, geometry: { type: "MultiPolygon", coordinates: polys } });
	log(`${lg.code.padEnd(4)} ${lg.name.padEnd(38)} cells ${String(hist[c]).padStart(7)} polygons ${polys.length}`);
}
const pbf = await new GeoPBF({ name: "climate-koppen", precision: 4, attribution: "Köppen–Geiger climate classification: Beck, H. E. et al. (2023) High-resolution (1 km) Köppen–Geiger maps for 1901–2099 based on constrained CMIP6 projections, Scientific Data 10, 724 (CC BY 4.0)", description: `Köppen–Geiger ${PERIOD.replace("_", "–")} at ${RES.replace("p", ".")}°: one MultiPolygon per class (id/code/group/name/color)` }).set({ type: "FeatureCollection", name: "climate-koppen", features });
const out = gzipSync(Buffer.from(pbf.arrayBuffer), { level: 9 });
await mkdir(path.dirname(OUT), { recursive: true }); await writeFile(OUT + ".geopbf", out);
if (opt("geojson", false)) await writeFile(OUT + ".geojson", JSON.stringify({ type: "FeatureCollection", features }));
let verts = 0; const walk = c => Array.isArray(c[0]) ? c.forEach(walk) : verts++; for (const f of features) walk(f.geometry.coordinates);
log(`${OUT}.geopbf: ${features.length} 区分・頂点 ${verts}・${(out.length / 1e6).toFixed(1)} MB (gzip)`);
