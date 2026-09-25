// CORS 回避の転送口。誰でも叩ける公開エンドポイントなので、転送先に門番を置く（2026-08-19）。
// 無制限の転送＝踏み台：帯域も Workers リクエストも運用者の課金で、苦情・アカウント停止の宛先も運用者。
// URL がソースに載る（SDK 公開・OSS）ほど確実に見つかるため、既定は「閉じている」側に倒す。
//
// 門は二段（先に通った方で確定）：
//  ① 転送先が PROXY_ALLOWED_HOSTS に載る … 誰でも GET/HEAD（カタログ・公開データの取得はここを通る）
//  ② 呼び出し元が信頼できる … Origin が ALLOWED_DOMAINS に一致、または X-API-Key が env.API_KEY と一致
//     → 転送先は任意（GIS-HUB の「任意URLを貼って開く」・Node のバッチスクリプトがここ）
//  GET/HEAD 以外（PUT/DELETE/POST）は転送先に関わらず X-API-Key だけが通す（Origin は偽れる＝2026-09-25）
//  ②を Origin だけで通る分（許可表外ホスト）は IP ごとの回数上限 PROXY_RL に掛ける（Origin は偽れる＝案 1・2026-09-25）
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

// X-Proxy-Deny＝この Worker 自身の検問で止めた印。上流由来の 403 と区別する（check モードが見る）。
const deny = (msg, status = 403) =>
	new Response(JSON.stringify({ error: msg }), { status, headers: { "Content-Type": "application/json", "X-Proxy-Deny": "1" } });

// Origin が ALLOWED_DOMAINS に載るか。URL として解いてから突き合わせる（生文字列の includes だと
// "https://evil.com/www.ortho-earth.com" 型のパスに書いただけの偽装や "www.ortho-earth.com.evil.com" が通る）。
// ALLOWED_DOMAINS には "localhost:5173" のようなポート付きの項目が混ざるため、host（ポート込み）と
// hostname（ポート無し）の両方で見る＝どちらの書き方も効く。空の項目（末尾カンマ等）は hostMatches が捨てる。
// ⚠ Origin はブラウザには偽れないが curl 等は自由に付けられる＝「ブラウザから来た」の目印でしかなく認証ではない。
// CORS の許可（index.js）と下の isTrusted が共用。
export const originAllowed = (req, env = {}) => {
	const allowedOrigins = (env.ALLOWED_DOMAINS || "").split(",");
	const origin = req.headers.get("Origin") || "";
	try {
		if (!origin) return false;
		const u = new URL(origin);
		return hostMatches(u.hostname.toLowerCase(), allowedOrigins) || hostMatches(u.host.toLowerCase(), allowedOrigins);
	} catch { return false; }   // Origin: null 等
};

// X-API-Key が env.API_KEY と一致するか（定数時間で比べる）。書き込み・非 GET の中継はこれだけが鍵（2026-09-25）。
export const keyMatches = (req, env = {}) => {
	const want = env.API_KEY || "", got = req.headers.get("X-API-Key") || "";
	if (!want || got.length !== want.length) return false;
	let d = 0;
	for (let i = 0; i < want.length; i++) d |= want.charCodeAt(i) ^ got.charCodeAt(i);
	return d === 0;
};

// 回数上限（案 1・2026-09-25）＝Origin だけを根拠に通す分（/proxy の許可表外ホスト・/tellus）を IP ごとに数える。
// Origin は偽れる＝ここが実質の歯止め。鍵持ちと許可表のホストは数えない。limiter（Workers Rate Limiting の binding）が
// 無い環境（wrangler dev・ミラーの自前 deploy）と limiter の故障時は素通し＝回数上限のせいで取れなくなる事故を作らない。
export const overLimit = async (limiter, req) => {
	if (!limiter?.limit) return false;
	try { return !(await limiter.limit({ key: req.headers.get("CF-Connecting-IP") || "unknown" })).success; }
	catch { return false; }
};
export const tooMany = () => new Response(JSON.stringify({ error: "rate limited（しばらく待つか X-API-Key を添えること）" }),
	{ status: 429, headers: { "Content-Type": "application/json", "Retry-After": "60", "X-Proxy-Deny": "1" } });

// 信頼された呼び出し元＝Origin 一致（ブラウザの頁）または API キー一致（Node バッチ）。
// /proxy の門②（GET/HEAD）と /tellus（tellus.js）が共用。非 GET の中継は keyMatches だけで判定する（proxy() 内）。
export const isTrusted = (req, env = {}) => originAllowed(req, env) || keyMatches(req, env);

export async function proxy(req, env = {}) {
	const url = new URL(req.url);
	const target = url.searchParams.get('url');
	const mode = url.searchParams.get('mode');
	if (!target) return new Response('URL required', { status: 400 });

	const allowedHosts = (env.PROXY_ALLOWED_HOSTS || "").split(",").filter(Boolean);
	const origin = req.headers.get("Origin") || "";
	const trusted = isTrusted(req, env);

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
	// 書き込み系は API キー持ちだけ（オープンな踏み台で PUT/DELETE を中継させない）。
	// Origin は curl で偽れるので非 GET の根拠にしない（2026-09-25・偽 Origin で任意ホストへの PUT/DELETE が通っていた）
	const method = req.method;
	if (method !== "GET" && method !== "HEAD" && !keyMatches(req, env)) return deny(`method not allowed: ${method}（非 GET の中継は X-API-Key が要る）`);
	// 許可表外のホストへ Origin だけで通る分は回数を数える（入口の転送先で判定＝リダイレクト先は数え直さない）
	if (!keyMatches(req, env) && !hostMatches(first.url.hostname.toLowerCase(), allowedHosts) && await overLimit(env.PROXY_RL, req)) return tooMany();

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
			// 探りは HEAD でなく GET+Range 1バイト。HEAD は二重に嘘をつく：
			//  ・S3 の署名付き URL（CKAN 等の 302 先）は GET に署名されており HEAD だと署名不一致 403
			//  ・UA 無しの素朴なリクエストを WAF が 403 で落とす先がある（geospatial.jp 実測 2026-08-29）
			const r = await followed(first.url.toString(), {
				method: 'GET',
				// 呼び出し元の Origin を添えて探る＝S3 系は Origin が無いと ACAO を返さない（無いと「CORS 不可」の偽陰性）
				headers: { 'User-Agent': 'nativeBucket-Proxy/1.2', 'Range': 'bytes=0-0', ...(origin ? { 'Origin': origin } : {}) }
			});
			if (r.headers.get('X-Proxy-Deny')) return r;   // 検問で止めた応答はそのまま返す（上流 403 は下の JSON に包む）
			try { await r.body?.cancel(); } catch { /* 既読み・切断は無視 */ }
			// ACAO は値まで見る＝有無だけだと Tellus storage（ACAO=https://www.tellusxdp.com 固定）を「CORS 可」と誤判定（2026-09-16 実測）
			const acao = r.headers.get('access-control-allow-origin');
			const hasCors = acao === '*' || (!!origin && acao === origin);
			// Range を無視する鯖は 200 で全長を返す。206 なら Content-Range "bytes 0-0/全長" から長さを拾う。
			const total = r.status === 206
				? (r.headers.get('content-range') || '').split('/')[1] || null
				: r.headers.get('content-length');
			return new Response(JSON.stringify({
				exists: r.ok, corsSafe: hasCors,
				supportsRange: r.status === 206 || r.headers.get('accept-ranges') === 'bytes',
				status: r.status,
				contentType: r.headers.get('content-type'),
				contentLength: total,
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
