// decoder/csv.js ── ブラウザ用 worker：.csv / .tsv / .xlsx（経緯度列か WKT 列を持つ表）→ GeoPBF バイト列。実体は convert/table.js の fromTable。
import { fromTable } from "../convert/table.js";

onmessage = async (e) => {
	const { file, name, precision, encoding, description, license, attribution, lon, lat, wkt, sheet, delimiter } = e.data;
	try {
		const u8 = new Uint8Array(await file.arrayBuffer());
		const { pbf, stats } = await fromTable(u8, { name, precision, description, license, attribution, lon, lat, wkt, sheet, delimiter, encoding: encoding && encoding !== "utf8" ? encoding : undefined });
		const res = pbf.arrayBuffer;
		const msg = { type: "csvdec", data: res };
		const notes = [];
		if (stats.droppedGeometries) notes.push(`座標の無い行 ${stats.droppedGeometries} を落とした`);
		if (stats.sheets && stats.sheets.length > 1) notes.push(`シート ${stats.sheets.length} 枚（${stats.sheets.join(", ")}）＝"${stats.sheet}" を読んだ。他は opts.sheet で`);
		if (notes.length) msg.warning = notes.join("・");
		postMessage(msg, [res]);
	} catch (err) {
		console.error("Table decode Worker Error:", err);
		postMessage(null);
	}
};
