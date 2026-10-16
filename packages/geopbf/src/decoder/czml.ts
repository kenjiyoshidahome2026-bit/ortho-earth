import { GeoPBFBase } from "../pbf-base.ts";
import { czmlToFeatures } from "../modules/czml.ts";
import type { FeatureCollection } from "../../types/geopbf.js";
import type { DecodeRequest, DecodeResponse } from "../worker-msg.ts";

// CZML → GeoPBF。約束事は modules/czml.ts の頭に。document パケットの name / description はヘッダへ、clock は残さない。
//   幾何を持たないパケット（参照だけ・clock だけ）は落として数える。2026-09-17。

onmessage = async (e: MessageEvent<DecodeRequest>) => {
	const { file, precision } = e.data;
	try {
		const packets: unknown = JSON.parse(await file.text());
		if (!Array.isArray(packets)) throw new Error("CZML must be a JSON array of packets");
		const { features, document, dropped } = czmlToFeatures(packets);
		if (dropped) console.warn(`[czml] ${dropped} packet(s) without geometry dropped`);
		const pbf = new GeoPBFBase({ name: ((document && document.name) || file.name.replace(/\.[^\.]+$/, "")) as string, precision: precision || 6 });
		if (document && document.description) pbf.description(String(document.description));
		await pbf.set({ type: "FeatureCollection", features } as unknown as FeatureCollection);
		const res = pbf.arrayBuffer;
		const msg: DecodeResponse = { type: "czmldec", data: res };
		postMessage(msg, [res]);
	} catch (err) {
		console.error("CZML decode Worker Error:", err);
		postMessage(null);
	}
};
