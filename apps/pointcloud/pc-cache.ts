// 点群の端末内の保管（2026-11-06・本人「IDB 等に、すぐ読める形式で保存する必要がありますね」→ OPFS が第一・IndexedDB が控え）。
// 置く物＝pc-pack.ts で詰めた ArrayBuffer（読んだ点＝points・変換した splat の段＝cloud）。鍵＝pc-pack.ts の cacheKey。
// OPFS（navigator.storage.getDirectory）＝ファイル 1 つ＝鍵 1 つ（鍵は名前に使えない字を逃がす）。目録（index.json）に大きさと最後に触った時＝予算を超えたら古い順に捨てる。
// IDB＝OPFS が無い器（古い Safari 等）。どちらも無い（プライベート・容量拒否）＝素通し（get は null・put は何もしない）＝読みは回線だけで従来どおり。
// 器は 1 つの頁が 1 つ持つ（openPcCache）。別タブとの取り合いは目録の書き直しで最後の物が勝つ＝壊れても目録を捨てて作り直すだけ。

export interface PcCache {
	readonly kind: "opfs" | "idb" | "none";
	get(key: string): Promise<ArrayBuffer | null>;
	put(key: string, buf: ArrayBuffer): Promise<void>;
	delete(key: string): Promise<void>;
	/** 置いてある物の一覧（鍵・大きさ・最後に触った時）と合計 */
	list(): Promise<{ entries: Array<{ key: string; size: number; t: number }>; total: number }>;
	clear(): Promise<void>;
}
interface IndexRec { size: number; t: number; file?: string }
type Index = Record<string, IndexRec>;
const DIR = "pointcloud-cache", INDEX = "index.json";
const fileName = (key: string) => key.replace(/[^\w.-]/g, c => `%${c.charCodeAt(0).toString(16).padStart(2, "0")}`) + ".bin";

/** OPFS → IDB → 素通し。budget＝置く合計の上限（bytes・超えたら古い順に 8 割まで捨てる） */
export async function openPcCache(budget = 2 * 1024 ** 3): Promise<PcCache> {
	try { const c = await openOpfs(budget); if (c) return c; } catch (e) { console.warn("[pointcloud] OPFS unavailable", e); }
	try { const c = await openIdb(budget); if (c) return c; } catch (e) { console.warn("[pointcloud] IndexedDB unavailable", e); }
	return { kind: "none", get: async () => null, put: async () => {}, delete: async () => {}, list: async () => ({ entries: [], total: 0 }), clear: async () => {} };
}

async function openOpfs(budget: number): Promise<PcCache | null> {
	if (!navigator.storage?.getDirectory) return null;
	const root = await navigator.storage.getDirectory(), dir = await root.getDirectoryHandle(DIR, { create: true });
	const readIndex = async (): Promise<Index> => { try { const f = await (await dir.getFileHandle(INDEX)).getFile(); return JSON.parse(await f.text()); } catch { return {}; } };
	const writeIndex = async (ix: Index) => { const w = await (await dir.getFileHandle(INDEX, { create: true })).createWritable(); await w.write(JSON.stringify(ix)); await w.close(); };
	const touch = async (key: string, size?: number) => { const ix = await readIndex(); if (!ix[key] && size == null) return; ix[key] = { size: size ?? ix[key].size, t: Date.now(), file: fileName(key) }; await writeIndex(ix); return ix; };
	const evict = async (ix: Index) => {
		let total = Object.values(ix).reduce((s, r) => s + r.size, 0);
		if (total <= budget) return;
		for (const [k, r] of Object.entries(ix).sort((a, b) => a[1].t - b[1].t)) { if (total <= budget * 0.8) break; await dir.removeEntry(r.file ?? fileName(k)).catch(() => {}); delete ix[k]; total -= r.size; }
		await writeIndex(ix);
	};
	// 書けるか一度試す（容量拒否・読み取り専用の器を put の時でなく今知る）
	const probe = await dir.getFileHandle(".probe", { create: true }); const w = await probe.createWritable(); await w.write(new Uint8Array(8)); await w.close(); await dir.removeEntry(".probe").catch(() => {});
	let chain: Promise<unknown> = Promise.resolve();   // 目録の読み書きは 1 本ずつ
	const serial = <T>(f: () => Promise<T>): Promise<T> => { const p = chain.then(f, f); chain = p.catch(() => {}); return p; };
	return {
		kind: "opfs",
		get: key => serial(async () => { try { const f = await (await dir.getFileHandle(fileName(key))).getFile(); const b = await f.arrayBuffer(); await touch(key); return b; } catch { return null; } }),
		put: (key, buf) => serial(async () => { const w = await (await dir.getFileHandle(fileName(key), { create: true })).createWritable(); await w.write(buf); await w.close(); const ix = await touch(key, buf.byteLength); if (ix) await evict(ix); }),
		delete: key => serial(async () => { await dir.removeEntry(fileName(key)).catch(() => {}); const ix = await readIndex(); delete ix[key]; await writeIndex(ix); }),
		list: () => serial(async () => { const ix = await readIndex(); const entries = Object.entries(ix).map(([key, r]) => ({ key, size: r.size, t: r.t })).sort((a, b) => b.t - a.t); return { entries, total: entries.reduce((s, e) => s + e.size, 0) }; }),
		clear: () => serial(async () => { for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) await dir.removeEntry(name).catch(() => {}); }),
	};
}

