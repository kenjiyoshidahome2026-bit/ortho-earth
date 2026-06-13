import { fname2mime } from "./fname2mime.js";
import { decodeZIP } from "./decodeZIP.js";
import { encodeZIP } from "./encodeZIP.js";
import { gzip, gunzip, isGzip } from "./gzip.js";

class _Bucket {
    constructor(directory, opts = {}) {
        const globalScope = typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : null);
        if (!opts.baseUrl) throw new Error("native-bucket: opts.baseUrl is required");
        this.baseUrl = opts.baseUrl;
        this.directory = directory.replace(/\/$/, "") + "/";// ディレクトリ名の末尾を必ず / にする
		this.apiKey = opts.apiKey || ""; // APIキーを保持
        this.url = this.baseUrl + this.directory;
        this.log = !opts.silent;
        this.event = (typeof CustomEvent === 'undefined') ? null : opts.eventTarget || globalScope;
    }
    offline() { return typeof navigator !== 'undefined' && navigator.onLine === false; }
    _dispatch(type, detail) { this.event && this.event.dispatchEvent(new CustomEvent(type, { detail })); }
    _log(s) { this.log && console.log(s); }
    // R2のデータ構造を使いやすい形に変換
    _conv(v) {
        if (!v) return null;
        let { Key, Size, LastModified, ETag } = v;
        const shortKey = Key ? Key.split("/").filter(Boolean).pop() : undefined;
        return { Key: shortKey, Size, LastModified, ETag: (ETag || "").replace(/"/g, "") };
    }
    async meta(name) {
        if (this.offline()) return false;
        try {
            const res = await fetch(this.url + name + "?meta=1");
            if (res.status === 404) return null;
            if (!res.ok) return false;
            const v = await res.json();
            return v ? this._conv(v.data) : null;
        } catch (e) { return false; }
    }
    async exist(name) { return !!(await this.meta(name)); }
	async etag(name) {
        const q = await this.meta(name);
        if (q === false) return false;
        return q ? q.ETag : null;
    }
    async list() {
        if (this.offline()) return [];
        try { // ディレクトリURLに対して GET を行う
            const res = await fetch(this.url);
            if (!res.ok) return [];
            const result = await res.json();
            const contents = result.data?.Contents || [];
            return contents.map(i => this._conv(i));
        } catch (e) {
            console.error("List failed:", e);
            return [];
        }
    }
    async get(name, type = "blob") {
        this._dispatch("LoadStart", { name });
        try {
            const res = await fetch(this.url + name);
            if (!res.ok) throw new Error("Load failed");
            let blob = await res.blob();
            this._log(` => total loaded: ${blob.size.toLocaleString()} bytes`);
            blob = await gunzip(blob);
            this._log(` => total expanded: ${blob.size.toLocaleString()} bytes`);
            blob = new Blob([blob], { type: fname2mime(name) });
            this._dispatch("LoadEnd", { name, total: blob.size });
            if (type === "json") return JSON.parse(await blob.text());
            if (type === "text") return await blob.text();
            if (type === "arrayBuffer") return await blob.arrayBuffer();
            return blob;
        } catch (e) {
            this._dispatch("LoadError", name);
            return null;
        }
    }
    async put(name, file) {
        if (name instanceof Blob && name.name) [file, name] = [name, name.name];
        const compressed = ['zip','gz','7z','rar','tar','tgz','pdf','epub','jpg','jpeg','png','gif','webp','mp4','mkv','mov','avi','webm','mp3','ogg','wav','flac'];
        const extension = name.split('.').pop().toLowerCase();
        const compressible = !compressed.includes(extension) && !(await isGzip(file));
        if (compressible) file = await gzip(file);
        const targetUrl = this.url + name.replace(/^\//, "");
        const sizeThreshold = 5 * 1024 * 1024; // 5MB
        this._dispatch("SaveStart", { name });
        // 1. アップロード開始
        let headers = { 'X-Action': 'mp-create', 'X-API-Key': this.apiKey, 'X-Metadata-Type': file.type || 'application/octet-stream' };
        if (compressible) headers['X-Content-Encoding'] = "gzip";
        const createRes = await fetch(targetUrl, { method: 'POST', headers });
        const { uploadId } = await createRes.json();
        const parts = []; // 2. 分割アップロード
        let partNumber = 1;
        let totalUploaded = 0;
        for (let start = 0; start < file.size; start += sizeThreshold) {
            const chunk = file.slice(start, start + sizeThreshold);
            const uploadRes = await fetch(targetUrl, {
                method: 'POST',
                headers: { 'X-Action': 'mp-upload', 'X-API-Key': this.apiKey, 'X-Upload-ID': uploadId, 'X-Part-Number': partNumber.toString() },
                body: chunk
            });
            const { etag } = await uploadRes.json();
            parts.push({ partNumber, etag });
            totalUploaded += chunk.size;
            this._dispatch("SaveProgress", { name, saved: totalUploaded, total: file.size });
            partNumber++;
        }
        const completeRes = await fetch(targetUrl, { // 3. アップロード完了
            method: 'POST',
            headers: { 'X-Action': 'mp-complete', 'X-API-Key': this.apiKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({ uploadId, parts })
        });
        this._dispatch("SaveEnd", { name, total: totalUploaded });
        return completeRes.ok ? totalUploaded : 0;
    }
    async del(name) {
        const url = this.url + name.replace(/^\//, "");
        const res = await fetch(url, { method: 'POST', headers: { 'X-Action': 'del', 'X-API-Key': this.apiKey } });
        this._dispatch("Delete", name);
        return res.ok;
    }
    async gets(name, target = null) {
        const blob = await this.get(name.replace(/\.zip/i, "") + ".zip");
        return blob ? decodeZIP(blob, target) : [];
    }
    async puts(name, files) {
        const blob = await encodeZIP(files);
        return this.put(new File([blob], name, { type: blob.type }));
    }
}

export async function Bucket(dir, opts) {
    const instance = new _Bucket(dir, opts);
    if (instance.offline()) return instance; // 接続テストとして1件だけリストを試みる
    try { await instance.list(); return instance;
    } catch (e) { return null;  }
}