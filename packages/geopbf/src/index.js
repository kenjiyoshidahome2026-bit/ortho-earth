import { GeoPBF } from "./pbf.js";
import { pbfio, setApiUrl } from "./pbf-io.js";
// decoder/pbf.js (669B) と decoder/gint.js (2行) はViteがdata:URLにインライン化するため
// 相対importが解決できずWorkerエラーになる。両方とも同期フォールバックを使う。
// GeoPBF._workerUrl = new URL("./decoder/pbf.js", import.meta.url);
// GeoPBF._gintWorkerUrl = new URL("./decoder/gint.js", import.meta.url);
export { setApiUrl };
import { topology } from "./extension/topology.js";
import { gint } from "./extension/gint.js";
import { topo2geo } from "./modules/topo2geo.js";
import { gunzip, isGzip } from "native-bucket";
import { isString, isURL, isFile, isObject, isBuffer } from "common"
let server = null;
const getServer = async () => {
	server = server || pbfio("GIS").catch(e => { console.warn("PBFIO initialization failed.", e); return null; });
	return server;
}
//  ----------------------------------------------------------------------------------------
export async function geopbf(data, options = {}) { if (isString(options)) options = { name: options };
	const dt = performance.now();
	const isInZip = _ => (isString(_) && _.match(/.+\.zip#.+/i));
	const isPBF = _ => (_ instanceof GeoPBF);
	let eventTarget = options.eventTarget || (typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : null));
	if (typeof CustomEvent === 'undefined' || !eventTarget.dispatchEvent) eventTarget = null;
	const throwEvent = (type, detail) => eventTarget && eventTarget.dispatchEvent(new CustomEvent(type, { detail }));
////===========================================================================================
	const decoder = async (type, file) => {
		const name = options.name || file.name.replace(/\.[^\.]+$/, "");
		const precision = options.precision || 6;
		const encoding = (options.encoding || "utf8").toLowerCase().replace(/[\-\_]/g, "").replace(/shiftjis/, "sjis");
		const { description, license, attribution } = options;
		const params = { file, name, precision, encoding, description, license, attribution };
		const event = `convrsion from ${type} to GeoPBF`;
		throwEvent("ConvertStart",{name, event});
		const url = new URL(`./decoder/${type}.js`, import.meta.url);
		const w = new Worker(url, { type: 'module' });
		return new Promise(resolve => {
			w.onmessage = async e => {
				if (e.data?.type === 'progress') {
					throwEvent("ConvertProgress", { name, loaded: e.data.loaded, total: e.data.total });
					return;
				}
				throwEvent("ConvertEnd", { name, event });
				w.terminate(); resolve(e.data ? new GeoPBF(options).set(e.data.data) : null); };
			w.onerror = e => {
				throwEvent("ConvertEnd", { name, error: `file decode error: [${type}]` });
				w.terminate(); console.error(`file decode error: [${type}]`); resolve(null);
			};
			w.postMessage(params);
		});
	};
////===========================================================================================
	const pbf = await _geopbf(data);
	if (pbf) {
		await pbf.gint({gint: options.gint});
		console.log(`[geopbf] 📥 ${pbf.name()} (${pbf.size.toLocaleString()} bytes) ${(performance.now()-dt).toFixed(2)} msec`);
		if (isURL(data) && !pbf.originalURL) {
			const server = await getServer();
			if (server) {
				const GINT = new Uint8Array(pbf._gintBuffer).slice().buffer;
				server.cache(data, { PBF: pbf.arrayBuffer, GINT }).catch(console.error);
			}
		} else if (isFile(data) && !pbf._fileKey) {
			const server = await getServer().catch(() => null);
			if (server && options.nocache !== true) {
				const fileKey = `FILE::${data.name}::${data.size}::${data.lastModified}`;
				const GINT = new Uint8Array(pbf._gintBuffer).slice().buffer;
				server.cache(fileKey, { PBF: pbf.arrayBuffer, GINT }).catch(console.error);
			}
		}
		await pbf.fileSize();
		return pbf;
	} else return new GeoPBF(options);
////===========================================================================================
	async function _geopbf(q) {
		if (!q) return null;
		if (isPBF(q)) return q;
		if (isBuffer(q)) return new GeoPBF(options).set(q);
		if (isFile(q)) {
			if (await isGzip(q)) return _geopbf(await gunzip(q));
			const name = q.name;
			options.name = options.name || name.replace(/\.[^\.]+$/, "");
			const fileKey = `FILE::${q.name}::${q.size}::${q.lastModified}`;
			if (options.nocache !== true) {
				const server = await getServer().catch(() => null);
				if (server) {
					const val = await server.cache(fileKey).catch(() => null);
					if (val?.PBF) {
						const pbf = await new GeoPBF(options).set(val.PBF);
						val.GINT && await pbf.setGintBUF(val.GINT);
						pbf._fileKey = fileKey;
						return pbf;
					}
				}
			}
			if (name.match(/\.(geo)?pbf$/i)) return _geopbf(await q.arrayBuffer());
			if (name.match(/\.geojson$/i)) return _geopbf(await decoder("json", q));
			if (name.match(/\.(topo)?json$/i)) return _geopbf(await file2json(q));
			if (name.match(/\.fgb$/i)) return _geopbf(await decoder("fgb", q));
			if (name.match(/\.zip$/i)) return _geopbf(await decoder(options.format === "moj" ? "moj" : "shape", q));
			if (name.match(/\.kmz$/i)) return _geopbf(await decoder("kmz", q));
			if (name.match(/\.gpx$/i)) return _geopbf(await decoder("gpx", q));
			if (name.match(/\.(gml|xml)$/i)) return _geopbf(await decoder("gml", q));
			console.warn("illegal file:", name);
		}
		if (isObject(q)) {
			q = toFeatureCollection(q);
			return (q && q.features.length > 0) ? await new GeoPBF(options).set(q) : null;
		}
		const server = await getServer();
		if (isString(q) && server) {
			if (isURL(q)) {
				const fetchUrl = isInZip(q) ? q : (q.match(/\.zip$/) && options.target) ? [q, options.target].join("#") : q;
				const val = options.nocache == true? undefined: await server.cache(fetchUrl).catch(console.error);
				if (val && val.PBF) { const pbf = (await new GeoPBF(options).set(val.PBF));
					val.GINT && await pbf.setGintBUF(val.GINT);
					pbf.originalURL = q;
					return pbf;
				}
				return _geopbf(await server.fetch(fetchUrl));
			}
			return _geopbf(await server.load(q, { gint: options.gint }));
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
				(q.type == "GeometryCollection") ? fc((q.geometries ?? []).map(f)) :
				q.type ? fc([f(q)]) : fc([]);
		}
	}
}
//  ----------------------------------------------------------------------------------------
const encoder = async (pbf, type, opts = {}) => { //console.log(pbf, type, opts);
	const eventTarget = typeof window !== "undefined" ? window : (typeof self !== "undefined" ? self : null);
	const name = pbf._name, buf = pbf.arrayBuffer, gintbuf = pbf._gintBuffer;
	const event = type =="profile"? `profiling` : `conversion from GeoPBF to ${type}`;
	const throwEvent = (type, detail) => eventTarget && !opts.silent && eventTarget.dispatchEvent(new CustomEvent(type, { detail }));
	const url = new URL(`./encoder/${type}.js`, import.meta.url)
	if (url.href.startsWith('data:')) return null; // Viteがdata:URLにインライン化 → Worker生成スキップ
	opts.message == false || throwEvent("ConvertStart", { name, event });
	const w = new Worker(url, { type: 'module' });
	return new Promise(resolve => {
		w.onmessage = e => {
			opts.message == false || throwEvent("ConvertEnd", { name, event });
			w.terminate(); resolve(e.data);
		};
		w.onerror = (e) => {
			opts.message == false || throwEvent("ConvertEnd", { name, error: `file encode error: [${type}]` });
			w.terminate(); console.error(`pbf encode error: [${type}]`, e?.message, e?.filename, `line:${e?.lineno}`); resolve(null);
		};
		w.postMessage({ buf, gintbuf, name, opts }, [buf]);
	});
};
const methods = {
	async save() { const s = await getServer(); return (s && await s.save(this)) ? this : null; },
	async preview(canvas, props = {}) {
		const htmlCanvas = (typeof HTMLCanvasElement !== "undefined" && canvas instanceof HTMLCanvasElement) ? canvas : null;
		if (htmlCanvas) canvas = null;
		else if (isObject(canvas)) { props = canvas; canvas = null; }
		const offscreen = canvas || null; // OffscreenCanvas ならそのまま渡す
		const buf = this.arrayBuffer, name = this._name;
		const url = new URL('./encoder/preview.js', import.meta.url);
		const w = new Worker(url, { type: 'module' });
		const transferables = offscreen ? [buf, offscreen] : [buf];
		const bitmap = await new Promise(resolve => {
			w.onmessage = e => { w.terminate(); resolve(e.data); };
			w.onerror  = () => { w.terminate(); resolve(null); };
			w.postMessage({ buf, canvas: offscreen, name, props }, transferables);
		});
		if (htmlCanvas && bitmap instanceof ImageBitmap) {
			htmlCanvas.width  = bitmap.width;
			htmlCanvas.height = bitmap.height;
			const dpr = props.dpr || 1;
			htmlCanvas.style.width  = (bitmap.width  / dpr) + "px";
			htmlCanvas.style.height = (bitmap.height / dpr) + "px";
			htmlCanvas.getContext("2d").drawImage(bitmap, 0, 0);
		}
		return bitmap;
	},
	async profile(opts = {}) { return encoder(this, "profile", opts); },
	async gintbuf(opts = {}) { return encoder(this, "gint", opts); },
	async geopbfFile(opts = {}) { return encoder(this, "geopbf", opts); },
	async geojsonFile(opts = {}) { return encoder(this, "geojson", opts); },
	async topojsonFile(opts = {}) { return encoder(this, "topojson", opts); },
	async shapeFile(opts = {}) { return encoder(this, "shape", opts); },
	async kmzFile(opts = {}) { return encoder(this, "kmz", opts); },
	async gpxFile(opts = {}) { return encoder(this, "gpx", opts); },
	async gmlFile(opts = {}) { return encoder(this, "gml", opts); },
	async fgbFile(opts = {}) { return encoder(this, "fgb", opts); },
	async gint(opts = {}) { if (opts.gint === false) return this;
		if (!this.unPackGint) {
			let buf = await encoder(this, "gint", opts);
			if (!buf) { await gint.initialize(); buf = topology(this); }
			await this.setGintBUF(buf);
		}
		if (!this.unPackGint) throw new Error("Failed to encode Gint buffer.");
		return this;
	},
};

Object.entries(methods).forEach(([name, func]) => {
	Object.defineProperty(GeoPBF.prototype, name, { value: func, configurable: false, enumerable: false });
});