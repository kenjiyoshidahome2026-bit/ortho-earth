// decoder/spatialite.js ── ブラウザ用 worker：.sqlite / .spatialite（SpatiaLite）→ GeoPBF バイト列。実体は convert/spatialite.js
import { fromSpatiaLite } from "../convert/spatialite.js";

onmessage = async (e) => {
	const { file, name, precision, description, license, attribution, layer, ignoreCrs, tky2jgd, patchjgd, include, exclude, excludeAll } = e.data;
	try {
		const u8 = new Uint8Array(await file.arrayBuffer());
		const { pbf, stats } = await fromSpatiaLite(u8, { name, precision, description, license, attribution, layer, ignoreCrs, tky2jgd, patchjgd, include, exclude, excludeAll });
		const res = pbf.arrayBuffer;
		const notes = [];
		if (stats.layers.length > 1) notes.push(`層 ${stats.layer} を読んだ（他: ${stats.layers.filter(l => l !== stats.layer).join(", ")}）`);
		if (stats.droppedGeometries) notes.push(`幾何なし ${stats.droppedGeometries} 行を落とした`);
		if (stats.badGeometries) notes.push(`読めない幾何 ${stats.badGeometries} 行`);
		if (stats.datumApprox) notes.push("日本測地系を Helmert 近似で変換（±10 m 級）");
		postMessage({ type: "spatialitedec", data: res, warning: notes.length ? `SpatiaLite: ${notes.join("・")}` : undefined, stats }, [res]);
	} catch (err) {
		console.error("[spatialite decoder]", err);
		postMessage(null);
	}
};
