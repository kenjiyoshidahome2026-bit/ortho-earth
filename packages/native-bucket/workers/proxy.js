export async function proxy(req) {
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
		const h = new Headers();
		for (const [k, v] of req.headers) {
			if (SAFE_HEADERS.includes(k.toLowerCase())) h.set(k, v);
		}
		h.set('User-Agent', 'nativeBucket-Proxy/1.1');
		const res = await fetch(target, { method: req.method, headers: h,
			body: (req.method !== 'GET' && req.method !== 'HEAD') ? req.body : null,
		});
		return res;
	} catch (e) { return new Response(JSON.stringify({ error: e.message }), { status: 500 });}
}