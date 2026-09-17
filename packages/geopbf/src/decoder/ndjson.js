// decoder/ndjson.js ── ブラウザ用 worker：.ndjson / .geojsonl / .jsonl / GeoJSON Text Sequence → GeoPBF バイト列。実体は convert/ndjson.js
import { dissolve } from "../extension/dissolve.js";
import { fromNdjson } from "../convert/ndjson.js";

onmessage = async (e) => {
	const { file, name, precision, description, license, attribution } = e.data;
	try {
		const { pbf, stats } = await fromNdjson(file, { name, precision, description, license, attribution });
		await dissolve(pbf);   // json デコーダと同じ（同一属性の地物を併合）
		const res = pbf.arrayBuffer;
		postMessage({ type: "ndjsondec", data: res, warning: stats.badLines ? `NDJSON: ${stats.badLines} unreadable lines skipped (features ${stats.features})` : undefined }, [res]);
	} catch (err) {
		console.error("[ndjson decoder]", err);
		postMessage(null);
	}
};
