const _cacheTub = {};
const _initQueue = {};
const _dead = {};

// 1 つの DB に複数のストアを並べる名前（"GIS/pbf" "GIS/alt"…）は、DB を作る／上げる時に既知のストアを全部まとめて作る。
// 旧＝必要になったストアだけを v+1 で足していた＝新しいプロファイルでは主スレッド（GIS/pbf・GIS/alt）と
// mesh worker（GIS/plateau）・標高 worker（GIS/alt）が起動直後に同じ DB の version を奪い合い、相手の接続が
// 閉じるまで（worker の重い処理が終わるまで）open が待たされ、8 秒切れで「IDB unavailable」→ 以後もずっと遅い、が起きていた
//（verify-ui の t-marker が 20 回中 4〜7 回 60 秒超・2026-10-15 実測）。全部まとめて作れば version は 1 のまま上がらない。
// 新しいストアを足す時はここにも足す（足し忘れても従来どおり v+1 で足される＝壊れはしない）。
const PRESET = {
	GIS: ["pbf", "alt", "plateau", "pack", "base"],
	world: ["files", "system"],
};

export async function Cache(name) {
	const isFile = v => ((v instanceof File) || (v instanceof Blob && v.name));
	let [dbname, tblname] = name.split(/[\.\/]/);
	tblname = tblname || dbname;
	const has = db => !!db && db.objectStoreNames.contains(tblname);

	// onblocked＝他の接続（凍結された背面タブ・イベントループが塞がった worker 等）が version 変更を握っている。
	// 相手が閉じれば進むので、ここでは見捨てずタイムアウト（8 秒）まで待つ。諦めた open は「後から開いたら即閉じる・
	// upgrade に来たら取り消す」＝宙に浮いた接続／upgrade 要求が後続の open を全部塞ぐ、の連鎖を断つ
	//（旧＝blocked で即 reject して要求を放置→後で開いた接続が誰にも閉じられず、以後の version 変更が永久に塞がった）。
	const openDB = version => new Promise((resolve, reject) => {
		const req = version ? indexedDB.open(dbname, version) : indexedDB.open(dbname);
		let gaveUp = false;
		const to = setTimeout(() => { gaveUp = true; reject(Object.assign(new Error(`indexedDB.open timeout（${dbname}）`), { name: "TimeoutError" })); }, 8000);
		req.onblocked = () => console.warn(`[Cache] indexedDB.open blocked（${dbname}＝他タブ/worker の接続が閉じるのを待つ）`);
		req.onupgradeneeded = e => {
			if (gaveUp) { try { e.target.transaction.abort(); } catch { /* 既に終わっている */ } return; }
			const u = e.target.result;
			for (const s of new Set([tblname, ...(PRESET[dbname] || [])])) if (!u.objectStoreNames.contains(s)) u.createObjectStore(s);
		};
		req.onsuccess = e => {
			const db = e.target.result;
			if (gaveUp) { db.close(); return; }
			clearTimeout(to); resolve(db);
		};
		req.onerror = e => { clearTimeout(to); if (!gaveUp) reject(e.target.error); };
	});

	const initDB = async () => {
		let db = await openDB();
		// 既知のストアが欠けている（旧版で作られた DB）＝一度だけ v+1 で全部足す。並行する他の文脈が先に上げていたら
		// VersionError／上げた後もまだ無い、がある＝開き直して数回やり直す
		for (let i = 0; i < 3 && !has(db); i++) {
			const nextVersion = db.version + 1;
			db.close();
			db = await openDB(nextVersion).catch(e => e?.name === "VersionError" ? openDB() : Promise.reject(e));
		}
		if (!has(db)) { db.close(); throw new Error(`indexedDB: store "${tblname}" を作れない（${dbname}）`); }
		db.onversionchange = () => {
			db.close();
			if (_cacheTub[dbname] === db) delete _cacheTub[dbname];
		};
		_cacheTub[dbname] = db;
		return db;
	};

	// 接続の用意（同じ DB への初期化は文脈内で 1 本にまとめる）。タイムアウトした DB はこの文脈では以後使わない＝
	// 呼び出し側は即座に「キャッシュ無し」へ縮退する（旧＝触るたびに 8 秒待ち、逐次読みの標高タイルで map.getHeight が 60 秒超）
	const ready = async () => {
		if (has(_cacheTub[dbname])) return _cacheTub[dbname];
		if (_dead[dbname]) throw _dead[dbname];
		const inflight = _initQueue[dbname];
		if (inflight) {
			await inflight.catch(() => {});
			return ready();
		}
		const p = _initQueue[dbname] = initDB()
			.catch(e => { if (e?.name === "TimeoutError") _dead[dbname] = e; throw e; })
			.finally(() => { if (_initQueue[dbname] === p) delete _initQueue[dbname]; });
		return p;
	};

	const exec = async (operation, key, val, retry = 1) => {
		const db = await ready();
		try {
			return await new Promise((resolve, reject) => {
				const tx = db.transaction([tblname], val === undefined ? "readonly" : "readwrite");
				const tbl = tx.objectStore(tblname);
				const req = val === undefined
					? (key === undefined ? tbl.getAllKeys() : tbl.get(key))
					: (val === false || val === null ? tbl.delete(key) : tbl.put(val, key));
				req.onsuccess = () => resolve(req.result);
				req.onerror = e => reject(e.target.error);
			});
		} catch (e) {
			// 接続が閉じられた（他の文脈の version 変更）＝開き直して 1 回だけやり直す
			if (e.name === "InvalidStateError" && retry > 0) {
				if (_cacheTub[dbname] === db) delete _cacheTub[dbname];
				return exec(operation, key, val, retry - 1);
			}
			throw e;
		}
	};

	await ready();

	return (key, val) => {
		if (isFile(key)) return exec("put", key.name, key);
		if (val !== undefined) return exec("put", key, val === false || val === null ? null : val);
		return exec("get", key);
	};
}
