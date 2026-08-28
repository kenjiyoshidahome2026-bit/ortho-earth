// /me/works（公開台帳の管理）・/works/*（公開面）の検定（デプロイ不要・router を直に叩く）。
//   node apps/account/tests/t-works.mjs
// 仕様の正本は workers/works.js の冒頭コメント。
import worker from "../workers/index.js";
import { createSession } from "../workers/session.js";
import { makeEnv, t, eq, done } from "./shims.mjs";

const ORIGIN = "https://www.ortho-earth.com";

async function mkUser(env, uid = "u1", name = "Kenji") {
	env.DB._db.prepare("INSERT INTO users(id,created_at,name,avatar_url) VALUES(?,?,?,?)").run(uid, 0, name, null);
	return `__Host-sid=${await createSession(env, uid, "test")}`;
}
const call = (env, path, { method = "GET", cookie, origin, headers = {}, body } = {}) => {
	const h = new Headers(headers);
	if (cookie) h.set("Cookie", cookie);
	if (origin !== null) h.set("Origin", origin ?? ORIGIN);
	return worker.fetch(new Request(`${ORIGIN}${path}`, { method, headers: h, body }), env);
};
const post = (env, cookie, body, opts = {}) =>
	call(env, "/me/works", { method: "POST", cookie, body: JSON.stringify(body),
		headers: { "Content-Type": "application/json" }, origin: opts.origin });
const GOOD = { title: "東京の台地", url: "gh:kenji/maps/tokyo.geopbf" };

console.log("── 公開 正常系");
await t("公開 → 行・一覧・公開カタログに載る（author 既定＝表示名）", async () => {
	const env = makeEnv(), sid = await mkUser(env);
	const res = await post(env, sid, { ...GOOD, summary: "山の手の凸凹", view: "#c=std&l=anno" });
	eq(res.status, 200, "status");
	const { id, updated } = await res.json();
	eq(updated, false, "updated");
	eq(!!id, true, "id");
	const mine = await (await call(env, "/me/works", { cookie: sid })).json();
	eq(mine.works.length, 1, "自分の一覧");
	eq(mine.works[0].author, "Kenji", "author 既定");
	const cat = await (await call(env, "/works/catalog.json", { cookie: null, origin: null })).json();   // 公開面＝未ログイン
	eq(cat.works.length, 1, "カタログ");
	eq(cat.works[0].title, "東京の台地", "カタログ題名");
	eq(cat.works[0].thumb, false, "サムネ無し");
});
await t("同一URL再公開＝上書き更新（行は増えない）", async () => {
	const env = makeEnv(), sid = await mkUser(env);
	await post(env, sid, GOOD);
	const res = await post(env, sid, { ...GOOD, title: "改題" });
	eq((await res.json()).updated, true, "updated");
	const mine = await (await call(env, "/me/works", { cookie: sid })).json();
	eq(mine.works.length, 1, "行数");
	eq(mine.works[0].title, "改題", "題名更新");
});
await t("https 完全形も可・制御文字入り題名は除去", async () => {
	const env = makeEnv(), sid = await mkUser(env);
	const res = await post(env, sid, { title: "a\x01b", url: "https://raw.githubusercontent.com/k/m/HEAD/x.geopbf" });
	eq(res.status, 200, "status");
	const mine = await (await call(env, "/me/works", { cookie: sid })).json();
	eq(mine.works[0].title, "ab", "制御文字除去");
});

console.log("── 公開 異常系");
await t("http URL・gh: の .. セグメント・題名欠落は 400", async () => {
	const env = makeEnv(), sid = await mkUser(env);
	eq((await post(env, sid, { title: "t", url: "http://example.com/x" })).status, 400, "http");
	eq((await post(env, sid, { title: "t", url: "gh:a/../b/x" })).status, 400, "gh ..");
	eq((await post(env, sid, { url: GOOD.url })).status, 400, "題名なし");
});
await t("未ログイン 401・Origin 不一致 403", async () => {
	const env = makeEnv();
	eq((await post(env, undefined, GOOD)).status, 401, "未ログイン");
	const sid = await mkUser(env);
	eq((await post(env, sid, GOOD, { origin: "https://evil.example" })).status, 403, "Origin");
});
await t("上限：50件で 413・1日20件で 429", async () => {
	const env = makeEnv(), sid = await mkUser(env);
	const ins = env.DB._db.prepare("INSERT INTO works(id,user_id,title,url,author,thumb,created_at,updated_at) VALUES(?,?,?,?,?,0,?,?)");
	for (let i = 0; i < 20; i++) ins.run(`w${i}`, "u1", "t", `https://e.com/${i}`, "a", Math.floor(Date.now() / 1000), 0);   // 直近20件
	eq((await post(env, sid, GOOD)).status, 429, "日次上限");
	for (let i = 20; i < 50; i++) ins.run(`w${i}`, "u1", "t", `https://e.com/${i}`, "a", 0, 0);   // 古い30件を足して計50
	eq((await post(env, sid, GOOD)).status, 413, "総数上限");
});

console.log("── 更新・削除・他人の壁");
await t("更新は自分のみ・他人の id は 404", async () => {
	const env = makeEnv(), sid = await mkUser(env);
	const { id } = await (await post(env, sid, GOOD)).json();
	const up = await call(env, `/me/works/${id}`, { method: "PUT", cookie: sid,
		body: JSON.stringify({ title: "新題" }), headers: { "Content-Type": "application/json" } });
	eq(up.status, 200, "更新");
	const sid2 = await mkUser(env, "u2", "Other");
	const forbidden = await call(env, `/me/works/${id}`, { method: "PUT", cookie: sid2,
		body: JSON.stringify({ title: "乗っ取り" }), headers: { "Content-Type": "application/json" } });
	eq(forbidden.status, 404, "他人");
	const del = await call(env, `/me/works/${id}`, { method: "DELETE", cookie: sid });
	eq(del.status, 200, "削除");
	const cat = await (await call(env, "/works/catalog.json", { cookie: null, origin: null })).json();
	eq(cat.works.length, 0, "カタログから消える");
});

console.log("── サムネ");
await t("png 保存→公開GET（未ログイン・nosniff）・svg は 415・過大は 413", async () => {
	const env = makeEnv(), sid = await mkUser(env);
	const { id } = await (await post(env, sid, GOOD)).json();
	const putT = (type, body, len) => call(env, `/me/works/${id}/thumb`, { method: "PUT", cookie: sid, body,
		headers: { "Content-Type": type, "Content-Length": String(len ?? body.length) } });
	eq((await putT("image/svg+xml", "<svg/>")).status, 415, "svg");
	eq((await putT("image/png", "x", 999999999)).status, 413, "過大");
	eq((await putT("image/png", "PNGDATA")).status, 200, "保存");
	const mine = await (await call(env, "/me/works", { cookie: sid })).json();
	eq(mine.works[0].thumb, true, "thumb フラグ");
	const pub = await call(env, `/works/thumb/${id}`, { cookie: null, origin: null });
	eq(pub.status, 200, "公開GET");
	eq(pub.headers.get("Content-Type"), "image/png", "型");
	eq(pub.headers.get("X-Content-Type-Options"), "nosniff", "nosniff");
	eq(await pub.text(), "PNGDATA", "中身");
	await call(env, `/me/works/${id}`, { method: "DELETE", cookie: sid });
	eq(env.USER_BUCKET.store.has(`w/${id}`), false, "削除でサムネも消える");
});
done();
