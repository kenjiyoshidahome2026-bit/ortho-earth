// decoder/gpkg.js ── ブラウザ用 worker：.gpkg（GeoPackage）→ GeoPBF バイト列。実体は convert/gpkg.js（読み専用・依存ゼロ）。
import { fromGeoPackage } from "../convert/gpkg.js";

onmessage = async (e) => {
	const { file, name, precision, description, license, attribution, layer } = e.data;
	try {
		const u8 = new Uint8Array(await file.arrayBuffer());
		const { pbf, stats } = await fromGeoPackage(u8, { name, precision, description, license, attribution, layer });
		const res = pbf.arrayBuffer;
		const msg = { type: "gpkgdec", data: res };
		const notes = [];
		if (stats.layers.length > 1 && !layer) notes.push(`GeoPackage に ${stats.layers.length} 層（${stats.layers.join(", ")}）＝先頭の "${stats.layer}" を読んだ。他の層は opts.layer で`);
		if (stats.skipped.length) notes.push(`読まなかった列: ${stats.skipped.map(k => `${k.name}(${k.reason})`).join(" ")}`);
		if (stats.z || stats.m) notes.push("Z/M 値は落とした（GeoPBF は 2D）");
		if (stats.reprojected) notes.push(`${stats.crs} を経緯度へ戻した`);
		for (const w of stats.warnings) notes.push(w);
		if (notes.length) msg.warning = notes.join("・");
		postMessage(msg, [res]);
	} catch (err) {
		console.error("GeoPackage decode Worker Error:", err);
		postMessage(null);
	}
};
