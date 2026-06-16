/*export async function proxy(req) {
	const url = new URL(req.url);
	const target = url.searchParams.get('url');
	const mode = url.searchParams.get('mode');
	if (!target) return new Response('URL required', { status: 400 });
	const SAFE_HEADERS = ['accept', 'accept-encoding', 'accept-language', 'content-type',
		'range', 'cache-control', 'if-modified-since', 'if-none-match'];
	try {
		if (mode === 'check') {
			const r = await fetch(target, { method: 'HEAD' });
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
		const headers = new Headers(), method = req.method;
		const body = (method !== 'GET' && method !== 'HEAD') ? req.body : null;
		for (const [k, v] of req.headers) SAFE_HEADERS.includes(k.toLowerCase()) && headers.set(k, v);
		headers.set('User-Agent', 'nativeBucket-Proxy/1.1');
		return await fetch(target, { method, headers, body });
	} catch (e) { return new Response(JSON.stringify({ error: e.message }), { status: 500 });}
}*/
export async function proxy(req) {
	const url = new URL(req.url);
	const target = url.searchParams.get('url');
	const mode = url.searchParams.get('mode');
	if (!target) return new Response('URL required', { status: 400 });

	const SAFE_HEADERS = ['accept', 'accept-encoding', 'accept-language', 'content-type',
		'range', 'cache-control', 'if-modified-since', 'if-none-match'];

	// 一般的なブラウザ（MacのChrome）のUser-Agent
	const BROWSER_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

	try {
		if (mode === 'check') {
			let checkTarget = target;
			// HEAD時もブラウザのUAを付与する
			let checkResponse = await fetch(checkTarget, {
				method: 'HEAD',
				headers: { 'User-Agent': BROWSER_USER_AGENT },
				redirect: 'manual'
			});

			if ([301, 302, 303, 307, 308].includes(checkResponse.status)) {
				const location = checkResponse.headers.get('location');
				if (location) {
					checkTarget = new URL(location, checkTarget).href;
					// S3へのHEADは403になることがあるので、リダイレクト先はGETでチェック（またはUAのみで綺麗に）
					checkResponse = await fetch(checkTarget, {
						method: 'HEAD',
						headers: { 'User-Agent': BROWSER_USER_AGENT }
					});
				}
			}

			const hasCors = checkResponse.headers.has('access-control-allow-origin');
			return new Response(JSON.stringify({
				exists: checkResponse.ok, corsSafe: hasCors,
				supportsRange: checkResponse.headers.get('accept-ranges') === 'bytes',
				status: checkResponse.status,
				contentType: checkResponse.headers.get('content-type'),
				contentLength: checkResponse.headers.get('content-length'),
				mustUseProxy: !hasCors, url: checkTarget
			}), { headers: { 'Content-Type': 'application/json' } });
		}

		const headers = new Headers(), method = req.method;
		const body = (method !== 'GET' && method !== 'HEAD') ? req.body : null;
		for (const [k, v] of req.headers) SAFE_HEADERS.includes(k.toLowerCase()) && headers.set(k, v);

		// 初期リクエストもブラウザUAに設定
		headers.set('User-Agent', BROWSER_USER_AGENT);

		let response = await fetch(target, { method, headers, body, redirect: 'manual' });

		// S3などへのリダイレクトが発生した場合
		if ([301, 302, 303, 307, 308].includes(response.status)) {
			const redirectUrl = response.headers.get('location');
			if (redirectUrl) {
				const finalTarget = new URL(redirectUrl, target).href;

				// 【超重要】S3用のヘッダーを完全にクリーンアップする
				const s3Headers = new Headers();

				// 1. User-Agent をブラウザのものに偽装
				s3Headers.set('User-Agent', BROWSER_USER_AGENT);

				// 2. 動画再生やシークに必要な Range ヘッダー「だけ」を引き継ぐ
				if (headers.has('Range')) {
					s3Headers.set('Range', headers.get('Range'));
				}

				// ⚠️ Origin, Referer, Authorization, Host などは絶対に含めない（S3が403を返す原因）

				response = await fetch(finalTarget, { method: 'GET', headers: s3Headers });
			}
		}

		return response;

	} catch (e) {
		return new Response(JSON.stringify({ error: e.message }), { status: 500 });
	}
}