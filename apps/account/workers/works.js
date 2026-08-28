// 公開台帳：作品（URL で公開された GeoPBF 地図）のポインタ台帳。データ本体は預からない＝
// 本人の GitHub 等に置かれた URL と、題名・作者・初期視点・サムネだけを持つ（非所有の謙譲）。
// 台帳自体も囲い込まない＝GET /works/catalog.json は誰でも読める公開 JSON。
// メタ文字列はここでは制御文字除去+長さ上限のみで HTML 消毒はしない＝**表示側が textContent で
// 扱うことが契約**（docs/geopbf §11 と同じ「出力境界で消毒」の定石。innerHTML に入れるな）。
// サムネは画像ラスタ3種のみ（SVG は script を運べるので不可）・公開配信は nosniff 付き。
import { err, json } from "./http.js";
import { requireUser, now } from "./session.js";

const MAX_WORKS = 50;            // 1ユーザーの台帳行上限
const DAY_LIMIT = 20;            // 1日の新規公開上限（スパム洪水よけ）
const MAX_THUMB = 512 * 1024;    // サムネ上限
const THUMB_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const CATALOG_LIMIT = 1000;

const clean = (s, max) => {   // 制御文字を除去して trim・空/超過は null（＝拒否 or 未指定扱い）
	if (typeof s !== "string") return null;
	s = s.replace(/[\x00-\x1f\x7f]/g, "").trim();
	return s && s.length <= max ? s : null;
};
// 公開URL：https 完全形か gh:user/repo[@ref]/path 短縮形（ビューア ?g= と同じ文法・".."セグメント拒否）
function validUrl(u) {
	if (typeof u !== "string" || u.length > 500 || /[\x00-\x1f\x7f\s]/.test(u)) return null;
	const gh = /^gh:([\w.-]+)\/([\w.-]+)(?:@([\w.-]+))?\/(.+)$/.exec(u);
	if (gh) return [gh[1], gh[2], gh[3] || "", ...gh[4].split("/")].some(x => x === "." || x === "..") ? null : u;
	try { const p = new URL(u); return (p.protocol === "https:" && p.hostname.includes(".")) ? u : null; } catch { return null; }
}
const rowOut = w => ({ id: w.id, title: w.title, url: w.url, author: w.author, view: w.view, summary: w.summary, thumb: !!w.thumb, updated_at: w.updated_at });

export async function worksList(req, env) {
	const user = await requireUser(req, env);
	if (!user) return err(401, "unauthorized", "login required");
	const { results } = await env.DB.prepare(
		"SELECT * FROM works WHERE user_id=? ORDER BY updated_at DESC").bind(user.id).all();
	return json({ works: results.map(rowOut), maxWorks: MAX_WORKS });
}

export async function workPost(req, env) {
	const user = await requireUser(req, env);
	if (!user) return err(401, "unauthorized", "login required");
	const b = await req.json().catch(() => null);
	if (!b) return err(400, "bad_request", "json body required");
	const url = validUrl(b.url);
	if (!url) return err(400, "bad_url", "url must be https or gh:user/repo/path");
	const title = clean(b.title, 80);
	if (!title) return err(400, "bad_request", "title required (≤80 chars)");
	const author = clean(b.author, 50) ?? clean(user.name, 50);
	const view = clean(b.view, 500);
	const summary = clean(b.summary, 200);
	const hit = await env.DB.prepare("SELECT * FROM works WHERE user_id=? AND url=?").bind(user.id, url).first();
	if (hit) {   // 同一URLの再公開＝上書き更新（行は増やさない・レート勘定にも入れない）
		await env.DB.prepare("UPDATE works SET title=?, author=?, view=?, summary=?, updated_at=? WHERE id=?")
			.bind(title, author, view, summary, now(), hit.id).run();
		return json({ id: hit.id, updated: true });
	}
	const q = await env.DB.prepare(
		"SELECT COUNT(*) AS n, COUNT(CASE WHEN created_at>? THEN 1 END) AS today FROM works WHERE user_id=?")
		.bind(now() - 86400, user.id).first();
	if (q.n >= MAX_WORKS) return err(413, "too_many_works", `max ${MAX_WORKS} works`);
	if (q.today >= DAY_LIMIT) return err(429, "rate_limited", `max ${DAY_LIMIT} publishes per day`);
	const id = crypto.randomUUID();
	await env.DB.prepare(
		"INSERT INTO works(id,user_id,title,url,author,view,summary,thumb,created_at,updated_at) VALUES(?,?,?,?,?,?,?,0,?,?)")
		.bind(id, user.id, title, url, author, view, summary, now(), now()).run();
	return json({ id, updated: false });
}

