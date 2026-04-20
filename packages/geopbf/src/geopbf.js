import { GeoPBF } from "./pbf.js";
import { pbfio } from "./pbf-io.js";
import { Logger } from "common/logger.js";
import { topo2geo } from "./modules/topo2geo.js";
import { gunzip, isGzip } from "native-bucket";
import { isString, isURL, isFile, isObject, isBuffer } from "common/utility.js"
const logger = new Logger();
let server = null;
const getServer = async () => {
    server = server || pbfio("GIS").catch(e => { logger.warn("PBFIO initialization failed.", e); return null; });
    return server;
}
//  ----------------------------------------------------------------------------------------
export async function geopbf(data, options = {}) {
    if (isString(options)) options = { name: options };
    logger.title("geopbf"); 
    const isInZip = _ => (_.match(/.+\.zip#.+/i));
    const isPBF = _ => (_ instanceof GeoPBF);

    const decoder = async (type, file) => {
        const encoding = (options.encoding || "utf8").toLowerCase().replace(/[\-\_]/g, "").replace(/shiftjis/, "sjis");
        const params = { file, precision: options.precision || 6, encoding, };
        const url = new URL(`./decoder/${type}.js`, import.meta.url);
        const w = new Worker(url, { type: 'module' });
        return new Promise(resolve => {
            w.onmessage = async e => { w.terminate(); resolve(e.data ? new GeoPBF(options).set(e.data.data) : null); };
            w.onerror = () => { w.terminate(); logger.error(`file decode error: [${type}]`); resolve(null); };
            w.postMessage(params);
        });
    }

    const pbf = await _geopbf(data);
    pbf && logger.success(`geopbf: ${pbf.name()} (${pbf.size.toLocaleString()} bytes)`);
    return pbf || new GeoPBF(options);
    async function _geopbf(q) { //console.log(q); debugger
        if (!q) return null;
        if (isPBF(q)) return q;
        if (isBuffer(q)) return new GeoPBF(options).set(q);
        if (isFile(q)) {
            if (await isGzip(q)) return _geopbf(await gunzip(q));
            const name = q.name;
            options.name = options.name || name.replace(/\.[^\.]+$/, "");
            if (name.match(/\.(geo)?pbf$/i)) return _geopbf(await q.arrayBuffer());
            if (name.match(/\.(geo|topo)?json$/i)) return _geopbf(await decoder("json", q));
            if (name.match(/\.zip$/i)) return _geopbf(await decoder("shape", q));
            if (name.match(/\.kmz$/i)) return _geopbf(await decoder("kmz", q));
            if (name.match(/\.gpx$/i)) return _geopbf(await decoder("gpx", q));
            if (name.match(/\.(gml|xml)$/i)) return _geopbf(await decoder("gml", q));
            if (name.match(/\.gz(ip)?$/i)) return _geopbf(await gunzip(q));
            logger.warn("illegal file:", name);
        }
        if (isObject(q)) {
            q = toFeatureCollection(q);
            return (q && q.features.length > 0) ? await new GeoPBF(options).set(q) : null;
        }
        const server = await getServer();
        if (isString(q) && server) {
            const usecache = !options.nocache;
            if (isURL(q)) {
                const fetchUrl = isInZip(q) ? q : (q.match(/\.zip$/) && options.target) ? [q, options.target].join("#") : q;
                return _geopbf(await server.fetch(fetchUrl, usecache));
            }
            return _geopbf(await server.load(q));
        }
        return null;
        async function file2json(file) {
            const json = toFeatureCollection(JSON.parse(await file.text()));
            json.name = file.name.split("/").reverse()[0].replace(/\.[^\.]+$/, "");
            return json;
        }
        function toFeatureCollection(q) {
            const fc = a => ({ type: "FeatureCollection", features: a });
            const f = g => ({ type: "Feature", geometry: g, properties: {} });
            return Array.isArray(q) ? fc(q.filter(t => isObject(t) && t.type == "Feature")) :
                (q.type == "Topology") ? topo2geo(q) :
                    (q.type == "FeatureCollection") ? q :
                        (q.type == "Feature") ? fc([q]) :
                            (q.type == "GeometryCollection") ? fc(q.map(f)) : fc([]);
        }
    }
}
//  ----------------------------------------------------------------------------------------
const encoder = async (pbf, type, gz, encoding) => {
    const url = new URL(`./encoder/${type}.js`, import.meta.url)
    const w = new Worker(url, { type: 'module' });
    const name = pbf._name, buf = pbf.arrayBuffer;
    return new Promise(resolve => {
        w.onmessage = e => { w.terminate(); resolve(e.data); };
        w.onerror = () => { w.terminate(); logger.error(`pbf encode error: [${type}]`); resolve(null); };
        w.postMessage({ buf, name, gz, encoding }, [buf]);
    });
};
const methods = {
    async save() { const s = await getServer(); return (s && await s.save(this)) ? this : null; },
    async pbfFile(flag) { return encoder(this, "pbf", flag); },
    async geojsonFile(flag) { return encoder(this, "geojson", flag); },
    async topojsonFile(flag) { return encoder(this, "topojson", flag); },
    async fgbFile(flag) { return encoder(this, "fgb", flag); }, 
    async shape(encoding = "utf8") { return encoder(this, "shape", false, encoding); },
    async kmz(flag = true) { return encoder(this, "kmz", flag); },//flag: true=>kmz, false=>kml
    async gpx(flag) { return encoder(this, "gpx", flag); },
    async gml(flag) { return encoder(this, "gml", flag); }
};

Object.entries(methods).forEach(([name, func]) => {
    Object.defineProperty(GeoPBF.prototype, name, { value: func, configurable: false, enumerable: false });
});