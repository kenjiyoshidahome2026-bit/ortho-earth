// convert/wkb.js ── WKB（ISO / EWKB）→ GeoJSON geometry。GeoParquet と GeoPackage の入口で共用。
// Z / M は読み飛ばす（GeoPBF は 2D）。ctx.vertices に頂点数を積む。曲線系（CircularString 8 以降）は未対応＝明示して投げる。
const WKB_TYPES = { 1: "Point", 2: "LineString", 3: "Polygon", 4: "MultiPoint", 5: "MultiLineString", 6: "MultiPolygon", 7: "GeometryCollection" };
export function parseWkb(u8, ctx, opts = {}) {
	const offset = opts.offset || 0;
	const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
	let p = offset;
	const geom = () => {
		const le = u8[p] === 1; p += 1;
		let t = dv.getUint32(p, le); p += 4;
		let dims = 2;
		if (t & 0x80000000) { t &= 0x7fffffff; dims++; }   // EWKB Z
		if (t & 0x40000000) { t &= 0x3fffffff; dims++; }   // EWKB M
		if (t & 0x20000000) { t &= 0x1fffffff; p += 4; }   // EWKB SRID
		if (t >= 3000) { t -= 3000; dims = 4; } else if (t >= 2000) { t -= 2000; dims = 3; } else if (t >= 1000) { t -= 1000; dims = 3; }
		const type = WKB_TYPES[t]; if (!type) throw new Error("WKB type " + t);
		const pt = () => { const c = [dv.getFloat64(p, le), dv.getFloat64(p + 8, le)]; p += 8 * dims; ctx.vertices++; return c; };
		const ring = () => { const n = dv.getUint32(p, le); p += 4; const r = new Array(n); for (let i = 0; i < n; i++) r[i] = pt(); return r; };
		if (t === 1) return { type, coordinates: pt() };
		if (t === 2) return { type, coordinates: ring() };
		if (t === 3) { const n = dv.getUint32(p, le); p += 4; const rings = new Array(n); for (let i = 0; i < n; i++) rings[i] = ring(); return { type, coordinates: rings }; }
		const n = dv.getUint32(p, le); p += 4;
		if (t === 7) { const gs = new Array(n); for (let i = 0; i < n; i++) gs[i] = geom(); return { type, geometries: gs }; }
		const parts = new Array(n); for (let i = 0; i < n; i++) parts[i] = geom().coordinates;
		return { type, coordinates: parts };
	};
	return geom();
}
