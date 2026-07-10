import Pbf from 'pbf';
import { bufferTub, readBufs } from "./modules/bufferTub.js";
import { isString, isSimpleObject, isNumber, isFloat, isBbox } from "common";
import { antimeridianFeature } from "./modules/antimeridianFeature.js";
import { cleanCoords, } from "./modules/cleanCoords.js";


const TAGS = { NAME: 1, KEYS: 2, PRECISION: 3, BUFS: 4, FARRAY: 5, FEATURE: 6, GEOMETRY: 7, GTYPE: 8, LENGTH: 9, COORDS: 10, VALUE: 11, INDEX: 12, GARRAY: 13, DESCRIPTION: 14, LICENSE: 15, ATTRIBUTION: 16, MIN_ZOOM: 17, MAX_ZOOM: 18 };
const geometryTypes = ["Point", "MultiPoint", "LineString", "MultiLineString", "Polygon", "MultiPolygon", "GeometryCollection"];
const geometryMap = {}; geometryTypes.forEach((t, i) => geometryMap[t] = i);
const dataTypeNames = ["NULL", "BOOL", "INTEGER", "FLOAT", "STRING", "DATE", "COLOR", "FUNC", "JSON", "BBOX", "BLOB", "IMAGE"];
const DATATYPE = {}; dataTypeNames.map((s, i) => DATATYPE[s] = i); DATATYPE.UNKNOWN = -1;

class GeoPBF {
	constructor(options = {}) {
		this.pbf = new Pbf();
		this._name = options.name || "";
		this._description = options.description || "";
		this._license = options.license || "";
		this._attribution = options.attribution || "";
		this._minZoom = options.minZoom ?? null;
		this._maxZoom = options.maxZoom ?? null;
		this.e = Math.pow(10, this._precision = options.precision || 6);
		this.noprop = !!options.noprop;
		this.keys = [], this.bufs = [], this.fmap = [], this.bin = {}; this.props = [];
	}
	static setProperty(name, value) {
		if (isString(name)) {
			(name in GeoPBF) || Object.defineProperty(GeoPBF, name, { value, configurable: false, enumerable: false });
		} else Object.entries(name).map(t => GeoPBF.setProperty(...t));
	}
	static setGetter(name, func) { Object.defineProperty(GeoPBF.prototype, name, { get: func, configurable: false, enumerable: false }); }
	static setPrototype(name, func) { Object.defineProperty(GeoPBF.prototype, name, { value: func, configurable: false, enumerable: false }); }

