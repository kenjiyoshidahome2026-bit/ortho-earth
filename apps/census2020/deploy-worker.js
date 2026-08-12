// census2020 配信 Worker：静的アセット（dist/site）に COOP/COEP を刻んで返すだけの薄い皮（ortho-nl と同型）。
// SharedArrayBuffer（gint）には crossOriginIsolated が必須＝この2ヘッダが無いと worker 全滅→黒画面。
// dev（vite.config.js の middleware）と同一条件を本番にも刻む＝環境差ゼロ。
export default {
	async fetch(req, env) {
		const url = new URL(req.url);
		if (url.pathname === "/census2020") return Response.redirect(url.origin + "/census2020/", 301);   // 裸パス＝正規の末尾スラッシュへ
		const res = await env.ASSETS.fetch(req);
		const h = new Headers(res.headers);
		h.set("Cross-Origin-Opener-Policy", "same-origin");
		h.set("Cross-Origin-Embedder-Policy", "credentialless");
		return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
	},
};
