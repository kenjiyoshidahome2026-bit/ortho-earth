// decoder/gpkg.js ── ブラウザ用 worker：.gpkg（GeoPackage）→ GeoPBF バイト列。実体は convert/gpkg.js（読み専用・依存ゼロ）。
import { fromGeoPackage } from "../convert/gpkg.js";

onmessage = async (e) => {
	const { file, name, precision, description, license, attribution, layer, tky2jgd, patchjgd } = e.data;
	try {
		const u8 = new Uint8Array(await file.arrayBuffer());
		const { pbf, stats } = await fromGeoPackage(u8, { name, precision, description, license, attribution, layer, tky2jgd, patchjgd });
		const res = pbf.arrayBuffer;
		const msg = { type: "gpkgdec", data: res };
		const notes = [];
		if (stats.layers.length > 1 && !layer) notes.push(`GeoPackage has ${stats.layers.length} layers (${stats.layers.join(", ")}); read the first, "${stats.layer}", choose another with opts.layer`);
		if (stats.skipped.length) notes.push(`skipped columns: ${stats.skipped.map(k => `${k.name}(${k.reason})`).join(" ")}`);
		if (stats.z || stats.m) notes.push("Z/M values dropped (GeoPBF is 2D)");
		if (stats.reprojected) notes.push(`${stats.crs} converted to lon/lat${stats.datumApprox ? " (Tokyo Datum via the Helmert approximation, ±10 m; pass a TKY2JGD grid as opts.tky2jgd for 0.2 m)" : ""}`);
		for (const w of stats.warnings) notes.push(w);
		if (notes.length) msg.warning = notes.join("; ");
		postMessage(msg, [res]);
	} catch (err) {
		console.error("GeoPackage decode Worker Error:", err);
		postMessage(null);
	}
};
