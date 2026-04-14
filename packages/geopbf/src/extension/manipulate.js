import { GeoPBF } from "../pbf-base.js";

const thenMap = async (a, func) => {
    const q = []; for (let i = 0; i < a.length; i++) q.push(await func(a[i], i).catch(console.error));
    return q;
};

export function count(self) {
    const sum = a => { let n = 0; a.forEach(t => n += t); return n; };
    if (self.counts) return self.counts;
    const counts = [0, 0, 0, 0];
    const sumup = g => {
        const { type, coordinates: c } = g; if (!c) return;
        const t = GeoPBF.geometryMap[type];
        switch (t) {
            case 0: counts[0] += 1; counts[3] += 1; break;
            case 1: counts[0] += c.length; counts[3] += c.length; break;
            case 2: counts[1] += 1; counts[3] += c.length; break;
            case 3: counts[1] += c.length; counts[3] += sum(c.map(t => t.length)); break;
            case 4: counts[2] += 1; counts[3] += sum(c.map(t => t.length)); break;
            case 5: counts[2] += c.length; counts[3] += sum(c.map(t => sum(t.map(u => u.length)))); break;
        }
    };
    self.each(i => {
        const g = self.getGeometry(i);
        if (self.getType(i) === "GeometryCollection") g.geometries.forEach(sumup);
        else sumup(g);
    });
    return (self.counts = counts);
}

export function lint(self) {
    const comma = _ => String(_).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    let str = []; const countArr = [0, 0, 0, 0, 0, 0, 0, 0];
    self.each((i, fmap) => countArr[fmap[2]]++);
    const types = countArr.map((n, i) => n ? `#${GeoPBF.geometryTypes[i]}: ${n}` : ``).filter(t => t);
    str.push(`-------------------------------------------------`, ` GEOPBF ${self._name}`, `-------------------------------------------------`);
    str.push(` FEATURES: ${self.length} ( ${types.join(" , ")} )`, ` SIZE: ${comma(self.size)} [bytes]`, ` PRECiSION: ${self._precision} [${1 / self.e}]`, ` BBOX: ${JSON.stringify(self.bbox)}`);
    const [point_count, line_count, poly_count, coords_count] = self.count.map(comma);
    str.push(`-------------------------------------------------`, ` GEOMETRY SECTION`, `-------------------------------------------------`, ` # POINT: ${point_count}`, ` # LINE: ${line_count}`, ` # POLYGON: ${poly_count}`, ` # TOTAL COORDINATES: ${coords_count}`);
    str.push(`-------------------------------------------------`, ` PROPERTIES SECTION (${self.keys.length} properties)`, `-------------------------------------------------`);
    const typesort = a => {
        const q = {}; a.forEach(t => q[t] = (q[t] || 0) + 1);
        const c = Object.entries(q).sort((p, q) => q[1] - p[1]);
        return (c.length == 2 && GeoPBF.dataTypeNames[c[0][0]] == "FLOAT" && GeoPBF.dataTypeNames[c[1][0]] == "INTEGER") ? [[c[0][0], (c[0][1] + c[1][1])]] : c;
    };
    var a = Array.from({ length: self.keys.length }, () => []);
    self.props.forEach((t) => t.forEach((s, j) => { if (s !== undefined) a[j].push(s); }));
    a.forEach((values, i) => {
        var typeStr = typesort(values.map(t => GeoPBF.dataType(t))).map(t => `${GeoPBF.dataTypeNames[t[0]]}:${t[1]}`).join("|");
        str.push(` ${self.keys[i]}: ${typeStr}`);
    });
    str.push(`-------------------------------------------------`, new Date().toString());
    return str.join("\n") + "\n";
}

export async function clone(self, options = {}) {
    let { name, filter, map } = options;
    name = name || ""; map = map || (t => t); filter = filter || (() => true);
    if (name.startsWith("@")) name = self.name() + name;
    const pbf = new GeoPBF({ name, precision: Math.log10(self.e) });
    const sels = self.each(i => i).filter(i => filter(self.getProperties(i), self.getType(i), self.getBbox(i), i));
    const props = sels.map(i => map(self.getProperties(i), self.getType(i), self.getBbox(i)));
    pbf.setHead(...(await GeoPBF.makeKeys(props)));
    pbf.setBody(() => sels.forEach((n, i) => pbf.setMessage(GeoPBF.TAGS.FEATURE, () => { pbf.copyGeometry(self, n); pbf.setProperties(props[i]); }))).close();
    return pbf.getPosition();
}

export async function classify(self, key) {
    const a = {};
    self.each(i => {
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

export function header(self, meta = {}) {
    return self.updateHeader(meta);
}

export async function update(buffer, meta = {}) {
    return GeoPBF.update(buffer, meta);
}

export async function concatinate(pbfs, name) {
    pbfs = pbfs.filter(t => t instanceof GeoPBF);
    if (pbfs.length == 0) return new GeoPBF(); if (pbfs.length == 1) return pbfs[0];
    if (!pbfs.map(t => t.precision()).slice(1).every((t, i, a) => t == pbfs[0].precision())) { console.error("PBF concatenate: precision is not equal."); return null; }
    name = name || pbfs[0].name();
    const props = pbfs.map(pbf => pbf.properties), [keys, bufs] = await GeoPBF.makeKeys(props.flat()), pbf = new GeoPBF({ name }).setHead(keys, bufs);
    pbf.setBody(() => pbfs.forEach((t, n) => { t.each(i => pbf.setMessage(GeoPBF.TAGS.FEATURE, () => { pbf.copyGeometry(t, i); pbf.setProperties(props[n][i]); })); })).close();
    return pbf.getPosition();
}