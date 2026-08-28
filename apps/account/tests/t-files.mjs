// /me・/me/files の検定（デプロイ不要・router を直に叩く）。
//   node apps/account/tests/t-files.mjs
// 仕様の正本は workers/files.js の冒頭コメント。
import worker from "../workers/index.js";
import { createSession } from "../workers/session.js";
import { makeEnv, t, eq, done } from "./shims.mjs";

const ORIGIN = "https://www.ortho-earth.com";

// ユーザーとセッションを直接こしらえる（OAuth 一巡は t-auth の領分）
async function mkUser(env, uid = "u1") {
	env.DB._db.prepare("INSERT INTO users(id,created_at,name,avatar_url) VALUES(?,?,?,?)").run(uid, 0, "Kenji", null);
	return `__Host-sid=${await createSession(env, uid, "test")}`;
}

const call = (env, path, { method = "GET", cookie, origin, headers = {}, body } = {}) => {
	const h = new Headers(headers);
	if (cookie) h.set("Cookie", cookie);
	if (origin !== null) h.set("Origin", origin ?? ORIGIN);   // 既定＝正規 Origin（GET には無害）
	return worker.fetch(new Request(`${ORIGIN}${path}`, { method, headers: h, body }), env);
};
const put = (env, cookie, name, body, opts = {}) =>
	call(env, `/me/files/${name}`, {
		method: "PUT", cookie, body,
		headers: { "Content-Length": String(opts.len ?? new TextEncoder().encode(body).length),
		           "Content-Type": opts.type || "application/x-geopbf" },
		origin: opts.origin,
	});

console.log("── PUT 正常系");
await t("保存 → R2 キー・files 行・/me 使用量・一覧に反映", async () => {
	const env = makeEnv(), sid = await mkUser(env);
	const res = await put(env, sid, "test.geopbf", "data");
	eq(res.status, 200, "status");
	const j = await res.json();
	eq(j.size, 4, "size");
	eq(!!j.etag, true, "etag");
	eq(env.USER_BUCKET.store.has("u/u1/test.geopbf"), true, "R2 キー");
	eq(env.DB._db.prepare("SELECT size FROM files WHERE user_id='u1' AND name='test.geopbf'").get().size, 4, "files 行");
	const me = await (await call(env, "/me", { cookie: sid })).json();
	eq(me.usage.files, 1, "usage.files");
	eq(me.usage.bytes, 4, "usage.bytes");
	const list = await (await call(env, "/me/files", { cookie: sid })).json();
	eq(list.files[0].name, "test.geopbf", "一覧");
});
await t("上書きは加算でなく置換（クォータ計算）", async () => {
	const env = makeEnv(), sid = await mkUser(env);
	await put(env, sid, "a.geopbf", "xxxx");
	await put(env, sid, "a.geopbf", "yy");
	const me = await (await call(env, "/me", { cookie: sid })).json();
	eq(me.usage.files, 1, "files");
	eq(me.usage.bytes, 2, "bytes");
});

console.log("── PUT の門");
await t("★Content-Length 無しは 411", async () => {
	const env = makeEnv(), sid = await mkUser(env);
	const res = await call(env, "/me/files/a.geopbf", { method: "PUT", cookie: sid, body: "data" });
	eq(res.status, 411, "status");
});
await t("★200MB 超は 413 file_too_large", async () => {
	const env = makeEnv(), sid = await mkUser(env);
	const res = await put(env, sid, "big.geopbf", "x", { len: 200 * 1024 * 1024 + 1 });
	eq(res.status, 413, "status");
	eq((await res.json()).error, "file_too_large", "error");
});
await t("★1GiB クォータ超は 413 quota_exceeded", async () => {
	const env = makeEnv(), sid = await mkUser(env);
	env.DB._db.prepare("INSERT INTO files(user_id,name,size,updated_at) VALUES('u1','huge',?,0)").run(1024 ** 3 - 2);
	const res = await put(env, sid, "a.geopbf", "xxxx");
	eq(res.status, 413, "status");
	eq((await res.json()).error, "quota_exceeded", "error");
});
await t("★100 ファイル超は 413・ただし既存名の上書きは通る", async () => {
	const env = makeEnv(), sid = await mkUser(env);
	const ins = env.DB._db.prepare("INSERT INTO files(user_id,name,size,updated_at) VALUES('u1',?,1,0)");
	for (let i = 0; i < 100; i++) ins.run(`f${i}`);
	eq((await put(env, sid, "new.geopbf", "x")).status, 413, "新規は 413");
	eq((await put(env, sid, "f0", "x")).status, 200, "上書きは 200");
});
await t("★名前の関門：a%2Fb・制御文字・101字は 400、.. は URL 正規化で届かない", async () => {
	const env = makeEnv(), sid = await mkUser(env);
	eq((await put(env, sid, "a%2Fb", "x")).status, 400, "スラッシュ");
	eq((await put(env, sid, "a%00b", "x")).status, 400, "制御文字");
	eq((await put(env, sid, encodeURIComponent("x".repeat(101)), "x")).status, 400, "101字");
	const res = await put(env, sid, "..", "x");
	eq(res.status !== 200, true, ".. は保存されない");
	eq(env.USER_BUCKET.store.size, 0, "R2 は空のまま");
});
await t("日本語名は往復できる", async () => {
	const env = makeEnv(), sid = await mkUser(env);
	eq((await put(env, sid, encodeURIComponent("地図.geopbf"), "nihon")).status, 200, "PUT");
	const list = await (await call(env, "/me/files", { cookie: sid })).json();
	eq(list.files[0].name, "地図.geopbf", "一覧の表示名");
	const got = await call(env, `/me/files/${encodeURIComponent("地図.geopbf")}`, { cookie: sid });
	eq(await got.text(), "nihon", "GET 本文");
});

