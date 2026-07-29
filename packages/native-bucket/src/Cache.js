const _cacheTub = {};
const _initQueue = {};

export async function Cache(name) {
	const isFile = v => ((v instanceof File) || (v instanceof Blob && v.name));
	let [dbname, tblname] = name.split(/[\.\/]/);
	tblname = tblname || dbname;

	const initDB = async () => {
		if (_cacheTub[dbname] && _cacheTub[dbname].objectStoreNames.contains(tblname)) {
			return _cacheTub[dbname];
		}

		// onblocked＝他の接続（凍結された背面タブ・イベントループが塞がった worker 等）が version 変更を
		// 握ると onsuccess も onerror も永遠に来ない＝await が「reject ですらない沈黙ハング」になり、
		// 呼び出し側の縮退 catch（plateau=メモリのみ続行／altpbf=キャッシュ無し続行）が発火できない。
		// 明示 reject ＋ 8秒タイムアウト保険（先客の upgrade 待ち行列に並んだ素の open も詰まり得る）で
		// 「一発死/永久待ち」を「縮退可能な失敗」へ。upgradeneeded は素の open（DB新規作成）にも付ける＝
		// 初回訪問はここでストアまで作り、version bump 競争（並行 worker の v+1 衝突）自体を減らす。
		const openDB = version => new Promise((resolve, reject) => {
			const req = version ? indexedDB.open(dbname, version) : indexedDB.open(dbname);
			const to = setTimeout(() => reject(new Error(`indexedDB.open timeout（${dbname}）`)), 8000);
			req.onblocked = () => { clearTimeout(to); reject(new Error(`indexedDB.open blocked（${dbname}＝他タブ/凍結接続が保持）`)); };
			req.onupgradeneeded = e => {
				const u = e.target.result;
				if (!u.objectStoreNames.contains(tblname)) u.createObjectStore(tblname);
			};
			req.onsuccess = e => { clearTimeout(to); resolve(e.target.result); };
			req.onerror = e => { clearTimeout(to); reject(e.target.error); };
		});
		let db = await openDB();
		if (!db.objectStoreNames.contains(tblname)) {
			const nextVersion = db.version + 1;
			db.close();
			db = await openDB(nextVersion);
		}

		db.onversionchange = () => {
			db.close();
			delete _cacheTub[dbname];
		};
		_cacheTub[dbname] = db;
		return db;
	};

	const exec = async (operation, key, val) => {
		if (!_cacheTub[dbname] || !_cacheTub[dbname].objectStoreNames.contains(tblname)) {
			_initQueue[dbname] = initDB();
			await _initQueue[dbname];
		}

		const db = _cacheTub[dbname];
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
			if (e.name === "InvalidStateError") {
				delete _cacheTub[dbname];
				await initDB();
				return exec(operation, key, val);
			}
			throw e;
		}
	};

	if (!_initQueue[dbname]) _initQueue[dbname] = initDB();
	await _initQueue[dbname];

	return (key, val) => {
		if (isFile(key)) return exec("put", key.name, key);
		if (val !== undefined) return exec("put", key, val === false || val === null ? null : val);
		return exec("get", key);
	};
}
