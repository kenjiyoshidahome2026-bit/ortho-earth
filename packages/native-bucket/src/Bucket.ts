import { fname2mime } from "geopbf/fname2mime";
// ⚠zip の読み書きは静的 import のまま（2026-09-23 差し戻し）：動的 import にすると world の出荷物で `import("geopbf/decodeZIP")` が
// 解決されないまま止まり（失敗なら捨てられるが「止まる」＝gets の Promise が永久に未解決）、起動が「Loading the world…」で固まった。
import { decodeZIP } from "geopbf/decodeZIP";
import { encodeZIP } from "geopbf/encodeZIP";
import { gzip, gunzip, isGzip } from "geopbf/gzip";
import type { DecodeZIPOptions, ZipEntryInfo } from "geopbf/decodeZIP";

export interface BucketOptions {
	/** bucket API の根（例 https://api.example.com/bucket/）＝必須 */
	baseUrl?: string;
	apiKey?: string;
	/** console.log を出さない */
	silent?: boolean;
	/** LoadStart／SaveProgress… を投げる先（既定＝window か self） */
	eventTarget?: EventTarget | null;
	/** 到達確認の list() を省く */
	lazy?: boolean;
}
/** R2 の一覧の 1 件（API の生の形） */
export interface BucketRawObject { Key?: string; Size?: number; LastModified?: string; ETag?: string }
/** list()／meta() が返す 1 件（Key＝ディレクトリを外した名前・ETag＝引用符なし） */
export interface BucketObject { Key: string | undefined; Size: number | undefined; LastModified: string | undefined; ETag: string }
export type BucketGetType = "blob" | "json" | "text" | "arrayBuffer";
export type BucketZipTarget = string | false | null | DecodeZIPOptions;

