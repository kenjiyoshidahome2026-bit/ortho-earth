// Tellus（衛星データPF）Traveler API の代理口＝「トークンをブラウザに渡さない」ための一枚（2026-09-16）。
//   Tellus 本体は CORS ヘッダを返さず、署名ダウンロード URL の CORS も tellusxdp.com 固定＝ブラウザ直叩き不可。
//   ここが Bearer（env.TELLUS_TOKEN＝Cloudflare secret）を付けて上流へ転送し、返ってきた署名 URL（S3 型・1時間）は
//   ブラウザが /proxy?url= 経由で Range 読みする（proxy.js 門②＝同じ信頼判定）。
// 門：信頼済み呼び出し元だけ（Origin∈ALLOWED_DOMAINS or X-API-Key＝proxy.js の isTrusted を共用）。
// 上流パスは読み取り系の白リストのみ＝購入（order）や設定系は通さない。POST 本文は 64 KB 上限。
//   GET  /tellus/datasets/                                          データセット一覧（?page_size= 等はそのまま）
//   POST /tellus/data-search/                                       横断シーン検索
//   POST /tellus/datasets/{ds}/data-search/                         データセット内シーン検索
//   GET  /tellus/datasets/{ds}/data/{id}/                           シーン情報
//   GET  /tellus/datasets/{ds}/data/{id}/files/                     ファイル一覧
//   POST /tellus/datasets/{ds}/data/{id}/files/{n}/download-url/    署名 URL 発行
//   GET  /tellus/webcog?dataset={ds}&data={id}                      files→「*_webcog.tif」（Tellus 表示用 COG）→download-url を一発
//                                                                   → {download_url, name, size_bytes, expires_in}
import { isTrusted } from "./proxy.js";

const UPSTREAM = "https://www.tellusxdp.com/api/traveler/v1";
const UUID = "[0-9a-fA-F-]{36}";
const ALLOW = [
	{ m: "GET", re: new RegExp(`^/datasets/$`) },
	{ m: "POST", re: new RegExp(`^/data-search/$`) },
	{ m: "POST", re: new RegExp(`^/datasets/${UUID}/data-search/$`) },
	{ m: "GET", re: new RegExp(`^/datasets/${UUID}/data/${UUID}/$`) },
	{ m: "GET", re: new RegExp(`^/datasets/${UUID}/data/${UUID}/files/$`) },
	{ m: "POST", re: new RegExp(`^/datasets/${UUID}/data/${UUID}/files/\\d+/download-url/$`) },
];
const MAX_BODY = 64 << 10;
const isUuid = (s) => new RegExp(`^${UUID}$`).test(s || "");
const json = (obj, status = 200, extra = {}) =>
	new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...extra } });
const deny = (msg, status = 403) => json({ error: msg }, status, { "X-Proxy-Deny": "1" });

export async function tellus(req, env = {}) {
	if (!isTrusted(req, env)) return deny("untrusted caller（許可された Origin から呼ぶか X-API-Key を添えること）");
	if (!env.TELLUS_TOKEN) return json({ error: "TELLUS_TOKEN not configured" }, 503);
	const url = new URL(req.url);
	const sub = url.pathname.replace(/^\/tellus/, "") || "/";
	const headers = { "Authorization": `Bearer ${env.TELLUS_TOKEN}`, "Content-Type": "application/json", "User-Agent": "nativeBucket-Tellus/1.0" };
	const up = (path, init = {}) => fetch(UPSTREAM + path, { ...init, headers });
	const relay = (r) => new Response(r.body, { status: r.status, headers: { "Content-Type": r.headers.get("content-type") || "application/json" } });

	// 便利口：webcog の署名 URL を一発で
	if (sub === "/webcog" || sub === "/webcog/") {
		if (req.method !== "GET") return deny(`method not allowed: ${req.method}`, 405);
		const ds = url.searchParams.get("dataset"), id = url.searchParams.get("data");
		if (!isUuid(ds) || !isUuid(id)) return json({ error: "dataset / data must be UUIDs" }, 400);
		const fr = await up(`/datasets/${ds}/data/${id}/files/`);
		if (!fr.ok) return relay(fr);
		const fj = await fr.json();
		const list = fj.results || fj || [];
		const file = list.find(x => /_webcog\.tiff?$/i.test(x.name) && x.is_downloadable)
			|| list.find(x => /\.tiff?$/i.test(x.name) && x.is_downloadable);   // 表示用 COG が無い産物は先頭の TIFF
		if (!file) return json({ error: "no downloadable GeoTIFF in this scene" }, 404);
		const dr = await up(`/datasets/${ds}/data/${id}/files/${file.id}/download-url/`, { method: "POST", body: "{}" });
		if (!dr.ok) return relay(dr);
		const { download_url } = await dr.json();
		let expires_in = 3600;
		try { expires_in = +new URL(download_url).searchParams.get("X-Amz-Expires") || 3600; } catch { /* 形が変わっても既定値で */ }
		return json({ download_url, name: file.name, size_bytes: file.size_bytes, expires_in });
	}

	const rule = ALLOW.find(r => r.m === req.method && r.re.test(sub));
	if (!rule) return deny(`path not allowed: ${req.method} ${sub}`);
	let body = null;
	if (req.method === "POST") {
		const t = await req.text();
		if (t.length > MAX_BODY) return json({ error: "body too large" }, 413);
		body = t || "{}";
	}
	return relay(await up(sub + url.search, { method: req.method, body }));
}
