// OAuth フローの検定（デプロイ不要・グローバル fetch を差し替えて router を直に叩く）。
//   node apps/account/tests/t-auth.mjs
// 仕様の正本は workers/oauth.js・workers/index.js の冒頭コメント。ここは「そのとおりに閉まっているか」を数える。
import worker from "../workers/index.js";
import { makeEnv, t, eq, done } from "./shims.mjs";

const ORIGIN = "https://www.ortho-earth.com";

// 差し替え fetch：プロバイダの token/userinfo を演じ、呼び出しを記録する
let calls = [], routes = {};
globalThis.fetch = async (url, init = {}) => {
	calls.push({ url: String(url).split("?")[0], init });
	const r = routes[String(url).split("?")[0]];
	if (!r) return new Response("not stubbed", { status: 599 });
	return new Response(JSON.stringify(r), { status: 200, headers: { "Content-Type": "application/json" } });
};

const call = (env, path, { method = "GET", cookie, origin } = {}) => {
	const headers = new Headers();
	if (cookie) headers.set("Cookie", cookie);
	if (origin) headers.set("Origin", origin);
	return worker.fetch(new Request(`${ORIGIN}${path}`, { method, headers }), env);
};
const cookieOf = (res, base) =>
	res.headers.getSetCookie().find(c => c.startsWith(`__Host-${base}=`) && !c.includes("Max-Age=0"))?.split(";")[0];

// login → callback を一巡してセッション Cookie を返す
const github = { access: "https://github.com/login/oauth/access_token", user: "https://api.github.com/user" };
async function loginFlow(env, { provider = "github", ret = "/geoedit/", state } = {}) {
	const r1 = await call(env, `/auth/login/${provider}?return=${encodeURIComponent(ret)}`);
	const loc = new URL(r1.headers.get("Location"));
	const tx = cookieOf(r1, "oauth");
	const cb = await call(env, `/auth/callback/${provider}?code=CODE&state=${state ?? loc.searchParams.get("state")}`, { cookie: tx });
	return { r1, loc, tx, cb, sid: cookieOf(cb, "sid") };
}

console.log("── login リダイレクトの中身");
await t("github: 302・client_id・S256・redirect_uri・state", async () => {
	const env = makeEnv();
	const res = await call(env, "/auth/login/github?return=/geoedit/");
	eq(res.status, 302, "status");
	const loc = new URL(res.headers.get("Location"));
	eq(loc.origin + loc.pathname, "https://github.com/login/oauth/authorize", "authorize URL");
	eq(loc.searchParams.get("client_id"), "gh-id", "client_id");
	eq(loc.searchParams.get("code_challenge_method"), "S256", "PKCE method");
	eq(loc.searchParams.get("redirect_uri"), "https://www.ortho-earth.com/auth/callback/github", "redirect_uri");
	eq(!!loc.searchParams.get("state"), true, "state 有り");
	eq(!!loc.searchParams.get("code_challenge"), true, "challenge 有り");
});
await t("oauth Cookie の属性（__Host-・HttpOnly・Secure・Lax・Path=/・600秒）", async () => {
	const res = await call(makeEnv(), "/auth/login/github");
	const c = res.headers.getSetCookie()[0];
	for (const attr of ["__Host-oauth=", "HttpOnly", "Secure", "SameSite=Lax", "Path=/", "Max-Age=600"])
		eq(c.includes(attr), true, attr);
});
await t("google/x の authorize URL も正しい", async () => {
	for (const [p, host] of [["google", "accounts.google.com"], ["x", "x.com"]]) {
		const res = await call(makeEnv(), `/auth/login/${p}`);
		eq(new URL(res.headers.get("Location")).hostname, host, `${p} host`);
	}
});
await t("未知プロバイダは 404", async () =>
	eq((await call(makeEnv(), "/auth/login/facebook")).status, 404, "status"));
await t("secret 未投入のプロバイダも 404（X 保留中の門）", async () => {
	const env = makeEnv();
	delete env.X_CLIENT_ID;
	eq((await call(env, "/auth/login/x")).status, 404, "status");
});

console.log("── callback（github ハッピーパス）");
await t("302 で戻り・sid 発行・3表に行・verifier が token 便に載る", async () => {
	const env = makeEnv();
	routes = { [github.access]: { access_token: "TOK" },
	           [github.user]: { id: 123, login: "kenji", name: "Kenji", avatar_url: "https://a/i.png" } };
	calls = [];
	const { cb, sid } = await loginFlow(env);
	eq(cb.status, 302, "status");
	eq(cb.headers.get("Location"), "/geoedit/", "戻り先");
	eq(!!sid, true, "__Host-sid 発行");
	const tokCall = calls.find(c => c.url === github.access);
	eq(tokCall.init.body.includes("code_verifier="), true, "code_verifier 送信");
	eq(tokCall.init.body.includes("client_secret=gh-secret"), true, "client_secret 送信");
	eq(env.DB._db.prepare("SELECT COUNT(*) n FROM users").get().n, 1, "users");
	eq(env.DB._db.prepare("SELECT COUNT(*) n FROM identities").get().n, 1, "identities");
	eq(env.DB._db.prepare("SELECT COUNT(*) n FROM sessions").get().n, 1, "sessions");
	eq(env.DB._db.prepare("SELECT provider_uid FROM identities").get().provider_uid, "123", "uid は文字列");
});
await t("同じ provider_uid の再ログインで users は増えない", async () => {
	const env = makeEnv();
	await loginFlow(env); await loginFlow(env);
	eq(env.DB._db.prepare("SELECT COUNT(*) n FROM users").get().n, 1, "users");
	eq(env.DB._db.prepare("SELECT COUNT(*) n FROM sessions").get().n, 2, "sessions");
});

