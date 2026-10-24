import { GeoPBF } from "../pbf.ts";
import { gzip } from "../modules/gzip.ts";
import { topojson } from "../extension/topojson.ts";
import { topology } from "../extension/topology.ts";
import { gint } from "../extension/gint.ts";
import type { EncodeRequest } from "../worker-msg.ts";

onmessage = async (e: MessageEvent<EncodeRequest>) => {
	const { buf, name, opts, gintbuf } = e.data, gz = opts && opts.gz;
	try {
		const pbf = await new GeoPBF().set(buf);
		// gintbuf 無し（gint() を通していない pbf＝geoedit の書き出し等）＝この worker で組む。旧＝setGintBUF(undefined) が throw して null（無言の書き出し失敗）
		await pbf.setGintBUF(gintbuf ?? (await gint.initialize(), topology(pbf)));
		const topo = await topojson(pbf);
		let out: Blob = new File([JSON.stringify(topo)], `${name}.topojson`, { type: "application/json" })
		if (gz) out = await gzip(out);
		postMessage(out);
	} catch (err) {
		console.error("Topojson encode Worker Error:", err);
		postMessage(null);
	}
};
