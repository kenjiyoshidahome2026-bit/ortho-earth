import { GeoPBF } from "./pbf-base.js";
import { centroid, lineLength, area, getBbox, bboxes, bbox } from "./extension/spatial.js";
import { concatinate, clone, cloneHead, cloneMap, classify, getPropertyTable, getCSV } from "./extension/manipulate.js";
import { dissolve } from "./extension/dissolve.js";
import { topojson, neighbors, mesh, merge } from "./extension/topojson.js";
import { identify, identifyAt, contain } from "./extension/identify.js";
import { simplified } from "./extension/simplify.js";
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
GeoPBF.setPrototype("identifyAt", function (lng, lat, options) { return identifyAt(this, lng, lat, options); });   // 描画レス識別（proj不要・許容半径m）
GeoPBF.setPrototype("contain", function ([lng, lat]) { return contain(this, lng, lat); });

GeoPBF.setPrototype("simplified", function (minRank) { return simplified(this, minRank); });   // VWランク間引きFC（描画でなく専用データ焼き用）
GeoPBF.setPrototype("cleanTopology", function(options) { cleanTopology(this.unPackGint, options); return this; });
// 引数なし＝同期の読み取り（pbf-base の precision() と同じ・CLI/Node からも素直に読める）。引数あり＝再エンコードして新インスタンスを返す（Promise）。
GeoPBF.setPrototype("precision", function (s) { return s === undefined ? this._precision : precision(this, s); });

GeoPBF.setPrototype("setGintBUF", async function(buf) {
	if (!buf) throw new Error("setGintBUF: buf is null — gint encoding failed");
	// SAB＝worker へのゼロコピー共有（最適化）であって必須ではない。Safari は COEP:credentialless を認識せず
	// crossOriginIsolated が立たない＝SAB 不在。ここで throw すると海岸線/14条筆が Safari/iPhone で全滅する
	//（実際に起きた）ので、無い環境は通常 ArrayBuffer＝structured clone のコピー1回を払って動かす。
	let payload;
	if (typeof SharedArrayBuffer !== "undefined") {
		payload = this._gintBuffer = new SharedArrayBuffer(buf.byteLength);
		new Uint8Array(payload).set(new Uint8Array(buf));
	} else {
		payload = this._gintBuffer = buf.slice(0);   // 自前コピーを保持（呼び出し元の buf と縁を切る＝IDB put 等は従来通り）
	}
	if (GeoPBF._gintWorkerFactory || GeoPBF._gintWorkerUrl) {
		this.unPackGint = await new Promise((resolve, reject) => {
			const w = GeoPBF._gintWorkerFactory ? GeoPBF._gintWorkerFactory() : new Worker(GeoPBF._gintWorkerUrl, { type: "module" });
			w.onmessage = e => { w.terminate(); resolve(e.data); };
			w.onerror  = e => { w.terminate(); reject(e); };
			w.postMessage({ sab: payload });   // AB の場合は structured clone（unpack は内部でコピーする設計＝どちらでも正しい）
		});
	} else {
		this.unPackGint = unPackGintBuffer(payload);
	}
	return this;
});

GeoPBF.setPrototype("fileSize", async function () { if (this._fileSize > 0) return this._fileSize;
	const stream = new Blob([this.arrayBuffer]).stream().pipeThrough(new CompressionStream('gzip'));
	return this._fileSize = (await new Response(stream).arrayBuffer()).byteLength;
});
export { GeoPBF };