export async function workPut(req, env, id) {
	const user = await requireUser(req, env);
	if (!user) return err(401, "unauthorized", "login required");
	const hit = await env.DB.prepare("SELECT * FROM works WHERE id=? AND user_id=?").bind(id, user.id).first();
	if (!hit) return err(404, "not_found", "no such work");
	const b = await req.json().catch(() => null);
	if (!b) return err(400, "bad_request", "json body required");
	const url = b.url === undefined ? hit.url : validUrl(b.url);
	if (!url) return err(400, "bad_url", "url must be https or gh:user/repo/path");
	const title = b.title === undefined ? hit.title : clean(b.title, 80);
	if (!title) return err(400, "bad_request", "title required (≤80 chars)");
	const author = b.author === undefined ? hit.author : clean(b.author, 50);
	const view = b.view === undefined ? hit.view : clean(b.view, 500);
	const summary = b.summary === undefined ? hit.summary : clean(b.summary, 200);
	await env.DB.prepare("UPDATE works SET title=?, url=?, author=?, view=?, summary=?, updated_at=? WHERE id=?")
		.bind(title, url, author, view, summary, now(), id).run();
	return json({ id });
}

export async function workDel(req, env, id) {
	const user = await requireUser(req, env);
	if (!user) return err(401, "unauthorized", "login required");
	const hit = await env.DB.prepare("SELECT id FROM works WHERE id=? AND user_id=?").bind(id, user.id).first();
	if (!hit) return err(404, "not_found", "no such work");
	await env.DB.prepare("DELETE FROM works WHERE id=?").bind(id).run();
	await env.USER_BUCKET.delete(`w/${id}`);
	return json({ ok: true });
}

export async function thumbPut(req, env, id) {
	const user = await requireUser(req, env);
	if (!user) return err(401, "unauthorized", "login required");
	const hit = await env.DB.prepare("SELECT id FROM works WHERE id=? AND user_id=?").bind(id, user.id).first();
	if (!hit) return err(404, "not_found", "no such work");
	const type = (req.headers.get("Content-Type") || "").split(";")[0].trim();
	if (!THUMB_TYPES.has(type)) return err(415, "bad_type", "png/jpeg/webp only");
	const len = Number(req.headers.get("Content-Length"));
	if (!Number.isFinite(len) || len <= 0) return err(411, "length_required", "Content-Length required");
	if (len > MAX_THUMB) return err(413, "thumb_too_large", `max ${MAX_THUMB} bytes`);
	await env.USER_BUCKET.put(`w/${id}`, req.body, { httpMetadata: { contentType: type } });
	await env.DB.prepare("UPDATE works SET thumb=1, updated_at=? WHERE id=?").bind(now(), id).run();
	return json({ ok: true });
}

// ---- 公開面（ログイン不要）----
export async function catalog(req, env) {
	const { results } = await env.DB.prepare(
		`SELECT id,title,url,author,view,summary,thumb,updated_at FROM works ORDER BY updated_at DESC LIMIT ${CATALOG_LIMIT}`).all();
	return json({ works: results.map(rowOut), generated_at: now() },
		200, { "Cache-Control": "public, max-age=300" });   // 台帳は開かれている＝誰でも・キャッシュ可
}

export async function thumbGet(req, env, id) {
	const obj = await env.USER_BUCKET.get(`w/${id}`, { onlyIf: req.headers });
	if (!obj) return err(404, "not_found", "no thumbnail");
	const h = new Headers({
		ETag: obj.httpEtag, "Cache-Control": "public, max-age=3600",
		"X-Content-Type-Options": "nosniff",   // 型は保存時に画像3種へ限定済み＝それでも嗅がせない
	});
	obj.writeHttpMetadata?.(h);
	return new Response(obj.body, { status: obj.body ? 200 : 304, headers: h });
}