console.log("── GET / DELETE");
await t("ETag → If-None-Match で 304", async () => {
	const env = makeEnv(), sid = await mkUser(env);
	const { etag } = await (await put(env, sid, "e.geopbf", "data")).json();
	const r1 = await call(env, "/me/files/e.geopbf", { cookie: sid });
	eq(r1.status, 200, "初回 200");
	eq(r1.headers.get("ETag"), etag, "ETag 一致");
	eq(r1.headers.get("Content-Type"), "application/x-geopbf", "Content-Type 保存");
	const r2 = await call(env, "/me/files/e.geopbf", { cookie: sid, headers: { "If-None-Match": etag } });
	eq(r2.status, 304, "304");
});
await t("無いファイルは 404・DELETE は冪等 204", async () => {
	const env = makeEnv(), sid = await mkUser(env);
	eq((await call(env, "/me/files/nai.geopbf", { cookie: sid })).status, 404, "GET 404");
	await put(env, sid, "d.geopbf", "x");
	eq((await call(env, "/me/files/d.geopbf", { method: "DELETE", cookie: sid })).status, 204, "DELETE");
	eq(env.USER_BUCKET.store.size, 0, "R2 消えた");
	eq(env.DB._db.prepare("SELECT COUNT(*) n FROM files").get().n, 0, "D1 消えた");
	eq((await call(env, "/me/files/d.geopbf", { method: "DELETE", cookie: sid })).status, 204, "再 DELETE も 204");
});

console.log("── 認証・CSRF の門");
await t("★Cookie 無しの /me・/me/files・PUT は全て 401", async () => {
	const env = makeEnv();
	eq((await call(env, "/me")).status, 401, "/me");
	eq((await call(env, "/me/files")).status, 401, "/me/files");
	eq((await put(env, undefined, "a", "x")).status, 401, "PUT");
});
await t("★他人の sid では他人の領分しか見えない（キー分離）", async () => {
	const env = makeEnv();
	const sid1 = await mkUser(env, "u1"), sid2 = await mkUser(env, "u2");
	await put(env, sid1, "mine.geopbf", "secret");
	eq((await call(env, "/me/files/mine.geopbf", { cookie: sid2 })).status, 404, "u2 からは 404");
});
await t("★偽 Origin の PUT/DELETE は 403（GET は素通り）", async () => {
	const env = makeEnv(), sid = await mkUser(env);
	await put(env, sid, "a.geopbf", "x");
	eq((await put(env, sid, "b.geopbf", "x", { origin: "https://evil.com" })).status, 403, "PUT");
	eq((await call(env, "/me/files/a.geopbf", { method: "DELETE", cookie: sid, origin: "https://evil.com" })).status, 403, "DELETE");
	eq((await call(env, "/me/files/a.geopbf", { cookie: sid, origin: "https://evil.com" })).status, 200, "GET は通る");
});
await t("Origin ヘッダ無しの PUT も 403（フォーム以外の非GETに Origin は必ず付く）", async () => {
	const env = makeEnv(), sid = await mkUser(env);
	eq((await put(env, sid, "c.geopbf", "x", { origin: null })).status, 403, "status");
});

done();
