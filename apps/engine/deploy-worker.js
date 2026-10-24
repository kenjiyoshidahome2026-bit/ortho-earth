// ortho-engine の配信口（Workers assets の前段・run_worker_first）＝/globe/engine/* だけを受ける（2026-10-15・ortho-globe の配信口から切り出し）。
// ①全レスポンスに COOP/COEP（credentialless）を刻む＝japan・globe と同条件（エンジンは同一オリジンの頁が読む）
// ②旧版＝この deploy の assets に無い版の入口（globe.js・maplibre.js・i18n.js・core.js・geopbf.js・h3.js・jp/*・nl/*・equal*.js・globe.css）は
//   今の版の同じ名前へ 302 で送る（入口でないチャンクも、今の版に同じ名前があれば送る＝下の toCurrent）。入口の名前は版を跨いで同じ＝前の版を指したまま出ている他のアプリも今のエンジンで動く。
//   送った先の URL がモジュールの住所になる（import.meta.url）＝チャンク・worker は今の版から引かれ、入口は同じ実体に揃う。
//   今の版は assets の globe/engine/current.json（scripts/build.mjs が置く）。今の版に無い名前の旧版チャンクは 404 のまま（R2 に控えは置かない＝本人 2026-09-30）。
// ③入口は immutable にしない（no-cache＝毎回 304 の再検証・2026-10-14）。旧＝入口も 1 年 immutable だった＝版を上げた後も
//   手元に旧版の globe.js が残った閲覧者は、302 を通らずに旧版のまま動き、遅延チャンク（cog-*.js 等）を旧版の住所へ取りに行って 404
//  （tellus の「Failed to fetch dynamically imported module …/engine/916d5c0d18/assets/cog-*.js」）。チャンクは中身のハッシュ名＝immutable のまま。
const ENGINE = /^\/globe\/engine\/([0-9a-f]{10})\/(.+)$/;
const ENTRY = /^(?!assets\/)[\w/-]+\.(js|css)$/;   // 入口＝assets/ の外の js・css（src/entries.mjs の一覧＋maplibre.js・globe.css）。チャンクと実行時データは assets/ の中（名前はハッシュか、版の中身）
const CURRENT = "/globe/engine/current.json";
const COI = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "credentialless",
	"X-Content-Type-Options": "nosniff", "Referrer-Policy": "strict-origin-when-cross-origin" };   // 後の 2 本＝型を推測させない・外部へ query を漏らさない（2026-10-24 監査）
const toCurrent = async (env, url) => {
	const m = url.pathname.match(ENGINE); if (!m) return null;
	const cur = await env.ASSETS.fetch(new Request(url.origin + CURRENT)).then(r => r.ok ? r.json() : null).catch(() => null);
	if (!cur?.version || cur.version === m[1]) return null;
	const to = `/globe/engine/${cur.version}/${m[2]}`;
	// 入口でない旧版のチャンク＝今の版に同じ名前があれば送る（名前は中身のハッシュ＝同じ名前は同じ中身）。旧版の入口を手元に持ったままの閲覧者が
	// 遅延チャンクで 404 に落ちるのを救う（2026-10-14・tellus の cog-*.js）。名前が変わったチャンクは救えない＝404 のまま
	if (!ENTRY.test(m[2]) && !(await env.ASSETS.fetch(new Request(url.origin + to, { method: "HEAD" })).then(r => r.ok).catch(() => false))) return null;
	return new Response(null, { status: 302, headers: { ...COI, Location: to, "Cache-Control": "no-store" } });
};
export default {
	async fetch(req, env) {
		const url = new URL(req.url);
		const res = await env.ASSETS.fetch(req);
		if (res.status === 404) { const moved = await toCurrent(env, url); if (moved) return moved; }
		const h = new Headers(res.headers);
		for (const [k, v] of Object.entries(COI)) h.set(k, v);
		const m = res.ok && url.pathname.match(ENGINE);
		if (m) h.set("Cache-Control", ENTRY.test(m[2]) ? "no-cache" : "public, max-age=31536000, immutable");   // 入口＝再検証（旧版になったら 302 へ乗る）・チャンク＝版の中身は変わらない
		if (url.pathname === CURRENT) h.set("Cache-Control", "no-cache");   // 今の版の札＝エンジンの「古い版を握ったまま」の確かめ（engine-stale.mjs）が読む＝常に再検証
		return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
	},
};
