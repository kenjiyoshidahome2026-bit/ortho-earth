import { GeoPBF } from "./pbf-base.js";
import { centroid, lineLength, area, getBbox, bboxes, bbox } from "./extension/spatial.js";
import { concatinate, clone, classify, getPropertyTable, getCSV } from "./extension/manipulate.js";
import { dissolve } from "./extension/dissolve.js";
import { topojson, neighbors, mesh, merge } from "./extension/topojson.js";
import { identify } from "./extension/identify.js";
import { view } from "./extension/view.js";
import { unPackGintBuffer } from "./extension/topology.js";

const setGetter = (name, func) => { Object.defineProperty(GeoPBF.prototype, name, { get: func, configurable: false, enumerable: false }); };
const setPrototype = (name, func) => { Object.defineProperty(GeoPBF.prototype, name, { value: func, configurable: false, enumerable: false }); };
Object.defineProperty(GeoPBF, 'concatinate', { value: concatinate, configurable: false, enumerable: false });

setPrototype("centroid", function(i) { return centroid(this, i); });
setPrototype("lineLength", function (i) { return lineLength(this, i); });
setPrototype("area", function (i) { return area(this, i); });
setPrototype("getBbox", function (i) { return getBbox(this, i); });
setGetter("bbox", function () { return bbox(this); });
setGetter("bboxes", function () { return bboxes(this); });

setPrototype("clone", function() { return clone(this); });
setPrototype("filter", function(filter) { return clone(this, { filter }); });
setPrototype("map", function(map) { return clone(this, { map }); });
setPrototype("classify", function(k) { return classify(this, k); });
setPrototype("concat", function(...args) { return concatinate([this, ...args], this.name()); });
setPrototype("getPropertyTable", function() { return getPropertyTable(this); });
setPrototype("getCSV", function() { return getCSV(this); });

setPrototype("dissolve", function(p) { return dissolve(this, p); });

setPrototype("topojson", function() { return topojson(this); });
setPrototype("neighbors", function(id) { return neighbors(this, id); });
setPrototype("mesh", function(f) { return mesh(this, f); });
setPrototype("merge", function(f) { return merge(this, f); });
setPrototype("identify", function (mx, my, proj, options) { return identify(this, mx, my, proj, options); });

setPrototype("view", function (width, height, props) { return view(this, width, height, props); });
setPrototype("setGintBUF", function(buf) { 
	if (typeof SharedArrayBuffer === 'undefined') throw new Error("SharedArrayBuffer is not supported in this environment. Please set headers.");
	const sab = this._gintBuffer = new SharedArrayBuffer(buf.byteLength);
    new Uint8Array(sab).set(new Uint8Array(buf));
	this.unPackGint = unPackGintBuffer(sab); return this;
});

setPrototype("fileSize", async function () { if (this._fileSize > 0) return this._fileSize;
	const stream = new Blob([this.arrayBuffer]).stream().pipeThrough(new CompressionStream('gzip'));
	return this._fileSize = (await new Response(stream).arrayBuffer()).byteLength;
});
export { GeoPBF };