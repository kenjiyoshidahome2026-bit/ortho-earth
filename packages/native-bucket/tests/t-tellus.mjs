// /tellus 代理口の検証（デプロイ不要・グローバル fetch を差し替えて tellus() を直に叩く）。
//   node packages/native-bucket/tests/t-tellus.mjs
// 仕様は workers/tellus.js の冒頭コメントが正本。ここは「門・白リスト・Bearer 付与・webcog 合成」を数える。
import { tellus } from "../workers/tellus.js";

const ENV = { ALLOWED_DOMAINS: "www.ortho-earth.com,localhost:5173", API_KEY: "secret-key", TELLUS_TOKEN: "tok-123" };
const ORIGIN = "https://api.ortho-earth.com";
const DS = "45ff087d-be02-4788-bc4c-28cd947a1167", ID = "2ee1f996-ae81-4892-882c-703e4ad0b990";

let calls = [], routes = {};
globalThis.fetch = async (url, init = {}) => {
	calls.push({ url: String(url), method: init.method || "GET", headers: init.headers || {}, body: init.body ?? null });
	const r = routes[String(url)];
	if (r) return new Response(JSON.stringify(r.body), { status: r.status || 200, headers: { "content-type": "application/json" } });
	return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
};
const call = (path, { origin = "https://www.ortho-earth.com", key, method = "GET", body, env = ENV } = {}) => {
	calls = [];
	const headers = new Headers();
	if (origin) headers.set("Origin", origin);
	if (key) headers.set("X-API-Key", key);
	return tellus(new Request(ORIGIN + path, { method, headers, body }), env);
};
let pass = 0, fail = 0;
const t = async (name, fn) => {
	try { await fn(); pass++; console.log(`  ok   ${name}`); }
	catch (e) { fail++; console.log(`  FAIL ${name}\n       ${e.message}`); }
};
const eq = (got, want, what) => { if (got !== want) throw new Error(`${what}: got ${got}, want ${want}`); };

console.log("── 門（信頼済み呼び出し元だけ）");
await t("未信頼 Origin は 403 + X-Proxy-Deny・上流は呼ばない", async () => {
	const r = await call("/tellus/datasets/", { origin: "https://evil.example" });
	eq(r.status, 403, "status"); eq(r.headers.get("X-Proxy-Deny"), "1", "deny 印"); eq(calls.length, 0, "上流呼び出し");
});
await t("Origin 無し + X-API-Key 一致は通る", async () => { eq((await call("/tellus/datasets/", { origin: "", key: "secret-key" })).status, 200, "status"); });
await t("TELLUS_TOKEN 未設定は 503", async () => { eq((await call("/tellus/datasets/", { env: { ...ENV, TELLUS_TOKEN: "" } })).status, 503, "status"); });

console.log("── 白リストと Bearer 付与");
await t("GET /datasets/ は上流へ Bearer 付きで転送・?page_size= も保つ", async () => {
	const r = await call("/tellus/datasets/?page_size=100");
	eq(r.status, 200, "status"); eq(calls[0].url, "https://www.tellusxdp.com/api/traveler/v1/datasets/?page_size=100", "上流 URL");
	eq(calls[0].headers.Authorization, "Bearer tok-123", "Bearer");
});
await t("POST data-search は本文をそのまま転送", async () => {
	const body = JSON.stringify({ intersects: { type: "Polygon" }, paginate: { size: 10, cursor: null } });
	await call(`/tellus/datasets/${DS}/data-search/`, { method: "POST", body });
	eq(calls[0].method, "POST", "method"); eq(calls[0].body, body, "body");
});
await t("★白リスト外のパスは 403（購入 order は通さない）", async () => {
	const r = await call(`/tellus/datasets/${DS}/data/${ID}/order/`, { method: "POST", body: "{}" });
	eq(r.status, 403, "status"); eq(calls.length, 0, "上流呼び出し");
});
await t("★白リストのパスでもメソッド違いは 403（datasets/ に POST）", async () => { eq((await call("/tellus/datasets/", { method: "POST", body: "{}" })).status, 403, "status"); });
await t("UUID でない id は白リストに掛からず 403", async () => { eq((await call("/tellus/datasets/../admin/data-search/", { method: "POST", body: "{}" })).status, 403, "status"); });
await t("64KB 超の本文は 413", async () => { eq((await call(`/tellus/datasets/${DS}/data-search/`, { method: "POST", body: "x".repeat(65537) })).status, 413, "status"); });
await t("上流の 403/422 はそのまま返す（Worker 自身の deny 印は付けない）", async () => {
	routes = { [`https://www.tellusxdp.com/api/traveler/v1/datasets/${DS}/data-search/`]: { status: 422, body: { paginate: ["required"] } } };
	const r = await call(`/tellus/datasets/${DS}/data-search/`, { method: "POST", body: "{}" });
	eq(r.status, 422, "status"); eq(r.headers.get("X-Proxy-Deny"), null, "deny 印なし");
	routes = {};
});