	name(s) { return (s === undefined) ? this._name : this.updateHeader({ name: this._name = s }); }
	description(s) { return (s === undefined) ? this._description : this.updateHeader({ description: this._description = s }); }
	license(s) { return (s === undefined) ? this._license : this.updateHeader({ license: this._license = s }); }
	attribution(s) { return (s === undefined) ? this._attribution : this.updateHeader({ attribution: this._attribution = s }); }
	minZoom(v) { return (v === undefined) ? this._minZoom : this.updateHeader({ minZoom: this._minZoom = v }); }
	maxZoom(v) { return (v === undefined) ? this._maxZoom : this.updateHeader({ maxZoom: this._maxZoom = v }); }
	init() { this.keys = [], this.bufs = [], this.fmap = [], this.bin = {}; this.props = []; delete this.end; delete this.ctx; delete this.proj; return this; }
	empty() { this.pbf = new Pbf(); this.init(); this.name(""); return this; }
	destroy() {
		try {
			if (this.bufs) { this.bufs.length = 0; this.bufs = null; }
			if (this.props) { this.props.length = 0; this.props = null; }
			if (this.keys) { this.keys.length = 0; this.keys = null; }
			this.fmap = this.bin = this.pbf = null;
			this._name = this._description = this._license = this._attribution = null;
			this._minZoom = this._maxZoom = null;
		} catch (e) { }
	}
	async set(q) {
		if (q instanceof ArrayBuffer || ArrayBuffer.isView(q)) {
			if (GeoPBF._workerFactory || GeoPBF._workerUrl) return _setViaWorker(this, q instanceof ArrayBuffer ? q : q.buffer.slice(q.byteOffset, q.byteOffset + q.byteLength));
			this.pbf = new Pbf(q);
		} else if (isSimpleObject(q)) {
			const [keys, buffs] = this.noprop ? [[], []] : await makeKeys(q.features.map(t => t.properties));
			this.setHead(keys, buffs).setBody(q).close();
		} else return (console.error("PBF set: setting illegal value", q), this);
		return await this.getPosition();
	}
	async getPosition() {
		this.init();
		const pbf = this.pbf, keys = this.keys, fmap = this.fmap, props = this.props;
		const bufsReader = new readBufs();
		let pos = 0, bodyPos = 0;
		pbf.readFields(tag => {
			if (tag === TAGS.NAME) this.name(pbf.readString()), pos = pbf.pos;
			else if (tag === TAGS.DESCRIPTION) this.description(pbf.readString()), pos = pbf.pos;
			else if (tag === TAGS.LICENSE) this.license(pbf.readString()), pos = pbf.pos;
			else if (tag === TAGS.ATTRIBUTION) this.attribution(pbf.readString()), pos = pbf.pos;
			else if (tag === TAGS.MIN_ZOOM) this._minZoom = pbf.readVarint(), pos = pbf.pos;
			else if (tag === TAGS.MAX_ZOOM) this._maxZoom = pbf.readVarint(), pos = pbf.pos;
			else if (tag === TAGS.KEYS) keys.push(pbf.readString()), pos = pbf.pos;
			else if (tag === TAGS.BUFS) bufsReader.set(pbf.readBytes()), pos = pbf.pos;
			else if (tag === TAGS.PRECISION) this.e = Math.pow(10, this._precision = pbf.readVarint()), pos = pbf.pos;
			else if (tag === TAGS.FARRAY) bodyPos = pbf.pos;
		});
		this.bufs = await bufsReader.close();
		this._bodyPos = pos;
		this.end = pbf.pos;
		if (!bodyPos) return this;
		pbf.pos = bodyPos;
		pbf.readMessage(tag => {
			if (tag !== TAGS.FEATURE) return;
			var fpos, gpos, type, garray = [], tarray = [];
			const values = [], q = new Array(keys.length);
			fpos = pbf.pos;
			pbf.readMessage(ftag => {
				if (ftag === TAGS.GEOMETRY) {
					gpos = pbf.pos;
					pbf.readMessage(gtag => {
						if (gtag === TAGS.GTYPE) type = pbf.readVarint();
						else if (gtag === TAGS.GARRAY) pbf.readMessage(gatag => {
							if (gatag === TAGS.GEOMETRY) {
								garray.push(pbf.pos);
								pbf.readMessage(gaatag => (gaatag === TAGS.GTYPE) && tarray.push(pbf.readVarint()));
							}
						});
					});
				} else if (ftag === TAGS.VALUE) { pbf.readVarint(); values.push(readValue(this));
				} else if (ftag === TAGS.INDEX) {
					const end = pbf.readVarint() + pbf.pos; let vpos = 0;
					while (pbf.pos < end) q[pbf.readVarint()] = values[vpos++];
				}
			});
			fmap.push(type == 6 ? [fpos, gpos, type, garray, tarray] : [fpos, gpos, type]);
			props.push(q);
		});
		return this;
	}

	get size() { return this.end; }
	get length() { return (this.fmap || []).length; }
	each(func) { return (this.fmap || []).map((t, i) => func(i, t)); }
	forEach(func) { const a = this.fmap || []; for (let i = 0, n = a.length; i < n; i++) func(i, a[i]); return this; }

	setMessage(tag, func) { this.pbf.writeMessage(tag, func); return this; }

