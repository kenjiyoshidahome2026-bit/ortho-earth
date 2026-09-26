// ベクタタイルの押し出し（段 8①）の検定試料＝node packages/globe/tests/fixtures/mlcompat/make-mvt.mjs
// OpenMapTiles 風の "building" 層（render_height・render_min_height・hide_3d・name・Feature.id）を持つ MVT を z13 1 枚＋z14 2×2 枚。
// 太平洋の上（140E・30N 付近＝既定の地形は海＝0）・z14 の 4 枚が接する角を原点に、角の周りへ 6 棟：
//   1 tall（北西・120m）／2 seam（北の縦の継ぎ目をまたぐ・40m）／3 court（南東・中庭の穴つき・50m）／4 L（南西・凹・20m）／
//   5 hidden（北東・hide_3d＝MapLibre の例の filter で消える・80m）／6 floating（北東・宙に浮く 20→60m）
// 段 8⑤（描く層）の試料も同じタイルへ：landuse（面・継ぎ目をまたぐ・名前つき）／road（線・継ぎ目をまたぐ）／poi（点＋name）＝建物から離れた西と南
// 出力：vt/{z}/{x}/{y}.pbf（XYZ）・vt.pmtiles（同じタイル・圧縮なし）・vt.json（TileJSON・相対の tiles）・vt-buildings.json（棟の中心と高さ＝検定がどこを押すか）
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Pbf from "geopbf/pbf";
import { zxyToTileId } from "pmtiles";

const HERE = dirname(fileURLToPath(import.meta.url));
const E = 4096, BUF = 64;
const lon2x = (lon, z) => (lon + 180) / 360 * 2 ** z;
const lat2y = (lat, z) => { const s = Math.sin(lat * Math.PI / 180); return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 2 ** z; };
const x2lon = (x, z) => x / 2 ** z * 360 - 180;
const y2lat = (y, z) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y / 2 ** z))) * 180 / Math.PI;

// 角＝z14 の偶数のタイル (x0, y0) の右下＝z13 の 1 枚の真ん中
const x0 = Math.floor(lon2x(140, 14)) & ~1, y0 = Math.floor(lat2y(30, 14)) & ~1;
const C = [x2lon(x0 + 1, 14), y2lat(y0 + 1, 14)];
const mE = 111320 * Math.cos(C[1] * Math.PI / 180), mN = 110574;   // 1 度あたりのメートル
const at = (e, n) => [C[0] + e / mE, C[1] + n / mN];
const rect = (ce, cn, w, h) => [at(ce - w / 2, cn - h / 2), at(ce + w / 2, cn - h / 2), at(ce + w / 2, cn + h / 2), at(ce - w / 2, cn + h / 2)];   // 経緯度で反時計回り
const B = [
	{ id: 1, name: "tall", rings: [rect(-150, 150, 40, 40)], props: { render_height: 120, render_min_height: 0 } },
	{ id: 2, name: "seam", rings: [rect(0, 150, 60, 40)], props: { render_height: 40, render_min_height: 0 } },
	{ id: 3, name: "court", rings: [rect(150, -150, 80, 80), rect(150, -150, 30, 30).reverse()], props: { render_height: 50, render_min_height: 0 } },
	{ id: 4, name: "L", rings: [[at(-180, -180), at(-120, -180), at(-120, -150), at(-150, -150), at(-150, -120), at(-180, -120)]], props: { render_height: 20, render_min_height: 0 } },
	{ id: 5, name: "hidden", rings: [rect(150, 150, 40, 40)], props: { render_height: 80, render_min_height: 0, hide_3d: true } },
	{ id: 6, name: "floating", rings: [rect(150, 60, 30, 30)], props: { render_height: 60, render_min_height: 20 } },
];
// 描く層（段 8⑤）：面は at の反時計回り・線は点列・点は 1 点
const LU = [
	{ id: 101, name: "Park", rings: [rect(-350, 0, 160, 160)], props: { class: "park" } },   // 横の継ぎ目（n=0）をまたぐ
	{ id: 102, name: "Lake", rings: [rect(0, -330, 200, 80)], props: { class: "water" } },   // 縦の継ぎ目（e=0）をまたぐ
];
const RD = [
	{ id: 201, name: "Main St", line: [at(-450, -230), at(450, -230)], props: { class: "primary" } },   // 縦の継ぎ目をまたぐ
	{ id: 202, name: "Side St", line: [at(-250, -450), at(-250, -250)], props: { class: "minor" } },
];
const PO = [
	{ id: 301, name: "Cafe", pt: at(350, -40), props: { class: "cafe" } },
	{ id: 302, name: "Shop", pt: at(-420, 330), props: { class: "shop" } },
];

