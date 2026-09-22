// decoder/fgb.js ── ブラウザ用 worker：.fgb（FlatGeobuf v3）→ GeoPBF バイト列。実体は convert/fgb.js（仕様どおりの読み・依存ゼロ）。
import { fromFlatGeobuf } from "../convert/fgb.js";

onmessage = async (e) => {
	const { file, name, precision, description, license, attribution, ignoreCrs, tky2jgd, patchjgd } = e.data;
	try {
		const u8 = new Uint8Array(await file.arrayBuffer());
		const { pbf, stats } = await fromFlatGeobuf(u8, { name, precision, description, license, attribution, ignoreCrs, tky2jgd, patchjgd });
		const res = pbf.arrayBuffer;
		const msg = { type: "fgbdec", data: res };
		const notes = [];
		if (stats.droppedGeometries) notes.push(`${stats.droppedGeometries} of ${stats.rows} features dropped (no geometry, or curve/surface types GeoPBF cannot hold)`);
		if (stats.skipped.length) notes.push(`skipped columns: ${stats.skipped.map(k => `${k.name}(${k.reason})`).join(" ")}`);
		if (stats.z || stats.m) notes.push("Z/M values dropped (GeoPBF is 2D)");
		if (stats.bigints) notes.push(`${stats.bigints} 64-bit integers beyond the safe range kept as strings`);
		if (stats.reprojected) notes.push(`${stats.crs} converted to lon/lat${stats.datumApprox ? " (Tokyo Datum via the Helmert approximation, ±10 m; pass a TKY2JGD grid as opts.tky2jgd for 0.2 m)" : ""}`);
		if (notes.length) msg.warning = notes.join("; ");
		postMessage(msg, [res]);
	} catch (err) {
		console.error("FlatGeobuf decode Worker Error:", err);
		postMessage(null);
	}
};
