// decoder/spatialite.js ── ブラウザ用 worker：.sqlite / .spatialite（SpatiaLite）→ GeoPBF バイト列。実体は convert/spatialite.js
import { fromSpatiaLite } from "../convert/spatialite.js";

onmessage = async (e) => {
	const { file, name, precision, description, license, attribution, layer, ignoreCrs, tky2jgd, patchjgd, include, exclude, excludeAll } = e.data;
	try {
		const u8 = new Uint8Array(await file.arrayBuffer());
		const { pbf, stats } = await fromSpatiaLite(u8, { name, precision, description, license, attribution, layer, ignoreCrs, tky2jgd, patchjgd, include, exclude, excludeAll });
		const res = pbf.arrayBuffer;
		const notes = [];
		if (stats.layers.length > 1) notes.push(`read layer ${stats.layer} (others: ${stats.layers.filter(l => l !== stats.layer).join(", ")}); choose another with opts.layer`);
		if (stats.droppedGeometries) notes.push(`${stats.droppedGeometries} rows without geometry dropped`);
		if (stats.badGeometries) notes.push(`${stats.badGeometries} rows with unreadable geometry`);
		if (stats.datumApprox) notes.push("Tokyo Datum converted with the Helmert approximation (±10 m)");
		postMessage({ type: "spatialitedec", data: res, warning: notes.length ? `SpatiaLite: ${notes.join("; ")}` : undefined, stats }, [res]);
	} catch (err) {
		console.error("[spatialite decoder]", err);
		postMessage(null);
	}
};
