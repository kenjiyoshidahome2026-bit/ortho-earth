// flat.js ── 読み手と列チャンクの間の「フラットな幾何」（#90）。読み手（GeoParquet の WKB・メモリ上の GeoPBF）はここまでを返し、
// 単位球 xyz・三角形分割・LOD は chunk.js が共通にやる＝読み手を足しても描画は変わらない。
//
// flat = {
//   n,                         // feature 数（チャンク内の番号 0..n-1）
//   rows: Int32Array(n),       // チャンク内番号 → 元の行（GeoParquet の row group 内の行・GeoPBF の fid）
//   types: Uint8Array(n),      // 0 Point 1 MultiPoint 2 LineString 3 MultiLineString 4 Polygon 5 MultiPolygon 6 GeometryCollection
//   xy: Float64Array,          // 経緯度（度）の平坦列 [x0,y0,x1,y1,…]。輪は閉じ点なし
//   featPart: Uint32Array(n+1),// feature f のパート＝[featPart[f], featPart[f+1])
//   partKind: Uint8Array(np),  // 0 点 1 線 2 外周 3 穴（穴は直前の外周に属する）
//   partStart: Uint32Array(np+1) // パート p の頂点＝[partStart[p], partStart[p+1])（頂点番号＝xy の添字/2）
// }
export const T = { Point: 0, MultiPoint: 1, LineString: 2, MultiLineString: 3, Polygon: 4, MultiPolygon: 5, GeometryCollection: 6 };
export const TYPE_NAMES = ["Point", "MultiPoint", "LineString", "MultiLineString", "Polygon", "MultiPolygon", "GeometryCollection"];
export const K = { POINT: 0, LINE: 1, OUTER: 2, HOLE: 3 };

class Grow {
	constructor(Ctor, cap = 1024) { this.a = new Ctor(cap); this.n = 0; this.Ctor = Ctor; }
	push(v) { if (this.n === this.a.length) this.grow(this.n * 2); this.a[this.n++] = v; }
	push2(x, y) { if (this.n + 2 > this.a.length) this.grow(Math.max(this.n * 2, this.n + 2)); this.a[this.n++] = x; this.a[this.n++] = y; }
	grow(cap) { const b = new this.Ctor(cap); b.set(this.a.subarray(0, this.n)); this.a = b; }
	done() { return this.a.length === this.n ? this.a : this.a.slice(0, this.n); }
}
export { Grow };

// フラットな幾何の組み立て手（読み手が使う）。beginFeature → (point | beginPart/vertex/endPart)* → endFeature → finish()
export function flatBuilder(capVerts = 4096) {
	const rows = new Grow(Int32Array, 256), types = new Grow(Uint8Array, 256), xy = new Grow(Float64Array, capVerts * 2);
	const featPart = new Grow(Uint32Array, 256), partKind = new Grow(Uint8Array, 256), partStart = new Grow(Uint32Array, 256);
	let np = 0, nv = 0, open = false;
	return {
		beginFeature(row, type) { rows.push(row); types.push(type); featPart.push(np); },
		point(x, y) { partKind.push(K.POINT); partStart.push(nv); xy.push2(x, y); nv++; np++; },
		beginPart(kind) { partKind.push(kind); partStart.push(nv); open = true; },
		vertex(x, y) { xy.push2(x, y); nv++; },
		endPart() { open = false; np++; },
		// 直前のパートの頂点数（穴・輪が 3 頂点未満なら捨てる等）
		partLen() { return nv - partStart.a[partStart.n - 1]; },
		dropPart() { nv = partStart.a[partStart.n - 1]; xy.n = nv * 2; partStart.n--; partKind.n--; open = false; },
		endFeature() { /* featPart は次の beginFeature で閉じる */ },
		get n() { return rows.n; }, get vertices() { return nv; },
		finish() {
			if (open) { open = false; np++; }
			featPart.push(np); partStart.push(nv);
			return { n: rows.n, rows: rows.done(), types: types.done(), xy: xy.done(), featPart: featPart.done(), partKind: partKind.done(), partStart: partStart.done() };
		},
	};
}

