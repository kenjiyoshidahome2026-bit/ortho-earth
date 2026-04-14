const _cacheTub = {};
export async function Cache(name) {
	const isFile = v => ((v instanceof File) || (v instanceof Blob && v.name));
	let [dbname, tblname] = name.split(/[\.\/]/); tblname = tblname || dbname;
////-------------------------------------------------------------------------------------------
	const open = () => new Promise((resolve, reject) => {
		const req = indexedDB.open(dbname);
		req.onsuccess = e => { const dbInstance = e.target.result;
			dbInstance.onversionchange = dbInstance.close;
			resolve(dbInstance);
		};
		req.onerror = e => reject(e.target.error);
	});
	const get = (key) => new Promise((resolve, reject) => {
		const tx = _cacheTub[dbname].transaction([tblname], "readonly");
		const tbl = tx.objectStore(tblname);
		const req = (key === undefined) ? tbl.getAllKeys() : tbl.get(key);
		req.onsuccess = () => resolve(req.result); 
		req.onerror = e => reject(e.target.error);
	});
	const put = (key, val) => new Promise((resolve, reject) => {
		const tx = _cacheTub[dbname].transaction([tblname], "readwrite");
		const tbl = tx.objectStore(tblname);
		const req = (val === false || val === null) ? tbl.delete(key) : tbl.put(val, key);
		req.onsuccess = () => resolve(val);
		req.onerror = e => reject(e.target.error);
	});
////-------------------------------------------------------------------------------------------
	let db = _cacheTub[dbname] || (_cacheTub[dbname] = await open(dbname));
	if (!db.objectStoreNames.contains(tblname)) {
		const nextVersion = db.version + 1;
		db.close(); delete _cacheTub[dbname];
		db = await new Promise((resolve, reject) => {
			const req = indexedDB.open(dbname, nextVersion);
			req.onblocked = () => console.error("indexedDB is blocked. Close other tabs.");
			req.onupgradeneeded = e => { const upgradeDb = e.target.result;
				upgradeDb.objectStoreNames.contains(tblname) || upgradeDb.createObjectStore(tblname);
			};
			req.onsuccess = e => resolve(e.target.result);
			req.onerror = e => reject(e.target.error);
		});
		_cacheTub[dbname] = db;
	}
	return (key, val) => val === undefined ? (isFile(key) ? put(key.name, key) : get(key)) : put(key, val);
}