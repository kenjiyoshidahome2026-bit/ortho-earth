// cache.js ── 作った列チャンク（三角形分割済み・LOD つき）と識別用のフラットな幾何を IDB に置く（URL の源だけ・#90）。
// 再訪は通信も分割も省ける。鍵＝URL|ETag(or size)|チャンク番号|版。総量は CACHE_MAX を超えたら古い順に落とす。失敗は全て null（無かったことに）
const CACHE_MAX = 256e6, VER = "c1";
let p = null;
const open = () => p ??= new Promise((res, rej) => {
	if (typeof indexedDB === "undefined") return rej(new Error("no idb"));
	const rq = indexedDB.open("ortho-columnar", 1);
	rq.onupgradeneeded = () => { const s = rq.result.createObjectStore("chunk"); s.createIndex("t", "t"); };
	rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error);
});
const run = async (mode, f) => { try { const d = await open(); return await new Promise((res, rej) => { const r = f(d.transaction("chunk", mode).objectStore("chunk")); r.onsuccess = () => res(r.result ?? null); r.onerror = () => rej(r.error); }); } catch { return null; } };
export const cacheKey = (base, g) => base ? `${base}|${g}|${VER}` : null;
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
