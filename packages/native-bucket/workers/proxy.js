// CORS 回避の転送口。誰でも叩ける公開エンドポイントなので、転送先に門番を置く（2026-08-19）。
// 無制限の転送＝踏み台：帯域も Workers リクエストも運用者の課金で、苦情・アカウント停止の宛先も運用者。
// URL がソースに載る（SDK 公開・OSS）ほど確実に見つかるため、既定は「閉じている」側に倒す。
//
// 門は二段（先に通った方で確定）：
//  ① 転送先が PROXY_ALLOWED_HOSTS に載る … 誰でも GET/HEAD（カタログ・公開データの取得はここを通る）
//  ② 呼び出し元が信頼できる … Origin が ALLOWED_DOMAINS に一致、または X-API-Key が env.API_KEY と一致
//     → 転送先は任意（GIS-HUB の「任意URLを貼って開く」・Node のバッチスクリプトがここ）
// どちらも通らなければ 403。PROXY_ALLOWED_HOSTS 未設定＝①が空＝②だけが通る（安全側の既定）。
//
// リダイレクトは自前で追う（redirect:"manual"）。allowlist のホストが 302 で任意の先へ飛ばせると
// ①の門が素通りになるため、ホップごとに同じ門で検問する。

const MAX_HOPS = 5;
const SAFE_HEADERS = ['accept', 'accept-encoding', 'accept-language', 'content-type',
	'range', 'cache-control', 'if-modified-since', 'if-none-match'];

// ドット境界のサフィックス一致（"gsi.go.jp" は "maps.gsi.go.jp" に当たり "evilgsi.go.jp" には当たらない）
const hostMatches = (host, list) => list.some(d => {
	d = d.trim().toLowerCase().replace(/^\./, "");
	return d && (host === d || host.endsWith("." + d));
});

// 内側へ向かう転送の拒否（SSRF・クラウドのメタデータ・自分自身への再帰＝増幅ループ）
const isInternalHost = host =>
	host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") ||
	host === "[::1]" || host === "::1" ||
	/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) ||
	/^172\.(1[6-9]|2\d|3[01])\./.test(host) || /^169\.254\./.test(host) ||
	/^0\./.test(host) || host === "metadata.google.internal";

const deny = (msg, status = 403) =>
	new Response(JSON.stringify({ error: msg }), { status, headers: { "Content-Type": "application/json" } });

export async function proxy(req, env = {}) {
	const url = new URL(req.url);
	const target = url.searchParams.get('url');
	const mode = url.searchParams.get('mode');
	if (!target) return new Response('URL required', { status: 400 });

	const allowedHosts = (env.PROXY_ALLOWED_HOSTS || "").split(",").filter(Boolean);
	const allowedOrigins = (env.ALLOWED_DOMAINS || "").split(",").filter(Boolean);
	const origin = req.headers.get("Origin") || "";
	// 信頼された呼び出し元＝Origin 一致（ブラウザは Origin を偽装できない）または API キー一致（Node バッチ）。
	// Origin は URL として解いてから突き合わせる（生文字列の includes だと "https://evil.com/www.ortho-earth.com"
	// 型のパスに書いただけの偽装が通る）。ALLOWED_DOMAINS には "localhost:5173" のようなポート付きの項目が
	// 混ざるため、host（ポート込み）と hostname（ポート無し）の両方で見る＝どちらの書き方も効く。
	let originHost = "", originHostPort = "";
	try { if (origin) { const u = new URL(origin); originHost = u.hostname.toLowerCase(); originHostPort = u.host.toLowerCase(); } } catch { /* Origin: null 等 */ }
	const trusted = (!!originHost && (hostMatches(originHost, allowedOrigins) || hostMatches(originHostPort, allowedOrigins)))
		|| (!!env.API_KEY && req.headers.get("X-API-Key") === env.API_KEY);

	// 転送先の検問（リダイレクト先にも同じものを掛ける）
	const gate = (raw) => {
		let t;
		try { t = new URL(raw); } catch { return { ok: false, why: "invalid url" }; }
		if (t.protocol !== "https:" && t.protocol !== "http:") return { ok: false, why: `scheme not allowed: ${t.protocol}` };
		const host = t.hostname.toLowerCase();
		if (isInternalHost(host)) return { ok: false, why: "internal address" };
		if (host === url.hostname.toLowerCase()) return { ok: false, why: "self-reference" };   // 増幅ループ
		if (trusted) return { ok: true, url: t };
		if (hostMatches(host, allowedHosts)) return { ok: true, url: t };
		return { ok: false, why: `host not allowed: ${host}（PROXY_ALLOWED_HOSTS に追加するか、許可された Origin から呼ぶこと）` };
	};

	const first = gate(target);
	if (!first.ok) return deny(first.why);
	// 書き込み系は信頼された呼び出し元だけ（オープンな踏み台で PUT/DELETE を中継させない）
	const method = req.method;
	if (!trusted && method !== "GET" && method !== "HEAD") return deny(`method not allowed: ${method}`);

	// リダイレクトを1ホップずつ検問しながら追う
	const followed = async (startUrl, init) => {
		let cur = startUrl;
		for (let hop = 0; hop <= MAX_HOPS; hop++) {
			const res = await fetch(cur, { ...init, redirect: "manual" });
			if (res.status < 300 || res.status > 399) return res;
			const loc = res.headers.get("location");
			if (!loc) return res;
			const next = new URL(loc, cur).toString();
			const g = gate(next);
			if (!g.ok) return deny(`redirect blocked → ${g.why}`);
			cur = next;
		}
		return deny("too many redirects", 508);
	};

	try {
		if (mode === 'check') {
			const r = await followed(first.url.toString(), { method: 'HEAD' });
			if (r.status === 403 || r.status === 508) return r;   // 検問で止めた応答はそのまま返す
			const hasCors = r.headers.has('access-control-allow-origin');
			return new Response(JSON.stringify({
				exists: r.ok, corsSafe: hasCors,
				supportsRange: r.headers.get('accept-ranges') === 'bytes',
				status: r.status,
				contentType: r.headers.get('content-type'),
				contentLength: r.headers.get('content-length'),
				mustUseProxy: !hasCors, url: target
			}), { headers: { 'Content-Type': 'application/json' } });
		}
		const headers = new Headers();
		const body = (method !== 'GET' && method !== 'HEAD') ? req.body : null;
		for (const [k, v] of req.headers) SAFE_HEADERS.includes(k.toLowerCase()) && headers.set(k, v);
		headers.set('User-Agent', 'nativeBucket-Proxy/1.2');
		return await followed(first.url.toString(), { method, headers, body });
	} catch (e) { return new Response(JSON.stringify({ error: e.message }), { status: 500 });}
}
