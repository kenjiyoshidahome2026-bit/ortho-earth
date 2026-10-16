import { GeoPBFBase } from "../pbf-base.ts";
import { dissolve } from "../extension/dissolve.ts";
import { geojson } from "../modules/geojson.ts";
import { isObject } from "../modules/utility.ts";
import { isCzml, czmlToFeatures } from "../modules/czml.ts";
import type { Feature, FeatureCollection } from "../../types/geopbf.js";
import type { DecodeRequest, DecodeResponse } from "../worker-msg.ts";

// Upper bound for a single JSON.parse (V8 native) pass.
// The bottleneck is memory, not parse speed: a 100 MB JSON file → ~300–500 MB heap.
const SMALL = 100 * 1024 * 1024;

// Memory ceiling for single-pass collection. Holding all parsed features simultaneously above this risks OOM.
const LARGE = 500 * 1024 * 1024;

onmessage = async (e: MessageEvent<DecodeRequest>) => {
	const file = e.data.file;
	if (!file) { console.error("[json decoder] file is null"); postMessage(null); return; }
	const pbf = new GeoPBFBase(e.data);

	try {
	if (file.size < SMALL) {
		// Small–medium: JSON.parse is fastest (single native C++ call).
		const obj: unknown = JSON.parse(await file.text());
		if (isCzml(obj)) {   // .json に入った CZML（Cesium のパケット配列）＝decoder/czml.ts と同じ写し方（2026-09-17）
			const { features, document, dropped } = czmlToFeatures(obj as unknown[]);
			if (dropped) console.warn(`[czml] ${dropped} packet(s) without geometry dropped`);
			if (document?.name) pbf.name(document.name as string);
			if (document?.description) pbf.description(String(document.description));
			await pbf.set({ type: "FeatureCollection", features } as unknown as FeatureCollection);
		} else await pbf.set(obj as FeatureCollection);

	} else if (file.size < LARGE) {
		// Medium–large: streaming single pass accumulates features while reading the file only once.
		// geojson prunes chunks so the raw JSON string is not retained (only parsed objects).
		const features: Feature[] = [];
		await geojson(file, f => features.push(f as Feature), false);
		const [keys, bufs] = await GeoPBFBase.makeKeys(features.map(f => f.properties));
		pbf.setHead(keys, bufs);
		pbf.setBody(() => features.forEach(f => pbf.setFeature(f)));
		pbf.close();
		await pbf.getPosition();

	} else {
		// Very large: holding all features at once would OOM, so use two passes (file read twice).
		const keySet = new Set<string>();
		const getPropertyKeys = (f: unknown): void => {
			const props = (f as Feature).properties;
			if (!isObject(props)) return;
			for (const k in props) {
				keySet.add(k);
				const v = props[k]; if (!isObject(v)) continue;
				for (const sk in v) keySet.add(`${k}.${sk}`);
			}
		};
		await geojson(file, getPropertyKeys, false);
		pbf.setHead(Array.from(keySet).sort());
		pbf.setBody(() => geojson(file, f => pbf.setFeature(f as Feature), true));
		pbf.close();
		await pbf.getPosition();
	}

	await dissolve(pbf);
	const res = pbf.arrayBuffer;   // 旧＝直前に console.log(pbf, pbf.arrayBuffer)＝全バッファをもう 1 回複製（DevTools が保持）。2026-09-15 撤去
	const msg: DecodeResponse = { type: "jsondec", data: res };
	postMessage(msg, [res]);
	} catch (err) {
		console.error("[json decoder] failed:", err, "\nfile:", file?.name, file?.size, "\ncontent preview:", await file?.slice(0, 200).text().catch(() => "(unreadable)"));
		throw err;
	}
};