// GeoJSON の geometry → 組み立て手へ（parseWkb の出力・検定の参照経路）。輪の閉じ点は落とす
export function addGeoJSON(fb, row, geom) {
	if (!geom) return false;
	const t = T[geom.type];
	if (t === undefined) return false;
	fb.beginFeature(row, t);
	addGeom(fb, geom);
	fb.endFeature();
	return true;
}
function addGeom(fb, g) {
	const c = g.coordinates;
	switch (g.type) {
		case "Point": fb.point(c[0], c[1]); break;
		case "MultiPoint": for (const p of c) fb.point(p[0], p[1]); break;
		case "LineString": line(fb, c); break;
		case "MultiLineString": for (const l of c) line(fb, l); break;
		case "Polygon": poly(fb, c); break;
		case "MultiPolygon": for (const p of c) poly(fb, p); break;
		case "GeometryCollection": for (const q of g.geometries) addGeom(fb, q); break;
	}
}
function line(fb, c) { if (c.length < 2) return; fb.beginPart(K.LINE); for (const p of c) fb.vertex(p[0], p[1]); fb.endPart(); }
function ring(fb, r, kind) {
	const n = r.length, closed = n >= 2 && r[0][0] === r[n - 1][0] && r[0][1] === r[n - 1][1], m = closed ? n - 1 : n;
	if (m < 3) return false;
	fb.beginPart(kind); for (let i = 0; i < m; i++) fb.vertex(r[i][0], r[i][1]); fb.endPart();
	return true;
}
function poly(fb, rings) { if (!rings.length) return; if (!ring(fb, rings[0], K.OUTER)) return; for (let i = 1; i < rings.length; i++) ring(fb, rings[i], K.HOLE); }

// WKB（ISO／EWKB・Z/M は読み飛ばし）→ 組み立て手へ直接（parseWkb の [x,y] 配列を作らない＝GeoParquet の読みの速さの肝）。
// 戻り＝載せたか（空・曲線系は false）。curve 系（8 以降）は投げる（parseWkb と同じ）
const WKB2T = [null, T.Point, T.LineString, T.Polygon, T.MultiPoint, T.MultiLineString, T.MultiPolygon, T.GeometryCollection];   // WKB の型番 → GeoPBF の型番
export function addWkb(fb, row, u8) {
	const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
	let p = 0, began = false;
	const geom = (top) => {
		const le = u8[p] === 1; p += 1;
		let t = dv.getUint32(p, le); p += 4;
		let dims = 2;
		if (t & 0x80000000) { t &= 0x7fffffff; dims++; }
		if (t & 0x40000000) { t &= 0x3fffffff; dims++; }
		if (t & 0x20000000) { t &= 0x1fffffff; p += 4; }
		if (t >= 3000) { t -= 3000; dims = 4; } else if (t >= 2000) { t -= 2000; dims = 3; } else if (t >= 1000) { t -= 1000; dims = 3; }
		if (t < 1 || t > 7) throw new Error("WKB type " + t);
		if (top) { fb.beginFeature(row, WKB2T[t]); began = true; }
		const step = 8 * dims;
		const pt = () => { const x = dv.getFloat64(p, le), y = dv.getFloat64(p + 8, le); p += step; return [x, y]; };
		const rng = (kind) => {
			const n = dv.getUint32(p, le); p += 4;
			if (n === 0) return;
			fb.beginPart(kind);
			const x0 = dv.getFloat64(p, le), y0 = dv.getFloat64(p + 8, le);
			for (let i = 0; i < n; i++) { const x = dv.getFloat64(p, le), y = dv.getFloat64(p + 8, le); p += step; if (i === n - 1 && n >= 2 && x === x0 && y === y0 && kind !== K.LINE) break; fb.vertex(x, y); }
			if (fb.partLen() < (kind === K.LINE ? 2 : 3)) fb.dropPart(); else fb.endPart();
		};
		if (t === 1) { const c = pt(); if (Number.isFinite(c[0]) && Number.isFinite(c[1])) fb.point(c[0], c[1]); return; }
		if (t === 2) { rng(K.LINE); return; }
		if (t === 3) { const n = dv.getUint32(p, le); p += 4; for (let i = 0; i < n; i++) rng(i === 0 ? K.OUTER : K.HOLE); return; }
		const n = dv.getUint32(p, le); p += 4;
		for (let i = 0; i < n; i++) geom(false);
	};
	geom(true);
	if (began) fb.endFeature();
	return began;
}
