// decoder/parquet.ts ── ブラウザ用 worker：.parquet / .geoparquet（GeoParquet・WKB・経緯度）→ GeoPBF バイト列。実体は convert/geoparquet.js の fromGeoParquet。
import { fromGeoParquet } from "../convert/geoparquet.ts";
import type { DecodeRequest, DecodeResponse } from "../worker-msg.ts";

onmessage = async (e: MessageEvent<DecodeRequest>) => {
	const { file, name, precision, geometryColumn, ignoreCrs } = e.data;   // description／license／attribution は parquet の key-value（geopbf:*）から読む＝fromGeoParquet は受けない
	try {
		const u8 = new Uint8Array(await file.arrayBuffer());
		const { pbf, stats } = await fromGeoParquet(u8, { name, precision, geometryColumn, ignoreCrs });
		const res = pbf.arrayBuffer;
		const msg: DecodeResponse = { type: "parquetdec", data: res };
		const notes: string[] = [];
		if (stats.droppedGeometries) notes.push(`${stats.droppedGeometries} rows without geometry dropped`);
		if (stats.skipped.length) notes.push(`skipped columns: ${stats.skipped.map(k => `${k.name}(${k.reason})`).join(" ")}`);
		if (notes.length) msg.warning = notes.join("; ");
		postMessage(msg, [res]);
	} catch (err) {
		console.error("GeoParquet decode Worker Error:", err);
		postMessage(null);
	}
};