class _Bucket {
	baseUrl: string;
	directory: string;
	apiKey: string;
	url: string;
	log: boolean;
	event: EventTarget | null;
	constructor(directory: string, opts: BucketOptions = {}) {
		const globalScope: EventTarget | null = typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : null);
		if (!opts.baseUrl) throw new Error("native-bucket: opts.baseUrl is required");
		this.baseUrl = opts.baseUrl;
		this.directory = directory.replace(/\/$/, "") + "/"; // enforce trailing slash on directory name
		this.apiKey = opts.apiKey || "";
		this.url = this.baseUrl + this.directory;
		this.log = !opts.silent;
		this.event = (typeof CustomEvent === 'undefined') ? null : opts.eventTarget || globalScope;
	}
	offline(): boolean { return typeof navigator !== 'undefined' && navigator.onLine === false; }
	_dispatch(type: string, detail: unknown): void { this.event && this.event.dispatchEvent(new CustomEvent(type, { detail })); }
	_log(s: string): void { this.log && console.log(s); }
	_conv(v: BucketRawObject | null | undefined): BucketObject | null {
		if (!v) return null;
		let { Key, Size, LastModified, ETag } = v;
		const shortKey = Key ? Key.split("/").filter(Boolean).pop() : undefined;
		return { Key: shortKey, Size, LastModified, ETag: (ETag || "").replace(/"/g, "") };
	}
	/** 1 件の情報。無い＝null・オフライン／失敗＝false */
	async meta(name: string): Promise<BucketObject | null | false> {
		if (this.offline()) return false;
		try {
			const res = await fetch(this.url + name + "?meta=1");
			if (res.status === 404) return null;
			if (!res.ok) return false;
			const v: { data?: BucketRawObject | null } | null = await res.json();
			return v ? this._conv(v.data) : null;
		} catch (e) { return false; }
	}
	async exist(name: string): Promise<boolean> { return !!(await this.meta(name)); }
	async etag(name: string): Promise<string | null | false> {
		const q = await this.meta(name);
		if (q === false) return false;
		return q ? q.ETag : null;
	}
	async list(): Promise<(BucketObject | null)[]> {
		if (this.offline()) return [];
		try {
			const res = await fetch(this.url);
			if (!res.ok) return [];
			const result: { data?: { Contents?: BucketRawObject[] } } = await res.json();
			const contents = result.data?.Contents || [];
			return contents.map(i => this._conv(i));
		} catch (e) {
			console.error("List failed:", e);
			return [];
		}
	}
	/** 1 本取る（gzip は伸ばす）。失敗＝null */
	async get(name: string, type?: "blob"): Promise<Blob | null>;
	async get(name: string, type: "text"): Promise<string | null>;
	async get(name: string, type: "arrayBuffer"): Promise<ArrayBuffer | null>;
	async get(name: string, type: "json" | string): Promise<unknown>;
	async get(name: string, type: string = "blob"): Promise<unknown> {
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
	/** 置く（名前付きの File 1 つ、か name と Blob）。縮めてよい物は gzip で。返り＝送ったバイト数 */
	async put(name: string | File, file?: Blob): Promise<number> {
		if (name instanceof Blob && name.name) [file, name] = [name, name.name];
		const key = name as string, f0 = file as Blob;   // ここから先は文字列と Blob（名前の無い File・Blob 無しは旧来どおり split／isGzip で落ちる）
		const compressed = ['zip','gz','7z','rar','tar','tgz','pdf','epub','jpg','jpeg','png','gif','webp','mp4','mkv','mov','avi','webm','mp3','ogg','wav','flac'];
		const extension = key.split('.').pop()!.toLowerCase();
		const compressible = !compressed.includes(extension) && !(await isGzip(f0));
		const f = compressible ? await gzip(f0) : f0;
		const targetUrl = this.url + key.replace(/^\//, "");
		const mpThreshold = 50 * 1024 * 1024; // files below 50 MB use simple PUT
		const chunkSize   =  5 * 1024 * 1024; // 5 MB chunks for multipart
		this._dispatch("SaveStart", { name: key });
		if (f.size < mpThreshold) {
			const headers: Record<string, string> = { 'X-Action': 'put', 'X-API-Key': this.apiKey, 'X-Metadata-Type': f.type || 'application/octet-stream' };
			if (compressible) headers['X-Content-Encoding'] = "gzip";
			const res = await fetch(targetUrl, { method: 'POST', headers, body: f });
			if (!res.ok) { const e: { error?: string } = await res.json().catch(() => ({})); throw new Error(`put failed: ${res.status} ${e.error ?? ""}`); }
			this._dispatch("SaveEnd", { name: key, total: f.size });
			return f.size;
		}
		// Files >= 50 MB use multipart upload.
		let headers: Record<string, string> = { 'X-Action': 'mp-create', 'X-API-Key': this.apiKey, 'X-Metadata-Type': f.type || 'application/octet-stream' };
		if (compressible) headers['X-Content-Encoding'] = "gzip";
		const createRes = await fetch(targetUrl, { method: 'POST', headers });
		if (!createRes.ok) { const e: { error?: string } = await createRes.json().catch(() => ({})); throw new Error(`mp-create failed: ${createRes.status} ${e.error ?? ""}`); }
		const { uploadId }: { uploadId: string } = await createRes.json();
		const parts: { partNumber: number; etag: string }[] = [];
		let partNumber = 1, totalUploaded = 0;
		for (let start = 0; start < f.size; start += chunkSize) {
			const chunk = f.slice(start, start + chunkSize);
			const uploadRes = await fetch(targetUrl, {
				method: 'POST',
				headers: { 'X-Action': 'mp-upload', 'X-API-Key': this.apiKey, 'X-Upload-ID': uploadId, 'X-Part-Number': partNumber.toString() },
				body: chunk
			});
			if (!uploadRes.ok) { const e: { error?: string } = await uploadRes.json().catch(() => ({})); throw new Error(`mp-upload failed: ${uploadRes.status} ${e.error ?? ""}`); }
			const { etag }: { etag: string } = await uploadRes.json();
			parts.push({ partNumber, etag });
			totalUploaded += chunk.size;
			this._dispatch("SaveProgress", { name: key, saved: totalUploaded, total: f.size });
			partNumber++;
		}
		const completeRes = await fetch(targetUrl, {
			method: 'POST',
			headers: { 'X-Action': 'mp-complete', 'X-API-Key': this.apiKey, 'Content-Type': 'application/json' },
			body: JSON.stringify({ uploadId, parts })
		});
		if (!completeRes.ok) { const e: { error?: string } = await completeRes.json().catch(() => ({})); throw new Error(`mp-complete failed: ${completeRes.status} ${e.error ?? ""}`); }
		this._dispatch("SaveEnd", { name: key, total: totalUploaded });
		return totalUploaded;
	}
	async del(name: string): Promise<boolean> {
		const url = this.url + name.replace(/^\//, "");
		const res = await fetch(url, { method: 'POST', headers: { 'X-Action': 'del', 'X-API-Key': this.apiKey } });
		this._dispatch("Delete", name);
		return res.ok;
	}
	/** zip を取って中身を出す（target＝decodeZIP と同じ）。取れなければ [] */
	async gets(name: string, target: BucketZipTarget = null): Promise<File[] | File | ZipEntryInfo[] | null> {
		const blob = await this.get(name.replace(/\.zip/i, "") + ".zip");
		return blob ? decodeZIP(blob, target) : [];
	}
	/** File の列を zip にして置く */
	async puts(name: string, files: Iterable<File>): Promise<number> {
		const blob = await encodeZIP(files);
		return this.put(new File([blob], name, { type: blob.type }));
	}
}
/** Bucket() が返す物（class は外に出さない＝旧来どおり関数の口だけ） */
export type Bucket = _Bucket;

export async function Bucket(dir: string, opts?: BucketOptions): Promise<_Bucket | null> {
	const instance = new _Bucket(dir, opts);
	if (instance.offline()) return instance;
	if (opts && opts.lazy) return instance;   // lazy: 到達確認の list() を省く（起動時の一覧リクエスト 1 本＝0.7s を節約。apps/world 2026-09-10）
	try { await instance.list(); return instance;
	} catch (e) { return null;  }
}