const DB = "ortho-pointcloud", ST = "blobs";
interface Rec { b: ArrayBuffer; t: number; n: number }
async function openIdb(budget: number): Promise<PcCache | null> {
	if (typeof indexedDB === "undefined") return null;
	const db = await new Promise<IDBDatabase | null>(res => {
		const rq = indexedDB.open(DB, 1), to = setTimeout(() => res(null), 3000);
		rq.onupgradeneeded = () => rq.result.createObjectStore(ST).createIndex("t", "t");
		rq.onsuccess = () => { clearTimeout(to); res(rq.result); }; rq.onerror = () => { clearTimeout(to); res(null); };
	});
	if (!db) return null;
	const done = (tx: IDBTransaction) => new Promise<void>((res, rej) => { tx.oncomplete = () => res(); tx.onerror = tx.onabort = () => rej(tx.error); });
	const req = <T>(r: IDBRequest<T>) => new Promise<T>((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
	const all = async (): Promise<Array<{ key: string; size: number; t: number }>> => {
		const tx = db.transaction(ST), st = tx.objectStore(ST), keys = await req(st.getAllKeys()), out: Array<{ key: string; size: number; t: number }> = [];
		for (const k of keys) { const r = (await req(st.get(k))) as Rec | undefined; if (r) out.push({ key: String(k), size: r.n, t: r.t }); }
		return out.sort((a, b) => b.t - a.t);
	};
	const evict = async () => {
		const es = await all(); let total = es.reduce((s, e) => s + e.size, 0);
		if (total <= budget) return;
		const tx = db.transaction(ST, "readwrite"), st = tx.objectStore(ST);
		for (const e of [...es].reverse()) { if (total <= budget * 0.8) break; st.delete(e.key); total -= e.size; }
		await done(tx);
	};
	return {
		kind: "idb",
		get: async key => { const tx = db.transaction(ST, "readwrite"), st = tx.objectStore(ST), r = (await req(st.get(key))) as Rec | undefined; if (!r) return null; st.put({ ...r, t: Date.now() }, key); await done(tx); return r.b; },
		put: async (key, b) => { const tx = db.transaction(ST, "readwrite"); tx.objectStore(ST).put({ b, t: Date.now(), n: b.byteLength } satisfies Rec, key); await done(tx); await evict(); },
		delete: async key => { const tx = db.transaction(ST, "readwrite"); tx.objectStore(ST).delete(key); await done(tx); },
		list: async () => { const entries = await all(); return { entries, total: entries.reduce((s, e) => s + e.size, 0) }; },
		clear: async () => { const tx = db.transaction(ST, "readwrite"); tx.objectStore(ST).clear(); await done(tx); },
	};
}
