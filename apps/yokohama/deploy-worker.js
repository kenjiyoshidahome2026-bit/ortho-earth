// yokohama 配信 Worker：静的アセット（dist/site）に COOP/COEP を刻んで返すだけの薄い皮（choju と同型）。
// この2ヘッダ＝crossOriginIsolated＝SharedArrayBuffer（gint バッファを worker へゼロコピーで渡す）の点火条件。
// ★必須ではない（2026-08-19 実測で訂正）：無ければ geopbf setGintBUF が通常 ArrayBuffer へ落ち、structured clone の
//   コピー1回を払って同じ結果を出す（Safari は COEP:credentialless 非対応＝元からこの世界で動いている）。
//   実測＝apps/ortho-japan `npm run verify:nocoi`（coi=false・SAB=false で gint/描画/識別 7ページ PASS）。
//   つまりここは「自前配信を速くする最適化」であって、SDK として第三者ページへ埋め込む条件ではない。
// dev（vite.config.js の middleware）と同一条件を本番にも刻む＝環境差ゼロ。
export default {
	async fetch(req, env) {
		const url = new URL(req.url);
		if (url.pathname === "/yokohama") return Response.redirect(url.origin + "/yokohama/", 301);   // 裸パス＝正規の末尾スラッシュへ
		const res = await env.ASSETS.fetch(req);
		const h = new Headers(res.headers);
		h.set("Cross-Origin-Opener-Policy", "same-origin");
		h.set("Cross-Origin-Embedder-Policy", "credentialless");
		h.set("X-Content-Type-Options", "nosniff");   // 配信物の型を推測させない（2026-10-24 監査）
		h.set("Referrer-Policy", "strict-origin-when-cross-origin");   // 外部のタイル鯖等へ URL の query（?g= 等）を漏らさない
		return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
	},
};
