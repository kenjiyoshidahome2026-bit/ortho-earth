import type { GeoPBF } from "../pbf-base.ts";
import type { topology } from "../extension/topology.ts";
import type { cleanGintBuffer } from "../extension/clean.ts";
import type { gint } from "../extension/gint.ts";
import type { EncodeRequest } from "../worker-msg.ts";

let _GeoPBF: typeof GeoPBF | undefined, _topology: typeof topology | undefined, _cleanGintBuffer: typeof cleanGintBuffer | undefined, _gint: typeof gint | undefined;
const _ready = Promise.all([
	import("../pbf-base.ts"),
	import("../extension/topology.ts"),
	import("../extension/clean.ts"),
	import("../extension/gint.ts"),
]).then(([a, b, c, d]) => {
	_GeoPBF = a.GeoPBF;
	_topology = b.topology;
	_cleanGintBuffer = c.cleanGintBuffer;
	_gint = d.gint;
}).catch(err => {
	console.error("[gint encoder] module import failed:", err);
});

let wasmInitPromise: Promise<unknown> | null = null;

onmessage = async (e: MessageEvent<EncodeRequest>) => {
	try {
		await _ready;
		if (!_gint) { postMessage(null); return; }
		if (!wasmInitPromise) wasmInitPromise = _gint.initialize();
		await wasmInitPromise;
		const pbf = await new _GeoPBF!().set(e.data.buf);
		// shared＝main が SAB を使える時は GintBUF を SAB に直に組む（setGintBUF の写しが消える）。clean を掛けると repack の ArrayBuffer
		let gintBuffer = _topology!(pbf, { shared: !!e.data.opts?.shared && !e.data.opts?.clean });
		if (e.data.opts?.clean) gintBuffer = _cleanGintBuffer!(gintBuffer, e.data.opts.clean);
		postMessage(gintBuffer, gintBuffer instanceof ArrayBuffer ? [gintBuffer] : []);   // SAB は transfer 不可＝共有のまま渡す
	} catch (err) {
		console.error("gint encode Worker Error:", err);
		postMessage(null);
	}
};
