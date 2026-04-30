//import { DOMParser } from 'linkedom';
import { fname2mime } from "./fname2mime.js";
import { decodeZIP } from "./decodeZIP.js";

/**
 * Fetch - スマートプロキシ対応・キャッシュ対策済み通信ユーティリティ
 */
export async function Fetch(url, opts = {}) {
    const type = ((typeof opts == "string")? opts: opts.type || "file").toLowerCase();
    const PROXY_URL = opts.proxy || `https://api.ortho-earth.com/proxy`;
    const proxy = s => `${PROXY_URL}?url=${encodeURIComponent(s)}`;
    const encoding = (opts.encoding||"utf8").toLowerCase().replace(/[\-\_]/g,"").replace(/shiftjis/,"sjis");
    const silent = !!opts.silent || console === undefined;

    let eventTarget = opts.eventTarget || (typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : null));
    if (typeof CustomEvent === 'undefined' || !eventTarget.dispatchEvent) eventTarget = null;
    const event = (type, detail) => eventTarget && eventTarget.dispatchEvent(new CustomEvent(type, { detail }));

    let name = opts.name || url.split("/").pop().split("?")[0] || "unknown";
    let surfix = name.split(".").reverse()[0].toLowerCase();
    const target = (surfix == "zip" && opts.target !== undefined) ? opts.target : null;
    if (target) { name = target }; 

    try {
        let cors = false, range = true;
        if (opts.cors !== undefined) {
            cors = !!opts.cors;
        } else {
            const checkRes = await fetch(`${proxy(url)}&mode=check`);
            const info = await checkRes.json();
            if (!info.exists) { console.warn(`file is not exist: ${url}`); return null; }
            cors = info.mustUseProxy;
            range = info.supportsRange;
        }

        const targetURL = cors ? proxy(url) : url;

        // 1. 部分取得 (Rangeリクエスト) を利用する場合
        if (range && target != null) {
            const file = await decodeZIP(targetURL, target);
            if (target === false) return file; // メタデータ取得モード
            if (!file) { 
                console.warn(`file is not exist: ${target} in ${url}`);
                console.log("zip file includes:", await decodeZIP(targetURL, false));
            }
            return await convert(file, type, encoding);
        }

        // 🚀 2. 全体取得 (修正ポイント: キャッシュバスターと no-store を追加)
        // URLにランダムなクエリを付与し、ブラウザ/プロキシの古いキャッシュをバイパスする
        const finalURL = `${targetURL}${targetURL.includes('?') ? '&' : '?'}_t=${Date.now()}`;
        const res = await fetch(finalURL, { cache: 'no-store' }); 
        
        if (!res.ok) throw new Error(res.status);

        const reader = res.body.getReader(), chunks = [];
        const total = parseInt(res.headers.get('Content-Length') || 0, 10) || 0;
        const totalLength = total ? total.toLocaleString() : "(unknown)";
        
        silent || console.log(`${url}: contentLength = ${total} bytes ${cors?"[PROXY]":""}`);
        const logProgress = len => silent || console.log(` => ${name}: ${len.toLocaleString()} / ${totalLength} bytes`);
        
        let loaded = 0, n = 0;
        event("FetchStart", {name});

        while (true) {
            const { done, value } = await reader.read(); if (done) break;
            chunks.push(value);
            loaded += value.length;
            if (++n % 256 === 0) { 
                logProgress(loaded); 
                event("FetchProgress", { name, loaded, total }); 
            }
        }
        logProgress(loaded);
        event("FetchEnd", {name});

        let rawBlob = new Blob(chunks);
        const head = new Uint8Array(await rawBlob.slice(0, 2).arrayBuffer());
        
        if (head[0] === 0x1f && head[1] === 0x8b) { // Gzip展開
            const ds = new DecompressionStream("gzip");
            rawBlob = await new Response(rawBlob.stream().pipeThrough(ds)).blob();
            name = name.replace(/\.gz(ip)?$/i, "");
            silent || console.log(` => ${name}: Decompressed (Gzip)`);
        }

        let file = new File([rawBlob], name, {type: fname2mime(name)});
        if (target) file = await decodeZIP(file, target);
        return await convert(file, type, encoding);

    } catch (error) { 
        event("FetchError", {name, error}); 
        throw error; 
    }

    async function convert(file, type, encoding) {
        if (!file) return null;
        if (type === "file") return file;
        if (type === "blob") return new Blob([file], { type: file.type });
        if (type === "arraybuffer") return await file.arrayBuffer();
        if (["text","json","xml","html","csv"].includes(type)) {
            const { DOMParser } = await import('linkedom');
            const text = new TextDecoder(encoding).decode(await file.arrayBuffer());
            return (type === "json") ? JSON.parse(text) :
                   (type === "xml") ? new DOMParser().parseFromString(text, 'text/xml') :
                   (type === "html") ? new DOMParser().parseFromString(text, 'text/html') :
                   (type === "csv") ? str2csv(text) : text;
        }
        return file;

        function str2csv(str) {
            let a = [[""]], i = 0, j = 0;
            str.replace(/^\xEF\xBB\xBF/,"")
            .replace(/\r?\n$/, '').replace(/\,|\r?\n|[^\,\"\r\n][^\,\r\n]*|\"(?:[^\"]|\"\")*\"/g, function(s) {
                if (s === "\n" || s === "\r\n") a[++i] = [""], j = 0; else if (s === ",") a[i][++j] = "";
                else if (s.charAt(0) === '"') a[i][j] = s.slice(1, -1).replace(/""/g, '"');
                else { 
                    s = s.replace(/^\s+|\s+$/g, "");
                    a[i][j] = s === "true"? true: s === "false"? false: s === "null"? null:
                    (isNaN(s)||s==="")? s: isFinite(s)? s.match(/e[+-]?\d/i)? s:+s:s;
                }
            });
            return a;
        };
    }
}