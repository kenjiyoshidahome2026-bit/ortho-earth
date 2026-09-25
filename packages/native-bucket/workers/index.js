import { proxy, originAllowed } from './proxy.js';
import { bucket } from './bucket.js';
import { tellus } from './tellus.js';

function getCorsHeaders(req, env) {
	const method = req.method;
	const headers = { // 許可するメソッドとヘッダーの定義
		"Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
		"Access-Control-Allow-Headers": "Content-Type, Authorization, X-Action, X-Metadata-Type, X-Upload-ID, X-Part-Number, X-API-Key",
		"Access-Control-Max-Age": "86400",
	};
	const isGetOptions = method === "OPTIONS" && req.headers.get("Access-Control-Request-Method") === "GET";
	if (method === "GET" || isGetOptions) {
		headers["Access-Control-Allow-Origin"] = "*";
	} else if (originAllowed(req, env)) {   // ホストの一致で見る（旧 origin.includes は "www.ortho-earth.com.evil.com" や空の項目で全許可になった・2026-09-25）
		headers["Access-Control-Allow-Origin"] = req.headers.get("Origin");
		headers["Vary"] = "Origin"; // 送信元によって内容が変わることをブラウザに通知
	}
	return headers;
}
// /bucket・/proxy・/tellus の応答は「データ」であって api.ortho-earth.com の頁ではない（2026-09-25）。
//  ・nosniff＝Content-Type を推測させない
//  ・CSP sandbox＝HTML/SVG として直に開かれても script を走らせずオリジンも与えない（fetch/img で使う分には効かない）
//  ・Set-Cookie は捨てる＝上流（/proxy の転送先）の Cookie を api オリジンに付けさせない
const DATA_HEADERS = { "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'" };
const DROP_HEADERS = ["set-cookie", "set-cookie2"];
export default {
	async fetch(req, env, ctx) {
		const corsHeaders = getCorsHeaders(req, env);
		if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
		try {
			const { pathname } = new URL(req.url);
			let res;
			if (pathname.startsWith('/bucket')) res = await bucket(req, env.MY_BUCKET, ctx, env); else
			if (pathname.startsWith('/proxy')) res = await proxy(req, env); else
			if (pathname.startsWith('/tellus')) res = await tellus(req, env); else
			return await env.ASSETS.fetch(req);
			const finalHeaders = new Headers(res.headers);
			DROP_HEADERS.forEach(k => finalHeaders.delete(k));
			Object.entries({ ...DATA_HEADERS, ...corsHeaders }).forEach(([k, v]) => finalHeaders.set(k, v));
			return new Response(res.body, { status: res.status, statusText: res.statusText, headers: finalHeaders });
		} catch (e) {
			return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...DATA_HEADERS, ...corsHeaders } });
		}
	}
};
