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

	try {
		if (mode === 'check') {
			// mode: check の場合も、リダイレクト先を含めた最終的な状態をチェックする
			let checkTarget = target;
			let checkResponse = await fetch(checkTarget, { method: 'HEAD', redirect: 'manual' });

			// リダイレクト（301/302など）が発生した場合は、リダイレクト先のURLに切り替える
			if ([301, 302, 303, 307, 308].includes(checkResponse.status)) {
				const location = checkResponse.headers.get('location');
				if (location) {
					checkTarget = new URL(location, checkTarget).href;
					checkResponse = await fetch(checkTarget, { method: 'HEAD' });
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
		headers.set('User-Agent', 'nativeBucket-Proxy/1.1');

		// 1. まずリダイレクトを自動追跡せず（manual）にフェッチを試みる
		let response = await fetch(target, { method, headers, body, redirect: 'manual' });

		// 2. もしS3などへのリダイレクト（301/302等）が発生した場合、手動で処理する
		if ([301, 302, 303, 307, 308].includes(response.status)) {
			const redirectUrl = response.headers.get('location');
			if (redirectUrl) {
				const finalTarget = new URL(redirectUrl, target).href;

				// S3にリダイレクトする際、元のリクエストヘッダー（特にRangeや余計なHost）が
				// 邪魔をして署名エラーや拒否を起こすことがあるため、
				// 必要最低限（User-AgentやRangeなど）に絞って再リクエストする
				const s3Headers = new Headers();
				if (headers.has('Range')) s3Headers.set('Range', headers.get('Range'));
				s3Headers.set('User-Agent', 'nativeBucket-Proxy/1.1');

				// S3への最終的なフェッチ（ここは通常自動リダイレクトでOK）
				response = await fetch(finalTarget, { method: 'GET', headers: s3Headers });
			}
		}

		// 3. 元のレスポンス（またはリダイレクト先から得たレスポンス）を返す
		return response;

	} catch (e) {
		return new Response(JSON.stringify({ error: e.message }), { status: 500 });
	}
}