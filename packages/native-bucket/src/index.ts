import { Bucket as _Bucket } from "./Bucket.ts";
import { Fetch as _Fetch } from "./Fetch.ts";
import { Cache } from "./Cache.ts";
import type { BucketOptions } from "./Bucket.ts";
import type { FetchOptions } from "./Fetch.ts";

export interface NativeBucketOptions { apiKey?: string }
/** nativeBucket(apiUrl) が返す口＝proxy と bucket の URL を結んだ Fetch／Bucket と、そのままの Cache */
export interface NativeBucket {
	Fetch: (url: string, opt?: string | FetchOptions) => ReturnType<typeof _Fetch>;
	Bucket: (dir: string, opts?: BucketOptions) => ReturnType<typeof _Bucket>;
	Cache: typeof Cache;
}

export function nativeBucket(apiUrl: string, options: string | NativeBucketOptions = {}): NativeBucket {
	if (!apiUrl) throw new Error("native-bucket: apiUrl is required");
	const API_BASE = apiUrl;
	const { apiKey = "" } = typeof options === "string" ? { apiKey: options } : options;
	// apiKey も渡す＝proxy の第二の門（allowlist 外ホストをキー持ちクライアントに開ける）。Fetch は proxy 宛にだけキーを付ける
	const proxyOption = (opts: string | FetchOptions): FetchOptions => typeof opts === "string"
		? { type: opts, proxy: `${API_BASE}/proxy/`, apiKey }
		: { proxy: `${API_BASE}/proxy/`, apiKey, ...opts };
	const bucketOption = (opts: BucketOptions): BucketOptions => ({ baseUrl: `${API_BASE}/bucket/`, apiKey, ...opts });
	return {
		Fetch: (url, opt = {}) => _Fetch(url, proxyOption(opt)),
		Bucket: (dir, opts = {}) => _Bucket(dir, bucketOption(opts)),
		Cache
	};
}

export default nativeBucket;

export * from "./Fetch.ts"
export * from "./Cache.ts"
export * from "./Bucket.ts"
export * from "geopbf/encodeZIP"
export * from "geopbf/decodeZIP"
export * from "geopbf/gzip"
