// cache.js ── 作った列チャンク（三角形分割済み・LOD つき）と識別用のフラットな幾何を IDB に置く（URL の源だけ・#90）。
// 再訪は通信も分割も省ける。鍵＝URL|ETag(or size)|作り方|チャンク番号|版。総量は CACHE_MAX を超えたら古い順に落とす。失敗は全て null（無かったことに）
import { chunkBytes } from "./chunk.js";
const CACHE_MAX = 256e6, VER = "c2";   // c2＝鍵に作り方（rAx・LOD 段・切り方）
let p = null;
const open = () => p ??= new Promise((res, rej) => {
	if (typeof indexedDB === "undefined") return rej(new Error("no idb"));
	const rq = indexedDB.open("ortho-columnar", 1);
	rq.onupgradeneeded = () => { const s = rq.result.createObjectStore("chunk"); s.createIndex("t", "t"); };
	rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error);
});
const run = async (mode, f) => { try { const d = await open(); return await new Promise((res, rej) => { const r = f(d.transaction("chunk", mode).objectStore("chunk")); r.onsuccess = () => res(r.result ?? null); r.onerror = () => rej(r.error); }); } catch { return null; } };
// 作り方＝チャンクに焼き込まれる物。rAx（楕円体の b/a＝位置が変わる・球で焼いた物を楕円体で出すと ≈10km 北）・LOD 段・切り方（読み手がチャンクの境を決める時）
export const buildTag = ({ rAx = 1, lods = [], chunkFeatures, chunkVertices } = {}) =>
	`r${rAx}|l${[...lods].join(",")}` + (chunkFeatures != null || chunkVertices != null ? `|c${chunkFeatures ?? ""},${chunkVertices ?? ""}` : "");
export const cacheKey = (base, g, tag = "") => base ? `${base}|${tag}|${g}|${VER}` : null;
// IDB へ置く 1 件。snap＝copyChunk の写し（transfer 前に取る）・added＝後から作った段（put の複製は呼んだ時＝この後で transfer してよい）
export function cacheRecord(snap, added, flat) {
	const chunk = { ...snap, levels: [...snap.levels, ...added].sort((a, b) => b.zoom - a.zoom), pending: false };
	return { chunk, flat, bytesTotal: chunkBytes(chunk) + flat.xy.byteLength };
}
export const cache = {
	get: k => k ? run("readonly", s => s.get(k)) : Promise.resolve(null),
	set: (k, v) => k ? run("readwrite", s => s.put({ ...v, t: Date.now() }, k)) : Promise.resolve(null),
	prune: async () => {
		try {
			const d = await open();
			await new Promise(res => {
				const st = d.transaction("chunk", "readwrite").objectStore("chunk"), rows = [];
				st.index("t").openCursor().onsuccess = e => {
					const c = e.target.result;
					if (c) { rows.push({ key: c.primaryKey, bytes: c.value.bytesTotal || 0 }); c.continue(); return; }
					let total = rows.reduce((a, r) => a + r.bytes, 0);
					for (const r of rows) { if (total <= CACHE_MAX) break; st.delete(r.key); total -= r.bytes; }
					res();
				};
			});
		} catch { /* 無ければ無いで */ }
	},
};
