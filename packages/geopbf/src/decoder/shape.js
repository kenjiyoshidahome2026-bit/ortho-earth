import { GeoPBF } from "../pbf-base.js";
import { dissolve } from "../extension/dissolve.js";
import { decodeZIP } from "../modules/decodeZIP.js";

import { mercToLonLat as fromMercator } from "../modules/mercator.js";   // 旧＝atan(sinh(y·π/R)) の自前式（数学的に同値・末位 ulp 差は precision 丸めで消える）
import { pointInRing } from "../modules/geom.js";
const view = a => new DataView(a.buffer, a.byteOffset, a.byteLength);
function detectCRS(wkt) {
    if (!wkt) return null;
    const s = wkt.trim();
    if (/AUTHORITY\["EPSG","(3857|3785|900913)"\]/.test(s) ||
        /Pseudo.Mercator|Web.Mercator|Auxiliary.Sphere/i.test(s)) return "3857";
    if (!s.startsWith("PROJCS") && (/WGS.?84|WGS.?1984/i.test(s) || /AUTHORITY\["EPSG","4326"\]/.test(s))) return null;
    if (s.startsWith("PROJCS")) {
        const m = s.match(/^PROJCS\["([^"]+)"/);
        return m?.[1] || "Unknown CRS";
    }
    return null;
}
function applyTransform(geom, fn) {
    if (!geom) return geom;
    const pt = p => fn(p), ring = r => r.map(pt);
    const { type, coordinates: c } = geom;
    const coords =
        type === "Point" ? pt(c) :
        type === "MultiPoint" || type === "LineString" ? c.map(pt) :
        type === "MultiLineString" ? c.map(r => r.map(pt)) :
        type === "Polygon" ? c.map(ring) :
        type === "MultiPolygon" ? c.map(poly => poly.map(ring)) : c;
    return { type, coordinates: coords };
}
const getbbox = r => {
	let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
	r.forEach(p => {
		if (p[0] < xmin) xmin = p[0]; if (p[0] > xmax) xmax = p[0];
		if (p[1] < ymin) ymin = p[1]; if (p[1] > ymax) ymax = p[1];
	});
	return [xmin, ymin, xmax, ymax];
};
const includes = (b, pt) => !(b[0] > pt[0] || b[2] < pt[0] || b[1] > pt[1] || b[3] < pt[1]);
const contains = (ring, pt) => pointInRing(pt[0], pt[1], ring);
const DBF_PARSE = {
	B: v => +v.trim(), F: v => +v.trim(), N: v => +v.trim(),
	L: v => /^[yt]$/i.test(v), D: v => new Date(v.replace(/(....)(..)(..)/, "$1-$2-$3")),
	C: v => { v = v.trim().replace(/\x00/g, ""); return v.length ? v : null; }
};
class DBF {
	constructor(s, enc) {
		const h = view(s.subarray(0, 32)), l = h.getUint16(8, true);
		const b = view(s.subarray(32, l));
		this.source = s.subarray(l); this.len = h.getUint16(10, true);
		this.dec = new TextDecoder(enc); this.fields = [];
		for (let n = 0; b.getUint8(n) !== 0x0d; n += 32) {
			let j = 0; while (j < 11 && b.getUint8(n + j) !== 0) j++;
			this.fields.push({
				name: this.dec.decode(new Uint8Array(b.buffer, b.byteOffset + n, j)).trim(),
				type: String.fromCharCode(b.getUint8(n + 11)),
				length: b.getUint8(n + 16)
			});
		}
	}
	read() {
		const value = this.source.subarray(0, this.len); this.source = this.source.subarray(this.len);
		if (!value || value[0] === 0x1a) return null;
		const q = {}, fields = this.fields;
		for (let k = 0, i = 1; k < fields.length; k++) {   // レコードごとに parse 表（6 クロージャ）を作らない
			const f = fields[k], raw = this.dec.decode(value.subarray(i, i += f.length));
			const v = (DBF_PARSE[f.type] || DBF_PARSE.C)(raw);
			if (v !== null) q[f.name] = v;
		}
		return q;
	}
}
// 各 parser は (DataView, o)＝o はレコード内容（shape type 欄）の絶対オフセット。レコードごとに DataView/subarray を作らない。
const Point = (q, o) => ({ type: "Point", coordinates: [q.getFloat64(o + 4, true), q.getFloat64(o + 12, true)] });
const MultiPoint = (q, o) => {
	const n = q.getInt32(o + 36, true), pts = [];
	for (let i = 0, p = o + 40; i < n; i++, p += 16) pts.push([q.getFloat64(p, true), q.getFloat64(p + 8, true)]);
	return { type: "MultiPoint", coordinates: pts };
};
const PolyLine = (q, o) => {
	let p = o + 44, n = q.getInt32(o + 36, true), m = q.getInt32(o + 40, true);
	const parts = [], pts = [];
	for (let i = 0; i < n; i++, p += 4) parts.push(q.getInt32(p, true));
	for (let i = 0; i < m; i++, p += 16) pts.push([q.getFloat64(p, true), q.getFloat64(p + 8, true)]);
	const lines = parts.map((st, i) => pts.slice(st, parts[i + 1]));
	return n === 1 ? { type: "LineString", coordinates: lines[0] } : { type: "MultiLineString", coordinates: lines };
};
const Polygon = (q, o) => {
	let p = o + 44, n = q.getInt32(o + 36, true), m = q.getInt32(o + 40, true);
	const parts = [], pts = [], polys = [], holes = [];
	for (let i = 0; i < n; i++, p += 4) parts.push(q.getInt32(p, true));
	for (let i = 0; i < m; i++, p += 16) pts.push([q.getFloat64(p, true), q.getFloat64(p + 8, true)]);
	parts.forEach((st, i) => {
		const ring = pts.slice(st, parts[i + 1]);
		let s = 0;
		for (let j = 0, l = ring.length; j < l; j++) {
			const a = ring[j], b = ring[(j + 1) % l];
			s += (b[0] - a[0]) * (b[1] + a[1]);
		}
		s >= 0 ? polys.push([ring]) : holes.push(ring);
	});

	const bboxes = polys.map(t => getbbox(t[0]));
	holes.forEach(hole => {
		const pt = hole[0];
		const idx = polys.findIndex((_, i) => includes(bboxes[i], pt) && contains(polys[i][0], pt));
		if (idx !== -1) polys[idx].push(hole);
	});
	return polys.length === 1 ? { type: "Polygon", coordinates: polys[0] } : { type: "MultiPolygon", coordinates: polys };
};
class SHP {
	constructor(s, transform = null) {
		this.view = view(s); this.pos = 100; this.end = s.byteLength;   // 1 本の DataView をオフセットで歩く
		this.type = this.view.getInt32(32, true);
		this.xform = transform;
		this.parse = { 1: Point, 3: PolyLine, 5: Polygon, 8: MultiPoint, 11: Point, 13: PolyLine, 15: Polygon }[this.type];
	}
	read() {
		const v = this.view;
		while (this.pos + 12 <= this.end) {
			const p = this.pos, len = v.getInt32(p + 4, false) * 2, type = v.getInt32(p + 8, true);
			this.pos = p + 8 + len;
			if (type !== this.type) continue;   // null shape 等は読み飛ばす（従来どおり）
			const geom = this.parse(v, p + 8);
			return (this.xform && geom) ? applyTransform(geom, this.xform) : geom;
		}
		return null;
	}
}
onmessage = async (e) => {
	try {
		const { file, encoding, precision, shpTarget } = e.data;
		const name = file.name.replace(/\.[^\.]+$/, "");
		const entries = await decodeZIP(file);
		if (!entries) { postMessage(null); return; }
		const keySet = new Set();
		const shpFiles = shpTarget
			? entries.filter(t => t.name.endsWith(shpTarget))
			: entries.filter(t => t.name.match(/\.shp$/i));
		let warning = null;
		const dbs = await Promise.all(shpFiles.map(async f => {
			const base = f.name.replace(/\.shp$/i, "");
			const dbfFile = entries.find(t => t.name === base + ".dbf");
			const cpgFile = entries.find(t => t.name === base + ".cpg");
			const prjFile = entries.find(t => t.name === base + ".prj");
			if (!dbfFile) return null;
			const shpBuf = new Uint8Array(await f.arrayBuffer());
			const dbfBuf = new Uint8Array(await dbfFile.arrayBuffer());
			let enc;
			if (cpgFile) {
				enc = (await cpgFile.text()).trim();
			} else if (dbfBuf[29] === 0x13) {
				enc = 'sjis';
			} else if (encoding !== 'utf8') {
				enc = encoding;
			} else {
				// .cpgなし・言語ドライババイト不明 → UTF-8で読めなければSJIS
				try { new TextDecoder('utf-8', { fatal: true }).decode(dbfBuf); enc = 'utf-8'; }
				catch { enc = 'sjis'; }
			}
			const dbf = new DBF(dbfBuf, enc);
			dbf.fields.forEach(field => keySet.add(field.name));
			const crs = prjFile ? detectCRS(await prjFile.text()) : null;
			const transform = crs === "3857" ? fromMercator : null;
			if (crs && crs !== "3857") warning = `Unsupported CRS detected: "${crs}". Data may not display correctly. Convert to WGS84 (EPSG:4326) before use.`;
			return [new SHP(shpBuf, transform), dbf];
		}));
		const pbf = new GeoPBF({ name, precision });
		pbf.setHead(Array.from(keySet).sort());
		pbf.setBody(() => {
			dbs.filter(t => t).forEach(([shp, dbf]) => {
				while (1) {
					const s = shp.read(), d = dbf.read();
					if (!s || !d) break;
					pbf.setFeature({ type: "Feature", geometry: s, properties: d });
				}
			});
		});
		pbf.close();
		await pbf.getPosition();
		await dissolve(pbf);
		const res = pbf.arrayBuffer;
		postMessage({ type: "shpdec", data: res, warning }, [res]);
	} catch (err) {
		console.error("[shape decoder]", err);
		postMessage(null);
	}
};