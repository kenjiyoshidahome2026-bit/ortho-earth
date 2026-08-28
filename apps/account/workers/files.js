// ユーザー別ファイル置き場：R2 キー u/{userId}/{name}・台帳と使用量は D1 の files 表（一覧とクォータを O(1) に）。
// body はストリームで R2 へ直結（workerd が Content-Length から既知長を付ける＝Worker でバッファしない）。
// 既知の制限：Cloudflare のゾーン body 上限（Free/Pro=100MB）超は Worker 到達前に弾かれる＝multipart 化は将来課題。
import { err, json } from "./http.js";
import { requireUser, now } from "./session.js";

const MAX_FILE_BYTES = 200 * 1024 * 1024;
const MAX_BYTES = 1024 ** 3;   // 1 GiB / ユーザー
const MAX_FILES = 100;
const MAX_NAME = 100;

// R2 キーに入る表示名：/ と \ と制御文字を禁止＝キー u/{uid}/{name} の traversal が構造的に不能
const validName = enc => {
	let name; try { name = decodeURIComponent(enc); } catch { return null; }
	if (!name || name.length > MAX_NAME) return null;
	if (/[/\\\x00-\x1f\x7f]/.test(name)) return null;
	if (name === "." || name === "..") return null;
	return name;
};
const key = (uid, name) => `u/${uid}/${name}`;

export async function me(req, env) {
	const user = await requireUser(req, env);
	if (!user) return err(401, "unauthorized", "login required");
	const u = await env.DB.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(size),0) AS bytes FROM files WHERE user_id=?")
		.bind(user.id).first();
	return json({
		user: { id: user.id, name: user.name, avatar_url: user.avatar_url },
		usage: { files: u.n, bytes: u.bytes, maxFiles: MAX_FILES, maxBytes: MAX_BYTES, maxFileBytes: MAX_FILE_BYTES },
	});
}

export async function filesList(req, env) {
	const user = await requireUser(req, env);
	if (!user) return err(401, "unauthorized", "login required");
	const { results } = await env.DB.prepare(
		"SELECT name,size,updated_at FROM files WHERE user_id=? ORDER BY updated_at DESC").bind(user.id).all();
	return json({ files: results });
}

export async function filePut(req, env, encName) {
	const user = await requireUser(req, env);
	if (!user) return err(401, "unauthorized", "login required");
	const name = validName(encName);
	if (!name) return err(400, "bad_request", "invalid file name");
	const lenHeader = req.headers.get("Content-Length");
	if (lenHeader == null) return err(411, "length_required", "Content-Length required");
	const len = Number(lenHeader);
	if (!Number.isFinite(len) || len < 0) return err(400, "bad_request", "bad Content-Length");
	if (len > MAX_FILE_BYTES) return err(413, "file_too_large", `max ${MAX_FILE_BYTES} bytes per file`);
	// クォータは1クエリで判定（check→put の TOCTOU は1人1アカウント前提で許容）
	// 無名 ? のみを使う（?1/?2 の番号付きはテストシムの node:sqlite が受け付けない＝出現順で渡す）
	const q = await env.DB.prepare(
		`SELECT COALESCE(SUM(size),0) AS total, COUNT(*) AS n,
		        COALESCE(SUM(CASE WHEN name=? THEN size END),0) AS cur,
		        COUNT(CASE WHEN name=? THEN 1 END) AS hit
		   FROM files WHERE user_id=?`).bind(name, name, user.id).first();
	if (q.total - q.cur + len > MAX_BYTES) return err(413, "quota_exceeded", `max ${MAX_BYTES} bytes total`);
	if (!q.hit && q.n >= MAX_FILES) return err(413, "too_many_files", `max ${MAX_FILES} files`);
	const obj = await env.USER_BUCKET.put(key(user.id, name), req.body, {
		httpMetadata: { contentType: req.headers.get("Content-Type") || "application/octet-stream" },
	});
	const size = obj?.size ?? len;
	await env.DB.prepare(
		`INSERT INTO files(user_id,name,size,updated_at) VALUES(?,?,?,?)
		   ON CONFLICT(user_id,name) DO UPDATE SET size=excluded.size, updated_at=excluded.updated_at`)
		.bind(user.id, name, size, now()).run();
	return json({ name, size, etag: obj?.httpEtag || null });
}

export async function fileGet(req, env, encName) {
	const user = await requireUser(req, env);
	if (!user) return err(401, "unauthorized", "login required");
	const name = validName(encName);
	if (!name) return err(400, "bad_request", "invalid file name");
	// If-None-Match / If-Modified-Since は R2 の onlyIf に丸投げ（一致時は body 無しで返る＝304）
	const obj = await env.USER_BUCKET.get(key(user.id, name), { onlyIf: req.headers });
	if (!obj) return err(404, "not_found", "no such file");
	const h = new Headers({ ETag: obj.httpEtag, "Cache-Control": "private, no-cache" });
	obj.writeHttpMetadata?.(h);
	if (!obj.body) return new Response(null, { status: 304, headers: h });
	h.set("Content-Length", String(obj.size));
	return new Response(obj.body, { status: 200, headers: h });
}

export async function fileDel(req, env, encName) {
	const user = await requireUser(req, env);
	if (!user) return err(401, "unauthorized", "login required");
	const name = validName(encName);
	if (!name) return err(400, "bad_request", "invalid file name");
	await env.USER_BUCKET.delete(key(user.id, name));
	await env.DB.prepare("DELETE FROM files WHERE user_id=? AND name=?").bind(user.id, name).run();
	return new Response(null, { status: 204 });   // 無くても 204（冪等）
}
