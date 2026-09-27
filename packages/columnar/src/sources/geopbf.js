// sources/geopbf.js ── メモリ上の GeoPBF → 列チャンク（#90・作り方その 2）。
// GeoPBF の書式は平たい feature の列で索引も row group も無い（pbf spec.md §3）＝丸ごと手元に置き、feature ごとの位置と bbox を
// 一度だけ走査（ワイヤ整数のまま・kernels.js ④ と同じ読み方）→ 空間順（geopbf/spatial-order・既定 str）に並べ替え → 一定の feature 数か
// 頂点数ごとに切ってチャンクにする。幾何はチャンクを作る時にもう一度だけ復号する（走査で全頂点を持たない＝100MB 級でもメモリが膨れない）。
// 属性は KEYS と VALUE から paint が参照する列だけ（getProperties の行配列＝keys に揃った配列）。gint は通らない。
import { GeoPBF } from "geopbf/pbf-base";
import Pbf from "geopbf/pbf";
import { spatialOrder } from "geopbf/spatial-order";
import { flatBuilder, K } from "../flat.js";
import { shareStats } from "../share.js";

const { TAGS } = GeoPBF;
const isGzip = u8 => u8.length > 2 && u8[0] === 0x1f && u8[1] === 0x8b;
async function gunzip(u8) {
	const ds = new DecompressionStream("gzip");
	const buf = await new Response(new Blob([u8]).stream().pipeThrough(ds)).arrayBuffer();
	return new Uint8Array(buf);
}
async function toU8(src) {
	if (src instanceof Uint8Array) return src;
	if (src instanceof ArrayBuffer) return new Uint8Array(src);
	if (typeof Blob !== "undefined" && src instanceof Blob) return new Uint8Array(await src.arrayBuffer());
	if (src && src.arrayBuffer instanceof ArrayBuffer) return new Uint8Array(src.arrayBuffer);   // GeoPBF オブジェクト（構造化複製できないので main が arrayBuffer を渡す）
	throw new Error("geopbf source: ArrayBuffer / Uint8Array / Blob expected");
}

// 1 幾何の復号（ワイヤ整数・デルタはパートごと＝readGeomInt と同じ規約）。onPart(kind)・onXY(x,y)（整数）・onEnd()
function walkGeom(P, pos, type, onPart, onXY, onEnd) {
	P.pos = pos;
	const lens = [];
	P.readMessage((tag) => {
		if (tag === TAGS.LENGTH) P.readPackedVarint(lens);
		else if (tag === TAGS.COORDS) {
			const end = P.readVarint() + P.pos;
			const run = (n, kind) => { onPart(kind); let x = 0, y = 0; for (let i = 0; i < n; i++) { x += P.readSVarint(); y += P.readSVarint(); onXY(x, y); } onEnd(kind); };
			if (type === 0) run(1, K.POINT);
			else if (type === 1) { let x = 0, y = 0; while (P.pos < end) { x += P.readSVarint(); y += P.readSVarint(); onPart(K.POINT); onXY(x, y); onEnd(K.POINT); } }
			else if (type === 2) { onPart(K.LINE); let x = 0, y = 0; while (P.pos < end) { x += P.readSVarint(); y += P.readSVarint(); onXY(x, y); } onEnd(K.LINE); }
			else if (type === 3) for (const n of lens) run(n, K.LINE);
			else if (type === 4) lens.forEach((n, i) => run(n, i === 0 ? K.OUTER : K.HOLE));
			else if (type === 5) { let p = 0; const np = lens[p++]; for (let i = 0; i < np; i++) { const nr = lens[p++]; for (let j = 0; j < nr; j++) run(lens[p++], j === 0 ? K.OUTER : K.HOLE); } }
		}
	}, {});
}
function walkFeature(pbf, i, onPart, onXY, onEnd) {
	const m = pbf.fmap[i];
	if (m[2] === undefined) return;
	const P = pbf.pbf;
	if (m[2] === 6) { for (let j = 0; j < m[3].length; j++) walkGeom(P, m[3][j], m[4][j], onPart, onXY, onEnd); }
	else walkGeom(P, m[1], m[2], onPart, onXY, onEnd);
}

