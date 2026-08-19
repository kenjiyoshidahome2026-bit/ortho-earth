// /proxy の門番の検証（デプロイ不要・グローバル fetch を差し替えて proxy() を直に叩く）。
//   node packages/native-bucket/tests/t-proxy.mjs
// 門の仕様は workers/proxy.js の冒頭コメントが正本。ここは「そのとおりに閉まっているか」を数える。
import { proxy } from "../workers/proxy.js";

const ENV = {
	ALLOWED_DOMAINS: "www.ortho-earth.com,ortho-earth.com,localhost:5173",
	PROXY_ALLOWED_HOSTS: "e-stat.go.jp,gsi.go.jp,naturalearth.s3.amazonaws.com",
	API_KEY: "secret-key",
};
const PROXY_ORIGIN = "https://api.ortho-earth.com";

// 差し替え fetch：呼ばれた URL を記録し、routes に書いた応答（無ければ 200）を返す
let calls = [], routes = {};
globalThis.fetch = async (url, init = {}) => {
	calls.push(String(url));
	const r = routes[String(url)];
	if (r?.redirect) return new Response(null, { status: 302, headers: { location: r.redirect } });
	return new Response("body", { status: 200, headers: { "accept-ranges": "bytes", "content-length": "4" } });
};

const call = (target, { origin, key, method = "GET", mode, env = ENV } = {}) => {
	calls = [];
	const u = new URL(`${PROXY_ORIGIN}/proxy/`);
	u.searchParams.set("url", target);
	if (mode) u.searchParams.set("mode", mode);
	const headers = new Headers();
	if (origin) headers.set("Origin", origin);
	if (key) headers.set("X-API-Key", key);
	return proxy(new Request(u, { method, headers }), env);
};

let pass = 0, fail = 0;
const t = async (name, fn) => {
	try { await fn(); pass++; console.log(`  ok   ${name}`); }
	catch (e) { fail++; console.log(`  FAIL ${name}\n       ${e.message}`); }
};
const eq = (got, want, what) => { if (got !== want) throw new Error(`${what}: got ${got}, want ${want}`); };

console.log("── ① 転送先 allowlist（誰でも GET）");
await t("許可ホストは Origin 無しで通る", async () =>
	eq((await call("https://www.e-stat.go.jp/x.zip")).status, 200, "status"));
await t("サブドメインもドット境界で当たる", async () =>
	eq((await call("https://maps.gsi.go.jp/x.json")).status, 200, "status"));
await t("完全一致指定のホストも通る", async () =>
	eq((await call("https://naturalearth.s3.amazonaws.com/a.zip")).status, 200, "status"));
await t("★同じドメインの別バケットは通らない（s3 全体は開かない）", async () =>
	eq((await call("https://evil.s3.amazonaws.com/a.zip")).status, 403, "status"));
await t("★偽装サフィックスは弾く（evilgsi.go.jp）", async () =>
	eq((await call("https://evilgsi.go.jp/x")).status, 403, "status"));
await t("未登録ホストは Origin 無しなら 403", async () =>
	eq((await call("https://example.com/x")).status, 403, "status"));

console.log("── ② 信頼された呼び出し元（転送先は任意）");
await t("許可 Origin なら任意ホストへ通る（GIS-HUB の任意URL）", async () =>
	eq((await call("https://example.com/x", { origin: "https://www.ortho-earth.com" })).status, 200, "status"));
await t("API キーなら任意ホストへ通る（Node バッチ）", async () =>
	eq((await call("https://example.com/x", { key: "secret-key" })).status, 200, "status"));
await t("★Origin の偽装（evil.com/www.ortho-earth.com）は弾く", async () =>
	eq((await call("https://example.com/x", { origin: "https://evil.com/www.ortho-earth.com" })).status, 403, "status"));
await t("★似せた Origin（www.ortho-earth.com.evil.jp）は弾く", async () =>
	eq((await call("https://example.com/x", { origin: "https://www.ortho-earth.com.evil.jp" })).status, 403, "status"));
await t("誤った API キーは弾く", async () =>
	eq((await call("https://example.com/x", { key: "wrong" })).status, 403, "status"));

console.log("── 内向き転送・自己参照・スキーム");
for (const h of ["http://127.0.0.1/x", "http://localhost/x", "http://169.254.169.254/latest/meta-data/",
                 "http://10.0.0.1/x", "http://192.168.1.1/x", "http://172.16.0.1/x", "http://metadata.google.internal/x"])
	await t(`★内向き ${h} は信頼済みでも弾く`, async () =>
		eq((await call(h, { key: "secret-key" })).status, 403, "status"));
await t("★自分自身への再帰（増幅ループ）を弾く", async () =>
	eq((await call(`${PROXY_ORIGIN}/proxy/?url=https://www.e-stat.go.jp/`, { key: "secret-key" })).status, 403, "status"));
await t("★file: スキームを弾く", async () =>
	eq((await call("file:///etc/passwd", { key: "secret-key" })).status, 403, "status"));

console.log("── メソッド");
await t("★未信頼の POST は弾く（許可ホストでも）", async () =>
	eq((await call("https://www.e-stat.go.jp/x", { method: "POST" })).status, 403, "status"));
await t("信頼済みの POST は通る", async () =>
	eq((await call("https://www.e-stat.go.jp/x", { method: "POST", key: "secret-key" })).status, 200, "status"));

console.log("── リダイレクト（allowlist を跨がせない）");
await t("★許可ホスト→未許可ホストの 302 を弾く", async () => {
	routes = { "https://www.e-stat.go.jp/r": { redirect: "https://example.com/final" } };
	const res = await call("https://www.e-stat.go.jp/r");
	eq(res.status, 403, "status");
	eq(calls.includes("https://example.com/final"), false, "未許可先へ実際に fetch していない");
	routes = {};
});
await t("許可ホスト内の 302 は追う", async () => {
	routes = { "https://www.e-stat.go.jp/r": { redirect: "https://www.e-stat.go.jp/final" } };
	eq((await call("https://www.e-stat.go.jp/r")).status, 200, "status");
	routes = {};
});
await t("★リダイレクト地獄は 508 で打ち切る", async () => {
	routes = {}; for (let i = 0; i < 20; i++) routes[`https://www.e-stat.go.jp/r${i}`] = { redirect: `https://www.e-stat.go.jp/r${i + 1}` };
	eq((await call("https://www.e-stat.go.jp/r0")).status, 508, "status");
	routes = {};
});

console.log("── mode=check（HEAD 経路も同じ門）");
await t("許可ホストの check は JSON を返す", async () => {
	const res = await call("https://www.e-stat.go.jp/x.zip", { mode: "check" });
	eq(res.status, 200, "status");
	eq((await res.json()).supportsRange, true, "supportsRange");
});
await t("★未許可ホストの check も弾く（偵察に使わせない）", async () =>
	eq((await call("https://example.com/x", { mode: "check" })).status, 403, "status"));

console.log("── 既定（PROXY_ALLOWED_HOSTS 未設定＝安全側）");
await t("★未設定なら未信頼は全て弾く", async () =>
	eq((await call("https://www.e-stat.go.jp/x", { env: { ALLOWED_DOMAINS: ENV.ALLOWED_DOMAINS } })).status, 403, "status"));
await t("未設定でも信頼済みは通る", async () =>
	eq((await call("https://www.e-stat.go.jp/x", { origin: "https://www.ortho-earth.com", env: { ALLOWED_DOMAINS: ENV.ALLOWED_DOMAINS } })).status, 200, "status"));

console.log(`\n${fail ? "❌" : "✅"} pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