	setHead(keys, bufs, meta = {}) {
		if (meta.name !== undefined) this._name = meta.name;
		if (meta.description !== undefined) this._description = meta.description;
		if (meta.license !== undefined) this._license = meta.license;
		if (meta.attribution !== undefined) this._attribution = meta.attribution;
		if (meta.precision !== undefined) this.e = Math.pow(10, this._precision = meta.precision);
		if (meta.minZoom !== undefined) this._minZoom = meta.minZoom;
		if (meta.maxZoom !== undefined) this._maxZoom = meta.maxZoom;

		this.keys = keys || this.keys;
		this.bufs = bufs || this.bufs || [];
		this.keytub = {}; this.keys.forEach((t, i) => this.keytub[t] = i);
 
		this._name && this.pbf.writeStringField(TAGS.NAME, this._name);
		this._description && this.pbf.writeStringField(TAGS.DESCRIPTION, this._description);
		this._license && this.pbf.writeStringField(TAGS.LICENSE, this._license);
		this._attribution && this.pbf.writeStringField(TAGS.ATTRIBUTION, this._attribution);
		this._minZoom != null && this.pbf.writeVarintField(TAGS.MIN_ZOOM, this._minZoom);
		this._maxZoom != null && this.pbf.writeVarintField(TAGS.MAX_ZOOM, this._maxZoom);
		this.pbf.writeVarintField(TAGS.PRECISION, this._precision);
		this.keys.forEach((t, i) => { this.pbf.writeStringField(TAGS.KEYS, t); });
		this.bufs.forEach((t, i) => { this.pbf.writeBytesField(TAGS.BUFS, new Uint8Array(t)) });
		return this;
	}
	updateHeader(meta = {}) {
		if (!this._bodyPos || !this.end) return this;
		const oldBodyPos = this._bodyPos;
		const bodyData = this.pbf.buf.subarray(oldBodyPos, this.end);
		const len = new TextEncoder().encode(this._name+this._description+this._license+this._attribution).length;
		const buffer = new ArrayBuffer(this.end + len);
		this.pbf = new Pbf(buffer);
		this.setHead(this.keys, this.bufs, meta);
		const newBodyPos = this.pbf.pos;
		this.pbf.buf.set(bodyData, this.pbf.pos); this.pbf.pos += bodyData.length;
		this.close();
		this._bodyPos = newBodyPos;
		const diff = newBodyPos - oldBodyPos;
		if (this.fmap && diff !== 0) {
			this.fmap.forEach(f => {
				f[0] += diff; f[1] += diff;
				if (f[2] === 6 && f[3]) f[3] = f[3].map(p => p + diff);
			});
		}
		return this;
	}
	copyHead(pbf) {
		const meta = { name:pbf._name, description:pbf._description, license:pbf._license, attribution:pbf._attribution, precision:pbf._precision, minZoom:pbf._minZoom, maxZoom:pbf._maxZoom };
		return this.setHead(pbf.keys, pbf.bufs, meta);
	}

	setBody(obj) {
		const func = (obj instanceof Function) ? obj : () => obj.features.forEach(t => this.setFeature(t))
		return this.setMessage(TAGS.FARRAY, func);
	}
	setFeature(q) { //if (!q.geometry || !q.geometry.coordinates) return; // <===
		q.geometry = q.geometry||{}; q.geometry.coordinates = q.geometry.coordinates ||[];
		antimeridianFeature(q);
		return this.setMessage(TAGS.FEATURE, () => this.setGeometry(q.geometry).setProperties(q.properties));
	}
	setGeometry(q) { return writeGeometry(this, q); }
	setProperties(q) { return writeProperties(this, q); }
	close() { this.end = this.pbf.pos; this.pbf.finish(); return this; }

	getFeature(i) { return { type: "Feature", geometry: this.getGeometry(i), properties: this.getProperties(i) }; }
	getGeometry(i, j) { return readGeometry(this, i, j); }
	getProperties(i) { return readProperties(this, i); }
	getType(i) { return i === undefined ? this.each(i => this.getType(i)) : geometryTypes[this.fmap[i][2]]; }

	getGeometryBuffer(i, j) {
		const map = this.fmap[i];
		const pos = this.pbf.pos = (map[2] == 6 && j !== undefined) ? map[3][j] : map[1], len = this.pbf.readVarint();
		var n = len < 128 ? 1 : len < 16384 ? 2 : len < 2097152 ? 3 : 4;
		return this.pbf.buf.slice(pos - 1, pos + len + n);
	}
	setGeometryBuffer(a) { this.pbf.realloc(a.length); this.pbf.buf.set(a, this.pbf.pos); this.pbf.pos += a.length; return this; }
	copyGeometry(pbf, i) { this.setGeometryBuffer(pbf.getGeometryBuffer(i)) }
	copyProperties(pbf, i) { this.setProperties(pbf.getProperties(i)) }
	get features() { return this.each(i => this.getFeature(i)); }
	get geometries() { return this.each(i => this.getGeometry(i)); }
	get properties() { return this.each(i => this.getProperties(i)); }
	get propertiesTable() {
		if (this.props) for (let i = 0; i < this.fmap.length; i++) {
			if (this.props[i] === undefined) decodePropsAt(this, i);
		}
		return [this.keys].concat(this.props);
	}
	get arrayBuffer() { return this.pbf.buf.buffer.slice(0, this.end); }
	get headerBuffer() { return this.pbf.buf.buffer.slice(0, this.pbf.pos = this._bodyPos); }
	get geojson() {
		const features = [];
		(this.fmap || []).forEach((_, i) => {
			let f;
			try {
				f = this.getFeature(i);
			} catch (e) {
				console.warn(`GeoPBF: Feature[${i}] could not be read and was skipped.`, e);
				return;
			}
			const g = f.geometry;
			if (g != null && g.type !== "GeometryCollection" && !Array.isArray(g.coordinates)) {
				console.warn(`GeoPBF: Feature[${i}] has invalid geometry (coordinates missing) and was skipped.`);
				return;
			}
			features.push({ type: "Feature", geometry: g ?? null, properties: f.properties });
		});
		return { type: "FeatureCollection", features, name: this.name() };
	}
}

