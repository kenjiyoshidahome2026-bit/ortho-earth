// geoedit 配信 Worker：静的アセット（dist/site）に COOP/COEP を刻んで返すだけの薄い皮（census2020 と同型）。
// この2ヘッダ＝crossOriginIsolated＝SharedArrayBuffer（gint バッファを worker へゼロコピーで渡す）の点火条件。
// ★必須ではない（2026-08-19 実測）：無ければ geopbf setGintBUF が通常 ArrayBuffer へ落ち、コピー1回で同じ結果。
export default {
	async fetch(req, env) {
		const url = new URL(req.url);
		if (url.pathname === "/geoedit") return Response.redirect(url.origin + "/geoedit/" + url.search, 301);   // 裸パス＝正規の末尾スラッシュへ
		const res = await env.ASSETS.fetch(req);
		const h = new Headers(res.headers);
		h.set("Cross-Origin-Opener-Policy", "same-origin");
		h.set("Cross-Origin-Embedder-Policy", "credentialless");
		return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
	},
};
