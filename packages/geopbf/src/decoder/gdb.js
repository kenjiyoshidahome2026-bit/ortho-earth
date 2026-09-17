// decoder/gdb.js ── ブラウザ用 worker：.gdb を zip に固めたもの（*.gdbtable を含む zip）→ GeoPBF バイト列。実体は convert/filegdb.js。
import { decodeZIP } from "../modules/decodeZIP.js";
import { fromFileGDB, gdbSourceFromFiles } from "../convert/filegdb.js";

onmessage = async (e) => {
	const { file, name, precision, description, license, attribution, layer, ignoreCrs, tky2jgd, patchjgd } = e.data;
	try {
		const entries = await decodeZIP(file);
		if (!entries) throw new Error("cannot open zip");
		const source = gdbSourceFromFiles(entries);
		const { pbf, stats } = await fromFileGDB(source, { precision, description, license, attribution, layer, ignoreCrs, tky2jgd, patchjgd });
		const res = pbf.arrayBuffer;
		const msg = { type: "gdbdec", data: res };
		const notes = [];
		if (stats.layers.length > 1 && !layer) notes.push(`FileGDB has ${stats.layers.length} layers (${stats.layers.join(", ")}); read the first, "${stats.layer}", choose another with opts.layer`);
		if (stats.droppedGeometries) notes.push(`${stats.droppedGeometries} features dropped (no geometry / empty / multipatch)`);
		if (stats.curves) notes.push(`${stats.curves} curves linearized (vertices joined by straight lines)`);
		if (stats.reprojected) notes.push(`${stats.crs} converted to lon/lat${stats.datumApprox ? " (Tokyo Datum via the Helmert approximation, ±10 m; pass a TKY2JGD grid as opts.tky2jgd for 0.2 m)" : ""}`);
		if (stats.crsUnknown) notes.push("unknown CRS; read as lon/lat");
		if (stats.z || stats.m) notes.push("Z/M values dropped (GeoPBF is 2D)");
		if (stats.skipped.length) notes.push(`skipped columns: ${stats.skipped.map(k => `${k.name}(${k.reason})`).join(" ")}`);
		if (notes.length) msg.warning = notes.join("; ");
		postMessage(msg, [res]);
	} catch (err) {
		console.error("FileGDB decode Worker Error:", err);
		postMessage(null);
	}
};
