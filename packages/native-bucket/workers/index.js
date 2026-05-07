import { proxy } from './proxy.js';
import { bucket } from './bucket.js';

function getCorsHeaders(req, env) {
    const origin = req.headers.get("Origin"), method = req.method;
    const allowedDomains = (env.ALLOWED_DOMAINS || "").split(",");
    const headers = { // 許可するメソッドとヘッダーの定義
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Action, X-Metadata-Type, X-Upload-ID, X-Part-Number",
        "Access-Control-Max-Age": "86400",
    };
    const isGetOptions = method === "OPTIONS" && req.headers.get("Access-Control-Request-Method") === "GET";
    if (method === "GET" || isGetOptions) {
        headers["Access-Control-Allow-Origin"] = "*";
    } else if (origin && allowedDomains.some(d => origin.includes(d.trim()))) {
        headers["Access-Control-Allow-Origin"] = origin;
        headers["Vary"] = "Origin"; // 送信元によって内容が変わることをブラウザに通知
    }
    return headers;
}
export default {
	async fetch(req, env, ctx) {
		const corsHeaders = getCorsHeaders(req, env);
		if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
		try {
			const { pathname } = new URL(req.url);
			let res;
			if (pathname.startsWith('/bucket')) res = await bucket(req, env.MY_BUCKET, ctx); else
			if (pathname.startsWith('/proxy')) res = await proxy(req); else
			return await env.ASSETS.fetch(req);
			const finalHeaders = new Headers(res.headers);
			Object.entries(corsHeaders).forEach(([k, v]) => finalHeaders.set(k, v));
			return new Response(res.body, { status: res.status, statusText: res.statusText, headers: finalHeaders });
		} catch (e) {
			return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
		}
  }
};