// 輪をタイル座標へ（y 下向き）＋バッファの枠で切る（Sutherland–Hodgman）
function clip(pts, lo, hi) {
	const edge = (src, axis, c, ge) => {
		const out = [];
		for (let i = 0; i < src.length; i++) {
			const a = src[i], b = src[(i + 1) % src.length], ina = ge ? a[axis] >= c : a[axis] <= c, inb = ge ? b[axis] >= c : b[axis] <= c;
			if (ina !== inb) { const t = (c - a[axis]) / (b[axis] - a[axis]); out.push(axis ? [a[0] + t * (b[0] - a[0]), c] : [c, a[1] + t * (b[1] - a[1])]); }
			if (inb) out.push(b);
		}
		return out;
	};
	let p = pts;
	for (const [axis, c, ge] of [[0, lo, true], [0, hi, false], [1, lo, true], [1, hi, false]]) { if (!p.length) break; p = edge(p, axis, c, ge); }
	return p;
}
const zig = v => (v << 1) ^ (v >> 31);
const toTile = (z, x, y) => ([lon, lat]) => [Math.round((lon2x(lon, z) - x) * E), Math.round((lat2y(lat, z) - y) * E)];
// 線をバッファの枠で切る（線分ごと・枠の中の連なりを 1 本に）
function clipLine(pts, lo, hi) {
	const out = []; let cur = [];
	const inside = p => p[0] >= lo && p[0] <= hi && p[1] >= lo && p[1] <= hi;
	for (let i = 0; i + 1 < pts.length; i++) {
		let [a, b] = [pts[i], pts[i + 1]], t0 = 0, t1 = 1;
		const d = [b[0] - a[0], b[1] - a[1]];
		let ok = true;
		for (const [p, q] of [[-d[0], a[0] - lo], [d[0], hi - a[0]], [-d[1], a[1] - lo], [d[1], hi - a[1]]]) {
			if (p === 0) { if (q < 0) { ok = false; break; } continue; }
			const r = q / p;
			if (p < 0) { if (r > t1) { ok = false; break; } if (r > t0) t0 = r; } else { if (r < t0) { ok = false; break; } if (r < t1) t1 = r; }
		}
		if (!ok) { if (cur.length > 1) out.push(cur); cur = []; continue; }
		const A = [Math.round(a[0] + t0 * d[0]), Math.round(a[1] + t0 * d[1])], Bp = [Math.round(a[0] + t1 * d[0]), Math.round(a[1] + t1 * d[1])];
		if (!cur.length) cur.push(A);
		cur.push(Bp);
		if (t1 < 1) { out.push(cur); cur = []; }
	}
	if (cur.length > 1) out.push(cur);
	return out;
}
// 層ごとの地物（type 1＝点・2＝線・3＝面）→ { id, props, type, parts }（parts＝タイル座標の点列の列）
function layerFeatures(name, z, x, y) {
	const T = toTile(z, x, y), feats = [];
	const polys = name === "building" ? B : name === "landuse" ? LU : null;
	if (polys) for (const b of polys) {
		const rings = [];
		b.rings.forEach((r, k) => {
			// MVT の外周＝画面（y 下向き）で時計回り＝経緯度の反時計回りをそのまま写すと y が反転して時計回りになる。穴は逆
			let p = r.map(T);
			p = clip(p, -BUF, E + BUF).map(([a, c]) => [Math.round(a), Math.round(c)]);
			if (p.length >= 3) rings.push(p); else if (k === 0) rings.length = 0;
		});
		if (rings.length) feats.push({ id: b.id, props: { ...b.props, name: b.name }, type: 3, parts: rings });
	}
	if (name === "road") for (const r of RD) { const parts = clipLine(r.line.map(T), -BUF, E + BUF); if (parts.length) feats.push({ id: r.id, props: { ...r.props, name: r.name }, type: 2, parts }); }
	if (name === "poi") for (const p of PO) { const q = T(p.pt); if (q[0] >= -BUF && q[0] <= E + BUF && q[1] >= -BUF && q[1] <= E + BUF) feats.push({ id: p.id, props: { ...p.props, name: p.name }, type: 1, parts: [[q]] }); }
	return feats;
}
function encodeTile(z, x, y) {
	const layers = ["building", "landuse", "road", "poi"].map(n => [n, layerFeatures(n, z, x, y)]).filter(([, f]) => f.length);
	if (!layers.length) return null;
	const pbf = new Pbf();
	for (const [lname, feats] of layers) pbf.writeMessage(3, (_, p) => {   // tile.layers
		const keys = [], vals = [], kIdx = new Map(), vIdx = new Map();
		const keyOf = k => { if (!kIdx.has(k)) { kIdx.set(k, keys.length); keys.push(k); } return kIdx.get(k); };
		const valOf = v => { const s = typeof v + ":" + v; if (!vIdx.has(s)) { vIdx.set(s, vals.length); vals.push(v); } return vIdx.get(s); };
		p.writeVarintField(15, 2);        // version
		p.writeStringField(1, lname);
		for (const f of feats) p.writeMessage(2, (__, q) => {
			q.writeVarintField(1, f.id);
			const tags = [];
			for (const [k, v] of Object.entries(f.props)) tags.push(keyOf(k), valOf(v));
			q.writePackedVarint(2, tags);
			q.writeVarintField(3, f.type);
			const g = []; let cx = 0, cy = 0;
			if (f.type === 1) {
				g.push((1 & 7) | (f.parts.length << 3));
				for (const [[px, py]] of f.parts) { g.push(zig(px - cx), zig(py - cy)); cx = px; cy = py; }
			} else for (const r of f.parts) {
				g.push((1 & 7) | (1 << 3), zig(r[0][0] - cx), zig(r[0][1] - cy)); cx = r[0][0]; cy = r[0][1];
				g.push((2 & 7) | ((r.length - 1) << 3));
				for (let i = 1; i < r.length; i++) { g.push(zig(r[i][0] - cx), zig(r[i][1] - cy)); cx = r[i][0]; cy = r[i][1]; }
				if (f.type === 3) g.push((7 & 7) | (1 << 3));
			}
			q.writePackedVarint(4, g);
		});
		for (const k of keys) p.writeStringField(3, k);
		for (const v of vals) p.writeMessage(4, (___, w) => {
			if (typeof v === "string") w.writeStringField(1, v);
			else if (typeof v === "boolean") w.writeBooleanField(7, v);
			else if (Number.isInteger(v)) w.writeVarintField(5, v);
			else w.writeDoubleField(3, v);
		});
		p.writeVarintField(5, E);
	});
	return pbf.finish();
}

