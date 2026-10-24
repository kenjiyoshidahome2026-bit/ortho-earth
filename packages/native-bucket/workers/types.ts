// worker（index・bucket・proxy・tellus）が共用する型だけの置き場（TS 化・2026-10-16）。実行時の中身は無い＝import type でだけ読む。
// @cloudflare/workers-types は入れない＝使う所だけ最小の形を自前で書く（R2・Rate Limiting・ExecutionContext・Assets・caches.default）。

// R2（env.MY_BUCKET）
export interface R2HTTPMetadata { contentType?: string | null; contentEncoding?: string | null }
export interface R2Object { key: string; size: number; uploaded: Date; httpEtag: string; httpMetadata?: R2HTTPMetadata }
export interface R2ObjectBody extends R2Object { body: ReadableStream }
export interface R2Objects { objects: R2Object[]; truncated: boolean; cursor?: string; delimitedPrefixes?: string[] }
export interface R2ListOptions { prefix?: string; cursor?: string; delimiter?: string }
export interface R2PutOptions { httpMetadata?: R2HTTPMetadata }
export type R2PutValue = ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob | null;
export interface R2UploadedPart { partNumber: number; etag: string }
export interface R2MultipartUpload {
	uploadId: string;
	uploadPart(partNumber: number, value: R2PutValue): Promise<R2UploadedPart>;
	complete(parts: R2UploadedPart[]): Promise<R2Object>;
}
export interface R2Bucket {
	list(options?: R2ListOptions): Promise<R2Objects>;
	head(key: string): Promise<R2Object | null>;
	get(key: string): Promise<R2ObjectBody | null>;
	put(key: string, value: R2PutValue, options?: R2PutOptions): Promise<R2Object | null>;
	delete(key: string): Promise<void>;
	createMultipartUpload(key: string, options?: R2PutOptions): Promise<R2MultipartUpload>;
	resumeMultipartUpload(key: string, uploadId: string): R2MultipartUpload;
}

// Workers Rate Limiting の binding（env.PROXY_RL・env.TELLUS_RL）
export interface RateLimiter { limit(options: { key: string }): Promise<{ success: boolean }> }

// Static Assets の binding（env.ASSETS）
export interface Fetcher { fetch(req: Request): Promise<Response> }

export interface ExecutionContext { waitUntil(promise: Promise<unknown>): void; passThroughOnException(): void }

// Cloudflare の caches には既定のキャッシュ caches.default が生える（標準の CacheStorage には無い）
export type CfCacheStorage = CacheStorage & { default: Cache };

// wrangler.toml の binding・vars と secret（API_KEY・TELLUS_TOKEN）
export interface Env {
	MY_BUCKET: R2Bucket;
	ASSETS: Fetcher;
	ALLOWED_DOMAINS?: string;
	PROXY_ALLOWED_HOSTS?: string;
	API_KEY?: string;
	API_KEY_POI?: string;   // 範囲付きの鍵＝GIS/pbf/ の下だけ書ける（poiedit 用・bucket.ts）。proxy・tellus には効かない
	TELLUS_TOKEN?: string;
	PROXY_RL?: RateLimiter;
	TELLUS_RL?: RateLimiter;
}
