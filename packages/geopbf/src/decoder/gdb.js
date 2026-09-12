// decoder/gdb.js ── ブラウザ用 worker：.gdb を zip に固めたもの（*.gdbtable を含む zip）→ GeoPBF バイト列。実体は convert/filegdb.js。
import { decodeZIP } from "../modules/decodeZIP.js";
import { fromFileGDB, gdbSourceFromFiles } from "../convert/filegdb.js";

onmessage = async (e) => {
	const { file, name, precision, description, license, attribution, layer, ignoreCrs, tky2jgd, patchjgd } = e.data;
	try {
		const entries = await decodeZIP(file);
		if (!entries) throw new Error("zip を開けない");
		const source = gdbSourceFromFiles(entries);
		const { pbf, stats } = await fromFileGDB(source, { precision, description, license, attribution, layer, ignoreCrs, tky2jgd, patchjgd });
		const res = pbf.arrayBuffer;
		const msg = { type: "gdbdec", data: res };
		const notes = [];
		if (stats.layers.length > 1 && !layer) notes.push(`FileGDB に ${stats.layers.length} 層（${stats.layers.join(", ")}）＝先頭の "${stats.layer}" を読んだ。他の層は opts.layer で`);
		if (stats.droppedGeometries) notes.push(`幾何なし/空/多パッチの地物 ${stats.droppedGeometries} を落とした`);
		if (stats.curves) notes.push(`曲線 ${stats.curves} 本は頂点を直線で結んだ`);
		if (stats.reprojected) notes.push(`${stats.crs} を経緯度へ戻した${stats.datumApprox ? "（日本測地系は Helmert 近似＝±10 m 級。TKY2JGD 格子を opts.tky2jgd で渡すと 0.2 m 級）" : ""}`);
		if (stats.crsUnknown) notes.push("座標系が不明＝経緯度として読んだ");
		if (stats.z || stats.m) notes.push("Z/M 値は落とした（GeoPBF は 2D）");
		if (stats.skipped.length) notes.push(`読まなかった列: ${stats.skipped.map(k => `${k.name}(${k.reason})`).join(" ")}`);
		if (notes.length) msg.warning = notes.join("・");
		postMessage(msg, [res]);
	} catch (err) {
		console.error("FileGDB decode Worker Error:", err);
		postMessage(null);
	}
};
