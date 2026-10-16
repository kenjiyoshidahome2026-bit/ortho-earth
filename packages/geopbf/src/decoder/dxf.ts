// decoder/dxf.ts ── ブラウザ用 worker：.dxf → GeoPBF バイト列。実体は convert/dxf.js（crs は EPSG 番号か WKT・省略時は経緯度の範囲なら経緯度とみなす）
import { fromDxf } from "../convert/dxf.js";
import type { DecodeRequest, DecodeResponse } from "../worker-msg.ts";

onmessage = async (e: MessageEvent<DecodeRequest>) => {
	const { file, name, precision, description, license, attribution, crs, ignoreCrs, unitScale, encoding, closedAsPolygon, tky2jgd, patchjgd } = e.data;
	try {
		const u8 = new Uint8Array(await file.arrayBuffer());
		const { pbf, stats } = await fromDxf(u8, { name, precision, description, license, attribution, crs, ignoreCrs, unitScale, encoding, closedAsPolygon, tky2jgd, patchjgd });
		const res = pbf.arrayBuffer;
		const notes: string[] = [];
		if (stats.assumedLonLat) notes.push("no CRS in the DXF; assumed lon/lat");
		const sk = Object.entries(stats.skipped); if (sk.length) notes.push(`skipped: ${sk.map(([k, v]) => `${k}×${v}`).join(" ")}`);
		if (stats.datumApprox) notes.push("Tokyo Datum converted with the Helmert approximation (±10 m)");
		const msg: DecodeResponse = { type: "dxfdec", data: res, warning: notes.length ? `DXF: ${notes.join("; ")}` : undefined, stats };
		postMessage(msg, [res]);
	} catch (err) {
		console.error("[dxf decoder]", err);
		postMessage(null);
	}
};