async function makeKeys(q) {
	const tub = {}, buffs = new bufferTub();
	for (let i = 0; i < q.length; i++) {
		const item = q[i];
		if (!isSimpleObject(item)) continue;
		for (let key in item) {
			const v = item[key]; tub[key] = true;
			if (v instanceof Blob) item[key].id = buffs.set(await v.arrayBuffer());
			else if (v instanceof ImageData) item[key].id = buffs.set(v.data.buffer);
			else if (isSimpleObject(v)) {
				for (let k in v) {
					const u = v[k]; tub[`${key}.${k}`] = true;
					if (u instanceof Blob) u.id = buffs.set(await u.arrayBuffer());
					if (u instanceof ImageData) u.id = buffs.set(u.data.buffer);
				}
			}
		}
	}
	return [Object.keys(tub).sort(), await buffs.close()];
}

function dataType(q) {
	const isColor = s => s.trim().match(/^rgba?\s*\([0-9,\.\s]+\)$/) || s.trim().match(/^\#[0-9a-f]{3,6}$/);
	if (q == null) return DATATYPE.NULL;
	const type = typeof q;
	if (type === "string") return isColor(q) ? DATATYPE.COLOR : DATATYPE.STRING;
	else if (type === "number") return isFloat(q) ? DATATYPE.FLOAT : DATATYPE.INTEGER;
	else if (type === "boolean") return DATATYPE.BOOL;
	else if (type === "function") return DATATYPE.FUNC;
	else if (q instanceof Date) return DATATYPE.DATE;
	else if (q instanceof Blob) return DATATYPE.BLOB;
	else if (q instanceof ImageData) return DATATYPE.IMAGE;
	else if (type === "object") return isBbox(q) ? DATATYPE.BBOX : DATATYPE.JSON;
	return DATATYPE.UNKNOWN;
}

function writeValue(self, q) {
	const { pbf } = self;
	if (q == null || q == undefined) return;
	const type = dataType(q)
	switch (type) {
		case DATATYPE.STRING: return pbf.writeStringField(type, q)
		case DATATYPE.FLOAT: return pbf.writeDoubleField(type, q);
		case DATATYPE.INTEGER: return pbf.writeSVarintField(type, q);
		case DATATYPE.BOOL: return pbf.writeBooleanField(type, q);
		case DATATYPE.JSON: return pbf.writeStringField(type, JSON.stringify(q));
		case DATATYPE.BLOB: return pbf.writeStringField(type, [q.name || "", q.type || "", q.id].join(":"));
		case DATATYPE.FUNC: return pbf.writeStringField(type, q.toString());
		case DATATYPE.IMAGE: return pbf.writeStringField(type, [q.width, q.height, q.id].join(":"));
		case DATATYPE.DATE: return pbf.writeSVarintField(type, Math.round(+q / 1000));
		case DATATYPE.BBOX: return pbf.writePackedDouble(type, q);
		case DATATYPE.COLOR: return pbf.writeBytesField(type, color(q));
	}
	function color(s) {
		s = s.replace(/\s/g, ""); var r;
		r = s.match(/^rgba\((\d+),(\d+),(\d+),([\d\.]+)\)$/); if (r) return [+r[1], +r[2], +r[3], ~~(+r[4] * 255)];
		r = s.match(/^rgb\((\d+),(\d+),(\d+)\)$/); if (r) return [+r[1], +r[2], +r[3], 255];
		r = s.match(/^\#[0-9a-f]{6}$/); if (r) return [parseInt(s.substring(1, 3), 16), parseInt(s.substring(3, 5), 16), parseInt(s.substring(5, 7), 16), 255];
		r = s.match(/^\#[0-9a-f]{3}$/); if (r) return [parseInt(s.substring(1, 2), 16) * 17, parseInt(s.substring(2, 3), 16) * 17, parseInt(s.substring(3, 4), 16) * 17, 255];
		return [0, 0, 0, 0];
	}
}

function readValue(self) {
	const { pbf, bufs, bin } = self;
	switch (pbf.readVarint() >> 3) {
		case DATATYPE.STRING: return pbf.readString();
		case DATATYPE.FLOAT: return pbf.readDouble();
		case DATATYPE.INTEGER: return pbf.readSVarint();
		case DATATYPE.BOOL: return pbf.readBoolean();
		case DATATYPE.JSON: return JSON.parse(pbf.readString());
		case DATATYPE.BLOB: return blob(pbf.readString());
		case DATATYPE.FUNC: return new Function(`return ${pbf.readString()}`);
		case DATATYPE.IMAGE: return image(pbf.readString());
		case DATATYPE.DATE: return new Date(pbf.readSVarint() * 1000);
		case DATATYPE.BBOX: return new Float64Array(pbf.readPackedDouble());
		case DATATYPE.COLOR: return color(pbf.readBytes());;
	}
	return null;
	function color(a) { return a.length == 3 || a[3] == 255 ? `rgb(${a[0]},${a[1]},${a[2]})` : `rgba(${a[0]},${a[1]},${a[2]},${(a[3] / 255).toFixed(2)})`; }
	function blob(s) {
		if (s in bin) return bin[s];
		const [name, type, id] = s.split(":"), buf = bufs[+id];
		return bin[s] = name ? new File([buf], name, { type }) : new Blob([buf], { type });
	}
	function image(s) {
		if (s in bin) return bin[s];
		const [width, height, id] = s.split(":").map(t => +t);
		return bin[s] = new ImageData(new Uint8ClampedArray(bufs[id]), width, height);
	}
}

function writeProperties(self, q) {
	const { pbf, keytub } = self;
	var index = []; if (self.noprop) return
	for (var key in q) if (q[key] != null) {
		var v = q[key];
		if (isSimpleObject(v) && Object.keys(v).every(k => `${key}.${k}` in keytub)) {
			for (let k in v) if (v[k] != null) { pbf.writeMessage(TAGS.VALUE, () => writeValue(self, v[k])); index.push(keytub[`${key}.${k}`]); }
		} else { pbf.writeMessage(TAGS.VALUE, () => writeValue(self, v)); index.push(keytub[key]); }
	}
	pbf.writePackedVarint(TAGS.INDEX, index);
}

function decodePropsAt(self, n) {
	const { pbf, keys, fmap } = self;
	const savedPos = pbf.pos;
	pbf.pos = fmap[n][0];
	const q = new Array(keys.length), values = [];
	pbf.readMessage(ftag => {
		if (ftag === TAGS.VALUE) { pbf.readVarint(); values.push(readValue(self)); }
		else if (ftag === TAGS.INDEX) {
			const end = pbf.readVarint() + pbf.pos; let vpos = 0;
			while (pbf.pos < end) q[pbf.readVarint()] = values[vpos++];
		}
		// Unknown fields (e.g. GEOMETRY) are left to readFields' automatic skip logic.
	});
	pbf.pos = savedPos;
	return self.props[n] = q;
}

function readProperties(self, n) {
	const { keys, props } = self, q = {};
	const row = props[n] !== undefined ? props[n] : decodePropsAt(self, n);
	row.forEach((v, i) => {
		const key = keys[i].split(/\./);
		if (key.length == 1) q[key[0]] = v;
		else { q[key[0]] = q[key[0]] || {}; q[key[0]][key.slice(1).join(".")] = v; }
	});
	return q;
}

function writeGeometry(self, q) {
	const { pbf, e } = self;
	return self.setMessage(TAGS.GEOMETRY, () => {
		const fix = n => { while (n < -180) n += 360; while (n > 180) n -= 360; return n; };
		let type = geometryMap[q.type], c = q.coordinates;
		if (type == null) return console.error("illegal geometry type: ", q.type);
		if (type % 2 == 1 && c.length == 1) { type--; c = c[0];}
		pbf.writeVarintField(TAGS.GTYPE, type);
		if (type == 6) return pbf.writeMessage(TAGS.GARRAY, () => q.geometries.forEach(t => writeGeometry(self, t)));
		[write0, write1, write1, write2, write2, write3][type]();
		pbf.writePackedSVarint(TAGS.COORDS, c.flat(Infinity));
		function len2() { return c.map(t => t.length); }
		function len3() { const l = [c.length]; c.forEach(t => { l.push(t.length); t.forEach(u => l.push(u.length)); }); return l; }
		function write0() { c = [Math.round(fix(c[0]) * e), Math.round(c[1] * e)]; }
		function write1() { c = diff(c); }
		function write2() { c = c.map(diff).filter(r => r.length > 0); pbf.writePackedVarint(TAGS.LENGTH, len2()); }
		function write3() { c = c.map(t => t.map(diff).filter(r => r.length > 0)).filter(p => p.length > 0); pbf.writePackedVarint(TAGS.LENGTH, len3()); }
		function diff(line) {
			if (!line || !line.length) return [];
			let sum = [0, 0], src = [], p = [];
			for (let i = 0, len = line.length; i < len; i++) {
				let x = Math.round(fix(line[i][0]) * e), y = Math.round(line[i][1] * e);
				if (src.length > 0 && src[src.length - 1][0] === x && src[src.length - 1][1] === y) continue;
				src.push([x, y]);
			}
			if (type > 3 && src.length >= 3) src = cleanCoords(src);
			for (let i = 0; i < src.length; i++) {
				let t = src[i]; p.push([t[0] - sum[0], t[1] - sum[1]]);
				sum[0] = t[0]; sum[1] = t[1];
			}
			if (type > 3 && p.length > 0) p.pop();
			return p;
		}
	});
}

function readGeometry(self, n, m) {
	const { pbf, fmap, e } = self, map = fmap[n];
	return (map[2] < 6) ? read(map[1], map[2]) : m !== undefined ? read(map[3][m], map[4][m]) : { type: geometryTypes[6], geometries: map[3].map((t, i) => read(t, map[4][i])) };
	function read(pos, type) {
		pbf.pos = pos;
		var q = { type: geometryTypes[type] }, isPoly = type > 3, lens = [], end;
		const funcs = [read0, read1, read1, read2, read2, read3][type];
		return pbf.readMessage((tag, q) => {
			if (tag === TAGS.LENGTH) pbf.readPackedVarint(lens);
			else if (tag === TAGS.COORDS) { end = pbf.readVarint() + pbf.pos; q.coordinates = funcs(); }
		}, q);
		function readCoords(p) { p = p || [0, 0]; p[0] += pbf.readSVarint(); p[1] += pbf.readSVarint(); return p; }
		function magCoords(p) { return [p[0] / e, p[1] / e]; }
		function read_n(n) { var c = [], p = [0, 0]; while (n-- > 0) c.push(magCoords(p = readCoords(p))); isPoly && c.length && c.push(c[0]); return c; }
		function read0() { return magCoords(readCoords()); }
		function read1() { var c = [], p = [0, 0]; while (pbf.pos < end) c.push(magCoords(readCoords(p))); return c; }
		function read2() { return lens.map(t => read_n(t)); }
		function read3() { const c = []; let pos = 0; for (var i = 0; i < lens[0]; i++) { var n = lens[++pos]; c[i] = []; for (var j = 0; j < n; j++) c[i].push(read_n(lens[++pos])); } return c; }
	}
}

GeoPBF.setProperty({ TAGS, makeKeys, dataType, dataTypeNames, geometryTypes, geometryMap });

function _setViaWorker(self, buf) {
	return new Promise((resolve, reject) => {
		// ファクトリ優先＝new Worker(new URL(…)) 直書きをバンドラに見せる（URL変数経由はビルドでdata:URL化して死ぬ）
		const w = GeoPBF._workerFactory ? GeoPBF._workerFactory() : new Worker(GeoPBF._workerUrl, { type: "module" });
		w.onmessage = ({ data: r }) => {
			w.terminate();
			self.init();
			self.pbf          = new Pbf(r.buf);
			self.fmap         = r.fmap;
			self.props        = new Array(r.fmap.length); // pre-allocated empty array for lazy property decoding
			self.keys         = r.keys;
			self.bufs         = r.bufs;
			self._name        = r._name;
			self._description = r._description;
			self._license     = r._license;
			self._attribution = r._attribution;
			self._minZoom     = r._minZoom;
			self._maxZoom     = r._maxZoom;
			self.e            = Math.pow(10, self._precision = r._precision);
			self._bodyPos     = r._bodyPos;
			self.end          = r.end;
			resolve(self);
		};
		w.onerror = e => { w.terminate(); reject(e); };
		w.postMessage({ buf }, [buf]);
	});
}

export { GeoPBF };