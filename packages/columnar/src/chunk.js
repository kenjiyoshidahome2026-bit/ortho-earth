// chunk.js ── フラットな幾何（flat.js）→ 列チャンク（GPU 向けの平たい配列・#90）。純関数＝Node で検定・worker が使う。
//
// 列チャンク = {
//   g, n, bbox:[w,s,e,n], rows: Int32Array(n), types: Uint8Array(n), fbbox: Float64Array(n*4)（識別の前捌き）,
//   origin: [x,y,z]（単位球・RTE の原点＝チャンク bbox の中心。pos は全部これからの差＝float32 に絶対座標を通さない）,
//   points: { pos: Float32Array(m*3), feat: Uint32Array(m) } | null,
//   levels: [ { zoom, lines: { pos: Float32Array(v*3), feat: Uint32Array(v) } | null, fills: { pos, index: Uint32Array, feat } | null }, … ]
//           zoom 降順（先頭＝Infinity＝全解像度・以降＝その zoom 以下で使う間引き版）。feat＝チャンク内 feature 番号
//           lines.feat の bit31＝「この頂点から次の頂点へ辺を引かない」（パートの終わり）＝辺は頂点 i→i+1 のインスタンス描画
// }
// 決め事：
//   ・1° を超える辺は経緯度で等分してから載せる（gint の度アンカーと同じ理由＝大きな面が球面で欠けない）
//   ・面は earcut（経緯度平面）。位相（共有弧）は作らない＝隣の面の境界は 2 回描く
//   ・LOD＝その zoom の画素格子（256px 世界・度）に丸め、同じ格子に続けて落ちる頂点を捨てる。輪が 3 点未満に潰れたら bbox の四角（≧半格子）＝
//     小さな面の塗りが低ズームで消えない。間引きが 25% に届かない段は作らない（前の段を使う）
//   ・±180° を跨ぐ feature（辺の経度差 > 180°）は負の経度に 360 を足して連続にする（GeoParquet の外来データ向け・GeoPBF は書き込み時に切断済み）
import earcut from "earcut";
import { K } from "./flat.js";

const D2R = Math.PI / 180;
export const LOD_ZOOMS = [12, 9, 6];
export const PART_END = 0x80000000;

class GrowF32 { constructor(c = 4096) { this.a = new Float32Array(c); this.n = 0; } push3(x, y, z) { if (this.n + 3 > this.a.length) { const b = new Float32Array(Math.max(this.a.length * 2, this.n + 3)); b.set(this.a.subarray(0, this.n)); this.a = b; } this.a[this.n++] = x; this.a[this.n++] = y; this.a[this.n++] = z; } done() { return this.a.slice(0, this.n); } }
class GrowU32 { constructor(c = 1024) { this.a = new Uint32Array(c); this.n = 0; } push(v) { if (this.n === this.a.length) { const b = new Uint32Array(this.n * 2); b.set(this.a); this.a = b; } this.a[this.n++] = v; } done() { return this.a.slice(0, this.n); } }

// 経緯度 → 単位球 xyz（quakes/parquet-view の toPos と同式・rAx＝楕円体なら b/a）
export function toXYZ(lon, lat, rAx, out = [0, 0, 0]) {
	const a = lon * D2R, b = lat * D2R;
	let sb = Math.sin(b), cb = Math.cos(b);
	if (rAx !== 1) { const w = Math.hypot(cb, rAx * sb); sb = rAx * sb / w; cb = cb / w; }
	out[0] = cb * Math.cos(a); out[1] = sb; out[2] = cb * Math.sin(a);
	return out;
}

// ±180° 跨ぎの連続化（feature 単位・xy を書き換える）。戻り＝跨いだ feature 数
export function unwrapAntimeridian(flat) {
	const { xy, featPart, partStart } = flat;
	let hit = 0;
	for (let f = 0; f < flat.n; f++) {
		let cross = false;
		for (let p = featPart[f]; p < featPart[f + 1] && !cross; p++) {
			const s = partStart[p], e = partStart[p + 1];
			for (let v = s + 1; v < e; v++) if (Math.abs(xy[v * 2] - xy[v * 2 - 2]) > 180) { cross = true; break; }
			if (!cross && e - s >= 3 && Math.abs(xy[(e - 1) * 2] - xy[s * 2]) > 180 && flat.partKind[p] !== K.LINE) cross = true;   // 輪の閉じ辺
		}
		if (!cross) continue;
		hit++;
		for (let p = featPart[f]; p < featPart[f + 1]; p++) for (let v = partStart[p]; v < partStart[p + 1]; v++) if (xy[v * 2] < 0) xy[v * 2] += 360;
	}
	return hit;
}

