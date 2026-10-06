// 最小の Shapefile 読み（国土数値情報の shp/dbf＝点・線・面・測地系はそのまま）。依存なし。
//   readShp(base) → { fields, records: [{ props, geometry }] }   geometry＝GeoJSON（Polygon の環は shp の向きのまま＝外周が時計回り）
import fs from "node:fs";
export function readShp(base, { encoding = "shift_jis" } = {}) {
	const shp = fs.readFileSync(base + ".shp"), dbf = fs.readFileSync(base + ".dbf");
	const geoms = []; let off = 100;
	const type0 = shp.readInt32LE(32);
	while (off + 8 <= shp.length) {
		const len = shp.readInt32BE(off + 4) * 2; const rec = shp.subarray(off + 8, off + 8 + len); off += 8 + len;
		const t = rec.readInt32LE(0);
		if (t === 0) { geoms.push(null); continue; }
		if (t === 1 || t === 11 || t === 21) { geoms.push({ type: "Point", coordinates: [rec.readDoubleLE(4), rec.readDoubleLE(12)] }); continue; }
		if (t === 8 || t === 18 || t === 28) { const n = rec.readInt32LE(36), pts = []; for (let i = 0; i < n; i++) pts.push([rec.readDoubleLE(40 + i * 16), rec.readDoubleLE(48 + i * 16)]); geoms.push({ type: "MultiPoint", coordinates: pts }); continue; }
		if ([3, 5, 13, 15, 23, 25].includes(t)) {
			const np = rec.readInt32LE(36), nn = rec.readInt32LE(40), parts = []; for (let i = 0; i < np; i++) parts.push(rec.readInt32LE(44 + i * 4));
			const p0 = 44 + np * 4, lines = [];
			for (let i = 0; i < np; i++) { const a = parts[i], b = i + 1 < np ? parts[i + 1] : nn, l = []; for (let k = a; k < b; k++) l.push([rec.readDoubleLE(p0 + k * 16), rec.readDoubleLE(p0 + 8 + k * 16)]); lines.push(l); }
			if (t === 3 || t === 13 || t === 23) geoms.push(lines.length === 1 ? { type: "LineString", coordinates: lines[0] } : { type: "MultiLineString", coordinates: lines });
			else geoms.push(ringsToPolygons(lines));
			continue;
		}
		throw new Error("shape type " + t + " は未対応（" + type0 + "）");
	}
	// dbf
	const nrec = dbf.readUInt32LE(4), hlen = dbf.readUInt16LE(8), rlen = dbf.readUInt16LE(10), fields = [];
	for (let p = 32; p < hlen - 1 && dbf[p] !== 0x0d; p += 32) { const name = dbf.subarray(p, p + 11).toString("latin1").replace(/\0.*$/, ""); fields.push({ name, type: String.fromCharCode(dbf[p + 11]), len: dbf[p + 16] }); }
	const dec = new TextDecoder(encoding), records = [];
	for (let i = 0; i < nrec; i++) {
		const r = dbf.subarray(hlen + i * rlen, hlen + (i + 1) * rlen), props = {}; let q = 1;
		for (const f of fields) { const raw = r.subarray(q, q + f.len); q += f.len; let v = dec.decode(raw).trim(); if (f.type === "N" || f.type === "F") v = v === "" ? null : +v; props[f.name] = v; }
		records.push({ props, geometry: geoms[i] ?? null });
	}
	return { fields, records };
}
// 環 → 面（shp は外周＝時計回り・穴＝反時計回り。外周ごとに Polygon を作り、穴は含む外周に付ける）
const area2 = r => { let a = 0; for (let i = 1; i < r.length; i++) a += (r[i][0] - r[i - 1][0]) * (r[i][1] + r[i - 1][1]); return a; };   // >0＝時計回り（y 上向き）
const inside = (p, r) => { let c = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const a = r[i], b = r[j]; if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) c = !c; } return c; };
function ringsToPolygons(rings) {
	const outer = [], holes = [];
	for (const r of rings) (area2(r) > 0 ? outer : holes).push(r);
	if (!outer.length) return rings.length ? { type: "Polygon", coordinates: [rings[0]] } : null;
	const polys = outer.map(r => [r]);
	for (const h of holes) { const i = outer.findIndex(o => inside(h[0], o)); (i >= 0 ? polys[i] : polys[0]).push(h); }
	return polys.length === 1 ? { type: "Polygon", coordinates: polys[0] } : { type: "MultiPolygon", coordinates: polys };
}
