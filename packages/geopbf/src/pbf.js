import { GeoPBF } from "./pbf-base.js";
import { centroid, lineLength, area, getBbox, bboxes, bbox } from "./extension/spatial.js";
import { concatinate, clone, cloneHead, cloneMap, classify, getPropertyTable, getCSV } from "./extension/manipulate.js";
import { dissolve } from "./extension/dissolve.js";
import { topojson, neighbors, mesh, merge } from "./extension/topojson.js";
import { identify, contain } from "./extension/identify.js";
import { unPackGintBuffer } from "./extension/topology.js";
import { cleanTopology } from "./extension/clean.js";
import { precision } from "./extension/precision.js";

GeoPBF.setProperty('concatinate', { value: concatinate, configurable: false, enumerable: false });

GeoPBF.setPrototype("centroid", function(i) { return centroid(this, i); });
GeoPBF.setPrototype("lineLength", function (i) { return lineLength(this, i); });
GeoPBF.setPrototype("area", function (i) { return area(this, i); });
GeoPBF.setPrototype("getBbox", function (i) { return getBbox(this, i); });
GeoPBF.setGetter("bbox", function () { return bbox(this); });
GeoPBF.setGetter("bboxes", function () { return bboxes(this); });

GeoPBF.setPrototype("clone", function () { return clone(this); });
GeoPBF.setPrototype("cloneHead", function () { return cloneHead(this); });
GeoPBF.setPrototype("cloneMap", function (opts = {}) { return cloneMap(this, opts); });
GeoPBF.setPrototype("closeFilter", function(filter) { return cloneMap(this, { filter }); });
GeoPBF.setPrototype("map", function(map) { return cloneMap(this, { map }); });
GeoPBF.setPrototype("classify", function(k) { return classify(this, k); });
GeoPBF.setPrototype("concat", function(...args) { return concatinate([this, ...args], this.name()); });

GeoPBF.setPrototype("getPropertyTable", function() { return getPropertyTable(this); });
GeoPBF.setPrototype("getCSV", function() { return getCSV(this); });

GeoPBF.setPrototype("dissolve", function(p) { return dissolve(this, p); });

GeoPBF.setPrototype("topojson", function() { return topojson(this); });
GeoPBF.setPrototype("neighbors", function(id) { return neighbors(this, id); });
GeoPBF.setPrototype("mesh", function(f) { return mesh(this, f); });
GeoPBF.setPrototype("merge", function(f) { return merge(this, f); });
GeoPBF.setPrototype("identify", function (mx, my, proj, options) { return identify(this, mx, my, proj, options); });
GeoPBF.setPrototype("contain", function ([lng, lat]) { return contain(this, lng, lat); });

GeoPBF.setPrototype("cleanTopology", function(options) { cleanTopology(this.unPackGint, options); return this; });
GeoPBF.setPrototype("precision", async function (s) { return precision(this, s); });

GeoPBF.setPrototype("setGintBUF", async function(buf) {
	if (!buf) throw new Error("setGintBUF: buf is null — gint encoding failed");
	if (typeof SharedArrayBuffer === 'undefined') throw new Error("SharedArrayBuffer is not supported in this environment. Please set headers.");
	const sab = this._gintBuffer = new SharedArrayBuffer(buf.byteLength);
	new Uint8Array(sab).set(new Uint8Array(buf));
	if (GeoPBF._gintWorkerUrl) {
		this.unPackGint = await new Promise((resolve, reject) => {
			const w = new Worker(GeoPBF._gintWorkerUrl, { type: "module" });
			w.onmessage = e => { w.terminate(); resolve(e.data); };
			w.onerror  = e => { w.terminate(); reject(e); };
			w.postMessage({ sab });
		});
	} else {
		this.unPackGint = unPackGintBuffer(sab);
	}
	return this;
});

GeoPBF.setPrototype("fileSize", async function () { if (this._fileSize > 0) return this._fileSize;
	const stream = new Blob([this.arrayBuffer]).stream().pipeThrough(new CompressionStream('gzip'));
	return this._fileSize = (await new Response(stream).arrayBuffer()).byteLength;
});
export { GeoPBF };