// feature ごとの bbox（連続化後の経緯度）
export function featureBboxes(flat) {
	const { xy, featPart, partStart } = flat, out = new Float64Array(flat.n * 4);
	for (let f = 0; f < flat.n; f++) {
		let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
		for (let v = partStart[featPart[f]]; v < partStart[featPart[f + 1]]; v++) { const x = xy[v * 2], y = xy[v * 2 + 1]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
		out[f * 4] = x0; out[f * 4 + 1] = y0; out[f * 4 + 2] = x1; out[f * 4 + 3] = y1;
	}
	return out;
}

// 1 パートの間引き（zoom の格子・度）。閉じた輪＝closed。戻り＝Float64Array [x,y,…]（3 点未満に潰れた輪は bbox の四角・線は両端）
function simplifyPart(xy, s, e, cell, closed) {
	const n = e - s;
	if (n === 0) return null;
	const out = [];
	let lcx = Math.floor(xy[s * 2] / cell), lcy = Math.floor(xy[s * 2 + 1] / cell);
	out.push(xy[s * 2], xy[s * 2 + 1]);
	for (let v = s + 1; v < e; v++) {
		const x = xy[v * 2], y = xy[v * 2 + 1], cx = Math.floor(x / cell), cy = Math.floor(y / cell);
		if (cx === lcx && cy === lcy) continue;
		lcx = cx; lcy = cy; out.push(x, y);
	}
	if (closed) {
		// 末尾が先頭と同じ格子なら落とす（閉じ辺が 0 長に）
		if (out.length >= 4 && Math.floor(out[out.length - 2] / cell) === Math.floor(out[0] / cell) && Math.floor(out[out.length - 1] / cell) === Math.floor(out[1] / cell)) out.length -= 2;
		if (out.length < 6) {
			let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
			for (let v = s; v < e; v++) { const x = xy[v * 2], y = xy[v * 2 + 1]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
			const h = cell * 0.25, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, hx = Math.max(h, (x1 - x0) / 2), hy = Math.max(h, (y1 - y0) / 2);
			return Float64Array.from([cx - hx, cy - hy, cx + hx, cy - hy, cx + hx, cy + hy, cx - hx, cy + hy]);
		}
	} else if (out.length < 4) { out.push(xy[(e - 1) * 2], xy[(e - 1) * 2 + 1]); }
	return Float64Array.from(out);
}

// 1 段ぶんの詰め替え（level＝{ zoom }・cell＝null なら全解像度）
function packLevel(flat, cell, maxEdgeDeg, rAx, O) {
	const { xy, featPart, partKind, partStart } = flat;
	const lpos = new GrowF32(), lfeat = new GrowU32(), fpos = new GrowF32(), fidx = new GrowU32(), ffeat = new GrowU32();
	const tmp = [0, 0, 0];
	let fillVerts = 0, linesN = 0, fillsN = 0;
	const emitLineVertex = (x, y, f, end) => { toXYZ(x, y, rAx, tmp); lpos.push3(tmp[0] - O[0], tmp[1] - O[1], tmp[2] - O[2]); lfeat.push(end ? (f | PART_END) >>> 0 : f); };
	// 辺の細分（両端を含まず中間点だけ）を coords 配列（閉じた輪なら末尾→先頭も）へ展開
	const subdivided = (c, closed) => {
		if (!(maxEdgeDeg > 0)) return c;
		const m = c.length / 2;
		let need = false;
		for (let i = 0; i < m; i++) { const j = i + 1 < m ? i + 1 : (closed ? 0 : -1); if (j < 0) break; if (Math.abs(c[j * 2] - c[i * 2]) > maxEdgeDeg || Math.abs(c[j * 2 + 1] - c[i * 2 + 1]) > maxEdgeDeg) { need = true; break; } }
		if (!need) return c;   // 細分不要＝写さない（速さの肝：筆級のデータは全部ここ）
		const out = [];
		for (let i = 0; i < m; i++) {
			const x0 = c[i * 2], y0 = c[i * 2 + 1];
			out.push(x0, y0);
			const j = i + 1 < m ? i + 1 : (closed ? 0 : -1);
			if (j < 0) break;
			const x1 = c[j * 2], y1 = c[j * 2 + 1], k = Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) / maxEdgeDeg);
			for (let q = 1; q < k; q++) { const t = q / k; out.push(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t); }
		}
		return out;
	};
	const coordsOf = (p, closed) => {
		const s = partStart[p], e = partStart[p + 1];
		if (cell == null) return subdivided(xy.subarray(s * 2, e * 2), closed);
		const c = simplifyPart(xy, s, e, cell, closed);
		return c ? subdivided(c, closed) : null;
	};
	const emitLine = (c, f, closed) => {
		const m = c.length / 2;
		for (let i = 0; i < m; i++) emitLineVertex(c[i * 2], c[i * 2 + 1], f, !closed && i === m - 1);
		if (closed) emitLineVertex(c[0], c[1], f, true);
		linesN++;
	};
	const flushPoly = (rings, f) => {
		if (!rings.length) return;
		let flatXY, holes = null;
		if (rings.length === 1) flatXY = rings[0];
		else {
			let total = 0; for (const r of rings) total += r.length;
			flatXY = new Float64Array(total); holes = [];
			let o = 0; for (let r = 0; r < rings.length; r++) { if (r > 0) holes.push(o / 2); flatXY.set(rings[r], o); o += rings[r].length; }
		}
		const tri = earcut(flatXY, holes, 2);
		if (!tri.length) return;
		const base = fillVerts, nv = flatXY.length / 2;
		for (let i = 0; i < nv; i++) { toXYZ(flatXY[i * 2], flatXY[i * 2 + 1], rAx, tmp); fpos.push3(tmp[0] - O[0], tmp[1] - O[1], tmp[2] - O[2]); ffeat.push(f); }
		for (let i = 0; i < tri.length; i++) fidx.push(base + tri[i]);
		fillVerts += nv; fillsN++;
	};
	for (let f = 0; f < flat.n; f++) {
		let rings = [];
		for (let p = featPart[f]; p < featPart[f + 1]; p++) {
			const kind = partKind[p];
			if (kind === K.POINT) continue;
			if (kind === K.LINE) { const c = coordsOf(p, false); if (c && c.length >= 4) emitLine(c, f, false); continue; }
			const c = coordsOf(p, true);
			if (kind === K.OUTER) { flushPoly(rings, f); rings = []; if (c && c.length >= 6) { rings.push(c); emitLine(c, f, true); } }
			else if (kind === K.HOLE && rings.length && c && c.length >= 6) { rings.push(c); emitLine(c, f, true); }
		}
		flushPoly(rings, f);
	}
	return {
		lines: linesN ? { pos: lpos.done(), feat: lfeat.done() } : null,
		fills: fillsN ? { pos: fpos.done(), index: fidx.done(), feat: ffeat.done() } : null,
		verts: lpos.n / 3 + fillVerts,
	};
}

