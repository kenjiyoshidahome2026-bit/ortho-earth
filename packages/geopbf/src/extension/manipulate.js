import { GeoPBF } from "../pbf-base.js";
import { isNull, isUndefined, isBoolean, isNumber, isString, isFunction, isObject, isArray, isDate, isBlob, isImageData, saveTo, thenMap, sum, comma } from "common";

export async function clone(self) { return new GeoPBF().set(self.arrayBuffer); }
export async function cloneHead(self) {
    const pbf = await (new GeoPBF().set(self.headerBuffer));
    pbf.keytub = {}; pbf.keys.forEach((t, i) => { pbf.keytub[t] = i; });
    return pbf;
}
export async function cloneMap(self, options) {
    const pbf = await cloneHead(self);
    const map = isFunction(options) ? options: isFunction(options.map) ? options.map : (t => t);
    const filter = isFunction(options.filter) ?options.filter: (() => true);
    const sels = self.each(i => i).filter(i => filter(self.getProperties(i), self.getType(i), self.getBbox(i), i));
    const props = sels.map(i => map(self.getProperties(i), self.getType(i), self.getBbox(i), i));
    pbf.setBody(() => sels.forEach((n, i) => pbf.setMessage(GeoPBF.TAGS.FEATURE, () => { pbf.copyGeometry(self, n); pbf.setProperties(props[i]); }))).close();
    return pbf.getPosition();
}

export async function classify(self, key) {
    const a = {};
    self.forEach(i => {
        const p = self.getProperties(i), s = (typeof key === "function") ? key(p, self.getType(i), self.getBbox(i), i) : p[key];
        if (s !== undefined) { a[s] = a[s] || []; a[s].push(i); }
    });
    return thenMap(Object.entries(a).sort((p, q) => p[0] > q[0] ? 1 : -1), async ([k, v]) => {
        const pbf = new GeoPBF({ name: self.name() + "@" + k, precision: Math.log10(self.e) }), props = v.map(i => self.getProperties(i));
        pbf.setHead(...(await GeoPBF.makeKeys(props)));
        pbf.setBody(() => v.forEach((n, i) => pbf.setMessage(GeoPBF.TAGS.FEATURE, () => { pbf.copyGeometry(self, n); pbf.setProperties(props[i]); }))).close();
        return pbf.getPosition();
    });
}

export async function concatinate(pbfs, name) {
    pbfs = pbfs.filter(t => t instanceof GeoPBF);
    if (pbfs.length == 0) return new GeoPBF(); if (pbfs.length == 1) return pbfs[0];
    if (!pbfs.slice(1).every(t => t._precision === pbfs[0]._precision)) { console.error("PBF concatenate: precision is not equal."); return null; }
    name = name || pbfs[0].name();
    const props = pbfs.map(pbf => pbf.properties), [keys, bufs] = await GeoPBF.makeKeys(props.flat()), pbf = new GeoPBF({ name }).setHead(keys, bufs);
    pbf.setBody(() => pbfs.forEach((t, n) => { t.forEach(i => pbf.setMessage(GeoPBF.TAGS.FEATURE, () => { pbf.copyGeometry(t, i); pbf.setProperties(props[n][i]); })); })).close();
    return pbf.getPosition();
}

export function getPropertyTable(self) {
    const a = self.propertiesTable; if (!a || a.length < 1) return null;
    const conv = (v) => { 
        if (isNull(v)||isUndefined(v)) return "";
        if (isBoolean(v)||isNumber(v)) return v;
        if (isDate(v)) return v.toISOString();
        if (isFunction(v)) return v.toString();
        if (isBlob(v)) return `[Blob: ${v.name || 'Unnamed'} (${v.type || 'unknown'}, ${v.size}B)]`;
        if (isImageData(v)) return `[ImageData: ${v.width}x${v.height}]`;
        if (isObject(v)||isArray(v)) return JSON.stringify(v);
        return String(v);
    };
    const len = a[0].length;
    const head = ["#","type"].concat(a[0]);
    const body = a.slice(1).map((t,i)=>{ const q = [];
        for (let j = 0; j < len; j++) q[j] = conv(t[j]);
        return [i+1, self.getType(i)].concat(q);
    });
    return [head].concat(body)
}
export function getCSV(self) {
    const a = self.propertiesTable; if (!a || a.length < 1) return "";
	const quot = s => (isString(s) && s.match(/[,"]|^0\d/))?`"${s.replace(/"/g, '""')}"`: s;
	const csv2str = a => (a||[]).map(row => row.map(quot).join(",")).join("\r\n");
    const conv = (v) => { 
        if (isNull(v)||isUndefined(v)) return "";
        if (isBoolean(v)||isNumber(v)) return v;
        if (isDate(v)) return v.toISOString();
        if (isFunction(v)) return v.toString();
        if (isBlob(v)) return `[Blob: ${v.name || 'Unnamed'} (${v.type || 'unknown'}, ${v.size}B)]`;
        if (isImageData(v)) return `[ImageData: ${v.width}x${v.height}]`;
        if (isObject(v)||isArray(v)) return JSON.stringify(v);
        return String(v);
    };
    const len = a[0].length;
    const head = [].concat(["#", "type"], a[0],["xmin","ymin","xmax","ymax"]);
    const body = a.slice(1).map((t,i)=>{ const q = [];
        for (let j = 0; j < len; j++) q[j] = conv(t[j]);
        return [i+1, self.getType(i)].concat(q);
    });
	return csv2str([head].concat(body));
}
