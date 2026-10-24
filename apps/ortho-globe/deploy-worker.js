// ortho-globe の配信口（Workers assets の前段・run_worker_first）。
// ①全レスポンスに COOP/COEP（credentialless）を刻む＝dev の vite と同条件（gint の SharedArrayBuffer の点火条件。無くてもコピー経路で動く）
// ②/globe（末尾スラッシュなし）→ /globe/
// 共有エンジン（/globe/engine/*）はここを通らない＝独立の Worker ortho-engine（apps/engine・route がより specific・2026-10-15〜）。
const COI = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "credentialless",
	"X-Content-Type-Options": "nosniff", "Referrer-Policy": "strict-origin-when-cross-origin" };   // 後の 2 本＝型を推測させない・外部へ query を漏らさない（2026-10-24 監査）
export default {
	async fetch(req, env) {
		const url = new URL(req.url);
		if (url.pathname === "/globe") return Response.redirect(url.origin + "/globe/" + url.search, 301);
		const res = await env.ASSETS.fetch(req);
		const h = new Headers(res.headers);
		for (const [k, v] of Object.entries(COI)) h.set(k, v);
		return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
	},
};