// 度／画素（256px 世界・正射スケール＝緯度に依らない）
export const cellOfZoom = z => 360 / (256 * Math.pow(2, z));

// 段の zoom 列（降順・先頭＝Infinity＝全解像度）
const levelZooms = lods => [Infinity, ...[...lods].sort((a, b) => b - a)];
// 今の zoom に要る段＝「zoom ≥ 今の zoom の最小の段」
export const levelZoomFor = (lods, zoom) => { const zs = levelZooms(lods); let pick = Infinity; for (const z of zs) if (z >= zoom) pick = z; return pick; };

// flat → 列チャンク。opts: { g, rAx=1, lods=LOD_ZOOMS, maxEdgeDeg=1, unwrap=true, zoom }
// zoom を渡すと**その zoom に要る段だけ**作って返す（最初の 1 枚を最短に）＝残りは buildLevels() で後から（chunk.pending＝true）
export function buildChunk(flat, opts = {}) {
	const { g = 0, rAx = 1, lods = LOD_ZOOMS, maxEdgeDeg = 1, zoom = null } = opts;
	if (opts.unwrap !== false) unwrapAntimeridian(flat);
	const fbbox = featureBboxes(flat);
	let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
	for (let f = 0; f < flat.n; f++) { if (fbbox[f * 4] < w) w = fbbox[f * 4]; if (fbbox[f * 4 + 1] < s) s = fbbox[f * 4 + 1]; if (fbbox[f * 4 + 2] > e) e = fbbox[f * 4 + 2]; if (fbbox[f * 4 + 3] > n) n = fbbox[f * 4 + 3]; }
	if (!(w <= e)) { w = s = e = n = 0; }
	const O = toXYZ((w + e) / 2, (s + n) / 2, rAx);
	// 点
	let points = null;
	{
		const { xy, featPart, partKind, partStart } = flat, pos = new GrowF32(), feat = new GrowU32(), tmp = [0, 0, 0];
		let m = 0;
		for (let f = 0; f < flat.n; f++) for (let p = featPart[f]; p < featPart[f + 1]; p++) if (partKind[p] === K.POINT) { const v = partStart[p]; toXYZ(xy[v * 2], xy[v * 2 + 1], rAx, tmp); pos.push3(tmp[0] - O[0], tmp[1] - O[1], tmp[2] - O[2]); feat.push(f); m++; }
		if (m) points = { pos: pos.done(), feat: feat.done() };
	}
	const chunk = { g, n: flat.n, bbox: [w, s, e, n], rows: flat.rows.slice(), types: flat.types.slice(), fbbox, origin: O, points, levels: [], pending: false, _verts: null };   // rows/types は写し＝transfer で flat 側が detach しない
	if (zoom != null) {
		const zL = levelZoomFor(lods, zoom);
		const L = packLevel(flat, zL === Infinity ? null : cellOfZoom(zL), maxEdgeDeg, rAx, O);
		chunk.levels.push({ zoom: zL, lines: L.lines, fills: L.fills, verts: L.verts });
		chunk.pending = true;
		return chunk;
	}
	buildLevels(flat, chunk, opts);
	return chunk;
}
// 残りの段を作る（buildChunk(…, { zoom }) の後）。戻り＝足した段（zoom 降順に並べ直した chunk.levels も更新・pending＝false）
export function buildLevels(flat, chunk, opts = {}) {
	const { rAx = 1, lods = LOD_ZOOMS, maxEdgeDeg = 1 } = opts, O = chunk.origin, have = new Map(chunk.levels.map(L => [L.zoom, L])), added = [];
	let full = have.get(Infinity);
	if (!full) { const L = packLevel(flat, null, maxEdgeDeg, rAx, O); full = { zoom: Infinity, lines: L.lines, fills: L.fills, verts: L.verts }; added.push(full); have.set(Infinity, full); }
	if (full.lines || full.fills) {
		let prev = full.verts;
		for (const z of [...lods].sort((a, b) => b - a)) {
			if (!(prev > 64)) break;   // もう軽い＝段を増やさない
			const had = have.get(z);
			if (had) { if (had.verts > prev * 0.75 && !had.keep) { /* 先に作った段が減らない段でも、要求された zoom の段は残す */ had.keep = true; } prev = Math.min(prev, had.verts); continue; }
			const L = packLevel(flat, cellOfZoom(z), maxEdgeDeg, rAx, O);
			if (L.verts > prev * 0.75) continue;   // 減らない段は作らない（選び方＝「zoom ≥ 今の zoom の最小の段」なので前の段がそのまま使われる）
			const lv = { zoom: z, lines: L.lines, fills: L.fills, verts: L.verts }; added.push(lv); have.set(z, lv);
			prev = L.verts;
		}
	}
	chunk.levels = [...have.values()].sort((a, b) => b.zoom - a.zoom); chunk.pending = false;
	return added;
}

// transfer 用の buffer 一覧
export function chunkBuffers(c) {
	const out = [c.rows.buffer, c.types.buffer];   // fbbox は複製で運ぶ（worker の識別が使い続ける）
	if (c.points) out.push(c.points.pos.buffer, c.points.feat.buffer);
	out.push(...levelBuffers(c.levels));
	return [...new Set(out)];
}
export function levelBuffers(levels) {
	const out = [];
	for (const L of levels) { if (L.lines) out.push(L.lines.pos.buffer, L.lines.feat.buffer); if (L.fills) out.push(L.fills.pos.buffer, L.fills.index.buffer, L.fills.feat.buffer); }
	return out;
}
// 目安のバイト数（常駐の予算・GPU 概算）
export function chunkBytes(c) { let b = c.rows.byteLength + c.fbbox.byteLength; if (c.points) b += c.points.pos.byteLength + c.points.feat.byteLength; for (const L of c.levels) { if (L.lines) b += L.lines.pos.byteLength + L.lines.feat.byteLength; if (L.fills) b += L.fills.pos.byteLength + L.fills.index.byteLength + L.fills.feat.byteLength; } return b; }
