import { GeoPBFBase as GeoPBFStatics } from "../pbf-base.ts";
import type { GeoPBF } from "../pbf.ts";
import type { GeometryType, GeoPBFOptions, Properties } from "../../types/geopbf.js";
import { isNull, isUndefined, isBoolean, isNumber, isString, isFunction, isObject, isArray, isDate, isBlob, isImageData, thenMap } from "../modules/utility.ts";

/** cloneMap／map／classify の関数＝(属性, 型, bbox, 番号)（types の旧宣言は (属性, 番号) だったが実体はこの 4 引数） */
export type FeatureCallback<R> = (properties: Properties, type: GeometryType, bbox: number[], index: number) => R;
export interface CloneMapOptions { map?: FeatureCallback<Properties>; filter?: FeatureCallback<boolean> }
// 新しいインスタンスは受け手と同じ class（"geopbf" の GeoPBF）で作る（旧＝pbf-base の GeoPBF＝後付けで同じ class だった・TS 化 段 4）
const ctorOf = (self: GeoPBF): new (options?: GeoPBFOptions) => GeoPBF => self.constructor as new (options?: GeoPBFOptions) => GeoPBF;

export async function clone(self: GeoPBF): Promise<GeoPBF> { return new (ctorOf(self))().set(self.arrayBuffer); }
export async function cloneHead(self: GeoPBF): Promise<GeoPBF> {
	const pbf = await (new (ctorOf(self))().set(self.headerBuffer));
	const keytub: Record<string, number> = pbf.keytub = {}; pbf.keys.forEach((t, i) => { keytub[t] = i; });
	return pbf;
}
export async function cloneMap(self: GeoPBF, options: FeatureCallback<Properties> | CloneMapOptions): Promise<GeoPBF> {
	const pbf = await cloneHead(self);
	const o = options as CloneMapOptions;
	const map: FeatureCallback<Properties> = isFunction(options) ? options as FeatureCallback<Properties> : isFunction(o.map) ? o.map : (t => t);
	const filter: FeatureCallback<boolean> = isFunction(o.filter) ? o.filter : (() => true);
	const sels = self.each(i => i).filter(i => filter(self.getProperties(i), self.getType(i), self.getBbox(i), i));
	const props = sels.map(i => map(self.getProperties(i), self.getType(i), self.getBbox(i), i));
	pbf.setBody(() => sels.forEach((n, i) => pbf.setMessage(GeoPBFStatics.TAGS.FEATURE, () => { pbf.copyGeometry(self, n); pbf.setProperties(props[i]); }))).close();
	return pbf.getPosition();
}

export async function classify(self: GeoPBF, key: string | FeatureCallback<string | number | undefined>): Promise<GeoPBF[]> {
	const a: Record<string, number[]> = {};
	self.forEach(i => {
		const p = self.getProperties(i), s = (typeof key === "function") ? key(p, self.getType(i), self.getBbox(i), i) : p![key];
		if (s !== undefined) { a[s] = a[s] || []; a[s].push(i); }
	});
	// thenMap は失敗した組を undefined のまま残す（console に出す）＝型の上は GeoPBF の配列
	return thenMap(Object.entries(a).sort((p, q) => p[0] > q[0] ? 1 : -1), async ([k, v]) => {
		const pbf = new (ctorOf(self))({ name: self.name() + "@" + k, precision: Math.log10(self.e) }), props = v.map(i => self.getProperties(i));
		pbf.setHead(...(await GeoPBFStatics.makeKeys(props)));
		pbf.setBody(() => v.forEach((n, i) => pbf.setMessage(GeoPBFStatics.TAGS.FEATURE, () => { pbf.copyGeometry(self, n); pbf.setProperties(props[i]); }))).close();
		return pbf.getPosition();
	}) as Promise<GeoPBF[]>;
}

