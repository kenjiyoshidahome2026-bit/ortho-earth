import { GeoPBF } from "../pbf-base.js";
import { featureToPackets, documentPacket } from "../modules/czml.js";
const enc = new TextEncoder();

// GeoPBF → CZML（JSON のパケット配列・1 行 1 パケット）。約束事は modules/czml.js の頭に。
//   Point＝position、時刻配列を持つ線＝sampled position（動く点）、線＝polyline、面＝polygon（czml.rectangle が残っていれば rectangle）、
//   Multi 幾何は部品ごとに 1 パケット。属性 czml はそのまま展開、その他の属性は packet.properties。2026-09-17。

onmessage = async (e) => {
	const { buf, name, opts } = e.data, gz = opts && opts.gz;
	try {
		const pbf = await new GeoPBF().name(name).set(buf);
		const { readable, writable } = new TransformStream();
		const writer = writable.getWriter();
		const out = gz ? readable.pipeThrough(new CompressionStream("gzip")) : readable;
		const bPromise = new Response(out).blob();

		(async () => {
			await writer.write(enc.encode("[\n" + JSON.stringify(documentPacket(pbf.name(), pbf.description()))));
			for (let i = 0, len = pbf.length; i < len; i++) {
				for (const pk of featureToPackets(pbf.getFeature(i), i)) await writer.write(enc.encode(",\n" + JSON.stringify(pk)));
			}
			await writer.write(enc.encode("\n]\n"));
			await writer.close();
		})();

		const b = await bPromise;
		postMessage(new File([b], `${name}.czml${gz ? ".gz" : ""}`, { type: "application/json" }));
	} catch (err) { postMessage(null); }
};
