// ortho-globe の配信口（Workers assets の前段・run_worker_first）。
// ①全レスポンスに COOP/COEP（credentialless）を刻む＝dev の vite と同条件（gint の SharedArrayBuffer の点火条件。無くてもコピー経路で動く）
// ②/globe（末尾スラッシュなし）→ /globe/
export default {
	async fetch(req, env) {
		const url = new URL(req.url);
		if (url.pathname === "/globe") return Response.redirect(url.origin + "/globe/" + url.search, 301);
		const res = await env.ASSETS.fetch(req);
		const h = new Headers(res.headers);
		h.set("Cross-Origin-Opener-Policy", "same-origin");
		h.set("Cross-Origin-Embedder-Policy", "credentialless");
		return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
	},
};
