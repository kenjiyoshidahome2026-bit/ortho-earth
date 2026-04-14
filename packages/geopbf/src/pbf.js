import { GeoPBF } from "./pbf-base.js";
import * as spatial from "./extension/spatial.js";
import * as manipulate from "./extension/manipulate.js";
import { nearPoint } from "./extension/nearPoint.js";
import { contain } from "./extension/contain.js";
import { dissolve } from "./extension/dissolve.js";
import { analyzeTopology, neighbors, mesh, merge } from "./extension/topology.js"; // 変更
import { toTopoJSON } from "./extension/topojson.js";
import { drawGeometry, view } from "./extension/view.js";

const setGetter = (name, func) => { Object.defineProperty(GeoPBF.prototype, name, { get: func, configurable: false, enumerable: false }); };
const setPrototype = (name, func) => { Object.defineProperty(GeoPBF.prototype, name, { value: func, configurable: false, enumerable: false }); };
Object.defineProperty(GeoPBF, 'update', { value: manipulate.update, configurable: false, enumerable: false });
Object.defineProperty(GeoPBF, 'concatinate', { value: manipulate.concatinate, configurable: false, enumerable: false });

setGetter("count", function () { return manipulate.count(this); });
setGetter("lint", function () { return manipulate.lint(this); });

setPrototype("centroid", function (i) { return spatial.centroid(this, i); });
setPrototype("area", function (i) { return spatial.area(this, i); });
setPrototype("contain", function (pt, one) { return contain(this, pt, one); });
setPrototype("nearPoint", function (pt, count, dist) { return nearPoint(this, pt, count, dist); });

setPrototype("clone", function (opt) { return manipulate.clone(this, opt); });
setPrototype("rename", function (name) { return manipulate.clone(this, { name }); });
setPrototype("filter", function (f) { return manipulate.clone(this, { filter: f }); });
setPrototype("map", function (m) { return manipulate.clone(this, { map: m }); });
setPrototype("classify", function (k) { return manipulate.classify(this, k); });
setPrototype("header", function (meta) { return manipulate.header(this, meta); });
setPrototype("concat", function (...args) { return manipulate.concatinate([this, ...args], this.name()); });
setPrototype("dissolve", function (p) { return dissolve(this, p); });

setPrototype("analyzeTopology", function () { return analyzeTopology(this); });
setPrototype("neighbors", function (id) { return neighbors(this, id); });
setPrototype("mesh", function (f) { return mesh(this, f); });   // 追加
setPrototype("merge", function (f) { return merge(this, f); }); // 追加
setGetter("topojson", function () { return toTopoJSON(this); });

setPrototype("drawGeometry", function (n) { return drawGeometry(this, n); });
setPrototype("context", function (ctx, proj) { this.ctx = ctx; this.proj = proj; return this; });
setPrototype("view", function (canvas, props) { return view(this, canvas, props); });

export { GeoPBF };