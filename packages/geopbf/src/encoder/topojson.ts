import { GeoPBF } from "../pbf.ts";
import { gzip } from "../modules/gzip.ts";
import { topojson } from "../extension/topojson.ts";
import type { EncodeRequest } from "../worker-msg.ts";

onmessage = async (e: MessageEvent<EncodeRequest>) => {
	const { buf, name, opts, gintbuf } = e.data, gz = opts && opts.gz;
	try {
		const pbf = await (await new GeoPBF().set(buf)).setGintBUF(gintbuf!);   // gintbuf 無し＝旧来どおり setGintBUF(undefined) に任せる
		const topo = await topojson(pbf);
		let out: Blob = new File([JSON.stringify(topo)], `${name}.topojson`, { type: "application/json" })
		if (gz) out = await gzip(out);
		postMessage(out);
	} catch (err) {
		console.error("Topojson encode Worker Error:", err);
		postMessage(null);
	}
};
