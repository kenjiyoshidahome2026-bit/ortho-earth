// sources/fgb.js ── FlatGeobuf（.fgb）→ 列チャンク（#90 段 5・任意の読み手）。
// geopbf/fgb（依存ゼロの FlatBuffers 読み・v3・投影系は経緯度へ）で GeoPBF に読み替え、あとは geopbf の読み手に委ねる＝全量を手元に置く読み方。
// 書式の空間索引（packed Hilbert R-tree）で Range 読みする版は次（索引の節を辿る読みは fgb.js の calcTreeSize が土台）。
import { fromFlatGeobuf } from "geopbf/fgb";
import { GEOPBF_SOURCE } from "./geopbf.js";

const MAGIC = h => h.length >= 4 && h[0] === 0x66 && h[1] === 0x67 && h[2] === 0x62 && h[3] === 0x03;   // "fgb" + 3
export const FGB_SOURCE = {
	name: "fgb",
	test: ({ name, head }) => /\.fgb$/i.test(name || "") || MAGIC(head),
	async open(src, ctx = {}) {
		let u8 = src instanceof Uint8Array ? src : src instanceof ArrayBuffer ? new Uint8Array(src) : new Uint8Array(await (typeof src === "string" ? (await fetch(src, { credentials: "omit" })).arrayBuffer() : src.arrayBuffer()));
		const { pbf, stats } = await fromFlatGeobuf(u8, { name: ctx.name });
		const r = await GEOPBF_SOURCE.open(pbf.arrayBuffer, ctx);
		r.meta.kind = "fgb"; r.meta.size = u8.byteLength; r.meta.fgb = { dropped: stats?.droppedGeometries ?? 0, crs: stats?.crs ?? null };
		return r;
	},
};