const CHUNK_FEATURES = 8192, CHUNK_VERTICES = 400_000;

export const GEOPBF_SOURCE = {
	name: "geopbf",
	test: ({ name, head }) => /\.geopbf(\.gz)?$/i.test(name || "") || (!/\.(geo)?parquet$/i.test(name || "") && head.length > 0 && (isGzip(head) || head[0] === 0x0a || head[0] === 0x12 || head[0] === 0x18)),   // 名前で分からなければ先頭バイト（gzip か protobuf の NAME/KEYS/PRECISION タグ）
	async open(src, { name = "", chunkFeatures = CHUNK_FEATURES, chunkVertices = CHUNK_VERTICES, order = "str" } = {}) {
		let u8 = await toU8(src);
		if (isGzip(u8)) u8 = await gunzip(u8);
		const pbf = new GeoPBF();
		pbf.pbf = new Pbf(u8);
		await pbf.getPosition({ skipProps: true });
		const n = pbf.length, D = Math.pow(10, pbf.precision()), keys = pbf.keys;
		// ── 走査：feature ごとの bbox（整数）・頂点数・バイト数
		const bb = new Float64Array(n * 4), verts = new Uint32Array(n), bytes = new Uint32Array(n), P = pbf.pbf;
		let x0, y0, x1, y1, vc;
		const onPart = () => {}, onEnd = () => {};
		const onXY = (x, y) => { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; vc++; };
		const types = new Set();
		for (let i = 0; i < n; i++) {
			x0 = y0 = Infinity; x1 = y1 = -Infinity; vc = 0;
			walkFeature(pbf, i, onPart, onXY, onEnd);
			bb[i * 4] = x0; bb[i * 4 + 1] = y0; bb[i * 4 + 2] = x1; bb[i * 4 + 3] = y1; verts[i] = vc;
			const m = pbf.fmap[i]; P.pos = m[0]; const len = P.readVarint(); bytes[i] = P.pos - m[0] + len;
			if (m[2] !== undefined) types.add(m[2]);
		}
		const has = i => verts[i] > 0;
		const perm = spatialOrder(order, bb, has, n, chunkFeatures) ?? Array.from({ length: n }, (_, i) => i);
		// ── 切り分け：feature 数か頂点数の上限で
		const chunks = [], lists = [], cverts = [];
		let cur = [], cv = 0, cbytes = 0, cb = [Infinity, Infinity, -Infinity, -Infinity];
		const flush = () => { if (!cur.length) return; chunks.push({ bbox: cb.map((v, k) => v / D), rows: cur.length, bytes: cbytes }); lists.push(Int32Array.from(cur)); cverts.push(cv); cur = []; cv = 0; cbytes = 0; cb = [Infinity, Infinity, -Infinity, -Infinity]; };
		for (const i of perm) {
			if (!has(i)) continue;   // 幾何なしは載せない
			cur.push(i); cv += verts[i]; cbytes += bytes[i];
			if (bb[i * 4] < cb[0]) cb[0] = bb[i * 4]; if (bb[i * 4 + 1] < cb[1]) cb[1] = bb[i * 4 + 1]; if (bb[i * 4 + 2] > cb[2]) cb[2] = bb[i * 4 + 2]; if (bb[i * 4 + 3] > cb[3]) cb[3] = bb[i * 4 + 3];
			if (cur.length >= chunkFeatures || cv >= chunkVertices) flush();
		}
		flush();
		let gb = null;
		for (const c of chunks) gb = gb ? [Math.min(gb[0], c.bbox[0]), Math.min(gb[1], c.bbox[1]), Math.max(gb[2], c.bbox[2]), Math.max(gb[3], c.bbox[3])] : c.bbox.slice();
		// 列＝KEYS。数値かどうかは先頭 256 行の標本で（レンジは range() で数える）
		const sample = Math.min(n, 256), kinds = new Array(keys.length).fill(0);
		for (let i = 0; i < sample; i++) { let r; try { pbf.getProperties(i); r = pbf.props[i]; } catch { continue; } if (!r) continue; for (let k = 0; k < keys.length; k++) { const v = r[k]; if (v == null) continue; kinds[k] |= typeof v === "number" ? 1 : 2; } }
		const columns = keys.map((k, i) => ({ name: k, numeric: kinds[i] === 1 }));
		const TN = ["Point", "MultiPoint", "LineString", "MultiLineString", "Polygon", "MultiPolygon", "GeometryCollection"];
		const meta = { name: pbf.name?.() || name, rows: n, chunks, columns, range: {}, bbox: gb, types: [...types].map(t => TN[t]), precision: pbf.precision(), size: u8.byteLength, kind: "geopbf", share: null };
		let flat0 = null;   // 先頭チャンクのフラット幾何（共有の物差しに読んだ分＝最初の readGeometry(0) で使い切る）
		const rowOf = (row) => { let r = pbf.props[row]; if (r === undefined) { pbf.getProperties(row); r = pbf.props[row]; } return r; };
		const rangeCache = new Map();
		const reader = {
			meta,
			select(bbox) { const out = []; for (let g = 0; g < chunks.length; g++) { const b = chunks[g].bbox; if (!bbox || (b[0] <= bbox[2] && b[2] >= bbox[0] && b[1] <= bbox[3] && b[3] >= bbox[1])) out.push(g); } return out; },
			readGeometry(g) {
				if (g === 0 && flat0) { const f = flat0; flat0 = null; return f; }
				const list = lists[g], fb = flatBuilder(Math.max(1024, cverts[g]));
				let kindNow = -1;
				const onPart = kind => { if (kind !== K.POINT) fb.beginPart(kind); kindNow = kind; };
				const onXY = (x, y) => { if (kindNow === K.POINT) fb.point(x / D, y / D); else fb.vertex(x / D, y / D); };
				const onEnd = kind => { if (kind === K.POINT) return; if (fb.partLen() < (kind === K.LINE ? 2 : 3)) fb.dropPart(); else fb.endPart(); };
				for (let k = 0; k < list.length; k++) { const i = list[k]; fb.beginFeature(i, pbf.fmap[i][2]); walkFeature(pbf, i, onPart, onXY, onEnd); fb.endFeature(); }
				return fb.finish();
			},
			readColumns(g, names /* , rows＝list と同順 */) {
				const list = lists[g], out = {};
				const idx = names.map(nm => keys.indexOf(nm)).filter(k => k >= 0);
				if (!idx.length) return out;
				for (const k of idx) out[keys[k]] = new Array(list.length);
				for (let j = 0; j < list.length; j++) { let r = null; try { r = rowOf(list[j]); } catch { /* 壊れた行＝空 */ } for (const k of idx) out[keys[k]][j] = r ? (r[k] ?? null) : null; }
				return out;
			},
			readProps(g, row) { try { return pbf.getProperties(row) ?? {}; } catch { return {}; } },   // row＝fid
			range(nm) {
				if (rangeCache.has(nm)) return rangeCache.get(nm);
				const k = keys.indexOf(nm); let lo = Infinity, hi = -Infinity;
				if (k >= 0) for (let i = 0; i < n; i++) { let r; try { r = rowOf(i); } catch { continue; } const v = r?.[k]; if (typeof v === "number" && Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; } }
				const r = lo <= hi ? [lo, hi] : null; rangeCache.set(nm, r); return r;
			},
			metrics: () => null,
			close() { try { pbf.destroy(); } catch { /* 二重 close */ } },
		};
		if (chunks.length) { flat0 = reader.readGeometry(0); meta.share = shareStats(flat0); }   // 共有の物差し（振り分けの規則が見る）＝先頭チャンクを標本に
		return reader;
	},
};