const tiles = [[13, x0 >> 1, y0 >> 1]];
for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) tiles.push([14, x0 + dx, y0 + dy]);
const out = [];
for (const [z, x, y] of tiles) {
	const buf = encodeTile(z, x, y);
	if (!buf) continue;
	const f = join(HERE, "vt", String(z), String(x), `${y}.pbf`);
	mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, buf);
	out.push({ z, x, y, buf: Buffer.from(buf) });
}

// ── PMTiles v3（圧縮なし・葉ディレクトリなし）──
const varint = (arr, v) => { while (v >= 0x80) { arr.push((v & 0x7f) | 0x80); v = Math.floor(v / 128); } arr.push(v); };
const ents = out.map(t => ({ id: zxyToTileId(t.z, t.x, t.y), buf: t.buf })).sort((a, b) => a.id - b.id);
let off = 0; for (const e of ents) { e.offset = off; e.length = e.buf.length; off += e.length; }
const dir = []; varint(dir, ents.length);
let last = 0; for (const e of ents) { varint(dir, e.id - last); last = e.id; }
for (const e of ents) varint(dir, 1);
for (const e of ents) varint(dir, e.length);
ents.forEach((e, i) => varint(dir, i > 0 && e.offset === ents[i - 1].offset + ents[i - 1].length ? 0 : e.offset + 1));
const meta = Buffer.from(JSON.stringify({ name: "t-mlcompat-vt", vector_layers: [{ id: "building", fields: { render_height: "Number", render_min_height: "Number", hide_3d: "Boolean", name: "String" } }, { id: "landuse", fields: { class: "String", name: "String" } }, { id: "road", fields: { class: "String", name: "String" } }, { id: "poi", fields: { class: "String", name: "String" } }] }));
const H = Buffer.alloc(127), rootOff = 127, metaOff = rootOff + dir.length, dataOff = metaOff + meta.length;
const bb = [at(-400, -400), at(400, 400)];
H.write("PMTiles", 0); H[7] = 3;
const u64 = (o, v) => H.writeBigUInt64LE(BigInt(v), o);
u64(8, rootOff); u64(16, dir.length); u64(24, metaOff); u64(32, meta.length); u64(40, 0); u64(48, 0); u64(56, dataOff); u64(64, off);
u64(72, ents.length); u64(80, ents.length); u64(88, ents.length);
H[96] = 1; H[97] = 1; H[98] = 1; H[99] = 1; H[100] = 13; H[101] = 14;   // clustered・内部圧縮なし・タイル圧縮なし・mvt・z13〜14
H.writeInt32LE(Math.round(bb[0][0] * 1e7), 102); H.writeInt32LE(Math.round(bb[0][1] * 1e7), 106); H.writeInt32LE(Math.round(bb[1][0] * 1e7), 110); H.writeInt32LE(Math.round(bb[1][1] * 1e7), 114);
H[118] = 14; H.writeInt32LE(Math.round(C[0] * 1e7), 119); H.writeInt32LE(Math.round(C[1] * 1e7), 123);
writeFileSync(join(HERE, "vt.pmtiles"), Buffer.concat([H, Buffer.from(dir), meta, ...ents.map(e => e.buf)]));

