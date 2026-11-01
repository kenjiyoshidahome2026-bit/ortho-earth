import { proxy, originAllowed } from './proxy.ts';
import { bucket } from './bucket.ts';
import { tellus } from './tellus.ts';
import type { Env, ExecutionContext } from './types.ts';

function getCorsHeaders(req: Request, env: Env) {
	const method = req.method;
	const headers: Record<string, string> = { // 許可するメソッドとヘッダーの定義
		"Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
		"Access-Control-Allow-Headers": "Content-Type, Authorization, X-Action, X-Metadata-Type, X-Content-Encoding, X-Upload-ID, X-Part-Number, X-API-Key",   // X-Content-Encoding＝Bucket.put が gzip して送る時の印（bucket.ts が読む）。抜けていた＝ブラウザの put が preflight で落ちて「Failed to fetch」（2026-10-23・uploader の標高タイル）
		"Access-Control-Max-Age": "86400",
		"Access-Control-Expose-Headers": "Content-Range, Content-Length, ETag",   // Range 読みの全長を JS から見せる（tellus のヘッダ保管が content-range を要る）。ETag は従来どおり
	};
	const isGetOptions = method === "OPTIONS" && req.headers.get("Access-Control-Request-Method") === "GET";
	if (method === "GET" || isGetOptions) {
		headers["Access-Control-Allow-Origin"] = "*";
	} else if (originAllowed(req, env)) {   // ホストの一致で見る（旧 origin.includes は "www.ortho-earth.com.evil.com" や空の項目で全許可になった・2026-09-25）
		headers["Access-Control-Allow-Origin"] = req.headers.get("Origin")!;
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
	async fetch(req: Request, env: Env, ctx: ExecutionContext) {
		const corsHeaders = getCorsHeaders(req, env);
		if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
		try {
			const { pathname } = new URL(req.url);
			let res: Response;
			if (pathname.startsWith('/bucket')) res = await bucket(req, env.MY_BUCKET, ctx, env); else
			if (pathname.startsWith('/proxy')) res = await proxy(req, env); else
			if (pathname.startsWith('/tellus')) res = await tellus(req, env); else
			return await env.ASSETS.fetch(req);
			const finalHeaders = new Headers(res.headers);
			DROP_HEADERS.forEach(k => finalHeaders.delete(k));
			Object.entries({ ...DATA_HEADERS, ...corsHeaders }).forEach(([k, v]) => finalHeaders.set(k, v));
			return new Response(res.body, { status: res.status, statusText: res.statusText, headers: finalHeaders });
		} catch (e) {
			return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: { ...DATA_HEADERS, ...corsHeaders } });
		}
	}
};
