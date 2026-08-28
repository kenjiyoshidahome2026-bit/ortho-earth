// テスト用シム：デプロイ不要でハンドラを直に叩く（native-bucket/tests/t-proxy.mjs と同流儀）。
//  - makeD1: Node 組み込み node:sqlite（in-memory）を D1 の形（prepare/bind/first/all/run・batch）に包み、実 migration を食わせる
//  - makeR2: Map ベースの R2 もどき（put/get/delete・If-None-Match → body 無し返し）
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const MIG_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));

export function makeD1() {
	const db = new DatabaseSync(":memory:");
	for (const f of readdirSync(MIG_DIR).filter(f => f.endsWith(".sql")).sort()) db.exec(readFileSync(MIG_DIR + f, "utf8"));
	const wrap = (sql, args = []) => ({
		bind: (...a) => wrap(sql, a),
		first: async () => db.prepare(sql).get(...args) ?? null,
		all: async () => ({ results: db.prepare(sql).all(...args) }),
		run: async () => { db.prepare(sql).run(...args); return { success: true }; },
	});
	return {
		prepare: sql => wrap(sql),
		batch: async stmts => {
			db.exec("BEGIN");
			try { for (const s of stmts) await s.run(); db.exec("COMMIT"); }
			catch (e) { db.exec("ROLLBACK"); throw e; }
			return [];
		},
		_db: db,   // テストからの直接検分用
	};
}

export function makeR2() {
	const store = new Map();
	let etagN = 0;
	return {
		store,
		async put(key, body, opts = {}) {
			const bytes = new Uint8Array(await new Response(body).arrayBuffer());
			const httpEtag = `"e${++etagN}"`;
			store.set(key, { bytes, httpEtag, httpMetadata: opts.httpMetadata || {} });
			return { size: bytes.length, httpEtag };
		},
		async get(key, { onlyIf } = {}) {
			const o = store.get(key);
			if (!o) return null;
			const base = {
				size: o.bytes.length, httpEtag: o.httpEtag, httpMetadata: o.httpMetadata,
				writeHttpMetadata(h) { if (o.httpMetadata.contentType) h.set("Content-Type", o.httpMetadata.contentType); },
			};
			if (onlyIf?.get?.("If-None-Match") === o.httpEtag) return { ...base, body: null };
			return { ...base, body: new Response(o.bytes.slice()).body };
		},
		async delete(key) { store.delete(key); },
	};
}

export const makeEnv = () => ({
	DB: makeD1(),
	USER_BUCKET: makeR2(),
	BASE_URL: "https://www.ortho-earth.com",
	ALLOWED_ORIGINS: "https://www.ortho-earth.com,http://localhost:5173",
	GITHUB_CLIENT_ID: "gh-id", GITHUB_CLIENT_SECRET: "gh-secret",
	GOOGLE_CLIENT_ID: "go-id", GOOGLE_CLIENT_SECRET: "go-secret",
	X_CLIENT_ID: "x-id", X_CLIENT_SECRET: "x-secret",
});

// t/eq ハーネス（t-proxy.mjs と同型）
let pass = 0, fail = 0;
export const t = async (name, fn) => {
	try { await fn(); pass++; console.log(`  ok   ${name}`); }
	catch (e) { fail++; console.log(`  FAIL ${name}\n       ${e.message}`); }
};
export const eq = (got, want, what) => { if (got !== want) throw new Error(`${what}: got ${got}, want ${want}`); };
export const done = () => { console.log(`\n${fail ? "❌" : "✅"} pass=${pass} fail=${fail}`); process.exit(fail ? 1 : 0); };