console.log("── callback の門");
await t("★state 不一致は 403・token 便ゼロ・セッションゼロ", async () => {
	const env = makeEnv(); calls = [];
	const { cb } = await loginFlow(env, { state: "WRONG" });
	eq(cb.status, 403, "status");
	eq(calls.some(c => c.url === github.access), false, "token 未呼出");
	eq(env.DB._db.prepare("SELECT COUNT(*) n FROM sessions").get().n, 0, "sessions");
});
await t("★oauth Cookie 無し（期限切れ）は 403", async () =>
	eq((await call(makeEnv(), "/auth/callback/github?code=C&state=S")).status, 403, "status"));
await t("★Cookie のプロバイダと callback パスの不一致は 403", async () => {
	const env = makeEnv();
	const r1 = await call(env, "/auth/login/github");
	const st = new URL(r1.headers.get("Location")).searchParams.get("state");
	const cb = await call(env, `/auth/callback/google?code=C&state=${st}`, { cookie: cookieOf(r1, "oauth") });
	eq(cb.status, 403, "status");
});
await t("同意キャンセル（?error=）はエラーページでなく ?login=denied で戻す", async () => {
	const env = makeEnv();
	const r1 = await call(env, "/auth/login/github?return=/geoedit/");
	const cb = await call(env, "/auth/callback/github?error=access_denied", { cookie: cookieOf(r1, "oauth") });
	eq(cb.status, 302, "status");
	eq(cb.headers.get("Location"), "/geoedit/?login=denied", "Location");
});
await t("★return=//evil.com と絶対URLは /geoedit/ へフォールバック", async () => {
	for (const bad of ["//evil.com", "https://evil.com/x"]) {
		const { cb } = await loginFlow(makeEnv(), { ret: bad });
		eq(cb.headers.get("Location"), "/geoedit/", `return=${bad}`);
	}
});

console.log("── X の差分");
await t("token は Basic 認証・uid=data.id・email は NULL", async () => {
	const env = makeEnv();
	routes = { "https://api.x.com/2/oauth2/token": { access_token: "XT" },
	           "https://api.x.com/2/users/me": { data: { id: "999", username: "kx", name: "KX" } } };
	calls = [];
	const { cb } = await loginFlow(env, { provider: "x" });
	eq(cb.status, 302, "status");
	const tok = calls.find(c => c.url === "https://api.x.com/2/oauth2/token");
	eq(tok.init.headers.Authorization, `Basic ${btoa("x-id:x-secret")}`, "Basic");
	eq(tok.init.body.includes("client_secret="), false, "body に secret を入れない");
	const idy = env.DB._db.prepare("SELECT provider_uid, email FROM identities WHERE provider='x'").get();
	eq(idy.provider_uid, "999", "uid");
	eq(idy.email, null, "email NULL");
	routes = { [github.access]: { access_token: "TOK" }, [github.user]: { id: 123, login: "kenji" } };
});

console.log("── セッションと logout");
await t("有効 sid で /me は 200・でたらめ sid は 401", async () => {
	const env = makeEnv();
	const { sid } = await loginFlow(env);
	eq((await call(env, "/me", { cookie: sid })).status, 200, "有効");
	eq((await call(env, "/me", { cookie: "__Host-sid=garbage" })).status, 401, "でたらめ");
	eq((await call(env, "/me")).status, 401, "Cookie 無し");
});
await t("★期限切れセッションは 401", async () => {
	const env = makeEnv();
	const { sid } = await loginFlow(env);
	env.DB._db.exec("UPDATE sessions SET expires_at = 1");
	eq((await call(env, "/me", { cookie: sid })).status, 401, "status");
});
await t("logout は 204＋行削除・Origin 不一致は 403 でセッション生存", async () => {
	const env = makeEnv();
	const { sid } = await loginFlow(env);
	eq((await call(env, "/auth/logout", { method: "POST", cookie: sid, origin: "https://evil.com" })).status, 403, "偽 Origin");
	eq((await call(env, "/me", { cookie: sid })).status, 200, "まだ生きている");
	eq((await call(env, "/auth/logout", { method: "POST", cookie: sid, origin: ORIGIN })).status, 204, "正規 logout");
	eq(env.DB._db.prepare("SELECT COUNT(*) n FROM sessions").get().n, 0, "行削除");
	eq((await call(env, "/me", { cookie: sid })).status, 401, "以後 401");
});
await t("日和見GC：ログイン時に期限切れ行が掃除される", async () => {
	const env = makeEnv();
	await loginFlow(env);
	env.DB._db.exec("UPDATE sessions SET expires_at = 1");
	await loginFlow(env);
	eq(env.DB._db.prepare("SELECT COUNT(*) n FROM sessions").get().n, 1, "生存は新しい1本のみ");
});

done();
