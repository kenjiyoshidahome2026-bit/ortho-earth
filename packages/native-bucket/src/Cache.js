const _cacheTub = {};
const _initQueue = {}; 

// 🔥 汎用Workerインスタンスのキャッシュ用
let _sharedCacheWorker = null;
const _workerCallbacks = new Map();
let _callbackId = 0;

// 🔥 Worker側の処理ロジック（文字列として定義し、BlobURL化してWorkerを動的起動）
const workerCode = `
    const _cacheTub = {};
    
    // メインスレッドから流れてきたリクエストを処理
    onmessage = async (e) => {
        const { id, dbname, tblname, operation, key, val } = e.data;
        try {
            // Worker内で直接IndexedDBを初期化・接続
            if (!_cacheTub[dbname]) {
                _cacheTub[dbname] = await new Promise((resolve, reject) => {
                    const req = indexedDB.open(dbname);
                    req.onsuccess = ev => resolve(ev.target.result);
                    req.onerror = ev => reject(ev.target.error);
                });
            }
            const db = _cacheTub[dbname];
            
            const result = await new Promise((resolve, reject) => {
                const tx = db.transaction([tblname], val === undefined ? "readonly" : "readwrite");
                const tbl = tx.objectStore(tblname);
                const req = val === undefined 
                    ? (key === undefined ? tbl.getAllKeys() : tbl.get(key))
                    : (val === false || val === null ? tbl.delete(key) : tbl.put(val, key));
                req.onsuccess = () => resolve(req.result);
                req.onerror = ev => reject(ev.target.error);
            });

            // 🌟 結果が ArrayBuffer や Blob などのバイナリの場合、Transferable でゼロコピー高速返却
            if (result && result.PBF instanceof ArrayBuffer) {
                postMessage({ id, success: true, result }, [result.PBF]);
            } else if (result instanceof ArrayBuffer) {
                postMessage({ id, success: true, result }, [result]);
            } else {
                postMessage({ id, success: true, result });
            }
        } catch (err) {
            postMessage({ id, success: false, error: err.message });
        }
    };
`;

function getSharedWorker() {
    if (_sharedCacheWorker) return _sharedCacheWorker;
    const blob = new Blob([workerCode], { type: "application/javascript" });
    const url = URL.createObjectURL(blob);
    _sharedCacheWorker = new Worker(url);
    
    _sharedCacheWorker.onmessage = (e) => {
        const { id, success, result, error } = e.data;
        const cb = _workerCallbacks.get(id);
        if (cb) {
            _workerCallbacks.delete(id);
            if (success) cb.resolve(result);
            else cb.reject(new Error(error));
        }
    };
    URL.revokeObjectURL(url);
    return _sharedCacheWorker;
}

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

    // --- メインスレッド側の実行ラッパー ---
    const exec = async (operation, key, val) => {
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
            if (e.name === "InvalidStateError") {
                delete _cacheTub[dbname];
                await initDB();
                return exec(operation, key, val); 
            }
            throw e;
        }
    };

    // --- 🌟 フラグが立っている場合の Worker 実行移譲ラッパー ---
    const execInWorker = (operation, key, val) => { //console.log(`Worker exec: ${operation} ${key} ...`);
        const worker = getSharedWorker();
        const id = _callbackId++;
        
        return new Promise((resolve, reject) => {
            _workerCallbacks.set(id, { resolve, reject });
            
            // データの所有権移転（Transferable）に対応
            const transfer = [];
            if (val && val.Buff instanceof ArrayBuffer) transfer.push(val.Buff);
            else if (val instanceof ArrayBuffer) transfer.push(val);

            worker.postMessage({ id, dbname, tblname, operation, key, val }, transfer);
        });
    };

    if (!_initQueue[dbname]) _initQueue[dbname] = initDB();
    await _initQueue[dbname];

    // 🌟 返却関数を拡張：第3引数に { worker: true } オプションを受け付け可能に
    return (key, val, options = {}) => {
        if (typeof key === "object" && key !== null && key.worker !== undefined) {
            options = key;
            key = undefined;
            val = undefined;
        }
        if (typeof val === "object" && val !== null && val.worker !== undefined) {
            options = val;
            val = undefined;
        }   
        // cache("key", undefined, { worker: true }) のようなケースへの対応
 //       const opt = (typeof val === "object" && val !== null && val.worker !== undefined) ? val : options;
 //       const actualVal = opt === val ? undefined : val;
        
        const run = options.worker ? execInWorker : exec;
        return val === undefined 
            ? (isFile(key) ? run("put", key.name, key) : run("get", key)) 
            : run("put", key, val === false || val === null ? null : val);
    };
}