console.log("── webcog 一発発行");
await t("files → *_webcog.tif → download-url を合成し expires_in を署名から読む", async () => {
	routes = {
		[`https://www.tellusxdp.com/api/traveler/v1/datasets/${DS}/data/${ID}/files/`]: { body: { results: [
			{ id: 1, name: "X_HH_SLP.tif", size_bytes: 10, is_downloadable: true },
			{ id: 7, name: "X_webcog.tif", size_bytes: 384, is_downloadable: true },
		] } },
		[`https://www.tellusxdp.com/api/traveler/v1/datasets/${DS}/data/${ID}/files/7/download-url/`]: { body: { download_url: "https://storage-b.tellusxdp.com/x.tif?X-Amz-Expires=3600&X-Amz-Signature=abc" } },
	};
	const r = await call(`/tellus/webcog?dataset=${DS}&data=${ID}`);
	eq(r.status, 200, "status");
	const j = await r.json();
	eq(j.name, "X_webcog.tif", "name"); eq(j.size_bytes, 384, "size"); eq(j.expires_in, 3600, "expires_in");
	eq(calls.length, 2, "上流 2 回"); eq(calls[1].method, "POST", "download-url は POST");
	routes = {};
});
await t("webcog が無ければ先頭の TIFF に落ちる", async () => {
	routes = {
		[`https://www.tellusxdp.com/api/traveler/v1/datasets/${DS}/data/${ID}/files/`]: { body: { results: [{ id: 3, name: "IMG-01.tif", size_bytes: 1, is_downloadable: true }] } },
		[`https://www.tellusxdp.com/api/traveler/v1/datasets/${DS}/data/${ID}/files/3/download-url/`]: { body: { download_url: "https://s/x" } },
	};
	eq((await (await call(`/tellus/webcog?dataset=${DS}&data=${ID}`)).json()).name, "IMG-01.tif", "name");
	routes = {};
});
await t("TIFF が一つも無ければ 404", async () => {
	routes = { [`https://www.tellusxdp.com/api/traveler/v1/datasets/${DS}/data/${ID}/files/`]: { body: { results: [{ id: 1, name: "a.xml", is_downloadable: true }] } } };
	eq((await call(`/tellus/webcog?dataset=${DS}&data=${ID}`)).status, 404, "status");
	routes = {};
});
await t("webcog の dataset/data が UUID でなければ 400・上流は呼ばない", async () => {
	const r = await call(`/tellus/webcog?dataset=..&data=${ID}`);
	eq(r.status, 400, "status"); eq(calls.length, 0, "上流呼び出し");
});
await t("webcog は GET 以外 405", async () => { eq((await call(`/tellus/webcog?dataset=${DS}&data=${ID}`, { method: "POST", body: "{}" })).status, 405, "status"); });

console.log(`\n${fail ? "❌" : "✅"} pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
