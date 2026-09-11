// decoder/parquet.js ── ブラウザ用 worker：.parquet / .geoparquet（GeoParquet・WKB・経緯度）→ GeoPBF バイト列。実体は convert/geoparquet.js の fromGeoParquet。
import { fromGeoParquet } from "../convert/geoparquet.js";

onmessage = async (e) => {
	const { file, name, precision, description, license, attribution, geometryColumn, ignoreCrs } = e.data;
	try {
		const u8 = new Uint8Array(await file.arrayBuffer());
		const { pbf, stats } = await fromGeoParquet(u8, { name, precision, description, license, attribution, geometryColumn, ignoreCrs });
		const res = pbf.arrayBuffer;
		const msg = { type: "parquetdec", data: res };
		const notes = [];
		if (stats.droppedGeometries) notes.push(`幾何なしの行 ${stats.droppedGeometries} を落とした`);
		if (stats.skipped.length) notes.push(`読まなかった列: ${stats.skipped.map(k => `${k.name}(${k.reason})`).join(" ")}`);
		if (notes.length) msg.warning = notes.join("・");
		postMessage(msg, [res]);
	} catch (err) {
		console.error("GeoParquet decode Worker Error:", err);
		postMessage(null);
	}
};
