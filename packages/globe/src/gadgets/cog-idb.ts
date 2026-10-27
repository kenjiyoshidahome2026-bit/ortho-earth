// 生タイル（圧縮バイト）の端末内保管（IDB）＝ページを開き直しても同じ Range を撃ち直さない
//（Kenji 2026-10-27「一度読んだデータは idb 等に保管しないのですか？」）。
// 鍵は core の二層目の鍵（cog:<cacheKey|ETag>:段/tx/ty）＝シーン id か ETag で刻む＝署名 URL が発行ごとに変わっても当たる。
// 容量＝budget を超えたら、置いた順に古いものから 8 割まで捨てる（合計は meta に持つ＝起動時に全件を数えない）。
// IDB が使えない（プライベート・容量拒否・open 待ち切れ）時は全部素通し＝読み込みはメモリと回線だけで従来どおり。
/** geopbf/cog の二層目キャッシュの口（openCog の opts.cache） */
export interface ByteCache { get(key: string): Promise<Uint8Array | null | undefined>; set(key: string, value: Uint8Array): Promise<unknown> }

const DB = "ortho-cog", ST = "tiles", META = "meta";
interface Rec { b: Uint8Array; t: number; n: number }

export function idbTileCache(budget: number): ByteCache {
	let dbP: Promise<IDBDatabase | null> | null = null;
	const open = () => dbP ??= new Promise<IDBDatabase | null>(res => {
		try {
			if (typeof indexedDB === "undefined") return res(null);
			const rq = indexedDB.open(DB, 1);
			const to = setTimeout(() => res(null), 3000);   // 他タブが握っている等＝待たずに素通しへ
			rq.onupgradeneeded = () => { const db = rq.result; db.createObjectStore(ST).createIndex("t", "t"); db.createObjectStore(META); };
			rq.onsuccess = () => { clearTimeout(to); res(rq.result); };
			rq.onerror = () => { clearTimeout(to); res(null); };
		} catch { res(null); }
	});
	const done = (tx: IDBTransaction) => new Promise<void>((res, rej) => { tx.oncomplete = () => res(); tx.onerror = tx.onabort = () => rej(tx.error); });

	// 古い順に捨てて budget の 8 割へ（1 トランザクション）
	let evicting = false;
	const evict = async (db: IDBDatabase) => {
		if (evicting) return;
		evicting = true;
		try {
			const tx = db.transaction([ST, META], "readwrite"), st = tx.objectStore(ST), meta = tx.objectStore(META);
			const rq = meta.get("total");
			rq.onsuccess = () => {
				let total = (rq.result as number) || 0;
				const cur = st.index("t").openCursor();
				cur.onsuccess = () => {
					const c = cur.result;
					if (c && total > budget * 0.8) { total -= (c.value as Rec).n || 0; c.delete(); c.continue(); return; }
					meta.put(Math.max(0, total), "total");
				};
			};
			await done(tx);
		} catch { /* 捨て損ね＝次の set でまた試す */ }
		finally { evicting = false; }
	};

	return {
		async get(k) {
			const db = await open(); if (!db) return null;
			try {
				const rq = db.transaction(ST).objectStore(ST).get(k);
				return await new Promise<Uint8Array | null>(res => { rq.onsuccess = () => res((rq.result as Rec | undefined)?.b || null); rq.onerror = () => res(null); });
			} catch { return null; }
		},
		async set(k, buf) {
			const db = await open(); if (!db) return;
			const b = buf.slice();   // core の buf は coalesce 塊の subarray＝そのまま clone すると親の塊ごと保存される
			let total = 0;
			try {
				const tx = db.transaction([ST, META], "readwrite"), st = tx.objectStore(ST), meta = tx.objectStore(META);
				const has = st.getKey(k);
				has.onsuccess = () => {
					if (has.result !== undefined) return;   // 既にある＝合計を二重に数えない
					st.put({ b, t: Date.now(), n: b.byteLength } satisfies Rec, k);
					const rq = meta.get("total");
					rq.onsuccess = () => { total = ((rq.result as number) || 0) + b.byteLength; meta.put(total, "total"); };
				};
				await done(tx);
			} catch { return; }
			if (total > budget) evict(db);
		},
	};
}