writeFileSync(join(HERE, "vt.json"), JSON.stringify({ tilejson: "3.0.0", name: "t-mlcompat-vt", attribution: "t-mlcompat fixture tiles", tiles: ["vt/{z}/{x}/{y}.pbf"], minzoom: 13, maxzoom: 14, bounds: [bb[0][0], bb[0][1], bb[1][0], bb[1][1]], vector_layers: [{ id: "building" }, { id: "landuse" }, { id: "road" }, { id: "poi" }] }, null, "\t") + "\n");
const centers = { corner: C, buildings: B.map(b => { const r = b.rings[0], lon = r.reduce((s, p) => s + p[0], 0) / r.length, lat = r.reduce((s, p) => s + p[1], 0) / r.length; return { id: b.id, name: b.name, center: [lon, lat], ...b.props }; }) };
centers.buildings.find(b => b.name === "L").center = at(-165, -165);   // L の中心は欠けた所に落ちる＝腕の上を押す
// 描く層（段 8⑤）の押す所：面の中・線の上・点
centers.draw = {
	park: at(-350, 0), parkEdge: at(-350 + 70, 0), lake: at(0, -330), outside: at(-350, -120),
	main: at(-100, -230), mainOff: at(-100, -215), side: at(-250, -350),
	cafe: PO[0].pt, shop: PO[1].pt,
};
writeFileSync(join(HERE, "vt-buildings.json"), JSON.stringify(centers, null, "\t") + "\n");
console.log(`tiles ${out.map(t => `${t.z}/${t.x}/${t.y}`).join(" ")} · pmtiles ${ents.length} entries · corner ${C.map(v => v.toFixed(6))}`);
