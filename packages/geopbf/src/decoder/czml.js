import { GeoPBF } from "../pbf-base.js";
import { czmlToFeatures } from "../modules/czml.js";

// CZML → GeoPBF。約束事は modules/czml.js の頭に。document パケットの name / description はヘッダへ、clock は残さない。
//   幾何を持たないパケット（参照だけ・clock だけ）は落として数える。2026-09-17。

onmessage = async (e) => {
	const { file, precision } = e.data;
	try {
		const packets = JSON.parse(await file.text());
		if (!Array.isArray(packets)) throw new Error("CZML must be a JSON array of packets");
		const { features, document, dropped } = czmlToFeatures(packets);
		if (dropped) console.warn(`[czml] ${dropped} packet(s) without geometry dropped`);
		const pbf = new GeoPBF({ name: (document && document.name) || file.name.replace(/\.[^\.]+$/, ""), precision: precision || 6 });
		if (document && document.description) pbf.description(String(document.description));
		await pbf.set({ type: "FeatureCollection", features });
		const res = pbf.arrayBuffer;
		postMessage({ type: "czmldec", data: res }, [res]);
	} catch (err) {
		console.error("CZML decode Worker Error:", err);
		postMessage(null);
	}
};