export async function concatinate(pbfs: GeoPBF[], name?: string): Promise<GeoPBF | null> {
	pbfs = pbfs.filter(t => t instanceof GeoPBFStatics);
	// 呼び手は pbf.concat(...)＝pbfs[0] は受け手（器の検札で落ちない）。空の時だけの予備は受け手が無い＝器の class
	if (pbfs.length == 0) return new GeoPBFStatics() as GeoPBF; if (pbfs.length == 1) return pbfs[0];
	if (!pbfs.slice(1).every(t => t._precision === pbfs[0]._precision)) { console.error("PBF concatenate: precision is not equal."); return null; }
	name = name || pbfs[0].name();
	const props = pbfs.map(pbf => pbf.properties), [keys, bufs] = await GeoPBFStatics.makeKeys(props.flat()), pbf = new (ctorOf(pbfs[0]))({ name }).setHead(keys, bufs);
	pbf.setBody(() => pbfs.forEach((t, n) => { t.forEach(i => pbf.setMessage(GeoPBFStatics.TAGS.FEATURE, () => { pbf.copyGeometry(t, i); pbf.setProperties(props[n][i]); })); })).close();
	return pbf.getPosition();
}

export function getPropertyTable(self: GeoPBF): unknown[][] | null {
	const a = self.propertiesTable; if (!a || a.length < 1) return null;
	const conv = (v: unknown): unknown => { 
		if (isNull(v)||isUndefined(v)) return "";
		if (isBoolean(v)||isNumber(v)) return v;
		if (isDate(v)) return v.toISOString();
		if (isFunction(v)) return v.toString();
		if (isBlob(v)) return `[Blob: ${(v as File).name || 'Unnamed'} (${v.type || 'unknown'}, ${v.size}B)]`;
		if (isImageData(v)) return `[ImageData: ${v.width}x${v.height}]`;
		if (isObject(v)||isArray(v)) return JSON.stringify(v);
		return String(v);
	};
	const len = a[0].length;
	const head = (["#","type"] as unknown[]).concat(a[0]);
	const body = a.slice(1).map((t,i)=>{ const q: unknown[] = [];
		for (let j = 0; j < len; j++) q[j] = conv(t[j]);
		return ([i+1, self.getType(i)] as unknown[]).concat(q);
	});
	return [head].concat(body)
}
export function getCSV(self: GeoPBF): string {
	const a = self.propertiesTable; if (!a || a.length < 1) return "";
	const quot = (s: unknown): unknown => (isString(s) && s.match(/[,"]|^0\d/))?`"${s.replace(/"/g, '""')}"`: s;
	const csv2str = (a: unknown[][]): string => (a||[]).map(row => row.map(quot).join(",")).join("\r\n");
	const conv = (v: unknown): unknown => {
		if (isNull(v)||isUndefined(v)) return "";
		if (isBoolean(v)||isNumber(v)) return v;
		if (isDate(v)) return v.toISOString();
		if (isFunction(v)) return v.toString();
		if (isBlob(v)) return `[Blob: ${(v as File).name || 'Unnamed'} (${v.type || 'unknown'}, ${v.size}B)]`;
		if (isImageData(v)) return `[ImageData: ${v.width}x${v.height}]`;
		if (isObject(v)||isArray(v)) return JSON.stringify(v);
		return String(v);
	};
	const typeSet = new Set(self.getType());
	const isPointOnly = [...typeSet].every(t => t === "Point");
	const hasLinear = [...typeSet].some(t => t === "LineString" || t === "MultiLineString" || t === "Polygon" || t === "MultiPolygon");
	const hasPolygon = [...typeSet].some(t => t === "Polygon" || t === "MultiPolygon");
	const geomHead = isPointOnly ? ["lng", "lat"] : ["xmin", "ymin", "xmax", "ymax"];
	if (hasLinear) geomHead.push("length");
	if (hasPolygon) geomHead.push("area");
	const len = a[0].length;
	const head = ([] as unknown[]).concat(["#", "type"], a[0], geomHead);
	const body = a.slice(1).map((t,i)=>{ const q: unknown[] = [];
		for (let j = 0; j < len; j++) q[j] = conv(t[j]);
		const geomVals: unknown[] = isPointOnly
			? ((c: number[]) => c ? [c[0], c[1]] : ["", ""])(self.centroid(i))
			: ((b: number[]) => b ? b : ["", "", "", ""])(self.getBbox(i));
		if (hasLinear) geomVals.push(self.lineLength(i) ?? "");
		if (hasPolygon) geomVals.push(self.area(i) ?? "");
		return ([i+1, self.getType(i)] as unknown[]).concat(q, geomVals);
	});
	return csv2str([head].concat(body));
}
