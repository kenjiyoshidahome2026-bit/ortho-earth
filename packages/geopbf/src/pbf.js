import { GeoPBF } from "./pbf-base.js";
import { centroid, area } from "./extension/spatial.js";
import { concatinate, clone, classify } from "./extension/manipulate.js";
//import { contain } from "./extension/contain.js";
import { dissolve } from "./extension/dissolve.js";
import { topojson, neighbors, mesh, merge } from "./extension/topojson.js";
import { identify } from "./extension/identify.js";
import { drawGeometry, view } from "./extension/view.js";
import { unPackGintBuffer } from "./extension/topology.js";

const setGetter = (name, func) => { Object.defineProperty(GeoPBF.prototype, name, { get: func, configurable: false, enumerable: false }); };
const setPrototype = (name, func) => { Object.defineProperty(GeoPBF.prototype, name, { value: func, configurable: false, enumerable: false }); };
Object.defineProperty(GeoPBF, 'concatinate', { value: concatinate, configurable: false, enumerable: false });

setPrototype("centroid", function(i) { return centroid(this, i); });
setPrototype("area", function(i) { return area(this, i); });

//setGetter("count", function() { return manipulate.count(this); });
//setPrototype("lint", function(opts = {}) { return manipulate.lint(this, opts); });

//setPrototype("contain", function(pt, one) { return contain(this, pt, one); });

setPrototype("clone", function() { return clone(this); });
setPrototype("filter", function(f) { return clone(this, { filter: f }); });
setPrototype("map", function(m) { return clone(this, { map: m }); });
setPrototype("classify", function(k) { return classify(this, k); });
//setPrototype("header", function(meta) { return manipulate.header(this, meta); });
setPrototype("concat", function(...args) { return concatinate([this, ...args], this.name()); });
setPrototype("dissolve", function(p) { return dissolve(this, p); });

setPrototype("topojson", function() { return topojson(this); });
setPrototype("neighbors", function(id) { return neighbors(this, id); });
setPrototype("mesh", function(f) { return mesh(this, f); });
setPrototype("merge", function(f) { return merge(this, f); });
setPrototype("identify", function (mx, my, proj, options) { return identify(this, mx, my, proj, options); });

//setPrototype("drawGeometry", function(n) { return drawGeometry(this, n); });
//setPrototype("context", function(ctx, proj) { this.ctx = ctx; this.proj = proj; return this; });
setPrototype("view", function(canvas, props) { return view(this, canvas, props); });
setPrototype("setGintBUF", function(buf) { 
	if (typeof SharedArrayBuffer === 'undefined') throw new Error("SharedArrayBuffer is not supported in this environment. Please set headers.");
	const sab = this._gintBuffer = new SharedArrayBuffer(buf.byteLength);
    new Uint8Array(sab).set(new Uint8Array(buf));
	this.unPackGint = unPackGintBuffer(sab); return this;
});

setPrototype("fileSize", async function() { 
	const buf = this.arrayBuffer;
	const url = new URL(`./encoder/fileSize.js`, import.meta.url);
	const w = new Worker(url, { type: 'module' });
	return new Promise(resolve => {
		w.onmessage = e => { w.terminate(); resolve(e.data); };
		w.postMessage(buf, [buf]);
	});
 });
export { GeoPBF };