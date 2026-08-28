// セッション：Cookie には生 sid（32byte 乱数→base64url）、D1 には SHA-256 hex のみ（漏洩したDBだけでは成り済ませない）。
// 本番 Cookie は __Host- 接頭辞（Secure・Path=/・Domain 無しをブラウザが強制）。DEV=1（http の wrangler dev）では素の名前・Secure 無し。

export const b64url = bytes =>
	btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const randB64 = n => b64url(crypto.getRandomValues(new Uint8Array(n)));
export const sha256hex = async s =>
	[...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))]
		.map(b => b.toString(16).padStart(2, "0")).join("");

export const cookieName = (env, base) => env.DEV ? base : `__Host-${base}`;
export const setCookie = (env, base, value, maxAge) =>
	`${cookieName(env, base)}=${value}; HttpOnly; ${env.DEV ? "" : "Secure; "}SameSite=Lax; Path=/; Max-Age=${maxAge}`;
export const getCookie = (req, env, base) => {
	const name = cookieName(env, base);
	for (const part of (req.headers.get("Cookie") || "").split(/;\s*/)) {
		const i = part.indexOf("=");
		if (i > 0 && part.slice(0, i) === name) return part.slice(i + 1);
	}
	return null;
};

export const now = () => Math.floor(Date.now() / 1000);
export const SESSION_DAYS = 30;   // 固定期限＝期限切れは再ログイン（スライド更新は将来課題）

export async function createSession(env, userId, ua) {
	const sid = randB64(32), t = now();
	await env.DB.batch([
		env.DB.prepare("INSERT INTO sessions(sid_hash,user_id,created_at,expires_at,ua) VALUES(?,?,?,?,?)")
			.bind(await sha256hex(sid), userId, t, t + SESSION_DAYS * 86400, ua || null),
		env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(t),   // 日和見GC（ログイン時だけで十分・cron 不要）
	]);
	return sid;
}

// Cookie → ユーザー行（{id, name, avatar_url}）。無効/期限切れは null
export async function requireUser(req, env) {
	const sid = getCookie(req, env, "sid");
	if (!sid) return null;
	return await env.DB.prepare(
		"SELECT u.id, u.name, u.avatar_url FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.sid_hash = ? AND s.expires_at > ?")
		.bind(await sha256hex(sid), now()).first();
}

export async function destroySession(req, env) {
	const sid = getCookie(req, env, "sid");
	if (sid) await env.DB.prepare("DELETE FROM sessions WHERE sid_hash = ?").bind(await sha256hex(sid)).run();
}
