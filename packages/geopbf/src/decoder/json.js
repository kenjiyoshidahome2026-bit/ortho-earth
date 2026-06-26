import { GeoPBF } from "../pbf-base.js";
import { dissolve } from "../extension/dissolve.js";
import { geojson } from "../modules/geojson.js";
import { isObject } from "common";

// Upper bound for a single JSON.parse (V8 native) pass.
// The bottleneck is memory, not parse speed: a 100 MB JSON file → ~300–500 MB heap.
const SMALL = 100 * 1024 * 1024;

// Memory ceiling for single-pass collection. Holding all parsed features simultaneously above this risks OOM.
const LARGE = 500 * 1024 * 1024;

onmessage = async (e) => {
	const file = e.data.file;
	if (!file) { console.error("[json decoder] file is null"); postMessage(null); return; }
	const pbf = new GeoPBF(e.data);

	try {
	if (file.size < SMALL) {
		// Small–medium: JSON.parse is fastest (single native C++ call).
		await pbf.set(JSON.parse(await file.text()));

	} else if (file.size < LARGE) {
		// Medium–large: streaming single pass accumulates features while reading the file only once.
		// geojson prunes chunks so the raw JSON string is not retained (only parsed objects).
		const features = [];
		await geojson(file, f => features.push(f), false);
		const [keys, bufs] = await GeoPBF.makeKeys(features.map(f => f.properties));
		pbf.setHead(keys, bufs);
		pbf.setBody(() => features.forEach(f => pbf.setFeature(f)));
		pbf.close();
		await pbf.getPosition();

	} else {
		// Very large: holding all features at once would OOM, so use two passes (file read twice).
		const keySet = new Set();
		const getPropertyKeys = f => {
			if (!isObject(f.properties)) return;
			for (const k in f.properties) {
				keySet.add(k);
				const v = f.properties[k]; if (!isObject(v)) continue;
				for (const sk in v) keySet.add(`${k}.${sk}`);
			}
		};
		await geojson(file, getPropertyKeys, false);
		pbf.setHead(Array.from(keySet).sort());
		pbf.setBody(() => geojson(file, f => pbf.setFeature(f), true));
		pbf.close();
		await pbf.getPosition();
	}

	console.time("dissolve");
	await dissolve(pbf);
	console.timeEnd("dissolve");
	console.log(pbf, pbf.arrayBuffer);
	const res = pbf.arrayBuffer;
	postMessage({ type: "jsondec", data: res }, [res]);
	} catch (err) {
		console.error("[json decoder] failed:", err, "\nfile:", file?.name, file?.size, "\ncontent preview:", await file?.slice(0, 200).text().catch(() => "(unreadable)"));
		throw err;
	}
};
