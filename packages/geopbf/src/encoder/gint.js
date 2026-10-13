let _GeoPBF, _topology, _cleanGintBuffer, _gint;
const _ready = Promise.all([
	import("../pbf-base.js"),
	import("../extension/topology.js"),
	import("../extension/clean.js"),
	import("../extension/gint.js"),
]).then(([a, b, c, d]) => {
	_GeoPBF = a.GeoPBF;
	_topology = b.topology;
	_cleanGintBuffer = c.cleanGintBuffer;
	_gint = d.gint;
}).catch(err => {
	console.error("[gint encoder] module import failed:", err);
});

let wasmInitPromise = null;

onmessage = async (e) => {
	try {
		await _ready;
		if (!_gint) { postMessage(null); return; }
		if (!wasmInitPromise) wasmInitPromise = _gint.initialize();
		await wasmInitPromise;
		const pbf = await new _GeoPBF().set(e.data.buf);
		// shared＝main が SAB を使える時は GintBUF を SAB に直に組む（setGintBUF の写しが消える）。clean を掛けると repack の ArrayBuffer
		let gintBuffer = _topology(pbf, { shared: !!e.data.opts?.shared && !e.data.opts?.clean });
		if (e.data.opts?.clean) gintBuffer = _cleanGintBuffer(gintBuffer, e.data.opts.clean);
		postMessage(gintBuffer, gintBuffer instanceof ArrayBuffer ? [gintBuffer] : []);   // SAB は transfer 不可＝共有のまま渡す
	} catch (err) {
		console.error("gint encode Worker Error:", err);
		postMessage(null);
	}
};
