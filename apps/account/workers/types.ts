// account Worker が共用する型だけの置き場（TS 化・2026-10-17）。実行時の中身は無い＝import type でだけ読む。
// @cloudflare/workers-types は入れない＝使う所だけ最小の形を自前で書く（D1・R2）＝native-bucket/workers/types.ts と同じ流儀。

// D1（env.DB）。行の形は呼ぶ側が first<T>()／all<T>() で名乗る
export interface D1PreparedStatement {
	bind(...values: unknown[]): D1PreparedStatement;
	first<T = Record<string, unknown>>(): Promise<T | null>;
	all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
	run(): Promise<unknown>;
}
export interface D1Database {
	prepare(sql: string): D1PreparedStatement;
	batch(statements: D1PreparedStatement[]): Promise<unknown[]>;
}

// R2（env.USER_BUCKET）。get の onlyIf が外れた（304 相当）時は body が無い
export interface R2Object { size: number; httpEtag: string; writeHttpMetadata?(headers: Headers): void }
export interface R2ObjectBody extends R2Object { body?: ReadableStream | null }
export interface R2Bucket {
	put(key: string, value: ReadableStream | null, options?: { httpMetadata?: { contentType?: string } }): Promise<R2Object | null>;
	get(key: string, options?: { onlyIf?: Headers }): Promise<R2ObjectBody | null>;
	delete(key: string): Promise<void>;
}

// wrangler.toml の binding・vars と secret（*_CLIENT_ID／*_CLIENT_SECRET）・.dev.vars の DEV
export interface Env {
	DB: D1Database;
	USER_BUCKET: R2Bucket;
	BASE_URL: string;
	ALLOWED_ORIGINS?: string;
	DEV?: string;
	GITHUB_CLIENT_ID?: string; GITHUB_CLIENT_SECRET?: string;
	GOOGLE_CLIENT_ID?: string; GOOGLE_CLIENT_SECRET?: string;
	X_CLIENT_ID?: string; X_CLIENT_SECRET?: string;
}
/** requireUser の答え＝セッションの持ち主 */
export interface User { id: string; name: string | null; avatar_url: string | null }
