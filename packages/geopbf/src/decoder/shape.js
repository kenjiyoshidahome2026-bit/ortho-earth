import { GeoPBF } from "../pbf-base.js";
import { decodeZIP } from "native-bucket";

const view = a => new DataView(a.buffer, a.byteOffset, a.byteLength);
const thenMap = async (a, f) => {
	const r = [];
	for (let i = 0; i < a.length; i++) r.push(await f(a[i], i).catch(console.error));
	return r;
};
const getbbox = r => {
	let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
	r.forEach(p => {
		if (p[0] < xmin) xmin = p[0]; if (p[0] > xmax) xmax = p[0];
		if (p[1] < ymin) ymin = p[1]; if (p[1] > ymax) ymax = p[1];
	});
	return [xmin, ymin, xmax, ymax];
};
const includes = (b, pt) => !(b[0] > pt[0] || b[2] < pt[0] || b[1] > pt[1] || b[3] < pt[1]);
const contains = (ring, pt) => {
	let [x, y] = pt, inside = false;
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		let xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
		if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
	}
	return inside;
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
		const q = {}, parse = {
			B: v => +v.trim(), F: v => +v.trim(), N: v => +v.trim(),
			L: v => /^[yt]$/i.test(v), D: v => new Date(v.replace(/(....)(..)(..)/, "$1-$2-$3")),
			C: v => { v = v.trim().replace(/\x00/g, ""); return v.length ? v : null; }
		};
		let i = 1;
		this.fields.forEach(f => {
			const raw = this.dec.decode(value.subarray(i, i += f.length));
			const v = (parse[f.type] || parse.C)(raw);
			if (v !== null) q[f.name] = v;
		});
		return q;
	}
}
const Point = q => ({ type: "Point", coordinates: [q.getFloat64(4, true), q.getFloat64(12, true)] });
const PolyLine = q => {
	let p = 44, n = q.getInt32(36, true), m = q.getInt32(40, true);
	const parts = [], pts = [];
	for (let i = 0; i < n; i++, p += 4) parts.push(q.getInt32(p, true));
	for (let i = 0; i < m; i++, p += 16) pts.push([q.getFloat64(p, true), q.getFloat64(p + 8, true)]);
	const lines = parts.map((st, i) => pts.slice(st, parts[i + 1]));
	return n === 1 ? { type: "LineString", coordinates: lines[0] } : { type: "MultiLineString", coordinates: lines };
};
const Polygon = q => {
	let p = 44, n = q.getInt32(36, true), m = q.getInt32(40, true);
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
	constructor(s) {
		const h = view(s.subarray(0, 100));
		this.type = h.getInt32(32, true); this.source = s.subarray(100);
		this.parse = { 1: Point, 3: PolyLine, 5: Polygon, 8: Point, 11: Point, 13: PolyLine, 15: Polygon }[this.type];
	}
	read() {
		if (!this.source.byteLength) return null;
		const len = view(this.source.subarray(4, 8)).getInt32(0, false) * 2;
		const type = view(this.source.subarray(8, 12)).getInt32(0, true);
		const s = this.source.subarray(8, 8 + len); this.source = this.source.subarray(8 + len);
		return type === this.type ? this.parse(view(s)) : this.read();
	}
}
self.onmessage = async (e) => {
	const { file, encoding, precision } = e.data, name = file.name;
	const entries = await decodeZIP(file);
	const keySet = new Set();
	const shpFiles = entries.filter(t => t.name.match(/\.shp$/i));
	const dbs = await Promise.all(shpFiles.map(async f => {
		const base = f.name.replace(/\.shp$/i, "");
		const dbfFile = entries.find(t => t.name === base + ".dbf");
		const cpgFile = entries.find(t => t.name === base + ".cpg");
		if (!dbfFile) return null;
		const shpBuf = new Uint8Array(await f.arrayBuffer());
		const dbfBuf = new Uint8Array(await dbfFile.arrayBuffer());
		const enc = (cpgFile ? await cpgFile.text() : (dbfBuf[29] === 0x13 ? 'sjis' : encoding)).trim();
		const dbf = new DBF(dbfBuf, enc);
		dbf.fields.forEach(field => keySet.add(field.name)); // プロパティ名を全収集
		return [new SHP(shpBuf), dbf];
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
	const res = pbf.arrayBuffer;
	self.postMessage({ type: "shpdec", data: res }, [res]);
};