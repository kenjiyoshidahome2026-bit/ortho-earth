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

        let db = await new Promise((resolve, reject) => {
            const req = indexedDB.open(dbname);
            req.onsuccess = e => resolve(e.target.result);
            req.onerror = e => reject(e.target.error);
        });

        if (!db.objectStoreNames.contains(tblname)) {
            const nextVersion = db.version + 1;
            db.close(); 
            db = await new Promise((resolve, reject) => {
                const req = indexedDB.open(dbname, nextVersion);
                req.onupgradeneeded = e => {
                    const upgradeDb = e.target.result;
                    if (!upgradeDb.objectStoreNames.contains(tblname)) {
                        upgradeDb.createObjectStore(tblname);
                    }
                };
                req.onsuccess = e => resolve(e.target.result);
                req.onerror = e => reject(e.target.error);
            });
        }
        
        db.onversionchange = () => { 
            db.close(); 
            delete _cacheTub[dbname]; 
        };
        _cacheTub[dbname] = db;
        return db;
    };

    // --- エラー防止用の実行ラッパー ---
    const exec = async (operation, key, val) => {
        // 接続が閉じている、または存在しない場合は再初期化を待つ
        if (!_cacheTub[dbname] || _cacheTub[dbname].objectStoreNames.contains(tblname) === false) {
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
            // "Database connection is closing" が出た場合、一度だけ初期化し直してリトライ
            if (e.name === "InvalidStateError") {
                delete _cacheTub[dbname];
                const retryDb = await initDB();
                return exec(operation, key, val); 
            }
            throw e;
        }
    };

    if (!_initQueue[dbname]) _initQueue[dbname] = initDB();
    await _initQueue[dbname];

    return (key, val) => val === undefined 
        ? (isFile(key) ? exec("put", key.name, key) : exec("get", key)) 
        : exec("put", key, val);
}