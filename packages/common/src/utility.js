export const isArray = Array.isArray;
export const isNumber = _ => typeof _ === 'number' && Number.isFinite(_);
export const isFloat = _ => isNumber(_) && (_ % 1 !== 0);
export const isString = _ => typeof _ === 'string';
export const isFunction = _ => typeof _ == 'function';
export const isAsync = _ => _[Symbol.toStringTag] === 'AsyncFunction';
export const isDOM = _ => _ instanceof Element;
export const isObject = _ => _ !== null && typeof _ === 'object' && !isArray(_);
export const isSimpleObject = _ => Object.prototype.toString.call(_) === '[object Object]' && Object.keys(_).length;
export const isBuffer = _ => (_ instanceof ArrayBuffer || ArrayBuffer.isView(_));
export const isBlob = _ => (_ instanceof Blob);
export const isFile = _ => (isBlob(_) && ("name" in _));
export const isURL = _ => (isString(_) && (_.match(/^https?\:\/\//)));
export const isBbox = _ => _ && _.length == 4 && _.every(isNumber)
    && (-180 <= _[0] && _[0] <= _[2] && _[2] <= 180) && (-90 <= _[1] && _[1] <= _[3] && _[3] <= 90);
export const toArray = _ => (_ != null ? isArray(_) ? _ : [_] : []);
////-----------------------------------------------------------------------------------------------
export const trim = _ => ("" + _).replace(/\s+/g, " ").replace(/(^\s+|\s+$)/g, "");
export const strfix = _ => trim(_).normalize('NFKC');
export const tostr = async _ => _ ? isDOM(_) ? _.outerHTML : isFunction(_) ? isAsync(_)? await _(): _() :
    isArray(_) ? _.map(trim).filter(t => t).join("<br/>") : String(_) : "";
export const comma = _ => { if (typeof _ === 'number') return _.toLocaleString();
    let s = String(_ ?? "").replace(/,/g, ""); const parts = s.split(".");
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return parts.join(".");
};
export const jsonSize = f => (new Blob([JSON.stringify(f)],{type: "text/plain"}).size/1024/1024).toFixed(3)+" MB";
export const clearObject = q => { for (const _ of Object.getOwnPropertyNames(q)) delete q[_]; };
////-----------------------------------------------------------------------------------------------
const pad = (n, len) => String(n).padStart(len, '0');
export const L2 = n => pad(n, 2);
export const L3 = n => pad(n, 3);
export const L4 = n => pad(n, 4);
export const L5 = n => pad(n, 5); 
export const dateArray = _ => { const d = _ == null ? new Date() : new Date(_); return [d.getFullYear()].concat([d.getMonth() + 1, d.getDate()].map(L2)); };
export const timeArray = _ => { const d = _ == null ? new Date() : new Date(_); return [d.getHours(), d.getMinutes(), d.getSeconds()].map(L2); };
export const datimArray = _ => [dateArray(_), timeArray(_)].flat();
////-----------------------------------------------------------------------------------------------
export const thenEach = async(a, func) => { const n = a.length;
    for (let i = 0; i < n; i++) await func(a[i], i).catch(console.error);
};
export const thenMap = async(a, func) => { const n = a.length, result = [];
    for (let i = 0; i < n; i++) result.push(await func(a[i], i).catch(console.error));
    return result;
};
export const thread = async(a, func, n = 4) => { const results = [];
    return new Promise(resolve => { let count = n;
        for (let th = 0; th < n; th++) go(th);
        function go(th) { let v = a.shift();
            v == null ? count-- : func(v, th).then(res => (results.push(res), go(th))).catch(() => go(th));
            count || resolve(results);
        }
    });
};
export const max = a => Math.max(...(a || []));
export const min = a => Math.min(...(a || []));
export const sum = a => (a || []).reduce((acc, cur) => acc + cur, 0);
export const unique = a => [...new Set(a)];
export const concat = a => a.flat();
export const slice = (a, n) => { const q = [];
    for (let i = 0; i < a.length; i += n) q.push(a.slice(i, i + n));
    return q;
};
export const random = a => {
    for (let i = a.length - 1; i > 0; i--) {
        let r = Math.floor(Math.random() * (i + 1));
        [a[r], a[i]] = [a[i], a[r]];
    }
    return a;
};
export const xy2yx = a => { if (!a.length) return [];
    return a[0].map((_, m) => a.map(n => n[m]));
};
let _prevEscapeHandler = null;
export const escape = func => { if (typeof document === 'undefined') return;
    if (_prevEscapeHandler) document.removeEventListener("keyup", _prevEscapeHandler);
     const handler = e => {
        if (e.key === "Escape" || e.keyCode === 27) {
            e.stopPropagation(); e.preventDefault();
            isFunction(func) && func(e);
        }
    };
   document.addEventListener("keyup", handler);
    _prevEscapeHandler = handler;
};
////-----------------------------------------------------------------------------------------------
let saveDire = null;
export const download = (blob, name) => {
    name = name || blob.name || "download";
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
};
export const saveTo = async(blob, name) => {
    try {
        if (!saveDire) {
            saveDire = await window.showDirectoryPicker({ mode: 'readwrite' });
        } else {
            const status = await saveDire.queryPermission({ mode: 'readwrite' });
            if (status !== 'granted') {
                saveDire = await window.showDirectoryPicker({ mode: 'readwrite' });
            }
        }
        const fileName = name || blob.name || "download";
        const fileHandle = await saveDire.getFileHandle(fileName, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(blob);
        await writable.close();
        console.info(`Saved: ${fileName}`);
        return true;
    } catch (err) {
        if (err.name === 'AbortError') return false;
        saveDire = null;
        console.error("Save failed:", err);
        throw err;
    }
};
export const dynamicWebWorker = (worker_url, val) => new Promise((resolve,reject)=>{
    let worker = new Worker(worker_url);
    worker.onmessage = e=>{ worker.terminate(); worker = null; resolve(e.data);}
    worker.onerror = e=>{ worker.terminate(); reject(e); }
    worker.postMessage(val);
});
