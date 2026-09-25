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
		let gintBuffer = _topology(pbf);
		if (e.data.opts?.clean) gintBuffer = _cleanGintBuffer(gintBuffer, e.data.opts.clean);
		postMessage(gintBuffer, [gintBuffer]);
	} catch (err) {
		console.error("gint encode Worker Error:", err);
		postMessage(null);
	}
};
