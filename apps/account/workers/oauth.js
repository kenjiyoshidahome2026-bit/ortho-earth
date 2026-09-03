// OAuth 認可コードフロー（state + PKCE S256）。3社共通の1経路＝差分は providers.js の設定のみ。
// 中間状態（provider/state/verifier/戻り先）は署名不要の HttpOnly Cookie（__Host-oauth, 10分）に持つ：
// 値は本人のブラウザにしか無く、callback で state を突き合わせる＝改竄しても自分のログインが壊れるだけ。
import { PROVIDERS } from "./providers.js";
import { b64url, randB64, setCookie, getCookie, createSession, destroySession, now, SESSION_DAYS } from "./session.js";
import { err } from "./http.js";

const RETURN_FALLBACK = "/japan/geoedit";
// open redirect 封じ：同一オリジンの相対パスのみ（"/" 始まり・"//" と "\" と制御文字は不可）
const validReturn = r => (r && /^\/(?!\/)/.test(r) && !/[\\\x00-\x1f]/.test(r)) ? r : RETURN_FALLBACK;

const challengeS256 = async v =>
	b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v))));

const encTx = obj => b64url(new TextEncoder().encode(JSON.stringify(obj)));
const decTx = s => {
	try {
		const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - s.length % 4) % 4));
		return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))));
	} catch { return null; }
};

const redirect = (location, ...cookies) => {
	const h = new Headers({ Location: location });
	for (const c of cookies) h.append("Set-Cookie", c);
	return new Response(null, { status: 302, headers: h });
};

export async function login(req, env, provider) {
	const P = PROVIDERS[provider];
	if (!P) return err(404, "not_found", `unknown provider: ${provider}`);
	if (!P.creds(env)[0]) return err(404, "not_found", `provider not configured: ${provider}`);   // secret 未投入＝未開通（X は従量課金化で保留中）
	const state = randB64(16), verifier = randB64(32);
	const ret = validReturn(new URL(req.url).searchParams.get("return"));
	const auth = new URL(P.authorize);
	auth.searchParams.set("client_id", P.creds(env)[0]);
	auth.searchParams.set("redirect_uri", `${env.BASE_URL}/auth/callback/${provider}`);
	auth.searchParams.set("response_type", "code");
	auth.searchParams.set("scope", P.scope);
	auth.searchParams.set("state", state);
	auth.searchParams.set("code_challenge", await challengeS256(verifier));
	auth.searchParams.set("code_challenge_method", "S256");   // 3社全部に送る（github は無害に無視・x は必須）
	return redirect(auth.toString(), setCookie(env, "oauth", encTx({ p: provider, s: state, v: verifier, r: ret }), 600));
}

export async function callback(req, env, provider) {
	const P = PROVIDERS[provider];
	if (!P) return err(404, "not_found", `unknown provider: ${provider}`);
	const url = new URL(req.url);
	const tx = decTx(getCookie(req, env, "oauth") || "");
	const clearTx = setCookie(env, "oauth", "", 0);
	if (!tx || tx.p !== provider) return err(403, "forbidden", "login flow expired — start again");
	if (url.searchParams.get("error"))   // 同意画面でキャンセル＝エラーページにせず戻す
		return redirect(`${tx.r}${tx.r.includes("?") ? "&" : "?"}login=denied`, clearTx);
	const code = url.searchParams.get("code"), state = url.searchParams.get("state");
	if (!code || !state || state !== tx.s) return err(403, "forbidden", "state mismatch");

	// code → access_token
	const [cid, secret] = P.creds(env);
	const body = new URLSearchParams({
		grant_type: "authorization_code", code,
		redirect_uri: `${env.BASE_URL}/auth/callback/${provider}`, code_verifier: tx.v,
	});
	const headers = { "Content-Type": "application/x-www-form-urlencoded", ...(P.tokenHeaders || {}) };
	if (P.clientAuth === "basic") headers.Authorization = `Basic ${btoa(`${cid}:${secret}`)}`;
	else { body.set("client_id", cid); body.set("client_secret", secret); }
	const tokRes = await fetch(P.token, { method: "POST", headers, body: body.toString() });
	const tok = tokRes.ok ? await tokRes.json().catch(() => null) : null;
	if (!tok?.access_token) return err(502, "provider_error", `token exchange failed (${provider}: HTTP ${tokRes.status})`);

	// access_token → プロフィール
	const uRes = await fetch(P.userinfo, { headers: P.userHeaders(tok.access_token) });
	if (!uRes.ok) return err(502, "provider_error", `userinfo failed (${provider}: HTTP ${uRes.status})`);
	const prof = P.map(await uRes.json());
	if (!prof.uid) return err(502, "provider_error", `no uid in ${provider} profile`);

	// upsert（identity キーが正・メール名寄せはしない）
	const t = now();
	const hit = await env.DB.prepare("SELECT user_id FROM identities WHERE provider=? AND provider_uid=?")
		.bind(provider, prof.uid).first();
	let userId = hit?.user_id;
	if (!userId) {
		userId = crypto.randomUUID();
		await env.DB.batch([
			env.DB.prepare("INSERT INTO users(id,created_at,name,avatar_url) VALUES(?,?,?,?)")
				.bind(userId, t, prof.name, prof.avatar),
			env.DB.prepare("INSERT INTO identities(provider,provider_uid,user_id,email,profile_json) VALUES(?,?,?,?,?)")
				.bind(provider, prof.uid, userId, prof.email, JSON.stringify(prof)),
		]);
	} else {
		await env.DB.batch([
			env.DB.prepare("UPDATE identities SET email=?, profile_json=? WHERE provider=? AND provider_uid=?")
				.bind(prof.email, JSON.stringify(prof), provider, prof.uid),
			env.DB.prepare("UPDATE users SET name=?, avatar_url=? WHERE id=?").bind(prof.name, prof.avatar, userId),
		]);
	}
	const sid = await createSession(env, userId, req.headers.get("User-Agent"));
	return redirect(tx.r, setCookie(env, "sid", sid, SESSION_DAYS * 86400), clearTx);
}

export async function logout(req, env) {
	await destroySession(req, env);   // Cookie 無しでも 204（冪等）
	return new Response(null, { status: 204, headers: { "Set-Cookie": setCookie(env, "sid", "", 0) } });
}
