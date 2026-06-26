let _GeoPBF, _topology, _unPackGintBuffer, _repackGintBuffer, _cleanTopology, _gint;
const _ready = Promise.all([
	import("../pbf-base.js"),
	import("../extension/topology.js"),
	import("../extension/clean.js"),
	import("../extension/gint.js"),
]).then(([a, b, c, d]) => {
	_GeoPBF = a.GeoPBF;
	({ topology: _topology, unPackGintBuffer: _unPackGintBuffer, repackGintBuffer: _repackGintBuffer } = b);
	_cleanTopology = c.cleanTopology;
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
		if (e.data.opts?.clean) {
			const gintData = _unPackGintBuffer(gintBuffer);
			_cleanTopology(gintData, e.data.opts?.clean !== true ? e.data.opts?.clean : {});
			gintBuffer = _repackGintBuffer(gintData);
		}
		postMessage(gintBuffer, [gintBuffer]);
	} catch (err) {
		console.error("gint encode Worker Error:", err);
		postMessage(null);
	}
};
